# 0024: The daemon reopens a pipe the relay ended for a lost connection

Status: accepted. Extends spec v1 section 5 (wire protocol: "On reconnect it keeps the same share
id for up to 60 s").

## Context

A share survives a dropped socket for the relay's reconnect grace (`RECONNECT_GRACE_MS`). Past
it, the relay ends the share with reason `disconnected`, and the CLI's daemon removed its state
file and exited. A laptop that slept for ten minutes woke up with no pipe: the agent had to notice
and run `npx wurmhol <port>` again, and the human's link was dead.

## Decision

- **`disconnected` is not the end of the daemon.** It opens a new pipe for the same port and
  options, waiting 1 s, doubling to at most 60 s, between attempts, until one opens. A named pipe
  gets its URL back; an unnamed one gets a new share id and URL.
- **The end time stays.** The new pipe asks for the old one's remaining lifetime; once that is
  past, the daemon ends as `expired` would.
- **It gives up on what a retry cannot fix:** every other end reason (`stopped`, `terminated`,
  `expired`, `revoked`, `limit`, `no_subscription`) and a refusal that is final (`FixError.final`).
  Other refusals (the proxy refusing, a name still held while the relay ends the old share) are
  retried.
- **This machine's view follows the new pipe.** The state file is rewritten with the new id and
  URL and the same `request`, so `wurmhol ls`, `wurmhol stop` and a re-run of the same command
  find it. Both pipes' logs get a `reopened` event with `from` and `to`. While it retries, the old
  state file stays, so `wurmhol stop <port|id|name>` still ends the daemon; SIGTERM stops the
  retries at once.
- **No dependence on the grace's length.** The daemon reacts to the reason, not to a timer.
- `openPipe` (the SDK) and `wurmhol mcp` are unchanged: their callers see `close` with
  `disconnected` and decide.

## Consequences

- An unnamed pipe's link changes after a long drop. The wall shows the new pipe; the human needs
  the new link, which the agent reads from `wurmhol ls`. Use `--name` for a link that must hold.
- A daemon whose relay is gone for good keeps retrying once a minute until its end time or
  `wurmhol stop`.
