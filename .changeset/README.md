# Changesets

Releases of the CLI (`packages/cli`, `wurmhol` on npm) are versioned with
[Changesets](https://changesets.dev). The other packages are private and never released.

- **A pull request that changes what `npx wurmhol` does** adds a changeset: `pnpm changeset`,
  pick `wurmhol`, pick the bump (patch: fixes; minor: new behavior; major: breaking flags, output
  or protocol), and write one line for the changelog, for the people running the CLI. Commit the
  file it creates. CI's `Changeset` step fails a pull request that changes `packages/cli` without
  one. For a change users can't see (tests, docs, refactors), `pnpm changeset --empty`. The CLI
  bundles `@wurmhol/protocol`, so a protocol change the CLI ships needs a `wurmhol` changeset too.
- **To release**, merge the release pull request. While changesets are pending on `main`,
  `.github/workflows/release.yml` keeps one pull request open, "Release wurmhol <version>" from the
  branch `changeset-release/main`: it runs `pnpm changeset version`, which bumps
  `packages/cli/package.json`, writes `packages/cli/CHANGELOG.md` and deletes the consumed
  changesets, and it updates the pull request on every push to `main`. A GitHub App opens it so
  that `Checks` runs on it (setup: `docs/operations/doppler.md`). When it merges,
  `.github/workflows/production.yml` publishes the new version to npm (trusted publishing, with
  provenance) and creates the `wurmhol@<version>` tag and GitHub release.
