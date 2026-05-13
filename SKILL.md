---
name: planrock
description: Inspect, summarize, and continue Markdown saved plans stored in a workspace plans/ directory. Use when the user asks for saved plans, open plans, closed plans, recent closed plans, plan status, plan progress, or to continue/implement a saved plan; especially for workspaces that store durable plans as Markdown files with YAML frontmatter and checklist items.
---

# Planrock

## Quick Start

Use the bundled CLI first for read-only plan inventory requests:

```bash
node <skill-dir>/scripts/planrock status --workspace <workspace-root>
node <skill-dir>/scripts/planrock open --workspace <workspace-root>
node <skill-dir>/scripts/planrock closed --workspace <workspace-root>
```

Add `--json` when structured output helps automation or follow-up analysis.

If `<workspace-root>/plans` does not exist, search upward from the current working directory for a `plans/` directory. If that fails, ask the user for the workspace root.

## Commands

- `status`: Show summary counts plus the 10 most recent open plans and 10 most recent closed plans.
- `open`: Show all open plans, newest `created_at` first.
- `closed`: Show all closed plans, newest `closed_at` first.

The CLI is read-only. It parses Markdown files directly under `plans/`, reads YAML frontmatter keys `title`, `state`, `created_at`, and `closed_at`, and counts checklist items matching `- [ ]` and `- [x]`.

## Continuing A Plan

When the user asks to continue, implement, or inspect a specific saved plan:

1. Run `node <skill-dir>/scripts/planrock open --workspace <workspace-root> --json` unless the plan file is already known.
2. Open the relevant plan Markdown file.
3. Summarize the current state and identify the next concrete unchecked step.
4. Before editing any repository code, follow the workspace or repository instructions that govern that plan.
5. After completing a plan item, update the plan file if appropriate and state the next concrete step.
6. When a plan is genuinely complete, close it according to that workspace's plan rules.

## Output Guidance

For simple status requests, report the CLI result concisely instead of reformatting every field. For continuation requests, include the plan file path, the current state, and the immediate next action.
