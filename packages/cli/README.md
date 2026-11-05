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
| `wurmhol init [--skill]`             | Tell this repo's agents how to share (see below)                 |
| `wurmhol login`                      | Approve this computer; stores `~/.wurmhol/credentials.json`      |
| `wurmhol logout`                     | Delete the stored token                                          |

A pipe ends after 4 hours. `--ttl` asks for another lifetime, like `90m` or `8h`, up to 12 hours
on wurmhol.com.

By default every member of the token's org can open a pipe. `--only ana@x.com,bo@y.com` narrows it
to those members.

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
`127.0.0.1`), `ttl` (seconds, or a duration like `"8h"`; `pipe.endsAt` says when it ends),
`viewers` (emails of the org members who may open it, like `--only`) and `signal` (an
`AbortSignal` that closes the pipe). `openPipe` rejects with a
`FixError` whose message is the one-line fix the CLI prints.

## Teach your agent

`wurmhol init`, run in a project, appends one line to `AGENTS.md` (or `CLAUDE.md` if that is
the file you have) with the dev server's port, read from `package.json`: Next 3000, Astro 4321,
Vite 5173, anything else 8787. It also says whether a token is set (`WURMHOL_TOKEN`, or one from
`wurmhol login`) and, if not, how to get one. `--skill` writes the `wurmhol` skill to `.claude/skills/wurmhol/SKILL.md` as well.

For Claude Code, the same skill comes as a plugin from this repository's marketplace:

```text
/plugin marketplace add handlemotion/wurmhol
/plugin install wurmhol@wurmhol
```

From a terminal, `claude plugin marketplace add handlemotion/wurmhol` and
`claude plugin install wurmhol@wurmhol` do the same. The skill tells the agent when to share (you
want to see a running server), how (`npx wurmhol <port>`, send the URL, `npx wurmhol stop <port>`
when you are done), to follow the fix each error names, and to keep the token out of its output.

## Claude Code cloud environments

The console shows these values after you create a token, each copied in one click. In the
environment's settings, put `WURMHOL_TOKEN=wh_…` under Environment variables and `api.wurmhol.com`
under Allowed domains (Network access). New sessions pick them up.
