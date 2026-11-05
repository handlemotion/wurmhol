---
"wurmhol": patch
---

An unknown flag, a flag missing its value, or a value on a flag that takes none now prints one line naming the flag and pointing at `npx wurmhol@latest --help`, and exits 1, instead of a Node stack trace.
