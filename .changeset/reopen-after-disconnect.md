---
"wurmhol": minor
---

A pipe whose connection is gone longer than the relay's reconnect grace (a laptop asleep, a network down) no longer ends: `wurmhol <port>` opens it again for the same port and flags, retrying with backoff (1 s doubling to 60 s) until its end time. A `--name` pipe gets its URL back; an unnamed one gets a new URL, shown by `wurmhol ls`, and both logs record a `reopened` event with the old and new ids. `wurmhol stop` ends it, including while it retries.
