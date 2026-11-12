# Vendored anti-slop

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit
`13909c9e07590f5a85d93c62712259fe14a883f7`, copied from
`skills/install-anti-slop/assets/anti-slop/` with the skill's `scripts/install.mjs`.

Installed plugins (registered in the root `vite.config.ts`):

- `index.ts` — the generic rules, all enabled at `error`.
- `effect/index.ts` — the Effect rules. Copied, not registered: enable them in the change that
  adds `effect` as a direct dependency.

`@oxlint/plugins` is pinned to the Oxlint version Vite+ bundles (`vite-plus` 1.5.1 → Oxlint
1.91.0); move both together.

No local deviations from upstream. These files are owned here now: change them to fit the
project, and record each deviation in this file.
