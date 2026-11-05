---
"wurmhol": patch
---

Pipes and `wurmhol host` reach a dev server that listens only on `::1`, like Vite on its default `localhost` with Node 17+: they try 127.0.0.1, then ::1, and remember which one answered.
