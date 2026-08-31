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
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from "@mantine/core";
import "@mantine/core/styles.css";
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

function formatDate(value) {
  if (!value) return "No date";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function completion(plan) {
  if (!plan.checklistTotal) return 0;
  return Math.round((plan.checklistDone / plan.checklistTotal) * 100);
}

function PlanRow({ plan, onSelect }) {
  const workflow = workflowState(plan);
  const percent = completion(plan);
  const date = plan.state === "closed" ? plan.closedAt || plan.createdAt : plan.createdAt;
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
      <div className="plan-date"><Text size="xs" tt="uppercase" c="dimmed">{plan.state === "closed" ? "Closed" : "Created"}</Text><Text size="sm" fw={550}>{formatDate(date)}</Text></div>
    </UnstyledButton>
  </Paper>;
}

function PlanList({ plans, onSelect }) {
  const headingId = useId();
  return <section aria-labelledby={headingId}>
    <Text id={headingId} className="section-kicker" component="h2" mb="sm">Plans - {plans.length} matching</Text>
    <Stack gap="sm">{plans.map((plan) => <PlanRow key={plan.id} plan={plan} onSelect={onSelect} />)}{plans.length === 0 && <Paper className="empty-state" withBorder><Title order={3}>No matching plans</Title><Text c="dimmed">Adjust the state, project, or search filters.</Text></Paper>}</Stack>
  </section>;
}

function PlanDrawer({ plan, onClose }) {
  const percent = completion(plan);
  const workflow = workflowState(plan);
  const [copyStatus, setCopyStatus] = useState("");
  async function copy(label, value) {
    try { await copyText(value); setCopyStatus(`${label} copied`); }
    catch { setCopyStatus("Copy failed — select the text above and copy it manually"); }
  }
  return <Drawer opened onClose={onClose} title="Plan details" position="right" size="lg">
    <Stack gap="lg">
      <div><Group gap="xs"><Badge className={`priority ${plan.priority}`} variant="light">{plan.priority}</Badge><Badge className={`workflow ${workflow}`} variant="light">{workflow === "active" ? "Active" : workflow === "pending" ? "Pending" : "Closed"}</Badge></Group><Title order={2} mt="sm">{plan.title}</Title><Text c="dimmed">{plan.projectName}</Text></div>
      <div><Group justify="space-between"><Text fw={600}>Progress</Text><Text>{plan.checklistDone}/{plan.checklistTotal} · {percent}%</Text></Group><Progress value={percent} mt="xs" /></div>
      <Divider />
      <div><Text className="detail-label">Goal</Text><Text className="goal-excerpt">{plan.goalExcerpt || "No Goal excerpt."}</Text></div>
      <div><Text className="detail-label">Plan path</Text><Text className="path-text">{plan.absolutePath}</Text></div>
      {plan.agentSessions?.length > 0 && <div><Text className="detail-label">Agent sessions</Text><Stack gap={4}>{plan.agentSessions.map((session) => <Text key={session} size="sm" className="path-text">{session}</Text>)}</Stack></div>}
      {plan.relatedLinks?.length > 0 && <div><Text className="detail-label">Related links</Text><Stack gap={6}>{plan.relatedLinks.map((link) => <a key={link} href={link} target="_blank" rel="noreferrer">{link}</a>)}</Stack></div>}
      <Group grow><Button variant="default" onClick={() => copy("Goal command", `/goal\n${plan.goalExcerpt || ""}\n\nUse plan reference: ${plan.absolutePath}.`)}>Copy goal command</Button><Button variant="default" onClick={() => copy("Path", plan.absolutePath)}>Copy path</Button></Group>
      <Text role="status" size="sm" c={copyStatus.startsWith("Copy failed") ? "red" : "dimmed"}>{copyStatus}</Text>
    </Stack>
  </Drawer>;
}

function HealthDrawer({ overview, onClose }) {
  const state = overview.health?.state || (overview.incomplete ? "degraded" : "healthy");
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

  async function refresh() { try { setRefreshing(true); setError(""); await api("/api/refresh", { method: "POST", body: "{}" }); await load(); } catch (reason) { setError(reason.message); } finally { setRefreshing(false); } }
  function restoreOverlayFocus() { requestAnimationFrame(() => overlayTrigger.current?.focus()); }
  function closePlan() { setSelected(null); restoreOverlayFocus(); }
  function closeHealth() { setHealthOpen(false); restoreOverlayFocus(); }
  const healthState = overview ? (overview.health?.state || (overview.incomplete ? "degraded" : "healthy")) : "loading";
  const healthColor = healthState === "healthy" ? "teal" : healthState === "loading" ? "gray" : "orange";

  return <MantineProvider theme={theme} defaultColorScheme="auto">
    <div className="page-shell"><Container size="xl" py={{ base: "lg", sm: 36 }}>
      <header className="dashboard-header"><div><Group gap="xs"><Text className="brand-mark">PLANROCK</Text><Text size="xs" c="dimmed">Saved plans</Text></Group><Title order={1}>Dashboard</Title></div><Group gap="sm"><Button className={`health-button ${healthState}`} variant="subtle" color={healthColor} disabled={!overview} onClick={(event) => { overlayTrigger.current = event.currentTarget; setHealthOpen(true); }}><span className="health-dot" aria-hidden="true" />{healthState}</Button><Button variant="default" loading={refreshing} onClick={refresh}>Refresh</Button></Group></header>
      {error && <Paper role="alert" className="alert" withBorder>{error}</Paper>}
      {overview && <Stack gap="lg">
        <Paper className="filter-panel" withBorder>
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
            <TextInput label="Search" aria-label="Search plans" placeholder="Title, project, or path" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
            <Select label="Project" aria-label="Project" placeholder="All projects" clearable searchable value={project} onChange={setProject} data={projectOptions} nothingFoundMessage="No projects" renderOption={({ option }) => <Group className="project-option" justify="space-between" gap="md" wrap="nowrap" w="100%"><Text className="project-option-name" size="sm" truncate>{option.label}</Text><Text className="project-option-count" size="xs">{option.openCount} open</Text></Group>} />
            <div className="project-toggle"><Switch label="Only projects with open plans" checked={onlyOpenProjects} onChange={(event) => setOnlyOpenProjects(event.currentTarget.checked)} /><Text size="xs" c="dimmed">{projectOptions.length} of {repositories.length} projects shown</Text></div>
          </SimpleGrid>
          <Divider my="md" />
          <div className="state-grid"><div><Text className="filter-label">State</Text><div className="segmented-scroll"><SegmentedControl aria-label="Plan lifecycle" fullWidth value={lifecycle} onChange={setLifecycle} data={[{ value: "open", label: `Open ${counts.open}` }, { value: "closed", label: `Closed ${counts.closed}` }]} /></div></div>{lifecycle === "open" && <div><Text className="filter-label">Open workflow</Text><div className="segmented-scroll"><SegmentedControl aria-label="Open workflow" fullWidth value={workflow} onChange={setWorkflow} data={[{ value: "all", label: `All ${counts.open}` }, { value: "pending", label: `Pending ${counts.pending}` }, { value: "active", label: `Active ${counts.active}` }]} /></div></div>}<div className="refresh-meta"><Text size="xs" c="dimmed">Last refreshed</Text><Text size="sm" fw={550}>{new Date(overview.refreshedAt).toLocaleString()}</Text></div></div>
        </Paper>
        <PlanList plans={filtered} onSelect={(plan, trigger) => { overlayTrigger.current = trigger; setSelected(plan); }} />
      </Stack>}
      {selected && <PlanDrawer plan={selected} onClose={closePlan} />}
      {healthOpen && overview && <HealthDrawer overview={overview} onClose={closeHealth} />}
    </Container></div>
  </MantineProvider>;
}

if (document.getElementById("root")) createRoot(document.getElementById("root")).render(<App />);
