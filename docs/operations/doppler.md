# Doppler secrets

Project `wurmhol` (from Omni's `docs/operations/doppler.md`). Branch configs inherit from their
environment's root config.

| Config       | Consumer                             | Holds                                                                                                                                   |
| ------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`        | every local command (root)           | local D1 settings, non-secret dev config                                                                                                |
| `dev_worker` | `wrangler dev` (mounted `.dev.vars`) | `BETTER_AUTH_SECRET`, `ENVIRONMENT=development`, OAuth client secrets, Stripe sandbox keys (`STRIPE_*`)                                 |
| `prd_worker` | Worker secrets                       | `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                      |
| `prd_github` | `production.yml`, records            | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `WORKER_DOMAIN`, `NPM_TOKEN`; records `WORKER_ROUTE`, `WORKER_VAR_*` |

Rules:

- A key is either a Worker secret (`prd_worker`) or a Worker var (`WORKER_VAR_*`), never both:
  Cloudflare refuses a name bound twice. Public values (price ids, client ids, hosts) are vars.
- Local: `doppler run -p wurmhol -c dev_<unit> -- <command>`. The Worker's `dev` script mounts
  `dev_worker` as `apps/worker/.dev.vars` (a named pipe, nothing on disk). Headless: set
  `DOPPLER_TOKEN` to a service token scoped to one config.
- Check presence by name only: `doppler secrets -p wurmhol -c <config> --only-names`.
- Cloud sessions get read-only service tokens as environment variables (`DOPPLER_TOKEN`,
  `DOPPLER_TOKEN_WORKER`); `.claude/hooks/cloud-session-start.sh` writes `apps/worker/.dev.vars`
  from them.

## Production deploys

Cloudflare Workers Builds deploys `main` (build `pnpm --filter @wurmhol/web build`, deploy
`pnpm --filter @wurmhol/worker deploy:cloudflare`, with `D1_DATABASE_ID`, `WORKER_DOMAIN`,
`WORKER_ROUTE` and `WORKER_VAR_*` as build variables copied from `prd_github`).
`.github/workflows/production.yml`, on each push to `main` and by hand:

1. **Migrate D1** with `wrangler d1 migrations apply --remote`. Nothing waits for it, so schema
   changes stay additive-first.
2. **Sync Worker secrets**: after this commit's Workers Builds check finishes, every key of
   `prd_worker` (read with `DOPPLER_TOKEN_WORKER`) becomes a Worker secret via
   `wrangler secret bulk`. Removing a key here does not delete the secret: use
   `wrangler secret delete`.
3. **Publish the CLI** when `packages/cli/package.json`'s version is not on npm, with provenance.

Never deploy from a laptop.
