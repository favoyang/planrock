---
name: planrock-dashboard
description: Start, reuse, open, inspect, diagnose, or stop Planrock's unrestricted on-demand dashboard. Use for Planrock dashboard lifecycle and health requests.
---

# Planrock Dashboard

Use the public Planrock CLI; do not reimplement listener discovery, process
signaling, identity checks, or owner-record recovery.

```bash
planrock dashboard start --json
planrock dashboard open --json
planrock dashboard status --json
planrock dashboard stop --json
```

The default port is `4210`. Add `--port <number>` only when the user requests
an invocation-specific override. The value is never persisted. A different
healthy recorded port requires an explicit stop before start; an unknown
listener is never terminated or replaced.

The dashboard binds to all interfaces and accepts viewer and API requests
without authentication in this early version. URLs returned by `start` and
`open` are plain local URLs. Preserve the CLI's identity-safe behavior around
unknown occupied ports rather than signaling processes directly.

Use the shared health badge to open **Index health**. It reports only the
latest scan attempt while retaining the last usable index after a failed
refresh. Refresh and native actions remain local-only; remote viewers are
read-only. Pending, Active, Open, and Closed match the CLI workflow views, and
Open is the default.
