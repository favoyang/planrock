---
name: planrock
description: Create, inspect, summarize, and continue Markdown saved plans stored in the current working directory's plans/ directory. Use when the user says plan, saved plan, or planrock in requests such as creating a plan, creating a saved plan, creating a planrock, listing saved plans, showing open plans, closed plans, recent closed plans, plan status, plan progress, or continuing/implementing a saved plan; especially for repositories that store durable plans as Markdown files with YAML frontmatter and checklist items.
---

# Planrock

## Quick Start

Use the bundled CLI first for read-only plan inventory requests:

```bash
node <skill-dir>/scripts/planrock status --working-dir <working-dir>
node <skill-dir>/scripts/planrock open --working-dir <working-dir>
node <skill-dir>/scripts/planrock open --working-dir <working-dir> --sort time
node <skill-dir>/scripts/planrock closed --working-dir <working-dir>
```

Add `--json` when structured output helps automation or follow-up analysis.

Use `plans/` directly under the current working directory as the convention. Do not search parent directories for a different `plans/` directory. If `<working-dir>/plans` does not exist, warn the user that no `plans/` directory was found in the current working directory and ask for a different working directory only when the request cannot proceed without it.

## Commands

- `status`: Show summary counts plus the 10 highest-priority open plans and 10 most recent closed plans.
- `open`: Show all open plans, priority first and then newest `created_at`.
- `closed`: Show all closed plans, newest `closed_at` first.

By default, `status` and `open` sort open plans by `priority` (`P0`, `P1`, `P2`, `P3`, `P4`) and then newest `created_at`. Use `--sort time` for the old newest-created-first behavior, or `--sort priority` to spell the default explicitly.

The CLI is read-only. It parses Markdown files directly under `plans/`, reads scalar YAML frontmatter keys `title`, `state`, `priority`, `created_at`, `closed_at`, `agent`, and `agent_claim_expires_at`, and counts checklist items matching `- [ ]` and `- [x]`. Plans without `priority` are treated as `P2`. JSON output also includes computed camelCase fields such as `agentClaimExpiresAt` and `agentClaimActive`; do not store `agentClaimActive` in frontmatter.

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
---
```

Then write a concise checklist of concrete implementation steps using `- [ ]`.

## Continuing A Plan

When the user asks to continue, implement, or inspect a specific saved plan:

1. Run `node <skill-dir>/scripts/planrock open --working-dir <working-dir> --json` unless the plan file is already known.
2. Avoid plans with a future `agent_claim_expires_at` unless the user explicitly asks you to work on that plan. Expired or missing claim timestamps do not block picking the plan.
3. Open the relevant plan Markdown file.
4. When starting or continuing implementation work on the plan, set or refresh `agent` and `agent_claim_expires_at` in frontmatter. Use `agent: codex` for Codex unless the user or runtime identifies a different display name, and set `agent_claim_expires_at` to a timestamp 60 minutes in the future with timezone offset, such as `2026-05-16T02:06:47+08:00`. Do not claim a plan for read-only inspection.
5. If you are still working and the claim is about to expire, extend `agent_claim_expires_at`.
6. Summarize the current state and identify the next concrete unchecked step.
7. Before editing any repository code, follow the working directory or repository instructions that govern that plan.
8. After completing a plan item, update the plan file if appropriate and state the next concrete step.
9. When a plan is genuinely complete, close it according to that working directory's plan rules.

Claim frontmatter example:

```yaml
agent: codex
agent_claim_expires_at: 2026-05-16T02:06:47+08:00
```

## Output Guidance

For simple status requests, report the CLI result concisely instead of reformatting every field. For continuation requests, include the plan file path, the current state, and the immediate next action.
