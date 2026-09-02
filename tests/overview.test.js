const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const cli = path.join(root, "scripts", "planrock");
const { LIMITS } = require("../lib/constants");
const { patternExpression } = require("../lib/discovery");
const { latestScanRecord } = require("../lib/indexer");
const { validateRegistry } = require("../lib/registry");

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "planrock-overview-"));
  const home = path.join(base, "home"); fs.mkdirSync(home);
  return { base, home };
}
function project(base, name) { const target = path.join(base, name); fs.mkdirSync(path.join(target, "plans"), { recursive: true }); return target; }
function plan(rootPath, name, frontmatter, body = "- [ ] Next") { fs.writeFileSync(path.join(rootPath, "plans", name), `---\n${frontmatter}\n---\n\n${body}\n`); }
function run(home, args, expected = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(result.status, expected, result.stderr || result.stdout); return result;
}
function json(home, args) { return JSON.parse(run(home, [...args, "--json"]).stdout); }
function runAsync(home, args) { return new Promise((resolve) => { const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] }); const stdout = []; const stderr = []; child.stdout.on("data", (chunk) => stdout.push(chunk)); child.stderr.on("data", (chunk) => stderr.push(chunk)); child.on("close", (status) => resolve({ status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") })); }); }

test("secure storage initializes with owner-only POSIX modes", () => {
  const { home } = fixture(); json(home, ["project", "list"]);
  const storage = path.join(home, ".agents", "planrock");
  assert.equal(fs.statSync(storage).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(storage, "planrock.json")).mode & 0o777, 0o600);
  const registry = JSON.parse(fs.readFileSync(path.join(storage, "planrock.json"), "utf8")); assert.deepEqual(registry, { schemaVersion: 2, projects: [], ignore: [] });
});

test("registry schema 1 migrates TaskChef suppressions into the global ignore array", () => {
  const { base, home } = fixture(); const repo = project(base, "repo"); const storage = path.join(home, ".agents", "planrock"); fs.mkdirSync(storage, { recursive: true });
  const canonicalRepo = fs.realpathSync.native(repo); const legacy = { schemaVersion: 1, projects: [{ id: "legacy", name: "Legacy", root: canonicalRepo, source: "explicit", addedAt: "2026-01-01T00:00:00.000Z", discovery: true }], suppressions: { taskchef: [canonicalRepo] } };
  fs.writeFileSync(path.join(storage, "planrock.json"), JSON.stringify(legacy), { mode: 0o600 });
  const listed = json(home, ["project", "list"]); assert.equal(listed.schemaVersion, 2); assert.deepEqual(listed.ignore, [canonicalRepo]);
  const migrated = JSON.parse(fs.readFileSync(path.join(storage, "planrock.json"), "utf8")); assert.equal(migrated.schemaVersion, 2); assert.equal(Object.hasOwn(migrated, "suppressions"), false); assert.deepEqual(migrated.ignore, [canonicalRepo]);
});

test("registry ignore cardinality and aggregate bytes are bounded", () => {
  assert.throws(() => validateRegistry({ schemaVersion: 2, projects: [], ignore: Array.from({ length: LIMITS.maxIgnoreEntries + 1 }, (_, index) => `entry-${index}`) }), /exceeds 512 entries/);
  assert.throws(() => validateRegistry({ schemaVersion: 2, projects: [], ignore: ["x".repeat(LIMITS.maxIgnoreBytes + 1)] }), /Invalid registry ignore entry|UTF-8 bytes/);
  assert.throws(() => validateRegistry({ schemaVersion: 2, projects: [], ignore: Array.from({ length: 9 }, (_, index) => `${index}${"x".repeat(32_000)}`) }), /UTF-8 bytes/);
  assert.throws(() => validateRegistry({ schemaVersion: 2, projects: [], ignore: [`${"**/".repeat(LIMITS.maxIgnorePatternSegments)}x`] }), /complexity exceeds limits/);
  assert.throws(() => validateRegistry({ schemaVersion: 2, projects: [], ignore: ["*".repeat(LIMITS.maxIgnorePatternWildcards + 1)] }), /complexity exceeds limits/);
  assert.equal(validateRegistry({ schemaVersion: 2, projects: [], ignore: Array.from({ length: LIMITS.maxIgnoreEntries }, (_, index) => `entry-${index}`) }).ignore.length, LIMITS.maxIgnoreEntries);
});

test("registry project names match persisted health field limits", () => {
  assert.throws(() => validateRegistry({ schemaVersion: 2, projects: [{ id: "project", name: "x".repeat(257), root: "/tmp/project", source: "explicit", addedAt: "", discovery: true }], ignore: [] }), /Invalid registry project/);
});

test("legacy suppressions remain canonical absolute TaskChef tombstones", () => {
  assert.throws(() => validateRegistry({ schemaVersion: 1, projects: [], suppressions: { taskchef: ["packages/**"] } }), /canonical absolute path/);
  assert.throws(() => validateRegistry({ schemaVersion: 1, projects: [], suppressions: { taskchef: "not-an-array" } }), /must contain only a TaskChef array/);
});

test("existing absolute symlink aliases are rejected as noncanonical ignores", () => {
  const { base } = fixture(); const real = project(base, "real"); const alias = path.join(base, "alias"); fs.symlinkSync(real, alias, "dir");
  assert.throws(() => validateRegistry({ schemaVersion: 2, projects: [], ignore: [alias] }), /not canonical|cannot be resolved/);
  assert.throws(() => validateRegistry({ schemaVersion: 2, projects: [], ignore: [path.join(alias, "future")] }), /cannot be resolved/);
});

test("failed absolute-ignore validation does not publish the rejected path", () => {
  const { base, home } = fixture(); json(home, ["project", "list"]); const blockingFile = path.join(base, "blocking"); fs.writeFileSync(blockingFile, "file"); const rejected = path.join(blockingFile, "secret-child"); const registryPath = path.join(home, ".agents", "planrock", "planrock.json"); fs.writeFileSync(registryPath, JSON.stringify({ schemaVersion: 2, projects: [], ignore: [rejected] }), { mode: 0o600 });
  assert.match(run(home, ["refresh"], 1).stderr, /cannot be resolved/); const scan = JSON.parse(fs.readFileSync(path.join(home, ".agents", "planrock", "latest-scan.json"), "utf8")); assert.equal(JSON.stringify(scan).includes(rejected), false);
});

test("adjacent wildcard runs compile to one bounded segment matcher", () => {
  const expression = patternExpression("**********z"); assert.equal(expression.source, "**********z"); assert.equal(expression.test("x".repeat(255)), false);
  const adversarial = patternExpression(`${"*a".repeat(32)}b`); const started = Date.now(); assert.equal(adversarial.test("a".repeat(255)), false); assert.ok(Date.now() - started < 100, "wildcard matching must remain bounded");
});

test("explicit roots canonicalize symlink boundaries and reject duplicates", () => {
  const { base, home } = fixture(); const real = project(base, "real"); const alias = path.join(base, "alias"); fs.symlinkSync(real, alias, "dir");
  const added = json(home, ["project", "add", alias, "--name", "Example"]); assert.equal(added.canonicalized, true); assert.equal(added.project.root, fs.realpathSync.native(real));
  const duplicateName = run(home, ["project", "add", project(base, "other"), "--name", "example"], 1); assert.match(duplicateName.stderr, /name is already used/i);
  const duplicateRoot = run(home, ["project", "add", real, "--name", "Other"], 1); assert.match(duplicateRoot.stderr, /already tracked/i);
});

test("concurrent registry mutations serialize without losing roots", async () => {
  const { base, home } = fixture(); const one = project(base, "one"); const two = project(base, "two");
  const results = await Promise.all([runAsync(home, ["project", "add", one, "--name", "One", "--json"]), runAsync(home, ["project", "add", two, "--name", "Two", "--json"])]);
  assert.ok(results.every((result) => result.status === 0), results.map((result) => result.stderr).join("\n")); assert.deepEqual(json(home, ["project", "list"]).projects.map((item) => item.name).sort(), ["One", "Two"]);
});

test("schema migration serializes with concurrent registry mutation", async () => {
  const { base, home } = fixture(); const legacyRoot = project(base, "legacy"); const addedRoot = project(base, "added"); const storage = path.join(home, ".agents", "planrock"); fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(path.join(storage, "planrock.json"), JSON.stringify({ schemaVersion: 1, projects: [{ id: "legacy", name: "Legacy", root: legacyRoot, source: "explicit", addedAt: "2026-01-01T00:00:00.000Z", discovery: true }], suppressions: { taskchef: [] } }), { mode: 0o600 });
  const results = await Promise.all([runAsync(home, ["project", "list", "--json"]), runAsync(home, ["project", "add", addedRoot, "--name", "Added", "--json"])]); assert.ok(results.every((result) => result.status === 0), results.map((result) => result.stderr).join("\n"));
  const registry = json(home, ["project", "list"]); assert.equal(registry.schemaVersion, 2); assert.deepEqual(registry.projects.map((item) => item.name).sort(), ["Added", "Legacy"]);
});

test("overview discovers direct child git repositories but not .git files or symlinks", () => {
  const { base, home } = fixture(); const workspace = project(base, "workspace");
  plan(workspace, "root.md", "title: Root\nstate: open\npriority: P2\ncreated_at: 2026-08-30");
  const child = project(workspace, "child"); fs.mkdirSync(path.join(child, ".git")); plan(child, "child.md", "title: Child\nstate: closed\ncreated_at: 2026-08-28\nclosed_at: 2026-08-29");
  const linked = project(base, "linked"); fs.symlinkSync(linked, path.join(workspace, "linked"), "dir");
  const worktree = project(workspace, "worktree"); fs.writeFileSync(path.join(worktree, ".git"), "gitdir: elsewhere\n"); plan(worktree, "ignored.md", "title: Ignored\nstate: open");
  const nested = project(worktree, "nested"); fs.mkdirSync(path.join(nested, ".git")); plan(nested, "also-ignored.md", "title: Also ignored\nstate: open");
  run(home, ["project", "add", workspace, "--name", "Workspace"]); const overview = json(home, ["overview"]);
  assert.deepEqual(overview.summary, { projects: 2, explicitRoots: 1, open: 1, closed: 1, invalid: 0 });
  assert.deepEqual(overview.nextUp.map((item) => item.title), ["Root"]);
});

test("built-in and configured ignores prune child discovery without matching the registered root basename", () => {
  const { base, home } = fixture(); const workspace = project(base, "generated"); plan(workspace, "root.md", "title: Root\nstate: open");
  for (const name of [".uv-cache", ".npm-cache", ".deps", ".agents", "ignored-name"]) { const child = project(workspace, name); fs.mkdirSync(path.join(child, ".git")); plan(child, `${name.replace(/[^a-z]/g, "")}.md`, `title: ${name}\nstate: open`); }
  const keptParent = path.join(workspace, "packages"); const ignoredPattern = project(keptParent, "generated-one"); fs.mkdirSync(path.join(ignoredPattern, ".git")); plan(ignoredPattern, "pattern.md", "title: Pattern\nstate: open");
  run(home, ["project", "add", workspace, "--name", "Workspace"]); const registryPath = path.join(home, ".agents", "planrock", "planrock.json"); const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")); registry.ignore = ["generated", "ignored-name", "packages/generated-*"]; fs.writeFileSync(registryPath, JSON.stringify(registry), { mode: 0o600 });
  const overview = json(home, ["overview"]); assert.deepEqual(overview.nextUp.map((item) => item.title), ["Root"]); assert.equal(overview.summary.projects, 1);
});

test("root-relative globstar ignores zero, one, and multiple path segments", () => {
  const { base, home } = fixture(); const workspace = project(base, "workspace"); plan(workspace, "root.md", "title: Root\nstate: open");
  for (const relative of ["packages/generated-zero", "packages/one/generated-one", "packages/one/two/generated-two"]) { const child = project(workspace, relative); fs.mkdirSync(path.join(child, ".git")); plan(child, "ignored.md", `title: ${relative}\nstate: open`); }
  run(home, ["project", "add", workspace, "--name", "Workspace"]); const registryPath = path.join(home, ".agents", "planrock", "planrock.json"); const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")); registry.ignore = ["packages/**/generated-*"]; fs.writeFileSync(registryPath, JSON.stringify(registry), { mode: 0o600 });
  assert.deepEqual(json(home, ["overview"]).nextUp.map((item) => item.title), ["Root"]);
});

test("canonical absolute ignores exclude only the exact registered root", () => {
  const { base, home } = fixture(); const ignored = project(base, "ignored"); const kept = project(base, "kept"); plan(ignored, "ignored.md", "title: Ignored\nstate: open"); plan(kept, "kept.md", "title: Kept\nstate: open");
  run(home, ["project", "add", ignored, "--name", "Ignored"]); run(home, ["project", "add", kept, "--name", "Kept"]); const registryPath = path.join(home, ".agents", "planrock", "planrock.json"); const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")); registry.ignore = [fs.realpathSync.native(ignored)]; fs.writeFileSync(registryPath, JSON.stringify(registry), { mode: 0o600 });
  const overview = json(home, ["overview"]); assert.deepEqual(overview.nextUp.map((item) => item.title), ["Kept"]); assert.equal(overview.summary.projects, 1); assert.equal(overview.summary.explicitRoots, 2);
});

test("canonical absolute ignores cannot be rediscovered beneath another root", () => {
  const { base, home } = fixture(); const workspace = project(base, "workspace"); plan(workspace, "root.md", "title: Root\nstate: open"); const child = project(workspace, "child"); fs.mkdirSync(path.join(child, ".git")); plan(child, "child.md", "title: Child\nstate: open");
  run(home, ["project", "add", workspace, "--name", "Workspace"]); const registryPath = path.join(home, ".agents", "planrock", "planrock.json"); const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")); registry.ignore = [fs.realpathSync.native(child)]; fs.writeFileSync(registryPath, JSON.stringify(registry), { mode: 0o600 });
  const overview = json(home, ["overview"]); assert.deepEqual(overview.nextUp.map((item) => item.title), ["Root"]); assert.equal(overview.summary.projects, 1);
});

test("unavailable registered roots make the overview incomplete", () => {
  const { base, home } = fixture(); const repo = project(base, "repo");
  run(home, ["project", "add", repo, "--name", "Repo"]); fs.renameSync(repo, `${repo}-away`);
  const overview = json(home, ["overview"]); const index = JSON.parse(fs.readFileSync(path.join(home, ".agents", "planrock", "index.json"), "utf8")); assert.equal(overview.incomplete, true); assert.equal(index.repositories[0].available, false);
  assert.ok(overview.diagnostics.some((item) => item.code === "PROJECT_ROOT_UNAVAILABLE"));
  assert.equal(overview.latestScan.outcome, "incomplete");
});

test("--no-discovery indexes the explicit root without discovering nested repositories", () => {
  const { base, home } = fixture(); const workspace = project(base, "workspace");
  plan(workspace, "root.md", "title: Root\nstate: open");
  const child = project(workspace, "child"); fs.mkdirSync(path.join(child, ".git")); plan(child, "child.md", "title: Child\nstate: open");
  run(home, ["project", "add", workspace, "--name", "Workspace", "--no-discovery"]); const overview = json(home, ["overview"]);
  assert.deepEqual(overview.summary, { projects: 1, explicitRoots: 1, open: 1, closed: 0, invalid: 0 });
  assert.deepEqual(overview.nextUp.map((item) => item.title), ["Root"]);
});

test("overview uses strict state taxonomy, compatibility defaults, and deterministic Next up ordering", () => {
  const { base, home } = fixture(); const repo = project(base, "repo");
  plan(repo, "normal.md", "title: Normal\nstate: open\ncreated_at: 2026-08-30");
  plan(repo, "urgent.md", "title: Urgent\nstate: open\npriority: P0\ncreated_at: 2026-08-01\nagent_session: codex:legacy", "- [x] Done");
  plan(repo, "invalid.md", "title: Invalid\nstate: waiting\ncreated_at: 2026-08-30");
  run(home, ["project", "add", repo, "--name", "Repo"]); const overview = json(home, ["overview"]);
  assert.equal(overview.summary.open, 2); assert.equal(overview.summary.invalid, 1); assert.deepEqual(overview.nextUp.map((item) => item.title), ["Urgent", "Normal"]);
  assert.deepEqual(overview.nextUp[0].agentSessions, ["codex:legacy"]);
  assert.ok(Number.isFinite(Date.parse(overview.nextUp[0].updatedAt)));
  assert.ok(overview.diagnostics.some((item) => item.code === "PLAN_OPEN_CHECKLIST_COMPLETE"));
  assert.ok(overview.diagnostics.some((item) => item.code === "PLAN_STATE_INVALID"));
});

test("TaskChef schema 2 imports independently with deterministic collision names and tombstones", () => {
  const { base, home } = fixture(); const explicit = project(base, "explicit"); const imported = project(base, "imported");
  run(home, ["project", "add", explicit, "--name", "Same"]);
  const taskchefDir = path.join(home, ".agents", "taskchef"); fs.mkdirSync(taskchefDir, { recursive: true });
  fs.writeFileSync(path.join(taskchefDir, "taskchef.json"), JSON.stringify({ schemaVersion: 2, projects: [{ name: "Same", path: imported, isGitRepository: true, githubRepos: [] }], dashboard: { autostart: false } }));
  const first = json(home, ["project", "import", "taskchef"]); const digest = crypto.createHash("sha256").update(fs.realpathSync.native(imported)).digest("hex").slice(0, 8); assert.equal(first.imported[0].name, `Same-${digest}`); assert.equal(Object.hasOwn(first, "redactions"), false);
  run(home, ["project", "remove", first.imported[0].id]); let registry = json(home, ["project", "list"]); assert.deepEqual(registry.ignore, [fs.realpathSync.native(imported)]); const second = json(home, ["project", "import", "taskchef"]); assert.equal(second.imported.length, 0);
  run(home, ["project", "add", imported, "--name", "ImportedExplicit"]); registry = json(home, ["project", "list"]); assert.ok(registry.projects.some((item) => item.name === "ImportedExplicit")); assert.deepEqual(registry.ignore, []);
});

test("failed refresh records one bounded attempt and preserves the last usable index", () => {
  const { base, home } = fixture(); const repo = project(base, "repo"); plan(repo, "one.md", "title: One\nstate: open"); run(home, ["project", "add", repo, "--name", "Repo"]);
  const healthy = json(home, ["refresh"]); const storage = path.join(home, ".agents", "planrock"); const indexBefore = fs.readFileSync(path.join(storage, "index.json"), "utf8"); assert.equal(healthy.latestScan.outcome, "success");
  const registryPath = path.join(storage, "planrock.json"); const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")); registry.ignore = ["../escape"]; fs.writeFileSync(registryPath, JSON.stringify(registry), { mode: 0o600 });
  assert.match(run(home, ["refresh"], 1).stderr, /Invalid registry ignore pattern/); assert.equal(fs.readFileSync(path.join(storage, "index.json"), "utf8"), indexBefore);
  const attempt = JSON.parse(fs.readFileSync(path.join(storage, "latest-scan.json"), "utf8")); assert.equal(attempt.outcome, "failed"); assert.equal(attempt.snapshotId, null); assert.equal(attempt.diagnostics[0].code, "SCAN_REFRESH_FAILED"); assert.equal(attempt.diagnostics[0].message.includes(home), false); assert.ok(attempt.durationMs >= 0);
});

test("latest-scan persistence is bounded by the exact pretty-printed representation", () => {
  const diagnostics = Array.from({ length: 30_000 }, (_, index) => ({ code: `CODE_${index}`, severity: index % 2 ? "warning" : "error", message: `Diagnostic ${index}`, project: "Repo", relativeFile: `plans/${index}.md` }));
  const invalidPlans = diagnostics.map((item, index) => ({ projectName: "Repo", relativeFile: `invalid/${index}.md`, diagnostics: [{ ...item, code: `INVALID_${index}`, relativeFile: `invalid/${index}.md` }] }));
  const record = latestScanRecord({ startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:00:01.000Z", trigger: "test", outcome: "incomplete", snapshot: { snapshotId: "snapshot", diagnostics, invalidPlans, repositories: [] } });
  assert.ok(Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`) < LIMITS.latestScanWriteBytes); assert.ok(record.omittedDiagnostics > 0); assert.ok(record.omittedInvalidPlans > 0);
});

test("latest-scan records invalid-plan diagnostics only in the invalid-plan collection", () => {
  const repeated = { code: "PLAN_STATE_INVALID", severity: "error", message: "Unsupported plan state", project: "Repo", relativeFile: "plans/broken.md" };
  const record = latestScanRecord({ startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:00:01.000Z", trigger: "test", outcome: "success", snapshot: { snapshotId: "snapshot", diagnostics: [repeated, { code: "SCAN_NOTE", severity: "info", message: "Distinct" }], invalidPlans: [{ projectName: "Repo", relativeFile: "plans/broken.md", diagnostics: [repeated] }], repositories: [] } });
  assert.deepEqual(record.diagnostics.map((item) => item.code), ["SCAN_NOTE"]); assert.equal(record.invalidPlans[0].diagnostics[0].code, "PLAN_STATE_INVALID");
  const redacted = latestScanRecord({ startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:00:01.000Z", trigger: "test", outcome: "incomplete", redactions: ["/private/repo"], snapshot: { snapshotId: "snapshot", diagnostics: [], invalidPlans: [{ projectName: "/private/repo", relativeFile: "plans/broken.md", diagnostics: [repeated] }], repositories: [] } }); assert.equal(redacted.invalidPlans[0].project, "[path]"); assert.equal(JSON.stringify(redacted).includes("/private/repo"), false);
});

test("latest-scan deduplicates repeated general diagnostics", () => {
  const repeated = { code: "SCAN_NOTE", severity: "warning", message: "Repeated" };
  const record = latestScanRecord({ startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:00:01.000Z", trigger: "test", outcome: "incomplete", snapshot: { snapshotId: "snapshot", diagnostics: [repeated, repeated], invalidPlans: [], repositories: [] } });
  assert.equal(record.diagnostics.length, 1); assert.equal(record.omittedDiagnostics, 0);
});

test("latest-scan write failure cannot replace the last usable index", () => {
  const { base, home } = fixture(); const repo = project(base, "repo"); plan(repo, "one.md", "title: One\nstate: open"); run(home, ["project", "add", repo, "--name", "Repo"]); json(home, ["refresh"]);
  const storage = path.join(home, ".agents", "planrock"); const indexPath = path.join(storage, "index.json"); const scanPath = path.join(storage, "latest-scan.json"); const before = fs.readFileSync(indexPath, "utf8"); fs.unlinkSync(scanPath); fs.symlinkSync(path.join(base, "outside.json"), scanPath); plan(repo, "two.md", "title: Two\nstate: open");
  assert.match(run(home, ["refresh"], 1).stderr, /must not be a symlink/); assert.equal(fs.readFileSync(indexPath, "utf8"), before);
});

test("malformed and duplicate TaskChef inputs import nothing and preserve prior registry", () => {
  const { base, home } = fixture(); const one = project(base, "one"); const two = project(base, "two"); const taskchefDir = path.join(home, ".agents", "taskchef"); fs.mkdirSync(taskchefDir, { recursive: true });
  json(home, ["project", "list"]);
  fs.writeFileSync(path.join(taskchefDir, "taskchef.json"), JSON.stringify({ schemaVersion: 2, projects: [{ name: "Dup", path: one, isGitRepository: true, githubRepos: [] }, { name: "dup", path: two, isGitRepository: true, githubRepos: [] }] }));
  const result = json(home, ["project", "import", "taskchef"]); assert.equal(result.imported.length, 0); assert.ok(result.diagnostics.some((item) => item.code === "TASKCHEF_IMPORT_INVALID")); assert.equal(json(home, ["project", "list"]).projects.length, 0);
});

test("malformed JSON fragments never enter the public latest-scan record", () => {
  const { home } = fixture(); const taskchefDir = path.join(home, ".agents", "taskchef"); fs.mkdirSync(taskchefDir, { recursive: true }); const secret = "customer-private-fragment"; fs.writeFileSync(path.join(taskchefDir, "taskchef.json"), `{"schemaVersion":2,"projects":["${secret}",oops]}`, { mode: 0o600 });
  const overview = json(home, ["overview"]); assert.equal(JSON.stringify(overview.latestScan).includes(secret), false); assert.equal(overview.latestScan.diagnostics.find((item) => item.code === "TASKCHEF_IMPORT_INVALID").message, "TaskChef discovery file is invalid");
});

test("TaskChef canonical-root aliases import only once", () => {
  const { base, home } = fixture(); const real = project(base, "real"); const alias = path.join(base, "alias"); fs.symlinkSync(real, alias, "dir"); const taskchefDir = path.join(home, ".agents", "taskchef"); fs.mkdirSync(taskchefDir, { recursive: true });
  fs.writeFileSync(path.join(taskchefDir, "taskchef.json"), JSON.stringify({ schemaVersion: 2, projects: [{ name: "Real", path: real, isGitRepository: true, githubRepos: [] }, { name: "Alias", path: alias, isGitRepository: true, githubRepos: [] }] }));
  const imported = json(home, ["project", "import", "taskchef"]); assert.equal(imported.imported.length, 1); assert.equal(json(home, ["overview"]).summary.explicitRoots, 1);
});

test("latest-scan redacts rejected TaskChef roots and source-file failures", () => {
  const { base, home } = fixture(); const taskchefDir = path.join(home, ".agents", "taskchef"); fs.mkdirSync(taskchefDir, { recursive: true }); const missing = path.join(base, "missing-secret-root"); const taskchefPath = path.join(taskchefDir, "taskchef.json");
  fs.writeFileSync(taskchefPath, JSON.stringify({ schemaVersion: 2, projects: [{ name: missing, path: missing, isGitRepository: true, githubRepos: [] }] }), { mode: 0o600 }); let overview = json(home, ["overview"]); assert.equal(JSON.stringify(overview.latestScan).includes(missing), false); assert.ok(overview.latestScan.diagnostics.some((item) => item.code === "TASKCHEF_ROOT_INVALID" && item.project === "[path]"));
  fs.unlinkSync(taskchefPath); const outside = path.join(base, "outside-taskchef.json"); fs.writeFileSync(outside, "{}"); fs.symlinkSync(outside, taskchefPath); overview = json(home, ["refresh"]); assert.equal(JSON.stringify(overview.latestScan).includes(home), false); assert.ok(overview.latestScan.diagnostics.some((item) => item.code === "TASKCHEF_IMPORT_INVALID"));
});

test("snapshot pagination fetches later pages and refresh invalidates old cursors", () => {
  const { base, home } = fixture(); const repo = project(base, "repo"); for (let index = 0; index < 3; index += 1) plan(repo, `${index}.md`, `title: Plan ${index}\nstate: open\ncreated_at: 2026-08-3${index}`);
  run(home, ["project", "add", repo, "--name", "Repo"]); const first = json(home, ["overview", "--limit", "1"]); assert.equal(first.page.items.length, 1); assert.ok(first.page.nextCursor);
  const second = json(home, ["overview", "--limit", "1", "--cursor", first.page.nextCursor]); assert.equal(second.page.offset, 1); assert.equal(second.page.items.length, 1); assert.notEqual(second.page.items[0].id, first.page.items[0].id);
  assert.match(run(home, ["overview", "--cursor", first.page.nextCursor], 1).stderr, /--cursor requires --json/);
  const malformed = Buffer.from(JSON.stringify({ snapshotId: first.overview.snapshotId, collection: "openPlans", offset: -1 })).toString("base64url"); assert.match(run(home, ["overview", "--limit", "1", "--cursor", malformed, "--json"], 1).stderr, /Invalid cursor offset/);
  json(home, ["refresh"]); const stale = run(home, ["overview", "--limit", "1", "--cursor", first.page.nextCursor, "--json"], 1); assert.match(stale.stderr, /stale snapshot/i);
});

test("corrupt index is discarded and rebuilt while corrupt registry is rejected", () => {
  const { base, home } = fixture(); const repo = project(base, "repo"); plan(repo, "plan.md", "title: Plan\nstate: open"); run(home, ["project", "add", repo, "--name", "Repo"]); const initial = json(home, ["overview"]);
  const storage = path.join(home, ".agents", "planrock"); fs.writeFileSync(path.join(storage, "latest-scan.json"), "not-json", { mode: 0o600 }); const cursor = Buffer.from(JSON.stringify({ snapshotId: initial.snapshotId, collection: "openPlans", offset: 0 })).toString("base64url"); assert.equal(json(home, ["overview", "--limit", "1", "--cursor", cursor]).overview.latestScan, null);
  fs.writeFileSync(path.join(storage, "latest-scan.json"), JSON.stringify({ schemaVersion: 1, invalidPlans: {} }), { mode: 0o600 }); assert.equal(json(home, ["overview", "--limit", "1", "--cursor", cursor]).overview.latestScan, null);
  const validScan = json(home, ["refresh"]).latestScan; fs.writeFileSync(path.join(storage, "latest-scan.json"), JSON.stringify({ ...validScan, unexpected: home }), { mode: 0o600 }); assert.equal(json(home, ["overview", "--limit", "1", "--cursor", Buffer.from(JSON.stringify({ snapshotId: validScan.snapshotId, collection: "openPlans", offset: 0 })).toString("base64url")]).overview.latestScan, null);
  fs.writeFileSync(path.join(storage, "latest-scan.json"), JSON.stringify({ ...validScan, snapshotId: "different-snapshot" }), { mode: 0o600 }); assert.equal(json(home, ["overview", "--limit", "1", "--cursor", Buffer.from(JSON.stringify({ snapshotId: validScan.snapshotId, collection: "openPlans", offset: 0 })).toString("base64url")]).overview.latestScan, null);
  fs.writeFileSync(path.join(storage, "index.json"), "not-json", { mode: 0o600 }); assert.equal(json(home, ["overview"]).summary.open, 1);
  fs.writeFileSync(path.join(storage, "planrock.json"), "not-json", { mode: 0o600 }); assert.match(run(home, ["project", "list"], 1).stderr, /Unexpected token|JSON/);
});

test("cache hits overlay the current registry identity after remove and re-add", () => {
  const { base, home } = fixture(); const repo = project(base, "repo"); plan(repo, "plan.md", "title: Cached\nstate: open");
  const first = json(home, ["project", "add", repo, "--name", "First"]); json(home, ["overview"]); run(home, ["project", "remove", first.project.id]);
  const second = json(home, ["project", "add", repo, "--name", "Second"]); const overview = json(home, ["overview"]);
  assert.equal(overview.summary.open, 1); assert.equal(overview.nextUp[0].projectId, second.project.id); assert.equal(overview.nextUp[0].projectName, "Second"); assert.equal(overview.diagnostics.some((item) => item.code === "INDEX_SERIALIZED_LIMIT"), false);
});

test("cache fingerprint detects same-size content edits with restored mtime", () => {
  const { base, home } = fixture(); const repo = project(base, "repo"); plan(repo, "plan.md", "title: First\nstate: open"); run(home, ["project", "add", repo, "--name", "Repo"]); assert.equal(json(home, ["overview"]).nextUp[0].title, "First");
  const target = path.join(repo, "plans", "plan.md"); const before = fs.statSync(target); const content = fs.readFileSync(target, "utf8"); fs.writeFileSync(target, content.replace("First", "Later")); fs.utimesSync(target, before.atime, before.mtime);
  assert.equal(json(home, ["overview"]).nextUp[0].title, "Later");
});

test("human registry output escapes terminal and bidi controls", () => {
  const { base, home } = fixture(); const repo = project(base, "repo"); const hostile = "Repo\u001b[31m\n\u202espoof";
  const added = run(home, ["project", "add", repo, "--name", hostile]); assert.doesNotMatch(added.stdout, /\u001b|\u202e/); assert.match(added.stdout, /\\\\u202e/); const listed = run(home, ["project", "list"]);
  assert.doesNotMatch(listed.stdout, /\u001b|\u202e/); assert.match(listed.stdout, /Repo\\x1b\[31m\\x0a\\u202espoof/); assert.equal(listed.stdout.trim().split("\n").length, 1);
});

test("managed-file symlinks are rejected", () => {
  const { base, home } = fixture(); const storage = path.join(home, ".agents", "planrock"); fs.mkdirSync(storage, { recursive: true, mode: 0o700 }); const target = path.join(base, "outside.json"); fs.writeFileSync(target, "{}\n"); fs.symlinkSync(target, path.join(storage, "planrock.json"));
  assert.match(run(home, ["project", "list"], 1).stderr, /symlink/i);
});

test("oversized and symlinked plan candidates are skipped without becoming invalid plans", () => {
  const { base, home } = fixture(); const repo = project(base, "repo"); const outside = path.join(base, "outside.md"); fs.writeFileSync(outside, "---\nstate: open\n---\n"); fs.symlinkSync(outside, path.join(repo, "plans", "linked.md")); fs.writeFileSync(path.join(repo, "plans", "large.md"), Buffer.alloc(2 * 1024 * 1024 + 1));
  run(home, ["project", "add", repo, "--name", "Repo"]); const overview = json(home, ["overview"]); assert.equal(overview.summary.invalid, 0); assert.equal(overview.incomplete, true); assert.ok(overview.diagnostics.some((item) => item.code === "PLAN_FILE_SIZE_LIMIT")); assert.ok(overview.diagnostics.some((item) => item.code === "PLAN_ENTRY_SKIPPED"));
});
