# Wurmhol web app

The React/Vite SPA for sign-in and the shares wall. `apps/worker` serves its production build;
in development Vite proxies `/api` (including the wall WebSocket) and `/open` to the Worker.

Before UI work, read [DESIGN.md](../../DESIGN.md) and the design skills it names.

## Develop

From the repository root, after [setup](../../docs/development.md#setup):

```bash
pnpm stack:serve
```

Then, in a separate shell:

```bash
pnpm --filter @wurmhol/web dev
```

The real Worker listens on 8787 and the Vite app on 5173. Keep the Worker running for auth
and API calls; Vite alone is not the full stack. Stop the Worker with `pnpm stack:serve:stop`.
For the alternative Doppler-backed Worker, see [Operations](../../docs/operations/doppler.md#local-development).

## Build and verify

`pnpm --filter @wurmhol/web build` creates `apps/web/dist`, the Worker's static assets. Run
`pnpm check` and `pnpm check-types` from the root. Real browser behavior belongs in the
Worker's [e2e suites](../worker/e2e/), not mocked component tests; see
[testing guidance](../../docs/development.md#checks-and-tests).
