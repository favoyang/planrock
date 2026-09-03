const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { LIMITS, PRIORITIES } = require("./constants");
const { countChecklistItems, extractSection, normalizeAgentSessions, parseFrontmatter, parsePlan } = require("./parser");
const { workflowState } = require("./plan-status");
const { safeReadFile, syncDirectory } = require("./security");

const STATUS_LIMIT = 10;

function localDate(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function plansDirectory(workingDir, { create = false } = {}) {
  if (!fs.existsSync(workingDir) || !fs.statSync(workingDir).isDirectory()) throw new Error(`Working directory does not exist or is not a directory: ${workingDir}`);
  const plansDir = path.join(workingDir, "plans");
  if (!fs.existsSync(plansDir)) {
    if (!create) throw new Error(`Warning: no plans/ directory found in the current working directory. Expected saved plans under: ${plansDir}`);
    try { fs.mkdirSync(plansDir); } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const stat = fs.lstatSync(plansDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`plans/ must be a real directory: ${plansDir}`);
  return plansDir;
}
function normalizePlanFilename(value) {
  if (!value) throw new Error("create requires a lowercase kebab-case plan slug");
  const slug = value.endsWith(".md") ? value.slice(0, -3) : value;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("plan slug must use lowercase kebab-case without directories");
  return `${slug}.md`;
}
function createPlan(slug, { workingDir, title, priority = "P2", now = new Date() }) {
  const normalizedTitle = typeof title === "string" ? title.trim() : "";
  if (!normalizedTitle) throw new Error("create requires --title <short-title>");
  if (/[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(normalizedTitle)) throw new Error("plan title must be one line without control characters");
  if (Buffer.byteLength(normalizedTitle) > LIMITS.titleBytes) throw new Error(`plan title must not exceed ${LIMITS.titleBytes} bytes`);
  if (!PRIORITIES.includes(priority)) throw new Error(`priority must be one of ${PRIORITIES.join(", ")}`);
  const filename = normalizePlanFilename(slug);
  const plansExisted = fs.existsSync(path.join(workingDir, "plans"));
  const plansDir = plansDirectory(workingDir, { create: true });
  const absolutePath = path.join(plansDir, filename);
  const relativeFile = path.join("plans", filename);
  const content = [
    "---",
    `title: '${normalizedTitle.replace(/'/g, "''")}'`,
    "state: open",
    `priority: ${priority}`,
    `created_at: ${localDate(now)}`,
    "agent_sessions: []",
    "---",
    "",
    "## Goal",
    "",
    "Describe the desired outcome.",
    "",
    "## Steps",
    "",
    "- [ ] Define the first concrete step.",
    "",
  ].join("\n");
  const parsed = parsePlan(content, { projectId: "local", relativeFile });
  if (!parsed.valid || parsed.diagnostics.length) throw new Error("Generated plan did not pass canonical validation");
  const temporaryPath = path.join(plansDir, `.${filename}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporaryPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o644);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    try { fs.linkSync(temporaryPath, absolutePath); }
    catch (error) { if (error && error.code === "EEXIST") throw new Error(`Plan already exists: ${relativeFile}`); throw error; }
    fs.unlinkSync(temporaryPath);
    syncDirectory(plansDir);
    if (!plansExisted) syncDirectory(workingDir);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporaryPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { workingDir, file: relativeFile, absolutePath, title: normalizedTitle, priority, createdAt: parsed.plan.createdAt };
}
function resolveValidationFiles(planPath, workingDir) {
  const plansDir = plansDirectory(workingDir);
  if (!planPath) return fs.readdirSync(plansDir, { withFileTypes: true }).filter((entry) => entry.name.endsWith(".md")).map((entry) => path.join(plansDir, entry.name)).sort();
  const resolved = path.isAbsolute(planPath) ? path.resolve(planPath) : path.resolve(workingDir, planPath);
  if (path.dirname(resolved) !== plansDir || path.extname(resolved) !== ".md") throw new Error("validate path must name a Markdown file directly under plans/");
  return [resolved];
}
function validatePlans(planPath, workingDir) {
  const files = resolveValidationFiles(planPath, workingDir);
  const plans = files.map((absolutePath) => {
    const relativeFile = path.join("plans", path.basename(absolutePath));
    const directory = path.dirname(absolutePath); const directoryStat = fs.lstatSync(directory);
    let content;
    try {
      const buffer = safeReadFile(absolutePath, LIMITS.planBytes, { requireOwned: false, directoryGuards: [{ path: directory, dev: directoryStat.dev, ino: directoryStat.ino }] }).buffer;
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    }
    catch (error) { const code = error.code === "PLANROCK_FILE_TOO_LARGE" ? "PLAN_FILE_TOO_LARGE" : "PLAN_FILE_INVALID"; return { file: relativeFile, valid: false, diagnostics: [{ code, severity: "error", message: error.message, relativeFile }] }; }
    const parsed = parsePlan(content, { projectId: "local", relativeFile }, { strictFields: true });
    return { file: relativeFile, valid: parsed.valid && parsed.diagnostics.length === 0, diagnostics: parsed.diagnostics };
  });
  const diagnostics = plans.flatMap((plan) => plan.diagnostics);
  return { workingDir, valid: diagnostics.length === 0, summary: { plans: plans.length, clean: plans.filter((plan) => plan.valid).length, warnings: diagnostics.filter((item) => item.severity === "warning").length, errors: diagnostics.filter((item) => item.severity === "error").length }, plans, diagnostics };
}

function escapedControl(character) { const code = character.charCodeAt(0); return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`; }
function escapeTerminalControls(value) { return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, escapedControl); }
function escapeMultilineTerminalText(value) {
  return String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, escapedControl);
}
function readPlans(plansDir, sort = "priority") {
  if (!fs.existsSync(plansDir)) throw new Error(`Warning: no plans/ directory found in the current working directory. Expected saved plans under: ${plansDir}`);
  const filenames = fs.readdirSync(plansDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name).sort();
  const openPlans = []; const closedPlans = []; const invalidPlans = [];
  for (const filename of filenames) {
    const content = fs.readFileSync(path.join(plansDir, filename), "utf8");
    const parsed = parseFrontmatter(content, { typed: true, compatibility: true });
    const frontmatter = parsed.values;
    const checklist = countChecklistItems(content);
    const plan = { file: path.join("plans", filename), title: typeof frontmatter.title === "string" && frontmatter.title ? frontmatter.title : filename, state: typeof frontmatter.state === "string" ? frontmatter.state : "", priority: PRIORITIES.includes(frontmatter.priority) ? frontmatter.priority : "P2", createdAt: typeof frontmatter.created_at === "string" ? frontmatter.created_at : "", closedAt: typeof frontmatter.closed_at === "string" ? frontmatter.closed_at : "", agentSessions: normalizeAgentSessions(frontmatter, []), checklistDone: checklist.done, checklistTotal: checklist.total, completionPercent: checklist.percent };
    if (parsed.parseError || !["open", "closed"].includes(plan.state)) {
      invalidPlans.push({ file: plan.file, title: plan.title, state: plan.state, reason: parsed.parseError || "state must be exactly open or closed" });
      continue;
    }
    plan.workflow = workflowState(plan);
    if (plan.state === "open") openPlans.push(plan); else closedPlans.push(plan);
  }
  openPlans.sort((a, b) => sort === "time" ? b.createdAt.localeCompare(a.createdAt) : PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || b.createdAt.localeCompare(a.createdAt));
  closedPlans.sort((a, b) => b.closedAt.localeCompare(a.closedAt));
  const pendingPlans = openPlans.filter((plan) => plan.workflow === "pending");
  const activePlans = openPlans.filter((plan) => plan.workflow === "active");
  return { openPlans, pendingPlans, activePlans, closedPlans, invalidPlans };
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
  const { openPlans, pendingPlans, activePlans, closedPlans, invalidPlans } = readPlans(path.join(workingDir, "plans"), sort);
  if (json) {
    if (command === "open") console.log(JSON.stringify({ workingDir, openPlans }, null, 2));
    else if (command === "pending") console.log(JSON.stringify({ workingDir, pendingPlans }, null, 2));
    else if (command === "active") console.log(JSON.stringify({ workingDir, activePlans }, null, 2));
    else if (command === "closed") console.log(JSON.stringify({ workingDir, closedPlans }, null, 2));
    else console.log(JSON.stringify({ workingDir, summary: { open: openPlans.length, pending: pendingPlans.length, active: activePlans.length, closed: closedPlans.length, invalid: invalidPlans.length }, recentOpenPlans: openPlans.slice(0, STATUS_LIMIT), recentPendingPlans: pendingPlans.slice(0, STATUS_LIMIT), recentActivePlans: activePlans.slice(0, STATUS_LIMIT), recentClosedPlans: closedPlans.slice(0, STATUS_LIMIT), invalidPlans }, null, 2));
    return;
  }
  console.log(`Working dir: ${escapeTerminalControls(workingDir)}`);
  if (command === "open") { console.log("Open Plans"); printTable(openPlans, columns(fullAgentSession)); return; }
  if (command === "pending") { console.log(`Pending Plans (${pendingPlans.length})`); printTable(pendingPlans, columns(fullAgentSession)); return; }
  if (command === "active") { console.log(`Active Plans (${activePlans.length})`); printTable(activePlans, columns(fullAgentSession)); return; }
  if (command === "closed") { console.log("Closed Plans"); printTable(closedPlans, [{ label: "Closed", value: (plan) => plan.closedAt }, { label: "Created", value: (plan) => plan.createdAt }, { label: "Title", value: (plan) => plan.title }]); return; }
  console.log("Planrock Status"); console.log(`Open:    ${openPlans.length}`); console.log(`Pending: ${pendingPlans.length}`); console.log(`Active:  ${activePlans.length}`); console.log(`Closed:  ${closedPlans.length}`); console.log(`Invalid: ${invalidPlans.length}`); console.log(""); console.log(`Pending Plans (top ${STATUS_LIMIT})`); printTable(pendingPlans.slice(0, STATUS_LIMIT), columns(fullAgentSession)); console.log(""); console.log(`Active Plans (top ${STATUS_LIMIT})`); printTable(activePlans.slice(0, STATUS_LIMIT), columns(fullAgentSession)); console.log(""); console.log(`Most Recent Closed Plans (top ${STATUS_LIMIT})`); printTable(closedPlans.slice(0, STATUS_LIMIT), [{ label: "Closed", value: (plan) => plan.closedAt }, { label: "Created", value: (plan) => plan.createdAt }, { label: "Title", value: (plan) => plan.title }]);
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

module.exports = { createPlan, escapeMultilineTerminalText, escapeTerminalControls, readPlans, runGoal, runLocal, validatePlans };
