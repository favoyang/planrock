import React, { useEffect, useId, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Badge, Button, Divider, Drawer, MantineProvider, Paper, SimpleGrid, Stack, Text, TextInput, Title } from "@mantine/core";
import "@mantine/core/styles.css";
import { removeBootstrapFragment } from "./bootstrap";
import { fetchAllPages } from "./pagination";
import "./styles.css";

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers } });
  if (!response.ok) throw new Error(`Planrock API returned ${response.status}`);
  return response.json();
}

function Summary({ label, value }) {
  return <Paper className="summary" withBorder><Text size="sm" c="dimmed">{label}</Text><Text fw={700} size="xl">{value}</Text></Paper>;
}

function PlanList({ title, plans, onSelect }) {
  const headingId = useId();
  return <section aria-labelledby={headingId}><Title id={headingId} order={2}>{title}</Title><div className="plan-list">{plans.map((plan) => <button className="plan-row" key={plan.id} onClick={() => onSelect(plan)}><Badge className={`priority ${plan.priority}`} variant="light">{plan.priority}</Badge><span><strong>{plan.title}</strong><small>{plan.projectName} · {plan.checklistDone}/{plan.checklistTotal} · {plan.createdAt || "No date"}</small></span></button>)}{plans.length === 0 && <Text>No matching plans.</Text>}</div></section>;
}

function PlanDrawer({ plan, onClose }) {
  return <Drawer opened onClose={onClose} title="Plan details" position="right" size="md"><Stack><Title order={2}>{plan.title}</Title><Text>{plan.projectName} · {plan.priority}</Text><Divider /><Text>{plan.goalExcerpt || "No Goal excerpt."}</Text><Text>{plan.absolutePath}</Text><Text>Progress: {plan.checklistDone}/{plan.checklistTotal}</Text><Button variant="default" onClick={() => navigator.clipboard.writeText(`/goal\n${plan.goalExcerpt}\n\nUse plan reference: ${plan.absolutePath}.`)}>Copy goal command</Button><Button variant="default" onClick={() => navigator.clipboard.writeText(plan.absolutePath)}>Copy path</Button>{plan.relatedLinks?.map((link) => <a key={link} href={link} target="_blank" rel="noreferrer">{link}</a>)}</Stack></Drawer>;
}

export function App() {
  const [overview, setOverview] = useState(null); const [allPlans, setAllPlans] = useState([]); const [repositories, setRepositories] = useState([]); const [query, setQuery] = useState(""); const [view, setView] = useState("next"); const [project, setProject] = useState(""); const [selected, setSelected] = useState(null); const [error, setError] = useState("");
  async function load() { const next = await api("/api/overview"); setOverview(next); const fetchPage = (collection, cursor, limit) => api(`/api/collection?name=${encodeURIComponent(collection)}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`); const [open, closed, projects] = await Promise.all([fetchAllPages(fetchPage, "openPlans"), fetchAllPages(fetchPage, "closedPlans"), fetchAllPages(fetchPage, "repositories")]); setAllPlans([...open, ...closed]); setRepositories(projects); }
  useEffect(() => { const token = removeBootstrapFragment(); const bootstrap = token ? api("/api/bootstrap", { method: "POST", headers: { Authorization: `Bootstrap ${token}` }, body: "{}" }) : Promise.resolve(); bootstrap.then(load).catch((reason) => setError(reason.message)); }, []);
  const filtered = useMemo(() => (view === "next" ? (query || project ? allPlans.filter((plan) => plan.state === "open") : overview?.nextUp || []) : allPlans).filter((plan) => (view === "next" || plan.state === view) && (!project || plan.projectId === project) && `${plan.title} ${plan.projectName} ${plan.relativeFile}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [allPlans, overview, query, view, project]);
  async function refresh() { try { await api("/api/refresh", { method: "POST", body: "{}" }); await load(); } catch (reason) { setError(reason.message); } }
  return <MantineProvider defaultColorScheme="auto"><div className="app-shell"><header><div><Title order={1}>Planrock</Title><Text c="dimmed">Cross-project saved plans</Text></div><TextInput aria-label="Search plans" placeholder="Search plans" value={query} onChange={(event) => setQuery(event.currentTarget.value)} /><Button variant="default" onClick={refresh}>Refresh</Button></header>{error && <div role="alert" className="alert">{error}</div>}{overview && <><div className="meta"><Text>Refreshed {new Date(overview.refreshedAt).toLocaleString()}</Text><Text>Health: {overview.health?.state || (overview.incomplete ? "degraded" : "healthy")}</Text></div><SimpleGrid className="summary-grid" cols={{ base: 2, sm: 4 }}><Summary label="Projects" value={overview.summary.projects} /><Summary label="Open" value={overview.summary.open} /><Summary label="Closed" value={overview.summary.closed} /><Summary label="Invalid" value={overview.summary.invalid} /></SimpleGrid><nav aria-label="Plan views">{[["next", "Next up"], ["open", "Open"], ["closed", "Closed"], ["health", "Registry & health"]].map(([id, label]) => <Button key={id} aria-pressed={view === id} variant={view === id ? "filled" : "default"} onClick={() => setView(id)}>{label}</Button>)}</nav><div className="content-grid"><aside className="project-sidebar" aria-label="Projects"><button aria-pressed={!project} className={!project ? "selected" : ""} onClick={() => setProject("")}>All projects</button>{repositories.map((repository) => <button key={repository.id} aria-pressed={project === repository.id} className={project === repository.id ? "selected" : ""} onClick={() => setProject(repository.id)}><strong>{repository.displayName}</strong><small>{repository.available ? `${repository.counts.open} open · ${repository.counts.closed} closed` : "Unavailable"}</small></button>)}</aside><main>{view === "health" ? <section><Title order={2}>Registry & health</Title>{overview.diagnostics.length ? <ul>{overview.diagnostics.map((item, index) => <li key={`${item.code}-${index}`}><strong>{item.code}</strong> {item.message}</li>)}</ul> : <Text>No warnings.</Text>}</section> : <PlanList title={view === "next" ? "Next up" : view === "open" ? "Open plans" : "Closed plans"} plans={filtered} onSelect={setSelected} />}</main></div>{selected && <PlanDrawer plan={selected} onClose={() => setSelected(null)} />}</>}</div></MantineProvider>;
}

if (document.getElementById("root")) createRoot(document.getElementById("root")).render(<App />);
