# Docs

The Wurmhol docs, built and hosted by [Mintlify](https://mintlify.com) and served at
`wurmhol.com/docs` through `apps/site`'s Worker (`apps/site/worker/index.ts`). Mintlify deploys
on every push to `main`; its Git settings point at this directory.

For repository work, use the Node version in [`.nvmrc`](../../.nvmrc) and pnpm version in
[`package.json`](../../package.json). See the [documentation map](../../docs/README.md) for
maintainer guides and the agent-documentation pattern.

Preview locally from this directory:

```bash
npx mint dev
```

`docs.json` holds the navigation, theme and colors; each page is an `.mdx` file.
