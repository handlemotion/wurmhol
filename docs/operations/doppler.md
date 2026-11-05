# Doppler secrets

Project `wurmhol` (from Omni's `docs/operations/doppler.md`). Branch configs inherit from their
environment's root config.

| Config       | Consumer                                 | Holds                                                                                                                                                                                                                            |
| ------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`        | every local command (root)               | local D1 settings, non-secret dev config                                                                                                                                                                                         |
| `dev_worker` | `wrangler dev` (mounted `.dev.vars`)     | `BETTER_AUTH_SECRET`, `ENVIRONMENT=development`, OAuth client secrets, Stripe sandbox keys (`STRIPE_*`)                                                                                                                          |
| `prd_worker` | Worker secrets                           | `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                                                                                                               |
| `prd_github` | `production.yml`, `release.yml`, records | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `WORKER_DOMAIN`, `DOPPLER_TOKEN_WORKER` (read-only, `prd_worker`), `RELEASE_APP_CLIENT_ID`, `RELEASE_APP_PRIVATE_KEY`; records `WORKER_ROUTE`, `WORKER_VAR_*` |

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
3. **Publish the CLI** when `packages/cli/package.json`'s version is not on npm, through npm
   trusted publishing: npm trusts this workflow's OIDC token, so no npm token exists anywhere.
   npm takes a few minutes to serve a new version, and the job waits until it does (up to 15
   minutes), so a green job means `npm install wurmhol@<version>` works.

## The CLI on npm

npm can only trust a workflow for a package that already exists, so the first version is
published once by hand, by an owner with 2FA:

```bash
pnpm install && pnpm --filter wurmhol build
cd packages/cli && npm login && npm publish --access public
```

Then on npmjs.com, package `wurmhol` → Settings → Trusted Publisher → GitHub Actions:
organization `handlemotion`, repository `wurmhol`, workflow `production.yml`, environment
`production`. Set "Publishing access" to require 2FA and disallow tokens. Every later version
ships from `main` when a Changesets release pull request bumps it (`.changeset/README.md`).

## The release pull request

`.github/workflows/release.yml` opens and updates the Changesets release pull request
(`.changeset/README.md`) as a GitHub App: a pull request opened with the workflow's own
`GITHUB_TOKEN` starts no `pull_request` workflows, so `Checks` would never run on it. Set it up
once:

1. GitHub → organization `handlemotion` → Settings → Developer settings → GitHub Apps → New GitHub
   App. Any name (for example `wurmhol-release`), homepage `https://github.com/handlemotion/wurmhol`,
   Webhook off. Repository permissions: Contents read and write, Pull requests read and write;
   nothing else. "Only on this account".
2. On the App's page, note the Client ID and generate a private key (a `.pem` download).
3. Install App → `handlemotion` → Only select repositories → `handlemotion/wurmhol`.
4. Put both in Doppler `prd_github`: `RELEASE_APP_CLIENT_ID` (the Client ID) and
   `RELEASE_APP_PRIVATE_KEY` (the whole `.pem`, including the `BEGIN` and `END` lines). Then
   delete the downloaded file. Doppler's GitHub sync makes them secrets of the `production`
   environment.

Until both exist, the workflow logs that the App is not configured and succeeds without doing
anything, so forks and self-hosters who don't release the CLI skip this section.

Never deploy from a laptop.
