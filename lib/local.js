const fs = require("node:fs");
const path = require("node:path");
const { PRIORITIES } = require("./constants");
const { countChecklistItems, extractSection, parseFrontmatter } = require("./parser");

const STATUS_LIMIT = 10;

function escapedControl(character) { const code = character.charCodeAt(0); return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`; }
function escapeTerminalControls(value) { return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, escapedControl); }
function escapeMultilineTerminalText(value) {
  return String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, escapedControl);
}
function normalizeSessions(frontmatter) {
  if (Array.isArray(frontmatter.agent_sessions)) return frontmatter.agent_sessions.filter((session) => session !== "");
  if (frontmatter.agent_sessions) return frontmatter.agent_sessions === "[]" ? [] : [frontmatter.agent_sessions];
  return frontmatter.agent_session ? [frontmatter.agent_session] : [];
}
function readPlans(plansDir, sort = "priority") {
  if (!fs.existsSync(plansDir)) throw new Error(`Warning: no plans/ directory found in the current working directory. Expected saved plans under: ${plansDir}`);
  const filenames = fs.readdirSync(plansDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name).sort();
  const openPlans = []; const closedPlans = [];
  for (const filename of filenames) {
    const content = fs.readFileSync(path.join(plansDir, filename), "utf8");
    const frontmatter = parseFrontmatter(content).values;
    const checklist = countChecklistItems(content);
    const plan = { file: path.join("plans", filename), title: frontmatter.title || filename, state: frontmatter.state || "", priority: PRIORITIES.includes(frontmatter.priority) ? frontmatter.priority : "P2", createdAt: frontmatter.created_at || "", closedAt: frontmatter.closed_at || "", agentSessions: normalizeSessions(frontmatter), checklistDone: checklist.done, checklistTotal: checklist.total, completionPercent: checklist.percent };
    if (plan.state === "open") openPlans.push(plan); else if (plan.state === "closed") closedPlans.push(plan);
  }
  openPlans.sort((a, b) => sort === "time" ? b.createdAt.localeCompare(a.createdAt) : PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || b.createdAt.localeCompare(a.createdAt));
  closedPlans.sort((a, b) => b.closedAt.localeCompare(a.closedAt));
  return { openPlans, closedPlans };
}
function printTable(rows, columns) {
  if (!rows.length) { console.log("  (none)"); return; }
  const widths = columns.map((column) => Math.max(column.label.length, ...rows.map((row) => escapeTerminalControls(column.value(row)).length)));
  console.log(columns.map((column, index) => String(column.label).padEnd(widths[index])).join("  "));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(columns.map((column, index) => escapeTerminalControls(column.value(row)).padEnd(widths[index])).join("  "));
}
function columns(full) { return [
  { label: "Priority", value: (plan) => plan.priority }, { label: "Title", value: (plan) => plan.title }, { label: "Created", value: (plan) => plan.createdAt },
  { label: "Done/Total", value: (plan) => `${plan.checklistDone}/${plan.checklistTotal}` }, { label: "Percent", value: (plan) => `${plan.completionPercent}%` },
  { label: "Agent Sessions", value: (plan) => plan.agentSessions.length ? plan.agentSessions.map((session) => full ? session : (() => { const index = session.indexOf(":"); return index === -1 ? session.slice(0, 8) : `${session.slice(0, index)}:${session.slice(index + 1, index + 9)}`; })()).join(", ") : "-" },
]; }
function runLocal(command, { workingDir, sort, json, fullAgentSession }) {
  const { openPlans, closedPlans } = readPlans(path.join(workingDir, "plans"), sort);
  if (json) {
    if (command === "open") console.log(JSON.stringify({ workingDir, openPlans }, null, 2));
    else if (command === "closed") console.log(JSON.stringify({ workingDir, closedPlans }, null, 2));
    else console.log(JSON.stringify({ workingDir, summary: { open: openPlans.length, closed: closedPlans.length }, recentOpenPlans: openPlans.slice(0, STATUS_LIMIT), recentClosedPlans: closedPlans.slice(0, STATUS_LIMIT) }, null, 2));
    return;
  }
  console.log(`Working dir: ${escapeTerminalControls(workingDir)}`);
  if (command === "open") { console.log("Open Plans"); printTable(openPlans, columns(fullAgentSession)); return; }
  if (command === "closed") { console.log("Closed Plans"); printTable(closedPlans, [{ label: "Closed", value: (plan) => plan.closedAt }, { label: "Created", value: (plan) => plan.createdAt }, { label: "Title", value: (plan) => plan.title }]); return; }
  console.log("Planrock Status"); console.log(`Open:   ${openPlans.length}`); console.log(`Closed: ${closedPlans.length}`); console.log(""); console.log(`Top Open Plans (top ${STATUS_LIMIT})`); printTable(openPlans.slice(0, STATUS_LIMIT), columns(fullAgentSession)); console.log(""); console.log(`Most Recent Closed Plans (top ${STATUS_LIMIT})`); printTable(closedPlans.slice(0, STATUS_LIMIT), [{ label: "Closed", value: (plan) => plan.closedAt }, { label: "Created", value: (plan) => plan.createdAt }, { label: "Title", value: (plan) => plan.title }]);
}
function runGoal(planPath, workingDir) {
  if (!planPath) throw new Error("goal requires a path to a plan");
  const resolved = path.isAbsolute(planPath) ? planPath : path.resolve(workingDir, planPath);
  const content = fs.readFileSync(resolved, "utf8");
  const goal = extractSection(content, "Goal");
  if (!goal) throw new Error(/#{1,6}\s+Goal\s*$/im.test(content) ? "Plan Goal section is empty." : "Plan does not contain a Goal section.");
  const segments = resolved.split(path.sep); const index = segments.lastIndexOf("plans"); const reference = index === -1 ? resolved : segments.slice(index).join("/");
  console.log(`/goal\n${escapeMultilineTerminalText(goal)}\n\nUse plan reference: ${escapeTerminalControls(reference)}.`);
}

module.exports = { escapeMultilineTerminalText, escapeTerminalControls, readPlans, runGoal, runLocal };
