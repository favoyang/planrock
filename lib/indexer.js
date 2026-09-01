const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { INDEX_SCHEMA_VERSION, LIMITS, PRIORITIES, STORAGE_DIR } = require("./constants");
const { discoverAll } = require("./discovery");
const { parsePlan } = require("./parser");
const { loadRegistry, registryDiagnostics } = require("./registry");
const { atomicWriteJson, diagnostic, ensureStorage, safeReadFile, withStorageLock } = require("./security");
const { importTaskChef } = require("./taskchef");

const INDEX_PATH = path.join(STORAGE_DIR, "index.json");

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
  const snapshotId = crypto.createHash("sha256").update(JSON.stringify(snapshotCore)).digest("hex").slice(0, 32);
  const snapshot = { ...snapshotCore, snapshotId };
  if (Buffer.byteLength(JSON.stringify(snapshot)) >= limit) throw new Error("Fixed index metadata exceeds the serialized index limit");
  return snapshot;
}

function refreshIndexUnlocked({ registry: suppliedRegistry } = {}) {
  ensureStorage();
  const registry = suppliedRegistry || loadRegistry();
  const taskchef = importTaskChef(registry);
  const discovery = discoverAll(registry.projects);
  const previous = loadPreviousIndex();
  const previousByPath = new Map((previous?.plans || []).map((plan) => [plan.absolutePath, plan]));
  const plans = [];
  const invalidPlans = [];
  const diagnostics = [...registryDiagnostics(registry), ...taskchef.diagnostics, ...discovery.diagnostics];
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
  atomicWriteJson(INDEX_PATH, snapshot, LIMITS.indexWriteBytes);
  return snapshot;
}

function refreshIndex(options = {}) { return withStorageLock("data", () => refreshIndexUnlocked(options)); }

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

module.exports = { INDEX_PATH, comparePlans, fingerprint, loadIndex, pageCollection, projectSnapshot, refreshIndex };
