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
| `wurmhol <port> --name my-app`       | Open it at `https://my-app.wurmhol.dev`, the same URL every time |
| `wurmhol ls [--json]`                | List open pipes and when each ends                               |
| `wurmhol stop <port\|id\|name>`      | End one (`--all` ends every one)                                 |
| `wurmhol init [--skill]`             | Tell this repo's agents how to share (see below)                 |
| `wurmhol login`                      | Approve this computer; stores `~/.wurmhol/credentials.json`      |
| `wurmhol logout`                     | Delete the stored token                                          |
| `wurmhol mcp`                        | Run an MCP server on stdio for agents (see below)                |

A pipe ends after 4 hours. `--ttl` asks for another lifetime, like `90m` or `8h`, up to 12 hours
on wurmhol.com.

`--name` keeps the URL, so an app that signs in with Google or GitHub can be tried through a pipe:
register `https://my-app.wurmhol.dev/<your callback path>` with the provider once. The first org to
use a name keeps it, and one pipe per name is open at a time.

### OAuth with many pipes

To run several pipes of one app at once (parallel agents, one per branch) without registering a
redirect URI for each name, sign in through the relay at `https://oauth.wurmhol.dev`:

1. Register `https://oauth.wurmhol.dev/<your callback path>` with the provider, once. For a GitHub
   OAuth App, register `https://oauth.wurmhol.dev`: any callback path under it is accepted.
2. Configure the app with that redirect URI (in Better Auth, the provider's `redirectURI`).
3. Open as many pipes as you like, named or not. When the app sends a viewer to the provider, the
   relay notes which pipe the sign-in's `state` came from, and sends the provider's callback back
   to that pipe, at the same path and query.

The relay reads only the redirect's `Location` header, keeps a hash of the `state` for at most 10
minutes, and lets each one through once. The app must send the viewer off with a redirect or a
`Location` header (Better Auth does both); `response_mode=form_post` is not supported.

By default every member of the token's org can open a pipe. `--only ana@x.com,bo@y.com` narrows it
to those members.

A client with no browser session, such as a script or an agent in a cloud sandbox, can be let in with
an access key: set `WURMHOL_ACCESS_KEY` (32 to 128 letters, digits, `-` or `_`; for example
`openssl rand -base64 24 | tr '+/' '-_' | tr -d '='`) when you open the pipe, and have the client send
it as the `x-wurmhol-key` header. The relay keeps only its hash, checks it on every request, and
strips it before the request reaches your server. Without it, only signed-in members get in, as
before. Keep the key secret: it is the pipe's only credential for such clients. Plan limits, billing
and the wall apply as for any request.

`WURMHOL_URL` points at a self-hosted install. Node 22+. MIT.

## From your own process

For orchestrators that open pipes for many agents. No daemon: the pipe lives in your process.

```ts
import { openPipe } from "wurmhol";

const pipe = await openPipe({ port: 5173, token: process.env.WURMHOL_TOKEN! });
pipe.url; // send it to the humans
pipe.on("request", ({ method, path, status, durationMs }) => {}); // stays in this process
pipe.on("close", (reason) => {}); // "stopped", "terminated", "expired", "revoked", ...
await pipe.close();
```

Options: `server` (a self-hosted install), `host` (where the dev server listens, default
`127.0.0.1`), `ttl` (seconds, or a duration like `"8h"`; `pipe.endsAt` says when it ends),
`viewers` (emails of the org members who may open it, like `--only`), `name` (a URL that stays
the same, like `--name`), `accessKey` (lets clients with no browser session in; see above), `signal` (an `AbortSignal`
that closes the pipe) and `log` (`(event, fields) => {}`, the connection's connects, drops and
reconnects; never request contents). `openPipe` rejects with a `FixError` whose message is the
one-line fix the CLI prints. ESM only.

## As an MCP server

To ask your own assistant what's open and end pipes, connect the hosted server instead: add
`https://api.wurmhol.com/mcp` to claude.ai, Claude Desktop or Claude Code and sign in, no token
needed ([docs](https://wurmhol.com/docs/mcp)). It cannot open pipes; this one can.

`wurmhol mcp` serves the same actions as MCP tools over stdio, for agents that call tools rather
than run commands. In Claude Code:

```bash
claude mcp add wurmhol -- npx -y wurmhol mcp
```

or, for everyone working in a repository, in its `.mcp.json`:

```json
{
  "mcpServers": {
    "wurmhol": { "command": "npx", "args": ["-y", "wurmhol", "mcp"] }
  }
}
```

| Tool         | Takes                                                           | Returns                                         |
| ------------ | --------------------------------------------------------------- | ----------------------------------------------- |
| `open_pipe`  | `port`, and optionally `ttl` (`"90m"`), `name`, `only` (emails) | `{ id, url, port, name, startedAt, endsAt }`    |
| `list_pipes` | nothing                                                         | `{ pipes: [...] }`, the ones this server opened |
| `stop_pipe`  | `target` (a port, id or name), or `all: true`                   | `{ stopped: [{ id, url }] }`                    |

It finds its token the way the CLI does: `WURMHOL_TOKEN` from the environment the agent host
starts it with (a cloud environment's variables reach it), else the one `wurmhol login` stored.
Without either, a tool call fails with that fix in one line, and works once you have done it; no
restart needed. `WURMHOL_URL` points it at a self-hosted install. Keep tokens out of a committed
`.mcp.json`.

Pipes live in the MCP server's process: they end when the agent's session ends, and `wurmhol ls`
does not show them (nor do the tools show pipes started with `npx wurmhol`).

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
