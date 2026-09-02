const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const test = require("node:test");
const packageJson = require("../package.json");
const { CONTROL_PROTOCOL_VERSION } = require("../lib/constants");
const { trustedLanAddress } = require("../lib/dashboard");

const enabled = process.env.PLANROCK_SERVER_TESTS === "1";
const root = path.resolve(__dirname, "..");
const cli = path.join(root, "scripts", "planrock");
function fixture() { const base = fs.mkdtempSync(path.join(os.tmpdir(), "planrock-server-")); const home = path.join(base, "home"); fs.mkdirSync(home); return { base, home }; }
function run(home, args, expected = 0) { const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, HOME: home }, encoding: "utf8" }); assert.equal(result.status, expected, result.stderr || result.stdout); return result; }
function randomPort() { return 45000 + Math.floor(Math.random() * 1000); }
function runAsync(home, args, extraEnv = {}) { return new Promise((resolve) => { const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, HOME: home, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] }); const stdout = []; const stderr = []; child.stdout.on("data", (chunk) => stdout.push(chunk)); child.stderr.on("data", (chunk) => stderr.push(chunk)); child.on("close", (status) => resolve({ status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") })); }); }
function birthIdentity(pid = process.pid) { if (process.platform === "linux") { const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return `linux:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`; } if (process.platform === "darwin") return `darwin:${execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim()}`; return null; }

test("unrestricted dashboard supports multiple viewers, cross-origin requests, reuse, assertions, and shutdown", { skip: !enabled }, async () => {
  const { base, home } = fixture(); const repo = path.join(base, "repo"); fs.mkdirSync(path.join(repo, "plans"), { recursive: true }); fs.mkdirSync(path.join(repo, "docs")); fs.writeFileSync(path.join(repo, "plans", "one.md"), "---\ntitle: <script>alert(1)</script>\nstate: open\nagent_sessions: [\"codex:019e2f18-930f-7052-999f-e3b083d9373f\"]\n---\n\n## Goal\n\nUnsafe <img src=x>. Read the [guide](../docs/guide.md).\n"); fs.writeFileSync(path.join(repo, "docs", "guide.md"), "# Guide\n\nRepository documentation. Read [details](details.md).\n"); fs.writeFileSync(path.join(repo, "docs", "details.md"), "# Details\n\nNested documentation.\n"); fs.writeFileSync(path.join(repo, "docs", "private.md"), "# Private\n\nNot linked by the plan.\n");
  const secondRepo = path.join(base, "second-repo"); fs.mkdirSync(path.join(secondRepo, "plans"), { recursive: true }); fs.mkdirSync(path.join(secondRepo, "docs")); fs.writeFileSync(path.join(secondRepo, "plans", "one.md"), "---\ntitle: Second project plan\nstate: open\n---\n\n## Goal\n\nRead the [guide](../docs/guide.md).\n"); fs.writeFileSync(path.join(secondRepo, "docs", "guide.md"), "# Second guide\n\nSecond repository documentation.\n");
  run(home, ["project", "add", repo, "--name", "Repo"]); run(home, ["project", "add", secondRepo, "--name", "Second repo"]); const taskchefDir = path.join(home, ".agents", "taskchef"); fs.mkdirSync(taskchefDir, { recursive: true }); const rejectedTaskchefRoot = path.join(base, "rejected-taskchef-root"); const secondRejectedRoot = path.join(base, "second-rejected-taskchef-root"); fs.writeFileSync(path.join(taskchefDir, "taskchef.json"), JSON.stringify({ schemaVersion: 2, projects: [{ name: "Rejected", path: rejectedTaskchefRoot, isGitRepository: true, githubRepos: [] }, { name: "Second rejected", path: secondRejectedRoot, isGitRepository: true, githubRepos: [] }] }), { mode: 0o600 }); const port = randomPort(); let remoteRequest = null; let remoteDiagnosticCursor = null; let remotePlanIdentities = null;
  try {
    const started = JSON.parse(run(home, ["dashboard", "start", "--port", String(port), "--json"]).stdout); assert.equal(started.action, "started"); assert.equal(started.url, `http://127.0.0.1:${port}/`); assert.equal(JSON.stringify(started).includes("capability"), false);
    const ownerPath = path.join(home, ".agents", "planrock", "dashboard-owner.json"); assert.equal(fs.statSync(ownerPath).mode & 0o777, 0o600); const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")); assert.equal(owner.controlProtocolVersion, CONTROL_PROTOCOL_VERSION); assert.equal(CONTROL_PROTOCOL_VERSION, 2);
    const reused = JSON.parse(run(home, ["dashboard", "start", "--port", String(port), "--json"]).stdout); assert.equal(reused.action, "reused");
    const conflict = run(home, ["dashboard", "start", "--port", String(port + 1)], 1); assert.match(conflict.stderr, new RegExp(`already running on port ${port}`));
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await fetch(`${baseUrl}/api/health`); assert.equal(health.status, 200); const healthBody = await health.json(); assert.equal(healthBody.instanceId, owner.instanceId); assert.equal(healthBody.controlProtocolVersion, CONTROL_PROTOCOL_VERSION); assert.equal(health.headers.get("access-control-allow-origin"), null);
    assert.equal((await fetch(`${baseUrl}/api/overview`, { headers: { Origin: "http://evil.example" } })).status, 403);
    const reboundStatus = await new Promise((resolve, reject) => { const request = http.request({ host: "127.0.0.1", port, path: "/api/overview", headers: { Host: "attacker.example", Origin: "http://attacker.example" } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); }); request.on("error", reject); request.end(); }); assert.equal(reboundStatus, 403);
    assert.equal(trustedLanAddress("192.168.1.20"), true); assert.equal(trustedLanAddress("10.0.0.5"), true); assert.equal(trustedLanAddress("8.8.8.8"), false);
    const lanAddress = Object.values(os.networkInterfaces()).flat().find((entry) => entry && !entry.internal && entry.family === "IPv4" && trustedLanAddress(entry.address));
    if (lanAddress) {
      const lanHost = `${lanAddress.address}:${port}`; const lanOverview = await new Promise((resolve, reject) => { const request = http.request({ host: "127.0.0.1", port, path: "/api/overview", headers: { Host: lanHost, Origin: `http://${lanHost}` } }, (response) => { const chunks = []; response.on("data", (chunk) => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) })); }); request.on("error", reject); request.end(); }); assert.equal(lanOverview.status, 200); assert.equal(lanOverview.body.nativeActions, false);
      remoteRequest = (requestPath) => new Promise((resolve, reject) => { const request = http.request({ host: lanAddress.address, port, path: requestPath, headers: { Host: lanHost, Origin: `http://${lanHost}` } }, (response) => { const chunks = []; response.on("data", (chunk) => chunks.push(chunk)); response.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let body; try { body = JSON.parse(text); } catch { body = text; } resolve({ status: response.statusCode, body }); }); }); request.on("error", reject); request.end(); });
      const remoteOverview = await remoteRequest("/api/overview"); assert.equal(remoteOverview.status, 200); assert.equal(remoteOverview.body.nativeActions, false); assert.equal(JSON.stringify(remoteOverview.body).includes(repo), false); assert.equal(remoteOverview.body.nextUp[0].absolutePath, undefined); assert.match(remoteOverview.body.snapshotId, /^[0-9a-f-]{36}$/); const matchingPlans = remoteOverview.body.nextUp.filter((item) => item.relativeFile === "plans/one.md"); assert.equal(matchingPlans.length, 2); assert.notEqual(matchingPlans[0].pathRef, matchingPlans[1].pathRef); assert.ok(matchingPlans.every((item) => item.registryId === undefined && item.pathRef === `/projects/${item.projectId}/plans/one.md` && /^[0-9a-f]{24}$/.test(item.id) && /^[0-9a-f]{24}$/.test(item.projectId))); remotePlanIdentities = new Map(matchingPlans.map((item) => [item.projectName, { id: item.id, projectId: item.projectId }]));
      for (const collection of ["openPlans", "repositories", "invalidPlans", "plansDirectories", "diagnostics"]) { const remotePage = await remoteRequest(`/api/collection?name=${collection}${collection === "diagnostics" ? "&limit=1" : ""}`); assert.equal(remotePage.status, 200); assert.equal(JSON.stringify(remotePage.body).includes(base), false); assert.ok(remotePage.body.items.every((item) => item.registryId === undefined)); if (collection === "diagnostics") { remoteDiagnosticCursor = remotePage.body.nextCursor; assert.ok(remoteDiagnosticCursor); } }
      const firstPlan = matchingPlans.find((item) => item.projectName === "Repo"); const secondPlan = matchingPlans.find((item) => item.projectName === "Second repo"); for (const [plan, expected] of [[firstPlan, "Repository documentation"], [secondPlan, "Second repository documentation"]]) { const remoteSource = await remoteRequest(`/api/plan?id=${plan.id}`); assert.equal(remoteSource.status, 200); const markdownRef = plan.pathRef.replace(/\/plans\/one\.md$/, "/docs/guide.md"); const remoteMarkdown = await remoteRequest(`/api/markdown?id=${plan.id}&path=${encodeURIComponent(markdownRef)}`); assert.equal(remoteMarkdown.status, 200); assert.equal(remoteMarkdown.body.absolutePath, undefined); assert.equal(remoteMarkdown.body.pathRef, markdownRef); assert.match(remoteMarkdown.body.content, new RegExp(expected)); assert.equal(JSON.stringify(remoteMarkdown.body).includes(repo), false); }
      const remoteRefresh = await new Promise((resolve, reject) => { const request = http.request({ host: lanAddress.address, port, path: "/api/refresh", method: "POST", headers: { Host: lanHost, Origin: `http://${lanHost}`, "Content-Type": "application/json", "Content-Length": 2 } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); }); request.on("error", reject); request.end("{}"); }); assert.equal(remoteRefresh, 403);
    }
    const overview = await fetch(`${baseUrl}/api/overview`, { headers: { Origin: baseUrl } }); assert.equal(overview.status, 200); const overviewBody = await overview.json(); assert.equal(overviewBody.schemaVersion, 2); assert.equal(overviewBody.summary.open, 2); assert.equal(overviewBody.nativeActions, true); assert.equal(overviewBody.latestScan.outcome, "success"); assert.equal(JSON.stringify(overviewBody.latestScan).includes(repo), false); assert.equal(JSON.stringify(overviewBody.diagnostics).includes(rejectedTaskchefRoot), false);
    const localDiagnostics = await fetch(`${baseUrl}/api/collection?name=diagnostics&limit=1`); const localDiagnosticsBody = await localDiagnostics.json(); assert.equal(localDiagnosticsBody.snapshotId, overviewBody.snapshotId); assert.equal(JSON.stringify(localDiagnosticsBody.items).includes(rejectedTaskchefRoot), true);
    const plans = await fetch(`${baseUrl}/api/collection?name=openPlans`); const planId = (await plans.json()).items.find((item) => item.projectName === "Repo").id;
    const planSource = await fetch(`${baseUrl}/api/plan?id=${encodeURIComponent(planId)}`); assert.equal(planSource.status, 200); assert.match(planSource.headers.get("content-type"), /^text\/plain/); assert.match(await planSource.text(), /Unsafe <img src=x>/);
    assert.equal((await fetch(`${baseUrl}/api/plan?id=missing`)).status, 404);
    const markdown = await fetch(`${baseUrl}/api/markdown?id=${encodeURIComponent(planId)}&path=${encodeURIComponent(fs.realpathSync.native(path.join(repo, "docs", "guide.md")))}`); assert.equal(markdown.status, 200); const markdownBody = await markdown.json(); assert.equal(markdownBody.relativeFile, "docs/guide.md"); assert.match(markdownBody.content, /Repository documentation/);
    assert.equal((await fetch(`${baseUrl}/api/markdown?id=${encodeURIComponent(planId)}&path=${encodeURIComponent(path.join(repo, "docs", "details.md"))}`)).status, 404);
    const nestedMarkdown = await fetch(`${baseUrl}/api/markdown?id=${encodeURIComponent(planId)}&source=${encodeURIComponent(markdownBody.absolutePath)}&path=${encodeURIComponent(fs.realpathSync.native(path.join(repo, "docs", "details.md")))}`); assert.equal(nestedMarkdown.status, 200); assert.match((await nestedMarkdown.json()).content, /Nested documentation/);
    assert.equal((await fetch(`${baseUrl}/api/markdown?id=${encodeURIComponent(planId)}&path=${encodeURIComponent(path.join(repo, "docs", "private.md"))}`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/markdown?id=${encodeURIComponent(planId)}&path=${encodeURIComponent(path.join(base, "outside.md"))}`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/open-plan?id=${encodeURIComponent(planId)}`, { method: "POST", headers: { Origin: "http://evil.example" }, body: "{}" })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/open-plan?id=${encodeURIComponent(planId)}`, { method: "POST", body: "{}" })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/open-plan?id=${encodeURIComponent(planId)}`, { method: "POST", headers: { Host: "viewer.example", Origin: "http://viewer.example" }, body: "{}" })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/open-plan?id=${encodeURIComponent(planId)}`, { method: "POST", headers: { Host: "127.attacker.example", Origin: "http://127.attacker.example" }, body: "{}" })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/open-plan?id=${encodeURIComponent(planId)}`, { method: "POST", headers: { Origin: baseUrl }, body: "{}" })).status, 200);
    const session = "codex:019e2f18-930f-7052-999f-e3b083d9373f";
    assert.equal((await fetch(`${baseUrl}/api/open-chat?id=${encodeURIComponent(planId)}&session=${encodeURIComponent(session)}`, { method: "POST", headers: { Origin: "http://evil.example" }, body: "{}" })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/open-chat?id=${encodeURIComponent(planId)}&session=${encodeURIComponent(session)}`, { method: "POST", headers: { Host: "viewer.example", Origin: "http://viewer.example" }, body: "{}" })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/open-chat?id=${encodeURIComponent(planId)}&session=${encodeURIComponent(session)}`, { method: "POST", headers: { Host: "127.attacker.example", Origin: "http://127.attacker.example" }, body: "{}" })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/open-chat?id=${encodeURIComponent(planId)}&session=${encodeURIComponent("codex:11111111-1111-1111-1111-111111111111")}`, { method: "POST", headers: { Origin: baseUrl }, body: "{}" })).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/open-chat?id=${encodeURIComponent(planId)}&session=${encodeURIComponent(session)}`, { method: "POST", headers: { Origin: baseUrl }, body: "{}" })).status, 200);
    const originalPlan = path.join(repo, "plans", "one-original.md"); fs.renameSync(path.join(repo, "plans", "one.md"), originalPlan); fs.symlinkSync(path.join(repo, "docs", "guide.md"), path.join(repo, "plans", "one.md"));
    assert.equal((await fetch(`${baseUrl}/api/open-plan?id=${encodeURIComponent(planId)}`, { method: "POST", headers: { Origin: baseUrl }, body: "{}" })).status, 500); fs.unlinkSync(path.join(repo, "plans", "one.md")); fs.renameSync(originalPlan, path.join(repo, "plans", "one.md"));
    const indexedPlanContent = fs.readFileSync(path.join(repo, "plans", "one.md")); fs.writeFileSync(path.join(repo, "plans", "one.md"), "---\ntitle: Replaced plan\nstate: open\n---\n");
    assert.equal((await fetch(`${baseUrl}/api/open-plan?id=${encodeURIComponent(planId)}`, { method: "POST", headers: { Origin: baseUrl }, body: "{}" })).status, 500); fs.writeFileSync(path.join(repo, "plans", "one.md"), indexedPlanContent);
    const originalPlans = path.join(repo, "plans-original"); const outsidePlans = path.join(base, "outside-plans"); fs.mkdirSync(outsidePlans); fs.writeFileSync(path.join(outsidePlans, "one.md"), "escaped source"); fs.renameSync(path.join(repo, "plans"), originalPlans); fs.symlinkSync(outsidePlans, path.join(repo, "plans"), "dir");
    assert.equal((await fetch(`${baseUrl}/api/plan?id=${encodeURIComponent(planId)}`)).status, 404); fs.unlinkSync(path.join(repo, "plans")); fs.renameSync(originalPlans, path.join(repo, "plans"));
    const secondViewer = await fetch(`${baseUrl}/api/overview`, { headers: { Origin: baseUrl } }); assert.equal(secondViewer.status, 200);
    assert.equal((await fetch(`${baseUrl}/api/control/stop`, { method: "POST", body: "{}" })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/control/stop`, { method: "POST", headers: { Host: "viewer.example", Origin: "http://viewer.example" }, body: "{}" })).status, 403);
    const preflight = await fetch(`${baseUrl}/api/refresh`, { method: "OPTIONS", headers: { Origin: "http://viewer.example" } }); assert.equal(preflight.status, 403); assert.equal(preflight.headers.get("access-control-allow-origin"), null);
    assert.equal((await fetch(`${baseUrl}/api/refresh`, { method: "POST", headers: { Origin: "http://evil.example", "Content-Type": "application/json" }, body: "{}" })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/refresh`, { method: "POST", headers: { Origin: baseUrl, "Content-Type": "application/json" }, body: "{}" })).status, 200); if (remoteRequest && remotePlanIdentities) { const refreshedRemote = await remoteRequest("/api/overview"); for (const item of refreshedRemote.body.nextUp.filter((plan) => remotePlanIdentities.has(plan.projectName))) assert.deepEqual({ id: item.id, projectId: item.projectId }, remotePlanIdentities.get(item.projectName)); }
    fs.writeFileSync(path.join(repo, "plans", "two.md"), "---\ntitle: Watched plan\nstate: open\n---\n"); await new Promise((resolve) => setTimeout(resolve, 500));
    const watched = await fetch(`${baseUrl}/api/overview`); assert.equal((await watched.json()).summary.open, 3);
    const beforeFailure = JSON.parse(fs.readFileSync(path.join(home, ".agents", "planrock", "index.json"), "utf8")).snapshotId; fs.writeFileSync(path.join(home, ".agents", "planrock", "planrock.json"), "invalid-json", { mode: 0o600 });
    const failedRefresh = await fetch(`${baseUrl}/api/refresh`, { method: "POST", body: "{}" }); const failedBody = await failedRefresh.json(); assert.equal(failedBody.snapshotId, beforeFailure); assert.equal(failedBody.health.state, "stale"); if (remoteRequest && remoteDiagnosticCursor) assert.equal((await remoteRequest(`/api/collection?name=diagnostics&limit=1&cursor=${encodeURIComponent(remoteDiagnosticCursor)}`)).status, 409);
    const staleOverview = await fetch(`${baseUrl}/api/overview`); const staleBody = await staleOverview.json(); assert.equal(staleBody.health.state, "stale"); assert.equal(staleBody.latestScan.outcome, "failed"); assert.equal(JSON.stringify(staleBody.latestScan).includes(home), false); assert.equal(JSON.stringify(staleBody.latestScan).includes("invalid-json"), false); assert.equal(staleBody.latestScan.diagnostics[0].message, "Bounded refresh failed"); assert.equal(JSON.stringify(staleBody.health).includes(home), false); assert.equal(staleBody.health.message, "Bounded refresh failed");
    const html = await fetch(`${baseUrl}/`); assert.equal(html.status, 200); assert.match(html.headers.get("content-security-policy"), /frame-ancestors 'none'/); assert.doesNotMatch(await html.text(), /script>alert|Unsafe <img/);
    assert.match(run(home, ["dashboard", "stop", "--port", String(port + 1)], 1).stderr, /assertion failed/);
    assert.match(run(home, ["dashboard", "status", "--port", String(port + 1)], 1).stderr, /assertion failed/);
    assert.equal(JSON.parse(run(home, ["dashboard", "status", "--json"]).stdout).running, true);
  } finally { run(home, ["dashboard", "stop", "--port", String(port)]); }
  assert.equal(JSON.parse(run(home, ["dashboard", "status", "--json"]).stdout).running, false);
});

test("unknown occupied listener is preserved", { skip: !enabled }, async () => {
  const { home } = fixture(); const port = randomPort(); const server = net.createServer(() => {}); await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  try { assert.match(run(home, ["dashboard", "start", "--port", String(port)], 1).stderr, /unknown process/); assert.equal(server.listening, true); } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("dashboard lifecycle health requests have an absolute deadline", { skip: !enabled }, async () => {
  const { home } = fixture(); const port = randomPort(); const instanceId = "trickle-instance"; const currentBirthIdentity = birthIdentity(); if (!currentBirthIdentity) return; run(home, ["project", "list"]);
  const server = http.createServer((request, response) => { if (request.url === "/api/identity") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ service: "planrock", pid: process.pid, instanceId })); return; } response.writeHead(200, { "Content-Type": "application/json" }); const interval = setInterval(() => response.write(" "), 100); response.on("close", () => clearInterval(interval)); }); await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const owner = { schemaVersion: 1, pid: process.pid, birthIdentity: currentBirthIdentity, port, instanceId, packageVersion: "1.2.4", controlProtocolVersion: 1, startedAt: new Date().toISOString() }; fs.writeFileSync(path.join(home, ".agents", "planrock", "dashboard-owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  try { const startedAt = Date.now(); const status = await runAsync(home, ["dashboard", "status", "--port", String(port), "--json"]); assert.equal(status.status, 0, status.stderr); assert.equal(JSON.parse(status.stdout).running, false); assert.ok(Date.now() - startedAt < 4000); } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("dashboard lifecycle commands preserve an unrelated listener when identity does not match", { skip: !enabled }, async () => {
  const { home } = fixture(); const port = randomPort(); let stopRequests = 0; run(home, ["project", "list"]);
  const server = http.createServer((request, response) => { if (request.url === "/api/control/stop") stopRequests += 1; response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ service: "other", instanceId: "spoofed" })); }); await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const ownerPath = path.join(home, ".agents", "planrock", "dashboard-owner.json"); const owner = { schemaVersion: 1, pid: 99999999, birthIdentity: "stale", port, instanceId: "stale-instance", packageVersion: "1.2.4", controlProtocolVersion: 1, startedAt: new Date().toISOString() }; fs.writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  try {
    const opened = run(home, ["dashboard", "open", "--port", String(port)], 1); assert.match(opened.stderr, /could not be identified/);
    const started = run(home, ["dashboard", "start", "--port", String(port)], 1); assert.match(started.stderr, /could not be identified/);
    assert.equal(JSON.parse(run(home, ["dashboard", "status", "--port", String(port), "--json"]).stdout).running, false);
    const stopped = run(home, ["dashboard", "stop", "--port", String(port)], 1); assert.match(stopped.stderr, /owner record was retained/);
    fs.writeFileSync(ownerPath, `${JSON.stringify({ ...owner, pid: process.pid, birthIdentity: undefined })}\n`, { mode: 0o600 });
    assert.equal(JSON.parse(run(home, ["dashboard", "status", "--port", String(port), "--json"]).stdout).running, false);
    assert.equal(stopRequests, 0);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("racing starts converge on one identified owner", { skip: !enabled }, async () => {
  const { home } = fixture(); const port = randomPort();
  try {
    const results = await Promise.all([runAsync(home, ["dashboard", "start", "--port", String(port), "--json"]), runAsync(home, ["dashboard", "start", "--port", String(port), "--json"])]);
    assert.ok(results.every((result) => result.status === 0), results.map((result) => result.stderr).join("\n"));
    assert.deepEqual(results.map((result) => JSON.parse(result.stdout).action).sort(), ["reused", "started"]);
    const pids = new Set(results.map((result) => JSON.parse(result.stdout).owner.pid)); assert.equal(pids.size, 1);
  } finally { run(home, ["dashboard", "stop", "--port", String(port)]); }
});

test("slow initial refresh is tracked before the start command finishes", { skip: !enabled }, async () => {
  const { home } = fixture(); const port = randomPort(); const ownerPath = path.join(home, ".agents", "planrock", "dashboard-owner.json");
  const starting = runAsync(home, ["dashboard", "start", "--port", String(port), "--json"], { PLANROCK_TEST_REFRESH_DELAY_MS: "5500" });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(fs.existsSync(ownerPath), true); assert.equal(JSON.parse(run(home, ["dashboard", "status", "--json"]).stdout).running, true);
  const result = await starting; assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).action, "started");
  run(home, ["dashboard", "stop", "--port", String(port)]);
});

test("owner record persistence failure terminates the identified child", { skip: !enabled }, async () => {
  const { home } = fixture(); const port = randomPort(); const failed = await runAsync(home, ["dashboard", "start", "--port", String(port), "--json"], { PLANROCK_TEST_OWNER_WRITE_FAILURE: "1" });
  assert.equal(failed.status, 1); assert.match(failed.stderr, /Simulated owner record write failure/); assert.equal(fs.existsSync(path.join(home, ".agents", "planrock", "dashboard-owner.json")), false);
  const started = JSON.parse(run(home, ["dashboard", "start", "--port", String(port), "--json"]).stdout); assert.equal(started.action, "started"); run(home, ["dashboard", "stop", "--port", String(port)]);
});

test("stop retains an active owner record when identity verification fails", { skip: !enabled }, () => {
  const { home } = fixture(); const port = randomPort(); const ownerPath = path.join(home, ".agents", "planrock", "dashboard-owner.json");
  const started = JSON.parse(run(home, ["dashboard", "start", "--port", String(port), "--json"]).stdout); assert.equal(started.action, "started");
  const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")); fs.writeFileSync(ownerPath, `${JSON.stringify({ ...owner, instanceId: "wrong-instance" })}\n`, { mode: 0o600 });
  const failed = run(home, ["dashboard", "stop", "--port", String(port)], 1); assert.match(failed.stderr, /owner record was retained/); assert.equal(fs.existsSync(ownerPath), true);
  fs.writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 }); run(home, ["dashboard", "stop", "--port", String(port)]);
});

test("dashboard reports degraded health for an unavailable registered root", { skip: !enabled }, async () => {
  const { base, home } = fixture(); const repo = path.join(base, "repo"); fs.mkdirSync(path.join(repo, "plans"), { recursive: true }); run(home, ["project", "add", repo, "--name", "Repo"]); fs.renameSync(repo, `${repo}-away`);
  const port = randomPort(); const ownerPath = path.join(home, ".agents", "planrock", "dashboard-owner.json");
  try {
    run(home, ["dashboard", "start", "--port", String(port), "--json"]); const baseUrl = `http://127.0.0.1:${port}`;
    const health = await fetch(`${baseUrl}/api/health`); const body = await health.json(); assert.equal(body.health.state, "degraded");
  } finally { run(home, ["dashboard", "stop", "--port", String(port)]); }
});

test("legacy authenticated owners remain controllable without exposing their capability", { skip: !enabled }, async () => {
  const currentBirthIdentity = birthIdentity(); if (!currentBirthIdentity) return;
  const { home } = fixture(); const port = randomPort(); const instanceId = "legacy-instance"; const capability = "legacy-secret-capability"; let stopAuthorized = false;
  run(home, ["project", "list"]);
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/identity") { response.end(JSON.stringify({ service: "planrock", pid: process.pid, instanceId })); return; }
    const authorized = request.headers.authorization === `Bearer ${capability}`;
    if (!authorized) { response.writeHead(401); response.end(JSON.stringify({ error: "AUTH_REQUIRED" })); return; }
    if (request.url === "/api/health") { response.end(JSON.stringify({ service: "planrock", pid: process.pid, birthIdentity: currentBirthIdentity, instanceId, packageVersion: packageJson.version, controlProtocolVersion: 1, port, health: { state: "healthy", message: "" }, snapshotId: "legacy" })); return; }
    if (request.url === "/api/control/mint" && request.method === "POST") { if (request.headers.origin !== `http://127.0.0.1:${port}`) { response.writeHead(403); response.end(JSON.stringify({ error: "ORIGIN_REJECTED" })); return; } response.end(JSON.stringify({ token: "legacy-bootstrap" })); return; }
    if (request.url === "/api/control/stop" && request.method === "POST") { stopAuthorized = request.headers.origin === `http://127.0.0.1:${port}`; response.writeHead(stopAuthorized ? 202 : 403); response.end(JSON.stringify({ stopping: stopAuthorized })); if (stopAuthorized) setImmediate(() => server.close()); return; }
    response.writeHead(404); response.end(JSON.stringify({ error: "NOT_FOUND" }));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const ownerPath = path.join(home, ".agents", "planrock", "dashboard-owner.json"); const owner = { schemaVersion: 1, pid: process.pid, birthIdentity: currentBirthIdentity, port, capability, instanceId, packageVersion: packageJson.version, controlProtocolVersion: 1, startedAt: new Date().toISOString() };
  fs.writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  try {
    const status = await runAsync(home, ["dashboard", "status", "--json"]); assert.equal(status.status, 0, status.stderr); assert.equal(JSON.parse(status.stdout).running, true); assert.equal(status.stdout.includes(capability), false);
    const opened = await runAsync(home, ["dashboard", "open", "--json"]); assert.equal(opened.status, 0, opened.stderr); assert.equal(JSON.parse(opened.stdout).url, `http://127.0.0.1:${port}/#bootstrap=legacy-bootstrap`); assert.equal(opened.stdout.includes(capability), false);
    const started = await runAsync(home, ["dashboard", "start", "--port", String(port), "--json"]); assert.equal(started.status, 0, started.stderr); assert.equal(JSON.parse(started.stdout).action, "started"); assert.equal(JSON.parse(started.stdout).url, `http://127.0.0.1:${port}/`); assert.equal(started.stdout.includes(capability), false); assert.equal(stopAuthorized, true);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    const status = JSON.parse(run(home, ["dashboard", "status", "--json"]).stdout); if (status.running) run(home, ["dashboard", "stop", "--port", String(port)]);
  }
});

test("identified newer or incompatible listeners fail safely without shutdown", { skip: !enabled }, async () => {
  const currentBirthIdentity = birthIdentity(); if (!currentBirthIdentity) return;
  for (const variant of [{ packageVersion: "99.0.0", controlProtocolVersion: 1 }, { packageVersion: "1.0.0", controlProtocolVersion: 99 }]) {
    const { home } = fixture(); const port = randomPort(); const instanceId = "test-instance"; let stopRequests = 0;
    run(home, ["project", "list"]);
    const server = http.createServer((request, response) => { if (request.url === "/api/control/stop") stopRequests += 1; response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ service: "planrock", pid: process.pid, birthIdentity: currentBirthIdentity, instanceId, port, ...variant })); });
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    const ownerPath = path.join(home, ".agents", "planrock", "dashboard-owner.json"); const owner = { schemaVersion: 1, pid: process.pid, birthIdentity: currentBirthIdentity, port, instanceId, ...variant, startedAt: new Date().toISOString() }; fs.writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    try {
      const started = await runAsync(home, ["dashboard", "start", "--port", String(port)]); assert.equal(started.status, 1); assert.match(started.stderr, /incompatible control protocol/);
      const stopped = await runAsync(home, ["dashboard", "stop", "--port", String(port)]); assert.equal(stopped.status, 1); assert.match(stopped.stderr, /incompatible control protocol/);
      assert.equal(stopRequests, 0); assert.equal(server.listening, true); assert.equal(fs.existsSync(ownerPath), true);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  }
});

test("stale owner recovery and restart rotate instance identities", { skip: !enabled }, async () => {
  const { home } = fixture(); const port = randomPort(); run(home, ["project", "list"]); const ownerPath = path.join(home, ".agents", "planrock", "dashboard-owner.json");
  fs.writeFileSync(ownerPath, `${JSON.stringify({ schemaVersion: 1, pid: 99999999, birthIdentity: "stale", port, instanceId: "stale-instance", packageVersion: "1.0.0", controlProtocolVersion: 1 })}\n`, { mode: 0o600 });
  let first;
  try { first = JSON.parse(run(home, ["dashboard", "start", "--port", String(port), "--json"]).stdout); assert.equal(first.action, "started"); const firstOwner = JSON.parse(fs.readFileSync(ownerPath, "utf8")); run(home, ["dashboard", "stop", "--port", String(port)]); const second = JSON.parse(run(home, ["dashboard", "start", "--port", String(port), "--json"]).stdout); assert.equal(second.action, "started"); const secondOwner = JSON.parse(fs.readFileSync(ownerPath, "utf8")); assert.notEqual(firstOwner.instanceId, secondOwner.instanceId); } finally { const status = JSON.parse(run(home, ["dashboard", "status", "--json"]).stdout); if (status.running) run(home, ["dashboard", "stop", "--port", String(port)]); }
});
