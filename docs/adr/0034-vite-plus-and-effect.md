# 0034: Vite+ toolchain, stricter lint, and Effect for the Worker

Status: accepted for the toolchain; proposed for `cloudflare.config.ts` and Effect. Amends the
spec's stack table (section 4 and the package map), which names Hono for the Worker.

## Context

Agents write most of Wurmhol's code. Their defaults drift: casts instead of parsing, `typeof`
ladders instead of a schema at the boundary, long functions, and a framework of their choosing.
Each correction lives in a prompt and is forgotten in the next session. Corrections that matter
belong in tools that fail the build.

## Decision

1. **Vite+ is the toolchain.** `vp` runs Oxfmt, Oxlint, Vitest, and tsdown (`vp pack`), configured
   in `vite.config.ts` files, and owns the pre-commit hook (`vp staged`). pnpm stays the package
   manager: `vp install` drives it, and the supply-chain guard (`minimumReleaseAge`) still
   applies to the toolchain's own packages. Turborepo stays the task runner, because CI uses
   `--affected` and `vp run` has no equivalent yet.
2. **Lint rejects low-evidence code.** The anti-slop Oxlint rules are vendored in
   `tools/oxlint/anti-slop/` and enabled at `error`, with Oxlint's `complexity` rule at its
   default ceiling. Findings are fixed, not disabled. A type assertion that is right carries a
   `// SAFETY:` comment naming its invariant.
3. **A verification skill is part of the repo.** `.claude/skills/verify` and `pnpm verify`
   prove a runtime change against the real local stack with the real CLI.
4. **`cloudflare.config.ts` replaces `wrangler.jsonc`** once it can carry production. Today the
   pinned Wrangler reads it only behind the hidden `--experimental-new-config` flag, `cf` is in
   beta, and the Deploy to Cloudflare button (ADR 0008) needs `wrangler.jsonc` at the root. The
   switch lands as its own change with local dev and e2e on the new file, and the production
   deploy path moves only after the flag is stable.
5. **The Worker moves from Hono to Effect's `HttpApi`**, route group by route group: schemas at
   every boundary, typed errors, and services provided by layers instead of module imports.
   Each step keeps the e2e suite green and changes no wire behavior. When `effect` becomes a
   direct dependency, the anti-slop Effect rules are enabled in the same change.

## Consequences

- `pnpm check` fails on casts without a reason, ad-hoc `typeof` narrowing, `unknown` parameters,
  open dictionaries, and functions over the complexity ceiling. The first adoption fixed the
  existing findings across the workspace.
- `vp` cannot run from a git worktree nested inside the main checkout: it resolves its tools from
  the outer checkout. Worktrees for this repository live outside it.
- `oxfmt` stays a root dev dependency, pinned to the version Vite+ bundles, because Changesets
  formats with it directly.
- Self-hosting is unchanged until step 4 lands; that change updates the self-hosting docs.
