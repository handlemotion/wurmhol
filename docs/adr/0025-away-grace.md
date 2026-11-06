# 0025: An away pipe waits 15 minutes for its CLI

Status: accepted. Departs from spec v1 section 5 ("Wire protocol": "On reconnect it keeps the
same share id for up to 60 s"). Works with ADR 0024 (the daemon reopens a pipe that ended
`disconnected`).

## Context

A pipe whose CLI drops is `away`: viewers get a page that retries on its own, and the CLI may
come back to the same share id, URL and name. The relay ended an away pipe after 60 s
(`RECONNECT_GRACE_MS`, the same constant the CLI uses to stop retrying). Real disconnects last
longer than that: a laptop lid closes for the length of a meeting, a cloud container is paused
and resumed, a proxy is down for a few minutes. Since the relay also marks a pipe away when its
CLI goes silent (two missed heartbeats), each of these ended the pipe. The agent then had to
start a new one at a new URL and hand that URL out again.

## Decision

- **The relay keeps an away pipe for `AWAY_GRACE_MS`, 15 minutes** (`@wurmhol/protocol`), then
  ends it with `disconnected` as before. The pipe's lifetime (`--ttl`) still ends it sooner.
- **`RECONNECT_GRACE_MS` stays 60 s, and now means only how long the CLI keeps retrying.** The
  relay's grace is the longer of the two, so the relay never ends a pipe its CLI is still trying
  to reach. A CLI whose socket drops when the machine wakes (the usual sleep) reconnects to the
  same share within that minute and keeps its URL, however long it slept. A CLI that retries
  for longer (up to `AWAY_GRACE_MS`) would also get its pipe back after a long outage; that
  change belongs to the CLI and is not part of this one.
- **An away pipe stays on the wall and counts toward the org's active pipes**, as it did for its
  60 s. Terminate on the wall ends it at once.

## Consequences

- A CLI that gave up after 60 s leaves its pipe away for up to 15 minutes instead of 1. Under
  ADR 0024 its daemon then opens a new pipe, so until the old one ends the wall shows both. The
  old pipe holds one of the org's active pipes and, when named, its name for that long, unless
  someone presses Terminate or starts the same name again (named pipe takeover). The wall shows
  it as away, so nobody mistakes it for a live one.
- Viewers of an away pipe see the retrying page for up to 15 minutes instead of a minute, then
  "This pipe has ended."
- A self-hosted relay behaves the same; the grace is a protocol constant, not configuration.
