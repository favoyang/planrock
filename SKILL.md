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
node <skill-dir>/scripts/planrock closed --working-dir <working-dir>
```

Add `--json` when structured output helps automation or follow-up analysis.

Use `plans/` directly under the current working directory as the convention. Do not search parent directories for a different `plans/` directory. If `<working-dir>/plans` does not exist, warn the user that no `plans/` directory was found in the current working directory and ask for a different working directory only when the request cannot proceed without it.

## Commands

- `status`: Show summary counts plus the 10 most recent open plans and 10 most recent closed plans.
- `open`: Show all open plans, newest `created_at` first.
- `closed`: Show all closed plans, newest `closed_at` first.

The CLI is read-only. It parses Markdown files directly under `plans/`, reads YAML frontmatter keys `title`, `state`, `created_at`, and `closed_at`, and counts checklist items matching `- [ ]` and `- [x]`.

## Creating A Plan

When the user asks to create a saved plan, create a Markdown file directly under `<working-dir>/plans/`. If no `plans/` directory exists in the current working directory, warn the user and create `plans/` only when the user has asked to create a saved plan there.

Use this frontmatter:

```yaml
---
title: <short title>
state: open
created_at: <YYYY-MM-DD>
---
```

Then write a concise checklist of concrete implementation steps using `- [ ]`.

## Continuing A Plan

When the user asks to continue, implement, or inspect a specific saved plan:

1. Run `node <skill-dir>/scripts/planrock open --working-dir <working-dir> --json` unless the plan file is already known.
2. Open the relevant plan Markdown file.
3. Summarize the current state and identify the next concrete unchecked step.
4. Before editing any repository code, follow the working directory or repository instructions that govern that plan.
5. After completing a plan item, update the plan file if appropriate and state the next concrete step.
6. When a plan is genuinely complete, close it according to that working directory's plan rules.

## Output Guidance

For simple status requests, report the CLI result concisely instead of reformatting every field. For continuation requests, include the plan file path, the current state, and the immediate next action.
