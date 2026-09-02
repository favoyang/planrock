const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { execFile, execFileSync, spawn } = require("node:child_process");
const { CONTROL_PROTOCOL_VERSION, DEFAULT_PORT, LIMITS, STORAGE_DIR } = require("./constants");
const { fingerprint, loadIndex, loadLatestScan, pageCollection } = require("./indexer");
const { atomicWriteJson, ensureStorage, safeReadFile, secureRandom } = require("./security");
const packageJson = require("../package.json");

const OWNER_PATH = path.join(STORAGE_DIR, "dashboard-owner.json");
const LOCK_PATH = path.join(STORAGE_DIR, "dashboard-lifecycle.lock");
const OWNER_LIMIT = 64 * 1024;

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function processBirthIdentity(pid) {
  if (!processAlive(pid)) return null;
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return `linux:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
    }
    if (process.platform === "darwin") return `darwin:${execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 }).trim()}`;
  } catch {}
  return null;
}

function writePrivateJson(target, value) { atomicWriteJson(target, value, OWNER_LIMIT); }
function readOwner() {
  try { return JSON.parse(safeReadFile(OWNER_PATH, OWNER_LIMIT).buffer.toString("utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function removeExact(target, expectedNonce) {
  let value;
  try { value = JSON.parse(safeReadFile(path.join(target, "lock.json"), OWNER_LIMIT).buffer.toString("utf8")); } catch { return false; }
  if (value.nonce !== expectedNonce) return false;
  const quarantine = `${target}.stale.${secureRandom(8)}`;
  try { fs.renameSync(target, quarantine); } catch { return false; }
  fs.unlinkSync(path.join(quarantine, "lock.json")); fs.rmdirSync(quarantine); return true;
}

function acquireLock() {
  ensureStorage();
  for (const entry of fs.readdirSync(STORAGE_DIR).filter((name) => name.startsWith(".dashboard-lock.")).slice(0, 64)) {
    const staging = path.join(STORAGE_DIR, entry);
    let record; try { record = JSON.parse(safeReadFile(path.join(staging, "lock.json"), OWNER_LIMIT).buffer.toString("utf8")); } catch { continue; }
    const alive = processAlive(record.pid); const actualBirth = alive ? processBirthIdentity(record.pid) : null;
    if ((!alive || (actualBirth && record.birthIdentity && actualBirth !== record.birthIdentity)) && record.nonce) removeExact(staging, record.nonce);
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nonce = secureRandom(18); const staging = path.join(STORAGE_DIR, `.dashboard-lock.${process.pid}.${nonce}`);
    fs.mkdirSync(staging, { mode: 0o700 }); writePrivateJson(path.join(staging, "lock.json"), { nonce, pid: process.pid, birthIdentity: processBirthIdentity(process.pid), createdAt: new Date().toISOString() });
    try { fs.renameSync(staging, LOCK_PATH); return { nonce }; } catch (error) {
      try { fs.unlinkSync(path.join(staging, "lock.json")); fs.rmdirSync(staging); } catch {}
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      let existing;
      try { existing = JSON.parse(safeReadFile(path.join(LOCK_PATH, "lock.json"), OWNER_LIMIT).buffer.toString("utf8")); } catch { throw new Error("Dashboard lifecycle lock is ambiguous; retry after inspecting the storage root"); }
      const alive = processAlive(existing.pid); const actualBirth = alive ? processBirthIdentity(existing.pid) : null;
      if (alive && (!actualBirth || !existing.birthIdentity || actualBirth === existing.birthIdentity)) throw new Error("Another Planrock dashboard lifecycle operation is running");
      if (!removeExact(LOCK_PATH, existing.nonce)) throw new Error("Dashboard lifecycle lock changed during recovery");
    }
  }
  throw new Error("Unable to acquire dashboard lifecycle lock");
}
function releaseLock(lock) { if (!removeExact(LOCK_PATH, lock.nonce)) throw new Error("Dashboard lifecycle lock ownership changed"); }
async function acquireLifecycleLock() {
  const deadline = Date.now() + 10_000;
  while (true) {
    try { return acquireLock(); } catch (error) {
      if (!/lifecycle operation is running/.test(error.message) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function request(port, pathname, { capability, method = "GET", body, timeout = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null; let settled = false; let req;
    const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(deadline); callback(value); };
    const fail = (error) => { if (req) req.destroy(); finish(reject, error); };
    const deadline = setTimeout(() => fail(new Error("request deadline exceeded")), timeout); deadline.unref();
    req = http.request({ host: "127.0.0.1", port, path: pathname, method, headers: { Host: `127.0.0.1:${port}`, ...(capability ? { Authorization: `Bearer ${capability}` } : {}), ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length, Origin: `http://127.0.0.1:${port}` } : {}) } }, (res) => {
      const chunks = []; let bytes = 0;
      res.on("data", (chunk) => { bytes += chunk.length; if (bytes > 1024 * 1024) { res.destroy(); fail(new Error("response exceeds 1 MiB")); return; } chunks.push(chunk); });
      res.on("end", () => { let parsed = null; try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {} finish(resolve, { status: res.statusCode, body: parsed }); });
      res.on("error", fail);
    });
    req.on("error", fail); if (payload) req.write(payload); req.end();
  });
}

async function identifiedHealth(owner) {
  if (!owner || !Number.isInteger(owner.port) || !(await instanceIdentityMatches(owner))) return null;
  try {
    const response = await request(owner.port, "/api/health", { capability: typeof owner.capability === "string" ? owner.capability : undefined });
    if (response.status !== 200 || response.body?.instanceId !== owner.instanceId || response.body?.pid !== owner.pid || (owner.birthIdentity && response.body?.birthIdentity !== owner.birthIdentity)) return null;
    return response.body;
  } catch { return null; }
}

async function instanceIdentityMatches(owner) {
  if (!owner || !Number.isInteger(owner.port) || typeof owner.instanceId !== "string" || !owner.instanceId) return false;
  try {
    const response = await request(owner.port, "/api/identity");
    return response.status === 200 && response.body?.service === "planrock" && response.body?.instanceId === owner.instanceId && response.body?.pid === owner.pid;
  } catch { return false; }
}

function recordedProcessMayBeActive(owner) {
  if (!owner || !processAlive(owner.pid)) return false;
  const actualBirth = processBirthIdentity(owner.pid);
  return !owner.birthIdentity || !actualBirth || actualBirth === owner.birthIdentity;
}

function portInUse(port) { return new Promise((resolve) => { const socket = net.connect({ host: "127.0.0.1", port }); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => resolve(false)); socket.setTimeout(500, () => { socket.destroy(); resolve(false); }); }); }
async function waitForHealth(owner, attempts = 50) { for (let index = 0; index < attempts; index += 1) { const health = await identifiedHealth(owner); if (health) return health; await new Promise((resolve) => setTimeout(resolve, 100)); } return null; }
async function waitForSettledHealth(owner, attempts = 1250) { for (let index = 0; index < attempts; index += 1) { const health = await identifiedHealth(owner); if (!health || health.health?.state !== "loading") return health; await new Promise((resolve) => setTimeout(resolve, 100)); } return identifiedHealth(owner); }
async function waitForRelease(port) { for (let index = 0; index < 50; index += 1) { if (!(await portInUse(port))) return true; await new Promise((resolve) => setTimeout(resolve, 100)); } return false; }

async function mintUrl(owner) {
  const health = await identifiedHealth(owner);
  if (!health || health.packageVersion !== owner.packageVersion || health.controlProtocolVersion !== owner.controlProtocolVersion) throw new Error("Recorded dashboard could not be identified");
  if (typeof owner.capability === "string" && owner.capability) {
    const result = await request(owner.port, "/api/control/mint", { capability: owner.capability, method: "POST", body: {} });
    if (result.status !== 200 || !result.body?.token) throw new Error("Legacy dashboard did not mint a browser bootstrap token");
    return `http://127.0.0.1:${owner.port}/#bootstrap=${encodeURIComponent(result.body.token)}`;
  }
  return `http://127.0.0.1:${owner.port}/`;
}

function publicOwner(owner) { return owner ? { ...owner, capability: undefined } : owner; }

async function startDashboard(port = DEFAULT_PORT) {
  const lock = await acquireLifecycleLock();
  try {
    let owner = readOwner(); const health = await identifiedHealth(owner);
    if (health) {
      if (owner.port !== port) throw new Error(`Planrock dashboard is already running on port ${owner.port}; stop it before starting on ${port}`);
      if (!owner.capability && health.packageVersion === packageJson.version && health.controlProtocolVersion === CONTROL_PROTOCOL_VERSION) return { action: "reused", owner: publicOwner(owner), url: await mintUrl(owner) };
      const legacyAuthenticatedOwner = typeof owner.capability === "string" && owner.capability && health.controlProtocolVersion === 1;
      if ((!legacyAuthenticatedOwner && health.controlProtocolVersion !== CONTROL_PROTOCOL_VERSION) || health.packageVersion.localeCompare(packageJson.version, undefined, { numeric: true }) > 0) throw new Error(`Planrock ${health.packageVersion} uses incompatible control protocol ${health.controlProtocolVersion}; run dashboard stop with that installed version`);
      const stopped = await request(owner.port, "/api/control/stop", { capability: typeof owner.capability === "string" ? owner.capability : undefined, method: "POST", body: {} });
      if (stopped.status !== 202 || !(await waitForRelease(owner.port))) throw new Error(`Planrock ${health.packageVersion} could not hand off cleanly`);
      try { fs.unlinkSync(OWNER_PATH); } catch (error) { if (error.code !== "ENOENT") throw error; }
      owner = null;
    } else if (owner) {
      if (await portInUse(owner.port)) throw new Error(`Recorded listener on port ${owner.port} could not be identified; it was not modified`);
      try { fs.unlinkSync(OWNER_PATH); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (await portInUse(port)) throw new Error(`Port ${port} is occupied by an unknown process; it was not modified`);
    const instanceId = secureRandom(24);
    const child = spawn(process.execPath, [path.join(__dirname, "..", "scripts", "planrock"), "dashboard", "serve", "--port", String(port)], { detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    let childExited = false; child.once("exit", () => { childExited = true; });
    child.stdin.end(JSON.stringify({ instanceId })); child.unref();
    owner = { schemaVersion: 1, pid: child.pid, birthIdentity: processBirthIdentity(child.pid), port, instanceId, packageVersion: packageJson.version, controlProtocolVersion: CONTROL_PROTOCOL_VERSION, startedAt: new Date().toISOString() };
    let ownerPersisted = false;
    try {
      const ready = await waitForHealth(owner);
      if (!ready) throw new Error(`Planrock dashboard failed to bind an identified listener on port ${port}`);
      if (process.env.PLANROCK_SERVER_TESTS === "1" && process.env.PLANROCK_TEST_OWNER_WRITE_FAILURE === "1") throw new Error("Simulated owner record write failure");
      writePrivateJson(OWNER_PATH, owner); ownerPersisted = true;
      await waitForSettledHealth(owner);
      return { action: "started", owner: publicOwner(owner), url: await mintUrl(owner) };
    } catch (error) {
      if (!ownerPersisted) {
        if (!childExited && processBirthIdentity(child.pid) === owner.birthIdentity) child.kill("SIGTERM");
        await waitForRelease(port);
      }
      throw error;
    }
  } finally { releaseLock(lock); }
}

async function dashboardStatus(assertedPort) {
  const owner = readOwner(); if (!owner) return { running: false, owner: null };
  if (assertedPort !== undefined && owner.port !== assertedPort) throw new Error(`Recorded dashboard uses port ${owner.port}; --port ${assertedPort} assertion failed`);
  const health = await identifiedHealth(owner); return { running: Boolean(health), owner: publicOwner(owner), health };
}
async function stopDashboard(assertedPort) {
  const lock = await acquireLifecycleLock();
  try {
    const owner = readOwner(); if (!owner) return { action: "not-running" };
    if (assertedPort !== undefined && owner.port !== assertedPort) throw new Error(`Recorded dashboard uses port ${owner.port}; --port ${assertedPort} assertion failed`);
    const health = await identifiedHealth(owner);
    if (!health) {
      if (recordedProcessMayBeActive(owner) || await portInUse(owner.port)) throw new Error(`Recorded dashboard on port ${owner.port} is still active or ambiguous but could not be identified; owner record was retained`);
      fs.unlinkSync(OWNER_PATH); return { action: "stale-record-removed", port: owner.port };
    }
    const legacyAuthenticatedOwner = typeof owner.capability === "string" && owner.capability && health.controlProtocolVersion === 1;
    if ((!legacyAuthenticatedOwner && health.controlProtocolVersion !== CONTROL_PROTOCOL_VERSION) || health.packageVersion.localeCompare(packageJson.version, undefined, { numeric: true }) > 0) throw new Error(`Planrock ${health.packageVersion} uses incompatible control protocol ${health.controlProtocolVersion}; run dashboard stop with that installed version`);
    const response = await request(owner.port, "/api/control/stop", { capability: typeof owner.capability === "string" ? owner.capability : undefined, method: "POST", body: {} });
    if (response.status !== 202 || !(await waitForRelease(owner.port))) throw new Error("Dashboard did not stop cleanly");
    fs.unlinkSync(OWNER_PATH); return { action: "stopped", port: owner.port };
  } finally { releaseLock(lock); }
}

function json(res, status, body, headers = {}) { const payload = Buffer.from(JSON.stringify(body)); res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": payload.length, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...headers }); res.end(payload); }
function securityHeaders() { return { "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" }; }
function isLoopbackHost(hostname) {
  const normalized = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  return net.isIP(normalized) === 4 && normalized.split(".")[0] === "127";
}
function trustedLanAddress(address) {
  if (net.isIP(address) !== 4) return false; const [first, second] = address.split(".").map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254);
}
function localClient(req) { return isLoopbackHost(req.socket.remoteAddress?.replace(/^::ffff:/, "")); }
function localInterfaceHost(hostname) {
  const normalized = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHost(normalized)) return true;
  if (!trustedLanAddress(normalized)) return false;
  return Object.values(os.networkInterfaces()).flat().some((entry) => entry?.address.toLowerCase() === normalized);
}
function dashboardHostAllowed(req, port) {
  try { const parsed = new URL(`http://${req.headers.host}`); return Number(parsed.port || 80) === port && localInterfaceHost(parsed.hostname); } catch { return false; }
}
function apiRequestAllowed(req) {
  const origin = req.headers.origin; if (!origin) return true;
  try { const parsed = new URL(origin); return parsed.protocol === "http:" && parsed.host === req.headers.host; } catch { return false; }
}
function nativeActionsAvailable(req) {
  if (!localClient(req)) return false;
  try { return isLoopbackHost(new URL(`http://${req.headers.host}`).hostname); } catch { return false; }
}
function nativeActionAllowed(req) {
  const origin = req.headers.origin;
  if (!origin || !nativeActionsAvailable(req)) return false;
  try { const parsed = new URL(origin); return parsed.protocol === "http:" && isLoopbackHost(parsed.hostname) && parsed.host === req.headers.host; } catch { return false; }
}

function indexedPlanRepository(snapshot, plan) {
  const repository = snapshot.repositories.find((item) => item.id === plan.projectId);
  if (!repository || path.dirname(plan.relativeFile) !== "plans" || path.resolve(repository.root, plan.relativeFile) !== plan.absolutePath) throw new Error("Indexed plan path is no longer valid");
  return repository;
}

function directoryGuards(root, targetDirectory) {
  const relative = path.relative(root, targetDirectory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Markdown path escapes its repository");
  const directories = [root]; let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) { current = path.join(current, part); directories.push(current); }
  return directories.map((target) => {
    const before = fs.lstatSync(target);
    if (before.isSymbolicLink() || !before.isDirectory() || fs.realpathSync.native(target) !== target) throw new Error("Markdown directory is no longer valid");
    const after = fs.lstatSync(target);
    if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) throw new Error("Markdown directory changed during inspection");
    return { path: target, dev: before.dev, ino: before.ino };
  });
}

function planSourceGuards(snapshot, plan) {
  const repository = indexedPlanRepository(snapshot, plan);
  return directoryGuards(repository.root, path.dirname(plan.absolutePath));
}

function markdownLinks(sourcePath, content, repositoryRoot) {
  const targets = new Set(); const linkPattern = /\]\(([^)]+)\)/g; let match;
  while ((match = linkPattern.exec(content))) {
    let value = match[1].trim(); if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
    value = value.split(/[?#]/, 1)[0]; try { value = decodeURIComponent(value); } catch { continue; }
    if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value)) continue;
    const linked = path.resolve(path.dirname(sourcePath), value); const relative = path.relative(repositoryRoot, linked);
    if (/\.md(?:own)?$/i.test(linked) && relative && !relative.startsWith("..") && !path.isAbsolute(relative)) targets.add(linked);
  }
  return targets;
}

function markdownSource(snapshot, plan, requestedPath, requestedSource) {
  const repository = indexedPlanRepository(snapshot, plan);
  if (typeof requestedPath !== "string" || !path.isAbsolute(requestedPath) || !/\.md(?:own)?$/i.test(requestedPath)) throw new Error("Markdown path is invalid");
  const target = path.resolve(requestedPath); const relativeFile = path.relative(repository.root, target);
  if (!relativeFile || relativeFile.startsWith("..") || path.isAbsolute(relativeFile)) throw new Error("Markdown path escapes its repository");
  const source = requestedSource ? path.resolve(requestedSource) : plan.absolutePath; const sourceRelative = path.relative(repository.root, source);
  if (source !== plan.absolutePath && (!sourceRelative || sourceRelative.startsWith("..") || path.isAbsolute(sourceRelative) || !/\.md(?:own)?$/i.test(source))) throw new Error("Markdown source is invalid");
  const queue = [plan.absolutePath]; const visited = new Set(); let sourceLinks = null;
  while (queue.length && visited.size < 32) {
    const current = queue.shift(); if (visited.has(current)) continue; visited.add(current);
    const guards = current === plan.absolutePath ? planSourceGuards(snapshot, plan) : directoryGuards(repository.root, path.dirname(current));
    const { buffer } = safeReadFile(current, LIMITS.planBytes, { requireOwned: false, directoryGuards: guards }); const links = markdownLinks(current, buffer.toString("utf8"), repository.root);
    if (current === source) { sourceLinks = links; break; }
    for (const linked of links) if (!visited.has(linked)) queue.push(linked);
  }
  if (!sourceLinks?.has(target)) throw new Error("Markdown path is not linked by an authorized source");
  const guards = directoryGuards(repository.root, path.dirname(target));
  const { buffer } = safeReadFile(target, LIMITS.planBytes, { requireOwned: false, directoryGuards: guards });
  return { content: buffer.toString("utf8"), absolutePath: target, relativeFile: relativeFile.split(path.sep).join("/") };
}

function remoteOpaqueId(secret, kind, id) {
  return crypto.createHmac("sha256", secret).update(`${kind}\0${id}`).digest("hex").slice(0, 24);
}

function createRemoteIds(snapshot, secret) {
  const projectIds = new Map(snapshot.repositories.map((item) => [item.id, remoteOpaqueId(secret, "project", item.id)]));
  const planIds = new Map(snapshot.plans.map((item) => [item.id, remoteOpaqueId(secret, "plan", item.id)]));
  return { projectIds, planIds, plansByRemoteId: new Map(snapshot.plans.map((item) => [planIds.get(item.id), item])) };
}

function remoteProjectId(remoteIds, projectId) {
  const id = remoteIds.projectIds.get(projectId);
  if (!id) throw new Error("Unknown project");
  return id;
}

function remotePlanId(remoteIds, planId) {
  const id = remoteIds.planIds.get(planId);
  if (!id) throw new Error("Unknown plan");
  return id;
}

function remoteRepository(repository, remoteIds) {
  const id = remoteProjectId(remoteIds, repository.id);
  const { root, registryId, ...safe } = repository;
  return { ...safe, id };
}

function remotePlan(plan, remoteIds) {
  const projectId = remoteProjectId(remoteIds, plan.projectId);
  const { absolutePath, diagnostics, registryId, ...safe } = plan;
  return { ...safe, id: remotePlanId(remoteIds, plan.id), projectId, pathRef: `/projects/${projectId}/${plan.relativeFile.split(path.sep).join("/")}` };
}

function remoteCollection(snapshot, latestScan, collection, remoteIds) {
  if (["plans", "openPlans", "closedPlans"].includes(collection)) return snapshot[collection].map((item) => remotePlan(item, remoteIds));
  if (collection === "repositories") return snapshot.repositories.map((item) => remoteRepository(item, remoteIds));
  if (collection === "invalidPlans") return latestScan?.invalidPlans || [];
  if (collection === "diagnostics") return latestScan?.diagnostics || [];
  if (collection === "plansDirectories") return [];
  throw new Error(`Unknown collection: ${collection}`);
}

function remoteMarkdownPath(repository, remoteIds, reference) {
  const prefix = `/projects/${remoteProjectId(remoteIds, repository.id)}/`;
  if (typeof reference !== "string" || !reference.startsWith(prefix)) throw new Error("Markdown reference is invalid");
  const relative = reference.slice(prefix.length); if (!relative || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) throw new Error("Markdown reference is invalid");
  const target = path.resolve(repository.root, relative); if (path.relative(repository.root, target).startsWith("..")) throw new Error("Markdown reference escapes its repository");
  return target;
}

function requestedPlan(snapshot, requestedId, nativeActions, remoteIds) {
  return nativeActions ? snapshot.plans.find((item) => item.id === requestedId) : remoteIds.plansByRemoteId.get(requestedId);
}

function openSystemFile(target) {
  if (process.env.PLANROCK_SERVER_TESTS === "1") return Promise.resolve();
  const command = process.platform === "darwin" ? "/usr/bin/open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  const args = [target];
  return new Promise((resolve, reject) => execFile(command, args, { timeout: 5000, windowsHide: true }, (error) => error ? reject(error) : resolve()));
}

function codexThreadId(session) {
  const match = String(session).match(/^codex:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i);
  return match?.[1] || null;
}

function openCodexThread(threadId) {
  if (process.env.PLANROCK_SERVER_TESTS === "1") return Promise.resolve();
  const target = `codex://threads/${encodeURIComponent(threadId)}`;
  const command = process.platform === "darwin" ? "/usr/bin/open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", target] : [target];
  return new Promise((resolve, reject) => execFile(command, args, { timeout: 5000, windowsHide: true }, (error) => error ? reject(error) : resolve()));
}

async function readStdinConfig() { const chunks = []; for await (const chunk of process.stdin) { chunks.push(chunk); if (Buffer.concat(chunks).length > 4096) throw new Error("Dashboard startup payload too large"); } const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value.instanceId) throw new Error("Dashboard startup identity missing"); return value; }

async function serveDashboard(port) {
  const { instanceId } = await readStdinConfig();
  let snapshot = loadIndex({ refreshIfMissing: false }) || { schemaVersion: 1, snapshotId: `loading-${instanceId}`, refreshedAt: new Date().toISOString(), incomplete: true, summary: { projects: 0, explicitRoots: 0, open: 0, closed: 0, invalid: 0 }, repositories: [], plans: [], openPlans: [], closedPlans: [], invalidPlans: [], diagnostics: [], plansDirectories: [] };
  const remoteIdSecret = crypto.randomBytes(32); let remoteIds = createRemoteIds(snapshot, remoteIdSecret);
  let latestScan = loadLatestScan({ snapshotId: snapshot.snapshotId });
  let healthState = { state: "loading", message: "Initial bounded refresh is running" };
  const watchers = new Map(); let debounce = null; let stopping = false; let refreshPromise = null; let refreshWorker = null;
  function refresh(trigger = "dashboard") {
    if (refreshPromise) return refreshPromise;
    healthState = { state: "loading", message: "Bounded refresh is running" };
    refreshPromise = new Promise((resolve) => {
      const worker = new Worker(path.join(__dirname, "dashboard-refresh-worker.js"), { env: { ...process.env, PLANROCK_REFRESH_TRIGGER: trigger } }); refreshWorker = worker; let settled = false;
      const finish = (result) => { if (settled) return; settled = true; refreshWorker = null; if (result.ok) { const next = loadIndex({ refreshIfMissing: false }); if (next) { snapshot = next; remoteIds = createRemoteIds(snapshot, remoteIdSecret); } latestScan = loadLatestScan({ snapshotId: snapshot.snapshotId }); healthState = latestScan ? { state: snapshot.incomplete ? "degraded" : "healthy", message: snapshot.incomplete ? "Latest scan is incomplete" : "" } : { state: "stale", message: "Latest scan health is unavailable" }; resetWatchers(); } else { latestScan = loadLatestScan({ snapshotId: snapshot.snapshotId }); healthState = { state: "stale", message: result.message || "Dashboard refresh worker failed" }; } refreshPromise = null; resolve(); };
      worker.once("message", finish); worker.once("error", () => finish({ ok: false, message: "Dashboard refresh worker failed" })); worker.once("exit", (code) => { if (code !== 0) finish({ ok: false, message: "Dashboard refresh worker exited unexpectedly" }); });
    });
    return refreshPromise;
  }
  function resetWatchers() {
    for (const watcher of watchers.values()) watcher.close(); watchers.clear();
    for (const dir of snapshot.plansDirectories || []) try { const watcher = fs.watch(dir, () => { clearTimeout(debounce); debounce = setTimeout(() => void refresh("watcher"), 250); }); watcher.on("error", () => { healthState = { state: "degraded", message: "A plan-directory watcher failed" }; clearTimeout(debounce); debounce = setTimeout(() => void refresh("watcher"), 250); }); watchers.set(dir, watcher); } catch { healthState = { state: "degraded", message: "A plan-directory watcher is unavailable" }; }
  }
  resetWatchers(); const hourly = setInterval(() => void refresh("hourly"), 60 * 60 * 1000); hourly.unref();
  const server = http.createServer(async (req, res) => {
    const headers = securityHeaders();
    let url; try { url = new URL(req.url, "http://planrock.local"); } catch { json(res, 400, { error: "BAD_URL" }, headers); return; }
    if (!dashboardHostAllowed(req, port)) { json(res, 403, { error: "HOST_NOT_ALLOWED" }, headers); return; }
    if (url.pathname.startsWith("/api/") && !apiRequestAllowed(req)) { json(res, 403, { error: "CROSS_ORIGIN_REQUEST" }, headers); return; }
    if (req.method === "OPTIONS") { res.writeHead(204, headers); res.end(); return; }
    if (url.pathname === "/api/identity" && req.method === "GET") { json(res, 200, { service: "planrock", pid: process.pid, instanceId }, securityHeaders()); return; }
    if (url.pathname === "/api/health" && req.method === "GET") { json(res, 200, { service: "planrock", pid: process.pid, birthIdentity: processBirthIdentity(process.pid), instanceId, packageVersion: packageJson.version, controlProtocolVersion: CONTROL_PROTOCOL_VERSION, port, health: healthState, snapshotId: snapshot.snapshotId }, securityHeaders()); return; }
    if (url.pathname === "/api/control/stop" && req.method === "POST") { if (!nativeActionAllowed(req)) { json(res, 403, { error: "LOCAL_CONTROL_REQUIRED" }, securityHeaders()); return; } json(res, 202, { stopping: true }, securityHeaders()); if (!stopping) { stopping = true; setImmediate(() => server.close(() => process.exit(0))); } return; }
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/overview" && req.method === "GET") { const nativeActions = nativeActionsAvailable(req); const nextUp = (nativeActions ? snapshot.openPlans.slice(0, 200) : snapshot.openPlans.slice(0, 200).map((item) => remotePlan(item, remoteIds))); json(res, 200, { schemaVersion: 2, snapshotId: snapshot.snapshotId, refreshedAt: snapshot.refreshedAt, incomplete: snapshot.incomplete, latestScan, nativeActions, health: healthState, summary: snapshot.summary, diagnostics: (latestScan?.diagnostics || []).slice(0, 100), nextUp, omittedNextUp: snapshot.openPlans.length - nextUp.length }, securityHeaders()); return; }
      if (url.pathname === "/api/collection" && req.method === "GET") { try { const collection = url.searchParams.get("name") || "openPlans"; const nativeActions = nativeActionsAvailable(req); const attemptCollection = ["diagnostics", "invalidPlans"].includes(collection); const items = nativeActions ? snapshot[collection] : remoteCollection(snapshot, latestScan, collection, remoteIds); const collectionSnapshotId = !nativeActions && attemptCollection ? latestScan?.attemptId || snapshot.snapshotId : snapshot.snapshotId; const source = { snapshotId: collectionSnapshotId, incomplete: snapshot.incomplete, [collection]: items }; json(res, 200, pageCollection(source, collection, { cursor: url.searchParams.get("cursor"), limit: url.searchParams.get("limit") || 100 }), securityHeaders()); } catch (error) { json(res, error.code === "STALE_CURSOR" ? 409 : 400, { error: error.code || "BAD_PAGE", message: error.message }, securityHeaders()); } return; }
      if (url.pathname === "/api/plan" && req.method === "GET") { const nativeActions = nativeActionsAvailable(req); const plan = requestedPlan(snapshot, url.searchParams.get("id"), nativeActions, remoteIds); if (!plan) { json(res, 404, { error: "PLAN_NOT_FOUND" }, securityHeaders()); return; } try { const directoryGuards = planSourceGuards(snapshot, plan); const { buffer } = safeReadFile(plan.absolutePath, LIMITS.planBytes, { requireOwned: false, directoryGuards }); res.writeHead(200, { ...securityHeaders(), "Content-Type": "text/plain; charset=utf-8", "Content-Length": buffer.length, "Content-Disposition": "inline", "Cache-Control": "no-store" }); res.end(buffer); } catch { json(res, 404, { error: "PLAN_UNAVAILABLE" }, securityHeaders()); } return; }
      if (url.pathname === "/api/markdown" && req.method === "GET") { const nativeActions = nativeActionsAvailable(req); const plan = requestedPlan(snapshot, url.searchParams.get("id"), nativeActions, remoteIds); if (!plan) { json(res, 404, { error: "PLAN_NOT_FOUND" }, securityHeaders()); return; } try { const repository = indexedPlanRepository(snapshot, plan); const requestedPath = nativeActions ? url.searchParams.get("path") : remoteMarkdownPath(repository, remoteIds, url.searchParams.get("path")); const sourceParameter = url.searchParams.get("source"); const requestedSource = nativeActions || !sourceParameter ? sourceParameter : remoteMarkdownPath(repository, remoteIds, sourceParameter); const result = markdownSource(snapshot, plan, requestedPath, requestedSource); const projectId = remoteProjectId(remoteIds, repository.id); json(res, 200, nativeActions ? result : { content: result.content, pathRef: `/projects/${projectId}/${result.relativeFile}`, relativeFile: result.relativeFile }, securityHeaders()); } catch { json(res, 404, { error: "MARKDOWN_UNAVAILABLE" }, securityHeaders()); } return; }
      if (url.pathname === "/api/open-plan" && req.method === "POST") { if (!nativeActionAllowed(req)) { json(res, 403, { error: "CROSS_ORIGIN_NATIVE_ACTION" }, securityHeaders()); return; } const plan = snapshot.plans.find((item) => item.id === url.searchParams.get("id")); if (!plan) { json(res, 404, { error: "PLAN_NOT_FOUND" }, securityHeaders()); return; } try { const directoryGuards = planSourceGuards(snapshot, plan); const { stat } = safeReadFile(plan.absolutePath, LIMITS.planBytes, { requireOwned: false, directoryGuards }); if (fingerprint(stat) !== plan.fingerprint) throw new Error("Indexed plan file changed"); await openSystemFile(plan.absolutePath); json(res, 200, { opened: true }, securityHeaders()); } catch { json(res, 500, { error: "PLAN_OPEN_FAILED" }, securityHeaders()); } return; }
      if (url.pathname === "/api/open-chat" && req.method === "POST") { if (!nativeActionAllowed(req)) { json(res, 403, { error: "CROSS_ORIGIN_NATIVE_ACTION" }, securityHeaders()); return; } const plan = snapshot.plans.find((item) => item.id === url.searchParams.get("id")); const session = url.searchParams.get("session"); if (!plan) { json(res, 404, { error: "PLAN_NOT_FOUND" }, securityHeaders()); return; } if (!plan.agentSessions?.includes(session)) { json(res, 404, { error: "SESSION_NOT_FOUND" }, securityHeaders()); return; } const threadId = codexThreadId(session); if (!threadId) { json(res, 400, { error: "UNSUPPORTED_SESSION" }, securityHeaders()); return; } try { await openCodexThread(threadId); json(res, 200, { opened: true }, securityHeaders()); } catch { json(res, 500, { error: "CHAT_OPEN_FAILED" }, securityHeaders()); } return; }
      if (url.pathname === "/api/refresh" && req.method === "POST") { if (!localClient(req)) { json(res, 403, { error: "LOCAL_REFRESH_REQUIRED" }, securityHeaders()); return; } await refresh("manual"); json(res, 200, { snapshotId: snapshot.snapshotId, refreshedAt: snapshot.refreshedAt, latestScan, health: healthState }, securityHeaders()); return; }
      json(res, 404, { error: "NOT_FOUND" }, securityHeaders()); return;
    }
    const assetsRoot = path.join(__dirname, "..", "dist", "dashboard"); let relative; try { relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1)); } catch { res.writeHead(400, securityHeaders()); res.end(); return; }
    const target = path.resolve(assetsRoot, relative); if (target !== assetsRoot && !target.startsWith(`${assetsRoot}${path.sep}`)) { res.writeHead(404, securityHeaders()); res.end(); return; }
    let body; try { body = fs.readFileSync(target); } catch { res.writeHead(404, securityHeaders()); res.end(); return; }
    const type = target.endsWith(".html") ? "text/html; charset=utf-8" : target.endsWith(".js") ? "text/javascript; charset=utf-8" : target.endsWith(".css") ? "text/css; charset=utf-8" : target.endsWith(".woff2") ? "font/woff2" : "application/octet-stream";
    res.writeHead(200, { ...securityHeaders(), "Content-Type": type, "Content-Length": body.length, "Cache-Control": target.endsWith(".html") ? "no-store" : "public, max-age=31536000, immutable" }); res.end(body);
  });
  server.on("error", (error) => { process.stderr.write(`${error.message}\n`); process.exit(1); });
  server.listen({ host: "0.0.0.0", port, exclusive: true }, () => void refresh("startup"));
  const close = () => { clearInterval(hourly); if (refreshWorker) void refreshWorker.terminate(); for (const watcher of watchers.values()) watcher.close(); server.close(() => process.exit(0)); };
  process.on("SIGTERM", close); process.on("SIGINT", close);
}

module.exports = { OWNER_PATH, dashboardStatus, mintUrl, readOwner, serveDashboard, startDashboard, stopDashboard, trustedLanAddress };
