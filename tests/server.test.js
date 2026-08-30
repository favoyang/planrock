const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const test = require("node:test");

const enabled = process.env.PLANROCK_SERVER_TESTS === "1";
const root = path.resolve(__dirname, "..");
const cli = path.join(root, "scripts", "planrock");
function fixture() { const base = fs.mkdtempSync(path.join(os.tmpdir(), "planrock-server-")); const home = path.join(base, "home"); fs.mkdirSync(home); return { base, home }; }
function run(home, args, expected = 0) { const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, HOME: home }, encoding: "utf8" }); assert.equal(result.status, expected, result.stderr || result.stdout); return result; }
function randomPort() { return 45000 + Math.floor(Math.random() * 1000); }
function runAsync(home, args, extraEnv = {}) { return new Promise((resolve) => { const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, HOME: home, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] }); const stdout = []; const stderr = []; child.stdout.on("data", (chunk) => stdout.push(chunk)); child.stderr.on("data", (chunk) => stderr.push(chunk)); child.on("close", (status) => resolve({ status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") })); }); }
function rawRequest(port, pathname, headers) { return new Promise((resolve, reject) => { const request = http.get({ host: "127.0.0.1", port, path: pathname, headers }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); }); request.on("error", reject); }); }
function birthIdentity(pid = process.pid) { if (process.platform === "linux") { const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return `linux:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`; } if (process.platform === "darwin") return `darwin:${execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim()}`; return null; }

test("authenticated dashboard bootstrap, session, reuse, assertions, and shutdown", { skip: !enabled }, async () => {
  const { base, home } = fixture(); const repo = path.join(base, "repo"); fs.mkdirSync(path.join(repo, "plans"), { recursive: true }); fs.writeFileSync(path.join(repo, "plans", "one.md"), "---\ntitle: <script>alert(1)</script>\nstate: open\n---\n\n## Goal\n\nUnsafe <img src=x>.\n");
  run(home, ["project", "add", repo, "--name", "Repo"]); const port = randomPort();
  try {
    const started = JSON.parse(run(home, ["dashboard", "start", "--port", String(port), "--json"]).stdout); assert.equal(started.action, "started"); assert.match(started.url, /#bootstrap=/); assert.equal(JSON.stringify(started).includes("capability"), false);
    const ownerPath = path.join(home, ".agents", "planrock", "dashboard-owner.json"); assert.equal(fs.statSync(ownerPath).mode & 0o777, 0o600); const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    const reused = JSON.parse(run(home, ["dashboard", "start", "--port", String(port), "--json"]).stdout); assert.equal(reused.action, "reused");
    const conflict = run(home, ["dashboard", "start", "--port", String(port + 1)], 1); assert.match(conflict.stderr, new RegExp(`already running on port ${port}`));
    const baseUrl = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${baseUrl}/api/health`, { headers: { Host: `127.0.0.1:${port}` } })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/overview`, { headers: { Host: `127.0.0.1:${port}` } })).status, 401);
    const health = await fetch(`${baseUrl}/api/health`, { headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${owner.capability}` } }); assert.equal(health.status, 200); assert.equal((await health.json()).instanceId, owner.instanceId);
    const token = new URL(started.url).hash.slice("#bootstrap=".length); const bootstrapHeaders = { Host: `127.0.0.1:${port}`, Origin: baseUrl, Authorization: `Bootstrap ${decodeURIComponent(token)}`, "Content-Type": "application/json" };
    const bootstrap = await fetch(`${baseUrl}/api/bootstrap`, { method: "POST", headers: bootstrapHeaders, body: "{}" }); assert.equal(bootstrap.status, 200); const cookie = bootstrap.headers.get("set-cookie"); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    assert.equal((await fetch(`${baseUrl}/api/bootstrap`, { method: "POST", headers: bootstrapHeaders, body: "{}" })).status, 401);
    const overview = await fetch(`${baseUrl}/api/overview`, { headers: { Host: `127.0.0.1:${port}`, Cookie: cookie } }); assert.equal(overview.status, 200); assert.equal((await overview.json()).summary.open, 1);
    assert.equal((await fetch(`${baseUrl}/api/overview`, { headers: { Host: `127.0.0.1:${port}`, Cookie: cookie, Origin: "http://evil.example" } })).status, 403);
    assert.equal(await rawRequest(port, "/api/overview", { Host: "evil.example", Cookie: cookie }), 400);
    assert.equal((await fetch(`${baseUrl}/api/refresh`, { method: "POST", headers: { Host: `127.0.0.1:${port}`, Cookie: cookie, Origin: "http://evil.example", "Content-Type": "application/json" }, body: "{}" })).status, 403);
    fs.writeFileSync(path.join(repo, "plans", "two.md"), "---\ntitle: Watched plan\nstate: open\n---\n"); await new Promise((resolve) => setTimeout(resolve, 500));
    const watched = await fetch(`${baseUrl}/api/overview`, { headers: { Host: `127.0.0.1:${port}`, Cookie: cookie } }); assert.equal((await watched.json()).summary.open, 2);
    const beforeFailure = JSON.parse(fs.readFileSync(path.join(home, ".agents", "planrock", "index.json"), "utf8")).snapshotId; fs.writeFileSync(path.join(home, ".agents", "planrock", "planrock.json"), "invalid-json", { mode: 0o600 });
    const failedRefresh = await fetch(`${baseUrl}/api/refresh`, { method: "POST", headers: { Host: `127.0.0.1:${port}`, Cookie: cookie, Origin: baseUrl, "Content-Type": "application/json" }, body: "{}" }); const failedBody = await failedRefresh.json(); assert.equal(failedBody.snapshotId, beforeFailure); assert.equal(failedBody.health.state, "stale");
    const staleOverview = await fetch(`${baseUrl}/api/overview`, { headers: { Host: `127.0.0.1:${port}`, Cookie: cookie } }); assert.equal((await staleOverview.json()).health.state, "stale");
    const html = await fetch(`${baseUrl}/`, { headers: { Host: `127.0.0.1:${port}` } }); assert.equal(html.status, 200); assert.match(html.headers.get("content-security-policy"), /frame-ancestors 'none'/); assert.doesNotMatch(await html.text(), /script>alert|Unsafe <img/);
    assert.match(run(home, ["dashboard", "stop", "--port", String(port + 1)], 1).stderr, /assertion failed/);
    assert.match(run(home, ["dashboard", "status", "--port", String(port + 1)], 1).stderr, /assertion failed/);
    assert.equal(JSON.parse(run(home, ["dashboard", "status", "--json"]).stdout).running, true);
  } finally { run(home, ["dashboard", "stop", "--port", String(port)]); }
  assert.equal(JSON.parse(run(home, ["dashboard", "status", "--json"]).stdout).running, false);
});

test("unknown occupied listener is preserved", { skip: !enabled }, async () => {
  const { home } = fixture(); const port = randomPort(); const server = net.createServer(() => {}); await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  try { assert.match(run(home, ["dashboard", "start", "--port", String(port)], 1).stderr, /unknown or unauthenticated process/); assert.equal(server.listening, true); } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("dashboard lifecycle health requests have an absolute deadline", { skip: !enabled }, async () => {
  const { home } = fixture(); const port = randomPort(); const instanceId = "trickle-instance"; const currentBirthIdentity = birthIdentity(); if (!currentBirthIdentity) return; run(home, ["project", "list"]);
  const server = http.createServer((request, response) => { if (request.url === "/api/identity") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ service: "planrock", pid: process.pid, instanceId })); return; } response.writeHead(200, { "Content-Type": "application/json" }); const interval = setInterval(() => response.write(" "), 100); response.on("close", () => clearInterval(interval)); }); await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const owner = { schemaVersion: 1, pid: process.pid, birthIdentity: currentBirthIdentity, port, capability: "secret-capability", instanceId, packageVersion: "1.2.4", controlProtocolVersion: 1, startedAt: new Date().toISOString() }; fs.writeFileSync(path.join(home, ".agents", "planrock", "dashboard-owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  try { const startedAt = Date.now(); const status = await runAsync(home, ["dashboard", "status", "--port", String(port), "--json"]); assert.equal(status.status, 0, status.stderr); assert.equal(JSON.parse(status.stdout).running, false); assert.ok(Date.now() - startedAt < 4000); } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("dashboard lifecycle commands do not disclose a stale owner's capability to an unrelated listener", { skip: !enabled }, async () => {
  const { home } = fixture(); const port = randomPort(); let bearerRequests = 0; run(home, ["project", "list"]);
  const server = http.createServer((request, response) => { if (request.headers.authorization) bearerRequests += 1; response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ token: "spoofed" })); }); await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const ownerPath = path.join(home, ".agents", "planrock", "dashboard-owner.json"); const owner = { schemaVersion: 1, pid: 99999999, birthIdentity: "stale", port, capability: "secret-capability", instanceId: "stale-instance", packageVersion: "1.2.4", controlProtocolVersion: 1, startedAt: new Date().toISOString() }; fs.writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  try {
    const opened = run(home, ["dashboard", "open", "--port", String(port)], 1); assert.match(opened.stderr, /could not be authenticated/);
    const started = run(home, ["dashboard", "start", "--port", String(port)], 1); assert.match(started.stderr, /could not be authenticated/);
    assert.equal(JSON.parse(run(home, ["dashboard", "status", "--port", String(port), "--json"]).stdout).running, false);
    const stopped = run(home, ["dashboard", "stop", "--port", String(port)], 1); assert.match(stopped.stderr, /owner record was retained/);
    fs.writeFileSync(ownerPath, `${JSON.stringify({ ...owner, pid: process.pid, birthIdentity: undefined })}\n`, { mode: 0o600 });
    assert.equal(JSON.parse(run(home, ["dashboard", "status", "--port", String(port), "--json"]).stdout).running, false);
    assert.equal(bearerRequests, 0);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("racing starts converge on one authenticated owner", { skip: !enabled }, async () => {
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

test("owner record persistence failure terminates the authenticated child", { skip: !enabled }, async () => {
  const { home } = fixture(); const port = randomPort(); const failed = await runAsync(home, ["dashboard", "start", "--port", String(port), "--json"], { PLANROCK_TEST_OWNER_WRITE_FAILURE: "1" });
  assert.equal(failed.status, 1); assert.match(failed.stderr, /Simulated owner record write failure/); assert.equal(fs.existsSync(path.join(home, ".agents", "planrock", "dashboard-owner.json")), false);
  const started = JSON.parse(run(home, ["dashboard", "start", "--port", String(port), "--json"]).stdout); assert.equal(started.action, "started"); run(home, ["dashboard", "stop", "--port", String(port)]);
});

test("stop retains an active owner record when authentication fails", { skip: !enabled }, () => {
  const { home } = fixture(); const port = randomPort(); const ownerPath = path.join(home, ".agents", "planrock", "dashboard-owner.json");
  const started = JSON.parse(run(home, ["dashboard", "start", "--port", String(port), "--json"]).stdout); assert.equal(started.action, "started");
  const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")); fs.writeFileSync(ownerPath, `${JSON.stringify({ ...owner, capability: "wrong-capability" })}\n`, { mode: 0o600 });
  const failed = run(home, ["dashboard", "stop", "--port", String(port)], 1); assert.match(failed.stderr, /owner record was retained/); assert.equal(fs.existsSync(ownerPath), true);
  fs.writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 }); run(home, ["dashboard", "stop", "--port", String(port)]);
});

test("dashboard reports degraded health for an unavailable registered root", { skip: !enabled }, async () => {
  const { base, home } = fixture(); const repo = path.join(base, "repo"); fs.mkdirSync(path.join(repo, "plans"), { recursive: true }); run(home, ["project", "add", repo, "--name", "Repo"]); fs.renameSync(repo, `${repo}-away`);
  const port = randomPort(); const ownerPath = path.join(home, ".agents", "planrock", "dashboard-owner.json");
  try {
    run(home, ["dashboard", "start", "--port", String(port), "--json"]); const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")); const baseUrl = `http://127.0.0.1:${port}`;
    const health = await fetch(`${baseUrl}/api/health`, { headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${owner.capability}` } }); const body = await health.json(); assert.equal(body.health.state, "degraded");
  } finally { run(home, ["dashboard", "stop", "--port", String(port)]); }
});

test("authenticated newer or incompatible listeners fail safely without shutdown", { skip: !enabled }, async () => {
  const currentBirthIdentity = birthIdentity(); if (!currentBirthIdentity) return;
  for (const variant of [{ packageVersion: "99.0.0", controlProtocolVersion: 1 }, { packageVersion: "1.0.0", controlProtocolVersion: 99 }]) {
    const { home } = fixture(); const port = randomPort(); const capability = "test-capability"; const instanceId = "test-instance"; let stopRequests = 0;
    run(home, ["project", "list"]);
    const server = http.createServer((request, response) => { if (request.url === "/api/control/stop") stopRequests += 1; if (request.url !== "/api/identity" && request.headers.authorization !== `Bearer ${capability}`) { response.writeHead(401).end(); return; } response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ service: "planrock", pid: process.pid, birthIdentity: currentBirthIdentity, instanceId, port, ...variant })); });
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    const owner = { schemaVersion: 1, pid: process.pid, birthIdentity: currentBirthIdentity, port, capability, instanceId, ...variant, startedAt: new Date().toISOString() }; fs.writeFileSync(path.join(home, ".agents", "planrock", "dashboard-owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    try { const result = await runAsync(home, ["dashboard", "start", "--port", String(port)]); assert.equal(result.status, 1); assert.match(result.stderr, /incompatible control protocol/); assert.equal(stopRequests, 0); assert.equal(server.listening, true); } finally { await new Promise((resolve) => server.close(resolve)); }
  }
});

test("stale owner recovery and restart rotate capabilities", { skip: !enabled }, async () => {
  const { home } = fixture(); const port = randomPort(); run(home, ["project", "list"]); const ownerPath = path.join(home, ".agents", "planrock", "dashboard-owner.json");
  fs.writeFileSync(ownerPath, `${JSON.stringify({ schemaVersion: 1, pid: 99999999, birthIdentity: "stale", port, capability: "stale-capability", instanceId: "stale-instance", packageVersion: "1.0.0", controlProtocolVersion: 1 })}\n`, { mode: 0o600 });
  let first;
  try { first = JSON.parse(run(home, ["dashboard", "start", "--port", String(port), "--json"]).stdout); assert.equal(first.action, "started"); const firstOwner = JSON.parse(fs.readFileSync(ownerPath, "utf8")); run(home, ["dashboard", "stop", "--port", String(port)]); const second = JSON.parse(run(home, ["dashboard", "start", "--port", String(port), "--json"]).stdout); assert.equal(second.action, "started"); const secondOwner = JSON.parse(fs.readFileSync(ownerPath, "utf8")); assert.notEqual(firstOwner.capability, secondOwner.capability); assert.notEqual(firstOwner.instanceId, secondOwner.instanceId); } finally { const status = JSON.parse(run(home, ["dashboard", "status", "--json"]).stdout); if (status.running) run(home, ["dashboard", "stop", "--port", String(port)]); }
});
