# Agent Instructions

## Commits

Use Semantic Commit Messages for every commit so semantic-release can calculate package versions:

- `fix: ...` for patch releases.
- `feat: ...` for minor releases.
- `feat!: ...` or a `BREAKING CHANGE:` footer for major releases.
- `chore: ...`, `docs: ...`, `test: ...`, and `ci: ...` for changes that should not publish a release.

Do not manually edit `package.json` versions for ordinary feature or fix work. GitHub Actions runs semantic-release on `main`, owns npm publishing, and commits release version updates back with `chore(release): ... [skip ci]`.

After pushing to `main`, confirm GitHub Actions finishes. If semantic-release publishes a version, pull the release commit back before continuing so local `package.json` matches npm.

If plan updates are part of implementing a feature or fix, commit them together with that feature or fix. Only plan-only or agent-instruction-only changes should avoid release automation; use a non-release commit type and include `[skip ci]` when appropriate. The release workflow also ignores pushes that only touch `AGENTS.md` or `plans/**`.

## Validation

Before handing off changes, run:

```bash
npm test
npm pack --dry-run
```
