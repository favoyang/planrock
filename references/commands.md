# Planrock commands and metadata

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
node <skill-dir>/scripts/planrock create <slug> --title "<short title>" --priority P2 --working-dir <working-dir>
node <skill-dir>/scripts/planrock validate [<working-dir>/plans/<plan>.md] --working-dir <working-dir>
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
- `create <slug> --title <short-title>`: Create a non-overwriting canonical
  plan template under `plans/`; optionally select `--priority P0-P4`.
- `validate [path-to-plan]`: Strictly validate one plan, or every direct
  `plans/*.md` file when no path is supplied. Warnings and errors both produce
  a non-zero exit so inconsistent but processable metadata cannot pass.
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

Except for `create`, the repository-local CLI is read-only. It parses Markdown files directly under `plans/`, reads scalar YAML frontmatter keys `title`, `state`, `priority`, `created_at`, and `closed_at`, reads list frontmatter key `agent_sessions`, and counts checklist items matching `- [ ]` and `- [x]`. Plans without `priority` are treated as `P2`.

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
