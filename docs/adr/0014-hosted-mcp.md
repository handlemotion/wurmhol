# 0014: A hosted MCP server, so a person's assistant can see and end the org's pipes

Status: proposed. Departs from ADR 0006 (the CLI's host answers more than `/connect`, `/device/*`,
`/v1/*` and `/health`) and from spec v1 section 6 (a second kind of credential besides `wh_`
tokens: OAuth access tokens issued to MCP clients).

## Context

`wurmhol mcp` (the CLI's stdio server) gives the agent that runs a dev server tools to open,
list and stop its own pipes. It runs where the code runs and can only see pipes it opened.

A different person asks a different question: someone in claude.ai, Claude Desktop, ChatGPT or
any assistant that takes a remote MCP server, asking "what pipes is my org running?" or "end the
one on port 5173". They are not in the sandbox, have no `wh_` token in their environment, and
expect to add a connector by URL and sign in, as with any other remote MCP server. Today they
can open the wall, or an orchestrator can call `GET /v1/pipes` with an `org` token (ADR 0008).
Neither works from inside an assistant.

What exists to build on:

- **The wall's data.** The Org Durable Object lists the org's open pipes as cards (title, port,
  starter, started, last request), and the Share Durable Object terminates one. `/v1/pipes`
  already serves both behind a bearer token.
- **Better Auth 1.7 (`packages/auth`)**: organization, device authorization and passkey plugins.
  Its MCP support has moved to `@better-auth/mcp` (1.7.18): `mcp()` turns the Better Auth
  instance into an OAuth 2.1 authorization server for one protected resource, built on
  `@better-auth/oauth-provider`. It serves RFC 9728 protected resource metadata, binds tokens to
  the resource (`aud`), issues JWT access tokens signed with keys from the `jwt()` plugin, and
  composes with `cimd()` for the MCP 2026-07-28 client registration flow (Client ID Metadata
  Documents). Dynamic Client Registration is off unless enabled on purpose. `requireMcpAuth`
  checks a bearer token's signature, issuer, audience, expiry and scopes, then hands the handler
  the verified claims.
- **The MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.4.0)**: `createMcpHandler` takes
  a web `Request` and returns a `Response`. With `legacy: "reject"` it speaks only the 2026-07-28
  protocol, where every request stands alone: one `POST` route and no session store. That fits a
  Worker.
- **The `RateLimiter` Durable Object**: fixed windows per (rule, key), with each rule set by an
  environment variable.

## Decision

### Transport and host

- **Streamable HTTP, at `https://api.wurmhol.com/mcp`, `POST` only.** `createMcpHandler` from
  `@modelcontextprotocol/server` with `legacy: "reject"`. A new server is built per request, so
  nothing is held between requests and no Durable Object is needed. `GET` and `DELETE` answer 405.
- **On the CLI's host, not the console's.** ADR 0006 keeps the console's API on `dirt` because it
  runs on `__Host-` session cookies. `api` is the host where every route takes a bearer credential,
  and the MCP route is one of those. Its protected resource metadata is served at
  `api.wurmhol.com/.well-known/oauth-protected-resource/mcp`. **Departs** from ADR 0006: `api`
  grows by `/mcp` and that metadata path.
- **The authorization server stays at `BETTER_AUTH_URL` (`dirt`)**, where people sign in. That
  is where the OAuth endpoints (`/api/auth/oauth2/*`), the authorization server metadata and the
  JWKS live. Sign-in and consent are pages in `apps/web`.

### Auth: Better Auth's MCP plugin first, `wh_` tokens second

- **OAuth through `@better-auth/mcp`** with `jwt()` and `cimd()`, `resource` set to the MCP
  URL. This is what assistant hosts implement. A person adds the URL, their assistant discovers
  the authorization server, sends them to `dirt` to sign in (passkey, Google, GitHub, magic link,
  as today) and to a consent page, and gets a short-lived access token for the `/mcp` resource
  only.
  - Client registration through CIMD, the 2026-07-28 default: the client's `client_id` is an
    HTTPS URL to its metadata document. Unauthenticated Dynamic Client Registration stays off.
    `fetchClientMetadataResource` is ours: HTTPS only, no private or loopback addresses, a size
    cap and a timeout, because the Worker fetches a URL the client chose.
  - The consent page names the client (from its metadata document, shown as unverified), what it
    will be able to do (the scopes below), and the orgs it will reach.
- **An `org`-scope `wh_` token also works as the bearer**, for headless clients that send a fixed
  header (`claude mcp add --transport http … --header "Authorization: Bearer wh_…"`) and for
  orchestrators already holding one. The route looks at the prefix: `wh_` goes through the
  existing `bearerToken` check (scope `org` required, as for `/v1/pipes`), and anything else goes
  through `requireMcpAuth`. Such a token reaches only its own org.
- **Rejected: `wh_` tokens only.** claude.ai connectors and most hosted assistants expect OAuth
  and do not offer a header field, so the person this ADR is for could not connect.
- **Rejected: our own OAuth server, or Cloudflare's `workers-oauth-provider`.** Better Auth
  already owns users, sessions, orgs and the device flow. A second authorization server would
  mean a second token store, second sign-in screens and second revocation logic.
- **Rejected: putting the org in the token.** A person often belongs to several orgs, and
  membership changes. The access token names the user (`sub`). Every tool call reads that user's
  memberships from D1 and checks the org it touches, as every console route does (AGENTS.md: check
  membership first). Removing someone from an org takes effect on their next call, not when
  their token expires.

### Scopes and tools

No `open_pipe`: a hosted server cannot reach anyone's localhost. Opening pipes stays with the CLI
and its stdio server.

| Tool         | Scope         | Does                                                                       |
| ------------ | ------------- | -------------------------------------------------------------------------- |
| `list_orgs`  | `pipes:read`  | The orgs the person belongs to, with their open pipe counts                |
| `list_pipes` | `pipes:read`  | An org's open pipes (default: every org of theirs), as the wall's cards    |
| `get_pipe`   | `pipes:read`  | One pipe by id or name: its card, plus when it ends and who may open it    |
| `stop_pipe`  | `pipes:write` | Terminate a pipe, as Terminate on the wall does; the CLI sees `terminated` |

- Every member may terminate any of the org's pipes (spec section 4), so `pipes:write` is open to
  every member. The scope exists so that a person can grant read-only access to a client.
- Results are the wall's data and nothing more: no request bodies, paths or viewer details beyond
  what the card shows (ADR 0008's privacy rules apply unchanged). Tool annotations mark `stop_pipe`
  as destructive, so hosts ask before calling it.
- An `org` `wh_` token carries both scopes, for its own org only.
- Members, tokens and billing are not exposed. Those stay in the console, behind a session.

### Rate limits

- A new rule, `RATE_LIMIT_MCP` (default `120/60`), on the `RateLimiter` Durable Object, keyed by
  user id (OAuth) or token id (`wh_`). A refused call is an MCP tool error that says when to
  retry, and the HTTP response carries `Retry-After`.
- The OAuth endpoints on `dirt` fall under the existing `RATE_LIMIT_AUTH`. CIMD fetches are cached
  per `client_id` for their `Cache-Control` lifetime, capped at a day, so a client cannot make the
  Worker fetch on every request.
- Access tokens last 1 hour and refresh tokens 30 days, with rotation (the plugin's defaults).
  "Connected apps" in the console's Tokens dialog lists each client a person has consented to,
  and revoking one deletes its refresh tokens.

### Self-hosting

- **Schema:** `jwt()`, `mcp()` and `cimd()` add Better Auth tables (signing keys, OAuth clients,
  access and refresh tokens, consents). They are generated with `pnpm --filter @wurmhol/auth
  auth:generate` and migrated like any other additive change.
- **No new secret.** The `jwt()` plugin keeps its private signing key in D1, encrypted with
  `BETTER_AUTH_SECRET`.
- **No new required variable.** The resource URL is derived: `https://<CONNECT_HOST>/mcp` when
  `CONNECT_HOST` is set, else `<BETTER_AUTH_URL>/mcp` for a single-host install (ADR 0006's
  self-hosting rule). `MCP_ENABLED` (default `true`) lets an install turn it off; disabled, `/mcp`
  answers 404 and the plugins' routes refuse. `RATE_LIMIT_MCP` is optional. All of these go in
  `.dev.vars.example`, with a section in `docs/self-hosting.md`.
- Still one Cloudflare account, two hostnames and `wrangler deploy`.

## Open questions

1. **JWKS fetched over the network.** `requireMcpAuth` fetches `<BETTER_AUTH_URL>/jwks` by
   default. A Worker that fetches its own hostname can loop or be refused. If it does, verify in
   process with `createMcpProtectedRequestHandler` and the keys read straight from D1. To check
   when implementing.
2. **Does `@better-auth/mcp` run on Workers with the D1 adapter** as `deviceAuthorization` does?
   Its `jwt()` key handling uses WebCrypto, which should be fine, but nobody has run it there yet.
3. **Which hosts support CIMD today.** Hosts that only do Dynamic Client Registration would need
   `allowDynamicClientRegistration` with authenticated registration, or a client we pre-register.
   We should check each target host (claude.ai, Claude Desktop, ChatGPT) before building.

## Order of work

Each is one pull request, in a stack on `main`:

1. `packages/auth`: `jwt()`, `mcp()` and `cimd()`, the generated schema, and the consent page in
   `apps/web`. An e2e test runs the authorization code flow with PKCE against the real stack, as an
   MCP client does.
2. `apps/worker`: `/mcp` on the CLI's host with the four tools, `wh_` bearer support, membership
   checks and `RATE_LIMIT_MCP`. E2E tests drive it with the official MCP client over Streamable
   HTTP, covering another org's pipe refused, a removed member refused on their next call, and
   `stop_pipe` reaching the CLI as `terminated`.
3. Connected apps in the Tokens dialog, and revocation.
4. Docs: the docs site's MCP page gains "Connect your assistant", and `docs/self-hosting.md` gains
   its section.

## Consequences

- People can ask their assistant about their org's pipes and end them, without the console.
- Wurmhol gains a second credential type, OAuth access tokens, with its own tables, expiry and
  revocation. It is scoped to one resource and two scopes, and cannot open pipes or manage the org.
- The CLI's host now answers `/connect`, `/health`, `/device/*`, `/v1/*`, `/mcp` and one
  `.well-known` path. Every route on it still takes a bearer credential or a device code, never a
  cookie.
- The Worker fetches URLs that clients choose (CIMD documents): a new outbound path, fenced by
  our own fetcher.
