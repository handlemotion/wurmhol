# wurmhol

A private HTTPS URL for a local dev server, from inside sandboxed cloud containers (Claude Code
cloud and similar) where ngrok and Cloudflare Tunnel can't connect.

```bash
export WURMHOL_TOKEN=wh_…        # from https://dirt.wurmhol.com (menu → Tokens)
npx wurmhol 8787                 # prints https://<id>.wurmhol.dev, then returns
```

Only signed-in members of the token's org can open the URL. One outbound WebSocket on 443,
dialed through `HTTPS_PROXY` when set; `NODE_EXTRA_CA_CERTS` adds a proxy's CA. In a sandbox
that only reaches listed hosts, allow `api.wurmhol.com`: it is the only host the CLI dials.

| Command                   | Does                                                     |
| ------------------------- | -------------------------------------------------------- |
| `wurmhol <port> [--json]` | Open a pipe to a port. `--json` prints `{url, port, id}` |
| `wurmhol ls [--json]`     | List open pipes                                          |
| `wurmhol stop <port\|id>` | End one (`--all` ends every one)                         |
| `wurmhol init [--skill]`  | Tell this repo's agents how to share (see below)         |

`WURMHOL_URL` points at a self-hosted install. Node 20+. MIT.

## Teach your agent

`wurmhol init`, run in a project, appends one line to `AGENTS.md` (or `CLAUDE.md` if that is
the file you have) with the dev server's port, read from `package.json`: Next 3000, Astro 4321,
Vite 5173, anything else 8787. It also says whether `WURMHOL_TOKEN` is set and, if not, where to
set it. `--skill` writes the `wurmhol` skill to `.claude/skills/wurmhol/SKILL.md` as well.

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

The console shows both values after you create a token, each copied in one click. In the
environment's settings, put `WURMHOL_TOKEN=wh_…` under Environment variables and `api.wurmhol.com`
under Allowed domains (Network access). New sessions pick them up.
