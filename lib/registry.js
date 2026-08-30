const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { LIMITS, REGISTRY_SCHEMA_VERSION, STORAGE_DIR } = require("./constants");
const { IS_POSIX, atomicWriteJson, diagnostic, ensureStorage, safeReadFile, truncateUtf8 } = require("./security");

const REGISTRY_PATH = path.join(STORAGE_DIR, "planrock.json");

function emptyRegistry() {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, projects: [], suppressions: { taskchef: [] } };
}

function validateRegistry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== REGISTRY_SCHEMA_VERSION || !Array.isArray(value.projects)) {
    throw new Error(`Unsupported or invalid Planrock registry schema; expected ${REGISTRY_SCHEMA_VERSION}`);
  }
  if (value.projects.length > LIMITS.maxProjects) throw new Error(`Planrock registry exceeds ${LIMITS.maxProjects} roots`);
  const ids = new Set(); const names = new Set(); const roots = new Set();
  const projects = value.projects.map((project, index) => {
    if (!project || typeof project !== "object" || typeof project.id !== "string" || !project.id || typeof project.name !== "string" || !project.name || typeof project.root !== "string" || !path.isAbsolute(project.root)) {
      throw new Error(`Invalid registry project at index ${index}`);
    }
    const nameKey = project.name.toLocaleLowerCase("en-US");
    if (ids.has(project.id) || names.has(nameKey) || roots.has(project.root)) throw new Error(`Duplicate registry project identity at index ${index}`);
    ids.add(project.id); names.add(nameKey); roots.add(project.root);
    return { id: project.id, name: project.name, root: project.root, source: project.source === "taskchef" ? "taskchef" : "explicit", addedAt: typeof project.addedAt === "string" ? project.addedAt : "", discovery: project.discovery !== false };
  });
  const suppressions = value.suppressions && Array.isArray(value.suppressions.taskchef) ? value.suppressions.taskchef.filter((entry) => typeof entry === "string") : [];
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, projects, suppressions: { taskchef: [...new Set(suppressions)].sort() } };
}

function loadRegistry({ create = true } = {}) {
  ensureStorage();
  try {
    const { buffer } = safeReadFile(REGISTRY_PATH, LIMITS.registryReadBytes);
    return validateRegistry(JSON.parse(buffer.toString("utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const registry = emptyRegistry();
    if (create) saveRegistry(registry);
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
  if (source === "explicit") registry.suppressions.taskchef = registry.suppressions.taskchef.filter((suppressed) => suppressed !== root);
  saveRegistry(registry);
  return { project, canonicalized };
}

function removeProject(registry, selector) {
  const key = String(selector).toLocaleLowerCase("en-US");
  const index = registry.projects.findIndex((project) => project.id === selector || project.name.toLocaleLowerCase("en-US") === key);
  if (index === -1) throw new Error(`Unknown project: ${selector}`);
  const [project] = registry.projects.splice(index, 1);
  if (project.source === "taskchef") registry.suppressions.taskchef = [...new Set([...registry.suppressions.taskchef, project.root])].sort();
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
  registry.suppressions.taskchef = registry.suppressions.taskchef.filter((suppressed) => suppressed !== root);
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
