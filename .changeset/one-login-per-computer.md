---
"wurmhol": minor
---

`wurmhol mcp` no longer fails without a token: `open_pipe` returns an approval link at once (`approval: true`) for the agent to send to the user, and opens the pipe once the computer is approved there. A second call while it waits returns the same link. A second `npx wurmhol <port>` with no token while another share waits on its link now prints that same link and opens once it is approved, instead of starting a second login.
