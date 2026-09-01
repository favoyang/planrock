import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Badge,
  Button,
  Container,
  createTheme,
  Divider,
  Drawer,
  Group,
  MantineProvider,
  Paper,
  Progress,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from "@mantine/core";
import "@mantine/core/styles.css";
import packageJson from "../../package.json";
import { fetchAllPages } from "./pagination";
import "./styles.css";

const theme = createTheme({
  primaryColor: "teal",
  defaultRadius: "md",
  fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  headings: { fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
});

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers } });
  if (!response.ok) throw new Error(`Planrock API returned ${response.status}`);
  return response.json();
}

export async function copyText(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand?.("copy") === true;
  textarea.remove();
  if (!copied) throw new Error("Copy is unavailable in this browser");
}

export function workflowState(plan) {
  if (plan.state === "closed") return "closed";
  return plan.checklistDone > 0 || (plan.agentSessions?.length || 0) > 0 ? "active" : "pending";
}

export function filterPlans(plans, { lifecycle, workflow, project, query }) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return plans.filter((plan) => plan.state === lifecycle).filter((plan) => lifecycle === "closed" || workflow === "all" || workflowState(plan) === workflow).filter((plan) => !project || plan.projectId === project).filter((plan) => `${plan.title} ${plan.projectName} ${plan.relativeFile}`.toLocaleLowerCase().includes(normalizedQuery));
}

function parseTimestamp(value) {
  if (!value) return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

export function formatRelativeDate(value, now = new Date()) {
  const date = parseTimestamp(value);
  if (!date) return value || "No date";
  const seconds = (date.valueOf() - now.valueOf()) / 1000;
  const units = [["year", 31_536_000], ["month", 2_592_000], ["day", 86_400], ["hour", 3_600], ["minute", 60], ["second", 1]];
  const [, divisor] = units.find(([, size]) => Math.abs(seconds) >= size) || units.at(-1);
  const unit = units.find(([, size]) => size === divisor)[0];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "always" }).format(Math.round(seconds / divisor), unit);
}

function formatFullDate(value) {
  const date = parseTimestamp(value);
  if (!date) return value || "No date";
  return new Intl.DateTimeFormat(undefined, /^\d{4}-\d{2}-\d{2}$/.test(value) ? { dateStyle: "long" } : { dateStyle: "medium", timeStyle: "medium" }).format(date);
}

function RelativeTime({ label, value, className = "" }) {
  const [expanded, setExpanded] = useState(false);
  if (!value) return null;
  const full = formatFullDate(value);
  return <UnstyledButton className={`relative-time ${className}`.trim()} data-expanded={expanded || undefined} title={full} aria-label={`${label}: ${expanded ? "show relative time" : "show full timestamp"}`} onClick={() => setExpanded((current) => !current)}><Text className="time-label">{label}</Text><Text className="time-value" size="sm" fw={550}><time dateTime={value}>{expanded ? full : formatRelativeDate(value)}</time></Text></UnstyledButton>;
}

function webHref(value) {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}

function planSourceHref(plan) {
  return `/api/plan?id=${encodeURIComponent(plan.id)}`;
}

function normalizePlanPath(value) { return String(value).replace(/\\/g, "/"); }

export function resolvePlanPath(value, basePath) {
  const target = normalizePlanPath(value).split(/[?#]/, 1)[0]; const base = normalizePlanPath(basePath);
  const targetDrive = target.match(/^[a-z]:\//i)?.[0].slice(0, 2); const baseDrive = base.match(/^[a-z]:\//i)?.[0].slice(0, 2);
  const absolute = target.startsWith("/") || Boolean(targetDrive); const root = targetDrive ? `${targetDrive}/` : absolute ? "/" : baseDrive ? `${baseDrive}/` : "/";
  const stripRoot = (pathValue, drive) => pathValue.slice(drive ? 3 : pathValue.startsWith("/") ? 1 : 0);
  const parts = absolute ? [] : stripRoot(base, baseDrive).split("/").slice(0, -1);
  for (const part of stripRoot(target, targetDrive).split("/")) { if (!part || part === ".") continue; if (part === "..") parts.pop(); else parts.push(part); }
  return `${root}${parts.join("/")}`;
}

function markdownTarget(value, basePath, plansByPath) {
  const remote = webHref(value);
  if (remote) return { href: remote, plan: null };
  if (!basePath || /^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  const target = plansByPath.get(resolvePlanPath(value, basePath));
  return target ? { href: planSourceHref(target), plan: target } : null;
}

function renderInlineMarkdown(value, context, keyPrefix) {
  const nodes = []; let text = ""; let cursor = 0;
  const flush = () => { if (text) { nodes.push(text); text = ""; } };
  while (cursor < value.length) {
    if (value[cursor] === "\\" && cursor + 1 < value.length) { text += value[cursor + 1]; cursor += 2; continue; }
    if (value[cursor] === "`") { const end = value.indexOf("`", cursor + 1); if (end !== -1) { flush(); nodes.push(<code key={`${keyPrefix}-code-${cursor}`}>{value.slice(cursor + 1, end)}</code>); cursor = end + 1; continue; } }
    if (value.startsWith("**", cursor)) { const end = value.indexOf("**", cursor + 2); if (end !== -1) { flush(); nodes.push(<strong key={`${keyPrefix}-strong-${cursor}`}>{renderInlineMarkdown(value.slice(cursor + 2, end), context, `${keyPrefix}-strong-${cursor}`)}</strong>); cursor = end + 2; continue; } }
    if (value[cursor] === "*") { const end = value.indexOf("*", cursor + 1); if (end !== -1) { flush(); nodes.push(<em key={`${keyPrefix}-em-${cursor}`}>{renderInlineMarkdown(value.slice(cursor + 1, end), context, `${keyPrefix}-em-${cursor}`)}</em>); cursor = end + 1; continue; } }
    if (value[cursor] === "[") { const labelEnd = value.indexOf("](", cursor + 1); const targetEnd = labelEnd === -1 ? -1 : value.indexOf(")", labelEnd + 2); if (targetEnd !== -1) { flush(); const label = renderInlineMarkdown(value.slice(cursor + 1, labelEnd), context, `${keyPrefix}-link-${cursor}`); const target = markdownTarget(value.slice(labelEnd + 2, targetEnd), context.basePath, context.plansByPath); nodes.push(target?.plan ? <button key={`${keyPrefix}-link-${cursor}`} type="button" className="markdown-link" onClick={(event) => context.onOpenPlan(event, target.plan)}>{label}</button> : target ? <a key={`${keyPrefix}-link-${cursor}`} href={target.href} target="_blank" rel="noreferrer">{label}</a> : <React.Fragment key={`${keyPrefix}-link-${cursor}`}>{label}</React.Fragment>); cursor = targetEnd + 1; continue; } }
    text += value[cursor]; cursor += 1;
  }
  flush(); return nodes;
}

function MarkdownText({ children, className, basePath, plansByPath, onOpenPlan }) {
  const lines = String(children || "").split("\n"); const blocks = []; const context = { basePath, plansByPath, onOpenPlan }; let index = 0;
  const blockStart = (line) => !line.trim() || /^\s*(?:[-*+] |\d+\. |#{1,4} |```)/.test(line);
  while (index < lines.length) {
    if (!lines[index].trim()) { index += 1; continue; }
    if (lines[index].trim().startsWith("```")) { const language = lines[index].trim().slice(3); const code = []; index += 1; while (index < lines.length && !lines[index].trim().startsWith("```")) { code.push(lines[index]); index += 1; } index += 1; blocks.push(<pre key={`code-${index}`}><code data-language={language || undefined}>{code.join("\n")}</code></pre>); continue; }
    const unordered = lines[index].match(/^\s*[-*+]\s+(.+)/); const ordered = lines[index].match(/^\s*\d+\.\s+(.+)/);
    if (unordered || ordered) { const items = []; const pattern = unordered ? /^\s*[-*+]\s+(.+)/ : /^\s*\d+\.\s+(.+)/; while (index < lines.length) { const match = lines[index].match(pattern); if (!match) break; items.push(<li key={`${index}`}>{renderInlineMarkdown(match[1], context, `item-${index}`)}</li>); index += 1; } const List = unordered ? "ul" : "ol"; blocks.push(<List key={`list-${index}`}>{items}</List>); continue; }
    const heading = lines[index].match(/^(#{1,4})\s+(.+)/); if (heading) { const Heading = `h${Math.min(heading[1].length + 2, 6)}`; blocks.push(<Heading key={`heading-${index}`}>{renderInlineMarkdown(heading[2], context, `heading-${index}`)}</Heading>); index += 1; continue; }
    const paragraph = [lines[index].trim()]; index += 1; while (index < lines.length && !blockStart(lines[index])) { paragraph.push(lines[index].trim()); index += 1; } blocks.push(<p key={`paragraph-${index}`}>{renderInlineMarkdown(paragraph.join(" "), context, `paragraph-${index}`)}</p>);
  }
  return <div className={className}>{blocks}</div>;
}

function sessionHref(session) {
  const [agent, ...parts] = String(session).split(":");
  return agent === "codex" && parts.length ? `codex://threads/${encodeURIComponent(parts.join(":"))}` : null;
}

function completion(plan) {
  if (!plan.checklistTotal) return 0;
  return Math.round((plan.checklistDone / plan.checklistTotal) * 100);
}

function PlanRow({ plan, onSelect }) {
  const workflow = workflowState(plan);
  const percent = completion(plan);
  const timestamp = workflow === "closed" ? { label: "Closed", value: plan.closedAt || plan.updatedAt || plan.createdAt } : workflow === "active" ? { label: "Active", value: plan.updatedAt || plan.createdAt } : { label: "Pending", value: plan.createdAt || plan.updatedAt };
  return <Paper className="plan-row" withBorder>
    <UnstyledButton className="plan-row-button" onClick={(event) => onSelect(plan, event.currentTarget)} aria-label={`Open ${plan.title}`}>
      <div className="plan-identity">
        <Group className="plan-title-line" gap={8} wrap="nowrap"><Badge className={`priority ${plan.priority}`} variant="light">{plan.priority}</Badge><Text component="h3" fw={650}>{plan.title}</Text><Badge className={`workflow ${workflow}`} variant="light">{workflow === "active" ? "Active" : workflow === "pending" ? "Pending" : "Closed"}</Badge></Group>
        <Text size="sm" c="dimmed">{plan.projectName} · {plan.relativeFile}</Text>
      </div>
      <div className="plan-progress">
        <Group justify="space-between" gap={8}><Text size="xs" fw={600}>Progress</Text><Text size="xs" c="dimmed">{plan.checklistDone}/{plan.checklistTotal} · {percent}%</Text></Group>
        <Progress value={percent} size="sm" radius="xl" aria-label={`${percent}% complete`} />
      </div>
      <span className="plan-date-space" aria-hidden="true" />
    </UnstyledButton>
    <RelativeTime className="plan-date" label={timestamp.label} value={timestamp.value} />
  </Paper>;
}

function PlanList({ plans, onSelect }) {
  const headingId = useId();
  return <section aria-labelledby={headingId}>
    <Text id={headingId} className="section-kicker" component="h2" mb="sm">Plans - {plans.length} matching</Text>
    <Stack gap="sm">{plans.map((plan) => <PlanRow key={plan.id} plan={plan} onSelect={onSelect} />)}{plans.length === 0 && <Paper className="empty-state" withBorder><Title order={3}>No matching plans</Title><Text c="dimmed">Adjust the state, project, or search filters.</Text></Paper>}</Stack>
  </section>;
}

function PlanDrawer({ plan, plans, onClose }) {
  const percent = completion(plan);
  const workflow = workflowState(plan);
  const plansByPath = useMemo(() => new Map(plans.map((item) => [normalizePlanPath(item.absolutePath), item])), [plans]);
  const [copyStatus, setCopyStatus] = useState("");
  const [sourcePlan, setSourcePlan] = useState(null);
  const [sourceText, setSourceText] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [sourceLoading, setSourceLoading] = useState(false);
  async function copy(label, value) {
    try { await copyText(value); setCopyStatus(`${label} copied`); }
    catch { setCopyStatus("Copy failed — select the text above and copy it manually"); }
  }
  async function openPlanSource(event, target) {
    event.preventDefault(); setSourcePlan(target); setSourceText(""); setSourceError(""); setSourceLoading(true);
    try { const response = await fetch(planSourceHref(target)); if (!response.ok) throw new Error(`Plan source returned ${response.status}`); setSourceText(await response.text()); }
    catch (reason) { setSourceError(reason.message); }
    finally { setSourceLoading(false); }
  }
  return <Drawer opened onClose={onClose} title="Plan details" position="right" size="lg">
    <Stack gap="md">
      <div><Group gap="xs"><Badge className={`priority ${plan.priority}`} variant="light">{plan.priority}</Badge><Badge className={`workflow ${workflow}`} variant="light">{workflow === "active" ? "Active" : workflow === "pending" ? "Pending" : "Closed"}</Badge></Group><Title className="detail-title" order={2} mt="xs">{plan.title}</Title><Text size="sm" c="dimmed">{plan.projectName}</Text></div>
      <div><Group justify="space-between"><Text size="sm" fw={600}>Progress</Text><Text size="sm">{plan.checklistDone}/{plan.checklistTotal} · {percent}%</Text></Group><Progress value={percent} mt="xs" /></div>
      <Divider />
      <Group className="detail-times" align="flex-start"><RelativeTime label="Created" value={plan.createdAt} /><RelativeTime label="Updated" value={plan.updatedAt} />{plan.state === "closed" && <RelativeTime label="Closed" value={plan.closedAt} />}</Group>
      <div><Text className="detail-label">Goal</Text><MarkdownText className="goal-excerpt" basePath={plan.absolutePath} plansByPath={plansByPath} onOpenPlan={openPlanSource}>{plan.goalExcerpt || "No goal excerpt."}</MarkdownText></div>
      <div><Text className="detail-label">Plan path</Text><UnstyledButton className="path-text detail-link" onClick={(event) => openPlanSource(event, plan)} title="Show plan source">{plan.absolutePath}</UnstyledButton></div>
      {sourcePlan && <Paper className="plan-source" withBorder p="sm" aria-live="polite"><Group justify="space-between" gap="sm" wrap="nowrap"><Text size="sm" fw={650} truncate>{sourcePlan.relativeFile}</Text><Button size="compact-xs" variant="subtle" onClick={() => setSourcePlan(null)}>Hide source</Button></Group>{sourceLoading && <Text size="sm" c="dimmed">Loading source…</Text>}{sourceError && <Text role="alert" size="sm" c="red">{sourceError}</Text>}{sourceText && <pre><code>{sourceText}</code></pre>}</Paper>}
      {plan.agentSessions?.length > 0 && <div><Text className="detail-label">Agent sessions</Text><Stack gap={4}>{plan.agentSessions.map((session) => { const href = sessionHref(session); return href ? <Text component="a" key={session} size="sm" className="path-text detail-link" href={href} title="Open Codex task">{session}</Text> : <Text key={session} size="sm" className="path-text">{session}</Text>; })}</Stack></div>}
      {plan.relatedLinks?.length > 0 && <div><Text className="detail-label">Related links</Text><Stack gap={6}>{plan.relatedLinks.map((link) => <Text component="a" size="sm" key={link} href={link} target="_blank" rel="noreferrer">{link}</Text>)}</Stack></div>}
      <Group grow><Button variant="default" onClick={() => copy("Goal command", `/goal\n${plan.goalExcerpt || ""}\n\nUse plan reference: ${plan.absolutePath}.`)}>Copy goal command</Button><Button variant="default" onClick={() => copy("Path", plan.absolutePath)}>Copy path</Button></Group>
      <Text role="status" size="sm" c={copyStatus.startsWith("Copy failed") ? "red" : "dimmed"}>{copyStatus}</Text>
    </Stack>
  </Drawer>;
}

function HealthDrawer({ overview, onClose, displayState }) {
  const state = displayState || overview.health?.state || (overview.incomplete ? "degraded" : "healthy");
  return <Drawer opened onClose={onClose} title="Registry and health" position="right" size="lg"><Stack><div><Text className="detail-label">Current state</Text><Title order={2}>{state}</Title></div><Group><Badge variant="light">{overview.summary.invalid} invalid</Badge><Badge variant="light">{overview.diagnostics.length} diagnostics shown</Badge></Group><Divider />{overview.diagnostics.length ? <Stack gap="sm">{overview.diagnostics.map((item, index) => <Paper key={`${item.code}-${index}`} withBorder p="md"><Text fw={650}>{item.code}</Text><Text size="sm" c="dimmed">{item.message}</Text></Paper>)}</Stack> : <Text c="dimmed">No registry or scan warnings.</Text>}</Stack></Drawer>;
}

export function App() {
  const [overview, setOverview] = useState(null);
  const [allPlans, setAllPlans] = useState([]);
  const [repositories, setRepositories] = useState([]);
  const [query, setQuery] = useState("");
  const [lifecycle, setLifecycle] = useState("open");
  const [workflow, setWorkflow] = useState("all");
  const [project, setProject] = useState(null);
  const [onlyOpenProjects, setOnlyOpenProjects] = useState(true);
  const [selected, setSelected] = useState(null);
  const [healthOpen, setHealthOpen] = useState(false);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const overlayTrigger = useRef(null);

  async function load() {
    const next = await api("/api/overview");
    setOverview(next);
    const fetchPage = (collection, cursor, limit) => api(`/api/collection?name=${encodeURIComponent(collection)}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    const [open, closed, projects] = await Promise.all([fetchAllPages(fetchPage, "openPlans"), fetchAllPages(fetchPage, "closedPlans"), fetchAllPages(fetchPage, "repositories")]);
    setAllPlans([...open, ...closed]);
    setRepositories(projects);
  }

  useEffect(() => { load().catch((reason) => setError(reason.message)); }, []);

  const counts = useMemo(() => {
    const result = { open: 0, pending: 0, active: 0, closed: 0 };
    for (const plan of allPlans) { const state = workflowState(plan); if (state === "closed") result.closed += 1; else { result.open += 1; result[state] += 1; } }
    return result;
  }, [allPlans]);

  const projectOptions = useMemo(() => repositories.filter((repository) => !onlyOpenProjects || repository.counts.open > 0).map((repository) => ({ value: repository.id, label: repository.displayName, openCount: repository.counts.open })), [repositories, onlyOpenProjects]);
  useEffect(() => { if (project && !projectOptions.some((option) => option.value === project)) setProject(null); }, [project, projectOptions]);

  const filtered = useMemo(() => filterPlans(allPlans, { lifecycle, workflow, project, query }), [allPlans, lifecycle, workflow, project, query]);

  async function refresh() { try { setRefreshing(true); setRefreshFailed(false); setError(""); await api("/api/refresh", { method: "POST", body: "{}" }); await load(); } catch (reason) { setRefreshFailed(true); setError(reason.message); } finally { setRefreshing(false); } }
  function restoreOverlayFocus() { requestAnimationFrame(() => overlayTrigger.current?.focus()); }
  function closePlan() { setSelected(null); restoreOverlayFocus(); }
  function closeHealth() { setHealthOpen(false); restoreOverlayFocus(); }
  const healthState = refreshing ? "loading" : refreshFailed ? "stale" : overview ? (overview.health?.state || (overview.incomplete ? "degraded" : "healthy")) : "loading";
  const healthColor = healthState === "healthy" ? "teal" : healthState === "loading" ? "gray" : "orange";

  return <MantineProvider theme={theme} defaultColorScheme="auto">
    <div className="page-shell">
      <header className="dashboard-navbar"><Container size="xl" pt={{ base: "lg", sm: 36 }}><div className="dashboard-header"><div><Group gap="xs"><Text className="brand-mark">PLANROCK</Text><Text size="xs" c="dimmed">v{packageJson.version}</Text></Group><Title order={1}>Dashboard</Title></div><Group className="header-actions" gap="sm" align="flex-start"><Button className={`health-button ${healthState}`} variant="subtle" color={healthColor} disabled={!overview} onClick={(event) => { overlayTrigger.current = event.currentTarget; setHealthOpen(true); }}><span className="health-dot" aria-hidden="true" />{healthState}</Button><div className="refresh-control"><Button variant="default" loading={refreshing} onClick={refresh}>Refresh</Button>{overview && <Text size="xs" c="dimmed">Last refreshed<br />{new Date(overview.refreshedAt).toLocaleString()}</Text>}</div></Group></div></Container></header>
      <Container size="xl" pt="xs" pb={{ base: "lg", sm: 36 }}>
      {error && <Paper role="alert" className="alert" withBorder>{error}</Paper>}
      {overview && <Stack gap="lg">
        <Paper className="filter-panel" withBorder>
          <div className="filter-top-grid">
            <div className="filter-field project-field"><Group className="filter-heading" justify="space-between" gap="sm"><Text className="filter-label">Project</Text><Text className="filter-count" size="xs" c="dimmed">{projectOptions.length} of {repositories.length}</Text></Group><Select aria-label="Project" placeholder="All projects" clearable searchable value={project} onChange={setProject} data={projectOptions} nothingFoundMessage="No projects" renderOption={({ option }) => <Group className="project-option" justify="space-between" gap="md" wrap="nowrap" w="100%"><Text className="project-option-name" size="sm" truncate>{option.label}</Text><Text className="project-option-count" size="xs">{option.openCount} open</Text></Group>} /></div>
            <div className="filter-field search-field"><div className="filter-heading"><Text className="filter-label">Search</Text></div><TextInput aria-label="Search plans" placeholder="Title, project, or path" value={query} onChange={(event) => setQuery(event.currentTarget.value)} /></div>
            <div className="project-toggle-row"><Switch label="Only projects with open plans" checked={onlyOpenProjects} onChange={(event) => setOnlyOpenProjects(event.currentTarget.checked)} /></div>
          </div>
          <Divider my="md" />
          <div className="state-grid"><div><div className="filter-heading"><Text className="filter-label">State</Text></div><div className="segmented-scroll"><SegmentedControl aria-label="Plan lifecycle" fullWidth value={lifecycle} onChange={setLifecycle} data={[{ value: "open", label: `Open ${counts.open}` }, { value: "closed", label: `Closed ${counts.closed}` }]} /></div></div>{lifecycle === "open" && <div><div className="filter-heading"><Text className="filter-label">Progress</Text></div><div className="segmented-scroll"><SegmentedControl aria-label="Plan progress" fullWidth value={workflow} onChange={setWorkflow} data={[{ value: "all", label: `All ${counts.open}` }, { value: "pending", label: `Pending ${counts.pending}` }, { value: "active", label: `Active ${counts.active}` }]} /></div></div>}</div>
        </Paper>
        <PlanList plans={filtered} onSelect={(plan, trigger) => { overlayTrigger.current = trigger; setSelected(plan); }} />
      </Stack>}
      {selected && <PlanDrawer plan={selected} plans={allPlans} onClose={closePlan} />}
      {healthOpen && overview && <HealthDrawer overview={overview} displayState={healthState} onClose={closeHealth} />}
      </Container>
    </div>
  </MantineProvider>;
}

if (document.getElementById("root")) createRoot(document.getElementById("root")).render(<App />);
