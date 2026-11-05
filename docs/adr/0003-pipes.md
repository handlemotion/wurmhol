# 0003: Shares are "pipes", at `<id>.pipe.wurmhol.com`

Status: accepted; the pipe host is superseded by ADR 0007 (`<id>.wurmhol.dev`). Departs from
spec v1 section 5 ("Domains"), which puts shares at `<id>.on.wurmhol.com`.

## Decision

- What a person sees is a **pipe**: the CLI ("No open pipes", "End a pipe"), the wall ("No open
  pipes"), the pages a viewer gets ("This pipe has ended."). The product's brand for a share.
- Pipe URLs are `<id>.pipe.wurmhol.com`. `SHARE_DOMAIN` sets the domain (`pipe.localhost` locally),
  so a self-hosted install picks its own.
- Code keeps the spec's names (`Share` Durable Object, `shares` table, `/api/shares`, the `share`
  query parameter): renaming them buys nothing and would churn every layer.

## Consequences

- `*.pipe.wurmhol.com` is still a two-level wildcard: it needs Advanced Certificate Manager
  ($10 a month) and a Public Suffix List entry for `pipe.wurmhol.com`, exactly as `on.` did.
- The CLI names `wurmhol.com` and `*.pipe.wurmhol.com` as the hosts to allowlist.
