# 0007: Pipes at `<id>.wurmhol.dev`, a domain of their own

Status: accepted. Supersedes the pipe host in ADR 0003 (`<id>.pipe.wurmhol.com`) and the
`*.pipe.wurmhol.com` row of ADR 0006. Answers spec v1 open question 2 ("`<id>.on.wurmhol.com`, or
a second domain?"): a second domain.

## Decision

- Pipe URLs are `<id>.wurmhol.dev`. Production sets `SHARE_DOMAIN=wurmhol.dev` and the Worker
  route `*.wurmhol.dev/*`; DNS is one proxied wildcard record, `*` → `AAAA 100::`.
- `wurmhol.dev` is in the same Cloudflare account as `wurmhol.com`, registered through
  Cloudflare Registrar.
- The apex `wurmhol.dev` serves nothing: it has no DNS record, and the route pattern
  `*.wurmhol.dev/*` does not match it. A pipe id is always 10 characters, so no pipe lives there.
- The console, the CLI's host and the marketing site stay on `wurmhol.com` (ADR 0006).

## Why

- **Cost.** Cloudflare's free Universal SSL certificate covers a zone's apex and one level of
  wildcard (`*.wurmhol.com`). `<id>.pipe.wurmhol.com` is two levels deep, so it needed Advanced
  Certificate Manager at $10 a month. `<id>.wurmhol.dev` is one level under its own zone, so the
  free certificate for `*.wurmhol.dev` covers it. The domain costs about $8 a year instead of
  $120 a year for ACM.
- **Isolation.** A pipe page is now a different _site_ from the console (`dirt.wurmhol.com`), not
  just a different host under the same registrable domain. The browser's same-site rules
  (SameSite cookies, `Sec-Fetch-Site`) treat a pipe's requests to the console as cross-site
  without waiting for a Public Suffix List entry, and a pipe page can never set a cookie for
  `wurmhol.com`.

## Consequences

- `<id>.pipe.wurmhol.com` no longer reaches a pipe. Pipes last at most 12 hours and the CLI
  prints whatever URL the Worker returns, so no CLI release is needed and open pipes end with
  the deploy that switches the domain.
- The Public Suffix List entry becomes `wurmhol.dev`. It still isolates one pipe from another
  (a page on one pipe can set a cookie for `wurmhol.dev` until it lands). The PSL asks for more
  than two years of registration left, so renew `wurmhol.dev` for several years before filing.
- ACM is no longer needed: ADR 0004's fixed costs drop by $10 a month.
- Self-hosters get the same choice ([self-hosting](../../apps/docs/self-hosting/index.mdx)): a separate domain for pipes by
  default, a `pipe.` subdomain with ACM as the alternative.
