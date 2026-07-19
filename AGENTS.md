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
4. Run relevant validation.
5. Run the review gate and address any valid findings.
6. Commit, push the branch, and open or update the GitHub pull request.
7. Verify required checks.
8. Ask the user before merging unless the change is obviously safe and
   mechanical, or the user already gave merge approval in advance.
9. After merge, update the main checkout with `git pull --ff-only`.

When working from a plan, after finishing any item, always state the next concrete step. Continue doing this until the plan is genuinely complete so the user does not need to ask "what's next?".

When a change is merged to `main`, confirm GitHub Actions completes. If semantic-release publishes a version, pull the release commit back before continuing so local `package.json` matches npm.

For release-producing changes, the automated deploy workflow is the `Release`
GitHub Actions workflow. After merging:

- Watch the `Release` workflow on `main` until it finishes.
- Confirm both the `Test` and `Release` jobs succeeded, unless the release job
  is intentionally skipped by `NPM_TRUSTED_PUBLISHING_READY`.
- Check the published package when semantic-release runs, for example
  `npm view @favoyang/planrock version`.
- Pull `main` again after a successful semantic-release run because the workflow
  may push a `chore(release): ... [skip ci]` version commit back to the
  repository.
- Clean up the feature worktree only after local `main` includes the merge and
  any release commit.

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

## Pull Request Delivery Workflow

Deliver repository changes through pull requests by default, regardless of
size. Do not make changes directly in the main checkout unless the user
explicitly approves an exception. Direct commits to `main` or the default
branch should be limited to explicit user-approved exceptions.

Follow this delivery sequence:

1. Create a dedicated topic branch. Use a separate worktree when repository
   guidance requires one or when isolation is useful.
2. Make the requested change and run relevant validation.
3. Update plan progress when working from a saved plan.
4. Run the review gate, fix valid findings, revalidate, and repeat the review
   until it passes.
5. Close the plan when appropriate, then commit and push the reviewed change.
6. Create or update the GitHub pull request with a brief summary and the
   validation commands that were run.
7. Verify required checks and merge when there is no blocking reason.
8. Monitor deployment when applicable, then clean up the worktree and branch.

Do not interpret short requests such as "commit", "publish the change", "ship
it", "push it", or "merge it" as approval to bypass this workflow. Unless the
user explicitly says to work directly on the default branch, skip the pull
request workflow, or make a direct-default-branch exception, continue the
normal flow on the dedicated topic branch, using a separate worktree when
applicable.

Direct-default-branch exceptions still need a clean scope check before
committing. When an exception is approved, state that the normal pull request
workflow is being bypassed because of the explicit exception.

Before committing, run `git status --short` and verify the staged files match
the requested change. Stage files by exact path when possible. Avoid broad
staging commands such as `git add .` when unrelated local work exists.

Include screenshots in the pull request only if a change affects rendered UI,
generated visual output, or external presentation.

## Review Gate

Before committing, use the installed `$branch-review-subagent-loop` skill to
review the complete branch diff. Follow the skill through any required fixes,
validation, and re-review. If the skill is unavailable, ask the user to install
it before continuing.

Create, update, or merge the pull request only after the review gate passes.
Merging also requires green checks unless the user explicitly accepts the
remaining risk.
