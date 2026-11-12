---
name: verify-flow-control
description: Exhaustively check per-stream flow control (ADR 0002) between the Share Durable Object and the CLI, on the real SendWindow and ReceiveWindow. Use whenever a change touches packages/protocol/src/mux.ts, INITIAL_WINDOW or MAX_CHUNK_BYTES, chunk(), or the code in share-do.ts or the SDK's tunnel.ts that sends data frames, handles data or window frames, or grants credit.
---

# Verify flow control

## The promise

A body sender never has more than one window of bytes in flight on a stream, and a body always
finishes while its reader keeps reading. If the first breaks, a large download read slowly by a
phone piles up in the Share Durable Object's 128 MB and crashes every stream it holds. If the
second breaks, a download or upload stops partway and hangs until a timeout.

## What is checked

[`packages/protocol/src/flow-control.verify.test.ts`](../../../packages/protocol/src/flow-control.verify.test.ts)
drives the real `SendWindow` and `ReceiveWindow` through every interleaving of these steps, for
every way of cutting the body into pieces:

- the sender cuts the next piece (1 up to the largest piece, like `chunk()` over reads of any size);
- the sender waits on the real `ready(piece)`, then calls `take(piece)` and sends a `data` frame;
- the receiver gets the next `data` frame in order and calls `received(bytes)`;
- the receiver hands on one piece and calls `consumed(bytes)`, sending back any grant it returns;
- the sender gets the next `window` frame in order and calls `grant(bytes)`.

In every reachable state it checks four properties:

- **no overrun:** `received()` never throws "peer sent past its flow-control window";
- **bounded memory:** bytes on the wire plus bytes waiting at the receiver are never more than the
  window;
- **credit adds up:** the sender's `available` equals the window plus delivered grants minus bytes
  sent, and `ready()` never lets a sender go that `take()` then refuses;
- **no stall:** a state with nothing left to do has the whole body handed on.

Bounds: windows of 6, 7 and 8 units, largest pieces of 2, 3 and 4, bodies of 24, 17 and 20 units
(about 14,000 to 96,000 distinct states each, under a second in all). One more test pins the
precondition that ties the model to the real sizes: `MAX_CHUNK_BYTES` (64 KiB) is at most
`INITIAL_WINDOW / 2` (512 KiB). The last test shows the checker finding a stall when a piece can
be larger than half the window: then a sender can wait for credit the receiver only grants after
half a window has been handed on.

## Run it

```bash
pnpm --filter @wurmhol/protocol exec vitest run src/flow-control.verify.test.ts
```

It also runs in `pnpm test:all` and `pnpm --filter @wurmhol/protocol test`. A failure prints the
broken property and the shortest sequence of steps that breaks it, numbered, in the code's words
("the sender has credit 3, takes 4…", "the receiver hands on 4 units and calls consumed()").

## Coverage and sync

Last confirmed to describe the code at commit `83a6007ca49ae151214c9401a77d08a99eb767fe`.

| Code                                                                                                            | What the check relies on                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol/src/mux.ts`: `SendWindow`, `ReceiveWindow`, `INITIAL_WINDOW`                                 | Run directly, unchanged.                                                                                                                                                               |
| `packages/protocol/src/frame.ts`: `MAX_CHUNK_BYTES`, `chunk()`                                                  | Every `data` frame is at most `MAX_CHUNK_BYTES`; the constant is at most half the window.                                                                                              |
| `apps/worker/src/share-do.ts`: `#pumpRequestBody`                                                               | Before each request-body `data` frame: `await stream.send.ready(n)`, then `take(n)`, `n` from `chunk()`.                                                                               |
| `apps/worker/src/share-do.ts`: `#relay`'s `pull`, and the `window` and `data` branches of the CLI frame handler | `received(n)` for every response `data` frame accepted; `consumed(n)` once per piece handed to the viewer; a non-zero grant is sent as a `window` frame; `window` frames call `grant`. |
| `packages/sdk/src/tunnel.ts`: `#pumpResponse`                                                                   | Before each response-body `data` frame: `ready(n)`, then `take(n)`, `n` from `chunk()`.                                                                                                |
| `packages/sdk/src/tunnel.ts`: the `window` and `data` branches of the HTTP frame handler                        | `received(n)` per request `data` frame; `consumed(n)` in the local write's callback; a non-zero grant is sent as a `window` frame.                                                     |

To see whether a change touches covered code:

```bash
git diff 83a6007ca49ae151214c9401a77d08a99eb767fe -- packages/protocol/src/mux.ts packages/protocol/src/frame.ts apps/worker/src/share-do.ts packages/sdk/src/tunnel.ts
```

The checker runs the two classes themselves, so a change inside them is checked by running it. A
change at a call site is not: read the call sites above and confirm each line of the table still
holds. Move the commit above forward only after you have confirmed that the whole table describes
the code at the new commit.

## Reading a failure

- **The change broke the promise** (the usual case after editing `mux.ts`, or after a call site
  stopped matching the table): the numbered steps are a schedule the real code can follow. Fix the
  code. Do not loosen a property, shrink a bound, or remove a step kind to make it pass.
- **The model no longer matches the code** (an intended change, such as grants sent at a new
  threshold, a sender that waits for something other than `ready`, or a new frame on this path):
  update `apply`, `enabled` and the coverage table together, then show the updated check failing on
  a broken variant of the new code before trusting its pass.
- **A precondition test fails** (`MAX_CHUNK_BYTES` grew past half of `INITIAL_WINDOW`): that is a
  real stall risk, not a modeling error. The last test shows the schedule.

Before trusting a pass after editing the checker, break the real code once and watch it fail. For
example, change `this.#size / 2` to `this.#size` in `ReceiveWindow.consumed` (it should report a
stall), or make `SendWindow.ready` return at once (it should report credit). Then restore the
file with `git checkout -- packages/protocol/src/mux.ts`.

## Not covered

- More than one stream at a time. Streams share nothing in these classes, so each is checked alone.
- Cancellation: `release()`, `#cancel`, `#failStreams`, `#cancelHttp`, and what happens to grants
  after a stream ends.
- The CLI's error page in `#openHttp`, sent without taking credit. It is small and is the only body
  on its stream, so it fits the initial window, but the checker does not see it.
- `ws-message` frames, which have no window (`SendBacklog` bounds those).
- The socket itself: the model assumes each direction delivers frames in order and loses none.
- Windows and bodies at full size. The bounds are scaled down, and the precondition test is what
  ties the scaled model to the real constants.
