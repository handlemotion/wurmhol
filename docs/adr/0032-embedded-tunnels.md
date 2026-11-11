# 0032: Embedded mode, private tunnels a SaaS opens for its own users

Status: proposed. Design and implementation plan only: nothing here is built. Departs from spec
v1 section 6 ("sign-in and membership check on every request") for embedded tunnels, whose
viewers are a SaaS's users and not org members. Resolves the open consequence in ADR 0027 ("an
integrator's own users still have to be org members"). Extends ADR 0028 (access keys), ADR 0030
(the SDK) and ADR 0021 (token revocation). Pipes as they work today are unchanged.

## Context

A SaaS that embeds Wurmhol (Dorks is the first, ADR 0028 and 0030) opens a tunnel for each of its
users: Dorks opens one to Alice's local bridge, and Alice reaches it through Dorks. Today that
only works if Alice joins Dorks' Wurmhol org, which is wrong four ways:

- **Every member sees every pipe.** The wall, `/api/shares`, `/v1/pipes` and the MCP server list
  the whole org's pipes, so Bob would see Alice's, and an org member's cookie opens any of them
  (spec section 6).
- **Membership is a management role.** A member can terminate pipes and make tokens; an owner
  can do anything. A SaaS's end users must have none of that.
- **The SaaS's staff can open every tunnel.** Membership is the traffic permission, so anyone on
  the Dorks team who is in the org can open Alice's app, by design.
- **Members cost the SaaS its plan's member cap and its users a Wurmhol account.** Alice should
  sign in to Dorks, not to Wurmhol.

ADR 0028's access key lets a program reach one pipe without signing in, but it is one bearer
secret per pipe, chosen by whoever opens it, with no subject, expiry or revocation short of
ending the pipe. It cannot say "Alice, for the next hour".

What exists and can be reused:

- **Named pipes** (ADR 0009) keep one host across reopens; `pipe_names` reserves a name to an org.
- **`keepOpen`** (ADR 0030) reopens a pipe on `expired` and `disconnected` and stops on final
  reasons.
- **The Share object** checks every viewer request already, caches membership for a short time,
  tags each viewer WebSocket (`v:<stream>`), and can end streams.
- **Usage** goes Share object → Org object → Stripe in batches that count once (ADR 0027).
- **One-time codes** swap for a host-only cookie on the pipe host (spec section 6, ADR 0026).

## Decision

### 1. Embedded is a mode of Business, not a third plan

Embedded is a feature an org on Business turns on by creating an application. Friends orgs
cannot create one (`402`, with the fix "move the org to Business"). With billing off on a
self-hosted install it is always available.

A third tier is not needed: the meter, the spend cap and the Stripe price Business already has
are what an embedding SaaS pays with (section 8). A tier would be justified only if packaging
needed a different base price or meter for embedding (per-tenant pricing, a committed volume, a
much higher fair-use count of open tunnels than Business can carry at its price). Those are
pricing decisions and stay out of this ADR; if they come, they change `PLAN_LIMITS` and Stripe
prices, not the authorization model below.

### 2. Who owns what

| Thing            | What it is                                                         | Table         |
| ---------------- | ------------------------------------------------------------------ | ------------- |
| **Organization** | The Wurmhol org: billing, members, integration keys. Unchanged.    | Better Auth's |
| **Application**  | One integrating SaaS inside an org (Dorks).                        | `apps`        |
| **Tenant**       | An isolated customer or account inside an application.             | `tenants`     |
| **Subject**      | An authenticated end user or service, inside exactly one tenant.   | `subjects`    |
| **Tunnel**       | A durable, private endpoint for one tenant; outlives its sessions. | `tunnels`     |
| **Session**      | One connection of the tunnel's agent: a share, as today.           | `shares`      |

- Every embedded tunnel belongs to one application and one tenant, and has one owner subject.
- Tenants and subjects are named by the SaaS's own ids (`external_id`), opaque to Wurmhol. The
  docs say not to use emails or names there: Wurmhol needs no personal data about end users.
- Subjects are not Better Auth users. They have no password, session or org membership and need
  no Wurmhol account, subscription or payment method.
- A tunnel's host is `e<15 random letters and digits>.<pipe domain>`, reserved in `pipe_names`
  to the org. It is a valid named-pipe label, so routing, the OAuth relay (ADR 0010) and
  `keepOpen` reopening at the same URL work unchanged. A classic pipe can never take that name.

The spec's "operators" are the SaaS's own staff. To avoid confusion with the deployment operator
of ADR 0022, this ADR calls them **app managers** (people, in the console) and the **integration**
(the SaaS backend, with a key).

### 3. Credentials

Four credentials, each with a distinct prefix so scanners, logs and routes tell them apart. All
are random, at least 32 bytes, stored only as SHA-256 hashes, and checked by name, presence or
length only in logs.

| Credential          | Prefix | Held by                  | Can                                                      | Lifetime                            |
| ------------------- | ------ | ------------------------ | -------------------------------------------------------- | ----------------------------------- |
| **Integration key** | `whk_` | The SaaS backend only    | The `/v1/embed` API, within its permissions (section 4)  | Until revoked; optional expiry      |
| **Connector**       | `whc_` | One local agent          | `/connect` for one tunnel: open, reconnect, reopen, stop | Default 30 days, max 365; revocable |
| **Grant**           | `whg_` | One subject's client     | Traffic to one tunnel, as one subject                    | Default 1 hour, max 24 hours        |
| **Launch code**     | none   | A browser, in a redirect | Swaps once for a grant cookie on the tunnel's host       | 60 seconds, single use              |

- **The integration key never leaves the SaaS backend.** The SDK's embed client refuses to start
  where `window` or `document` exists, and the docs say so first. Nothing the relay sends to an
  agent or a browser contains it.
- **Integration keys belong to the application, not to a person.** ADR 0021 revokes a person's
  tokens when they leave the org; an integration key made by an engineer who leaves keeps
  working, because a SaaS in production must not go down when someone changes jobs. The console
  shows who made each key and when it was last used; owners revoke and rotate. This departs from
  ADR 0021 for integration keys only. Removing an application or deleting the org revokes its keys.
- **A connector opens one tunnel.** `/connect` with a `whc_` credential takes a port and nothing
  that picks or shapes the pipe: no `name`, no `--only`, no access key. The tunnel is the
  connector's. It is refused on every other route (`/v1/pipes`, `/v1/embed`, `/api/*`, `/host`,
  `/mcp`, `/device/*`), so a CLI or agent credential reaches no billing, members, tokens or org
  settings.
- **A grant is traffic only.** It lists nothing, stops nothing and reaches no API. It names one
  tunnel and one subject, so a grant minted for Alice's tunnel is useless on Bob's.
- **Classic tokens see no embedded tunnel.** `pipes` and `org` tokens, members' sessions and the
  hosted MCP server neither list, open, terminate nor reconnect embedded tunnels, and `/connect`
  with a classic token refuses a name reserved for one.

### 4. Authorization: lifecycle and traffic are separate permissions

**Integration key permissions**, chosen when the key is made (any combination):

| Permission        | Allows                                                                           |
| ----------------- | -------------------------------------------------------------------------------- |
| `tunnels:read`    | List tunnels and their health and usage metadata (section 7)                     |
| `tunnels:manage`  | Create, stop and delete tunnels; issue and revoke connectors; edit tunnel access |
| `subjects:manage` | Create, update, disable and delete tenants and subjects                          |
| `grants:issue`    | Issue and revoke grants for subjects on a tunnel's access list                   |

A dashboard key gets `tunnels:read` alone and can never mint traffic. A backend that signs its
users into their tunnels needs `grants:issue`.

**Tunnel access is explicit.** Each tunnel has an access list (`tunnel_access`) of subjects of its
tenant; the owner subject is on it from creation. The integration adds or removes subjects
(`tunnels:manage`). A grant is issued only for a subject that is on the tunnel's access list,
enabled, and of the tunnel's tenant; a subject of another tenant can never be added. Organization
membership, ownership of the org, app manager rights and `tunnels:manage` alone grant no traffic.

**Traffic checks, on every request to an embedded tunnel's host**, in the Share object:

1. The request carries a grant: the grant cookie (browsers) or `x-wurmhol-grant: whg_…`
   (programs). A member's `__Host-wurmhol` share cookie and ADR 0028's `x-wurmhol-key` are
   refused on embedded hosts.
2. The grant exists, is for this tunnel, is unexpired and unrevoked, and its subject is enabled
   and still on the access list.
3. Then the request is relayed as any other: limits, metering, the stripping of `x-wurmhol-*`
   headers and of the relay's cookies (the grant cookie and the grant header included) apply.

The SaaS backend is the identity provider: it asserts who Alice is, so a backend holding
`grants:issue` can mint a grant for any subject on a tunnel's list. That is inherent to the
model and documented. What the relay guarantees is that no one reaches a tunnel without a grant
it issued, for a subject on that tunnel's list, and every grant is recorded (section 7). The
SaaS's staff get no access through their Wurmhol role; to look at Alice's app they need Alice's
backend to mint them a grant as a subject Alice's tunnel lists, which is an auditable act in the
SaaS's own product.

### 5. Grant exchange, browser and program clients

**Programs** (an agent in a sandbox, an authenticated WebSocket client): the backend calls
`POST /v1/embed/grants { tunnel, subject, ttlSeconds, kind: "client" }` and hands the returned
`whg_` token to that client, which sends it as `x-wurmhol-grant` on each HTTP request and on the
WebSocket handshake. The relay strips the header before the dev server sees it.

**Browsers**: `kind: "browser"` returns a `launchUrl` on the tunnel's host,
`https://<host>/__wurmhol/launch?code=<launch code>&next=<path>`, instead of a token. The browser
navigates there; the Worker swaps the code once for a host-only cookie and redirects to `next`
(same-origin paths only, as `/__wurmhol/auth` does). The cookie:

- is `__Host-wurmhol` with the same attributes as a member's share cookie, but its value names the
  tunnel and the grant, `e.<tunnelId>.<grantId>.<expiresAt>.<signature>`, signed under a key
  derived separately from both Better Auth's and the member share cookie's, so neither kind
  verifies as the other;
- is bound to the tunnel, not to the session, so it survives the agent reopening the tunnel;
- lasts until the grant expires, at most 24 hours.

**An unknown or expired browser** on an embedded host is never sent to Wurmhol's `/open` or login
page (its users have no Wurmhol account). A page navigation is redirected to the application's
`launch_url` (set by an app manager) with `tunnel=<id>&next=<path>`: the SaaS signs its user in,
issues a fresh browser grant and redirects to the new `launchUrl`. Without a `launch_url`, and for
anything that is not a page navigation, the answer is `401 grant required`.

**Browser WebSockets from the SaaS's own pages** (a socket from `app.dorks.dev` to the tunnel's
host) cannot carry the host-only cookie and cannot set headers. They carry a client grant in the
WebSocket subprotocol list instead, the pattern Kubernetes uses for bearer tokens:

- The page offers two entries, `wurmhol.grant` and `wurmhol.grant.<whg_ token>`, beside any of
  its app's own subprotocols. The SDK's browser helper builds the list.
- The relay accepts this only on a WebSocket handshake, and only when the request's `Origin` is
  in the application's `allowed_origins` (set by an app manager; empty refuses every one). This
  stops another site's page from using a leaked grant from a victim's browser.
- The relay removes both entries before the handshake reaches the dev server. It answers with the
  subprotocol the dev server chose, or with `wurmhol.grant` when it chose none, because browsers
  fail a handshake that names protocols and gets none back. The token is never echoed.
- The grant is a short-lived client grant, minted per connection by the SaaS backend and handed to
  its page; it is in page memory, never in a URL, a cookie or storage.

**Third-party iframes are not supported.** A tunnel's page opens in a top-level tab or a popup
(`window.open(launchUrl)`), never in an iframe on another site. Browsers block or partition
third-party cookies differently, and a framed tunnel invites clickjacking of the user's own app.
The grant cookie stays `SameSite=Lax` with no `Partitioned` attribute, so a cross-site frame never
gets a session and shows the `401` page. Supporting iframes would need its own ADR.

### 6. Expiry, revocation and reconnect

- **Expiry.** A grant stops at `expires_at`. HTTP requests after it are refused. The Share object
  keeps an alarm at the earliest expiry among open viewer sockets and closes each socket whose
  grant expired with close code `4401` and reason `grant expired`. The client issues a new grant
  and reconnects; the SDK's client helper does both.
- **Revocation.** `DELETE /v1/embed/grants/:id`, removing a subject from a tunnel's access list,
  disabling or deleting a subject or tenant, and deleting a tunnel or application all revoke the
  affected grants. The order is D1 first, then the open tunnel's Share object: it drops the grants
  from its cache and closes every viewer socket opened under them (tagged `g:<grantId>`) with
  close code `4403` and reason `grant revoked`. A request in flight during the revoke reads D1 or
  the emptied cache and is refused. If the object was evicted, its cache is gone and the next
  request reads D1.
- **The grant cache.** The Share object caches a checked grant until the sooner of its expiry and
  60 seconds, so a lost revocation push still takes effect within a minute; revocation's push
  makes it immediate in the normal case.
- **Connectors.** Revoking a connector ends the tunnel's open session with `revoked` (final, so
  `keepOpen` stops) and refuses its reconnects. Issuing a new connector does not revoke the old
  one unless asked (`rotate: true`), so an agent can be handed the new one first.
- **Reconnect.** A connector reconnects to its session (`/connect?share=`) or, after `expired` or
  `disconnected`, reopens a new session at the tunnel's same host, as a named pipe does. Grants
  belong to the tunnel, so viewers keep their grants across sessions; their WebSockets close with
  the old session (`1012`, as today) and reconnect with the same grant.
- **Stopping.** `POST /v1/embed/tunnels/:id/stop` ends the open session with `terminated`, which
  `keepOpen` treats as final; the connector stays valid, so the agent can open the tunnel again
  when it is restarted. `DELETE` ends the session, revokes the connectors and grants, and marks
  the tunnel deleted; its host is never reused.

### 7. App managers and the integration see health, never traffic

- **Health metadata** for a tunnel, through `tunnels:read` and the console: state (`never`,
  `live`, `away`, `stopped`, `deleted`), tenant and owner ids, connected-since, last request time,
  requests and bytes in the current window, the agent's client and version, the last session's
  end reason, connector and grant counts. Nothing from inside the tunnel: no page title, no
  favicon, no paths, no headers. The start-of-pipe probe that reads the title and favicon for the
  wall does not run on embedded tunnels.
- **No "open" anywhere** in the console or the API for app managers; the console's Applications
  page has Stop and Delete, not a link to the tunnel.
- **Grant log.** `grant_events` records each issue and revoke: which key, which subject, which
  tunnel, when, and the grant's expiry. No IPs, user agents, paths or bodies. The integration can
  read it (`tunnels:read`) and show it to its own users.
- **Bodies are never logged or stored**, as for every pipe. The embedded hosts keep less than a
  classic pipe: not even the title and favicon.
- **This is application-level access isolation.** The relay terminates TLS: the deployment
  operator and Cloudflare can technically read relayed traffic, as spec section 6 states for every
  pipe. Embedded mode does not provide end-to-end encryption from the relay operator. The docs
  say this on the Embedded page, not only in the security model.
- **Takedown** (ADR 0022) works on embedded hosts as on any pipe: it ends the session, revokes the
  connector, and with `blockOrg` blocks the org and every application in it.

### 8. Billing and limits

- **Usage aggregates to the org.** Embedded sessions report usage through the same Share object →
  Org object → Stripe path, so they count toward the org's Business meter and spend cap with no
  new Stripe price. End users pay nothing and need no payment method.
- **Attribution.** Usage batches carry the application and tenant; the Org object keeps per-window
  counts per application and per tenant beside the org's (requests, bytes, open tunnels).
  `GET /v1/embed/usage?tenant=` reports them.
- **Limits per application and per tenant**, set by app managers: monthly requests and open
  tunnels for the application, and a default per tenant with per-tenant overrides. Reaching a
  tenant's limit ends only that tenant's sessions (`limit`) and refuses its new ones; reaching
  the application's ends that application's; the org's spend cap still ends everything, as today.
  A runaway tenant cannot spend the SaaS's whole cap.
- **Open tunnels.** Embedded tunnels do not take the org's wall slots (Business's 500 open pipes).
  They count against a separate fair-use limit per org, `LIMIT_EMBED_ACTIVE`, default and hosted
  value 1,000 open sessions: twice Business's wall slots, raised for an org on request. An idle
  session hibernates and costs nothing, so the limit protects against abuse, not cost, and starts
  low because raising a limit is easy and lowering one breaks a customer.
- **Defaults for a new application**: open tunnels per tenant 10, no per-tenant or per-application
  request limit (the org's spend cap applies). App managers lower or raise them; per-tenant
  values never exceed the application's, nor the application's the org's.

### 9. What stays the same

Friends and team sharing are untouched: the wall, members' cookies, `/open`, `--only`, access
keys, named pipes, classic tokens, machines, the MCP server and Business metering behave as
today. Embedded tunnels are additive rows and code paths, selected by the tunnel's host.

### 10. Settled and deferred

Settled above: browser WebSockets from the SaaS's pages use a subprotocol grant checked against
the application's allowed origins (section 5); third-party iframes are not supported (section 5);
`LIMIT_EMBED_ACTIVE` is 1,000 and a tenant opens 10 tunnels by default (section 8).

Deferred: **custom domains** (ADR 0031) fit as an application's tunnel zone; designed there, not
here.

## Consequences

- A SaaS can give each of its users a private tunnel without adding them to its org, and its
  staff's Wurmhol roles reach lifecycle and health, never traffic.
- The relay gains a second viewer path (grants) beside membership. Both run in the Share object,
  chosen by the tunnel's meta, so a bug in one cannot widen the other; e2e tests cover each
  refusal across the boundary.
- Ten new tables and four nullable columns on `shares`, all additive (section 11).
- Integration keys survive their maker leaving the org; owners must rotate them deliberately.
- The SaaS backend is trusted to assert its users' identities. Wurmhol cannot tell a forged
  "Alice" from a real one; the grant log makes every issued grant visible.
- One more D1 read per grant per minute per open session, and per viewer request a hash and a
  cache lookup in the Share object.

## 11. Implementation plan

### Goal and acceptance criteria

Ship Embedded mode on Business behind the design above. Done when, on the real stack (workerd,
D1, Durable Objects, the CLI and SDK, local servers), e2e tests show:

1. Alice cannot list, open, reconnect to or stop Bob's tunnel, with any credential she can hold
   (her grant, her connector), and a grant for Alice is refused on Bob's tunnel and across tenants.
2. An org owner signed in to the console, with a member share cookie or an `org` token, cannot
   open, list or terminate an embedded tunnel, and it never appears on the wall, `/api/live`,
   `/v1/pipes` or the MCP server.
3. A revoked grant is refused on the next HTTP request and closes its open WebSockets with
   `4403`; an expired one closes with `4401`.
4. Connectors and grants are refused on `/api/*` (billing included), `/v1/pipes`, `/v1/embed`,
   `/host`, `/mcp` and `/device/*`.
5. Existing suites (`viewers`, `access`, `wall`, `named-pipes`, `pipes-api`, `billing`,
   `metering`, `takedown`, `sdk*`) pass unchanged.

### Stack

One PR per step, stacked (`gh stack`, see [Contributing](../contributing.md)). Each is deployable
on its own: nothing reads a new table before the migration that makes it has run. The
Applications page and `/v1/embed` answer 404 until `EMBEDDED` is set (off by default, documented
for self-hosters), which hosted Wurmhol sets only after step 6 passes.

**Step 1: protocol.** `packages/protocol`, pure:

- Credential prefixes and parsers (`whk_`, `whc_`, `whg_`), with unit tests for shape and length.
- `GRANT_HEADER` (`x-wurmhol-grant`), already covered by the `x-wurmhol-*` strip; add a unit test
  that it is stripped.
- `EMBED_PERMISSIONS`, `SUBJECT_KINDS` (`user`, `service`), close codes `4401` and `4403`.
- `embedTunnelName()` generating and recognizing `e` + 15 characters, and a test that it is a
  valid `pipeName` and never a `SHARE_ID`.

**Step 2: schema.** `packages/db/src/schema/app.ts`, then
`pnpm --filter @wurmhol/db db:generate`. Additive only; every table has `org_id` and cascades from
the org. The tables are named with an `embed_` prefix (`embed_apps`, …). The new `shares` columns
have no delete action: embedded rows are soft-deleted, so deleting one a session points at is
refused instead of turning the session into an org pipe.

| Table            | Columns (beyond `id`, `org_id`, `created_at`)                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps`           | `name`, `launch_url`, `allowed_origins` (text list), `monthly_requests`, `active_tunnels`, `tenant_monthly_requests`, `tenant_active_tunnels` (limits nullable), `deleted_at` |
| `app_keys`       | `app_id`, `name`, `hash` (unique), `permissions` (text list), `created_by` (set null), `expires_at`, `last_used_at`, `revoked_at`                                             |
| `tenants`        | `app_id`, `external_id` (unique per app), `monthly_requests`, `active_tunnels` (overrides), `disabled_at`                                                                     |
| `subjects`       | `app_id`, `tenant_id`, `external_id` (unique per tenant), `kind`, `disabled_at`                                                                                               |
| `tunnels`        | `app_id`, `tenant_id`, `owner_subject_id`, `name` (unique, also in `pipe_names`), `stopped_at`, `deleted_at`                                                                  |
| `tunnel_access`  | `tunnel_id`, `subject_id` (primary key together)                                                                                                                              |
| `connectors`     | `tunnel_id`, `hash` (unique), `expires_at`, `last_used_at`, `revoked_at`                                                                                                      |
| `grants`         | `app_id`, `tenant_id`, `tunnel_id`, `subject_id`, `key_id`, `kind`, `hash` (unique, null for browser grants), `expires_at`, `revoked_at`                                      |
| `launch_codes`   | `hash` (primary key), `grant_id`, `expires_at`; deleted on use and swept like `oauth_states`                                                                                  |
| `grant_events`   | `grant_id`, `key_id`, `subject_id`, `tunnel_id`, `event` (`issued`, `revoked`, `expired`), `at`                                                                               |
| `shares` (alter) | nullable `app_id`, `tenant_id`, `tunnel_id`, `connector_id`; index `(tunnel_id, ended_at)`                                                                                    |

Query helpers in `packages/db` (`useAppKey`, `useConnector`, `findGrant`, `revokeGrants…`) scope
every query by `org_id` and application. Migration runs while the old Worker serves; the old
Worker never reads the new columns.

**Step 3: applications and keys in the console.** Worker `/api/apps` (owners only, Business or
billing off): create, rename, set `launch_url`, allowed origins and limits, delete; make, list and revoke
integration keys (shown once, with permissions). Web app: an Applications page per
[DESIGN.md](../../DESIGN.md), with tunnels' health and Stop/Delete and no open link. E2E: a member
who is not an owner is refused; a Friends org gets `402`; a key is shown once and stored hashed.

**Step 4: tenants, subjects, tunnels, connectors.** `/v1/embed` on the CLI's host, integration key
only, per-permission middleware like `requireOrgToken`:

- `PUT /v1/embed/tenants/:externalId`, `DELETE …` (revokes its grants, deletes its tunnels).
- `PUT /v1/embed/tenants/:tenant/subjects/:externalId { kind }`, `PATCH { disabled }`, `DELETE`.
- `POST /v1/embed/tunnels { tenant, owner, access? }` → `{ tunnel: { id, url }, connector }`.
- `GET /v1/embed/tunnels?tenant=&subject=&state=`, `GET /v1/embed/tunnels/:id` (health only).
- `POST /v1/embed/tunnels/:id/stop`, `DELETE /v1/embed/tunnels/:id`.
- `PUT` and `DELETE /v1/embed/tunnels/:id/access/:subject`.
- `POST /v1/embed/tunnels/:id/connectors { rotate? }`, `DELETE …/connectors/:id`.

`/connect` accepts a `whc_` credential: looks up the connector, its tunnel and application, checks
the org is not blocked and on Business, and opens or reopens the tunnel's session with
`ShareInit.embed = { appId, tenantId, tunnelId }`. The Org object reserves embedded sessions in a
separate count, not as wall cards. `shareOfOrg`, `/api/shares`, `/api/live`, `/v1/pipes`, the MCP
listing and `checkToken` exclude embedded shares and credentials. Takedown (`routes/operator.ts`) revokes an
embedded session's connector where it revokes a classic pipe's token. E2E: a connector opens and
reopens its tunnel at the same host and reaches nothing else; classic tokens cannot take the name
or see the session; health has no title or favicon.

**Step 5: grants.** `POST /v1/embed/grants`, `DELETE /v1/embed/grants/:id`, `grant_events`. In the
Worker's share-host handler (`viewer.ts`), embedded hosts go through a grant path: the launch
route, the grant cookie (new signer beside `share-cookie.ts`), the grant header, the subprotocol
grant on WebSocket handshakes (origin check, both entries stripped, `wurmhol.grant` answered when
the dev server picks none), and the redirect to `launch_url`. In the Share object: the grant check and cache, `g:<grantId>` socket tags, the
expiry alarm, and `revokeGrants(ids)` called after D1 on every revoking route. Member cookies and
access keys refused on embedded meta. E2E: acceptance criteria 1 to 4, including a WebSocket held
open across a revoke and an expiry; a subprotocol grant from an allowed origin connects, from any
other origin is refused, and the dev server never sees either entry.

**Step 6: usage and limits.** Usage batches carry `appId` and `tenantId`; the Org object keeps
per-application and per-tenant counts per window and enforces their limits on reserve and on usage,
ending only the affected sessions. `GET /v1/embed/usage`. `LIMIT_EMBED_ACTIVE` already arrived in step 4, with the session
reservation it guards. E2E: a tenant over its limit loses only its own
sessions; the org's Stripe meter (test mode) receives the sum once.

**Step 7: SDK and CLI.** `@wurmhol/sdk`:

- `@wurmhol/sdk/embed`, server-only: `new WurmholEmbed({ key, server })` with `tenants`,
  `subjects`, `tunnels` (create, list, get, stop, delete, access, connectors), `grants.issue`
  (`client` returns a token, `browser` a `launchUrl`), `grants.revoke`, `usage`. It throws a
  `FixError` (`unsupported`) in a browser.
- Agents: `keepOpen({ connector, port })` and `openPipe({ connector })`; `name`, `viewers` and
  `accessKey` are refused with a connector. `keepOpen` already treats `revoked` and `terminated`
  as final.
- Clients: `grantHeaders(token)` and a WebSocket helper that reissues a grant through a callback
  and reconnects on `4401`; `4403` is final.
- Browsers: `@wurmhol/sdk/browser`, a dependency-free entry with `grantProtocols(token, own?)`
  (the subprotocol list of section 5) and the same reconnecting WebSocket helper, taking a callback
  that asks the SaaS backend for a fresh client grant.
- CLI: `WURMHOL_TOKEN=whc_… wurmhol <port>` opens the connector's tunnel; `--name` and `--only`
  are refused with a fix. `wurmhol login` stays for members.
- E2E with a compiled Bun binary as in `sdk-bun.e2e.test.ts`, plus a TypeScript example app.

**Step 8: docs.** An Embedded page in `apps/docs` (model, credentials, the browser flow, limits,
and the isolation and no-end-to-end-encryption statement), the API reference for `/v1/embed`, the
SDK reference, and the self-hosting variable. Mark this ADR accepted, noting any departures found
while building.

**Step 9: production verification**, per [Contributing](../contributing.md): after the deploy, a
test application in a Business test org opens a tunnel from a real agent, a grant opens it in a
browser and from a WebSocket client, a revoke closes both, and the owner's console shows health
without an open link.

### Migration and rollout

- All schema changes are additive and nullable; no backfill, no destructive step. Old Workers
  ignore the new columns and tables.
- Order per deploy: migration, then the Worker. The SDK and CLI release after the Worker that
  serves them; an older relay answers a `whc_` credential with `401`, which the SDK shows as
  "this relay does not support embedded tunnels" (`GET /v1/capabilities` from ADR 0031, if built
  by then, reports `embedded`).
- Dorks moves from one shared org with access keys to an application: it creates a tenant and
  subject per account, a tunnel per bridge, hands each bridge its connector, and replaces access
  keys with client grants. Its old named pipes keep working until it stops opening them.
