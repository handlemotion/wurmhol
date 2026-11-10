---
"wurmhol": minor
---

`import { Wurmhol, keepOpen } from "wurmhol"` is now a full SDK for apps that embed pipes. It signs people in with the device flow and keeps the token in a store you choose, opens a pipe that reopens itself when its lifetime runs out (with backoff, and the same URL for a named pipe), lists and ends the org's pipes, and rejects with a `FixError` that has a `code` and the relay's `status`. A pipe also reports `disconnected` and `reconnected`. It runs on Bun, including a compiled Bun binary, which `openPipe` could not. `openPipe` and the CLI behave as before.
