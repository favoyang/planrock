const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { LIMITS } = require("../lib/constants");
const { discoverAll } = require("../lib/discovery");

function repo(name) { const root = fs.mkdtempSync(path.join(os.tmpdir(), `planrock-${name}-`)); fs.mkdirSync(path.join(root, "plans")); return root; }
function write(root, name, size = 32) { fs.writeFileSync(path.join(root, "plans", name), Buffer.alloc(size, "x")); }
function withLimits(overrides, callback) { const original = {}; for (const [key, value] of Object.entries(overrides)) { original[key] = LIMITS[key]; LIMITS[key] = value; } try { return callback(); } finally { Object.assign(LIMITS, original); } }
function project(root, name = "Repo") { return { id: name, name, root: fs.realpathSync.native(root), source: "explicit", discovery: true }; }

test("root candidate, source-byte, and aggregate budgets stop deterministically", () => {
  const one = repo("one"); const two = repo("two"); write(one, "a.md"); write(one, "b.md"); write(two, "c.md");
  const countLimited = withLimits({ rootPlanCandidates: 1 }, () => discoverAll([project(one)])); assert.equal(countLimited.aggregate.candidates, 1); assert.ok(countLimited.diagnostics.some((item) => item.code === "SCAN_ROOT_PLAN_COUNT_LIMIT"));
  const byteLimited = withLimits({ rootPlanBytes: 40 }, () => discoverAll([project(one)])); assert.equal(byteLimited.aggregate.candidates, 1); assert.ok(byteLimited.diagnostics.some((item) => item.code === "SCAN_ROOT_SOURCE_LIMIT"));
  const aggregateLimited = withLimits({ aggregatePlanCandidates: 1 }, () => discoverAll([project(one, "One"), project(two, "Two")])); assert.equal(aggregateLimited.aggregate.candidates, 1); assert.ok(aggregateLimited.diagnostics.some((item) => item.code === "SCAN_AGGREGATE_PLAN_COUNT_LIMIT"));
});

test("directory, depth, per-root time, and aggregate time limits emit stable diagnostics", () => {
  const root = repo("directories"); let current = root; for (let index = 0; index < 5; index += 1) { current = path.join(current, `level-${index}`); fs.mkdirSync(current); }
  const directories = withLimits({ maxDirectories: 1 }, () => discoverAll([project(root)])); assert.ok(directories.diagnostics.some((item) => item.code === "SCAN_ROOT_DIRECTORY_LIMIT"));
  const depth = withLimits({ maxDepth: 0 }, () => discoverAll([project(root)])); assert.ok(depth.diagnostics.some((item) => item.code === "SCAN_ROOT_DEPTH_LIMIT"));
  const rootTime = withLimits({ rootMilliseconds: 0 }, () => discoverAll([project(root)])); assert.ok(rootTime.diagnostics.some((item) => item.code === "SCAN_ROOT_TIME_LIMIT"));
  const aggregateTime = withLimits({ aggregateMilliseconds: 0 }, () => discoverAll([project(root)])); assert.ok(aggregateTime.diagnostics.some((item) => item.code === "SCAN_AGGREGATE_TIME_LIMIT"));
});

test("plan file size limit skips the candidate and marks the root incomplete", () => {
  const root = repo("size"); write(root, "large.md", 16); const result = withLimits({ planBytes: 8 }, () => discoverAll([project(root)])); assert.equal(result.aggregate.candidates, 0); assert.equal(result.incomplete, true); assert.ok(result.diagnostics.some((item) => item.code === "PLAN_FILE_SIZE_LIMIT"));
});
