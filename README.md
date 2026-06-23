# Planrock

Planrock is a small CLI and agent skill for saved Markdown plans. It reads plan files under a repository-local `plans/` directory, summarizes open and closed plans, and displays checklist progress plus agent session markers.

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
planrock open
planrock open --sort time
planrock open --full-agent-session
planrock closed
planrock goal plans/example-plan.md
```

By default, Planrock reads `plans/` under the current working directory. Use `--working-dir /path/to/repo` when you want to inspect a different repository. Add `--json` for machine-readable output.

Use `planrock goal <path-to-plan>` to print a copy-pasteable Codex `/goal` command from the body of the plan's `## Goal` section. The output ends with a stable `plans/...` reference for the original plan file.

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
