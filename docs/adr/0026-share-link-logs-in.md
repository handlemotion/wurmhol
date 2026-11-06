# 0026: With no token, the share link logs the computer in

Status: accepted. Departs from spec v1 section 2 ("in under 3 s once a token is set") and
section 7 ("`WURMHOL_TOKEN` from the environment"): `npx wurmhol <port>` works with no token.
Extends ADR 0008 (`wurmhol login`).

## Context

A cloud sandbox has no saved login: `~/.wurmhol/credentials.json` dies with the container, so
ADR 0008 sends cloud users to `WURMHOL_TOKEN`. Before the first pipe a person signs in, makes a
token in the console, opens the agent's environment settings and pastes it there. Without that,
`npx wurmhol 8787` stops with "Run wurmhol login, or set WURMHOL_TOKEN".

`wurmhol login` already does the hard part, a device-code approval on any device, but it is a
separate command that blocks a terminal, prints a code to type, and ends with nothing to look at.
The human the agent sends a link to is about to sign in anyway, to open the pipe.

Options considered:

- **An unclaimed pipe.** The CLI opens a pipe with no org; whoever opens its URL signs in and
  claims it. Every part of a pipe assumes an org from its first second: the share row, the Org
  object's card, the subscription check at `/connect`, named pipes and limits. All of them would
  grow a state with no org, for a pipe that serves nothing until it is claimed.
- **A token from the hosted MCP connector.** A connector belongs to the account and survives the
  container, so a tool could hand the agent a setup code (ADR 0020) every session. It needs the
  connector installed first, works only in clients that have it, and is a second way to start.
- **The share command runs the device login, and its link becomes the pipe.** Chosen.

## Decision

- **`npx wurmhol <port>` with no token** asks `/device/code` for a code, as `wurmhol login`
  does, with the port, and prints the approval link (`/device?code=…` on the console) as its first
  stdout line, where the pipe URL goes. It returns at once, like any share; stderr says to send the
  link to someone in the org. `--json` prints `{ url, port, id, endsAt, approval: true }`.
- **The daemon waits for the approval.** The device code goes to it over IPC, never in its
  argv. It polls `/device/token` as `wurmhol login` does, saves the token where `login` saves it
  (so the next share on this computer needs no approval), then opens the pipe as usual.
- **While it waits, the share is listed** by `wurmhol ls` as waiting for approval, `wurmhol stop
  <port>` ends it, and running the same command again prints the same link instead of a new code.
- **The approval page knows it is a share.** The code's scope carries `port:<n>`. The page asks
  "Open port 8787 on `<computer>`?" and, once approved, waits for the pipe and replaces itself with
  the pipe's URL. The person signs in once, taps Approve once, and is in the app.
- **Finding the pipe.** The token minted for the code records the code (`tokens.login_code`, the
  normalized user code). `GET /api/device/pipe?code=` answers, for the member who approved it, the
  newest open pipe of the token made from that code, or that it is still on its way. A user code is
  unique among live codes; the lookup is also limited to tokens the caller made in their active org
  in the last hour.
- **The token is a `wurmhol login` token**: org scope `pipes`, 90 days, named after the computer,
  listed under Tokens and revoked there like any other.

## Consequences

- A cloud session needs no setup beyond, in Limited network mode, `api.wurmhol.com` on its
  allowed hosts. Each new container costs one tap, on a page the person reaches on the way to the
  pipe. `WURMHOL_TOKEN` still wins when set, for CI, orchestrators and anyone who wants no tap.
- The approval link is the same exposure as `wurmhol login`'s: a stranger who gets a member to
  approve their link gets a token in that member's org. The page names the computer and port and
  says to approve only a link the person expected, as it already says for a typed code.
- The first share without a token is not ready in 3 s: it is ready when someone approves.
- `wurmhol mcp` works the same way: with no token, `open_pipe` starts a share login for its port
  and returns the approval link at once (`approval: true`), telling the agent to send it to the
  user. The MCP process waits for the approval, saves the token and opens the pipe it holds, as
  the daemon does. Another call while it waits, for the same port or another, returns the same
  link and opens that port too. The SDK still needs a token: it hands back a pipe, not a link.
- **One login per computer.** A second tokenless `npx wurmhol <port>` while a share already waits
  on its link starts no code: its daemon writes its own waiting state that `follows` the first,
  prints the same link and says it opens once that link is approved. It waits until the first
  share stops waiting, then reads the token from `credentials.json` and opens its pipe; if none
  was saved (denied, expired, stopped), it ends too. Two commands started in the same instant
  can still each start a code.
- **The approval page names its port.** One token can open several pipes before the page looks,
  so `GET /api/device/pipe` takes the port the page asked to open and answers that port's pipe.
- Self-hosted installs get it with the deploy and a migration: no new binding or variable.
