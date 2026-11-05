---
"wurmhol": minor
---

Name who may open a pipe with `--only ana@x.com,bo@y.com` (or `openPipe({ viewers })` in the
SDK). They must be members of the token's org; a name that isn't is refused with the fix. Without
`--only`, every member of the org may open it, as before.
