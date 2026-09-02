const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { INDEX_SCHEMA_VERSION, LATEST_SCAN_SCHEMA_VERSION, LIMITS, PRIORITIES, STORAGE_DIR } = require("./constants");
const { discoverAll } = require("./discovery");
const { parsePlan } = require("./parser");
const { loadRegistry, registryDiagnostics } = require("./registry");
const { atomicWriteJson, diagnostic, ensureStorage, safeReadFile, withStorageLock } = require("./security");
const { importTaskChef } = require("./taskchef");

const INDEX_PATH = path.join(STORAGE_DIR, "index.json");
const LATEST_SCAN_PATH = path.join(STORAGE_DIR, "latest-scan.json");

function fingerprint(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function loadPreviousIndex() {
  try {
    const { buffer } = safeReadFile(INDEX_PATH, LIMITS.indexReadBytes);
    const value = JSON.parse(buffer.toString("utf8"));
    return value && value.schemaVersion === INDEX_SCHEMA_VERSION ? value : null;
  } catch { return null; }
}

function loadLatestScan({ snapshotId } = {}) {
  try {
    const { buffer } = safeReadFile(LATEST_SCAN_PATH, LIMITS.latestScanReadBytes);
    const value = JSON.parse(buffer.toString("utf8"));
    const scan = canonicalLatestScan(value);
    return scan && (!snapshotId || scan.outcome === "failed" || scan.snapshotId === snapshotId) ? scan : null;
  } catch { return null; }
}

function exactKeys(value, required, optional = []) {
  const keys = Object.keys(value); const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function canonicalRelativeFile(value) {
  return typeof value === "string" && Buffer.byteLength(value) <= LIMITS.pathBytes && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) && value.split(/[\\/]/).every((part) => part && part !== "." && part !== "..") ? value.replace(/\\/g, "/") : null;
}

function canonicalDiagnostic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, ["code", "severity", "message"], ["project", "relativeFile"]) || typeof value.code !== "string" || !value.code || Buffer.byteLength(value.code) > 256 || !["error", "warning", "info"].includes(value.severity) || typeof value.message !== "string" || Buffer.byteLength(value.message) > LIMITS.diagnosticBytes || (value.project !== undefined && (typeof value.project !== "string" || Buffer.byteLength(value.project) > 256))) return null;
  const relativeFile = value.relativeFile === undefined ? undefined : canonicalRelativeFile(value.relativeFile); if (value.relativeFile !== undefined && relativeFile === null) return null;
  return { code: value.code, severity: value.severity, message: value.message, ...(value.project ? { project: value.project } : {}), ...(relativeFile ? { relativeFile } : {}) };
}

function canonicalLatestScan(value) {
  const required = ["schemaVersion", "attemptId", "startedAt", "finishedAt", "durationMs", "trigger", "outcome", "snapshotId", "diagnostics", "invalidPlans", "omittedDiagnostics", "omittedInvalidPlans"];
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, required) || value.schemaVersion !== LATEST_SCAN_SCHEMA_VERSION || typeof value.attemptId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.attemptId) || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt)) || typeof value.finishedAt !== "string" || !Number.isFinite(Date.parse(value.finishedAt)) || !Number.isFinite(value.durationMs) || value.durationMs < 0 || typeof value.trigger !== "string" || !value.trigger || Buffer.byteLength(value.trigger) > 64 || !["success", "incomplete", "failed"].includes(value.outcome) || (value.outcome === "failed" ? value.snapshotId !== null : typeof value.snapshotId !== "string" || !value.snapshotId) || !Array.isArray(value.diagnostics) || value.diagnostics.length > LIMITS.latestScanCollectionItems || !Array.isArray(value.invalidPlans) || value.invalidPlans.length > LIMITS.latestScanCollectionItems || !Number.isInteger(value.omittedDiagnostics) || value.omittedDiagnostics < 0 || !Number.isInteger(value.omittedInvalidPlans) || value.omittedInvalidPlans < 0) return null;
  const diagnostics = value.diagnostics.map(canonicalDiagnostic); if (diagnostics.some((item) => item === null)) return null;
  const invalidPlans = [];
  for (const item of value.invalidPlans) {
    if (!item || typeof item !== "object" || Array.isArray(item) || !exactKeys(item, ["project", "relativeFile", "diagnostics"]) || typeof item.project !== "string" || !item.project || Buffer.byteLength(item.project) > 256 || !Array.isArray(item.diagnostics) || item.diagnostics.length > LIMITS.latestScanPlanDiagnostics) return null;
    const relativeFile = canonicalRelativeFile(item.relativeFile); const itemDiagnostics = item.diagnostics.map(canonicalDiagnostic); if (relativeFile === null || itemDiagnostics.some((entry) => entry === null)) return null;
    invalidPlans.push({ project: item.project, relativeFile, diagnostics: itemDiagnostics });
  }
  return { schemaVersion: LATEST_SCAN_SCHEMA_VERSION, attemptId: value.attemptId, startedAt: value.startedAt, finishedAt: value.finishedAt, durationMs: value.durationMs, trigger: value.trigger, outcome: value.outcome, snapshotId: value.snapshotId, diagnostics, invalidPlans, omittedDiagnostics: value.omittedDiagnostics, omittedInvalidPlans: value.omittedInvalidPlans };
}

function comparePlans(a, b) {
  return PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || b.createdAt.localeCompare(a.createdAt) || a.projectName.localeCompare(b.projectName) || a.relativeFile.localeCompare(b.relativeFile);
}

function takeByteBounded(source, budget) {
  const values = []; let used = 2;
  for (const value of source) {
    const bytes = Buffer.byteLength(JSON.stringify(value)) + (values.length ? 1 : 0);
    if (used + bytes > budget) break;
    values.push(value); used += bytes;
  }
  return values;
}

function takePersistedBounded(source, budget) {
  const values = []; let used = 2;
  for (const value of source) {
    const bytes = Buffer.byteLength(JSON.stringify(value, null, 2)) + (values.length ? 2 : 0);
    if (used + bytes > budget) break;
    values.push(value); used += bytes;
  }
  return values;
}

function publicDiagnostic(item, redactions = []) {
  const orderedRedactions = redactions.filter(Boolean).sort((a, b) => b.length - a.length);
  const redact = (input) => orderedRedactions.reduce((value, redaction) => value.split(redaction).join("[path]"), String(input));
  return { code: item.code, severity: item.severity, message: redact(item.message), ...(item.project ? { project: redact(item.project) } : {}), ...(item.relativeFile ? { relativeFile: redact(item.relativeFile).split(path.sep).join("/") } : {}) };
}

function diagnosticOrder(a, b) {
  const severity = ["error", "warning", "info"];
  return severity.indexOf(a.severity) - severity.indexOf(b.severity) || String(a.project || "").localeCompare(String(b.project || "")) || String(a.relativeFile || "").localeCompare(String(b.relativeFile || "")) || String(a.code || "").localeCompare(String(b.code || ""));
}

function diagnosticIdentity(item) { return JSON.stringify([item.code, item.severity, item.message, item.project || "", item.relativeFile || ""]); }

function latestScanRecord({ startedAt, finishedAt, trigger, outcome, snapshot = null, error = null, redactions: suppliedRedactions = [] }) {
  const diagnosticsSource = snapshot ? snapshot.diagnostics : [diagnostic("SCAN_REFRESH_FAILED", "error", "Bounded refresh failed")];
  const invalidSource = snapshot ? snapshot.invalidPlans : [];
  const redactions = [STORAGE_DIR, ...suppliedRedactions, ...(snapshot?.repositories || []).map((item) => item.root)];
  const invalidPlansSource = invalidSource.map((item) => { const publicContext = publicDiagnostic({ code: "CONTEXT", severity: "info", message: "", project: item.projectName, relativeFile: item.relativeFile }, redactions); return { project: publicContext.project, relativeFile: publicContext.relativeFile, diagnostics: (item.diagnostics || []).map((diagnosticItem) => publicDiagnostic({ ...diagnosticItem, project: diagnosticItem.project || item.projectName, relativeFile: diagnosticItem.relativeFile || item.relativeFile }, redactions)).sort(diagnosticOrder) }; }).sort((a, b) => String(a.project || "").localeCompare(String(b.project || "")) || String(a.relativeFile || "").localeCompare(String(b.relativeFile || "")));
  const invalidDiagnosticIdentities = new Set(invalidPlansSource.flatMap((item) => item.diagnostics.map(diagnosticIdentity)));
  const seenDiagnostics = new Set();
  const uniqueDiagnosticsSource = diagnosticsSource.map((item) => publicDiagnostic(item, redactions)).filter((item) => {
    const identity = diagnosticIdentity(item);
    if (invalidDiagnosticIdentities.has(identity) || seenDiagnostics.has(identity)) return false;
    seenDiagnostics.add(identity); return true;
  }).sort(diagnosticOrder);
  const diagnostics = takePersistedBounded(uniqueDiagnosticsSource, Math.floor(LIMITS.latestScanWriteBytes * 0.25));
  const invalidPlans = takePersistedBounded(invalidPlansSource, Math.floor(LIMITS.latestScanWriteBytes * 0.25));
  const record = {
    schemaVersion: LATEST_SCAN_SCHEMA_VERSION,
    attemptId: crypto.randomUUID(),
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    trigger,
    outcome,
    snapshotId: snapshot?.snapshotId || null,
    diagnostics,
    invalidPlans,
    omittedDiagnostics: uniqueDiagnosticsSource.length - diagnostics.length,
    omittedInvalidPlans: invalidSource.length - invalidPlans.length,
  };
  if (Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`) >= LIMITS.latestScanWriteBytes) throw new Error("Fixed latest-scan metadata exceeds the serialized limit");
  return record;
}

function saveLatestScan(record) {
  const canonical = canonicalLatestScan(record);
  if (!canonical) throw new Error("Latest-scan record failed schema validation");
  atomicWriteJson(LATEST_SCAN_PATH, canonical, LIMITS.latestScanWriteBytes);
}

function projectSnapshot(core) {
  const limit = LIMITS.indexWriteBytes; const collectionBudget = Math.max(1024, Math.floor(limit / 8));
  const repositories = takeByteBounded(core.repositories, collectionBudget);
  const invalidPlans = takeByteBounded(core.invalidPlans, collectionBudget);
  const diagnostics = takeByteBounded(core.diagnostics, collectionBudget);
  const plansDirectories = takeByteBounded(core.plansDirectories, Math.max(1024, Math.floor(limit / 16)));
  const truncatedFixed = repositories.length !== core.repositories.length || invalidPlans.length !== core.invalidPlans.length || diagnostics.length !== core.diagnostics.length || plansDirectories.length !== core.plansDirectories.length;
  if (truncatedFixed) diagnostics.push(diagnostic("INDEX_SERIALIZED_LIMIT", "warning", "Index projection truncated at serialized size limit"));
  const fixed = { ...core, incomplete: core.incomplete || truncatedFixed, repositories, invalidPlans, diagnostics, plansDirectories, plans: [], openPlans: [], closedPlans: [], summary: { ...core.summary, projects: repositories.length, open: 0, closed: 0, invalid: invalidPlans.length } };
  let remaining = limit - Buffer.byteLength(JSON.stringify(fixed)) - Math.min(128 * 1024, Math.floor(limit / 20));
  const repositoryIds = new Set(repositories.map((repository) => repository.id));
  const eligiblePlans = core.plans.filter((plan) => repositoryIds.has(plan.projectId));
  const plans = [];
  for (const plan of eligiblePlans) {
    const bytes = Buffer.byteLength(JSON.stringify(plan)) * 2 + 8;
    if (bytes > remaining) break;
    plans.push(plan); remaining -= bytes;
  }
  const plansTruncated = plans.length !== core.plans.length;
  if (plansTruncated && !truncatedFixed) fixed.diagnostics.push(diagnostic("INDEX_SERIALIZED_LIMIT", "warning", "Index projection truncated at serialized size limit"));
  const openPlans = plans.filter((plan) => plan.state === "open").sort(comparePlans);
  const closedPlans = plans.filter((plan) => plan.state === "closed").sort((a, b) => b.closedAt.localeCompare(a.closedAt) || a.projectName.localeCompare(b.projectName) || a.relativeFile.localeCompare(b.relativeFile));
  const snapshotCore = { ...fixed, incomplete: fixed.incomplete || plansTruncated, plans, openPlans, closedPlans, summary: { ...fixed.summary, open: openPlans.length, closed: closedPlans.length } };
  const snapshotId = crypto.randomUUID();
  const snapshot = { ...snapshotCore, snapshotId };
  if (Buffer.byteLength(JSON.stringify(snapshot)) >= limit) throw new Error("Fixed index metadata exceeds the serialized index limit");
  return snapshot;
}

function refreshIndexUnlocked({ registry: suppliedRegistry, scanRedactions = [], scanDetails = {} } = {}) {
  ensureStorage();
  const registry = suppliedRegistry || loadRegistry({ migrate: false });
  const taskchefDetails = { redactions: [] };
  const taskchef = importTaskChef(registry, taskchefDetails);
  scanRedactions.push(...taskchefDetails.redactions);
  const discovery = discoverAll(registry.projects, registry.ignore);
  const previous = loadPreviousIndex();
  const previousByPath = new Map((previous?.plans || []).map((plan) => [plan.absolutePath, plan]));
  const plans = [];
  const invalidPlans = [];
  const absoluteIgnore = new Set(registry.ignore.filter((entry) => path.isAbsolute(entry)));
  const activeRegistry = { ...registry, projects: registry.projects.filter((project) => !absoluteIgnore.has(project.root)) };
  const diagnostics = [...registryDiagnostics(activeRegistry), ...taskchef.diagnostics, ...discovery.diagnostics];
  for (const root of discovery.roots) {
    for (const candidate of root.candidates.sort((a, b) => a.absolutePath.localeCompare(b.absolutePath))) {
      const currentFingerprint = fingerprint(candidate.stat);
      const cached = previousByPath.get(candidate.absolutePath);
      const context = { project: candidate.repository.displayName, projectId: candidate.repository.id, relativeFile: candidate.relativeFile };
      if (cached && cached.fingerprint === currentFingerprint) {
        const cachedDiagnostics = Array.isArray(cached.diagnostics) ? cached.diagnostics.map((item) => ({ ...item, ...context })) : [];
        plans.push({ ...cached, projectId: candidate.repository.id, registryId: candidate.repository.registryId, projectName: candidate.repository.displayName, relativeFile: candidate.relativeFile, absolutePath: candidate.absolutePath, updatedAt: candidate.stat.mtime.toISOString(), fingerprint: currentFingerprint, diagnostics: cachedDiagnostics });
        diagnostics.push(...cachedDiagnostics);
        continue;
      }
      try {
        const { buffer, stat } = safeReadFile(candidate.absolutePath, LIMITS.planBytes, { requireOwned: false, directoryGuards: candidate.directoryGuards });
        const parsed = parsePlan(buffer.toString("utf8"), context);
        if (!parsed.valid) {
          invalidPlans.push({ projectId: candidate.repository.id, projectName: candidate.repository.displayName, relativeFile: candidate.relativeFile, absolutePath: candidate.absolutePath, diagnostics: parsed.diagnostics });
          diagnostics.push(...parsed.diagnostics);
          continue;
        }
        const plan = { ...parsed.plan, projectId: candidate.repository.id, registryId: candidate.repository.registryId, projectName: candidate.repository.displayName, relativeFile: candidate.relativeFile, absolutePath: candidate.absolutePath, updatedAt: stat.mtime.toISOString(), fingerprint: fingerprint(stat), diagnostics: parsed.diagnostics };
        plans.push(plan); diagnostics.push(...parsed.diagnostics);
      } catch (error) {
        const item = diagnostic("PLAN_READ_ERROR", "error", `Plan read failed: ${error.message}`, context);
        diagnostics.push(item); invalidPlans.push({ projectId: candidate.repository.id, projectName: candidate.repository.displayName, relativeFile: candidate.relativeFile, absolutePath: candidate.absolutePath, diagnostics: [item] });
      }
    }
  }
  plans.sort((a, b) => a.absolutePath.localeCompare(b.absolutePath));
  invalidPlans.sort((a, b) => a.absolutePath.localeCompare(b.absolutePath));
  const countsByProject = new Map();
  function countsFor(projectId) { if (!countsByProject.has(projectId)) countsByProject.set(projectId, { open: 0, closed: 0, invalid: 0 }); return countsByProject.get(projectId); }
  for (const plan of plans) countsFor(plan.projectId)[plan.state] += 1;
  for (const plan of invalidPlans) countsFor(plan.projectId).invalid += 1;
  const repositories = discovery.roots.flatMap((root) => root.repositories.map((repository) => ({ id: repository.id, registryId: repository.registryId, name: repository.name, displayName: repository.displayName, root: repository.root, relativeRoot: repository.relativeRoot, kind: repository.kind, available: repository.available, counts: countsByProject.get(repository.id) || { open: 0, closed: 0, invalid: 0 } })));
  for (const root of discovery.roots.filter((item) => !item.available)) repositories.push({ id: root.project.id, registryId: root.project.id, name: root.project.name, displayName: root.project.name, root: root.project.root, relativeRoot: ".", kind: "explicit", available: false, counts: { open: 0, closed: 0, invalid: 0 } });
  repositories.sort((a, b) => a.root.localeCompare(b.root));
  const openPlans = plans.filter((plan) => plan.state === "open").sort(comparePlans);
  const closedPlans = plans.filter((plan) => plan.state === "closed").sort((a, b) => b.closedAt.localeCompare(a.closedAt) || a.projectName.localeCompare(b.projectName) || a.relativeFile.localeCompare(b.relativeFile));
  const refreshedAt = new Date().toISOString();
  const snapshot = projectSnapshot({ schemaVersion: INDEX_SCHEMA_VERSION, refreshedAt, incomplete: discovery.incomplete, summary: { projects: repositories.length, explicitRoots: registry.projects.length, open: openPlans.length, closed: closedPlans.length, invalid: invalidPlans.length }, repositories, plans, openPlans, closedPlans, invalidPlans, diagnostics, plansDirectories: discovery.plansDirectories });
  scanDetails.diagnostics = diagnostics; scanDetails.invalidPlans = invalidPlans; scanDetails.repositories = repositories;
  return snapshot;
}

function refreshIndex(options = {}) {
  return withStorageLock("data", () => {
    const startedAt = new Date().toISOString();
    const trigger = typeof options.trigger === "string" && options.trigger ? options.trigger.slice(0, 64) : "cli";
    let registry = null;
    const scanRedactions = [];
    const scanDetails = {};
    try {
      registry = options.registry || loadRegistry({ migrate: false });
      const snapshot = refreshIndexUnlocked({ ...options, registry, scanRedactions, scanDetails });
      const finishedAt = new Date().toISOString();
      const scanSnapshot = { snapshotId: snapshot.snapshotId, diagnostics: scanDetails.diagnostics, invalidPlans: scanDetails.invalidPlans, repositories: scanDetails.repositories };
      saveLatestScan(latestScanRecord({ startedAt, finishedAt, trigger, outcome: snapshot.incomplete ? "incomplete" : "success", snapshot: scanSnapshot, redactions: [...registry.projects.map((project) => project.root), ...scanRedactions] }));
      atomicWriteJson(INDEX_PATH, snapshot, LIMITS.indexWriteBytes);
      return snapshot;
    } catch (error) {
      const finishedAt = new Date().toISOString();
      saveLatestScan(latestScanRecord({ startedAt, finishedAt, trigger, outcome: "failed", error, redactions: [...(registry?.projects || []).map((project) => project.root), ...scanRedactions] }));
      throw error;
    }
  });
}

function loadIndex({ refreshIfMissing = true } = {}) {
  const existing = loadPreviousIndex();
  return existing || (refreshIfMissing ? refreshIndex() : null);
}

function pageCollection(snapshot, collection, { cursor, limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 1000));
  let offset = 0; let decodedOffset = 0;
  if (cursor) {
    let decoded;
    try { decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new Error("Invalid cursor"); }
    if (decoded.snapshotId !== snapshot.snapshotId || decoded.collection !== collection) throw Object.assign(new Error("Cursor belongs to a stale snapshot"), { code: "STALE_CURSOR" });
    decodedOffset = decoded.offset;
  }
  const source = snapshot[collection];
  if (!Array.isArray(source)) throw new Error(`Unknown collection: ${collection}`);
  if (cursor && (!Number.isInteger(decodedOffset) || !Number.isFinite(decodedOffset) || decodedOffset < 0 || decodedOffset > source.length)) throw Object.assign(new Error("Invalid cursor offset"), { code: "BAD_CURSOR" });
  offset = decodedOffset;
  let items = source.slice(offset, offset + safeLimit);
  while (items.length > 1 && Buffer.byteLength(JSON.stringify({ items })) > 2 * 1024 * 1024) items.pop();
  const nextOffset = offset + items.length;
  return { schemaVersion: 1, snapshotId: snapshot.snapshotId, collection, offset, limit: safeLimit, items, nextCursor: nextOffset < source.length ? Buffer.from(JSON.stringify({ snapshotId: snapshot.snapshotId, collection, offset: nextOffset })).toString("base64url") : null, total: source.length, incomplete: snapshot.incomplete };
}

module.exports = { INDEX_PATH, LATEST_SCAN_PATH, comparePlans, fingerprint, latestScanRecord, loadIndex, loadLatestScan, pageCollection, projectSnapshot, refreshIndex };
