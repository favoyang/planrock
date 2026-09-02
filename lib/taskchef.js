const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { LIMITS } = require("./constants");
const { canonicalRoot, importedName, saveRegistry } = require("./registry");
const { diagnostic, safeReadFile } = require("./security");

const TASKCHEF_PATH = path.join(os.homedir(), ".agents", "taskchef", "taskchef.json");

function exactKeys(object, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(object, key)) && Object.keys(object).every((key) => allowed.has(key));
}

function parseTaskChef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, ["schemaVersion", "projects"], ["dashboard"]) || !Number.isInteger(value.schemaVersion) || value.schemaVersion !== 2 || !Array.isArray(value.projects)) {
    throw new Error("TaskChef discovery requires exact schemaVersion 2 structure");
  }
  if (value.dashboard !== undefined && (!value.dashboard || typeof value.dashboard !== "object" || Array.isArray(value.dashboard) || !exactKeys(value.dashboard, ["autostart"]) || typeof value.dashboard.autostart !== "boolean")) {
    throw new Error("TaskChef dashboard structure is invalid");
  }
  const records = [];
  const diagnostics = [];
  const seenNames = new Set(); const seenPaths = new Set();
  for (const [index, project] of value.projects.slice(0, 256).entries()) {
    const context = { relativeFile: `projects[${index}]` };
    if (!project || typeof project !== "object" || Array.isArray(project) || !exactKeys(project, ["name", "path", "isGitRepository", "githubRepos"], ["description"]) || typeof project.name !== "string" || !project.name.trim() || typeof project.path !== "string" || !path.isAbsolute(project.path) || path.normalize(project.path) !== project.path || typeof project.isGitRepository !== "boolean" || !Array.isArray(project.githubRepos) || !project.githubRepos.every((url) => typeof url === "string") || (project.description !== undefined && typeof project.description !== "string")) {
      diagnostics.push(diagnostic("TASKCHEF_PROJECT_INVALID", "warning", "Invalid TaskChef project record skipped", context));
      continue;
    }
    if (Buffer.byteLength(project.name) > 256 || Buffer.byteLength(project.path) > LIMITS.pathBytes || project.githubRepos.some((url) => Buffer.byteLength(url) > 2048) || (project.description && Buffer.byteLength(project.description) > LIMITS.diagnosticBytes)) {
      diagnostics.push(diagnostic("TASKCHEF_PROJECT_LIMIT", "warning", "TaskChef project record exceeds field limits", context));
      continue;
    }
    const nameKey = project.name.toLocaleLowerCase("en-US");
    if (seenNames.has(nameKey) || seenPaths.has(project.path)) throw new Error("TaskChef projects contain duplicate names or paths");
    seenNames.add(nameKey); seenPaths.add(project.path);
    records.push({ name: project.name, path: project.path });
  }
  if (value.projects.length > 256) diagnostics.push(diagnostic("TASKCHEF_PROJECT_CAP", "warning", "Only the first 256 TaskChef project records were inspected"));
  return { records, diagnostics };
}

function importTaskChef(registry, details = {}) {
  const diagnostics = [];
  const redactions = [TASKCHEF_PATH];
  details.redactions = redactions;
  if (!fs.existsSync(TASKCHEF_PATH)) return { imported: [], diagnostics };
  let parsed;
  try {
    const before = fs.lstatSync(TASKCHEF_PATH);
    if (before.isSymbolicLink() || !before.isFile()) throw new Error("TaskChef discovery file must be a regular non-symlink file");
    const { buffer } = safeReadFile(TASKCHEF_PATH, LIMITS.taskchefBytes, { requireOwned: false });
    parsed = parseTaskChef(JSON.parse(buffer.toString("utf8")));
  } catch (error) {
    diagnostics.push(diagnostic("TASKCHEF_IMPORT_INVALID", "warning", "TaskChef discovery file is invalid"));
    return { imported: [], diagnostics };
  }
  diagnostics.push(...parsed.diagnostics);
  const prepared = [];
  const preparedRoots = new Set(registry.projects.map((project) => project.root));
  for (const record of parsed.records) {
    redactions.push(record.path);
    try {
      const { root } = canonicalRoot(record.path);
      if (preparedRoots.has(root) || registry.ignore.includes(root)) continue;
      preparedRoots.add(root);
      prepared.push({ name: record.name, root });
    } catch (error) {
      diagnostics.push(diagnostic("TASKCHEF_ROOT_INVALID", "warning", `TaskChef root skipped: ${error.message}`, { project: record.name }));
    }
  }
  prepared.sort((a, b) => a.root.localeCompare(b.root));
  const imported = [];
  for (const record of prepared) {
    if (registry.projects.length >= LIMITS.maxProjects) {
      diagnostics.push(diagnostic("REGISTRY_PROJECT_CAP", "warning", "TaskChef import stopped at the registry root cap"));
      break;
    }
    const project = { id: require("node:crypto").randomUUID(), name: importedName(registry, record.name, record.root), root: record.root, source: "taskchef", addedAt: new Date().toISOString(), discovery: true };
    registry.projects.push(project); imported.push(project);
  }
  if (imported.length) {
    registry.projects.sort((a, b) => a.root.localeCompare(b.root));
    saveRegistry(registry);
  }
  return { imported, diagnostics };
}

module.exports = { TASKCHEF_PATH, importTaskChef, parseTaskChef };
