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

- $12 a year per org (ADR 0004).
- `wurmhol ls`, `wurmhol stop <port|id>`, `wurmhol stop --all`, `wurmhol init`
- `WURMHOL_TOKEN`: a token from your org at https://dirt.wurmhol.com (menu → Tokens). `WURMHOL_URL`: a self-hosted install.

In Claude Code, the `wurmhol` plugin teaches the agent when and how to share:

```text
/plugin install wurmhol --marketplace handlemotion/wurmhol
```

The relay can read the traffic it carries; it never logs or stores request or response bodies.
It keeps only each page's `<title>` and favicon, for the wall.

## Repo

`docs/spec/v1.md` is the spec; `AGENTS.md` the rules; `docs/self-hosting.md` runs your own.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/handlemotion/wurmhol)

The button creates the Worker, D1 and Durable Objects in your Cloudflare account. The pipe
domain's wildcard route and the hostname vars are yours to set afterwards: see
[Deploy to Cloudflare](docs/self-hosting.md#deploy-to-cloudflare).

| Unit                | Package             |
| ------------------- | ------------------- |
| `apps/worker`       | `@wurmhol/worker`   |
| `apps/web`          | `@wurmhol/web`      |
| `packages/cli`      | `wurmhol` (npm)     |
| `packages/protocol` | `@wurmhol/protocol` |
| `packages/auth`     | `@wurmhol/auth`     |
| `packages/db`       | `@wurmhol/db`       |

License: AGPL-3.0 for the app, MIT for the CLI (`packages/cli/LICENSE`).
