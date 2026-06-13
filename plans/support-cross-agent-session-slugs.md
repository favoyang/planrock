---
title: Support cross-agent session slugs
state: closed
priority: P2
created_at: 2026-06-13
closed_at: 2026-06-13
agent_sessions:
  - codex:019ec0d9-fc2c-7ee0-b7d6-9d0fb6a493f2
---

- [x] Define the canonical agent slug list for `agent_sessions`, starting with `codex` and `claude-code`, and decide how unknown agents should be represented.
- [x] Review current Planrock CLI parsing and display behavior for `agent_sessions` values such as `codex:<session-id>` and `claude-code:<session-id>`.
- [x] Update the Planrock skill instructions so Codex records `codex:<CODEX_THREAD_ID>` and Claude Code records the best available `claude-code:<session-id>` value.
- [x] Add tests covering multiple agent slugs, full and shortened session display, ordering, and preservation of unknown agent slugs.
- [x] Document the supported agent slug list and `agent_sessions` format in the README or skill instructions where appropriate.
- [x] Run the Planrock test suite and update this plan with any follow-up for additional agents.
