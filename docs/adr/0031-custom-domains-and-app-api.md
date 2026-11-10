# 0031: Custom domains for pipe URLs, and the API apps need around them

Status: proposed. Design only: nothing here is built, and the SDK refuses `domain` until it is
(ADR 0030). Departs from the pipe URL of ADR 0007 (`<id>.wurmhol.dev`) for orgs that opt in.
Spec section 2 rules out public links and custom domains for v1; this lifts the second, not the
first.

## Context

An app that embeds pipes (ADR 0030) shows its users a preview URL. Today that is a wurmhol.dev
host. Apps and teams want `preview.acme.dev`, or `<branch>.preview.acme.dev`: the URL goes in
OAuth redirect settings, in a PR, in a customer's browser, and a vendor's name in it is wrong for
all three. A named pipe (ADR 0009) already keeps its URL stable; the domain is the other half.

Constraints from what exists:

- A pipe is served by Cloudflare Workers on the pipe domain with a wildcard certificate. A
  customer's hostname needs its own certificate, which on Cloudflare is Cloudflare for SaaS custom
  hostnames: priced per hostname, with a fallback origin, and DNS validation by the customer.
- The viewer's cookie is host-only (`__Host-wurmhol`) and set through a one-time sign-in code
  (ADR 0026). On a customer's host that exchange has to start and end there, and the sign-in page
  stays on the console's host.
- Only org members may see a pipe (spec section 6). A custom domain must not make it public or
  help phishing: a domain belongs to one org, must be proven, and shows the same interstitial and
  limits as any pipe.

## Decision (proposed)

### Relay

- **Domains belong to an org.** `POST /v1/domains { hostname }` (org-scope token, or the console)
  registers a hostname and answers with the DNS record to create (`CNAME` to the fallback origin,
  and a `TXT` ownership token while Cloudflare validates). `GET /v1/domains` and
  `GET /v1/domains/:hostname` report `state`; `DELETE` removes it and ends its pipes.
- **States**: `pending_dns`, `pending_certificate`, `active`, `failed` (with a one-line `fix`),
  `removed`. Cloudflare's hostname status maps onto them; a poll or its webhook moves them.
- **A hostname is a zone for pipes.** An org registers `preview.acme.dev`; a pipe named `web` is
  served at `web.preview.acme.dev`, an unnamed one at `<id>.preview.acme.dev`. One wildcard record
  covers them all. Apex hostnames and bring-your-own certificates are out.
- **Opening a pipe with a domain.** `/connect?domain=preview.acme.dev` is refused with a fix unless
  the domain is `active` and the org's. The Share Durable Object stores the host the pipe is served
  on; routing looks pipes up by host instead of by `<id>.<pipe domain>`.
- **Viewer sign-in** reuses ADR 0026's code on the custom host: the console mints the code for the
  target host, the host exchanges it and sets its own host-only cookie. No cookie is shared across
  hosts.
- **Limits and cost.** A plan feature (Business, ADR 0027) with a count of hostnames; Cloudflare's
  per-hostname price is paid by the plan. **Needs the owner's decision before any of it is built**,
  since it adds spend. Self-hosters use their own Cloudflare account and any domain, as the
  self-hosting guide already says for the pipe domain.
- **Abuse.** Domains are proven (DNS), one org each, removed with the org, and takedown (ADR 0022)
  removes a domain and blocks the org's hostnames. Dangling DNS after removal is the customer's;
  the relay stops answering for it.

### SDK (already typed, see ADR 0030)

- `OpenPipeOptions.domain` and `keepOpen({ domain })`. Until the relay supports it the SDK rejects
  with a `FixError` coded `unsupported`.
- `PipeDomain` and `DomainState` (exported, marked experimental).
- A management client beside `pipes`: `domains.add(hostname)`, `domains.list()`,
  `domains.get(hostname)` (returns `PipeDomain`, including the record to create),
  `domains.remove(hostname)`, and a helper `domains.waitUntilActive(hostname, { signal })` that
  polls with backoff and reports each state.

### Other API pieces apps asked for, proposed with it

- `GET /v1/usage`: the org's byte and pipe counts for the month, for an app that shows quota.
- `DELETE /v1/token`: a token revokes itself, so `auth.signOut({ revoke: true })` can end a
  credential rather than forget it.
- `GET /v1/capabilities`: what this relay supports (`domains`, `accessKey`, limits), so an app
  checks instead of failing on a feature a self-hosted install lacks.

## Consequences

- Branded URLs make pipes look like the customer's own site, so the interstitial and the "who may
  open it" rules matter more, not less; they stay on.
- Routing by host and a hostname table are a real change to the Worker and D1, with a migration.
  It ships as its own stack, after the cost decision.
- Open: wildcard certificates for `*.preview.acme.dev` under Cloudflare for SaaS, the exact cookie
  and redirect flow on a custom host, and whether the Pro plan gets one domain.
