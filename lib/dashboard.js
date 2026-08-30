const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const crypto = require("node:crypto");
const { Worker } = require("node:worker_threads");
const { execFileSync, spawn } = require("node:child_process");
const { CONTROL_PROTOCOL_VERSION, DEFAULT_PORT, LIMITS, STORAGE_DIR } = require("./constants");
const { loadIndex, pageCollection } = require("./indexer");
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

async function authenticatedHealth(owner) {
  if (!owner || !Number.isInteger(owner.port) || typeof owner.capability !== "string" || !(await instanceIdentityMatches(owner))) return null;
  try {
    const response = await request(owner.port, "/api/health", { capability: owner.capability });
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
async function waitForHealth(owner, attempts = 50) { for (let index = 0; index < attempts; index += 1) { const health = await authenticatedHealth(owner); if (health) return health; await new Promise((resolve) => setTimeout(resolve, 100)); } return null; }
async function waitForSettledHealth(owner, attempts = 1250) { for (let index = 0; index < attempts; index += 1) { const health = await authenticatedHealth(owner); if (!health || health.health?.state !== "loading") return health; await new Promise((resolve) => setTimeout(resolve, 100)); } return authenticatedHealth(owner); }
async function waitForRelease(port) { for (let index = 0; index < 50; index += 1) { if (!(await portInUse(port))) return true; await new Promise((resolve) => setTimeout(resolve, 100)); } return false; }

async function mintUrl(owner) {
  const health = await authenticatedHealth(owner);
  if (!health || health.packageVersion !== owner.packageVersion || health.controlProtocolVersion !== owner.controlProtocolVersion) throw new Error("Recorded dashboard could not be authenticated; no bootstrap token was requested");
  const result = await request(owner.port, "/api/control/mint", { capability: owner.capability, method: "POST", body: {} });
  if (result.status !== 200 || !result.body?.token) throw new Error("Authenticated dashboard did not mint a browser bootstrap token");
  return `http://127.0.0.1:${owner.port}/#bootstrap=${encodeURIComponent(result.body.token)}`;
}

async function startDashboard(port = DEFAULT_PORT) {
  const lock = await acquireLifecycleLock();
  try {
    let owner = readOwner(); const health = await authenticatedHealth(owner);
    if (health) {
      if (owner.port !== port) throw new Error(`Planrock dashboard is already running on port ${owner.port}; stop it before starting on ${port}`);
      if (health.packageVersion === packageJson.version && health.controlProtocolVersion === CONTROL_PROTOCOL_VERSION) return { action: "reused", owner: { ...owner, capability: undefined }, url: await mintUrl(owner) };
      if (health.controlProtocolVersion !== CONTROL_PROTOCOL_VERSION || health.packageVersion.localeCompare(packageJson.version, undefined, { numeric: true }) > 0) throw new Error(`Authenticated Planrock ${health.packageVersion} uses incompatible control protocol ${health.controlProtocolVersion}; run dashboard stop with that installed version`);
      const stopped = await request(owner.port, "/api/control/stop", { capability: owner.capability, method: "POST", body: {} });
      if (stopped.status !== 202 || !(await waitForRelease(owner.port))) throw new Error(`Authenticated Planrock ${health.packageVersion} could not hand off cleanly`);
      try { fs.unlinkSync(OWNER_PATH); } catch (error) { if (error.code !== "ENOENT") throw error; }
      owner = null;
    } else if (owner) {
      if (await portInUse(owner.port)) throw new Error(`Recorded listener on port ${owner.port} could not be authenticated; it was not modified`);
      try { fs.unlinkSync(OWNER_PATH); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (await portInUse(port)) throw new Error(`Port ${port} is occupied by an unknown or unauthenticated process; it was not modified`);
    const capability = secureRandom(32); const instanceId = secureRandom(24);
    const child = spawn(process.execPath, [path.join(__dirname, "..", "scripts", "planrock"), "dashboard", "serve", "--port", String(port)], { detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    let childExited = false; child.once("exit", () => { childExited = true; });
    child.stdin.end(JSON.stringify({ capability, instanceId })); child.unref();
    owner = { schemaVersion: 1, pid: child.pid, birthIdentity: processBirthIdentity(child.pid), port, capability, instanceId, packageVersion: packageJson.version, controlProtocolVersion: CONTROL_PROTOCOL_VERSION, startedAt: new Date().toISOString() };
    let ownerPersisted = false;
    try {
      const ready = await waitForHealth(owner);
      if (!ready) throw new Error(`Planrock dashboard failed to bind an authenticated listener on port ${port}`);
      if (process.env.PLANROCK_SERVER_TESTS === "1" && process.env.PLANROCK_TEST_OWNER_WRITE_FAILURE === "1") throw new Error("Simulated owner record write failure");
      writePrivateJson(OWNER_PATH, owner); ownerPersisted = true;
      await waitForSettledHealth(owner);
      return { action: "started", owner: { ...owner, capability: undefined }, url: await mintUrl(owner) };
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
  const health = await authenticatedHealth(owner); return { running: Boolean(health), owner: { ...owner, capability: undefined }, health };
}
async function stopDashboard(assertedPort) {
  const lock = await acquireLifecycleLock();
  try {
    const owner = readOwner(); if (!owner) return { action: "not-running" };
    if (assertedPort !== undefined && owner.port !== assertedPort) throw new Error(`Recorded dashboard uses port ${owner.port}; --port ${assertedPort} assertion failed`);
    const health = await authenticatedHealth(owner);
    if (!health) {
      if (recordedProcessMayBeActive(owner) || await portInUse(owner.port)) throw new Error(`Recorded dashboard on port ${owner.port} is still active or ambiguous but could not be authenticated; owner record was retained`);
      fs.unlinkSync(OWNER_PATH); return { action: "stale-record-removed", port: owner.port };
    }
    const response = await request(owner.port, "/api/control/stop", { capability: owner.capability, method: "POST", body: {} });
    if (response.status !== 202 || !(await waitForRelease(owner.port))) throw new Error("Authenticated dashboard did not stop cleanly");
    fs.unlinkSync(OWNER_PATH); return { action: "stopped", port: owner.port };
  } finally { releaseLock(lock); }
}

function parseCookies(header = "") { return Object.fromEntries(header.split(";").map((part) => part.trim().split("=")).filter((parts) => parts.length === 2)); }
function safeTokenEqual(actual, expected) { const left = Buffer.from(String(actual || "")); const right = Buffer.from(String(expected || "")); return left.length === right.length && crypto.timingSafeEqual(left, right); }
function setBounded(map, key, value, limit = 256) { map.set(key, value); while (map.size > limit) map.delete(map.keys().next().value); }
function json(res, status, body, headers = {}) { const payload = Buffer.from(JSON.stringify(body)); res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": payload.length, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...headers }); res.end(payload); }
function securityHeaders() { return { "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" }; }

async function readStdinConfig() { const chunks = []; for await (const chunk of process.stdin) { chunks.push(chunk); if (Buffer.concat(chunks).length > 4096) throw new Error("Dashboard startup payload too large"); } const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value.capability || !value.instanceId) throw new Error("Dashboard startup credentials missing"); return value; }

async function serveDashboard(port) {
  const { capability, instanceId } = await readStdinConfig();
  let snapshot = loadIndex({ refreshIfMissing: false }) || { schemaVersion: 1, snapshotId: `loading-${instanceId}`, refreshedAt: new Date().toISOString(), incomplete: true, summary: { projects: 0, explicitRoots: 0, open: 0, closed: 0, invalid: 0 }, repositories: [], plans: [], openPlans: [], closedPlans: [], invalidPlans: [], diagnostics: [], plansDirectories: [] };
  let healthState = { state: "loading", message: "Initial bounded refresh is running" };
  const sessions = new Map(); const bootstraps = new Map(); const watchers = new Map(); let debounce = null; let stopping = false; let refreshPromise = null; let refreshWorker = null;
  function refresh() {
    if (refreshPromise) return refreshPromise;
    healthState = { state: "loading", message: "Bounded refresh is running" };
    refreshPromise = new Promise((resolve) => {
      const worker = new Worker(path.join(__dirname, "dashboard-refresh-worker.js")); refreshWorker = worker; let settled = false;
      const finish = (result) => { if (settled) return; settled = true; refreshWorker = null; if (result.ok) { const next = loadIndex({ refreshIfMissing: false }); if (next) snapshot = next; healthState = { state: snapshot.incomplete ? "degraded" : "healthy", message: snapshot.incomplete ? "Latest scan is incomplete" : "" }; resetWatchers(); } else healthState = { state: "stale", message: result.message || "Dashboard refresh worker failed" }; refreshPromise = null; resolve(); };
      worker.once("message", finish); worker.once("error", (error) => finish({ ok: false, message: String(error.message).slice(0, 4096) })); worker.once("exit", (code) => { if (code !== 0) finish({ ok: false, message: `Dashboard refresh worker exited with code ${code}` }); });
    });
    return refreshPromise;
  }
  function resetWatchers() {
    for (const watcher of watchers.values()) watcher.close(); watchers.clear();
    for (const dir of snapshot.plansDirectories || []) try { const watcher = fs.watch(dir, () => { clearTimeout(debounce); debounce = setTimeout(() => void refresh(), 250); }); watcher.on("error", () => { healthState = { state: "degraded", message: `Watcher failed for ${dir}` }; clearTimeout(debounce); debounce = setTimeout(() => void refresh(), 250); }); watchers.set(dir, watcher); } catch { healthState = { state: "degraded", message: `Watcher unavailable for ${dir}` }; }
  }
  resetWatchers(); const hourly = setInterval(() => void refresh(), 60 * 60 * 1000); hourly.unref();
  const server = http.createServer(async (req, res) => {
    const expectedHost = `127.0.0.1:${port}`; if (req.headers.host !== expectedHost) { json(res, 400, { error: "HOST_REJECTED" }, securityHeaders()); return; }
    let url; try { url = new URL(req.url, `http://${expectedHost}`); } catch { json(res, 400, { error: "BAD_URL" }, securityHeaders()); return; }
    const bearer = req.headers.authorization?.startsWith("Bearer ") && safeTokenEqual(req.headers.authorization.slice(7), capability); const sessionId = parseCookies(req.headers.cookie).planrock_session; const session = sessionId && sessions.get(sessionId); const sessionValid = session && session.expiresAt > Date.now();
    if (url.pathname === "/api/identity" && req.method === "GET") { json(res, 200, { service: "planrock", pid: process.pid, instanceId }, securityHeaders()); return; }
    if (url.pathname === "/api/health") { if (!bearer && !sessionValid) { json(res, 401, { error: "AUTH_REQUIRED" }, securityHeaders()); return; } json(res, 200, { service: "planrock", pid: process.pid, birthIdentity: processBirthIdentity(process.pid), instanceId, packageVersion: packageJson.version, controlProtocolVersion: CONTROL_PROTOCOL_VERSION, port, health: healthState, snapshotId: snapshot.snapshotId }, securityHeaders()); return; }
    if (url.pathname === "/api/control/mint" && req.method === "POST") { if (!bearer) { json(res, 401, { error: "AUTH_REQUIRED" }, securityHeaders()); return; } if (req.headers.origin !== `http://${expectedHost}`) { json(res, 403, { error: "ORIGIN_REJECTED" }, securityHeaders()); return; } const token = secureRandom(24); setBounded(bootstraps, token, Date.now() + 60_000); json(res, 200, { token, expiresInSeconds: 60 }, securityHeaders()); return; }
    if (url.pathname === "/api/control/stop" && req.method === "POST") { if (!bearer) { json(res, 401, { error: "AUTH_REQUIRED" }, securityHeaders()); return; } if (req.headers.origin !== `http://${expectedHost}`) { json(res, 403, { error: "ORIGIN_REJECTED" }, securityHeaders()); return; } json(res, 202, { stopping: true }, securityHeaders()); if (!stopping) { stopping = true; setImmediate(() => server.close(() => process.exit(0))); } return; }
    if (url.pathname === "/api/bootstrap" && req.method === "POST") {
      if (req.headers.origin !== `http://${expectedHost}`) { json(res, 403, { error: "ORIGIN_REJECTED" }, securityHeaders()); return; }
      const token = req.headers.authorization?.startsWith("Bootstrap ") ? req.headers.authorization.slice(10) : ""; const expiry = bootstraps.get(token); bootstraps.delete(token);
      if (!expiry || expiry <= Date.now()) { json(res, 401, { error: "BOOTSTRAP_INVALID" }, securityHeaders()); return; }
      const id = secureRandom(24); setBounded(sessions, id, { expiresAt: Date.now() + 12 * 60 * 60 * 1000 }); json(res, 200, { ok: true }, { ...securityHeaders(), "Set-Cookie": `planrock_session=${id}; HttpOnly; SameSite=Strict; Path=/api` }); return;
    }
    if (url.pathname.startsWith("/api/")) {
      if (!sessionValid) { json(res, 401, { error: "AUTH_REQUIRED" }, securityHeaders()); return; }
      if ((req.headers.origin && req.headers.origin !== `http://${expectedHost}`) || req.headers["sec-fetch-site"] === "cross-site") { json(res, 403, { error: "ORIGIN_REJECTED" }, securityHeaders()); return; }
      if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && req.headers.origin !== `http://${expectedHost}`) { json(res, 403, { error: "ORIGIN_REJECTED" }, securityHeaders()); return; }
      if (url.pathname === "/api/overview" && req.method === "GET") { const nextUp = pageCollection(snapshot, "openPlans", { limit: 200 }); json(res, 200, { schemaVersion: 1, snapshotId: snapshot.snapshotId, refreshedAt: snapshot.refreshedAt, incomplete: snapshot.incomplete, health: healthState, summary: snapshot.summary, diagnostics: snapshot.diagnostics.slice(0, 100), nextUp: nextUp.items, omittedNextUp: snapshot.openPlans.length - nextUp.items.length }, securityHeaders()); return; }
      if (url.pathname === "/api/collection" && req.method === "GET") { try { json(res, 200, pageCollection(snapshot, url.searchParams.get("name") || "openPlans", { cursor: url.searchParams.get("cursor"), limit: url.searchParams.get("limit") || 100 }), securityHeaders()); } catch (error) { json(res, error.code === "STALE_CURSOR" ? 409 : 400, { error: error.code || "BAD_PAGE", message: error.message }, securityHeaders()); } return; }
      if (url.pathname === "/api/refresh" && req.method === "POST") { await refresh(); json(res, 200, { snapshotId: snapshot.snapshotId, refreshedAt: snapshot.refreshedAt, health: healthState }, securityHeaders()); return; }
      json(res, 404, { error: "NOT_FOUND" }, securityHeaders()); return;
    }
    const assetsRoot = path.join(__dirname, "..", "dist", "dashboard"); let relative; try { relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1)); } catch { res.writeHead(400, securityHeaders()); res.end(); return; }
    const target = path.resolve(assetsRoot, relative); if (target !== assetsRoot && !target.startsWith(`${assetsRoot}${path.sep}`)) { res.writeHead(404, securityHeaders()); res.end(); return; }
    let body; try { body = fs.readFileSync(target); } catch { res.writeHead(404, securityHeaders()); res.end(); return; }
    const type = target.endsWith(".html") ? "text/html; charset=utf-8" : target.endsWith(".js") ? "text/javascript; charset=utf-8" : target.endsWith(".css") ? "text/css; charset=utf-8" : target.endsWith(".woff2") ? "font/woff2" : "application/octet-stream";
    res.writeHead(200, { ...securityHeaders(), "Content-Type": type, "Content-Length": body.length, "Cache-Control": target.endsWith(".html") ? "no-store" : "public, max-age=31536000, immutable" }); res.end(body);
  });
  server.on("error", (error) => { process.stderr.write(`${error.message}\n`); process.exit(1); });
  server.listen({ host: "127.0.0.1", port, exclusive: true }, () => void refresh());
  const close = () => { clearInterval(hourly); if (refreshWorker) void refreshWorker.terminate(); for (const watcher of watchers.values()) watcher.close(); server.close(() => process.exit(0)); };
  process.on("SIGTERM", close); process.on("SIGINT", close);
}

module.exports = { OWNER_PATH, dashboardStatus, mintUrl, readOwner, serveDashboard, startDashboard, stopDashboard };
