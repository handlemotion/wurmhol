# 0030: An SDK for apps that embed pipes, on Node and Bun

Status: accepted. Extends ADR 0008 section 3 ("an SDK for orchestrators"), which gave apps
`openPipe`. Departs from nothing in the spec; the relay and the wire protocol do not change.

## Context

ADR 0008 shipped `openPipe`: a pipe in the caller's process, no daemon. That served orchestrators
that run Node. The first app built on it as a product, Dorks (a desktop app whose local server
agents in cloud sandboxes reach through a named pipe, ADR 0009 and 0028), could not use it:

- **It breaks on Bun.** Dorks' server is a compiled Bun binary. Bun replaces the `ws` package with
  its own shim, which has no `upgrade` event (the share's URL arrives in the handshake response's
  headers) and no `unexpected-response` event (a refusal's one-line fix arrives in its body). A
  failed connection there raises an unhandled `ErrorEvent` and ends the process.
- **Everything around the pipe is the app's to write.** Reopening after a pipe's lifetime ends,
  backing off after a failure, signing a person in (the device flow lives in the CLI), keeping the
  token between runs, and listing or ending the org's pipes (`curl` only).
- **Failures are strings.** An app cannot tell a revoked token (stop) from a flaky network (retry)
  without parsing the fix.

Apps also asked for branded preview URLs on their own domain; ADR 0031 designs that and this ADR
reserves the SDK's side of it.

## Decision

### 1. One SDK package, which the CLI is built on

`packages/sdk` (`@wurmhol/sdk`, MIT) holds the tunnel, the pipe, the device flow, the token store,
the managed pipe and the management client. `packages/cli` keeps only what a terminal needs: the
commands, the detached daemon, the log, the login service, doctor, MCP and `host`. The CLI imports
the SDK, so what the CLI does the SDK can do.

The SDK has two entry points: the public one (`@wurmhol/sdk`), whose API this ADR describes and
which follows semver, and `@wurmhol/sdk/internal`, which the CLI uses and which carries no promise.

**Publishing.** The `wurmhol` npm package bundles the SDK and re-exports all of it
(`import { Wurmhol, keepOpen } from "wurmhol"`), so apps can use it with the release machinery that
exists. `openPipe` and every type it had are unchanged. The SDK package stays `private` until npm
trusted publishing is set up for `@wurmhol/sdk` (a step only the package owner can take); then it
publishes alone with the same API and `wurmhol` keeps re-exporting it. Until then the SDK's version
is the CLI's.

### 2. Two WebSocket transports behind one interface

The tunnel needs a small WebSocket: send and receive text and binary, ping, close with a code,
terminate, buffered bytes, the handshake response's headers, and a refusal's body. It is written
against `WsConnection` (`transport/types.ts`) with two implementations:

- **`node`**: the `ws` package, unchanged. The proven path, used on Node.
- **`builtin`**: an RFC 6455 client over `node:net` and `node:tls` (`transport/builtin.ts`), used on
  Bun (compiled binaries included) and Deno. It masks frames out, rejects masked frames in,
  reassembles fragments, answers pings, does the close handshake with a timeout, bounds message
  size, validates the handshake's `Sec-WebSocket-Accept`, reaches the relay through an HTTP CONNECT
  proxy as the Node path does, refuses header values that could inject a header, and never raises
  an error event nobody listens to. It reads the handshake response's headers and a refusal's body,
  which is exactly what Bun's shim cannot give.

`transport: "auto" | "node" | "builtin"` chooses; `"auto"` picks by runtime. The local side (the
connection from the tunnel to the dev server for a viewer's WebSocket) goes through the same
interface.

Rejected: Bun's native `WebSocket`, which exposes neither the handshake response nor a refusal body,
so the share's URL would have to travel in-band (a protocol change, and an older CLI would not
understand it); patching or vendoring `ws`; Node's built-in `WebSocket` (no custom headers).

Both transports run the same end-to-end cases against the real stack on Node (large bodies, every
frame length boundary, a fragmented message, a refusal, an unreachable relay, a CONNECT proxy and a
cut connection), and a compiled Bun binary runs the example app against it.

### 3. The public API

- `new Wurmhol({ server?, token?, tokenStore?, client?, transport?, log? })`:
  - `auth.start`, `auth.wait`, `auth.login` (device flow, RFC 8628, with callbacks for the approval
    URL), `auth.redeem` (setup code), `auth.signOut`, `auth.status`.
  - `pipes.open(options)`, `pipes.keepOpen(options)`, `pipes.list()`, `pipes.end(id)`.
- `openPipe`, `keepOpen`, and the device-flow functions as plain functions.
- Token stores: `memoryTokenStore`, `fileTokenStore(path)` (mode 0600, replaced atomically, read
  only for the server it was saved with), and the `TokenStore` interface for an app's keychain.
- Types for everything above, `CloseReason`, `PipeInfo`, and `DomainState` and `PipeDomain`
  (reserved; ADR 0031).

`Pipe` gains `state` (`open`, `reconnecting`, `closed`) and the events `disconnected` and
`reconnected`, beside `request` and `close`. A close the owner asked for is not a disconnect.

### 4. A pipe that stays open

`keepOpen` opens a pipe and reopens it when the relay ends it for a reason that does not mean stop.
Default: reopen on `expired` and `disconnected`; give up on `stopped`, `terminated`, `revoked`,
`limit` and `no_subscription`, and on any 4xx refusal except 408 and 429 (a revoked or unknown
token will not heal). Failures back off with a configurable delay, factor, cap and jitter. A named
pipe returns at the same URL, an unnamed one at a new one, announced by `open` with
`reopened: true`. `ready()` resolves with the first pipe, or rejects when it can never open;
transient failures before the first open are retried. The token may be a function, read before each
attempt.

### 5. Typed errors

`FixError` keeps its one-line `message` and gains `code` (`refused`, `invalid_option`, `no_token`,
`network`, `dns`, `unreachable`, `tls`, `proxy`, `auth`, `unsupported`, `error`), `status` (the
relay's HTTP status on a refusal) and the existing `reason` and `final`. Apps branch on `code`, show
`message`.

### 6. What the SDK does not do

- **No token refresh.** Tokens do not refresh; they expire by scope and are replaced by signing in
  again. `auth.signOut` forgets the stored token on this computer only; revoking a token is the
  console's, and a self-revoke endpoint is proposed in ADR 0031.
- **No detached daemon.** The pipe lives in the caller's process; `wurmhol <port>` is the CLI's.
- **No request contents, ever.** `request` events carry method, path, status and duration; logging
  hooks never see bodies, headers or tokens.

## Consequences

- Dorks can embed Wurmhol in a compiled Bun binary and keep a named pipe up for a sandbox's bridge,
  with the access key of ADR 0028, without writing the lifecycle itself.
- The built-in transport is code the project now owns. It is small and run through the same cases
  as `ws`; if Bun's shim gains the two missing events, `"auto"` can pick `ws` again.
- The CLI's behavior on Node is unchanged: it uses the same `ws` path and the same tunnel.
- The `wurmhol` package grows by the managed pipe, the client and the built-in transport.
- Building the CLI first builds the SDK (the CLI's `build` script does), because the `wurmhol`
  bundle and its types are made from the SDK's build.
