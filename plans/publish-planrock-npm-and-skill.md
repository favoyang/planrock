---
title: Publish Planrock npm package and skill
state: open
priority: P1
created_at: 2026-06-13
agent_sessions:
  - codex:019ebfe3-da12-7e90-96ae-236357cded77
---

- [x] Make the Planrock repository public on GitHub and verify the public URL used by npm, README, and skill install examples.
- [x] Confirm `planrock` remains available on npm before the first publish and decide whether the first package reservation happens through trusted publishing or a one-time manual publish.
- [x] Rename/configure the npm package as `planrock`, remove the `private: true` publish blocker, keep the existing `planrock` CLI bin, and include only intended package files.
- [ ] Configure npm trusted publishing for the GitHub repository as the publish source, including package provenance where supported.
- [x] Add GitHub Actions release automation using semantic-release so version calculation, npm publishing, and any package version mutation happen only in CI and are not committed back from local development.
- [x] Add semantic-release configuration for Semantic Commit Messages, npm publishing, GitHub releases, and a practical dry-run path.
- [x] Add `README.md` covering what the repo contains, skill installation with `npx skills add favoyang/planrock -g -a codex -y` and URL form, and CLI installation with `npx planrock`, `npm install -g planrock`, `volta install planrock`, and local `npm link`.
- [x] Add an MIT license.
- [x] Add `AGENTS.md` if missing, including the requirement to use Semantic Commit Messages for semantic-release compatibility.
- [x] Run tests, validate the package tarball contents, and run semantic-release dry-run where practical, then update the plan with any publish-time follow-up.

Notes:

- Public GitHub repo created at `https://github.com/favoyang/planrock` and configured as `origin`.
- npm still returns 404 for `planrock`, so the package name is available at implementation time.
- npm 11.12 documents that `npm trust` requires the package to already exist, so first package reservation needs a one-time token-backed semantic-release run in GitHub Actions. After `planrock` exists, configure trusted publishing with `npm trust github planrock --repo favoyang/planrock --file release.yml`, remove the temporary `NPM_TOKEN` secret, then set `NPM_TRUSTED_PUBLISHING_READY=true`.
- Release job is gated by repository variable `NPM_TRUSTED_PUBLISHING_READY=true` so the first push can establish the default branch and workflow before npm trusted publishing is configured.
- `npm test`, `npm pack --dry-run`, and `git diff --check` pass locally. GitHub Actions test/package validation passes on `main`; the release job is intentionally skipped while `NPM_TRUSTED_PUBLISHING_READY` is unset.
- Testing without `safe` and relying on `~/.npmrc` also fails `npm whoami` with `E401`; `npm publish --dry-run --tag dev --provenance=false` succeeds for tarball validation, but dry-run does not prove publish authentication.
- After refreshing `safe` secrets, semantic-release dry-run with command-scoped `GITHUB_TOKEN,NPM_TOKEN` succeeds. It verifies npm and GitHub auth, selects initial release `1.0.0`, and skips publishing because of dry-run mode. Standalone `npm whoami` does not read `NPM_TOKEN` directly, but semantic-release writes it to a temporary `.npmrc` and verifies successfully.
