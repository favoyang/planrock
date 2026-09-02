const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { readPlans } = require("../lib/local");
const { parsePlan } = require("../lib/parser");
const { workflowState } = require("../lib/plan-status");

test("shared workflow classifier covers dashboard and CLI edge cases", () => {
  const cases = [
    [{ state: "open", checklistDone: 0, checklistTotal: 0, agentSessions: [] }, "pending"],
    [{ state: "open", checklistDone: 0, checklistTotal: 2, agentSessions: [] }, "pending"],
    [{ state: "open", checklistDone: 1, checklistTotal: 2, agentSessions: [] }, "active"],
    [{ state: "open", checklistDone: 0, checklistTotal: 2, agentSessions: ["codex:session"] }, "active"],
    [{ state: "open", checklistDone: 2, checklistTotal: 2, agentSessions: [] }, "active"],
    [{ state: "closed", checklistDone: 0, checklistTotal: 2, agentSessions: ["codex:session"] }, "closed"],
  ];

  for (const [plan, expected] of cases) assert.equal(workflowState(plan), expected);
});

test("CLI collections have parity with the dashboard's shared classifier", () => {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "planrock-status-parity-"));
  const plansDir = path.join(workingDir, "plans");
  fs.mkdirSync(plansDir);
  fs.writeFileSync(path.join(plansDir, "pending.md"), "---\ntitle: Pending\nstate: open\n---\n\n- [ ] Start\n");
  fs.writeFileSync(path.join(plansDir, "progress.md"), "---\ntitle: Progress\nstate: open\n---\n\n- [x] Started\n- [ ] Finish\n");
  fs.writeFileSync(path.join(plansDir, "session.md"), "---\ntitle: Session\nstate: open\nagent_sessions:\n  - codex:session\n---\n\n- [ ] Start\n");
  fs.writeFileSync(path.join(plansDir, "closed.md"), "---\ntitle: Closed\nstate: closed\n---\n\n- [x] Done\n");

  const inventory = readPlans(plansDir);
  const all = [...inventory.openPlans, ...inventory.closedPlans];
  assert.deepEqual(Object.fromEntries(all.map((plan) => [plan.title, plan.workflow])), {
    Progress: "active",
    Session: "active",
    Pending: "pending",
    Closed: "closed",
  });
  for (const plan of all) assert.equal(plan.workflow, workflowState(plan));
});

test("CLI and dashboard normalize typed session metadata identically", () => {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "planrock-session-parity-"));
  const plansDir = path.join(workingDir, "plans");
  fs.mkdirSync(plansDir);
  const fixtures = {
    "null.md": "---\ntitle: Null\nstate: open\nagent_sessions: null\n---\n\n- [ ] Start\n",
    "false.md": "---\ntitle: False\nstate: open\nagent_sessions: false\n---\n\n- [ ] Start\n",
    "non-text.md": "---\ntitle: Non-text\nstate: open\nagent_sessions: [null, false]\n---\n\n- [ ] Start\n",
    "mixed.md": "---\ntitle: Mixed\nstate: open\nagent_sessions: [null, codex:session]\n---\n\n- [ ] Start\n",
  };
  for (const [filename, content] of Object.entries(fixtures)) fs.writeFileSync(path.join(plansDir, filename), content);
  fs.writeFileSync(path.join(plansDir, "malformed-flow.md"), "---\ntitle: Malformed flow\nstate: open\nagent_sessions: [null\n---\n");
  fs.writeFileSync(path.join(plansDir, "duplicate.md"), "---\ntitle: First\ntitle: Duplicate compatible\nstate: open\n---\n\n- [ ] Start\n");

  const inventory = readPlans(plansDir);
  const localByTitle = new Map(inventory.openPlans.map((plan) => [plan.title, plan]));
  for (const [filename, content] of Object.entries(fixtures)) {
    const parsed = parsePlan(content, { projectId: "parity", relativeFile: `plans/${filename}` });
    assert.equal(parsed.valid, true);
    const local = localByTitle.get(parsed.plan.title);
    assert.deepEqual(local.agentSessions, parsed.plan.agentSessions);
    assert.equal(local.workflow, workflowState(parsed.plan));
  }
  assert.equal(localByTitle.get("null.md").workflow, "pending");
  assert.equal(localByTitle.get("false.md").workflow, "pending");
  assert.equal(localByTitle.get("Non-text").workflow, "pending");
  assert.equal(localByTitle.get("Mixed").workflow, "active");
  assert.deepEqual(inventory.invalidPlans.map((plan) => plan.file), ["plans/malformed-flow.md"]);
  assert.equal(localByTitle.get("Duplicate compatible").workflow, "pending");
});
