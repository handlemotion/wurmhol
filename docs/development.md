# Development

## Setup

Use the Node version in [`.nvmrc`](../.nvmrc) and pnpm version in
[`package.json`](../package.json)'s `packageManager`. The published CLI supports Node 22+;
working on the monorepo requires Node 26.

```bash
pnpm install --frozen-lockfile
```

This installs the workspace and the Vite+ pre-commit hook (`.vite-hooks/pre-commit`). The hook
runs `vp staged` (the `staged` block in [`vite.config.ts`](../vite.config.ts): `vp fmt`,
`vp lint --fix`, and test policy); staged files can change during a commit, so re-read them
before editing again.

[Vite+](https://viteplus.dev) (`vp`) is the toolchain: Oxfmt, Oxlint, Vitest, and tsdown (as
`vp pack`) behind one CLI, configured in `vite.config.ts` files. Lint runs Oxlint's rules, the
vendored [anti-slop](../tools/oxlint/anti-slop/UPSTREAM.md) rules, and `complexity`. pnpm stays
the package manager and Turborepo the task runner. `vp` cannot run from a git worktree nested
inside the main checkout (such as `.claude/worktrees/*`); it resolves its tools from the outer
checkout.

### Cloud machines

[`kickoff.sh`](../kickoff.sh) is the pinned, checksum-verified Linux x86_64 machine-tool
installer: Node in `/opt/node`, pnpm, Cloudflare `cf`, Doppler, and `gh stack`. It needs root;
preserve the session user's home so the GitHub extension installs for that user:

```bash
sudo -n env HOME="$HOME" /bin/bash ./kickoff.sh
export PATH="/opt/node/bin:$PATH"
pnpm install --frozen-lockfile
```

Persist that PATH in the host's environment setup. Snapshot builds install tools and
dependencies, not running servers or credentials. Bind stored secrets explicitly when the
host does not inject them; see [Operations](operations/doppler.md#local-development).

The [Claude Code session hook](../.claude/hooks/cloud-session-start.sh) only runs when
`CLAUDE_CODE_REMOTE=true`. It installs dependencies, prepares local variables and migrates D1;
other agent hosts need their own setup. Do not assume a Claude hook ran in Devin or another host.

## Run locally

```bash
pnpm stack:serve
curl -fsS http://127.0.0.1:8787/health
pnpm stack:serve:stop
```

`stack:serve` runs the real Worker and built web app on port 8787 with local D1 and Durable
Objects. It applies local migrations, creates `apps/worker/.dev.vars` from the example with a
random local signing secret if missing, and detaches safely even in a piped command. Logs are
in `.local/serve/worker.log`; development magic links are logged as `auth.dev_link`.
Use this for UI checks rather than `cmd &` in a piped script.

For hot reload, run each in a separate shell:

```bash
pnpm --filter @wurmhol/web dev
pnpm --filter @wurmhol/site dev
```

Vite runs on 5173 and proxies `/api` (including the wall WebSocket) and `/open` to the Worker
on 8787. Astro runs on 4321. For the Doppler-backed Worker instead of `stack:serve`, follow
[Local development](operations/doppler.md#local-development); do not run two Workers on 8787.

Crons do not fire automatically in local development. Run the retention job explicitly:

```bash
curl -fsS http://127.0.0.1:8787/cdn-cgi/local/scheduled
```

## Checks and tests

| Command                                                        | Purpose                                                    |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| `pnpm check`                                                   | Format check, lint, test/workflow/Wrangler config policies |
| `pnpm fix`                                                     | Apply format and lint fixes                                |
| `pnpm check-types`                                             | TypeScript project checks                                  |
| `pnpm test`                                                    | Affected unit suites through Turborepo                     |
| `pnpm test:all`                                                | All unit suites                                            |
| `pnpm test:e2e`                                                | All real-stack e2e suites                                  |
| `pnpm verify`                                                  | Real share through the real CLI against the local stack    |
| `pnpm --filter @wurmhol/worker test:e2e e2e/relay.e2e.test.ts` | One e2e file                                               |
| `pnpm --filter @wurmhol/site build`                            | Astro checks and static site build                         |

The SDK suites (`e2e/sdk*.e2e.test.ts`) also run the built-in WebSocket transport on Node and compile `packages/sdk/examples/embed.ts` with `bun build --compile` (the `bun` devDependency, so no global Bun is needed). E2E setup builds the web app and CLI, then starts real workerd, local D1, Durable Objects,
and local HTTP servers; no stack needs to be started first. Behavior crossing auth, HTTP,
sockets, processes, or the database belongs here, not in mocked unit tests.

The wall's browser suites need Playwright Chromium. Install its browser and Linux dependencies:

```bash
pnpm --filter @wurmhol/worker exec playwright install --with-deps chromium
```

Unit tests are limited to valuable pure logic in `packages/protocol` and `scripts/`, enforced
by [`scripts/check-tests.mjs`](../scripts/check-tests.mjs). Good cases include frame round-trips,
chunking, stream interleaving, and flow-control windows. Tests of constants, getters, mock calls,
or Drizzle query construction do not earn their cost. Do not add tests that cannot name a
plausible bug they catch.

For runtime changes, green suites are the floor: start the local stack, share a real server
with the real CLI, and exercise it with HTTP calls. `pnpm verify` does that baseline; the
[verify skill](../.claude/skills/verify/SKILL.md) lists what else to run for each kind of change. Include what ran and what was observed in
the hand-off. Documentation-only changes need documentation validation, not unrelated e2e runs.

## Package map

| Unit                | Package             | Role                                                                       |
| ------------------- | ------------------- | -------------------------------------------------------------------------- |
| `apps/worker`       | `@wurmhol/worker`   | Hono API, auth, billing, relay, Durable Objects; serves the built web app  |
| `apps/web`          | `@wurmhol/web`      | Vite SPA: sign-in and the shares wall                                      |
| `apps/site`         | `@wurmhol/site`     | Astro marketing site and Worker proxy for hosted docs                      |
| `apps/docs`         | —                   | Mintlify product and self-hosting documentation                            |
| `packages/sdk`      | `@wurmhol/sdk`      | The SDK: tunnel, pipes, device flow, managed pipe (bundled into `wurmhol`) |
| `packages/cli`      | `wurmhol`           | Published CLI, built on the SDK, which it re-exports                       |
| `packages/protocol` | `@wurmhol/protocol` | Pure frame codec and stream multiplexer shared by Node and Worker          |
| `packages/auth`     | `@wurmhol/auth`     | Better Auth configuration                                                  |
| `packages/db`       | `@wurmhol/db`       | Drizzle schema and D1 migrations                                           |

## Database changes

Edit `packages/db/src/schema`, then run `pnpm --filter @wurmhol/db db:generate`. Better Auth's
tables are generated with `pnpm --filter @wurmhol/auth auth:generate`; never hand-edit those
tables, migration files, journals, or snapshots. Additive schema may land before its consumers.
Drop, rename, or tighten nullability only after production code stops using the old shape:
migrations run while the previous Worker still serves.
