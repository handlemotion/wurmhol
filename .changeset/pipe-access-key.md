---
"wurmhol": minor
---

A pipe can take an access key for clients with no browser session. Set `WURMHOL_ACCESS_KEY` (or pass `accessKey` to `openPipe`) and clients send it as the `x-wurmhol-key` header; the relay keeps only its hash and strips the header before the request reaches your server. Without a key, only signed-in members get in, as before.
