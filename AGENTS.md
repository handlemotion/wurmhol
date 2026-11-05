# Wurmhol agent rules

Wurmhol gives a coding agent's dev server a private HTTPS URL that its humans open in their own
browser, from inside sandboxed cloud containers where ngrok and Cloudflare Tunnel can't connect.
The product spec is `docs/spec/v1.md`: read it before you design anything, and record any
departure from it as an ADR in `docs/adr/`.

TypeScript monorepo: pnpm workspaces + Turborepo, one Cloudflare Worker (Hono) with Durable
Objects, D1 through Drizzle, Better Auth, a Node CLI on npm.

Repo-wide rules only. Before editing an app or package, read its `AGENTS.md` if it has one: it
extends this file and wins where they differ. Explicit user instructions override every file here.

## Architecture

| Unit                | Package             | Role                                                                      |
| ------------------- | ------------------- | ------------------------------------------------------------------------- |
| `apps/worker`       | `@wurmhol/worker`   | The Worker: Hono API, auth, Stripe, relay routing, DOs; serves `apps/web` |
| `apps/web`          | `@wurmhol/web`      | Vite SPA: login and the shares wall                                       |
| `apps/site`         | `@wurmhol/site`     | Marketing site at the apex domain (Astro, static)                         |
| `packages/cli`      | `wurmhol` (npm)     | The CLI                                                                   |
| `packages/protocol` | `@wurmhol/protocol` | Frame codec and stream multiplexer. Pure, no I/O                          |
| `packages/auth`     | `@wurmhol/auth`     | Better Auth config (from Omni)                                            |
| `packages/db`       | `@wurmhol/db`       | Drizzle schema and D1 migrations                                          |

- Any UI or design work: read `DESIGN.md` first, every time. Its rules (components only, semantic
  classes, `skullet` for loading states) apply to every screen.
- Boundaries are hard:
  - `packages/protocol` stays free of I/O: it runs in the Worker and in Node, and its tests are
    cheap because of it. Both ends speak it; never hand-roll a second codec.
  - Every org-owned table has `org_id`, and every route that reads one checks the caller's
    membership in that org first.
  - Request and response bodies that pass through the relay are never logged or stored. Only the
    page `<title>` and the favicon are kept, for the wall.
  - The dev server never sees Wurmhol's cookies: the relay strips them before forwarding.

## Commands

- Install `pnpm install` · Format `pnpm format` · Lint `pnpm lint` · Types `pnpm check-types`
- `pnpm check` runs format check, lint (oxlint), and policy scripts (`scripts/check-*.mjs`);
  `pnpm fix` applies the fixable ones.
- `pnpm test` runs affected unit suites. `pnpm test:e2e` runs e2e suites against the real local
  stack (`wrangler` with local D1 and Durable Objects, the real CLI, real local HTTP servers):
  nothing to start first. One file: `pnpm --filter <pkg> test:e2e e2e/<file>`.
- `pnpm stack:serve` serves the real Worker and built web app on `:8787` with local D1, detached;
  it returns once `/health` answers (`pnpm stack:serve:stop` stops it). Use it for UI checks
  instead of backgrounding a server yourself (`cmd &` in a piped script hangs).
- Node is 26 (`.nvmrc`). Cloud sessions put `/opt/node/bin` first. The CLI itself supports
  Node 20+.
- The pre-commit hook runs `lint-staged` (`oxfmt`, `oxlint --fix`, test policy), so staged files
  can change during `git commit`. Re-read a file after committing before you edit it again.

## Testing

Tests are a cost. Each one must catch a bug we would plausibly ship. Zero low-signal tests.

- **E2E first.** Behavior that crosses a process, the database, a socket, auth, or HTTP is proven
  with Vitest e2e suites (`*.e2e.test.ts`) against the real local stack: real workerd, real D1,
  real Durable Objects, the real CLI and a real HTTP server. No mocks, stubs, or fakes in e2e
  (enforced).
- **Unit tests only for valuable pure logic**, and only in `packages/protocol` and `scripts/`
  (enforced by `scripts/check-tests.mjs`). Good: frame round-trips, chunking, stream
  interleaving, flow-control windows. Bad: testing that a constant equals itself, that Drizzle
  builds a query, that a mock was called, getters, snapshots of whole objects nobody reads.
- Before writing a test, name the bug it catches. If you cannot, do not write it.
- Delete tests that stop catching anything. Never weaken an assertion to make it pass.
- No `.only`, `.skip`, `.todo` (enforced).
- Evidence is real or reported as unverified. A green suite that mocks the thing under test is
  not evidence.

## Verify it running

Own the follow-through. Green tests are the floor, not the proof.

- Before you call work done, run it: start the real local stack (`pnpm stack:serve`), share a
  real server with the real CLI, and open it with real HTTP calls. Report what you ran and what
  you saw.
- After a merge to `main`, check production yourself: the deploy finished, the active version is
  the new one, `/health` answers, and logs show no new errors. Report the result, or say exactly
  what you could not check.
- If a check would touch production data or cost money beyond normal use, ask first.

## Secrets (Doppler)

- Doppler project `wurmhol` holds every secret. Configs: `dev` (shared local), `dev_worker`,
  `prd_worker`, `prd_github`. Details: `docs/operations/doppler.md`.
- Local commands run under Doppler: `doppler run -p wurmhol -c dev_<unit> -- <command>`. Package
  `dev` scripts already do. `DOPPLER_TOKEN` authenticates headlessly (cloud, CI).
- Credentials are keys, tokens, passwords and signing secrets (`*_SECRET*`, `*_KEY`, `*_TOKEN`).
  Never commit, print, export, or persist those. Check them by name, presence, or length only.
  Wurmhol share tokens (`wh_…`) are credentials too.
- Plain config is not a credential: hostnames, public URLs, ports, limits, price ids. Read it with
  `doppler secrets get <NAME> --plain` and verify it instead of guessing or asking the user. When
  unsure which kind a value is, treat it as a credential.
- Writes to `dev*` configs are fine when the user asks. Creating, rotating, or deleting
  production secrets needs explicit approval.
- Do not assign the user a setup or verification step you can do or check yourself with the CLIs
  here (`doppler`, `wrangler`, `gh`). Hand off only what needs a human: a dashboard-only action, a
  credential you must not see, or approval for production changes.

## Self-hostable by design

Wurmhol is built to be self-hosted (hosted wurmhol.com is the product; the code is free). Every
change keeps that path working:

- Config comes only from environment variables, validated with zod at startup, each documented in
  `apps/worker/.dev.vars.example`. Doppler is how _we_ inject them; code never calls Doppler, and
  a plain `.dev.vars` must work for anyone else.
- No Handlemotion-specific values in code: account ids, domains and database ids are config or
  `wrangler.jsonc` vars with neutral defaults.
- One Cloudflare account, two hostnames and `wrangler deploy` must be enough to run Wurmhol.
  Self-hosting steps live in `docs/self-hosting.md`; update it when you add a required binding or
  variable.

## Database

- Drizzle only. Schema changes go through `packages/db/src/schema` and `db:generate`; never
  hand-write migration, journal, or snapshot files. Better Auth's tables come from
  `pnpm --filter @wurmhol/auth auth:generate`, never edited by hand.
- Additive schema may land before the code that uses it. Destructive schema (drop, rename,
  nullability tighten) lands only after production code stops using that shape: migrations run
  while the old Worker still serves.

## Working style

- For multi-step changes, state the goal and acceptance criteria before editing.
- Read the relevant code and the spec section first; follow existing patterns.
- Use maintained libraries for protocols, auth, and parsing (`ws`, Better Auth, Stripe). Write our
  own code only where the product differs.
- Make the simplest change that meets the ask. Pick the boring, standard path. No compatibility
  layers or fallbacks for code that has never shipped.
- If the premise turns out wrong or the change keeps growing, stop and shrink the plan.
- Before finishing, check the diff against the ask: intent met, relevant checks and tests run,
  nothing unrequested added.

## Comments and prose

- DO NOT leak our conversation, prompt, or iteration history into code comments, pull request
  descriptions, or other maintainer-facing prose. No "used to be x; now y", "changed from",
  "as requested", "per your request". Comments say what the code does and why, as it stands,
  for whoever reads it next; history belongs in git.
- `.claude/hooks/no-chat-comments.sh` (a PreToolUse hook in `.claude/settings.json`) refuses
  Claude Code edits that add such comments.

## Shared workspace

Several agents may work in this repository at once.

- Touch only what your task needs. Uncommitted work you don't recognize belongs to someone else.
- One owner per file set. If you need a change in a package another task owns, keep it minimal
  and call it out in your PR.
- Don't edit `AGENTS.md`, CI, or root config unless that is your task; propose the change instead.

## Branching and shipping

- PRs target `main` (or the layer below, in a stack). Squash merge. CI (`Checks`) must be green;
  the `main` ruleset enforces both.
- **PR descriptions follow the `pr-writing` skill, always** (`.claude/skills/pr-writing`): problem
  first, evidence beside every claim, an ELI5. Load it before opening a pull request or writing
  or updating its description.
- **Stacks (`gh stack`, see the `gh-stack` skill).** Work that depends on unmerged work is a
  layer stacked on that branch, never a parallel branch off `main` that copies or re-implements
  it. Each layer is one reviewable PR with one owner. Stacks merge bottom-first.
- **Parallel agents.** Independent work gets its own stack rooted on `main`. Before starting, an
  agent names the packages it owns; two stacks never edit the same package. Shared touch points
  (`pnpm-lock.yaml`, root config, `docs/self-hosting.md`) are resolved by the later layer: merge
  `main`, reinstall to regenerate the lockfile (`pnpm install`), never hand-merge it.
- Before each push run `pnpm check`, `pnpm check-types`, and the tests your change touches. Batch
  fixes into one push; CI minutes cost money.
- Deploys happen when `main` changes: Cloudflare Workers Builds ships the Worker, and
  `.github/workflows/production.yml` migrates D1, syncs Worker secrets and publishes the CLI
  (Omni's ADR 0019). Never `wrangler deploy` from a laptop for production.

## Skills

Repo skills live in `.claude/skills/` as real folders, each symlinked from `.agents/skills/` so
other agents find them too. Add a new skill in both places.
