# Wurmhol

A private HTTPS URL for a coding agent's dev server, from inside sandboxed cloud containers
(Claude Code cloud and similar) where ngrok and Cloudflare Tunnel can't connect.

```bash
npx wurmhol 8787
# https://k3x9p2m7qa.wurmhol.dev
```

The URL (a pipe) opens only for signed-in members of the org that owns the token, on any device. The CLI
needs one outbound WebSocket on 443 to `api.wurmhol.com` and works through an HTTPS CONNECT proxy (`HTTPS_PROXY`,
`NODE_EXTRA_CA_CERTS`).

- Friends at $15 a year or Business at $20 a month plus metered requests, per org, each with a 14-day trial (ADR 0027).
- `wurmhol ls`, `wurmhol stop <port|id>`, `wurmhol stop --all`, `wurmhol init`
- `WURMHOL_TOKEN`: a token from your org at https://dirt.wurmhol.com (menu → Tokens). `WURMHOL_URL`: a self-hosted install.

In Claude Code, the `wurmhol` plugin teaches the agent when and how to share:

```text
/plugin install wurmhol --marketplace handlemotion/wurmhol
```

The relay can read the traffic it carries; it never logs or stores request or response bodies.
It keeps only each page's `<title>` and favicon, for the wall.

## Repo

[AGENTS.md](AGENTS.md) holds agent rules and task-specific reading links.
[Development](docs/development.md) covers setup and testing;
[Contributing](docs/contributing.md) covers PRs and shipping. The
[documentation map](docs/README.md) separates current guides from historical specs and ADRs.
Product docs, self-hosting included, are at https://wurmhol.com/docs (source in `apps/docs`).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/handlemotion/wurmhol)

The button creates the Worker, D1 and Durable Objects in your Cloudflare account. The pipe
domain's wildcard route and the hostname vars are yours to set afterwards: see
[Self-hosting](https://wurmhol.com/docs/self-hosting).

| Unit                | Package                                 |
| ------------------- | --------------------------------------- |
| `apps/worker`       | `@wurmhol/worker`                       |
| `apps/web`          | `@wurmhol/web`                          |
| `packages/sdk`      | `@wurmhol/sdk` (bundled into `wurmhol`) |
| `packages/cli`      | `wurmhol` (npm)                         |
| `packages/protocol` | `@wurmhol/protocol`                     |
| `packages/auth`     | `@wurmhol/auth`                         |
| `packages/db`       | `@wurmhol/db`                           |

## Local

```bash
pnpm install --frozen-lockfile
pnpm stack:serve        # http://localhost:8787, pipes at http://<id>.pipe.localhost:8787
```

Use the Node version in `.nvmrc` and pnpm version in `package.json`. The stack command applies
local D1 migrations and creates local signing config when missing. See
[Development](docs/development.md#run-locally) for sign-in, hot reload, logs, and stopping it;
[Operations](docs/operations/doppler.md) covers Doppler and the preferred Cloudflare `cf` CLI.

## Marketing site and docs

`apps/site` is hosted Wurmhol's landing page, a static Astro build served by its own Worker
(`wurmhol-site`); nothing in the app depends on it. Its Worker also serves `/docs` by proxying
to the Mintlify deployment named by `DOCS_HOST` in `apps/site/wrangler.jsonc` (Mintlify builds
`apps/docs`; turn on **Host at** `/docs` in its custom domain settings). Empty `DOCS_HOST` makes
`/docs` the 404 page.

License: AGPL-3.0 for the app, MIT for the CLI and the wire protocol (`packages/cli/LICENSE`, `packages/protocol/LICENSE`).
