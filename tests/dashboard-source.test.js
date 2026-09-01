const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "dashboard", "src", "main.jsx"), "utf8");
const styles = fs.readFileSync(path.join(root, "dashboard", "src", "styles.css"), "utf8");
const packageJson = require(path.join(root, "package.json"));
const releaseConfig = require(path.join(root, ".releaserc.json"));
const { DEFAULT_PORT, STORAGE_DIR } = require("../lib/constants");

test("dashboard uses Mantine 9 with the accepted accessible information architecture", () => {
  assert.match(source, /from "@mantine\/core"/); assert.match(source, /<MantineProvider theme=\{theme\} defaultColorScheme="auto">/);
  for (const label of ["Search plans", "Project", "Open", "Closed", "Pending", "Active", "Only projects with open plans", "Registry and health", "Plan details", "Copy goal command"]) assert.match(source, new RegExp(label.replace(/[&]/g, "&")));
  assert.match(source, /aria-label="Plan lifecycle"/); assert.match(source, /aria-label="Plan progress"/);
  assert.match(source, /useId\(\)/); assert.match(source, /overview\.health\?\.state/);
  assert.match(source, /workflowState\(plan\)/);
  assert.match(source, /openCount: repository\.counts\.open/);
  assert.match(source, /className="project-option-name"/);
  assert.match(source, /className="project-option-count"/);
  assert.match(styles, /\.mantine-Select-options \.mantine-ScrollArea-content \{[^}]*min-width: 0;[^}]*width: 100%;/s);
  assert.match(styles, /\.project-option \{[^}]*min-width: 0;[^}]*max-width: 100%;[^}]*overflow: hidden;/s);
  assert.match(styles, /\.project-option-name \{[^}]*flex: 1 1 auto;[^}]*min-width: 0;/s);
  assert.match(styles, /\.project-option-count \{[^}]*flex: 0 0 auto;[^}]*color: inherit;[^}]*white-space: nowrap;/s);
  assert.match(styles, /\.health-dot \{[^}]*margin-inline-end: 0\.45rem;/s);
  assert.match(styles, /\.health-button\.healthy \.health-dot \{ background: var\(--mantine-color-teal-7\); \}/);
  assert.match(styles, /dark.*\.health-button\.healthy \.health-dot \{ background: var\(--mantine-color-teal-4\); \}/);
  assert.match(styles, /dark.*\.health-button:not\(\.healthy, \.loading\) \.health-dot \{ background: var\(--mantine-color-orange-4\); \}/);
  assert.match(styles, /\.plan-title-line h3 \{[^}]*flex: 1 1 auto;[^}]*min-width: 0;[^}]*text-overflow: ellipsis;/s);
  assert.match(styles, /\.detail-title \{ font-size: 1\.125rem; font-weight: 650; line-height: 1\.4; \}/);
  assert.match(source, /<MarkdownText className="plan-content" basePath=\{plan\.absolutePath\} plansByPath=\{plansByPath\} onOpenPlan=\{openPlanOverlay\} onOpenMarkdown=\{openMarkdownOverlay\}>/);
  assert.match(source, /function renderMarkdownList/);
  assert.match(source, /function renderMarkdownTable/);
  assert.match(styles, /\.refresh-control \{[^}]*justify-items: end;[^}]*font-variant-numeric: tabular-nums;/s);
  assert.match(source, /v\{packageJson\.version\}/); assert.doesNotMatch(source, /Saved plans/);
  assert.match(styles, /\.filter-top-grid \{[^}]*grid-template-areas: "project search" "toggle \.";[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s);
  assert.match(source, /className="filter-count"[^>]*>\{projectOptions\.length\} of \{repositories\.length\}/);
  assert.equal((source.match(/<SegmentedControl[^>]*size="xs"/g) || []).length, 2);
  assert.match(styles, /\.state-grid \.mantine-SegmentedControl-label \{ font-size: var\(--mantine-font-size-xs\); \}/);
  assert.doesNotMatch(styles, /\.state-grid \.mantine-SegmentedControl-label \{[^}]*padding/s);
  assert.match(styles, /\.plan-date\[data-expanded\] \{ position: static; display: block; width: 100%;/);
  assert.match(styles, /\.plan-row:has\(\.plan-date\[data-expanded\]\) \.plan-row-button \{ grid-template-columns: minmax\(260px, 1fr\) minmax\(180px, 250px\); \}/);
  assert.match(styles, /\.plan-row:has\(\.plan-date\[data-expanded\]\) \.plan-identity \{ padding-right: 0; \}/);
  assert.match(source, /className="refresh-control"/); assert.doesNotMatch(source, /refresh-meta/);
  assert.match(source, /const healthState = refreshing \? "loading" : refreshFailed \? "stale"/);
  assert.match(source, /className="dashboard-navbar"/);
  assert.match(styles, /\.dashboard-navbar \{ border-bottom: 1px solid var\(--mantine-color-gray-3\); \}/);
  assert.match(styles, /dark.*\.dashboard-navbar \{ border-bottom-color: var\(--mantine-color-dark-5\); \}/);
  assert.match(source, /plan\.checklistDone > 0 \|\| \(plan\.agentSessions\?\.length \|\| 0\) > 0/);
  assert.match(source, /api\/open-chat\?id=/);
  assert.match(source, /api\/open-plan\?id=/);
  assert.match(source, /nativeActionsAvailable=\{overview\?\.nativeActions === true\}/);
  assert.match(source, /available on the Planrock host machine only/);
  assert.match(source, /disabled=\{refreshing \|\| !refreshAvailable\}/);
  assert.match(source, /api\/markdown\?id=/);
  assert.match(source, /function MarkdownDrawer/);
  assert.match(source, />Go chat</);
  assert.doesNotMatch(source, />Copy path</);
  assert.match(source, /miw=\{112\} disabled=\{refreshing \|\| !refreshAvailable\} aria-busy=\{refreshing\}/);
  assert.doesNotMatch(source, /refresh-indicator/);
  assert.match(source, /Math\.max\(0, 800 - \(Date\.now\(\) - startedAt\)\)/);
  assert.match(styles, /\.refresh-button\.refreshing::after \{[^}]*animation: refresh-border-sweep 800ms linear infinite;/s);
  assert.match(styles, /\.detail-state-value \{[^}]*font-size: var\(--mantine-font-size-sm\);[^}]*font-weight: 550;[^}]*text-align: left;/s);
  assert.match(styles, /\.markdown-table-scroll \{[^}]*overflow-x: auto;/s);
  assert.doesNotMatch(source, /loading=\{refreshing\}/);
  assert.match(source, /<PlanProgress plan=\{plan\} className="detail-progress" \/>/);
  assert.match(styles, /\.detail-meta-value \{ font-size: var\(--mantine-font-size-xs\);/);
  assert.match(styles, /\.task-list-item \{[^}]*display: grid;[^}]*grid-template-columns: auto minmax\(0, 1fr\);/s);
  assert.match(source, /formatRelativeDate\(value\)/);
  assert.match(source, /Use plan reference: \$\{plan\.absolutePath\}/);
  assert.doesNotMatch(source, /Next up|summary-grid|removeBootstrapFragment/);
});

test("release commits version manifests and the version-dependent dashboard build", () => {
  const gitPlugin = releaseConfig.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === "@semantic-release/git");
  assert.deepEqual(gitPlugin[1].assets, ["package.json", "package-lock.json", "dist/dashboard/**"]);
});

test("Node 18 runtime job installs the tarball as a local path", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
  assert.match(workflow, /npm install --ignore-scripts --prefix \/tmp\/planrock-prefix \.\/packed\/\*\.tgz/);
});

test("priority badges define readable light and dark scheme pairs", () => {
  assert.match(styles, /\.priority\.P0 \{ color: #9f1239; background: #fff1f2; \}/);
  assert.match(styles, /dark.*\.priority\.P0 \{ color: #fff; background: #9f1239; \}/);
  assert.match(styles, /dark.*\.priority\.P1 \{ color: #fff; background: #9a3412; \}/);
});

test("dashboard presentation stays text-only and V1 contains no blocking surface", () => {
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML|markdown-to-html|blocked_reason|blocked_by|Blocked/);
  assert.doesNotMatch(source, /https?:\/\//);
});

test("package has no runtime dependency on build tooling or TaskChef", () => {
  assert.equal(packageJson.dependencies, undefined); assert.equal(JSON.stringify(packageJson).includes("taskchef"), false);
  assert.equal(packageJson.engines.node, ">=18");
});

test("global ownership stays fixed to ~/.agents/planrock with invocation-only port selection", () => {
  assert.equal(DEFAULT_PORT, 4210); assert.equal(STORAGE_DIR, path.join(os.homedir(), ".agents", "planrock"));
  const repositoryText = fs.readFileSync(path.join(root, "lib", "constants.js"), "utf8") + fs.readFileSync(path.join(root, "scripts", "planrock"), "utf8");
  assert.doesNotMatch(repositoryText, /PLANROCK_HOME|PLANROCK_PORT/);
});
