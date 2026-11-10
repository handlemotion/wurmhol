# @wurmhol/sdk

The Wurmhol SDK: open a private HTTPS URL for a local server from inside your own app, keep it
open, sign people in, and list or end the org's pipes. ESM, Node 22+ and Bun (a compiled Bun binary
included). MIT.

This package is the source of the `wurmhol` npm package's API, which re-exports all of it:

```ts
import { Wurmhol, fileTokenStore } from "wurmhol";
```

It is not published on its own yet (ADR 0030). Guide and option reference:
[apps/docs/sdk.mdx](../../apps/docs/sdk.mdx). Design: [ADR 0030](../../docs/adr/0030-sdk-for-embedding-apps.md).

- `src/index.ts`: the public API. `src/internal.ts`: what the CLI needs; no promises.
- `src/transport/`: the two WebSocket implementations (`ws` on Node, a built-in client on Bun).
- `examples/embed.ts`: a complete app; the e2e compiles it with `bun build --compile` and runs it.
- Build: `pnpm --filter @wurmhol/sdk build`. Type-checking resolves the sources (`@wurmhol/source`
  condition); the bundlers and npm consumers use `dist`.
- Tests are end to end, in `apps/worker/e2e/sdk*.e2e.test.ts`, against the real relay.
