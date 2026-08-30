const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { parsePlan } = require("../lib/parser");
const { LIMITS } = require("../lib/constants");
const { projectSnapshot } = require("../lib/indexer");
const { safeReadFile, syncDirectory } = require("../lib/security");

test("plan projection truncates bounded fields and keeps hostile schemes inert", () => {
  const title = "t".repeat(2048); const longUrl = `https://example.com/${"x".repeat(3000)}`;
  const parsed = parsePlan(`---\ntitle: ${title}\nstate: open\ncreated_at: 2026-02-30\n---\n\n## Goal\n\nGoal text.\n\n[bad](javascript:alert(1)) [file](file:///tmp/x) [long](${longUrl}) [good](https://example.com/good)`, { project: "test", projectId: "test", relativeFile: "plans/hostile.md" });
  assert.equal(parsed.valid, true); assert.ok(Buffer.byteLength(parsed.plan.title) <= 1024); assert.deepEqual(parsed.plan.relatedLinks, ["https://example.com/good"]);
  assert.ok(parsed.diagnostics.some((item) => item.code === "PLAN_FIELD_TRUNCATED")); assert.ok(parsed.diagnostics.some((item) => item.code === "PLAN_LINK_UNSUPPORTED_SCHEME")); assert.ok(parsed.diagnostics.some((item) => item.code === "PLAN_LINK_TOO_LONG")); assert.ok(parsed.diagnostics.some((item) => item.code === "PLAN_CREATED_AT_INVALID"));
});

test("frontmatter closes only on an exact delimiter line", () => {
  const malformed = parsePlan("---\ntitle: Bad\nstate: open\n---garbage\n\n## Goal\n\nBody", { project: "test", projectId: "test", relativeFile: "plans/bad.md" });
  assert.equal(malformed.valid, false); assert.ok(malformed.diagnostics.some((item) => item.code === "PLAN_FRONTMATTER_INVALID"));
});

test("no-follow read fails closed when a file is replaced between inspection and open", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "planrock-race-")); const target = path.join(directory, "plan.md"); const outside = path.join(directory, "outside.md"); fs.writeFileSync(target, "safe"); fs.writeFileSync(outside, "escaped");
  const original = fs.openSync; let replaced = false;
  fs.openSync = function patched(file, flags, mode) { if (!replaced && file === target) { replaced = true; fs.unlinkSync(target); fs.symlinkSync(outside, target); } return original.call(fs, file, flags, mode); };
  try { assert.throws(() => safeReadFile(target, 1024, { requireOwned: false }), /symlink|ELOOP|changed/i); } finally { fs.openSync = original; }
});

test("guarded read fails closed when a parent directory is replaced", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "planrock-parent-race-")); const plans = path.join(directory, "plans"); const outside = path.join(directory, "outside"); fs.mkdirSync(plans); fs.mkdirSync(outside); const target = path.join(plans, "plan.md"); fs.writeFileSync(target, "safe"); fs.writeFileSync(path.join(outside, "plan.md"), "escaped"); const plansStat = fs.lstatSync(plans); const guard = { path: plans, dev: plansStat.dev, ino: plansStat.ino };
  const original = fs.openSync; let replaced = false; fs.openSync = function patched(file, flags, mode) { if (!replaced && file === target) { replaced = true; fs.renameSync(plans, `${plans}-old`); fs.symlinkSync(outside, plans, "dir"); } return original.call(fs, file, flags, mode); };
  try { assert.throws(() => safeReadFile(target, 1024, { requireOwned: false, directoryGuards: [guard] }), /parent directory identity changed|symlink|changed during inspection/i); } finally { fs.openSync = original; }
});

test("serialized index projection bounds every large collection in one pass", () => {
  const originalLimit = LIMITS.indexWriteBytes; LIMITS.indexWriteBytes = 64 * 1024;
  try {
    const plans = Array.from({ length: 500 }, (_, index) => ({ id: String(index), projectId: "repo", state: "open", priority: "P2", createdAt: "2026-08-30", projectName: "Repo", relativeFile: `plans/${index}.md`, payload: "x".repeat(1000) }));
    const large = Array.from({ length: 500 }, (_, index) => ({ code: `D${index}`, severity: "warning", message: "x".repeat(1000) }));
    const snapshot = projectSnapshot({ schemaVersion: 1, refreshedAt: "2026-08-30T00:00:00.000Z", incomplete: false, summary: { projects: 1, explicitRoots: 1, open: 500, closed: 0, invalid: 500 }, repositories: [{ id: "repo", root: "/repo" }], plans, openPlans: plans, closedPlans: [], invalidPlans: large, diagnostics: large, plansDirectories: large.map((_, index) => `/repo/${index}/plans`) });
    assert.equal(snapshot.incomplete, true); assert.ok(snapshot.plans.length < plans.length); assert.ok(snapshot.invalidPlans.length < large.length); assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < LIMITS.indexWriteBytes); assert.ok(snapshot.diagnostics.some((item) => item.code === "INDEX_SERIALIZED_LIMIT"));
  } finally { LIMITS.indexWriteBytes = originalLimit; }
});

test("Windows atomic-write durability skips unsupported directory fsync", () => {
  const fsModule = { constants: { O_RDONLY: 0 }, openSync() { throw new Error("directory open must not run on Windows"); } };
  assert.doesNotThrow(() => syncDirectory("C:\\storage", { platform: "win32", fsModule }));
});
