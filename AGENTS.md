# Agent Instructions

## Commits

Use Semantic Commit Messages for every commit so semantic-release can calculate package versions:

- `fix: ...` for patch releases.
- `feat: ...` for minor releases.
- `feat!: ...` or a `BREAKING CHANGE:` footer for major releases.
- `chore: ...`, `docs: ...`, `test: ...`, and `ci: ...` for changes that should not publish a release.

Do not manually edit `package.json` versions for ordinary feature or fix work. GitHub Actions runs semantic-release on `main`, owns npm publishing, and commits release version updates back with `chore(release): ... [skip ci]`.

## Validation

Before handing off changes, run:

```bash
npm test
npm pack --dry-run
```
