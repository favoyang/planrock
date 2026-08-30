const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { LIMITS } = require("./constants");
const { diagnostic, safeReadFile } = require("./security");

const PRUNED = new Set([
  ".git", ".hg", ".svn", ".worktrees", "node_modules", "vendor", "dist",
  "build", "out", "output", "coverage", ".cache", "cache", "tmp", "temp",
  ".tmp", ".venv", "venv", "__pycache__", ".next", ".nuxt", ".turbo",
]);

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function safeDirectory(target, root) {
  const before = fs.lstatSync(target);
  if (before.isSymbolicLink() || !before.isDirectory()) return null;
  const canonical = fs.realpathSync.native(target);
  if (!within(root, canonical)) return null;
  const after = fs.lstatSync(target);
  if (after.dev !== before.dev || after.ino !== before.ino || after.isSymbolicLink()) return null;
  return { stat: before, canonical };
}

function directPlans(repository, rootContext) {
  const plansDir = path.join(repository.root, "plans");
  const candidates = [];
  let directory;
  try { directory = safeDirectory(plansDir, rootContext.root); } catch (error) {
    if (error.code !== "ENOENT") rootContext.diagnostics.push(diagnostic("PLANS_DIRECTORY_UNSAFE", "warning", `Plans directory skipped: ${error.message}`, { project: repository.name }));
    return { candidates, plansDir: null };
  }
  if (!directory) return { candidates, plansDir: null };
  let entries;
  try { entries = fs.readdirSync(plansDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch (error) {
    rootContext.diagnostics.push(diagnostic("PLANS_DIRECTORY_READ_ERROR", "error", `Plans directory unreadable: ${error.message}`, { project: repository.name }));
    return { candidates, plansDir };
  }
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (performance.now() >= rootContext.deadline) { rootContext.incomplete("SCAN_ROOT_TIME_LIMIT", "Root scan exceeded 15 seconds"); break; }
    const target = path.join(plansDir, entry.name);
    let stat;
    try { stat = fs.lstatSync(target); } catch (error) {
      rootContext.diagnostics.push(diagnostic("PLAN_STAT_ERROR", "warning", `Plan candidate stat failed: ${error.message}`, { project: repository.name, relativeFile: path.relative(repository.root, target) }));
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      rootContext.diagnostics.push(diagnostic("PLAN_ENTRY_SKIPPED", "warning", "Plan candidate is not a regular non-symlink file", { project: repository.name, relativeFile: path.relative(repository.root, target) }));
      continue;
    }
    rootContext.candidateCount += 1;
    if (rootContext.candidateCount > LIMITS.rootPlanCandidates) { rootContext.incomplete("SCAN_ROOT_PLAN_COUNT_LIMIT", "Root plan candidate limit exceeded"); break; }
    if (rootContext.aggregate.candidates >= LIMITS.aggregatePlanCandidates) { rootContext.aggregate.incomplete("SCAN_AGGREGATE_PLAN_COUNT_LIMIT", "Aggregate plan candidate limit exceeded"); break; }
    if (stat.size > LIMITS.planBytes) {
      rootContext.incomplete("PLAN_FILE_SIZE_LIMIT", "Oversized plan skipped", { project: repository.name, relativeFile: path.relative(repository.root, target) });
      continue;
    }
    if (rootContext.sourceBytes + stat.size > LIMITS.rootPlanBytes) { rootContext.incomplete("SCAN_ROOT_SOURCE_LIMIT", "Root plan source byte limit exceeded"); break; }
    if (rootContext.aggregate.bytes + stat.size > LIMITS.aggregatePlanBytes) { rootContext.aggregate.incomplete("SCAN_AGGREGATE_SOURCE_LIMIT", "Aggregate plan source byte limit exceeded"); break; }
    rootContext.sourceBytes += stat.size; rootContext.aggregate.bytes += stat.size; rootContext.aggregate.candidates += 1;
    const guardDirectories = [{ path: rootContext.root, stat: rootContext.rootStat }, { path: repository.root, stat: repository.directoryStat }, { path: plansDir, stat: directory.stat }];
    const directoryGuards = [...new Map(guardDirectories.filter((guard) => guard.stat).map((guard) => [guard.path, { path: guard.path, dev: guard.stat.dev, ino: guard.stat.ino }])).values()];
    candidates.push({ absolutePath: target, relativeFile: path.relative(repository.root, target).split(path.sep).join("/"), size: stat.size, stat, directoryGuards });
  }
  return { candidates, plansDir };
}

function discoverRoot(project, allExplicitRoots, aggregate) {
  const diagnostics = [];
  const repositories = [];
  const plansDirectories = [];
  let available = true;
  let incomplete = false;
  let canonicalRoot;
  let rootDirectory;
  try {
    rootDirectory = safeDirectory(project.root, project.root);
    if (!rootDirectory || rootDirectory.canonical !== project.root) throw new Error("registered root identity changed");
    canonicalRoot = rootDirectory.canonical;
  } catch (error) {
    available = false;
    incomplete = true;
    diagnostics.push(diagnostic("PROJECT_ROOT_UNAVAILABLE", "error", `Project root unavailable: ${error.message}`, { project: project.name }));
    return { project, available, incomplete, repositories, candidates: [], plansDirectories, diagnostics };
  }
  const context = {
    root: canonicalRoot,
    rootStat: rootDirectory.stat,
    deadline: Math.min(performance.now() + LIMITS.rootMilliseconds, aggregate.deadline),
    diagnostics,
    candidateCount: 0,
    sourceBytes: 0,
    aggregate,
    incomplete(code, message, extra = {}) { incomplete = true; diagnostics.push(diagnostic(code, "warning", message, { project: project.name, ...extra })); },
  };
  const explicitRepository = { id: project.id, registryId: project.id, name: project.name, displayName: project.name, root: canonicalRoot, relativeRoot: ".", kind: "explicit", available: true, directoryStat: rootDirectory.stat };
  repositories.push(explicitRepository);
  const explicitPlans = directPlans(explicitRepository, context);
  explicitRepository.candidates = explicitPlans.candidates;
  if (explicitPlans.plansDir) plansDirectories.push(explicitPlans.plansDir);
  const queue = project.discovery === false ? [] : [{ dir: canonicalRoot, depth: 0 }];
  let visited = 0;
  while (queue.length && performance.now() < context.deadline && performance.now() < aggregate.deadline) {
    const current = queue.shift();
    visited += 1;
    if (visited > LIMITS.maxDirectories) { context.incomplete("SCAN_ROOT_DIRECTORY_LIMIT", "Root directory visit limit exceeded"); break; }
    let entries;
    try { entries = fs.readdirSync(current.dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch (error) {
      diagnostics.push(diagnostic("DISCOVERY_DIRECTORY_READ_ERROR", "warning", `Directory discovery skipped: ${error.message}`, { project: project.name, relativeFile: path.relative(canonicalRoot, current.dir) }));
      continue;
    }
    for (const entry of entries) {
      if (performance.now() >= context.deadline) { context.incomplete("SCAN_ROOT_TIME_LIMIT", "Root scan exceeded 15 seconds"); break; }
      if (PRUNED.has(entry.name) || entry.name === "plans") continue;
      const target = path.join(current.dir, entry.name);
      let directory;
      try { directory = safeDirectory(target, canonicalRoot); } catch { continue; }
      if (!directory) continue;
      if (allExplicitRoots.has(directory.canonical) && directory.canonical !== canonicalRoot) continue;
      let gitMarker = false;
      let gitDirectory = false;
      try {
        const gitStat = fs.lstatSync(path.join(target, ".git"));
        gitMarker = true;
        gitDirectory = gitStat.isDirectory() && !gitStat.isSymbolicLink();
      } catch {}
      if (gitDirectory) {
        const relativeRoot = path.relative(canonicalRoot, directory.canonical).split(path.sep).join("/");
        const repository = { id: `discovered:${directory.canonical}`, registryId: project.id, name: path.basename(directory.canonical), displayName: path.basename(directory.canonical), root: directory.canonical, relativeRoot, kind: "discovered", available: true, directoryStat: directory.stat };
        const found = directPlans(repository, context);
        repository.candidates = found.candidates;
        if (found.plansDir) plansDirectories.push(found.plansDir);
        repositories.push(repository);
        continue;
      }
      if (gitMarker) continue;
      if (current.depth < LIMITS.maxDepth) queue.push({ dir: directory.canonical, depth: current.depth + 1 });
      else diagnostics.push(diagnostic("SCAN_ROOT_DEPTH_LIMIT", "info", "Discovery depth limit reached", { project: project.name, relativeFile: path.relative(canonicalRoot, directory.canonical) }));
    }
  }
  if (queue.length && performance.now() >= context.deadline && !diagnostics.some((item) => item.code === "SCAN_ROOT_TIME_LIMIT")) context.incomplete("SCAN_ROOT_TIME_LIMIT", "Root scan exceeded 15 seconds");
  if (performance.now() >= aggregate.deadline) aggregate.incomplete("SCAN_AGGREGATE_TIME_LIMIT", "Aggregate refresh exceeded two minutes");
  const candidates = repositories.flatMap((repository) => repository.candidates.map((candidate) => ({ ...candidate, repository })));
  return { project, available, incomplete, repositories, candidates, plansDirectories, diagnostics };
}

function discoverAll(projects) {
  const diagnostics = [];
  let incomplete = false;
  const aggregate = {
    deadline: performance.now() + LIMITS.aggregateMilliseconds,
    bytes: 0,
    candidates: 0,
    incomplete(code, message) { incomplete = true; diagnostics.push(diagnostic(code, "warning", message)); },
  };
  const roots = new Set(projects.map((project) => project.root));
  const rootsResult = [];
  for (const project of [...projects].sort((a, b) => a.root.localeCompare(b.root))) {
    if (performance.now() >= aggregate.deadline) { aggregate.incomplete("SCAN_AGGREGATE_TIME_LIMIT", "Aggregate refresh exceeded two minutes"); break; }
    rootsResult.push(discoverRoot(project, roots, aggregate));
  }
  diagnostics.push(...rootsResult.flatMap((result) => result.diagnostics));
  const discoveredNames = new Map();
  for (const repository of rootsResult.flatMap((result) => result.repositories)) {
    const key = repository.name.toLocaleLowerCase("en-US");
    discoveredNames.set(key, (discoveredNames.get(key) || 0) + 1);
  }
  for (const result of rootsResult) {
    for (const repository of result.repositories) {
      if (repository.kind === "discovered" && discoveredNames.get(repository.name.toLocaleLowerCase("en-US")) > 1) repository.displayName = `${result.project.name}/${repository.relativeRoot}`;
    }
  }
  return { roots: rootsResult, diagnostics, incomplete: incomplete || rootsResult.some((result) => result.incomplete), aggregate: { bytes: aggregate.bytes, candidates: aggregate.candidates }, plansDirectories: [...new Set(rootsResult.flatMap((result) => result.plansDirectories))].sort() };
}

module.exports = { PRUNED, directPlans, discoverAll, safeDirectory, within };
