---
name: planrock
description: Create, inspect, summarize, and continue Markdown saved plans stored in the current working directory's plans/ directory. Use when the user says plan, saved plan, or planrock in requests such as creating a plan, creating a saved plan, creating a planrock, listing saved plans, showing pending, active, open, or closed plans, plan status, plan progress, or continuing/implementing a saved plan; especially for repositories that store durable plans as Markdown files with YAML frontmatter and checklist items.
---

# Planrock

This skill owns repository-local saved-plan creation, inspection,
reconciliation, continuation, and closure. Use `$planrock-bootstrap` for the
cross-project registry/index and `$planrock-dashboard` for dashboard lifecycle.

## Quick Start

Use the bundled CLI first for read-only plan inventory requests:

```bash
node <skill-dir>/scripts/planrock status --working-dir <working-dir>
node <skill-dir>/scripts/planrock pending --working-dir <working-dir>
node <skill-dir>/scripts/planrock active --working-dir <working-dir>
node <skill-dir>/scripts/planrock open --working-dir <working-dir>
node <skill-dir>/scripts/planrock open --working-dir <working-dir> --sort time
node <skill-dir>/scripts/planrock open --working-dir <working-dir> --full-agent-session
node <skill-dir>/scripts/planrock closed --working-dir <working-dir>
node <skill-dir>/scripts/planrock goal <working-dir>/plans/<plan>.md
```

For a read-only cross-project summary after bootstrap, use:

```bash
node <skill-dir>/scripts/planrock overview --json
```

Add `--json` when structured output helps automation or follow-up analysis. Human output shortens each `agent_sessions` entry to the agent slug plus 8 session ID characters, such as `codex:019e2f7f`; add `--full-agent-session` to show the complete values.

Use `plans/` directly under the current working directory as the convention. Do not search parent directories for a different `plans/` directory. If `<working-dir>/plans` does not exist, warn the user that no `plans/` directory was found in the current working directory and ask for a different working directory only when the request cannot proceed without it.

## Commands

- `status`: Show open, pending, active, closed, and invalid counts; the 10 highest-priority pending and active plans; and the 10 most recent closed plans.
- `pending`: Show open plans with no checked checklist items and no agent sessions.
- `active`: Show open plans with at least one checked checklist item or agent session.
- `open`: Show all pending and active plans as a backward-compatible aggregate, priority first and then newest `created_at`.
- `closed`: Show all closed plans, newest `closed_at` first.
- `goal <path-to-plan>`: Print a copy-pasteable Codex `/goal` command from the
  body of the plan's `## Goal` section, ending with a stable `plans/...`
  reference for the original plan file.

By default, `status`, `pending`, `active`, and `open` sort open plans by `priority` (`P0`, `P1`, `P2`, `P3`, `P4`) and then newest `created_at`. Use `--sort time` for the old newest-created-first behavior, or `--sort priority` to spell the default explicitly.

Pending and active are derived workflow states shared with the dashboard; plan
frontmatter continues to use only lifecycle `state: open` or `state: closed`.
A closed plan is always closed. An open plan is active when it has at least one
checked checklist item or at least one normalized `agent_sessions` entry, and
is pending otherwise. Thus zero-checklist plans are pending without sessions,
session-only plans are active, and fully checked open plans stay active until
formally closed. Missing or unsupported lifecycle state and structurally
malformed frontmatter are invalid and excluded from lifecycle and workflow
collections. The local CLI retains legacy tolerance for unsupported nested
fields and uses the last duplicate scalar key.

The CLI is read-only. It parses Markdown files directly under `plans/`, reads scalar YAML frontmatter keys `title`, `state`, `priority`, `created_at`, and `closed_at`, reads list frontmatter key `agent_sessions`, and counts checklist items matching `- [ ]` and `- [x]`. Plans without `priority` are treated as `P2`.

## Agent Sessions

Use `agent_sessions` entries in `<agent-slug>:<session-id>` format.

Supported agent slugs:

- `codex`
- `claude-code`

Unknown agents should use a stable lowercase slug such as `local-agent`. Preserve unknown slugs as written.

## Priority

Use these `priority` values in frontmatter:

- `P0`: emergency / stop-the-world.
- `P1`: high priority / pick soon.
- `P2`: normal planned work.
- `P3`: low priority / nice to have.
- `P4`: backlog / maybe later.

## Creating A Plan

When the user asks to create a saved plan, create a Markdown file directly under `<working-dir>/plans/`. If no `plans/` directory exists in the current working directory, warn the user and create `plans/` only when the user has asked to create a saved plan there.

Use this frontmatter:

```yaml
---
title: <short title>
state: open
priority: P2
created_at: <YYYY-MM-DD>
agent_sessions: []
---
```

Then write a concise checklist of concrete implementation steps using `- [ ]`.
The new plan is pending until a checklist item is checked or an agent session is recorded.

## Continuing A Plan

When the user asks to continue, implement, or inspect a specific saved plan:

1. Run `node <skill-dir>/scripts/planrock open --working-dir <working-dir> --json` unless the plan file is already known.
2. Open the relevant plan Markdown file.
3. Before editing the plan or repository code, read and follow the working directory or repository instructions that govern the plan and its implementation.
4. Before selecting the next implementation step, reconcile the entire plan against the user's latest explicit scope. The user's latest explicit decisions override stale checklist items and prose. When continuing or implementing the plan, edit it so its current completion gates contain only the accepted scope plus requirements mandated by governing repository instructions. For read-only inspection, report scope drift without editing the plan.
5. Record rejected, deferred, and transferred work clearly outside the current completion checklist, then remove or mark it so it no longer blocks this plan. For transferred work, link the destination plan and do not execute it in both plans or make this plan wait for it unless the user explicitly made it a dependency.
6. Do not introduce new drills, soak periods, deliverables, or validation gates unless the user explicitly requested them or governing repository policy requires them. Preserve mandatory repository safety, testing, review, and delivery requirements.
7. When starting or continuing implementation work on the plan, update `agent_sessions` in frontmatter as a simple signal that agent sessions are working on or have worked on the plan. For Codex, use `codex:<CODEX_THREAD_ID>` when `CODEX_THREAD_ID` is available. For Claude Code, use `claude-code:<session-id>` with the best available stable session id from its environment or runtime metadata. Other agents should use `<stable-lowercase-agent-slug>:<session-id>`. If the current session entry is not in the list, append it. If it already exists, move that entry to the end so the latest active session is last. Do not update `agent_sessions` for read-only inspection.
8. Summarize the reconciled state and identify the next concrete unchecked step.
9. Keep the plan checklist current during execution. Mark completed items with `- [x]` soon after completing them so progress can sync through the saved plan.
10. After completing a plan item, update the plan file if appropriate and state the next concrete step.
11. When a plan is genuinely complete, close it according to that working directory's plan rules.

Agent sessions frontmatter example:

```yaml
agent_sessions:
  - codex:01932f7f-930f-7052-999f-e3b083d9373f
  - claude-code:982f38ab-930f-7052-999f-e3b083d9373f
```

## Output Guidance

For simple status requests, report the CLI result concisely instead of reformatting every field. For continuation requests, include the plan file path, the current state, and the immediate next action.
