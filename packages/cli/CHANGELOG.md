# wurmhol

## 0.2.0

### Minor Changes

- b61202d: `wurmhol init` writes the agent line with the dev server's port from `package.json` (Next 3000,
  Astro 4321, Vite 5173, else 8787), says whether a token is set (`WURMHOL_TOKEN` or
  `wurmhol login`) and how to get one, and `--skill` writes the `wurmhol` skill to
  `.claude/skills/wurmhol/SKILL.md`.
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
