---
title: Add pending and active CLI status
state: closed
priority: P1
created_at: 2026-09-02
closed_at: 2026-09-02
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
- [x] Merge the feature PR, verify release publication, and update the installed skill and CLI package.

## Delivery

- Feature: https://github.com/favoyang/planrock/pull/21
- Release: `v1.5.0` / `@favoyang/planrock@1.5.0`
- Installed: global Skills CLI copy and mise-managed CLI both refreshed and verified.

Repository worktree and branch cleanup follows this closure commit under the repository delivery policy.
