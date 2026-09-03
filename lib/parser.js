const crypto = require("node:crypto");
const path = require("node:path");
const { LIMITS, PRIORITIES } = require("./constants");
const { diagnostic, truncateUtf8 } = require("./security");

function unquoteValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function stripYamlComment(value) {
  let quote = null; let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === '"' && escaped) { escaped = false; continue; }
    if (quote === '"' && character === "\\") { escaped = true; continue; }
    if (character === quote) {
      if (quote === "'" && value[index + 1] === "'") { index += 1; continue; }
      quote = null; continue;
    }
    if (!quote && (character === '"' || character === "'")) { quote = character; continue; }
    if (!quote && character === "#" && (index === 0 || /\s/.test(value[index - 1]))) return value.slice(0, index).trimEnd();
  }
  return value;
}

function typedScalar(value) {
  if ((value.startsWith('"') && !value.endsWith('"')) || (value.startsWith("'") && !value.endsWith("'"))) throw new Error("unterminated quoted scalar");
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { throw new Error("invalid double-quoted scalar"); }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    const body = value.slice(1, -1); let result = "";
    for (let index = 0; index < body.length; index += 1) {
      if (body[index] !== "'") { result += body[index]; continue; }
      if (body[index + 1] !== "'") throw new Error("invalid single-quoted scalar");
      result += "'"; index += 1;
    }
    return result;
  }
  if (value === "[]") return [];
  if (value.startsWith("[") && value.endsWith("]")) {
    const body = value.slice(1, -1); const items = []; let current = ""; let quote = null; let escaped = false;
    if (!body.trim()) return [];
    for (const character of body) {
      if (quote === '"' && escaped) { current += character; escaped = false; continue; }
      if (quote === '"' && character === "\\") { current += character; escaped = true; continue; }
      if (character === quote) { current += character; quote = null; continue; }
      if (!quote && (character === '"' || character === "'")) { current += character; quote = character; continue; }
      if (!quote && character === ",") { items.push(typedScalar(current.trim())); current = ""; continue; }
      if (!quote && (character === "[" || character === "]" || character === "{" || character === "}")) throw new Error("nested flow values are unsupported");
      current += character;
    }
    if (quote || escaped) throw new Error("unterminated quoted scalar");
    items.push(typedScalar(current.trim()));
    return items;
  }
  if (value.startsWith("[") || value.endsWith("]") || value.startsWith("{") || value.endsWith("}")) throw new Error("unsupported or malformed flow value");
  if (",[]{}#&*!|>'\"%@`".includes(value[0]) || /^[-?:](?:\s|$)/.test(value) || /:(?:\s|$|[\[\]{},])/.test(value)) throw new Error("unsupported YAML scalar syntax");
  if (/^(true|false)$/i.test(value)) return value.toLocaleLowerCase("en-US") === "true";
  if (/^(null|~)$/i.test(value)) return null;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);
  return value;
}

function parseFrontmatter(content, { typed = false, compatibility = false } = {}) {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return { values: {}, present: false, parseError: null };
  const normalized = content.replace(/\r\n/g, "\n");
  const delimiter = /\n---(?:\n|$)/.exec(normalized.slice(4));
  const end = delimiter ? delimiter.index + 4 : -1;
  if (end === -1) return { values: {}, present: true, parseError: "unterminated frontmatter" };
  const lines = normalized.slice(4, end).split("\n");
  const values = Object.create(null);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      if (typed && !compatibility) return { values: {}, present: true, parseError: `unsupported frontmatter line ${index + 1}` };
      continue;
    }
    const key = match[1];
    const raw = stripYamlComment(match[2]).trim();
    if (typed && !compatibility && Object.hasOwn(values, key)) return { values: {}, present: true, parseError: `duplicate frontmatter key ${key}` };
    if (raw === "") {
      const items = [];
      let next = index + 1;
      while (next < lines.length) {
        const item = lines[next].match(/^\s+-\s*(.*)$/);
        if (!item) break;
        const itemRaw = stripYamlComment(item[1]).trim();
        try { items.push(typed ? typedScalar(itemRaw) : unquoteValue(itemRaw)); } catch (error) { return { values: {}, present: true, parseError: error.message }; }
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

function normalizeAgentSessions(frontmatter, warnings, { strict = false } = {}) {
  if (frontmatter.agent_session !== undefined) {
    if (typeof frontmatter.agent_session === "string" && frontmatter.agent_session) warnings.push(["PLAN_AGENT_SESSION_LEGACY", "agent_session is deprecated; use agent_sessions"]);
    else warnings.push(["PLAN_AGENT_SESSION_INVALID", "agent_session is invalid; use agent_sessions"]);
  }
  if (Array.isArray(frontmatter.agent_sessions)) {
    if (frontmatter.agent_sessions.some((value) => typeof value !== "string")) warnings.push(["PLAN_AGENT_SESSIONS_INVALID", "non-text agent_sessions entries were omitted"]);
    if (frontmatter.agent_sessions.some((value) => typeof value === "string" && value === "")) warnings.push(["PLAN_AGENT_SESSIONS_INVALID", "empty agent_sessions entries were omitted"]);
    const sessions = frontmatter.agent_sessions.filter((value) => typeof value === "string" && value !== "");
    if (strict) {
      const seen = new Set();
      for (const value of sessions) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*:[^\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/.test(value)) warnings.push(["PLAN_AGENT_SESSION_INVALID", `invalid agent_sessions entry: ${value}`]);
        if (seen.has(value)) warnings.push(["PLAN_AGENT_SESSION_DUPLICATE", `duplicate agent_sessions entry: ${value}`]);
        seen.add(value);
      }
    }
    if (sessions.length > 64) warnings.push(["PLAN_FIELD_TRUNCATED", "agent_sessions truncated to 64 entries"]);
    return sessions.slice(0, 64).map((value, index) => {
      const truncated = truncateUtf8(value, 1024);
      if (truncated.truncated) warnings.push(["PLAN_FIELD_TRUNCATED", `agent_sessions entry ${index + 1} truncated; sha256=${truncated.hash}`]);
      return truncated.value;
    });
  }
  if (typeof frontmatter.agent_sessions === "string" && frontmatter.agent_sessions) {
    if (frontmatter.agent_sessions === "[]") return [];
    warnings.push(["PLAN_AGENT_SESSIONS_LEGACY_SCALAR", "agent_sessions should be an array"]);
    const truncated = truncateUtf8(frontmatter.agent_sessions, 1024);
    if (truncated.truncated) warnings.push(["PLAN_FIELD_TRUNCATED", `agent_sessions entry 1 truncated; sha256=${truncated.hash}`]);
    return [truncated.value];
  }
  if (typeof frontmatter.agent_session === "string" && frontmatter.agent_session) {
    const truncated = truncateUtf8(frontmatter.agent_session, 1024);
    if (truncated.truncated) warnings.push(["PLAN_FIELD_TRUNCATED", `agent_sessions entry 1 truncated; sha256=${truncated.hash}`]);
    return [truncated.value];
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

function parsePlan(content, context, { strictState = true, strictFields = false } = {}) {
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
  if (strictFields) {
    const supported = new Set(["title", "state", "priority", "created_at", "closed_at", "agent_sessions", "agent_session"]);
    for (const key of Object.keys(frontmatter)) if (!supported.has(key)) warningPairs.push(["PLAN_FIELD_UNKNOWN", `unsupported frontmatter field: ${key}`]);
  }
  if (strictFields && frontmatter.title === undefined) warningPairs.push(["PLAN_TITLE_MISSING", "title is required"]);
  if (strictFields && frontmatter.priority === undefined) warningPairs.push(["PLAN_PRIORITY_MISSING", "priority is required"]);
  if (strictFields && frontmatter.created_at === undefined) warningPairs.push(["PLAN_CREATED_AT_MISSING", "created_at is required"]);
  if (strictFields && frontmatter.agent_sessions === undefined) warningPairs.push(["PLAN_AGENT_SESSIONS_MISSING", "agent_sessions is required"]);
  else if (strictFields && !Array.isArray(frontmatter.agent_sessions)) warningPairs.push(["PLAN_AGENT_SESSIONS_INVALID", "agent_sessions must be an array"]);
  const titleRaw = typeof frontmatter.title === "string" && frontmatter.title ? frontmatter.title : path.basename(context.relativeFile || context.file || "plan.md");
  if (frontmatter.title !== undefined && (typeof frontmatter.title !== "string" || !frontmatter.title.trim() || /[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(frontmatter.title))) warningPairs.push(["PLAN_TITLE_INVALID", "title must be non-empty, one-line text"]);
  const title = truncateUtf8(titleRaw, LIMITS.titleBytes);
  if (title.truncated) warningPairs.push(["PLAN_FIELD_TRUNCATED", `title truncated; sha256=${title.hash}`]);
  const priority = PRIORITIES.includes(frontmatter.priority) ? frontmatter.priority : "P2";
  if (frontmatter.priority !== undefined && !PRIORITIES.includes(frontmatter.priority)) warningPairs.push(["PLAN_PRIORITY_INVALID", "priority is invalid; P2 used"]);
  const createdAt = validDate(frontmatter.created_at) ? frontmatter.created_at : "";
  if (frontmatter.created_at !== undefined && !createdAt) warningPairs.push(["PLAN_CREATED_AT_INVALID", "created_at must be a calendar date in YYYY-MM-DD form"]);
  const closedAt = validDate(frontmatter.closed_at) ? frontmatter.closed_at : "";
  if (frontmatter.closed_at !== undefined && !closedAt) warningPairs.push(["PLAN_CLOSED_AT_INVALID", "closed_at must be a calendar date in YYYY-MM-DD form"]);
  if (state === "open" && frontmatter.closed_at) warningPairs.push(["PLAN_OPEN_HAS_CLOSED_AT", "open plan supplies closed_at"]);
  if (state === "closed" && !frontmatter.closed_at) warningPairs.push(["PLAN_CLOSED_MISSING_CLOSED_AT", "closed plan omits closed_at"]);
  const agentSessions = normalizeAgentSessions(frontmatter, warningPairs, { strict: strictFields });
  const checklist = countChecklistItems(content);
  if (state === "open" && checklist.total > 0 && checklist.done === checklist.total) warningPairs.push(["PLAN_OPEN_CHECKLIST_COMPLETE", "open plan has a fully checked checklist"]);
  const goal = truncateUtf8(extractSection(content, "Goal"), LIMITS.excerptBytes);
  if (goal.truncated) warningPairs.push(["PLAN_FIELD_TRUNCATED", `goal excerpt truncated; sha256=${goal.hash}`]);
  const allLinks = relatedLinks(content, warningPairs);
  if (allLinks.length > 64) warningPairs.push(["PLAN_FIELD_TRUNCATED", "related links truncated to 64 entries"]);
  const links = allLinks.slice(0, 64);
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

module.exports = { countChecklistItems, extractSection, normalizeAgentSessions, parseFrontmatter, parsePlan, stripFrontmatter, validDate };
