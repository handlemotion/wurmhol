# Self-hosting Wurmhol

One Cloudflare account, two hostnames, `wrangler deploy`. No other service is required: D1 holds
the data, Durable Objects hold the shares, and billing stays off unless you set Stripe keys.

Below, `example.com` is your app's host and `on.example.com` the domain your shares live under.

## 1. Domains and TLS

- The app: `example.com` (or any host), a custom domain on the Worker.
- Shares: `<id>.on.example.com`. A two-level wildcard needs a certificate that covers
  `*.on.example.com`: in Cloudflare that is **Advanced Certificate Manager** (or a second zone
  whose apex wildcard covers shares, e.g. `*.example-shares.dev`; spec open question 2).
  - DNS: a proxied wildcard record `*.on` (an `AAAA` to `100::` is enough; the Worker route
    answers).
  - Route: `*.on.example.com/*` → the Worker.
- **Public Suffix List.** Submit `on.example.com` to the [PSL](https://github.com/publicsuffix/list)
  so browsers treat every share as its own site: one share's JavaScript then cannot read or set
  cookies for another share or for the app. Wurmhol's cookies are `__Host-` cookies either way,
  but the PSL entry is what isolates shares from each other.

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
| `BETTER_AUTH_URL`                      | `https://example.com`                         |
| `SHARE_DOMAIN`                         | `on.example.com`                              |
| `AUTH_TRUSTED_ORIGINS`                 | empty (or extra origins allowed to call auth) |
| `ENVIRONMENT`                          | `production`                                  |
| `GOOGLE_CLIENT_ID`, `GITHUB_CLIENT_ID` | optional OAuth clients                        |

Secrets (`wrangler secret put <NAME>`): `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), and
optionally `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`.

Deploy:

```bash
D1_DATABASE_ID=<id> WORKER_DOMAIN=example.com WORKER_ROUTE='*.on.example.com/*' \
  WORKER_VAR_BETTER_AUTH_URL=https://example.com WORKER_VAR_SHARE_DOMAIN=on.example.com \
  pnpm --filter @wurmhol/worker deploy:cloudflare
```

For continuous deploys, connect the repo with Cloudflare Workers Builds: build command
`pnpm --filter @wurmhol/web build`, deploy command `pnpm --filter @wurmhol/worker deploy:cloudflare`,
and the variables above as build variables. `.github/workflows/production.yml` then migrates D1
and syncs secrets on each push to `main` (see `docs/operations/doppler.md`).

## 3. Sign-in

Passkeys work with no setup. For OAuth, create the clients with these callback URLs:

- Google: `https://example.com/api/auth/callback/google`
- GitHub: `https://example.com/api/auth/callback/github`

Magic links stay off in production until a mail sender exists (spec open question 4). Sign up
with an OAuth provider first, then add a passkey.

## 4. Billing (optional)

Leave `STRIPE_SECRET_KEY` empty and every org shares without a plan. To bill:

1. In Stripe, one product with a monthly price ($3) and a yearly price ($30).
2. Vars `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`, `BILLING_TRIAL_DAYS` (7 by default).
3. A webhook endpoint `https://example.com/api/auth/stripe/webhook` for
   `checkout.session.completed` and `customer.subscription.created`, `.updated`, `.deleted`; its
   signing secret as `STRIPE_WEBHOOK_SECRET`.
4. The customer portal turned on in Stripe's settings.

## 5. Limits

Per org, enforced by the Durable Objects: `LIMIT_ACTIVE_SHARES` (5), `LIMIT_MONTHLY_BYTES`
(100 GB), `LIMIT_SHARE_SECONDS` (12 h). Rate limits: `RATE_LIMIT_AUTH`, `RATE_LIMIT_CONNECT`,
`RATE_LIMIT_MANAGE` as `<count>/<seconds>` or `off`.

## 6. Using it

```bash
WURMHOL_URL=https://example.com WURMHOL_TOKEN=wh_… npx wurmhol 8787
```

In a sandbox with a Limited network policy, allowlist `example.com` and `*.on.example.com`.

## Local

```bash
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # stack:serve does this for you
pnpm stack:serve        # http://localhost:8787, shares at http://<id>.on.localhost:8787
```

Sign in with the magic link printed in `.local/serve/worker.log` (`auth.dev_link`).
