---
name: planrock-dashboard
description: Start, reuse, open, inspect, diagnose, or stop Planrock's authenticated on-demand localhost dashboard. Use for Planrock dashboard lifecycle and health requests.
---

# Planrock Dashboard

Use the public Planrock CLI; do not reimplement listener discovery, process
signaling, capability handling, or owner-record recovery.

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

URLs returned by `start` and `open` contain a single-use, short-lived browser
bootstrap token in the fragment. Do not log, persist, transform, or copy that
token beyond presenting the returned URL to the user. Treat lifecycle and API
authentication failures as security diagnostics rather than PID-management
requests.
