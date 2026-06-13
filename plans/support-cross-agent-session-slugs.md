---
title: Support cross-agent session slugs
state: open
priority: P2
created_at: 2026-06-13
agent_sessions: []
---

- [ ] Define the canonical agent slug list for `agent_sessions`, starting with `codex` and `claude-code`, and decide how unknown agents should be represented.
- [ ] Review current Planrock CLI parsing and display behavior for `agent_sessions` values such as `codex:<session-id>` and `claude-code:<session-id>`.
- [ ] Update the Planrock skill instructions so Codex records `codex:<CODEX_THREAD_ID>` and Claude Code records the best available `claude-code:<session-id>` value.
- [ ] Add tests covering multiple agent slugs, full and shortened session display, ordering, and preservation of unknown agent slugs.
- [ ] Document the supported agent slug list and `agent_sessions` format in the README or skill instructions where appropriate.
- [ ] Run the Planrock test suite and update this plan with any follow-up for additional agents.
