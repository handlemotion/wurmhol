# 0029: The wire protocol package is MIT, like the CLI

Status: accepted. Amends spec v1 section 9 (License), which put `packages/protocol` under AGPL-3.0.

## Context

The CLI is MIT and ships to npm. It bundles `@wurmhol/protocol` (a private package, so it is not
installed separately), which spec v1 section 9 licensed AGPL-3.0. A package under one license
therefore carried code under a stronger one, and a program that embeds the CLI's `openPipe` (Dorks
does, as a sidecar and as a library) could not tell what terms applied to what it was shipping.

The protocol is the frame codec and stream multiplexer both ends share. It has no I/O and no
dependency on the relay, auth or database packages. What keeps a competing hosted relay from simply
running this code for free is the relay itself (`apps/worker`), authentication (`packages/auth`) and
the database layer (`packages/db`), not the codec.

## Decision

- `packages/protocol` is MIT, with its own `LICENSE`.
- `packages/auth`, `packages/db` and everything under `apps/` stay AGPL-3.0-only.
- The CLI's bundle holds only MIT-licensed or permissively licensed code: `@wurmhol/protocol`, the
  MCP SDK and zod are bundled; `ws` and the proxy helpers are dependencies.
- The AGPL relay depends on the MIT protocol, which is allowed. The reverse never happens: the
  protocol must not import an AGPL package.

## Consequences

- Anyone may embed the CLI or `openPipe` in a product under MIT, with no AGPL obligation from the
  bundled protocol.
- Someone could implement a client or a relay against the protocol without AGPL terms on the codec
  itself. A relay that reuses this repo's Worker, auth or database code is still AGPL.
- The copyright holder of the protocol is the project's sole author, so no one else's consent was
  needed. A contribution to `packages/protocol` from now on is accepted under MIT.
