---
name: planrock
description: "Create, inspect, or continue saved Markdown plans in the current working directory’s plans/ folder. Use for Planrock or saved-plan requests, not general planning discussion."
---

# Planrock

This skill owns repository-local saved-plan creation, inspection,
reconciliation, continuation, and closure. Use `$planrock-bootstrap` for the
cross-project registry/index and `$planrock-dashboard` for dashboard lifecycle.

## Select the operation

Resolve `<skill-dir>` to this installed skill's directory. For inventory, use
`node <skill-dir>/scripts/planrock status --working-dir <working-dir>`;
use `open --json` to select an unknown plan. Read
[commands and metadata](references/commands.md) for filters, sorting, workflow
states, priority values, or session display options.

Use only `plans/` directly under the current working directory; do not search
parents for another plan store. Report a missing directory for inspection;
creation can create it. Ask for a different directory only when needed to
continue the request. Read-only inspection must not mutate plans or sessions.

## Creating A Plan

When the user asks to create a saved plan, run
`node <skill-dir>/scripts/planrock create <slug> --title "<short title>" --priority <P0-P4> --working-dir <working-dir>`.
The command
creates `plans/` when needed, refuses to overwrite an existing plan, and fills
canonical lifecycle, date, priority, and session metadata. Replace the
generated Goal and Steps placeholders with the user's concrete outcome and a
concise checklist, then run
`node <skill-dir>/scripts/planrock validate <path> --working-dir <working-dir>`.
Do not report creation
complete until validation exits successfully. The new plan is pending until a
checklist item is checked or an agent session is recorded.

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
11. After every plan mutation, including checklist, session, metadata, and
    closure changes, run
    `node <skill-dir>/scripts/planrock validate <path> --working-dir <working-dir>`
    and correct every reported
    warning or error before continuing.
12. When a plan is genuinely complete, close it according to that working directory's plan rules and validate the closed plan again.

Agent sessions frontmatter example:

```yaml
agent_sessions:
  - codex:01932f7f-930f-7052-999f-e3b083d9373f
  - claude-code:982f38ab-930f-7052-999f-e3b083d9373f
```

## Output Guidance

For simple status requests, report the CLI result concisely instead of reformatting every field. For continuation requests, include the plan file path, the current state, and the immediate next action.
