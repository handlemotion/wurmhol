# 0022: An operator takedown route, behind its own secret

Status: accepted. Fills in spec v1 section 6 (Phishing hosted on shares: "takedown path") and
section 11 (Abuse gets the domain flagged: "a fast takedown path").

## Context

Someone reports a pipe (`<id>.wurmhol.dev`) for phishing or abuse. Whoever runs the deployment,
hosted or self-hosted, has to stop it now and keep its owner from opening the next one. The
public security page promises: end the pipe, revoke the token that opened it, and for deliberate
abuse cut off the org behind it.

Before this, only an org's own members could do any of that, from the console. An operator could
revoke a token in D1 by hand, which stops new uses (`checkToken`) but leaves the open pipes
running: a pipe ends only when its Share Durable Object is told to, and nothing outside the
Worker can reach a Durable Object.

## Decision

- **A route on the app's host, `POST /operator/takedown`, authenticated by `OPERATOR_TOKEN`.**
  The token is a Worker secret of at least 32 characters, compared in constant time. Without
  one, every `/operator/*` path answers 404, so a self-hosted install that never sets it has no
  such surface. The CLI's host does not answer it.
- **It takes the pipe as the report gives it:** a URL, a host, an id, or a named pipe's name
  (the newest pipe that took the name). An ended pipe still works: its token and org are still
  there to act on.
- **It always revokes the token that opened the pipe** and ends everything that token runs: the
  reported pipe, its other pipes (with `revoked`, so each CLI says why and stops), and its
  machines. Revocation is written to D1 before the pipes end, so a CLI that reconnects in
  between is refused.
- **`blockOrg: true` blocks the org**, for deliberate abuse: a row in `org_blocks`, every open
  pipe of the org ends, its machines disconnect, and `checkToken` refuses every token of a
  blocked org, made before or after, on `/connect`, `/host`, `/v1/pipes` and MCP. The CLI prints
  "This org is blocked from opening pipes" and stops. Members can still sign in and see the
  wall; nothing they do there opens a pipe. Deleting the row unblocks it.
- **The response says what was done:** the pipe, the revoked token's id, every pipe it ended,
  and whether the org is blocked. That is what the operator tells the reporter. The log line
  `operator.takedown` records the same ids, never the note.

## Alternatives

- **A script run through `wrangler d1 execute`.** It can revoke tokens and write the block, but
  cannot end an open pipe: that needs a call into the Share Durable Object, which only the Worker
  can make. Open pipes would keep serving until they expired, up to 12 hours.
- **An operator role on signed-in accounts** (an `OPERATOR_EMAILS` list and a console screen).
  More surface for the same three actions: a session can be phished, a list of emails is
  another thing to keep right. A console screen can come later on top of this route.
- **Closing user accounts.** Blocking the org is what stops the pipes. Banning people would need
  a user-level block checked at sign-in and when they make a new org; not needed for the
  takedown itself. If abuse comes back through new orgs, that is the next step.

## Consequences

- Operators of hosted Wurmhol set `OPERATOR_TOKEN` in Doppler `prd_worker`; self-hosters set it
  with `wrangler secret put OPERATOR_TOKEN`. Anyone with it can end any pipe of the deployment,
  so it is treated like `BETTER_AUTH_SECRET`.
- One more D1 read on each bearer-authenticated request (the org's block).
- A blocked org's owner can delete it (the block goes with it) and make a new org; that org
  starts unblocked. Its pipes need a plan where billing is on, which is its own deterrent.
