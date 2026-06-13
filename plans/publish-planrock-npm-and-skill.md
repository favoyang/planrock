---
title: Publish Planrock npm package and skill
state: open
priority: P1
created_at: 2026-06-13
agent_sessions:
  - codex:019ebfe3-da12-7e90-96ae-236357cded77
---

- [x] Make the Planrock repository public on GitHub and verify the public URL used by npm, README, and skill install examples.
- [x] Confirm the npm package name before the first publish and decide whether the first package reservation happens through trusted publishing or a one-time manual publish.
- [x] Rename/configure the npm package as `@favoyang/planrock`, remove the `private: true` publish blocker, keep the existing `planrock` CLI bin, and include only intended package files.
- [ ] Configure npm trusted publishing for the GitHub repository as the publish source, including package provenance where supported.
- [x] Add GitHub Actions release automation using semantic-release so version calculation, npm publishing, and any package version mutation happen only in CI and are not committed back from local development.
- [x] Add semantic-release configuration for Semantic Commit Messages, npm publishing, GitHub releases, and a practical dry-run path.
- [x] Add `README.md` covering what the repo contains, skill installation with `npx skills add favoyang/planrock -g -a codex -y` and URL form, and CLI installation with `npx @favoyang/planrock`, `npm install -g @favoyang/planrock`, `volta install @favoyang/planrock`, and local `npm link`.
- [x] Add an MIT license.
- [x] Add `AGENTS.md` if missing, including the requirement to use Semantic Commit Messages for semantic-release compatibility.
- [x] Run tests, validate the package tarball contents, and run semantic-release dry-run where practical, then update the plan with any publish-time follow-up.

Notes:

- Public GitHub repo created at `https://github.com/favoyang/planrock` and configured as `origin`.
- npm still returns 404 for `planrock`, so the package name is available at implementation time.
- npm 11.12 documents that `npm trust` requires the package to already exist, so `@favoyang/planrock@0.0.1` was published once locally to bootstrap the package. After manual npm trusted publishing setup, set `NPM_TRUSTED_PUBLISHING_READY=true` so the GitHub release workflow can publish future releases through OIDC.
- Release job is gated by repository variable `NPM_TRUSTED_PUBLISHING_READY=true` so normal pushes can establish workflow changes before npm trusted publishing is configured.
- `npm test`, `npm pack --dry-run`, and `git diff --check` pass locally. GitHub Actions test/package validation passes on `main`; the release job is intentionally skipped while `NPM_TRUSTED_PUBLISHING_READY` is unset.
- Testing without `safe` and relying on `~/.npmrc` also fails `npm whoami` with `E401`; `npm publish --dry-run --tag dev --provenance=false` succeeds for tarball validation, but dry-run does not prove publish authentication.
- After refreshing `safe` secrets, semantic-release dry-run with command-scoped `GITHUB_TOKEN,NPM_TOKEN` succeeds. It verifies npm and GitHub auth, selects initial release `1.0.0`, and skips publishing because of dry-run mode. Standalone `npm whoami` does not read `NPM_TOKEN` directly, but semantic-release writes it to a temporary `.npmrc` and verifies successfully.
- One-time local bootstrap publish was attempted with temporary version `0.0.1` and a temporary `.npmrc` backed by `safe` `NPM_TOKEN`. npm accepted the token and reached publish, then blocked with `EOTP`; the npm account/token requires one-time browser/OTP authentication for writes. `package.json` was restored to `0.0.0-development`.
- After updating `safe` `NPM_TOKEN`, one-time local bootstrap publish reached npm without OTP but was rejected with `E403`: unscoped package name `planrock` is too similar to existing package `la9rock`. npm suggested publishing as `@favoyang/planrock`; that scoped name currently returns 404 and appears available.
- Switched package metadata and docs to scoped package `@favoyang/planrock`. The installed CLI command remains `planrock` via `bin.planrock`.
- Published one-time bootstrap package `@favoyang/planrock@0.0.1` locally with `safe` `NPM_TOKEN`. npm initially exposed dist-tags but returned package metadata 404; `npm access set status=public @favoyang/planrock` repaired visibility. `npm view @favoyang/planrock` and `npm exec --package @favoyang/planrock@0.0.1 -- planrock --help` now work.
- A local real semantic-release run with `CI=true` was attempted for `1.0.0`, but npm publish failed with `EOTP`. semantic-release had created and pushed tag `v1.0.0` before npm failed; the false tag was deleted locally and from GitHub, `package.json` was restored, and generated `dist/` output was removed.
- `npm trust github @favoyang/planrock --repo favoyang/planrock --file release.yml` still fails with `E403` because npm requires two-factor authentication for the trust configuration request. This must be completed with an npm session that can satisfy 2FA, then `NPM_TRUSTED_PUBLISHING_READY=true` can be set for the GitHub release workflow.
- After trust was manually configured, the GitHub release workflow still failed because it used `semantic-release@24` plus `actions/setup-node` `registry-url`, causing `@semantic-release/npm` to require token auth from an `.npmrc`. Workflow was updated to `semantic-release@25` and no `registry-url` so npm trusted publishing can use GitHub OIDC.
