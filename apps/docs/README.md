# Docs

The Wurmhol docs, built and hosted by [Mintlify](https://mintlify.com) and served at
`wurmhol.com/docs` through `apps/site`'s Worker (`apps/site/worker/index.ts`). Mintlify deploys
on every push to `main`; its Git settings point at this directory.

Preview locally from this directory (Node 20.17+):

```bash
npx mint dev
```

`docs.json` holds the navigation, theme and colors; each page is an `.mdx` file.
