# 0002: A `window` frame for flow control, and the heartbeat as text

Status: accepted. Departs from spec v1 section 5 ("Wire protocol"), which lists eight frame types.

## Context

The Share Durable Object sits between a local dev server (fast, in the sandbox) and a viewer
(maybe a phone on cellular). A Durable Object has 128 MB of memory and no backpressure on an
accepted WebSocket: whatever the CLI sends is delivered. A 50 MB download read slowly by a phone
would sit in the object's memory; a 500 MB one would crash it, and every other stream with it.

The CLI's 20-second heartbeat would also wake the object from hibernation three times a minute
for every idle share, which is what hibernation exists to avoid.

## Decision

- A ninth frame type, `window`, carries per-stream credit (`{bytes}`). A body sender starts with
  1 MiB per stream (`INITIAL_WINDOW`) and stops when it is spent; the receiver grants more as it
  hands bytes on, in one grant per half-window. Both directions use it: response bodies (CLI to
  relay) and request bodies (relay to CLI).
- `ping` is the exact text message `wurmhol:ping`, never a binary frame. The Share DO registers
  it with `setWebSocketAutoResponse`, so the runtime answers `wurmhol:pong` without waking the
  object. `getWebSocketAutoResponseTimestamp` still tells the object when the CLI was last seen.
- Browser WebSocket messages (`ws-message`) are not chunked: each is one frame, up to 1 MiB, the
  Workers message limit.

## Consequences

- A share's memory stays bounded by `INITIAL_WINDOW` per open stream, whatever the body size.
- Throughput per stream is capped at one window per round trip between the CLI and Cloudflare;
  with 1 MiB and a 100 ms round trip that is about 10 MB/s, well above a phone's link.
- Every frame type other than `ping` stays binary, so a text message other than the heartbeat is
  a protocol error.
