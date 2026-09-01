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
  Menu,
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
  if (!response.ok) { const error = new Error(`Planrock API returned ${response.status}`); error.status = response.status; throw error; }
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
  const displayed = expanded ? full : formatRelativeDate(value);
  return <UnstyledButton className={`relative-time ${className}`.trim()} data-expanded={expanded || undefined} title={full} aria-label={`${label}: ${displayed}; ${expanded ? "show relative time" : "show full timestamp"}`} onClick={() => setExpanded((current) => !current)}><Text className="time-label">{label}</Text><Text className="time-value" size="sm" fw={550}><time dateTime={value}>{displayed}</time></Text></UnstyledButton>;
}

function RefreshedTime({ value }) {
  const [expanded, setExpanded] = useState(false);
  if (!value) return null;
  const full = formatFullDate(value);
  const displayed = expanded ? full : `Refreshed ${formatRelativeDate(value)}`;
  return <UnstyledButton className="refresh-time" title={full} aria-label={`${displayed}; ${expanded ? "show relative time" : "show full timestamp"}`} onClick={() => setExpanded((current) => !current)}><Text size="xs" c="dimmed"><time dateTime={value}>{displayed}</time></Text></UnstyledButton>;
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
  const rawTarget = normalizePlanPath(value).split(/[?#]/, 1)[0]; const wrappedTarget = rawTarget.startsWith("<") && rawTarget.endsWith(">") ? rawTarget.slice(1, -1) : rawTarget;
  let target; try { target = decodeURIComponent(wrappedTarget); } catch { target = wrappedTarget; }
  const base = normalizePlanPath(basePath);
  const targetDrive = target.match(/^[a-z]:\//i)?.[0].slice(0, 2); const baseDrive = base.match(/^[a-z]:\//i)?.[0].slice(0, 2);
  const absolute = target.startsWith("/") || Boolean(targetDrive); const root = targetDrive ? `${targetDrive}/` : absolute ? "/" : baseDrive ? `${baseDrive}/` : "/";
  const stripRoot = (pathValue, drive) => pathValue.slice(drive ? 3 : pathValue.startsWith("/") ? 1 : 0);
  const parts = absolute ? [] : stripRoot(base, baseDrive).split("/").slice(0, -1);
  for (const part of stripRoot(target, targetDrive).split("/")) { if (!part || part === ".") continue; if (part === "..") parts.pop(); else parts.push(part); }
  return `${root}${parts.join("/")}`;
}

export function stripPlanFrontmatter(content) {
  const normalized = String(content || "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized;
  const delimiter = /\n---(?:\n|$)/.exec(normalized.slice(4));
  return delimiter ? normalized.slice(delimiter.index + 8).replace(/^\n+/, "") : normalized;
}

function markdownTarget(value, basePath, plansByPath) {
  const remote = webHref(value);
  if (remote) return { href: remote, plan: null };
  if (!basePath || /^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  const absolutePath = resolvePlanPath(value, basePath); const target = plansByPath.get(absolutePath);
  if (target) return { href: planSourceHref(target), plan: target };
  return /\.md(?:own)?$/i.test(absolutePath) ? { markdown: { absolutePath, label: value.split(/[\\/]/).at(-1) || value } } : null;
}

function renderInlineMarkdown(value, context, keyPrefix) {
  const nodes = []; let text = ""; let cursor = 0;
  const flush = () => { if (text) { nodes.push(text); text = ""; } };
  while (cursor < value.length) {
    if (value[cursor] === "\\" && cursor + 1 < value.length) { text += value[cursor + 1]; cursor += 2; continue; }
    if (value[cursor] === "`") { const end = value.indexOf("`", cursor + 1); if (end !== -1) { flush(); nodes.push(<code key={`${keyPrefix}-code-${cursor}`}>{value.slice(cursor + 1, end)}</code>); cursor = end + 1; continue; } }
    if (value.startsWith("**", cursor)) { const end = value.indexOf("**", cursor + 2); if (end !== -1) { flush(); nodes.push(<strong key={`${keyPrefix}-strong-${cursor}`}>{renderInlineMarkdown(value.slice(cursor + 2, end), context, `${keyPrefix}-strong-${cursor}`)}</strong>); cursor = end + 2; continue; } }
    if (value[cursor] === "*") { const end = value.indexOf("*", cursor + 1); if (end !== -1) { flush(); nodes.push(<em key={`${keyPrefix}-em-${cursor}`}>{renderInlineMarkdown(value.slice(cursor + 1, end), context, `${keyPrefix}-em-${cursor}`)}</em>); cursor = end + 1; continue; } }
    if (value[cursor] === "[") { const labelEnd = value.indexOf("](", cursor + 1); const targetEnd = labelEnd === -1 ? -1 : value.indexOf(")", labelEnd + 2); if (targetEnd !== -1) { flush(); const label = renderInlineMarkdown(value.slice(cursor + 1, labelEnd), context, `${keyPrefix}-link-${cursor}`); const target = markdownTarget(value.slice(labelEnd + 2, targetEnd), context.basePath, context.plansByPath); nodes.push(target?.plan ? <button key={`${keyPrefix}-link-${cursor}`} type="button" className="markdown-link" onClick={(event) => context.onOpenPlan(event, target.plan)}>{label}</button> : target?.markdown ? <button key={`${keyPrefix}-link-${cursor}`} type="button" className="markdown-link" onClick={(event) => context.onOpenMarkdown(event, target.markdown)}>{label}</button> : target ? <a key={`${keyPrefix}-link-${cursor}`} href={target.href} target="_blank" rel="noreferrer">{label}</a> : <React.Fragment key={`${keyPrefix}-link-${cursor}`}>{label}</React.Fragment>); cursor = targetEnd + 1; continue; } }
    text += value[cursor]; cursor += 1;
  }
  flush(); return nodes;
}

function listMarker(line) {
  const match = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)/);
  return match ? { indent: match[1].replace(/\t/g, "    ").length, ordered: /\d/.test(match[2]), content: match[3] } : null;
}

function renderMarkdownList(lines, start, context, keyPrefix) {
  const root = listMarker(lines[start]); const items = []; let index = start;
  while (index < lines.length) {
    const marker = listMarker(lines[index]);
    if (!marker || marker.indent !== root.indent || marker.ordered !== root.ordered) break;
    const itemStart = index; const segments = [{ type: "text", lines: [marker.content] }]; index += 1;
    while (index < lines.length) {
      const next = listMarker(lines[index]);
      if (next?.indent === root.indent) break;
      if (next && next.indent > root.indent) { const child = renderMarkdownList(lines, index, context, `${keyPrefix}-${itemStart}`); segments.push({ type: "node", node: child.node }); index = child.index; continue; }
      if (!lines[index].trim()) { index += 1; continue; }
      const indent = lines[index].match(/^\s*/)[0].replace(/\t/g, "    ").length;
      if (indent > root.indent && !/^\s*(?:#{1,6}\s|```)/.test(lines[index])) { const last = segments.at(-1); if (last.type === "text") last.lines.push(lines[index].trim()); else segments.push({ type: "text", lines: [lines[index].trim()] }); index += 1; continue; }
      break;
    }
    const firstText = segments.find((segment) => segment.type === "text"); const task = root.ordered ? null : firstText?.lines.join(" ").match(/^\[([ xX])\]\s+(.+)/);
    const children = segments.map((segment, segmentIndex) => segment.type === "node" ? segment.node : task ? <span className="task-text" key={`${keyPrefix}-${itemStart}-text-${segmentIndex}`}>{renderInlineMarkdown(segment === firstText ? task[2] : segment.lines.join(" "), context, `${keyPrefix}-${itemStart}-${segmentIndex}`)}</span> : <React.Fragment key={`${keyPrefix}-${itemStart}-text-${segmentIndex}`}>{renderInlineMarkdown(segment.lines.join(" "), context, `${keyPrefix}-${itemStart}-${segmentIndex}`)}</React.Fragment>);
    items.push(<li className={task ? "task-list-item" : undefined} key={`${keyPrefix}-${itemStart}`}>{task && <input type="checkbox" aria-label={task[2]} checked={task[1].toLocaleLowerCase() === "x"} disabled />}{children}</li>);
  }
  const List = root.ordered ? "ol" : "ul";
  return { node: <List className={items.some((item) => item.props.className) ? "task-list" : undefined} key={`${keyPrefix}-${start}`}>{items}</List>, index };
}

function markdownTableCells(line) {
  const value = line.trim().replace(/^\|/, "").replace(/\|$/, ""); const cells = []; let cell = ""; let escaped = false; let inCode = false;
  for (const character of value) {
    if (escaped) { cell += character; escaped = false; continue; }
    if (character === "\\") { escaped = true; cell += character; continue; }
    if (character === "`") { inCode = !inCode; cell += character; continue; }
    if (character === "|" && !inCode) { cells.push(cell.trim()); cell = ""; continue; }
    cell += character;
  }
  if (escaped) cell += "\\"; cells.push(cell.trim()); return cells;
}

function renderMarkdownTable(lines, start, context) {
  if (!lines[start].trim().includes("|") || start + 1 >= lines.length) return null;
  const headers = markdownTableCells(lines[start]); const delimiters = markdownTableCells(lines[start + 1]);
  if (headers.length < 2 || delimiters.length !== headers.length || !delimiters.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
  const alignments = delimiters.map((cell) => cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left"); const rows = []; let index = start + 2;
  while (index < lines.length && lines[index].trim().includes("|") && lines[index].trim()) { const cells = markdownTableCells(lines[index]); if (cells.length !== headers.length) break; rows.push(cells); index += 1; }
  return { index, node: <div className="markdown-table-scroll" role="region" aria-label="Scrollable Markdown table" tabIndex={0} key={`table-${start}`}><table><thead><tr>{headers.map((cell, column) => <th scope="col" style={{ textAlign: alignments[column] }} key={`header-${column}`}>{renderInlineMarkdown(cell, context, `table-${start}-header-${column}`)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={`row-${rowIndex}`}>{row.map((cell, column) => <td style={{ textAlign: alignments[column] }} key={`cell-${rowIndex}-${column}`}>{renderInlineMarkdown(cell, context, `table-${start}-${rowIndex}-${column}`)}</td>)}</tr>)}</tbody></table></div> };
}

function MarkdownText({ children, className, basePath, plansByPath, onOpenPlan, onOpenMarkdown }) {
  const lines = String(children || "").split("\n"); const blocks = []; const context = { basePath, plansByPath, onOpenPlan, onOpenMarkdown }; let index = 0;
  const blockStart = (line) => !line.trim() || /^\s*(?:[-*+] |\d+\. |#{1,6} |```)/.test(line);
  while (index < lines.length) {
    if (!lines[index].trim()) { index += 1; continue; }
    if (lines[index].trim().startsWith("```")) { const language = lines[index].trim().slice(3); const code = []; index += 1; while (index < lines.length && !lines[index].trim().startsWith("```")) { code.push(lines[index]); index += 1; } index += 1; blocks.push(<pre key={`code-${index}`}><code data-language={language || undefined}>{code.join("\n")}</code></pre>); continue; }
    const table = renderMarkdownTable(lines, index, context); if (table) { blocks.push(table.node); index = table.index; continue; }
    if (listMarker(lines[index])) { const list = renderMarkdownList(lines, index, context, "list"); blocks.push(list.node); index = list.index; continue; }
    const heading = lines[index].match(/^(#{1,6})\s+(.+)/); if (heading) { const Heading = `h${heading[1].length}`; blocks.push(<Heading key={`heading-${index}`}>{renderInlineMarkdown(heading[2], context, `heading-${index}`)}</Heading>); index += 1; continue; }
    const paragraph = [lines[index].trim()]; index += 1; while (index < lines.length && !blockStart(lines[index])) { paragraph.push(lines[index].trim()); index += 1; } blocks.push(<p key={`paragraph-${index}`}>{renderInlineMarkdown(paragraph.join(" "), context, `paragraph-${index}`)}</p>);
  }
  return <div className={className}>{blocks}</div>;
}

function sessionThreadId(session) {
  const [agent, ...parts] = String(session).split(":");
  const threadId = parts.join(":");
  return agent === "codex" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId) ? threadId : null;
}

function completion(plan) {
  if (!plan.checklistTotal) return 0;
  return Math.round((plan.checklistDone / plan.checklistTotal) * 100);
}

function PlanProgress({ plan, className = "" }) {
  const percent = completion(plan);
  return <div className={`plan-progress ${className}`.trim()}>
    <Group justify="space-between" gap={8}><Text size="xs" fw={600}>Progress</Text><Text size="xs" c="dimmed">{plan.checklistDone}/{plan.checklistTotal} · {percent}%</Text></Group>
    <Progress value={percent} size="sm" radius="xl" aria-label={`${percent}% complete`} />
  </div>;
}

function PlanRow({ plan, onSelect }) {
  const workflow = workflowState(plan);
  const timestamp = workflow === "closed" ? { label: "Closed", value: plan.closedAt || plan.updatedAt || plan.createdAt } : workflow === "active" ? { label: "Active", value: plan.updatedAt || plan.createdAt } : { label: "Pending", value: plan.createdAt || plan.updatedAt };
  return <Paper className="plan-row" withBorder>
    <UnstyledButton className="plan-row-button" onClick={(event) => onSelect(plan, event.currentTarget)} aria-label={`Open ${plan.title}`}>
      <div className="plan-identity">
        <Group className="plan-title-line" gap={8} wrap="nowrap"><Badge className={`priority ${plan.priority}`} variant="light">{plan.priority}</Badge><Text component="h3" fw={650}>{plan.title}</Text></Group>
        <Text size="sm" c="dimmed">{plan.projectName} · {plan.relativeFile}</Text>
      </div>
      <PlanProgress plan={plan} />
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

function ChatAction({ sessions = [], onOpen, disabled = false }) {
  const links = sessions.filter((session) => sessionThreadId(session));
  const latest = links.at(-1); if (!latest) return null;
  const explanation = disabled ? "Available on the Planrock host machine only" : undefined;
  return <Button.Group title={explanation}><Button disabled={disabled} onClick={() => onOpen(latest)}>Go chat</Button>{links.length > 1 && <Menu position="bottom-end" withinPortal><Menu.Target><Button disabled={disabled} variant="filled" className="chat-menu-trigger" aria-label="Choose agent session">▾</Button></Menu.Target><Menu.Dropdown>{[...links].reverse().map((session, index) => <Menu.Item onClick={() => onOpen(session)} key={session}>{index === 0 ? "Latest · " : ""}{session}</Menu.Item>)}</Menu.Dropdown></Menu>}</Button.Group>;
}

function MarkdownDrawer({ preview, plansByPath, onClose, onOpenPlan, onOpenMarkdown }) {
  return <Drawer opened onClose={onClose} title="Markdown preview" position="right" size="lg">
    <Stack gap="md"><div><Title className="detail-title" order={2}>{preview.label}</Title>{preview.relativeFile && <Text size="xs" c="dimmed" className="path-text">{preview.relativeFile}</Text>}</div>{preview.loading && <Text size="sm" c="dimmed">Loading Markdown…</Text>}{preview.error && <Text role="alert" size="sm" c="red">{preview.error}</Text>}{preview.content && <MarkdownText className="plan-content" basePath={preview.absolutePath} plansByPath={plansByPath} onOpenPlan={onOpenPlan} onOpenMarkdown={(event, target) => onOpenMarkdown(event, target, preview.absolutePath)}>{stripPlanFrontmatter(preview.content)}</MarkdownText>}</Stack>
  </Drawer>;
}

function PlanDrawer({ plan, plans, onClose, nativeActionsAvailable }) {
  const workflow = workflowState(plan);
  const plansByPath = useMemo(() => new Map(plans.map((item) => [normalizePlanPath(item.absolutePath), item])), [plans]);
  const [copyStatus, setCopyStatus] = useState("");
  const [chatStatus, setChatStatus] = useState("");
  const [pathStatus, setPathStatus] = useState("");
  const [planContent, setPlanContent] = useState("");
  const [planContentError, setPlanContentError] = useState("");
  const [planContentLoading, setPlanContentLoading] = useState(true);
  const [linkedPlanId, setLinkedPlanId] = useState(null);
  const [markdownPreview, setMarkdownPreview] = useState(null);
  const markdownRequest = useRef(0);
  useEffect(() => {
    const controller = new AbortController(); setPlanContent(""); setPlanContentError(""); setPlanContentLoading(true);
    fetch(planSourceHref(plan), { signal: controller.signal }).then((response) => { if (!response.ok) throw new Error(`Plan source returned ${response.status}`); return response.text(); }).then((text) => setPlanContent(stripPlanFrontmatter(text))).catch((reason) => { if (reason.name !== "AbortError") setPlanContentError(reason.message); }).finally(() => { if (!controller.signal.aborted) setPlanContentLoading(false); });
    return () => controller.abort();
  }, [plan.id, plan.fingerprint]);
  async function copy(label, value) {
    try { await copyText(value); setCopyStatus(`${label} copied`); }
    catch { setCopyStatus("Copy failed — select the text above and copy it manually"); }
  }
  function closeMarkdownOverlay() { markdownRequest.current += 1; setMarkdownPreview(null); }
  function openPlanOverlay(event, target) { event.preventDefault(); closeMarkdownOverlay(); setLinkedPlanId(target.id); }
  async function openMarkdownOverlay(event, target, sourcePath) {
    event.preventDefault(); setLinkedPlanId(null); const request = markdownRequest.current + 1; markdownRequest.current = request; setMarkdownPreview({ ...target, loading: true, content: "", error: "" });
    try { const result = await api(`/api/markdown?id=${encodeURIComponent(plan.id)}&path=${encodeURIComponent(target.absolutePath)}${sourcePath ? `&source=${encodeURIComponent(sourcePath)}` : ""}`); if (markdownRequest.current === request) setMarkdownPreview({ ...target, ...result, label: target.label, loading: false, error: "" }); }
    catch (reason) { if (markdownRequest.current === request) setMarkdownPreview({ ...target, loading: false, content: "", error: reason.message }); }
  }
  async function openPlanPath() {
    setPathStatus("Opening…");
    try { await api(`/api/open-plan?id=${encodeURIComponent(plan.id)}`, { method: "POST", body: "{}" }); setPathStatus("Opened in system"); }
    catch { setPathStatus("Could not open this plan in the system"); }
  }
  async function openChat(session) {
    setChatStatus("Opening chat…");
    try { await api(`/api/open-chat?id=${encodeURIComponent(plan.id)}&session=${encodeURIComponent(session)}`, { method: "POST", body: "{}" }); setChatStatus("Opened in Codex"); }
    catch { setChatStatus("Could not open this chat in Codex"); }
  }
  const linkedPlan = linkedPlanId ? plans.find((item) => item.id === linkedPlanId) || null : null;
  return <>
    <Drawer opened onClose={onClose} title="Plan details" position="right" size="lg">
      <Stack gap="md">
        <div><Title className="detail-title" order={2}>{plan.title}</Title><Text size="sm" c="dimmed">{plan.projectName}</Text></div>
        <PlanProgress plan={plan} className="detail-progress" />
        <Divider />
        <Group className="detail-stats" align="flex-start"><div className="detail-stat"><Text className="time-label">Priority</Text><Badge className={`priority ${plan.priority}`} variant="light">{plan.priority}</Badge></div><div className="detail-stat"><Text className="time-label">State</Text><Text className="time-value detail-state-value" size="sm" fw={550}>{workflow === "active" ? "Active" : workflow === "pending" ? "Pending" : "Closed"}</Text></div><RelativeTime label="Created" value={plan.createdAt} /><RelativeTime label="Updated" value={plan.updatedAt} />{plan.state === "closed" && <RelativeTime label="Closed" value={plan.closedAt} />}</Group>
        <Group className="detail-actions" gap="sm"><ChatAction sessions={plan.agentSessions} onOpen={openChat} disabled={!nativeActionsAvailable} /><Button variant="default" onClick={() => copy("Goal command", `/goal\n${plan.goalExcerpt || ""}\n\nUse plan reference: ${plan.absolutePath}.`)}>Copy goal command</Button></Group>
        {!nativeActionsAvailable && <Text size="xs" c="dimmed">System file and chat actions are available on the Planrock host machine only.</Text>}
        {chatStatus && <Text role="status" size="sm" c={chatStatus.startsWith("Could not") ? "red" : "dimmed"}>{chatStatus}</Text>}
        {copyStatus && <Text role="status" size="sm" c={copyStatus.startsWith("Copy failed") ? "red" : "dimmed"}>{copyStatus}</Text>}
        <section>{planContentLoading && <Text size="sm" c="dimmed">Loading plan…</Text>}{planContentError && <Text role="alert" size="sm" c="red">{planContentError}</Text>}{planContent && <MarkdownText className="plan-content" basePath={plan.absolutePath} plansByPath={plansByPath} onOpenPlan={openPlanOverlay} onOpenMarkdown={openMarkdownOverlay}>{planContent}</MarkdownText>}</section>
        <div><Text className="detail-label">Plan path</Text>{nativeActionsAvailable ? <UnstyledButton className="path-text detail-link detail-meta-value" onClick={openPlanPath} title="Open plan in the system">{plan.absolutePath}</UnstyledButton> : <Text size="xs" className="path-text detail-meta-value">{plan.absolutePath}</Text>}{pathStatus && <Text role="status" size="xs" c={pathStatus.startsWith("Could not") ? "red" : "dimmed"}>{pathStatus}</Text>}</div>
        {plan.agentSessions?.length > 0 && <div><Text className="detail-label">Agent sessions</Text><Stack gap={4}>{plan.agentSessions.map((session) => sessionThreadId(session) && nativeActionsAvailable ? <UnstyledButton key={session} className="path-text detail-link detail-meta-value" onClick={() => openChat(session)} title="Open Codex task">{session}</UnstyledButton> : <Text key={session} size="xs" className="path-text detail-meta-value">{session}</Text>)}</Stack></div>}
        {plan.relatedLinks?.length > 0 && <div><Text className="detail-label">Related links</Text><Stack gap={6}>{plan.relatedLinks.map((link) => <Text component="a" size="sm" key={link} href={link} target="_blank" rel="noreferrer">{link}</Text>)}</Stack></div>}
      </Stack>
    </Drawer>
    {markdownPreview && <MarkdownDrawer preview={markdownPreview} plansByPath={plansByPath} onClose={closeMarkdownOverlay} onOpenPlan={openPlanOverlay} onOpenMarkdown={openMarkdownOverlay} />}
    {linkedPlan && <PlanDrawer plan={linkedPlan} plans={plans} onClose={() => setLinkedPlanId(null)} nativeActionsAvailable={nativeActionsAvailable} />}
  </>;
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
  const [selectedId, setSelectedId] = useState(null);
  const [healthOpen, setHealthOpen] = useState(false);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const overlayTrigger = useRef(null);
  const loadGeneration = useRef(0);

  async function load() {
    const generation = loadGeneration.current + 1; loadGeneration.current = generation;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const next = await api("/api/overview");
        const fetchPage = async (collection, cursor, limit) => { const page = await api(`/api/collection?name=${encodeURIComponent(collection)}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`); if (page.snapshotId !== next.snapshotId) { const error = new Error("Planrock snapshot changed while loading"); error.code = "SNAPSHOT_MISMATCH"; throw error; } return page; };
        const [open, closed, projects] = await Promise.all([fetchAllPages(fetchPage, "openPlans"), fetchAllPages(fetchPage, "closedPlans"), fetchAllPages(fetchPage, "repositories")]);
        if (generation !== loadGeneration.current) return;
        setOverview(next); setAllPlans([...open, ...closed]); setRepositories(projects); return;
      } catch (reason) {
        if (generation !== loadGeneration.current) return;
        if (attempt < 2 && (reason.code === "SNAPSHOT_MISMATCH" || reason.status === 409)) continue;
        throw reason;
      }
    }
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
  const selected = useMemo(() => selectedId ? allPlans.find((plan) => plan.id === selectedId) || null : null, [allPlans, selectedId]);

  async function refresh() { const startedAt = Date.now(); try { setRefreshing(true); setRefreshFailed(false); setError(""); await api("/api/refresh", { method: "POST", body: "{}" }); await load(); } catch (reason) { setRefreshFailed(true); setError(reason.message); } finally { const remaining = Math.max(0, 800 - (Date.now() - startedAt)); if (remaining) await new Promise((resolve) => setTimeout(resolve, remaining)); setRefreshing(false); } }
  function restoreOverlayFocus() { requestAnimationFrame(() => overlayTrigger.current?.focus()); }
  function closePlan() { setSelectedId(null); restoreOverlayFocus(); }
  function closeHealth() { setHealthOpen(false); restoreOverlayFocus(); }
  const healthState = refreshing ? "loading" : refreshFailed ? "stale" : overview ? (overview.health?.state || (overview.incomplete ? "degraded" : "healthy")) : "loading";
  const healthColor = healthState === "healthy" ? "teal" : healthState === "loading" ? "gray" : "orange";
  const refreshAvailable = overview?.nativeActions === true;

  return <MantineProvider theme={theme} defaultColorScheme="auto">
    <div className="page-shell">
      <header className="dashboard-navbar"><Container size="xl" pt={{ base: "lg", sm: 36 }}><div className="dashboard-header"><div><Group gap="xs"><Text className="brand-mark">PLANROCK</Text><Text size="xs" c="dimmed">v{packageJson.version}</Text></Group><Title order={1}>Dashboard</Title></div><Group className="header-actions" gap="sm" align="flex-start"><Button className={`health-button ${healthState}`} variant="subtle" color={healthColor} disabled={!overview} onClick={(event) => { overlayTrigger.current = event.currentTarget; setHealthOpen(true); }}><span className="health-dot" aria-hidden="true" />{healthState}</Button><div className="refresh-control" title={!refreshAvailable && overview ? "Refresh is available on the Planrock host machine only" : undefined}><Button className={`refresh-button ${refreshing ? "refreshing" : ""}`} variant="default" miw={112} disabled={refreshing || !refreshAvailable} aria-busy={refreshing} onClick={refresh}>Refresh</Button>{overview && <RefreshedTime value={overview.refreshedAt} />}</div></Group></div></Container></header>
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
            <div className="state-grid"><div><div className="filter-heading"><Text className="filter-label">State</Text></div><div className="segmented-scroll"><SegmentedControl aria-label="Plan lifecycle" size="xs" fullWidth value={lifecycle} onChange={setLifecycle} data={[{ value: "open", label: `Open ${counts.open}` }, { value: "closed", label: `Closed ${counts.closed}` }]} /></div></div>{lifecycle === "open" && <div><div className="filter-heading"><Text className="filter-label">Progress</Text></div><div className="segmented-scroll"><SegmentedControl aria-label="Plan progress" size="xs" fullWidth value={workflow} onChange={setWorkflow} data={[{ value: "all", label: `All ${counts.open}` }, { value: "pending", label: `Pending ${counts.pending}` }, { value: "active", label: `Active ${counts.active}` }]} /></div></div>}</div>
        </Paper>
        <PlanList plans={filtered} onSelect={(plan, trigger) => { overlayTrigger.current = trigger; setSelectedId(plan.id); }} />
      </Stack>}
      {selected && <PlanDrawer plan={selected} plans={allPlans} onClose={closePlan} nativeActionsAvailable={overview?.nativeActions === true} />}
      {healthOpen && overview && <HealthDrawer overview={overview} displayState={healthState} onClose={closeHealth} />}
      </Container>
    </div>
  </MantineProvider>;
}

if (document.getElementById("root")) createRoot(document.getElementById("root")).render(<App />);
