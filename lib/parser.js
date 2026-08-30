const crypto = require("node:crypto");
const path = require("node:path");
const { LIMITS, PRIORITIES } = require("./constants");
const { diagnostic, truncateUtf8 } = require("./security");

function unquoteValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function typedScalar(value) {
  if ((value.startsWith('"') && !value.endsWith('"')) || (value.startsWith("'") && !value.endsWith("'"))) throw new Error("unterminated quoted scalar");
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  if (value === "[]") return [];
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1).split(",").map((item) => typedScalar(item.trim())).filter((item) => item !== "");
  if (value.startsWith("[") || value.endsWith("]") || value.startsWith("{") || value.endsWith("}")) throw new Error("unsupported or malformed flow value");
  if (/^(true|false)$/i.test(value)) return value.toLocaleLowerCase("en-US") === "true";
  if (/^(null|~)$/i.test(value)) return null;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);
  return value;
}

function parseFrontmatter(content, { typed = false } = {}) {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return { values: {}, present: false, parseError: null };
  const normalized = content.replace(/\r\n/g, "\n");
  const delimiter = /\n---(?:\n|$)/.exec(normalized.slice(4));
  const end = delimiter ? delimiter.index + 4 : -1;
  if (end === -1) return { values: {}, present: true, parseError: "unterminated frontmatter" };
  const lines = normalized.slice(4, end).split("\n");
  const values = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      if (typed) return { values: {}, present: true, parseError: `unsupported frontmatter line ${index + 1}` };
      continue;
    }
    const key = match[1];
    const raw = match[2].trim();
    if (typed && Object.hasOwn(values, key)) return { values: {}, present: true, parseError: `duplicate frontmatter key ${key}` };
    if (raw === "") {
      const items = [];
      let next = index + 1;
      while (next < lines.length) {
        const item = lines[next].match(/^\s+-\s*(.*)$/);
        if (!item) break;
        try { items.push(typed ? typedScalar(item[1].trim()) : unquoteValue(item[1].trim())); } catch (error) { return { values: {}, present: true, parseError: error.message }; }
        next += 1;
      }
      values[key] = items.length ? items : "";
      index = next - 1;
    } else {
      try { values[key] = typed ? typedScalar(raw) : unquoteValue(raw); } catch (error) { return { values: {}, present: true, parseError: error.message }; }
    }
  }
  return { values, present: true, parseError: null };
}

function normalizeAgentSessions(frontmatter, warnings) {
  if (Array.isArray(frontmatter.agent_sessions)) {
    if (frontmatter.agent_sessions.some((value) => typeof value !== "string")) warnings.push(["PLAN_AGENT_SESSIONS_INVALID", "non-text agent_sessions entries were omitted"]);
    return frontmatter.agent_sessions.filter((value) => typeof value === "string" && value !== "").slice(0, 64).map((value) => truncateUtf8(value, 1024).value);
  }
  if (typeof frontmatter.agent_sessions === "string" && frontmatter.agent_sessions) {
    if (frontmatter.agent_sessions === "[]") return [];
    warnings.push(["PLAN_AGENT_SESSIONS_LEGACY_SCALAR", "agent_sessions should be an array"]);
    return [truncateUtf8(frontmatter.agent_sessions, 1024).value];
  }
  if (typeof frontmatter.agent_session === "string" && frontmatter.agent_session) {
    warnings.push(["PLAN_AGENT_SESSION_LEGACY", "agent_session is deprecated; use agent_sessions"]);
    return [truncateUtf8(frontmatter.agent_session, 1024).value];
  }
  if (frontmatter.agent_sessions !== undefined && frontmatter.agent_sessions !== "") warnings.push(["PLAN_AGENT_SESSIONS_INVALID", "agent_sessions is invalid"]);
  return [];
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function countChecklistItems(content) {
  const total = content.match(/^\s*-\s+\[[ xX]\]/gm) || [];
  const done = content.match(/^\s*-\s+\[[xX]\]/gm) || [];
  return { done: done.length, total: total.length, percent: total.length ? Math.round((done.length / total.length) * 100) : 0 };
}

function stripFrontmatter(content) {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized;
  const delimiter = /\n---(?:\n|$)/.exec(normalized.slice(4));
  const end = delimiter ? delimiter.index + 4 : -1;
  return end === -1 ? normalized : normalized.slice(end + 4).replace(/^\n/, "");
}

function extractSection(content, name) {
  const lines = stripFrontmatter(content).split("\n");
  const start = lines.findIndex((line) => new RegExp(`^#{1,6}\\s+${name}\\s*$`, "i").test(line));
  if (start === -1) return "";
  const level = lines[start].match(/^#+/)[0].length;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#{1,6})\s+/);
    if (heading && heading[1].length <= level) { end = index; break; }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

function relatedLinks(content, warnings) {
  const links = [];
  const seen = new Set();
  const regex = /\[[^\]]*\]\(([^)]+)\)|<(https?:\/\/[^>]+)>/g;
  for (const match of content.matchAll(regex)) {
    const raw = (match[1] || match[2] || "").trim();
    if (seen.has(raw)) continue;
    seen.add(raw);
    try {
      const url = new URL(raw);
      if (url.protocol === "http:" || url.protocol === "https:") {
        if (Buffer.byteLength(url.href) <= 2048) links.push(url.href);
        else warnings.push(["PLAN_LINK_TOO_LONG", "Related link exceeds 2 KiB and was omitted"]);
      }
      else warnings.push(["PLAN_LINK_UNSUPPORTED_SCHEME", `Unsupported link scheme: ${url.protocol}`]);
    } catch {
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) warnings.push(["PLAN_LINK_INVALID", `Invalid related link: ${raw}`]);
    }
  }
  return links;
}

function parsePlan(content, context, { strictState = true } = {}) {
  const parsed = parseFrontmatter(content, { typed: true });
  const diagnostics = [];
  if (parsed.parseError) {
    diagnostics.push(diagnostic("PLAN_FRONTMATTER_INVALID", "error", parsed.parseError, context));
    return { valid: false, diagnostics };
  }
  const frontmatter = parsed.values;
  const state = typeof frontmatter.state === "string" ? frontmatter.state : "";
  if (strictState && !["open", "closed"].includes(state)) {
    diagnostics.push(diagnostic("PLAN_STATE_INVALID", "error", "state must be exactly open or closed", context));
    return { valid: false, diagnostics };
  }
  const warningPairs = [];
  const titleRaw = typeof frontmatter.title === "string" && frontmatter.title ? frontmatter.title : path.basename(context.relativeFile || context.file || "plan.md");
  if (frontmatter.title !== undefined && (typeof frontmatter.title !== "string" || !frontmatter.title)) warningPairs.push(["PLAN_TITLE_INVALID", "title is invalid; filename used"]);
  const title = truncateUtf8(titleRaw, LIMITS.titleBytes);
  if (title.truncated) warningPairs.push(["PLAN_FIELD_TRUNCATED", `title truncated; sha256=${title.hash}`]);
  const priority = PRIORITIES.includes(frontmatter.priority) ? frontmatter.priority : "P2";
  if (frontmatter.priority !== undefined && !PRIORITIES.includes(frontmatter.priority)) warningPairs.push(["PLAN_PRIORITY_INVALID", "priority is invalid; P2 used"]);
  const createdAt = validDate(frontmatter.created_at) ? frontmatter.created_at : "";
  if (frontmatter.created_at && !createdAt) warningPairs.push(["PLAN_CREATED_AT_INVALID", "created_at must be a calendar date in YYYY-MM-DD form"]);
  const closedAt = validDate(frontmatter.closed_at) ? frontmatter.closed_at : "";
  if (frontmatter.closed_at && !closedAt) warningPairs.push(["PLAN_CLOSED_AT_INVALID", "closed_at must be a calendar date in YYYY-MM-DD form"]);
  if (state === "open" && frontmatter.closed_at) warningPairs.push(["PLAN_OPEN_HAS_CLOSED_AT", "open plan supplies closed_at"]);
  if (state === "closed" && !frontmatter.closed_at) warningPairs.push(["PLAN_CLOSED_MISSING_CLOSED_AT", "closed plan omits closed_at"]);
  const agentSessions = normalizeAgentSessions(frontmatter, warningPairs);
  const checklist = countChecklistItems(content);
  if (state === "open" && checklist.total > 0 && checklist.done === checklist.total) warningPairs.push(["PLAN_OPEN_CHECKLIST_COMPLETE", "open plan has a fully checked checklist"]);
  const goal = truncateUtf8(extractSection(content, "Goal"), LIMITS.excerptBytes);
  if (goal.truncated) warningPairs.push(["PLAN_FIELD_TRUNCATED", `goal excerpt truncated; sha256=${goal.hash}`]);
  const links = relatedLinks(content, warningPairs).slice(0, 64);
  for (const [code, message] of warningPairs) diagnostics.push(diagnostic(code, "warning", message, context));
  return {
    valid: ["open", "closed"].includes(state),
    plan: {
      id: crypto.createHash("sha256").update(`${context.projectId || "local"}\0${context.relativeFile || context.file}`).digest("hex").slice(0, 24),
      file: context.relativeFile || context.file,
      title: title.value,
      state,
      priority,
      createdAt,
      closedAt,
      agentSessions,
      checklistDone: checklist.done,
      checklistTotal: checklist.total,
      completionPercent: checklist.percent,
      goalExcerpt: goal.value,
      relatedLinks: links,
    },
    diagnostics,
  };
}

module.exports = { countChecklistItems, extractSection, parseFrontmatter, parsePlan, stripFrontmatter, validDate };
