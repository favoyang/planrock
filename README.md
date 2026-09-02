# Planrock

Planrock is a CLI, shared indexer, and set of agent skills for saved Markdown
plans. Repository-local `plans/*.md` files stay authoritative. An optional
cross-project registry and disposable index under `~/.agents/planrock` power a
deterministic overview and an unrestricted, on-demand dashboard.

## Skill Install

Install the Planrock skill globally for an agent runtime that supports skills:

```bash
npx skills add favoyang/planrock -g -y
```

URL form:

```bash
npx skills add https://github.com/favoyang/planrock -g -y
```

You can also ask an agent with skill-install support to install `favoyang/planrock`.

The skill uses its bundled CLI directly, so a global `planrock` shell command is not required for an agent to use the skill.
The repository includes CI-verified production dashboard assets so Git-based
Skills CLI installations have the same dashboard as the published npm package.

## CLI Install

Run without installing:

```bash
npx @favoyang/planrock status
```

Install globally with npm:

```bash
npm install -g @favoyang/planrock
planrock status
```

Install globally with mise:

```bash
mise use -g npm:@favoyang/planrock
planrock status
```

Link from a local checkout:

```bash
git clone https://github.com/favoyang/planrock.git
cd planrock
npm link
planrock status
```

## Usage

```bash
planrock status
planrock pending
planrock active
planrock open
planrock open --sort time
planrock open --full-agent-session
planrock closed
planrock goal plans/example-plan.md
planrock project add /path/to/repository --name example
planrock refresh
planrock overview
planrock dashboard start
planrock dashboard stop
```

By default, Planrock reads `plans/` under the current working directory. Use `--working-dir /path/to/repo` when you want to inspect a different repository. Add `--json` for machine-readable output.

`pending` and `active` are workflow views of the authored lifecycle. An open
plan is active when it has at least one checked checklist item or at least one
`agent_sessions` entry; otherwise it is pending. A closed plan is always
closed. Consequently, a zero-checklist plan is pending until a session is
recorded, a session-only plan is active, and a fully checked plan remains
active until its frontmatter is formally changed to `state: closed`.

`planrock open` remains the backward-compatible aggregate of pending and active
plans. `planrock status` reports open, pending, active, closed, and invalid
counts, then displays separate pending and active sections. Plans with missing
or unsupported `state` values or structurally malformed frontmatter are counted
as invalid and excluded from all lifecycle collections. For compatibility, the
local CLI still ignores unsupported nested fields and lets the last duplicate
scalar key win. JSON adds `workflow` to plan
records and adds `pending`, `active`, and `invalid` summary fields while
preserving the existing `open`, `closed`, and `recentOpenPlans` fields.

The cross-project registry is opt-in. Every explicit root may contribute its
own direct `plans/` and bounded child Git repositories with direct `plans/`.
Planrock never traverses symlinks and treats linked worktrees and submodules as
explicit-registration-only. It also performs a one-way, optional import from a
valid fixed TaskChef schema-2 file without depending on TaskChef code or
runtime state.

### Registry ignores

`~/.agents/planrock/planrock.json` uses schema version 2 and contains one
top-level `ignore` array. New registries use `"ignore": []`. Configured entries
extend Planrock's built-in pruning of version-control, dependency, build,
output, cache, temporary, and virtual-environment directories, including
`.uv-cache`, `.npm-cache`, `.deps`, and `.agents`.

Non-absolute entries match directories inside every registered project. An
entry without `/` is a case-sensitive directory-name pattern at any depth; an
entry containing `/` is a case-sensitive, project-root-relative pattern.
Backslashes are normalized to `/`, `*` matches within one path segment, a
whole `**` segment may span path segments, and `?` matches one non-separator character. Negation,
escaping above a project root, per-project ignores, and implicit `.gitignore`
loading are not supported. A relative pattern is never applied to the
registered root itself, even when its basename matches.
The array is limited to 512 entries and 256 KiB of pattern text. Each pattern
is also bounded to 256 segments and 1,024 wildcard tokens; Planrock validates
and compiles the segments once before bounded, non-backtracking discovery.

Canonical absolute entries have one narrower meaning: they exclude that exact
project root from automatic TaskChef import and scanning. Removing a
TaskChef-imported project adds its canonical root to `ignore`; explicitly
adding or relinking the exact root removes that automatic exclusion. Planrock
migrates canonical absolute schema-1 `suppressions.taskchef` tombstones to
`ignore` while preserving project identities and discovery settings. Relative
or malformed legacy suppressions are rejected rather than reinterpreted as
global patterns. Invalid, ambiguous, oversized, or
unsupported entries reject the refresh and appear in the latest scan attempt;
the last usable index remains available.

### Latest scan health

Planrock keeps exactly one bounded latest-attempt record in
`~/.agents/planrock/latest-scan.json`, separate from the latest usable
`index.json`. The record contains timing, trigger, outcome, snapshot identity,
diagnostics, and invalid-plan metadata. A successful or incomplete refresh
updates both records; a failed refresh updates only the attempt record, so CLI
and dashboard readers continue to use the previous valid index. Managed files
remain owner-only, non-symlink, size-bounded, and atomically replaced.

The dashboard listens on all IPv4 interfaces at port `4210` by default so
multiple local or LAN viewers can open it without authentication. `--port` overrides
the port for that invocation and is not persisted. `start` and `open` return a
plain `http://127.0.0.1:<port>/` URL for local use; replace the host with the
machine's LAN address for another device.

Only run the dashboard on a trusted local network: every viewer can read the
indexed plans and Markdown documents they link. Remote viewers are read-only;
refresh, system-file, chat, and lifecycle controls remain host-only.

The home-page health badge opens **Index health**, where the latest attempt's
registry issues, invalid plans, and scan diagnostics are shown without scan
history or aggregate issue counts. Refresh is available there only to a local
viewer. The dashboard's Pending, Active, Open, and Closed views use the same
workflow definitions as the CLI, with Open selected by default.

Unauthenticated dashboards use lifecycle control protocol 2. Current Planrock
can hand off a legacy authenticated protocol-1 dashboard, but older protocol-1
CLIs cannot manage a protocol-2 listener and must not modify its owner record.

Use `planrock goal <path-to-plan>` to print a copy-pasteable Codex `/goal`
command from the readable Goal section. The output also includes a stable
`plans/...` reference for the original plan file.

When using `--working-dir`, repo-relative goal paths resolve from that selected
working directory:

```bash
planrock goal plans/example-plan.md --working-dir /path/to/repo
```

Plan files live directly under `plans/` and use YAML frontmatter:

```markdown
---
title: Publish Planrock
state: open
priority: P1
created_at: 2026-06-13
agent_sessions:
  - codex:example-session-id
---

- [ ] Do the next concrete step.
```

### Agent Sessions

Use `agent_sessions` to record the agent sessions that have worked on a plan. Each entry uses `<agent-slug>:<session-id>`.

Supported agent slugs:

- `codex`
- `claude-code`

Unknown agents should use a stable lowercase slug such as `local-agent`. Planrock preserves unknown slugs instead of rejecting them. Human output shortens each entry to the slug plus the first 8 characters of the session id, such as `claude-code:example-`; use `--full-agent-session` to show complete values.

## Release

Releases are automated with semantic-release from GitHub Actions on `main`. Use Semantic Commit Messages so the release type can be calculated:

```text
fix: correct plan parsing
feat: add a new CLI command
feat!: change plan file format
```

Publishing is handled by the release workflow.

## Development

```bash
npm test
npm pack --dry-run
npx -y -p semantic-release@25 -p @semantic-release/git semantic-release --dry-run
```

## License

MIT
