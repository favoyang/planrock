const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { LIMITS, REGISTRY_SCHEMA_VERSION, STORAGE_DIR } = require("./constants");
const { IS_POSIX, atomicWriteJson, diagnostic, ensureStorage, safeReadFile, truncateUtf8, withStorageLock } = require("./security");

const REGISTRY_PATH = path.join(STORAGE_DIR, "planrock.json");

function emptyRegistry() {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, projects: [], ignore: [] };
}

function normalizeIgnoreEntry(entry, index) {
  if (typeof entry !== "string" || !entry || entry.includes("\0") || Buffer.byteLength(entry) > LIMITS.pathBytes) throw new Error(`Invalid registry ignore entry at index ${index}`);
  if (entry.startsWith("!")) throw new Error(`Ignore negation is unsupported at index ${index}`);
  const absolute = path.isAbsolute(entry);
  if (absolute) {
    if (path.normalize(entry) !== entry) throw new Error(`Absolute registry ignore entry is not canonical at index ${index}`);
    let probe = entry; const missing = [];
    while (true) {
      try {
        const stat = fs.statSync(probe); if (!stat.isDirectory()) throw new Error(`Absolute registry ignore entry cannot resolve through a non-directory at index ${index}`);
        const resolved = path.join(fs.realpathSync.native(probe), ...missing); if (resolved !== entry) throw new Error(`Absolute registry ignore entry is not canonical at index ${index}`);
        break;
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw new Error(`Absolute registry ignore entry cannot be resolved at index ${index}`);
        const parent = path.dirname(probe); if (parent === probe) throw new Error(`Absolute registry ignore entry cannot be resolved at index ${index}`);
        missing.unshift(path.basename(probe)); probe = parent;
      }
    }
    return entry;
  }
  const normalized = entry.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.endsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`Invalid registry ignore pattern at index ${index}`);
  if (normalized.split("/").length > LIMITS.maxIgnorePatternSegments || [...normalized].filter((character) => character === "*" || character === "?").length > LIMITS.maxIgnorePatternWildcards) throw new Error(`Registry ignore pattern complexity exceeds limits at index ${index}`);
  return normalized;
}

function validateRegistry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![1, REGISTRY_SCHEMA_VERSION].includes(value.schemaVersion) || !Array.isArray(value.projects)) {
    throw new Error(`Unsupported or invalid Planrock registry schema; expected 1 or ${REGISTRY_SCHEMA_VERSION}`);
  }
  if (value.projects.length > LIMITS.maxProjects) throw new Error(`Planrock registry exceeds ${LIMITS.maxProjects} roots`);
  const ids = new Set(); const names = new Set(); const roots = new Set();
  const projects = value.projects.map((project, index) => {
    if (!project || typeof project !== "object" || typeof project.id !== "string" || !project.id || typeof project.name !== "string" || !project.name || Buffer.byteLength(project.name) > 256 || typeof project.root !== "string" || !path.isAbsolute(project.root)) {
      throw new Error(`Invalid registry project at index ${index}`);
    }
    const nameKey = project.name.toLocaleLowerCase("en-US");
    if (ids.has(project.id) || names.has(nameKey) || roots.has(project.root)) throw new Error(`Duplicate registry project identity at index ${index}`);
    ids.add(project.id); names.add(nameKey); roots.add(project.root);
    return { id: project.id, name: project.name, root: project.root, source: project.source === "taskchef" ? "taskchef" : "explicit", addedAt: typeof project.addedAt === "string" ? project.addedAt : "", discovery: project.discovery !== false };
  });
  if (value.schemaVersion === 1 && value.ignore !== undefined) throw new Error("Registry schema 1 cannot contain ignore");
  if (value.schemaVersion === REGISTRY_SCHEMA_VERSION && value.suppressions !== undefined) throw new Error("Registry schema 2 cannot contain suppressions");
  if (value.schemaVersion === 1 && value.suppressions !== undefined && (!value.suppressions || typeof value.suppressions !== "object" || Array.isArray(value.suppressions) || !Array.isArray(value.suppressions.taskchef) || Object.keys(value.suppressions).some((key) => key !== "taskchef"))) throw new Error("Registry schema 1 suppressions must contain only a TaskChef array");
  const legacy = value.schemaVersion === 1 && value.suppressions ? value.suppressions.taskchef : [];
  const sourceIgnore = value.schemaVersion === REGISTRY_SCHEMA_VERSION ? value.ignore : legacy;
  if (!Array.isArray(sourceIgnore)) throw new Error("Registry ignore must be an array");
  if (sourceIgnore.length > LIMITS.maxIgnoreEntries) throw new Error(`Registry ignore exceeds ${LIMITS.maxIgnoreEntries} entries`);
  if (sourceIgnore.reduce((bytes, entry) => bytes + Buffer.byteLength(String(entry)), 0) > LIMITS.maxIgnoreBytes) throw new Error(`Registry ignore exceeds ${LIMITS.maxIgnoreBytes} UTF-8 bytes`);
  const ignore = sourceIgnore.map((entry, index) => {
    if (value.schemaVersion === 1 && (typeof entry !== "string" || !path.isAbsolute(entry))) throw new Error(`Legacy TaskChef suppression must be a canonical absolute path at index ${index}`);
    return normalizeIgnoreEntry(entry, index);
  });
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, projects, ignore: [...new Set(ignore)].sort() };
}

function loadRegistry({ create = true, migrate = true } = {}) {
  ensureStorage();
  try {
    const { buffer } = safeReadFile(REGISTRY_PATH, LIMITS.registryReadBytes);
    const source = JSON.parse(buffer.toString("utf8"));
    const registry = validateRegistry(source);
    if (create && source.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
      if (!migrate) { saveRegistry(registry); return registry; }
      return withStorageLock("data", () => {
        const current = loadRegistry({ create: false, migrate: false });
        saveRegistry(current);
        return current;
      });
    }
    return registry;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const registry = emptyRegistry();
    if (create && !migrate) { saveRegistry(registry); return registry; }
    if (create) return withStorageLock("data", () => {
      if (fs.existsSync(REGISTRY_PATH)) return loadRegistry({ create: false, migrate: false });
      saveRegistry(registry); return registry;
    });
    return registry;
  }
}

function saveRegistry(registry) {
  atomicWriteJson(REGISTRY_PATH, validateRegistry(registry), LIMITS.registryWriteBytes);
}

function canonicalRoot(input) {
  const resolvedInput = path.resolve(input);
  const stat = fs.statSync(resolvedInput);
  if (!stat.isDirectory()) throw new Error(`Project root is not a directory: ${input}`);
  const root = fs.realpathSync.native(resolvedInput);
  if (Buffer.byteLength(root) > LIMITS.pathBytes) throw new Error("Project root path is too long");
  return { root, canonicalized: root !== resolvedInput };
}

function normalizeName(name) {
  if (typeof name !== "string" || !name.trim()) throw new Error("Project name must be non-empty");
  const value = name.trim();
  if (Buffer.byteLength(value) > 256) throw new Error("Project name exceeds 256 UTF-8 bytes");
  return value;
}

function addProject(registry, { name, root: inputRoot, source = "explicit", discovery = true, id = crypto.randomUUID() }) {
  if (registry.projects.length >= LIMITS.maxProjects) throw new Error(`Registry is limited to ${LIMITS.maxProjects} projects`);
  const normalizedName = normalizeName(name);
  const { root, canonicalized } = canonicalRoot(inputRoot);
  const duplicateRoot = registry.projects.find((project) => project.root === root);
  if (duplicateRoot) throw new Error(`Project root is already tracked as ${duplicateRoot.name}`);
  const duplicateName = registry.projects.find((project) => project.name.toLocaleLowerCase("en-US") === normalizedName.toLocaleLowerCase("en-US"));
  if (duplicateName) throw new Error(`Project name is already used by ${duplicateName.root}`);
  const project = { id, name: normalizedName, root, source, addedAt: new Date().toISOString(), discovery };
  registry.projects.push(project);
  registry.projects.sort((a, b) => a.root.localeCompare(b.root));
  if (source === "explicit") registry.ignore = registry.ignore.filter((entry) => entry !== root);
  saveRegistry(registry);
  return { project, canonicalized };
}

function removeProject(registry, selector) {
  const key = String(selector).toLocaleLowerCase("en-US");
  const index = registry.projects.findIndex((project) => project.id === selector || project.name.toLocaleLowerCase("en-US") === key);
  if (index === -1) throw new Error(`Unknown project: ${selector}`);
  const [project] = registry.projects.splice(index, 1);
  if (project.source === "taskchef") registry.ignore = [...new Set([...registry.ignore, project.root])].sort();
  saveRegistry(registry);
  return project;
}

function relinkProject(registry, selector, inputRoot) {
  const key = String(selector).toLocaleLowerCase("en-US");
  const project = registry.projects.find((item) => item.id === selector || item.name.toLocaleLowerCase("en-US") === key);
  if (!project) throw new Error(`Unknown project: ${selector}`);
  const { root, canonicalized } = canonicalRoot(inputRoot);
  const duplicate = registry.projects.find((item) => item.id !== project.id && item.root === root);
  if (duplicate) throw new Error(`Project root is already tracked as ${duplicate.name}`);
  project.root = root;
  project.source = "explicit";
  registry.projects.sort((a, b) => a.root.localeCompare(b.root));
  registry.ignore = registry.ignore.filter((entry) => entry !== root);
  saveRegistry(registry);
  return { project, canonicalized };
}

function importedName(registry, sourceName, canonicalPath) {
  const occupied = new Set(registry.projects.map((project) => project.name.toLocaleLowerCase("en-US")));
  const normalized = truncateUtf8(sourceName.trim(), 256).value;
  if (!occupied.has(normalized.toLocaleLowerCase("en-US"))) return normalized;
  const digest = crypto.createHash("sha256").update(canonicalPath).digest("hex");
  for (let length = 8; length <= digest.length; length += 4) {
    const candidate = truncateUtf8(`${normalized}-${digest.slice(0, Math.min(length, digest.length))}`, 256).value;
    if (!occupied.has(candidate.toLocaleLowerCase("en-US"))) return candidate;
  }
  for (let suffix = 1; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const candidate = truncateUtf8(`${normalized}-${digest}-${suffix}`, 256).value;
    if (!occupied.has(candidate.toLocaleLowerCase("en-US"))) return candidate;
  }
  throw new Error("Unable to derive a unique imported project name");
}

function registryDiagnostics(registry) {
  const diagnostics = [];
  if (!IS_POSIX) diagnostics.push(diagnostic("PLATFORM_PERMISSION_LIMITATION", "warning", "Owner-only POSIX modes are unavailable on this platform; available private-file protections are best effort"));
  for (const project of registry.projects) {
    try {
      const stat = fs.statSync(project.root);
      if (!stat.isDirectory()) throw new Error("not a directory");
    } catch (error) {
      diagnostics.push(diagnostic("PROJECT_ROOT_UNAVAILABLE", "error", `Project root unavailable: ${error.message}`, { project: project.name }));
    }
  }
  return diagnostics;
}

module.exports = { REGISTRY_PATH, addProject, canonicalRoot, emptyRegistry, importedName, loadRegistry, registryDiagnostics, relinkProject, removeProject, saveRegistry, validateRegistry };
