---
title: Add pending and active CLI status
state: open
priority: P1
created_at: 2026-09-02
agent_sessions:
  - codex:01a06025-07b1-73b2-98f9-6892153a6dc7
---

## Goal

Expose the dashboard's pending and active plan semantics through the repository-local Planrock CLI while preserving `open` compatibility and shipping the result through the normal reviewed release workflow.

## Canonical Status Semantics

- `closed`: frontmatter `state: closed`, regardless of progress or sessions.
- `active`: frontmatter `state: open` and either at least one checked checklist item or at least one normalized agent session.
- `pending`: frontmatter `state: open` with no checked checklist items and no normalized agent sessions.
- Missing or unsupported lifecycle state is invalid and excluded from lifecycle and workflow collections. A fully checked but still-open plan remains active until formally closed.

## Steps

- [x] Inspect repository guidance, existing plans, dashboard classification, parser, and local CLI behavior.
- [x] Extract the dashboard workflow classifier and add pending/active/open local CLI projections.
- [x] Update status output, JSON, help, README, skill guidance, and packaged/generated artifacts.
- [x] Add domain, CLI, compatibility, malformed-input, sorting, JSON, and dashboard parity tests.
- [x] Run formatting/build/type-equivalent checks, tests, package validation, and independent review until clean.
- [ ] Close this plan, commit, push, open and merge the PR, verify release publication, update the installed skill/package, and clean up.
