const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "scripts", "planrock");

function makeWorkingDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "planrock-test-"));
}

function writePlan(workingDir, filename, frontmatter, body) {
  const plansDir = path.join(workingDir, "plans");
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(
    path.join(plansDir, filename),
    [
      "---",
      `title: ${frontmatter.title}`,
      `state: ${frontmatter.state}`,
      `created_at: ${frontmatter.created_at}`,
      frontmatter.closed_at ? `closed_at: ${frontmatter.closed_at}` : null,
      "---",
      "",
      body,
      "",
    ]
      .filter((line) => line !== null)
      .join("\n"),
  );
}

function runPlanrock(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd || repoRoot,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
  });
}

test("help documents --working-dir without advertising --workspace", () => {
  const result = runPlanrock(["--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /--working-dir <path>/);
  assert.doesNotMatch(result.stdout, /--workspace <path>/);
});

test("status --working-dir emits workingDir JSON and checklist counts", () => {
  const workingDir = makeWorkingDir();
  writePlan(
    workingDir,
    "open-plan.md",
    {
      title: "Open Plan",
      state: "open",
      created_at: "2026-05-14",
    },
    ["- [x] Done item", "- [ ] Next item"].join("\n"),
  );

  const result = runPlanrock(["status", "--working-dir", workingDir, "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.workingDir, workingDir);
  assert.equal(report.summary.open, 1);
  assert.equal(report.summary.closed, 0);
  assert.equal(report.recentOpenPlans[0].checklistDone, 1);
  assert.equal(report.recentOpenPlans[0].checklistTotal, 2);
  assert.equal(report.recentOpenPlans[0].completionPercent, 50);
});

test("--workspace remains a compatibility alias for --working-dir", () => {
  const workingDir = makeWorkingDir();
  writePlan(
    workingDir,
    "open-plan.md",
    {
      title: "Alias Plan",
      state: "open",
      created_at: "2026-05-14",
    },
    "- [ ] Check alias",
  );

  const result = runPlanrock(["open", "--workspace", workingDir, "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.workingDir, workingDir);
  assert.equal(report.openPlans[0].title, "Alias Plan");
});

test("current directory lookup does not search parent directories", () => {
  const workingDir = makeWorkingDir();
  const childDir = path.join(workingDir, "nested");
  fs.mkdirSync(childDir);
  writePlan(
    workingDir,
    "parent-plan.md",
    {
      title: "Parent Plan",
      state: "open",
      created_at: "2026-05-14",
    },
    "- [ ] Should not be discovered from child",
  );

  const result = runPlanrock(["status"], { cwd: childDir });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /no plans\/ directory found in the current working directory/);
  assert.match(result.stderr, new RegExp(`${childDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/plans`));
});

test("PLANROCK_WORKING_DIR selects the working directory", () => {
  const workingDir = makeWorkingDir();
  writePlan(
    workingDir,
    "env-plan.md",
    {
      title: "Env Plan",
      state: "open",
      created_at: "2026-05-14",
    },
    "- [ ] Check env",
  );

  const result = runPlanrock(["status", "--json"], {
    cwd: makeWorkingDir(),
    env: { PLANROCK_WORKING_DIR: workingDir },
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.workingDir, workingDir);
  assert.equal(report.recentOpenPlans[0].title, "Env Plan");
});
