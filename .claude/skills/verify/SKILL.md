---
name: verify
description: Prove a Wurmhol change works before calling it done or pushing it — static checks, the right test suites, and a real share through the real CLI against the local stack. Use after any code change, before a commit or PR, and whenever asked to verify, check, or confirm that something works.
---

# Verify a change

Green unit tests are the floor, not the proof. A change is verified when you have run the
checks below that apply to it and can quote what you observed. Say what you did not verify.

## 1. Static checks (every change)

```bash
pnpm check        # vp fmt --check, vp lint (Oxlint + anti-slop + complexity), repo policies
pnpm check-types  # tsc -b across the workspace
```

Fix findings; never silence them. No `oxlint-disable` to get past anti-slop or `complexity`:
parse at the boundary instead of asserting, and split functions instead of raising limits. A
type assertion that is genuinely right carries a `// SAFETY:` comment naming the invariant.

`vp` cannot run from a git worktree nested inside the main checkout (such as
`.claude/worktrees/*`): it resolves its tools from the outer checkout's `node_modules` and fails
with `Cannot find package 'vite-plus'`. Work in a worktree outside the main checkout, or run the
checks from a copy outside it.

## 2. Tests that cover the change

| Changed                                   | Run                                                            |
| ----------------------------------------- | -------------------------------------------------------------- |
| `packages/protocol`, `scripts/` pure code | `pnpm test` (affected unit suites)                             |
| Worker, auth, D1, Durable Objects, CLI    | The e2e files for that behavior, then `pnpm test:e2e` for all  |
| The wall (web app)                        | The wall e2e suites (Playwright Chromium) and a look in a page |
| Docs only                                 | Documentation validation, not unrelated suites                 |

One e2e file: `pnpm --filter @wurmhol/worker test:e2e e2e/<file>.e2e.test.ts`. New behavior
that crosses processes, HTTP, sockets, auth, or the database gets an e2e test, not a mock.

## 3. The real thing (runtime changes)

```bash
pnpm verify
```

[`scripts/verify.mjs`](../../../scripts/verify.mjs) starts `stack:serve` if it is not
answering, signs in through the real magic-link flow, creates an org token, shares a local
HTTP server with the built CLI, checks that the share refuses an anonymous request, and fetches
a page through the share's public URL with an access key. Each `✓` line is an observation to
quote. It leaves the stack running; stop it with `pnpm stack:serve:stop`.

Rebuild the CLI first when it changed: `pnpm --filter wurmhol build`. When the change has its
own observable behavior (a route, a header, a page, a CLI command), exercise that too against
the same stack with real requests and quote the status and the part of the body that proves it.
Worker logs are in `.local/serve/worker.log`.

## 4. Report

In the hand-off or PR (see the `pr-writing` skill): the commands run and their results, the
observations from step 3, and anything not verified with the reason.
