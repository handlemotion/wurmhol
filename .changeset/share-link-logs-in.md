---
"wurmhol": minor
---

`npx wurmhol <port>` with no token no longer fails: it prints an approval link where the URL goes (`--json` adds `"approval": true`) and returns. Approving the computer at that link saves its token and opens the pipe, and the page goes straight to it. `wurmhol ls` lists the share as waiting for approval and `wurmhol stop <port>` ends the wait.
