# 0028: A pipe can take an access key, for clients with no browser session

Status: proposed. Departs from spec v1 section 6 ("Every request to a share host needs the viewer's
cookie") for pipes opened with a key. Pipes without one are unchanged. Spec section 2 rules out
public links; this is not one.

## Context

A share host answers only to a signed-in member of the org that owns the pipe: a request with no
`__Host-wurmhol` cookie gets `401 sign in to view this pipe`. That fits a person opening a dev
server in a browser. It cannot serve a program in the cloud that connects to the pipe: a script, a
webhook sender, or an agent in a sandbox that reaches an app on someone's computer. Such a client has
no browser to sign in with, and OAuth-style sign-in is the wrong tool for it.

The first user is Dorks, a desktop app that runs a server on the person's Mac while agents run in
Boat sandboxes. Each sandbox opens a WebSocket to that server through a named pipe (ADR 0009), whose
URL is stable. The sandbox authenticates itself to the server with its own secret; the pipe only has
to let it through.

## Decision

- **`openPipe({ accessKey })`, or `WURMHOL_ACCESS_KEY` for the CLI's daemon.** 32 to 128 letters,
  digits, `-` or `_`, so at least 128 bits fit. It is chosen by whoever opens the pipe and may be the
  same every time, so a named pipe that reopens keeps working for clients that hold the key.
- **The relay keeps only its hash.** The CLI sends the SHA-256 (lowercase hex) of the key with a new
  pipe's handshake (`Wurmhol-Access`). The key itself is never sent to `/connect`. A reconnect of the
  same pipe keeps the stored hash; a reopened pipe sends it again.
- **Clients send the key as `x-wurmhol-key` on a request to the share host.** The Worker hands it to
  the pipe's object, which hashes it and compares in constant time. A match is let through as the
  member sign-in would be: the same plan limits, metering and wall apply, and the request is relayed
  like any other. A wrong key, or a key on a pipe that has none, is `401 bad access key`. No
  redirect to the app happens, so a client never lands on the sign-in page.
- **The header stays with the relay.** Every `x-wurmhol-*` header is already stripped before a
  request reaches the dev server (`viewerRequestHeaders`); the presented key is also removed from
  the request the object relays.
- **It opens one pipe, nothing else.** The key does not sign anyone in, does not set a cookie, and
  does not reach the console or the org's other pipes. Viewer lists (`--only`) apply to people; a key
  holder is not one, so they do not narrow it.
- **No new endpoint and no schema change.** The hash lives in the pipe object's stored meta, as
  `accessHash`, absent in pipes from before it.

## Consequences

- A pipe with a key is reachable by anyone who has it, from anywhere. It is as strong as the key: the
  person who opens the pipe decides where it goes, and the app behind the pipe should still
  authenticate its own clients (Dorks does, per sandbox).
- There is no key rotation without reopening the pipe with a new one; a leaked key ends with the
  pipe (`wurmhol stop`, or its TTL).
- Request views of a key client are not recorded as a signed-in viewer on the wall's view log.
- Abuse: a pipe still belongs to an org that pays for it and can be terminated (ADR 0022); a key
  does not make it public, because a client must hold a secret the opener chose.
- `X-Wurmhol-Key` attempts on a pipe cost one Durable Object call each, as an unauthenticated
  request to a pipe already does; the key's size makes guessing infeasible.
