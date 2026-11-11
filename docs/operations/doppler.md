# Cloudflare and Doppler operations

## Cloudflare CLI

Prefer **`cf`, not `wrangler`**, for direct Cloudflare account and resource operations.
[`kickoff.sh`](../../kickoff.sh) installs the pinned CLI. Discover the command and its flags
before using it:

```bash
cf --help
cf auth whoami
cf accounts get
cf workers --help
cf schema workers list
```

`CLOUDFLARE_API_TOKEN` authenticates headlessly; `CLOUDFLARE_ACCOUNT_ID` selects the account.
Use `cf schema <command>` to inspect the API contract. Do not guess a Wrangler-equivalent flag
or change production resources to test authentication.

The repo's dev/test/deploy scripts and CI still use their pinned Wrangler runtime. Run those
scripts as documented; this CLI preference does not migrate their config or authorize an
ad-hoc production deploy. The self-hosting manual documents the separate installer's flow.

## Doppler configs

Project `wurmhol`. Branch configs inherit from their environment's root config.

| Config       | Consumer                             | Holds                                                                                                                                                                        |
| ------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`        | development branch configs           | root config inherited by `dev_*` configs                                                                                                                                     |
| `dev_worker` | `wrangler dev` (mounted `.dev.vars`) | `BETTER_AUTH_SECRET`, `ENVIRONMENT=development`, OAuth client secrets, Stripe sandbox keys (`STRIPE_*`)                                                                      |
| `prd_worker` | Worker secrets                       | `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*`                                         |
| `prd_github` | `production.yml`, records            | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `WORKER_DOMAIN`, `DOPPLER_TOKEN_WORKER` (read-only, `prd_worker`); records `WORKER_ROUTE`, `WORKER_VAR_*` |

Rules:

- A key is either a Worker secret (`prd_worker`) or a Worker var (`WORKER_VAR_*`), never both:
  Cloudflare refuses a name bound twice. Public values (client ids, hosts) are vars. Stripe's price
  ids are the exception: they sit in `prd_worker` beside `STRIPE_SECRET_KEY`, so the secret sync
  delivers the key and its prices in one step and no deploy runs with one but not the other.
- Check presence by name only: `doppler secrets -p wurmhol -c <config> --only-names`.
- Never print, commit, or persist keys, passwords, signing secrets, `*_SECRET*`, `*_KEY`,
  `*_TOKEN`, or `wh_…` share tokens. Verify them by name, presence, or length only. Use injection
  or the ephemeral mount instead of downloading credentials to a durable plaintext file.
- Non-secret hostnames, URLs, ports, limits, and price ids can be read with
  `doppler secrets get <NAME> -p wurmhol -c <config> --plain`; verify them instead of guessing.
  When unsure, treat a value as a credential.
- Writes to `dev*` configs are allowed when requested. Creating, rotating, or deleting
  production secrets needs explicit approval.

## Local development

With `DOPPLER_TOKEN` available, the Worker's `dev` script mounts `dev_worker` as an ephemeral
named pipe at `apps/worker/.dev.vars`; it does not write a regular secrets file. On a fresh
checkout, apply local D1 migrations with the repo-pinned local runtime tooling first:

```bash
doppler secrets -p wurmhol -c dev_worker --only-names
pnpm --filter @wurmhol/worker exec wrangler d1 migrations apply wurmhol --local
pnpm --filter @wurmhol/worker dev
```

The mount path must be absent before starting. Do not overwrite a hand-made config. If using
[`pnpm stack:serve`](../development.md#run-locally), use its local example-based config instead;
do not run both Worker modes on port 8787. Vite and Astro's `dev` scripts do not invoke Doppler.
For other commands, inject config with `doppler run -p wurmhol -c <config> -- <command>`.

Headless authentication uses `DOPPLER_TOKEN` with access to the intended project/config; do
not assume a stored credential is already in the shell. In Devin, bind exec environment
variables to the repo-scoped secrets explicitly:

| exec environment variable | Stored reference                                         |
| ------------------------- | -------------------------------------------------------- |
| `DOPPLER_TOKEN`           | `secret:repo:handlemotion/wurmhol:DOPPLER_TOKEN`         |
| `CLOUDFLARE_API_TOKEN`    | `secret:repo:handlemotion/wurmhol:CLOUDFLARE_API_TOKEN`  |
| `CLOUDFLARE_ACCOUNT_ID`   | `secret:repo:handlemotion/wurmhol:CLOUDFLARE_ACCOUNT_ID` |

These are references, not values to paste into a shell or commit. On other hosts use their
secure environment injection. The Claude Code remote hook uses `DOPPLER_TOKEN_WORKER` when
provided and writes a gitignored `.dev.vars`; it is specific to `CLAUDE_CODE_REMOTE=true`, not
a universal session initializer. Prefer the ephemeral dev-script mount for interactive work.

## Production deploys

Hosted production ships through `main`, never an ad-hoc deploy from a laptop or agent session.
Self-hosters follow [their own deployment guide](../../apps/docs/self-hosting/manual.mdx).

Cloudflare Workers Builds deploys `main` (build `pnpm --filter @wurmhol/web build`, deploy
`pnpm --filter @wurmhol/worker deploy:cloudflare`, with `D1_DATABASE_ID`, `WORKER_DOMAIN`,
`WORKER_ROUTE` and `WORKER_VAR_*` as build variables copied from `prd_github`). A `WORKER_ROUTE`
entry `<pattern>@<zone>` names its zone, as `*/*@wurmhol.dev` (custom domains) must; a deploy
replaces the Worker's routes with the list, so a route added by hand does not survive one.
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

Never deploy from a laptop.
