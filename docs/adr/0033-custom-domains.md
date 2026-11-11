# 0033: Custom domains for branded pipe URLs

Status: proposed. Extends ADR 0009 (named pipes keep their URL) and ADR 0007 (pipes at
`<id>.wurmhol.dev`). Leaves "only the org's members get in" (spec section 6) and the pipe access key
(ADR 0028) as they are. Supersedes the custom-domain design proposed in ADR 0031 (a hostname as a
zone of pipes, and `domain` when opening one); the rest of ADR 0031 (usage, token revocation,
capabilities) is untouched by this. Embedded tunnels (ADR 0032) keep their own hosts.

## Context

A named pipe has a stable URL, but it is always on Wurmhol's domain: `my-app.wurmhol.dev`. An app that
shows previews to its own users, or a team that wants `preview.acme.dev` in a redirect URI, an email
or a pull request comment, has to show someone else's name. Apps that embed Wurmhol (the SDK's
`openPipe`, ADR 0030) are the clearest case: their users should see the app's brand.

So an org can attach a hostname it owns to one of its pipe names. A request to that hostname is a
request to the name's open pipe, behind the same sign-in wall, with the same access key rule.

Constraints this has to hold:

- **TLS and routing for a hostname we do not own** are Cloudflare for SaaS custom hostnames, not
  something to build: certificate issuance and renewal, validation, and the edge route into our zone.
- **A subdomain takeover must not be possible.** If `old.acme.dev` still has a `CNAME` to our target
  after Acme stops using it, no other org may claim it and serve its own pipe there. Cloudflare marks a
  hostname active as soon as the `CNAME` resolves to the zone, so Cloudflare's check alone proves that
  _someone_ points at us, not that _this org_ owns the name.
- **Self-hosters** get the feature only if they run it: neutral defaults, environment-only
  configuration validated with zod, no Wurmhol-specific values in code.
- **Cost** follows hostnames: Cloudflare for SaaS bills per custom hostname past a free allowance, so
  the feature needs a per-org limit.

## Decision

### The model

- A **domain** is a hostname (`preview.acme.dev`) bound to one **pipe name** of the same org. A name
  can have several domains; a hostname belongs to at most one org, and to one name.
- The name must belong to the org. A free name is claimed for the org when the domain is added (the
  same first-come rule as ADR 0009), so a team can set its brand up before the first `wurmhol` run.
- A request to an `active` domain is handled as a request to its name's open pipe (ADR 0009): D1
  looks the hostname up, then the name, then the Share Durable Object. With no pipe open it gets
  "This pipe has ended." Nothing about the pipe changes: its id, Durable Object, history row, limits,
  viewer cookie and access key are the same on both hosts.
- The pipe's **URL** (what the CLI prints, `openPipe` returns, and the wall shows) is the name's
  oldest active domain, else `<name>.<SHARE_DOMAIN>`. The `wurmhol.dev` host keeps working next to it.
- The domain follows the name, so opening a pipe never names a domain: the SDK's reserved
  `OpenPipeOptions.domain` (ADR 0031) stays refused, with a fix that says to attach the hostname to
  the name instead.
- Exact hostnames only. Wildcards (`*.preview.acme.dev` mapping each label to a name) need Cloudflare's
  wildcard custom hostnames, an Enterprise feature, and are not part of this decision.
- Not served: an apex that cannot hold a `CNAME` (no CNAME flattening at the customer's DNS), any host
  under `SHARE_DOMAIN`, the app's, the CLI's, an alias's or the relay's host, the SaaS target, and
  IP literals.

### Two proofs, because there are two risks

1. **Ownership (ours).** `POST` returns a random challenge. The org publishes
   `TXT _wurmhol.<hostname>  "wurmhol-verify=<challenge>"`. The Worker checks it with a DNS-over-HTTPS
   lookup (`DNS_RESOLVER_URL`, Cloudflare's by default). Only the DNS owner can publish it, whatever
   dangling records exist. This is what closes the takeover: a `CNAME` left behind proves nothing here.
2. **Traffic and TLS (Cloudflare's).** The org points `CNAME <hostname> → <CUSTOM_DOMAIN_TARGET>`
   (`domains.wurmhol.dev` in production). Cloudflare validates it, and issues the certificate by
   automatic HTTP validation once the `CNAME` resolves (`ssl.method: http`, so one record is all the
   certificate needs). The TXT record can be removed afterwards.

The Cloudflare custom hostname is created when the domain is added (so its `CNAME` validation can start
while the org edits DNS) but **no request is routed to it until both proofs hold**. Routing needs our
row to be `active`, never Cloudflare's state alone.

### States

| State       | Meaning                                                                   | Routed |
| ----------- | ------------------------------------------------------------------------- | ------ |
| `pending`   | Added. Our TXT challenge is not seen yet.                                 | no     |
| `verifying` | Ownership proven. Cloudflare's hostname or certificate is not active yet. | no     |
| `active`    | Ownership proven, Cloudflare reports the hostname and certificate active. | yes    |
| `failed`    | Refused or lost: see `error`. Remove it, or add it again after the fix.   | no     |

Transitions, all driven by `POST /v1/domains/:hostname/verify` (and the console's button), and by
the daily job for domains that are not `active` or that were:

- `pending` → `verifying` when the TXT record is found. Ownership, once proven, stays proven.
- `verifying` → `active` when Cloudflare reports `status: active` and `ssl.status: active`;
  → `failed` when it reports `blocked`, or a certificate refusal (`ssl.validation_errors`, a CAA
  record forbidding the issuer, a validation timeout), keeping the error for the person, and deleting
  the Cloudflare hostname so a refused one is not kept and billed. A hostname Cloudflare no longer
  holds is made again.
- `active` → `verifying` when Cloudflare stops reporting active (`moved`: the `CNAME` was removed):
  routing stops at once, and the daily job re-checks. An org blocked by the operator (ADR 0022) is not
  routed either, whatever the row says.
- Any state short of `active` → `failed` (`expired`) once `CUSTOM_DOMAIN_PENDING_SECONDS` (seven
  days) have passed since it was added, or since it last left `active`. The Cloudflare hostname is
  deleted then.

A TXT record that disappears after activation does not deactivate a domain; the `CNAME` does.

A check reads DNS and Cloudflare, then writes what it found only to the claim it started from (the
hostname and its challenge): a domain removed and added again meanwhile, by any org, starts over.
Every check, failed or not, moves the domain to the back of the daily job's queue.

### The API contract (shared with the SDK)

On the CLI's host with an `org`-scope token, beside `/v1/pipes` (ADR 0008); the console has the same
calls under `/api/domains`, signed in as any member. A refusal is `{ error, fix, code }`: `fix` is one line that says what to do, `code` is the machine
reason below. (`reason` on a refusal already means why a share ended, so it is not reused.)

```
GET    /v1/domains                      -> { domains: Domain[] }
POST   /v1/domains   { hostname, pipe } -> 201 { domain: Domain }
GET    /v1/domains/:hostname            -> { domain: Domain }
POST   /v1/domains/:hostname/verify     -> { domain: Domain }   // checks now; never waits for DNS
DELETE /v1/domains/:hostname            -> { ok: true }

Domain = {
  hostname: string,                 // lowercase, no trailing dot
  pipe: string,                     // the pipe name
  state: "pending" | "verifying" | "active" | "failed",
  url: string | null,               // `https://<hostname>`; null until active
  dns: { type: "TXT" | "CNAME", name: string, value: string, purpose: "ownership" | "traffic",
         done: boolean }[],         // what to publish, and whether it was seen
  error: { code: string, message: string, fix: string } | null,
  createdAt: string, verifiedAt: string | null, expiresAt: string | null  // ISO 8601
}
```

Error codes (`code` on the refusal): `custom_domains_off` (404, the install has the feature off),
`invalid_hostname` and `invalid_pipe` (400), `hostname_reserved` and `pipe_reserved` (409, a host or
name the install itself uses), `hostname_taken` (409, another org, or this org's other name),
`pipe_taken` (409, the name belongs to another org), `domain_limit` (402 on a plan, 403 with billing
off), `no_subscription` (402), `not_found` (404), `dns_unavailable` (503, the resolver failed: try again),
`provider_error` (502, Cloudflare refused or was unreachable), `expired` and `certificate_refused` and
`hostname_blocked` (on a `failed` domain's `error`, not a refusal). Calls are idempotent: adding the
same hostname for the same name again returns the existing domain, and deleting a missing one is
`{ ok: true }`.

`verify` returns at once with the state as found and asks Cloudflare to validate again; callers poll
`verify` (about every ten seconds, as the CLI's `--wait` does) rather than hold a request open. `GET`
reads the stored state without nudging Cloudflare.

A `dns` record is `done` when it was seen: the TXT record by our own lookup (kept once seen), the
`CNAME` while Cloudflare reports the hostname active.

### Cloudflare

- The SaaS zone is the share domain's zone (`wurmhol.dev`): its fallback origin is an originless
  record (`fallback.wurmhol.dev AAAA 100::`, already covered by the `*` wildcard record), and the
  `CNAME` target `domains.wurmhol.dev` is a proxied record on it. Both labels are reserved from pipe
  names, as the relay's is (ADR 0010).
- The Worker needs a route that matches traffic entering the zone under a customer's hostname:
  `*/*` on the zone (Cloudflare: Workers as a fallback origin). The Worker therefore treats any host
  it does not know as not found, never as the app, once the feature is on.
- The Worker calls the Cloudflare API with a token scoped to custom hostnames on that zone (`SSL and
  Certificates: Edit`): `POST/GET/PATCH/DELETE /zones/{zone}/custom_hostnames`. The provider is an
  interface with one real adapter; nothing else knows Cloudflare's shapes.

### Configuration (environment only)

| Variable                        | Meaning                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `CUSTOM_DOMAIN_TARGET`          | The `CNAME` target (`domains.wurmhol.dev`). Setting it turns the feature on.             |
| `CLOUDFLARE_ZONE_ID`            | The SaaS zone. Required with the target.                                                 |
| `CLOUDFLARE_API_TOKEN`          | Secret. Required with the target.                                                        |
| `CLOUDFLARE_API_URL`            | Cloudflare's API origin. Default `https://api.cloudflare.com/client/v4`.                 |
| `DNS_RESOLVER_URL`              | A DNS-over-HTTPS JSON endpoint. Default `https://cloudflare-dns.com/dns-query`.          |
| `CUSTOM_DOMAIN_PENDING_SECONDS` | How long a domain may stay unverified. Default seven days.                               |
| `LIMIT_CUSTOM_DOMAINS`          | Domains per org with billing off. Default 10. With billing on, the plan's limit applies. |

All of the first three or none. Off is the default: a self-hosted install keeps today's behaviour,
including an unknown host reaching the app.

### Limits and abuse

- **Per org:** `PLAN_LIMITS.customDomains` with billing on, `LIMIT_CUSTOM_DOMAINS` with it off. Proposed:
  Friends 0, Business 20. This is a pricing decision (ADR 0027); the number is the maintainer's to set.
  Cloudflare's allowance is 100 hostnames, then $0.10 each a month, so 20 is at most $2 a month of
  cost for a $20 plan.
- **The limit is checked as the row is written**, in one statement, so concurrent adds cannot pass
  it together. A pipe name claimed by an add that then fails is released again.
- **Pending claims** count against the limit and expire, so an org cannot sit on hostnames. A hostname
  is unique in Cloudflare's zone, so a pending claim blocks other orgs from it until it is proven,
  expired, or removed. That is accepted for now; the operator can remove a domain
  (`DELETE /operator/domains/:hostname`, ADR 0022; a takedown report may also name a pipe by its
  custom domain), and "claim by proof" (a second org proving the
  TXT record takes the hostname) is the way out if squatting appears.
- **Every request still needs a signed-in member**, so a custom domain is not a way to publish
  anything: it cannot host a phishing page for the public.
- Rate limits: the `manage` limit on adds, verifies and removes, per member or token.

### Sign-in and cookies on a custom host

- The share cookie (`__Host-wurmhol`) is host-bound and names the share, so a cookie from
  `my-app.wurmhol.dev` does not open `preview.acme.dev`: the first visit goes through `/open` again.
- The dev server behind the pipe is told the host the viewer used (`X-Forwarded-Host`), not the pipe's
  own URL, so the redirect URIs it builds match the host in the address bar on either host.
- `/open?share=<id>` takes an optional `host`. It is honoured only when it is the share's own host or
  an `active` domain of the share's org and name; the one-time code goes back to that host, never to
  an arbitrary one. Without `host` it is as before.
- The OAuth relay (ADR 0010) records the host the flow started on (an optional `host` on the state)
  and redirects back to it. An app on a custom domain can also register its own redirect URI on that
  domain and skip the relay.

### The access key (ADR 0028)

The key check is in the Share Durable Object's request path and the viewer's host handling, which a
custom host shares with any other host. A custom host with a valid `x-wurmhol-key` skips the sign-in
exactly as `<name>.wurmhol.dev` does, a wrong key is a 401 without a redirect, and the header never
reaches the dev server. A test covers it on a custom host.

### Staged rollout

1. This ADR.
2. Schema, API, provider, verification, with the feature off. A deploy changes nothing: no routing
   change, no new route.
3. Host routing and `/open` support, still off.
4. CLI, SDK surface and console.
5. Operator, with approval: enable Cloudflare for SaaS on the zone, create the fallback origin and
   target records, add the `*/*` route, set the three variables and the secret, then try one real
   domain end to end before telling anyone.

## Consequences

- One D1 read per request to a custom host (as named pipes pay one); none to `wurmhol.dev` hosts.
- A new table (`custom_domains`) and one nullable column (`oauth_states.host`): additive, so a
  migration runs while the previous Worker still serves.
- `*/*` on the zone makes the Worker the first stop for everything entering it. The unknown-host rule
  above keeps that from exposing the console on arbitrary hosts.
- Cloudflare for SaaS needs a paid allowance past 100 hostnames and an API token in production: both
  need the operator's approval before step 5.
- Deleting an org removes its domains from Cloudflare first. If Cloudflare does not answer, the org
  is not deleted and the person is told to try again, since once the rows are gone nothing would
  find those hostnames again.
- The SDK's reserved `DomainState` and `PipeDomain` types (ADR 0031) are replaced by `Domain` and
  this ADR's states, and `domains()` / `Wurmhol#domains` is the client ADR 0031 sketched.
- Not solved here: wildcards, apex domains without CNAME flattening, per-domain TLS settings,
  bring-your-own certificates, and a domain shared by several names.
