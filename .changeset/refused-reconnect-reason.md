---
"wurmhol": patch
---

A pipe whose reconnect is refused for good now closes with the relay's reason: `revoked` when its token expired or was revoked, `no_subscription` when the org has no plan, or why the share ended. It used to close as `disconnected`. A viewer who opens a pipe before its server is up no longer puts "Waiting for port N" on the wall as the pipe's title.
