---
"wurmhol": minor
---

Pipes end after 4 hours by default. Ask for another lifetime with `--ttl` (`90m`, `8h`, up to
12 hours on wurmhol.com), or `openPipe({ ttl })` in the SDK. `wurmhol ls` shows when each pipe
ends, and `--json` output carries `endsAt`.
