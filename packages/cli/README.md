# wurmhol

A private HTTPS URL for a local dev server, from inside sandboxed cloud containers (Claude Code
cloud and similar) where ngrok and Cloudflare Tunnel can't connect.

```bash
npx wurmhol login                # approve this computer in the browser; stores a token
npx wurmhol 8787                 # prints https://<id>.wurmhol.dev, then returns
```

In a cloud environment, set `WURMHOL_TOKEN=wh_…` instead (from https://dirt.wurmhol.com, menu →
Tokens): the stored token dies with the container. `WURMHOL_TOKEN` wins when both are there.

Only signed-in members of the token's org can open the URL. One outbound WebSocket on 443,
dialed through `HTTPS_PROXY` when set; `NODE_EXTRA_CA_CERTS` adds a proxy's CA. In a sandbox
that only reaches listed hosts, allow `api.wurmhol.com`: it is the only host the CLI dials.

| Command                              | Does                                                             |
| ------------------------------------ | ---------------------------------------------------------------- |
| `wurmhol <port> [--ttl 8h] [--json]` | Open a pipe to a port. `--json` prints `{url, port, id, endsAt}` |
| `wurmhol ls [--json]`                | List open pipes and when each ends                               |
| `wurmhol stop <port\|id>`            | End one (`--all` ends every one)                                 |
| `wurmhol init`                       | Tell this repo's agents how to share (AGENTS.md)                 |
| `wurmhol login`                      | Approve this computer; stores `~/.wurmhol/credentials.json`      |
| `wurmhol logout`                     | Delete the stored token                                          |

A pipe ends after 4 hours. `--ttl` asks for another lifetime, like `90m` or `8h`, up to 12 hours
on wurmhol.com.

`WURMHOL_URL` points at a self-hosted install. Node 20+. MIT.

## From your own process: `wurmhol/sdk`

For orchestrators that open pipes for many agents. No daemon: the pipe lives in your process.

```ts
import { openPipe } from "wurmhol/sdk";

const pipe = await openPipe({ port: 5173, token: process.env.WURMHOL_TOKEN! });
pipe.url; // send it to the humans
pipe.on("request", ({ method, path, status, durationMs }) => {}); // stays in this process
pipe.on("close", (reason) => {}); // "stopped", "terminated", "expired", "revoked", ...
await pipe.close();
```

Options: `server` (a self-hosted install), `host` (where the dev server listens, default
`127.0.0.1`), `ttl` (seconds, or a duration like `"8h"`; `pipe.endsAt` says when it ends) and
`signal` (an `AbortSignal` that closes the pipe). `openPipe` rejects with a
`FixError` whose message is the one-line fix the CLI prints.
