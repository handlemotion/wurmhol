# Contributing and shipping

## Scope and review

- State the goal and acceptance criteria for multi-step changes. Follow the relevant code,
  spec section, and accepted ADRs; record departures as a new ADR.
- Use the simplest maintained library for standard protocols, auth, and parsing (`ws`, Better
  Auth, Stripe). Keep custom code for what is specific to Wurmhol. No speculative compatibility
  layers or fallbacks for behavior that has never shipped.
- Resolve what code, documentation, an agreed plan, or a sensible default already answers.
  Ask for product/pricing decisions, spending, explicit production approvals, or human-only
  steps. Complete every reachable setup and verification step with the CLIs and connectors;
  prefer `cf` for Cloudflare. Human hand-offs include the exact resource URL and values.
- Comments, PR descriptions, and other maintainer-facing prose explain the code as it stands,
  not conversations, prompts, requesters, or iteration history. The Claude Code
  [edit hook](../.claude/hooks/no-chat-comments.sh) enforces this for edits.
- Before finishing, check that the diff meets the ask, contains no unrelated changes, and has
  relevant evidence. See [Development](development.md#checks-and-tests) for commands and proof.

## Pull requests

- Target `main`, or the layer below in a stack. Squash merge; the `main` ruleset requires green
  `Checks`. Do not merge without instruction.
- Read the [PR-writing skill](../.claude/skills/pr-writing/SKILL.md) before opening a PR or
  writing/updating its description: problem first, evidence beside every claim, an ELI5.
- Before each push run `pnpm check`, `pnpm check-types`, and the tests the change touches.
  Batch fixes into one push; CI minutes cost money.
- A CLI behavior change includes a changeset (`pnpm changeset`); a CLI release PR runs
  `pnpm changeset version`. See [Changesets](../.changeset/README.md).

## Dependent work and shared files

Work that depends on unmerged work is a layer stacked on that branch, not a parallel branch
off `main` that copies or re-implements it. Each layer is one reviewable PR with one owner;
stacks merge bottom-first.

Read the [gh-stack skill](../.claude/skills/gh-stack/SKILL.md) before opening dependent PRs.
Build, update, and merge the stack with `gh stack` (`init`, `add`, `submit`, `rebase`, `sync`,
`merge`). PRs whose bases merely point at each other are not a stack: GitHub must group them.

Where cloud networking blocks GraphQL, keep the local stack with `gh stack init`, `add`,
`rebase`, and `push`; use the REST stacks API as described in the skill for GitHub's side.
Create the stack once two PRs are open, add later PRs with `POST stacks/<n>/add`, and use
`PUT pulls/<top>/merge-async` when instructed to merge. Never stop at a hand-made chain of bases.

Several agents may share a workspace:

- Name the packages you own before parallel work. Independent work gets its own stack rooted
  on `main`; two stacks do not edit the same package.
- Touch only your files; unrecognized uncommitted work belongs to someone else. If another
  task owns a package you must touch, keep the change minimal and call it out in the PR.
- Do not edit `AGENTS.md`, CI, or root config unless that is the task; propose changes instead.
- The later layer resolves shared touch points (`pnpm-lock.yaml`, root config,
  `apps/docs/self-hosting/`): merge `main`, then reinstall to regenerate the lockfile. Never
  hand-merge a lockfile.

## Production and self-hosting

Cloudflare Workers Builds deploys the Worker when `main` changes. The
[production workflow](../.github/workflows/production.yml) migrates D1, waits for the commit's
Workers Builds check before syncing Worker secrets, and publishes the CLI with npm trusted
publishing. See [Operations](operations/doppler.md#production-deploys) for the exact sequence.
Never deploy hosted production from a laptop or agent session.

After an instructed merge, verify production: the deploy completed, the active version is
the new one, `/health` answers, and logs show no new errors. Prefer `cf` to inspect Cloudflare;
discover the installed command/schema before using it. Report evidence, or exactly what could
not be checked. Ask before a check touches production data or costs beyond normal use.

Keep the self-hosted path working: one Cloudflare account, the app and pipe hostnames, and the
documented deployment flow must suffice. Config is environment-only, validated with zod, and
documented in [the Worker example](../apps/worker/.dev.vars.example); application code never
calls Doppler. Account/domain/database values remain configurable, with neutral defaults.
Update [self-hosting docs](../apps/docs/self-hosting/index.mdx) when adding required config or
bindings. The self-hoster's manual deployment instructions do not authorize changing hosted
production.
