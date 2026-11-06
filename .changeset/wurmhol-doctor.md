---
"wurmhol": minor
---

Add `wurmhol doctor [--port N] [--json]`: checks the token, `HTTPS_PROXY` and its CA, whether the network allows the CLI's host and the pipe domain, and whether a port answers HTTP on 127.0.0.1 or ::1; one line each, `ok` or the fix, exit 1 if any fails. `wurmhol init` and `wurmhol login` now name the hosts to allowlist first.
