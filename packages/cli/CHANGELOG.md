# wurmhol

## 0.8.0

### Minor Changes

- 0a9e319: Embedded tunnels (ADR 0032): `WurmholEmbed` (also `@wurmhol/sdk/embed`) lets a SaaS backend make tenants, subjects and private tunnels for its own users with an integration key, and issue and revoke their grants; `grantHeaders` sends a program's grant; and `tunnelSocket` (also `@wurmhol/sdk/browser`, no Node APIs) opens a page's WebSocket to a tunnel with its grant and renews it when it expires. `openPipe`, `keepOpen` and `wurmhol <port>` accept a tunnel's connector (`whc_…`) as the token, which opens that one tunnel and refuses a name, viewers or an access key.
- 1fec8cb: `import { Wurmhol, keepOpen } from "wurmhol"` is now a full SDK for apps that embed pipes. It signs people in with the device flow and keeps the token in a store you choose, opens a pipe that reopens itself when its lifetime runs out (with backoff, and the same URL for a named pipe), lists and ends the org's pipes, and rejects with a `FixError` that has a `code` and the relay's `status`. A pipe also reports `disconnected` and `reconnected`. It runs on Bun, including a compiled Bun binary, which `openPipe` could not. `openPipe` and the CLI behave as before.

## 0.7.0

### Minor Changes

- d9b6872: A pipe can take an access key for clients with no browser session. Set `WURMHOL_ACCESS_KEY` (or pass `accessKey` to `openPipe`) and clients send it as the `x-wurmhol-key` header; the relay keeps only its hash and strips the header before the request reaches your server. Without a key, only signed-in members get in, as before.

## 0.6.0

### Minor Changes

- 0d98dc1: `wurmhol mcp` no longer fails without a token: `open_pipe` returns an approval link at once (`approval: true`) for the agent to send to the user, and opens the pipe once the computer is approved there. A second call while it waits returns the same link. A second `npx wurmhol <port>` with no token while another share waits on its link now prints that same link and opens once it is approved, instead of starting a second login.

### Patch Changes

- f58591d: `wurmhol logs <port>` shows why a share that waited for approval never opened its pipe, after its background process has exited.

## 0.5.0

### Minor Changes

- 37c3332: `wurmhol <port> --path /checkout?step=2` prints the pipe's link opened at that page (and `pageUrl` in `--json`); sign-in lands there. `wurmhol mcp`'s `open_pipe` takes `path` and returns `pageUrl`. A path that would leave the pipe is refused with a fix.
- 75d13e8: A pipe whose connection is gone longer than the relay's reconnect grace (a laptop asleep, a network down) no longer ends: `wurmhol <port>` opens it again for the same port and flags, retrying with backoff (1 s doubling to 60 s) until its end time. A `--name` pipe gets its URL back; an unnamed one gets a new URL, shown by `wurmhol ls`, and both logs record a `reopened` event with the old and new ids. `wurmhol stop` ends it, including while it retries.
- a6c835e: `wurmhol logs <port|id|name>` shows a pipe's recent requests (method, path without query values, status, time taken) and connection events, with `--follow` and `--json`; `wurmhol mcp` gains a `recent_requests` tool. The log stays on this machine, capped at about 2 MB per pipe, and never holds bodies, headers, cookies or query values.
- e7deeba: `npx wurmhol <port>` run again with the same flags prints the pipe that is already open on this machine (same `--json` shape) instead of opening a second one. A different `--name`, `--only`, `--link` or `--note`, or any `--ttl`, opens a new pipe; `wurmhol stop <port>` first for a new URL.
- ea6013c: `npx wurmhol <port>` with no token no longer fails: it prints an approval link where the URL goes (`--json` adds `"approval": true`) and returns. Approving the computer at that link saves its token and opens the pipe, and the page goes straight to it. `wurmhol ls` lists the share as waiting for approval and `wurmhol stop <port>` ends the wait.
- ac586ae: Add `wurmhol doctor [--port N] [--json]`: checks the token, `HTTPS_PROXY` and its CA, whether the network allows the CLI's host and the pipe domain, and whether a port answers HTTP on 127.0.0.1 or ::1; one line each, `ok` or the fix, exit 1 if any fails. `wurmhol init` and `wurmhol login` now name the hosts to allowlist first.

### Patch Changes

- 585221b: Pipes and `wurmhol host` reach a dev server that listens only on `::1`, like Vite on its default `localhost` with Node 17+: they try 127.0.0.1, then ::1, and remember which one answered.
- 11084c5: A pipe whose reconnect is refused for good now closes with the relay's reason: `revoked` when its token expired or was revoked, `no_subscription` when the org has no plan, or why the share ended. It used to close as `disconnected`. A viewer who opens a pipe before its server is up no longer puts "Waiting for port N" on the wall as the pipe's title.

## 0.4.0

### Minor Changes

- 5e8235c: `wurmhol host --install` keeps this computer connected to the wall: it starts `wurmhol host` at login and restarts it if it stops (a launch agent on macOS, a systemd user service on Linux). `wurmhol host --uninstall` removes it.
- 42e98fa: `wurmhol host --code <code>` logs this computer in with the setup code in Create pipe's command, so there is nothing to approve in the browser.
- eb3b591: `wurmhol host` connects this computer to the wall, so you can open a pipe to any web server running on it from Create pipe in the browser.

### Patch Changes

- ad4811a: A revoked pipe or `wurmhol host` stops within 2 s of the server closing it, instead of up to 30 s when the connection lingers.
- 0cf8375: `wurmhol host` no longer lists debuggers (Node's, Chrome's and wrangler's inspectors) or ports that answer with an error other than 404. Set `WURMHOL_HOST_IGNORE=9229,5555` to leave out other ports.

## 0.3.0

### Minor Changes

- f61e94d: Add `wurmhol mcp`, a stdio MCP server with `open_pipe`, `list_pipes` and `stop_pipe` tools for agents. It finds its token like the CLI (`WURMHOL_TOKEN`, else `wurmhol login`), and its pipes end when the agent's MCP session ends.
- cb47869: `wurmhol <port> --name my-app` opens the pipe at `https://my-app.wurmhol.dev`, the same URL every time, so it can be registered as an OAuth redirect URI. `wurmhol stop my-app` ends it; `openPipe` takes `name` too.
- 274245e: The wall shows where each pipe came from: the git repo, branch and commit it was opened in, and the agent session (Claude Code, Codex, Cursor and others). New flags `--link <url>` and `--note "<text>"` add a link and a line of text; `openPipe` takes them as `source`.

### Patch Changes

- 51c8a26: A request the relay sends the instant a pipe connects or reconnects is no longer dropped: the CLI listens from the moment its socket opens.
- c4de180: An unknown flag, a flag missing its value, or a value on a flag that takes none now prints one line naming the flag and pointing at `npx wurmhol@latest --help`, and exits 1, instead of a Node stack trace.

## 0.2.0

### Minor Changes

- b61202d: `wurmhol init` writes the agent line with the dev server's port from `package.json` (Next 3000,
  Astro 4321, Vite 5173, else 8787), says whether a token is set (`WURMHOL_TOKEN` or
  `wurmhol login`) and how to get one, and `--skill` writes the `wurmhol` skill to
  `.claude/skills/wurmhol/SKILL.md`.
- Needs Node 22 or later. Node 20 reached end of life in April 2026.
- 4a62a9e: Name who may open a pipe with `--only ana@x.com,bo@y.com` (or `openPipe({ viewers })` in the
  SDK). They must be members of the token's org; a name that isn't is refused with the fix. Without
  `--only`, every member of the org may open it, as before.
- 3d40169: Pipes end after 4 hours by default. Ask for another lifetime with `--ttl` (`90m`, `8h`, up to
  12 hours on wurmhol.com), or `openPipe({ ttl })` in the SDK. `wurmhol ls` shows when each pipe
  ends, and `--json` output carries `endsAt`.
- ee7b75b: `import { openPipe } from "wurmhol"`: open a pipe from your own Node process with `openPipe({ port, token })`, with `request` and `close` events, an opt-in `log` callback, and `close()`. The CLI runs on it, unchanged.
- 8e18197: `wurmhol login` approves this computer in the browser with a short code and stores an org token in
  `~/.wurmhol/credentials.json` (mode 0600); `wurmhol logout` deletes it. `WURMHOL_TOKEN` still wins
  when set.

### Patch Changes

- eeeb9fb: README: hosted Wurmhol's pipes are at `https://<id>.wurmhol.dev`.

## 0.1.1

### Patch Changes

- The README names `api.wurmhol.com` as the one host a sandbox must allow.
