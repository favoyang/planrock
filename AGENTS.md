# Agent Instructions

## Repository Shape

Planrock is a Node.js CLI package and Codex skill for saved Markdown plans.

- `scripts/planrock` is the executable; `lib/` owns supporting runtime code.
- `SKILL.md`, `references/`, `skills/`, and `agents/` contain packaged skills,
  references, and agent integration metadata.
- `dashboard/` contains UI source; `dist/dashboard/` contains tracked assets.
- `tests/` covers CLI, indexing, and loopback-server behavior.
- `plans/` contains repository-local Markdown plans with YAML frontmatter.
- `.github/workflows/release.yml` owns release validation and npm publishing.

Prefer the existing implementation and tests unless a change needs new
structure or dependencies. Edit `AGENTS.md` directly for repository-specific
instruction changes.

## Working And Release Boundaries

Use a branch-specific worktree outside the canonical checkout for changes.
Direct changes require an explicit user exception under the global delivery
policy. Keep plan checklist items concrete and update progress with the
implementation; use `agent_sessions` for cross-agent session markers. Report
the next step when it helps explain remaining work or a blocker.

Use Semantic Commit Messages: `fix:` for patches, `feat:` for features, and
`feat!:` or a `BREAKING CHANGE:` footer for breaking changes. Use `docs:`,
`chore:`, `test:`, or `ci:` for changes that should not publish a release.
Commit plan changes with the implementation they describe; use a non-release
type for plan-only or instruction-only changes. Do not manually edit package
versions for ordinary feature or fix work.

After an authorized merge, watch the `Release` workflow when it is triggered.
Confirm all validation jobs pass, including `Test` and `Node 18 packaged
runtime`, and that `Release` succeeds or is intentionally skipped because
`NPM_TRUSTED_PUBLISHING_READY` is disabled. The workflow ignores pushes touching only `AGENTS.md` or `plans/**`.
When semantic-release publishes, verify the npm version with
`npm view @favoyang/planrock version`. Fast-forward the clean canonical `main`
with `git pull --ff-only` after the workflow finishes so it contains both the
merge and any automated version commit before worktree cleanup.

## Validation And Packaging

Select checks by the changed surface; required CI checks remain mandatory:

- Instructions and plans: check referenced paths and Markdown/YAML structure.
- CLI or runtime: run `npm test`. For loopback-server changes, run
  `PLANROCK_SERVER_TESTS=1 npm test` so server tests are not skipped.
- Dashboard: run `npm run test:dashboard` and `npm run build:dashboard`; commit
  the resulting tracked assets with their source change.
- Package metadata, skill files, CLI/runtime files, assets, or publish config:
  run `npm pack --dry-run` and inspect the allowlist; run
  `npm run validate:package` for changes affecting installed runtime behavior
  or package contents.

`package.json` `files` is the package-content authority. Keep needed runtime
and skill references included; keep instruction files, plans, tests, and local
development artifacts excluded. Packaging runs `prepack`, which rebuilds the
dashboard. The dashboard embeds package metadata, so metadata changes can also
require regenerated tracked assets. Inspect that diff rather than discarding
it as incidental.
