---
"wurmhol": minor
---

`npx wurmhol <port>` run again with the same flags prints the pipe that is already open on this machine (same `--json` shape) instead of opening a second one. A different `--name`, `--only`, `--link` or `--note`, or any `--ttl`, opens a new pipe; `wurmhol stop <port>` first for a new URL.
