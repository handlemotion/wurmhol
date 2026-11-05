# Self-hosting Wurmhol

One Cloudflare account, two hostnames, `wrangler deploy`. No other service is required: D1 holds
the data, Durable Objects hold the shares, and billing stays off unless you set Stripe keys.

Below, `dirt.example.com` is the console (the app: sign-in, the wall, its API), `api.example.com`
the host the CLI dials (ADR 0006), and `example-pipes.dev` a second domain your pipes live under
(ADR 0007). One host for the app also works: leave `CONNECT_HOST` and `APP_ALIASES` empty.

## 1. Domains and TLS

- The console: `dirt.example.com`, a custom domain on the Worker (`BETTER_AUTH_URL`). Optional
  aliases that redirect to it (`APP_ALIASES`, e.g. `app.example.com`) are custom domains too.
- The CLI's host: `api.example.com`, a custom domain on the Worker (`CONNECT_HOST`).
- Pipes: `<id>.example-pipes.dev`, on a domain of their own, added as a second zone in the same
  Cloudflare account. The zone's free Universal SSL certificate covers `*.example-pipes.dev`, and
  every pipe is a different site from the console.
  - DNS: a proxied wildcard record `*` (an `AAAA` to `100::` is enough; the Worker route
    answers). The apex needs no record.
  - Route: `*.example-pipes.dev/*` → the Worker.
- Alternative, one domain: pipes at `<id>.pipe.example.com`. That is a two-level wildcard, which
  the free certificate does not cover: in Cloudflare it needs **Advanced Certificate Manager**
  (paid) for `*.pipe.example.com`, a proxied `*.pipe` record and the route `*.pipe.example.com/*`.
  Pipes are then the same site as the console until the Public Suffix List entry lands.
- **Public Suffix List.** Submit the pipe domain (`example-pipes.dev`, or `pipe.example.com`) to
  the [PSL](https://github.com/publicsuffix/list) so browsers treat every pipe as its own site:
  one pipe's JavaScript then cannot read or set cookies for another pipe. Wurmhol's cookies are
  `__Host-` cookies either way, but the PSL entry is what isolates pipes from each other. The PSL
  asks for more than two years of registration left on the domain.

## 2. Database and Worker

```bash
pnpm install
cd apps/worker
pnpm exec wrangler d1 create wurmhol            # note the database id
D1_DATABASE_ID=<id> node scripts/deploy-cloudflare.mjs --config-only
pnpm exec wrangler d1 migrations apply DB --remote --config wrangler.deploy.jsonc
```

Set the vars (see `apps/worker/.dev.vars.example` for every one): in `wrangler.jsonc`, the
dashboard, or `WORKER_VAR_<NAME>` build variables for the deploy script.

| Var                                    | Value                                         |
| -------------------------------------- | --------------------------------------------- |
| `BETTER_AUTH_URL`                      | `https://dirt.example.com`                    |
| `CONNECT_HOST`                         | `api.example.com` (optional)                  |
| `APP_ALIASES`                          | `app.example.com` (optional)                  |
| `SHARE_DOMAIN`                         | `example-pipes.dev`                           |
| `AUTH_TRUSTED_ORIGINS`                 | empty (or extra origins allowed to call auth) |
| `ENVIRONMENT`                          | `production`                                  |
| `GOOGLE_CLIENT_ID`, `GITHUB_CLIENT_ID` | optional OAuth clients                        |

Secrets (`wrangler secret put <NAME>`): `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), and
optionally `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`.

Deploy:

```bash
D1_DATABASE_ID=<id> WORKER_DOMAIN=dirt.example.com,api.example.com,app.example.com \
  WORKER_ROUTE='*.example-pipes.dev/*' WORKER_VAR_BETTER_AUTH_URL=https://dirt.example.com \
  WORKER_VAR_SHARE_DOMAIN=example-pipes.dev WORKER_VAR_CONNECT_HOST=api.example.com \
  WORKER_VAR_APP_ALIASES=app.example.com \
  pnpm --filter @wurmhol/worker deploy:cloudflare
```

For continuous deploys, connect the repo with Cloudflare Workers Builds: build command
`pnpm --filter @wurmhol/web build`, deploy command `pnpm --filter @wurmhol/worker deploy:cloudflare`,
and the variables above as build variables. `.github/workflows/production.yml` then migrates D1
and syncs secrets on each push to `main` (see `docs/operations/doppler.md`).

## 3. Sign-in

Passkeys work with no setup. For OAuth, create the clients with these callback URLs:

- Google: `https://dirt.example.com/api/auth/callback/google`
- GitHub: `https://dirt.example.com/api/auth/callback/github`

Magic links (ADR 0005): onboard your domain under **Email Service → Email Sending** and set
`MAIL_FROM` (for example `sign-in@example.com`). The `EMAIL` binding in `wrangler.jsonc` is the
credential; no API key. Without `MAIL_FROM`, sign in with OAuth and add a passkey.

## 4. Billing (optional)

Leave `STRIPE_SECRET_KEY` empty and every org shares without a plan. To bill:

1. In Stripe, one product with a yearly price (hosted Wurmhol: $12 a year, ADR 0004) and, if you
   want, a monthly one.
2. Vars `STRIPE_PRICE_YEARLY` and optionally `STRIPE_PRICE_MONTHLY`. There is no trial: an org
   subscribes before its first pipe.
3. A webhook endpoint `https://dirt.example.com/api/auth/stripe/webhook` for
   `checkout.session.completed` and `customer.subscription.created`, `.updated`, `.deleted`; its
   signing secret as `STRIPE_WEBHOOK_SECRET`.
4. The customer portal turned on in Stripe's settings.

## 5. Limits

Per org, enforced by the Durable Objects: `LIMIT_ACTIVE_SHARES` (5), `LIMIT_MONTHLY_BYTES`
(100 GB), `LIMIT_SHARE_SECONDS` (12 h). Rate limits: `RATE_LIMIT_AUTH`, `RATE_LIMIT_CONNECT`,
`RATE_LIMIT_MANAGE` as `<count>/<seconds>` or `off`.

## 6. Using it

```bash
WURMHOL_URL=https://api.example.com WURMHOL_TOKEN=wh_… npx wurmhol 8787
```

In a sandbox with a Limited network policy, allowlist `api.example.com` (the only host the CLI
dials).

## 7. Marketing site (optional)

`apps/site` is hosted Wurmhol's landing page: a static Astro build that its own Worker
(`wurmhol-site`) serves with Workers static assets. Nothing in the app depends on it, so most
installs skip it. To run one anyway, change its copy and links, then:

```bash
pnpm --filter @wurmhol/site build
cd apps/site && pnpm exec wrangler deploy --domain example.com
```

If you deploy it on the apex, give the app its own host (for example `app.example.com`).

## Local

```bash
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # stack:serve does this for you
pnpm stack:serve        # http://localhost:8787, shares at http://<id>.pipe.localhost:8787
```

Sign in with the magic link printed in `.local/serve/worker.log` (`auth.dev_link`).
