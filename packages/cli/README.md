# wurmhol

A private HTTPS URL for a local dev server, from inside sandboxed cloud containers (Claude Code
cloud and similar) where ngrok and Cloudflare Tunnel can't connect.

```bash
export WURMHOL_TOKEN=wh_…        # from https://dirt.wurmhol.com (menu → Tokens)
npx wurmhol 8787                 # prints https://<id>.pipe.wurmhol.com, then returns
```

Only signed-in members of the token's org can open the URL. One outbound WebSocket on 443,
dialed through `HTTPS_PROXY` when set; `NODE_EXTRA_CA_CERTS` adds a proxy's CA. In a sandbox
that only reaches listed hosts, allow `api.wurmhol.com`: it is the only host the CLI dials.

| Command                   | Does                                                     |
| ------------------------- | -------------------------------------------------------- |
| `wurmhol <port> [--json]` | Open a pipe to a port. `--json` prints `{url, port, id}` |
| `wurmhol ls [--json]`     | List open pipes                                          |
| `wurmhol stop <port\|id>` | End one (`--all` ends every one)                         |
| `wurmhol init`            | Tell this repo's agents how to share (AGENTS.md)         |

`WURMHOL_URL` points at a self-hosted install. Node 20+. MIT.
