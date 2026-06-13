# Planrock

Planrock is a small CLI and Codex skill for saved Markdown plans. It reads plan files under a repository-local `plans/` directory, summarizes open and closed plans, and displays checklist progress plus agent session markers.

## Skill Install

Install the Planrock skill globally for Codex:

```bash
npx skills add favoyang/planrock -g -a codex -y
```

URL form:

```bash
npx skills add https://github.com/favoyang/planrock -g -a codex -y
```

The skill uses its bundled CLI directly, so a global `planrock` shell command is not required for Codex to use the skill.

## CLI Install

Run without installing:

```bash
npx planrock status --working-dir /path/to/repo
```

Install globally with npm:

```bash
npm install -g planrock
planrock status --working-dir /path/to/repo
```

Install globally with Volta:

```bash
volta install planrock
planrock status --working-dir /path/to/repo
```

Link from a local checkout:

```bash
git clone https://github.com/favoyang/planrock.git
cd planrock
npm link
planrock status --working-dir /path/to/repo
```

## Usage

```bash
planrock status --working-dir .
planrock open --working-dir .
planrock open --working-dir . --sort time
planrock open --working-dir . --full-agent-session
planrock closed --working-dir .
```

Add `--json` for machine-readable output.

Plan files live directly under `plans/` and use YAML frontmatter:

```markdown
---
title: Publish Planrock
state: open
priority: P1
created_at: 2026-06-13
agent_sessions:
  - codex:019ebfe3-da12-7e90-96ae-236357cded77
---

- [ ] Do the next concrete step.
```

## Release

Releases are automated with semantic-release from GitHub Actions on `main`. Use Semantic Commit Messages so the release type can be calculated:

```text
fix: correct plan parsing
feat: add a new CLI command
feat!: change plan file format
```

The npm package is intended to publish through npm trusted publishing from the public `favoyang/planrock` GitHub repository. npm requires a package to already exist before a trusted publisher can be configured, so bootstrap the package once with an npm automation token stored as the repository secret `NPM_TOKEN`. After that first semantic-release run creates `planrock` on npm, configure trusted publishing:

```bash
npm trust github planrock --repo favoyang/planrock --file release.yml
```

Then remove the temporary `NPM_TOKEN` repository secret and enable the release job:

```bash
gh variable set NPM_TRUSTED_PUBLISHING_READY --body true --repo favoyang/planrock
```

## Development

```bash
npm test
npm pack --dry-run
npx -y semantic-release@24 --dry-run
```

## License

MIT
