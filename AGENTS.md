# Wurmhol agent guide

Wurmhol gives a local dev server a private HTTPS URL from a sandbox that can only reach an
HTTPS CONNECT proxy. TypeScript, pnpm workspaces, Turborepo, Cloudflare Workers, D1, Durable
Objects, Better Auth, and a Node CLI.

Explicit user instructions win. A nearer `AGENTS.md` extends this guide and wins where they
differ. Read the relevant code and the task-specific guidance below before editing; do not
load every reference for every task.

## Read when relevant

| Task                                                     | Read                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Setup, commands, tests, package map                      | [Development](docs/development.md)                                                                          |
| Branches, PRs, stacks, releases, production verification | [Contributing](docs/contributing.md)                                                                        |
| Cloudflare, Doppler, credentials, deploy plumbing        | [Operations](docs/operations/doppler.md)                                                                    |
| UI or design, every time                                 | [Design rules](DESIGN.md), then the skills it names                                                         |
| Product or architecture decisions                        | Relevant [v1 spec](docs/spec/v1.md) section and [ADRs](docs/adr/); accepted ADRs amend the original spec    |
| Bindings, configuration, self-hosting                    | [Self-hosting](apps/docs/self-hosting/index.mdx) and [Worker config example](apps/worker/.dev.vars.example) |
| Documentation changes                                    | [Documentation map and maintenance rules](docs/README.md)                                                   |

## Commands and tools

- Node: `.nvmrc`; pnpm: `package.json#packageManager`. Install: `pnpm install --frozen-lockfile`.
- Check: `pnpm check` and `pnpm check-types`. Unit tests: `pnpm test:all` (all) or `pnpm test`
  (affected). E2E: `pnpm test:e2e`; one file:
  `pnpm --filter @wurmhol/worker test:e2e e2e/<file>.e2e.test.ts`.
- Run the real local app: `pnpm stack:serve`; stop: `pnpm stack:serve:stop`.
  It migrates local D1, builds the web app, and returns when `/health` on port 8787 answers.
- **Prefer the Cloudflare `cf` CLI, not `wrangler`, for direct Cloudflare operations.** Discover
  commands with `cf --help`, subcommand `--help`, and `cf schema <command>`. Do not guess flags.
  Keep existing pnpm dev/test/deploy scripts and use pinned Wrangler where local Workers/D1
  tooling requires it, not for ad-hoc account or resource management.
- Use the CLIs and connectors to complete setup and verification. Ask only for product/pricing
  judgement, spending, production approval, or genuinely human-only steps. A hand-off includes
  the exact URL and values, not dashboard navigation instructions.

## Non-negotiable boundaries

- `packages/protocol` is pure: no I/O. Both ends use its codec; do not hand-roll another.
- Every org-owned table has `org_id`; every route reading one checks the caller's membership
  in that org first.
- Never log or store relayed request or response bodies. Only the page title and favicon are
  kept for the wall. Strip Wurmhol's cookies before forwarding to a dev server.
- Secrets stay out of source, logs, and durable plaintext files. Check credentials by name,
  presence, or length only; `wh_…` share tokens are credentials too. Use Doppler injection or
  its ephemeral mount. Non-secret config can be read to verify it; see [Operations](docs/operations/doppler.md).
- Creating, rotating, or deleting production secrets needs explicit approval. So does a check
  that touches production data or costs beyond normal use. Never deploy hosted production from
  a laptop or agent session; pushes to `main` deploy through Workers Builds and CI.
- Preserve self-hosting: env-only config validated with zod, no Doppler calls in application
  code, neutral defaults, no Handlemotion-specific account/domain/database values in code.
  Update the config example and self-hosting docs for required variables or bindings.
- Drizzle only: edit `packages/db/src/schema`, then `pnpm --filter @wurmhol/db db:generate`.
  Better Auth tables come from `pnpm --filter @wurmhol/auth auth:generate`. Never hand-edit
  generated auth tables, migrations, journals, or snapshots. Destructive schema changes wait
  until production stops using the old shape; migrations run while old code still serves.
- Record departures from the product spec or an accepted decision in `docs/adr/`.

## Work and proof

- State the goal and acceptance criteria for multi-step changes. Make the smallest useful
  change, follow existing patterns, and use maintained protocol/auth/parsing libraries.
  If the premise is wrong or scope grows, stop and shrink the plan.
- E2E first for behavior crossing processes, auth, HTTP, sockets, or the database: real workerd,
  D1, Durable Objects, CLI, and local servers. No mocks, stubs, or fakes in e2e.
- Unit tests only for valuable pure logic in `packages/protocol` and `scripts/`. Name the bug
  before writing a test; delete low-signal tests. Never weaken assertions or add `.only`,
  `.skip`, or `.todo`.
- For runtime changes, run the real stack, share a real server with the real CLI, and make real
  HTTP calls before declaring success. Report observed evidence or say what is unverified.
- Before each push: `pnpm check`, `pnpm check-types`, and relevant tests. Review the diff against
  the ask. Read the [PR-writing skill](.claude/skills/pr-writing/SKILL.md) before creating or
  updating a PR description; follow [Contributing](docs/contributing.md) for shipping.
- Touch only your task's files. Unrecognized uncommitted work belongs to another agent. One
  owner per file set; don't edit CI, root config, or agent rules unless that is the task.
- Comments and maintainer-facing prose describe the code and its reasons, never the chat,
  prompt, requester, or iteration history. The Claude Code hook enforces this for edits.

## Skills

Reusable workflows live in `.claude/skills/`, symlinked from `.agents/skills/`. Read only the
skill relevant to the task and its needed references. Add new repo skills in both locations;
do not duplicate their procedures here. `CLAUDE.md` imports only this guide.
