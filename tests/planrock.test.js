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
  const extraFrontmatter = Object.entries(frontmatter)
    .filter(
      ([key, value]) =>
        !["title", "state", "created_at", "closed_at"].includes(key) &&
        value !== undefined &&
        value !== null,
    )
    .flatMap(([key, value]) => {
      if (Array.isArray(value)) {
        return [`${key}:`, ...value.map((item) => `  - ${item}`)];
      }

      return [`${key}: ${value}`];
    });

  fs.writeFileSync(
    path.join(plansDir, filename),
    [
      "---",
      `title: ${frontmatter.title}`,
      `state: ${frontmatter.state}`,
      `created_at: ${frontmatter.created_at}`,
      frontmatter.closed_at ? `closed_at: ${frontmatter.closed_at}` : null,
      ...extraFrontmatter,
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
  assert.equal(report.recentOpenPlans[0].priority, "P2");
  assert.deepEqual(report.recentOpenPlans[0].agentSessions, []);
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

test("open defaults to priority sort then newest created_at", () => {
  const workingDir = makeWorkingDir();
  writePlan(
    workingDir,
    "new-normal.md",
    {
      title: "New Normal",
      state: "open",
      created_at: "2026-05-16",
      priority: "P2",
    },
    "- [ ] Normal work",
  );
  writePlan(
    workingDir,
    "old-high.md",
    {
      title: "Old High",
      state: "open",
      created_at: "2026-05-14",
      priority: "P1",
    },
    "- [ ] Important work",
  );
  writePlan(
    workingDir,
    "new-high.md",
    {
      title: "New High",
      state: "open",
      created_at: "2026-05-15",
      priority: "P1",
    },
    "- [ ] Important newer work",
  );
  writePlan(
    workingDir,
    "emergency.md",
    {
      title: "Emergency",
      state: "open",
      created_at: "2026-05-13",
      priority: "P0",
    },
    "- [ ] Stop the world",
  );

  const result = runPlanrock(["open", "--working-dir", workingDir, "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(
    report.openPlans.map((plan) => plan.title),
    ["Emergency", "New High", "Old High", "New Normal"],
  );
});

test("open --sort time uses newest created_at only", () => {
  const workingDir = makeWorkingDir();
  writePlan(
    workingDir,
    "new-normal.md",
    {
      title: "New Normal",
      state: "open",
      created_at: "2026-05-16",
      priority: "P2",
    },
    "- [ ] Normal work",
  );
  writePlan(
    workingDir,
    "old-emergency.md",
    {
      title: "Old Emergency",
      state: "open",
      created_at: "2026-05-14",
      priority: "P0",
    },
    "- [ ] Emergency work",
  );

  const result = runPlanrock([
    "open",
    "--working-dir",
    workingDir,
    "--sort",
    "time",
    "--json",
  ]);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(
    report.openPlans.map((plan) => plan.title),
    ["New Normal", "Old Emergency"],
  );
});

test("status --sort time uses newest created_at for recent open plans", () => {
  const workingDir = makeWorkingDir();
  writePlan(
    workingDir,
    "new-normal.md",
    {
      title: "New Normal",
      state: "open",
      created_at: "2026-05-16",
      priority: "P2",
    },
    "- [ ] Normal work",
  );
  writePlan(
    workingDir,
    "old-emergency.md",
    {
      title: "Old Emergency",
      state: "open",
      created_at: "2026-05-14",
      priority: "P0",
    },
    "- [ ] Emergency work",
  );

  const result = runPlanrock([
    "status",
    "--working-dir",
    workingDir,
    "--sort=time",
    "--json",
  ]);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(
    report.recentOpenPlans.map((plan) => plan.title),
    ["New Normal", "Old Emergency"],
  );
});

test("open --sort priority is accepted explicitly", () => {
  const workingDir = makeWorkingDir();
  writePlan(
    workingDir,
    "normal.md",
    {
      title: "Normal",
      state: "open",
      created_at: "2026-05-16",
      priority: "P2",
    },
    "- [ ] Normal work",
  );
  writePlan(
    workingDir,
    "high.md",
    {
      title: "High",
      state: "open",
      created_at: "2026-05-15",
      priority: "P1",
    },
    "- [ ] High work",
  );

  const result = runPlanrock([
    "open",
    "--working-dir",
    workingDir,
    "--sort=priority",
    "--json",
  ]);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(
    report.openPlans.map((plan) => plan.title),
    ["High", "Normal"],
  );
});

test("human open output includes priority, title, progress, and short agent sessions", () => {
  const workingDir = makeWorkingDir();
  writePlan(
    workingDir,
    "agent-session.md",
    {
      title: "Agent Session Plan",
      state: "open",
      created_at: "2026-05-16",
      priority: "P1",
      agent_sessions: [
        "codex:019e2f18-930f-7052-999f-e3b083d9373f",
        "codex:982f38ab-930f-7052-999f-e3b083d9373f",
      ],
    },
    "- [ ] Agent session work",
  );
  writePlan(
    workingDir,
    "missing.md",
    {
      title: "Missing Agent",
      state: "open",
      created_at: "2026-05-14",
    },
    "- [ ] Missing",
  );

  const result = runPlanrock(["open", "--working-dir", workingDir]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Priority\s+Title\s+Created\s+Done\/Total\s+Percent\s+Agent Sessions/,
  );
  assert.match(
    result.stdout,
    /P1\s+Agent Session Plan\s+2026-05-16\s+0\/1\s+0%\s+codex:019e2f18, codex:982f38ab/,
  );
  assert.match(
    result.stdout,
    /P2\s+Missing Agent\s+2026-05-14\s+0\/1\s+0%\s+-/,
  );
});

test("human open output can include full agent session", () => {
  const workingDir = makeWorkingDir();
  writePlan(
    workingDir,
    "agent-session.md",
    {
      title: "Agent Session Plan",
      state: "open",
      created_at: "2026-05-16",
      priority: "P1",
      agent_sessions: ["codex:019e2f18-930f-7052-999f-e3b083d9373f"],
    },
    "- [ ] Agent session work",
  );

  const result = runPlanrock([
    "open",
    "--working-dir",
    workingDir,
    "--full-agent-session",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /P1\s+Agent Session Plan\s+2026-05-16\s+0\/1\s+0%\s+codex:019e2f18-930f-7052-999f-e3b083d9373f/,
  );
});

test("JSON output includes agent sessions field only", () => {
  const workingDir = makeWorkingDir();
  writePlan(
    workingDir,
    "agent-session.md",
    {
      title: "Agent Session",
      state: "open",
      created_at: "2026-05-16",
      priority: "P1",
      agent_sessions: ["codex:019e2f18-930f-7052-999f-e3b083d9373f"],
    },
    "- [ ] Agent session",
  );

  const result = runPlanrock(["open", "--working-dir", workingDir, "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(report.openPlans[0]), [
    "file",
    "title",
    "state",
    "priority",
    "createdAt",
    "closedAt",
    "agentSessions",
    "checklistDone",
    "checklistTotal",
    "completionPercent",
  ]);
  assert.equal(report.openPlans[0].priority, "P1");
  assert.deepEqual(report.openPlans[0].agentSessions, [
    "codex:019e2f18-930f-7052-999f-e3b083d9373f",
  ]);
});

test("legacy agent_session is read as one agent session", () => {
  const workingDir = makeWorkingDir();
  writePlan(
    workingDir,
    "agent-session.md",
    {
      title: "Legacy Agent Session",
      state: "open",
      created_at: "2026-05-16",
      priority: "P1",
      agent_session: "codex:019e2f18-930f-7052-999f-e3b083d9373f",
    },
    "- [ ] Agent session",
  );

  const result = runPlanrock(["open", "--working-dir", workingDir, "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.openPlans[0].agentSessions, [
    "codex:019e2f18-930f-7052-999f-e3b083d9373f",
  ]);
});

test("agent_sessions empty inline list is read as no agent sessions", () => {
  const workingDir = makeWorkingDir();
  writePlan(
    workingDir,
    "agent-sessions.md",
    {
      title: "Empty Agent Sessions",
      state: "open",
      created_at: "2026-05-16",
      priority: "P1",
      agent_sessions: "[]",
    },
    "- [ ] Agent session",
  );

  const result = runPlanrock(["open", "--working-dir", workingDir, "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.openPlans[0].agentSessions, []);
});
