---
"wurmhol": minor
---

`wurmhol logs <port|id|name>` shows a pipe's recent requests (method, path without query values, status, time taken) and connection events, with `--follow` and `--json`; `wurmhol mcp` gains a `recent_requests` tool. The log stays on this machine, capped at about 2 MB per pipe, and never holds bodies, headers, cookies or query values.
