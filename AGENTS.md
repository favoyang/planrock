# Agent Instructions

## Repository Shape

Planrock is a small Node.js CLI package and Codex skill for saved Markdown plans.

- `scripts/planrock` is the executable CLI.
- `SKILL.md` is the installable Codex skill entry point.
- `agents/` contains published agent integration metadata.
- `plans/` contains repository-local saved plans and is not part of the npm package.
- `tests/planrock.test.js` covers CLI behavior with Node's built-in test runner.
- `.github/workflows/release.yml` runs tests, validates the npm tarball, and publishes through semantic-release.

Keep changes scoped. Prefer updating the existing CLI script and test file over introducing new dependencies or structure unless the change clearly needs it.

## Agent Workflow

Use a git worktree for implementation work by default. Create a branch-specific worktree outside the main checkout, make changes there, and open a pull request from that branch. Use the main checkout only for inspection, tiny documentation-only edits, or emergency follow-up work where the user explicitly asks for direct changes.

Default flow:

1. Inspect the current state from the main checkout.
2. Create or use a task branch worktree for implementation.
3. Make the smallest coherent change.
4. Run validation before requesting review.
5. Push the branch and open a GitHub PR.
6. Ask `@codex` for review on the PR.
7. Address review feedback in commits on the same branch and repeat review until no blocking issues remain.
8. Ask the user before merging unless the change is obviously safe and mechanical, or the user already gave merge approval in advance.
9. After merge, update the main checkout with `git pull --ff-only`.

After asking `@codex` for review, proactively check the PR review state before handing off. If review feedback appears, inspect unresolved review threads, fix all actionable blocking issues on the same branch, rerun validation, push the fixes, and request review again. Do not wait for the user to explicitly ask for the review loop to continue.

When a change is merged to `main`, confirm GitHub Actions completes. If semantic-release publishes a version, pull the release commit back before continuing so local `package.json` matches npm.

## Commits And Releases

Use Semantic Commit Messages for every commit so semantic-release can calculate package versions:

- `fix: ...` for patch releases.
- `feat: ...` for minor releases.
- `feat!: ...` or a `BREAKING CHANGE:` footer for major releases.
- `chore: ...`, `docs: ...`, `test: ...`, and `ci: ...` for changes that should not publish a release.

Do not manually edit `package.json` versions for ordinary feature or fix work. GitHub Actions runs semantic-release on `main`, owns npm publishing, and commits release version updates back with `chore(release): ... [skip ci]`.

If plan updates are part of implementing a feature or fix, commit them together with that feature or fix. Only plan-only or agent-instruction-only changes should avoid release automation; use a non-release commit type and include `[skip ci]` when appropriate. The release workflow also ignores pushes that only touch `AGENTS.md` or `plans/**`.

## Package Contents

The npm package is allowlisted through `package.json` `files`.

Publish:

- `SKILL.md`
- `agents/`
- `scripts/planrock`
- `README.md`
- `LICENSE`

Do not publish:

- `AGENTS.md`
- `plans/`
- tests or local development artifacts

Validate package contents with `npm pack --dry-run` whenever changing package metadata, skill files, CLI files, or publish configuration.

## Plan Files

Plans live directly under `plans/` as Markdown files with YAML frontmatter. Keep checklist items concrete and update them when work is completed. Use `agent_sessions` for cross-agent session markers, including Codex session IDs when available.

Plan-only changes should normally use `docs: ... [skip ci]` or another non-release commit message. If a plan changes as part of an implementation, commit it with the implementation instead.

## Validation

Before handing off changes, run:

```bash
npm test
npm pack --dry-run
```

If the default npm cache is not writable, use a temporary cache:

```bash
npm_config_cache=/private/tmp/planrock-npm-cache npm pack --dry-run
```
