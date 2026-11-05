# wurmhol

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
