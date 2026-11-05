# 0018: Open pipes from the browser, through `wurmhol host`

Status: accepted; the card's approval step is replaced by ADR 0019. Extends spec v1 section 3
(Create pipe) and section 7 (the CLI). Departs from section 3's "the wall only lists pipes": the
wall can now start one, on a computer that asks it to.

## Context

Create pipe offered three things to copy. The third, "setup for this computer", was
`npx wurmhol login && npx wurmhol <port>`: the person still had to know the port and type it in a
terminal, every time. People asked to open pipes on their own machine from the browser.

A web page cannot do that alone. It cannot list a computer's listening ports, open raw sockets,
or read a local dev server's responses (CORS, and Chrome's Local Network Access prompt), so it
cannot relay them. Something has to run on the computer.

## Decision

- **`wurmhol host`** runs in a terminal and keeps one WebSocket to `GET /host` on the CLI's host,
  authenticated by a bearer token like `/connect`. With no token it runs `wurmhol login` first.
- **It reports web ports.** Every 3 s it reads the listening TCP ports (Linux `/proc/net/tcp{,6}`,
  `lsof` on macOS, `netstat` on Windows), from 1024 up. It asks each new one for `/` once and
  offers it only if it answers HTTP, with its page's `<title>`. At most 64.
- **The Org object holds the sockets** (hibernation API), each tagged with its owner: the user
  who made the token. Nothing is stored; a machine is gone when its socket closes.
- **Only its owner sees and uses a machine.** The Create pipe card watches
  `GET /api/machines/live` (cookie, same-origin check as `/api/live`) and gets only the caller's
  machines. `POST /api/machines/:id/open { port }` reaches only the caller's machine, and only a
  port it reported, so the wall cannot reach a database or anything else it did not offer.
- **Opening is a normal pipe.** The CLI starts the same daemon as `wurmhol <port>`, from the home
  directory (so no git source is claimed), answers with the URL, and the pipe joins the wall like
  any other. A port already shared from this computer answers with the open pipe's URL. Pipes
  outlive `wurmhol host`; `wurmhol stop` or Terminate ends them.
- **Revoking the token disconnects its machines** at once, and the CLI exits with the fix.
- **The card.** "Copy setup for this computer" becomes "Create from this computer". It turns the
  same square into three steps with a Back button: run `npx wurmhol host`, approve it at the link
  it prints, pick a port. The first two collapse to their answer once a computer connects; a
  pick opens the new pipe's card.

## Consequences

- Page titles of local servers reach the Worker, as they already do for open pipes (ADR 0008).
  They are held in memory on the socket and never stored.
- The browser cannot tell which connected computer it is running on; with two, the card names
  each port's computer.
- Self-hosted installs get it with the deploy: no new binding or variable.
