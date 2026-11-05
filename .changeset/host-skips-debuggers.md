---
"wurmhol": patch
---

`wurmhol host` no longer lists debuggers (Node's, Chrome's and wrangler's inspectors) or ports that answer with an error other than 404. Set `WURMHOL_HOST_IGNORE=9229,5555` to leave out other ports.
