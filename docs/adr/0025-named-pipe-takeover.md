# 0025: A named pipe that is away or stale gives its name to the next one

Status: accepted. Amends ADR 0009 ("One open pipe per name": a second one is refused with the fix
`wurmhol stop <name>`).

## Context

A named pipe holds its name while it is open. When its CLI crashes, or its machine sleeps, the
pipe goes away and stays open for its CLI to come back: 15 minutes since ADR 0024. Running
`wurmhol <port> --name app` again in that time, the obvious thing to do after a crash, was
refused with 409 "name open", and the `wurmhol stop app` it suggested could not reach a CLI that
no longer runs. The org had to find the pipe on the wall and press Terminate, or wait.

## Decision

When a new pipe asks for a name the org's open pipe holds, the relay ends that pipe (`stopped`)
and opens the new one at the same URL if any of these holds:

- the old pipe is **away** (its CLI dropped or went silent);
- the old pipe's object has already **ended or never started**, so only its D1 row is left open
  (it is ended `disconnected` and taken off the wall);
- the **same token** started it: the same agent running its command again, so the old pipe's
  CLI, if it still runs somewhere, is the one being replaced.

A live pipe started by another token keeps its name, and the new one is refused as before. Two
agents of one org asking for the same name do not take it from each other back and forth. A name
held by another org is still refused with "name taken".

## Consequences

- After a crash, re-running the same command gets the same URL back at once. Anything that
  trusts the URL (an OAuth redirect URI, a link already sent) keeps working.
- A CLI that still runs with a token whose pipe was taken over is closed with `stopped` and stops,
  as after `wurmhol stop`.
- Viewers holding a cookie for the old pipe sign in again, as with any new pipe of the name (ADR
  0009).
- No schema change: the takeover is a check in `/connect` and one more read of the open pipe's
  token.
