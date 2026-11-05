# 0008: Privacy, ergonomics when the human is elsewhere, and an SDK for orchestrators

Status: proposed. Departs from spec v1 in four places, each marked **Departs** below: ADR 0006
(the CLI's host answers more than `/connect`), section 4 (a shorter default pipe lifetime),
section 6 (token scopes and expiry) and section 2 ("not in v1: per-share invites").

## Context

Wurmhol's pitch is a generous ngrok for coding agents: one command in a sandbox, a private URL
for the humans. Three groups need more than v1 gives them:

- **People who care what we can see.** The relay terminates TLS, so it can read every request.
  The site says so, but we have never written down what we _do_ keep, for how long, or how far
  privacy can go before it breaks the product.
- **The human who isn't on the agent's machine.** Today a token is created in the console and
  pasted into `WURMHOL_TOKEN`. That works for a cloud environment's secrets, and nowhere else is
  pleasant: over SSH, on a fresh laptop, or for a second agent host.
- **Orchestrators** (Conductor-style apps running many agents at once) want preview URLs as a
  library call, a token that belongs to the org rather than a person, and a way to list and close
  what they opened. Today the only client is a CLI that forks a daemon.

### What the code stores today

From `packages/db/src/schema`, the Durable Objects and `log.ts`, as of this ADR:

| Where                       | What                                                                                          | How long                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| D1 `users`                  | name, email, avatar URL (from OAuth), email verified                                          | until the account is deleted                                             |
| D1 `accounts`               | OAuth provider ids, and the provider's access, refresh and id tokens, in plain text           | same                                                                     |
| D1 `sessions`               | session token, expiry, **IP address** (`X-Forwarded-For`) and **user agent**                  | until expiry, rows not pruned                                            |
| D1 `passkeys`               | public keys and metadata                                                                      | until removed                                                            |
| D1 `verifications`          | magic-link and OAuth state, short-lived                                                       | expiry, rows not pruned                                                  |
| D1 orgs, members, invites   | org name, membership and role, hashed invite codes                                            | until removed                                                            |
| D1 `tokens`                 | name, SHA-256 of the token, creator, created, last used, revoked                              | forever (history)                                                        |
| D1 `shares`                 | id, org, token, starter, port, start and end, end reason, bytes relayed                       | forever (history)                                                        |
| D1 `subscriptions`          | Stripe customer and subscription ids, status, period                                          | forever                                                                  |
| Share Durable Object        | the pipe's meta, including **the page `<title>`**; the favicon; one-time sign-in codes        | favicon and codes deleted at end; **meta, with the title, kept forever** |
| Org Durable Object          | cards of open pipes (title, port, starter); monthly byte count                                | card deleted at end                                                      |
| Rate limiter Durable Object | counts keyed by IP, token or member                                                           | deleted when the window ends                                             |
| Our logs (`log.ts`)         | event, route pattern, status, duration, org, share and request ids. No bodies, IPs or queries | Workers Logs, 7 days                                                     |
| Cloudflare invocation logs  | **method and full URL of every request**, pipe paths and query strings included               | Workers Logs, 7 days                                                     |
| Forwarded to the dev server | the viewer's IP as `X-Forwarded-For`                                                          | whatever the dev server does                                             |

Bodies are never logged or stored, and Wurmhol's cookies are stripped before forwarding. The
bold rows are where we keep or pass on more than the product needs.

## Decision

### 1. Privacy

**Data minimization.** Keep what the product needs, for as long as it needs it, and nothing that
identifies a viewer's network:

- Turn off Cloudflare's invocation logs (`observability.logs.invocation_logs: false`). Our own
  log lines already carry what we debug with; the invocation log is the one place pipe paths and
  query strings are written down.
- No IP addresses at rest: `advanced.ipAddress.disableIpTracking` in Better Auth, so `sessions`
  keeps no IP. The rate limiter keeps keying on `cf-connecting-ip` for its window only.
- Stop forwarding the viewer's IP to the dev server. It runs in a sandbox the viewer may not
  control; no dev server needs it. (Rejected: an opt-in flag. Nobody has asked for it.)
- At pipe end, the Share DO deletes its meta down to a tombstone (`state`, `endReason`); the
  title goes with it. The D1 `shares` row is the history.
- Retention, run by a daily cron trigger: `shares` rows and view events after 90 days,
  `verifications` and device codes once expired, expired sessions. Usage that billing needs is
  the Org DO's monthly counter, which is overwritten each month.
- Encrypt OAuth provider tokens at rest (`account.encryptOAuthTokens`). We never call Google or
  GitHub after sign-in, so not storing them at all would be better still; Better Auth has no
  switch for that today, so encryption is the step we can take.

**Per-pipe access.** A pipe can name who may open it: `npx wurmhol 8787 --only ana@x.com,bo@y.com`,
or `viewers` in the SDK. Names must be members of the token's org; the Share DO checks the list
on every request, as it already re-checks membership. The default stays "everyone in the org".
**Departs** from section 2 ("not in v1: per-share invites"), but only narrows access.
Rejected for now: guests outside the org. It is a public link with extra steps, and the abuse
and phishing story (spec section 6) rests on "only org members see pages".

**View log, events only.** The Share DO records, per viewer, the first and last time they
opened the pipe and a request count. No paths, no IPs, no user agents. The wall shows it on the
card ("Ana, 2 min ago"); it ends up in a `share_views` table with `org_id`, pruned with
`shares` after 90 days. Rejected: a per-request access log. It is exactly the browsing history
we promise not to keep.

**Token scopes and expiry.** **Departs** from section 6 ("scoped to start shares").
`tokens` gains `scope` (`pipes`: open pipes; `org`: also list and close the org's pipes through
the API, for orchestrators) and `expires_at`. The console offers 30 days, 90 days or never, with
90 days as the default; `wurmhol login` tokens expire after 90 days. Existing tokens migrate as
`pipes` with no expiry, so nothing breaks.

**Shorter default pipe lifetime.** **Departs** from section 4: a pipe ends after 4 hours unless
the CLI asks for longer (`--ttl 12h`, up to the org's `LIMIT_SHARE_SECONDS`, still 12 h). An
agent's server usually matters for one review, not a working day. Rejected: an idle timeout.
It ends pipes before the human has picked up their phone.

**End-to-end encryption: not worth it.** The design would be: the CLI makes a key, puts it in
the URL fragment (`#k=…`, never sent to servers), encrypts each response, and a service worker on
the pipe host decrypts in the browser. What breaks:

- **The relay serves the code that holds the key.** The bootstrap page and the service worker
  come from the relay. A relay that wants to read traffic serves a service worker that sends the
  key home. Against the party it is meant to stop, it protects nothing. That alone decides it.
- **WebSockets don't pass through service workers.** Vite and Next hot reload, and any app with
  a socket, would be in plain text or broken.
- **Cookies.** A service worker can't apply `Set-Cookie` from a decrypted response. Sign-in in
  the dev app (Omni's magic links, any session cookie) stops working.
- **First load, hard reload and new tabs** bypass or precede the service worker, and the
  fragment is lost on redirects and when a link is opened from the wall or a chat preview.
- The wall loses titles and favicons, and the relay can no longer refuse a request by
  membership after looking at it; it can still only see sizes and timing.

We would ship a weaker product with a security claim it can't keep. The honest options are
the ones we have: say the relay can read traffic, keep nothing, and make self-hosting easy.

**Self-hosting as the strongest option, with a Deploy to Cloudflare button.** The button reads a
repo's Wrangler config, provisions D1 and Durable Objects, prompts for the secrets in
`.dev.vars.example` and sets up Workers Builds on a copy of the repo. Its limit: a subdirectory
must be self-contained, and `apps/worker` depends on workspace packages. So the button points at
the repository root, with a root `wrangler.jsonc` whose `main` is `apps/worker/src/index.ts` and
whose build runs `pnpm install` and builds `apps/web`. Two steps stay manual and go in
`docs/self-hosting.md` beside the button: the wildcard route and certificate for the pipe domain
(no API the button drives can add a route on someone's zone), and the D1 migrations, until the
build applies them. Acceptance is the spec's: a second Cloudflare account, from the button, passes
the v1 list.

### 2. Ergonomics when the human is not on the agent's machine

**`wurmhol login`, a device-code flow.** **Departs** from ADR 0006: the CLI's host answers
`/device/*` too, so a sandbox still allowlists one host.

1. The CLI posts to `<server>/device/code` and prints a short code and a URL:
   `Open https://dirt.wurmhol.com/device and enter WXYZ-1234`.
2. The human opens it on any device, signs in, sees the code, the computer's name and the org
   the token will belong to, and approves or denies.
3. The CLI polls `<server>/device/token`. On approval the Worker mints an ordinary org token
   (`scope: pipes`, 90 days, named after the computer), returns it once, and the CLI stores it in
   `~/.wurmhol/credentials.json` (mode 0600). `WURMHOL_TOKEN` still wins when set.

Better Auth's `deviceAuthorization` plugin does the RFC 8628 part: user codes, polling and
`slow_down`, approve and deny, single redemption. Its token endpoint returns a full Better Auth
session, which can manage members and billing; the CLI should never hold that. So the Worker
calls the plugin's token endpoint itself, turns the approved session into an org token, and
revokes the session in the same request. The org is the approver's active org at approval time,
recorded on the device code's `scope` (`org:<id>`), which the approval route sets.

Rejected: a localhost OAuth callback (the browser is on another machine); keeping a Better Auth
session in the CLI (too much power, and it would need cookies on the API host); our own device
flow (the plugin already gets polling, expiry and one-time redemption right).

In a cloud session the credential file dies with the container, so `login` is for laptops,
SSH and long-lived VMs. Cloud environments keep using a secret, which the next item makes easy.

**A console snippet for cloud environments.** The Tokens dialog, after creating a token, shows
the two things a Claude Code cloud environment needs, each in a `CopyField`:
`WURMHOL_TOKEN=wh_…` for the environment's variables, and `api.wurmhol.com` for its allowed
hosts, with one line saying where each goes.

**A Claude Code plugin with a `wurmhol` skill.** A plugin marketplace in this repo
(`.claude-plugin/marketplace.json`) with one plugin whose skill says when to share (the user
wants to see a running server), how (`npx wurmhol <port>`, send the URL, `wurmhol stop` when
done) and how to read errors (they say the fix). Rejected: an MCP server first. The spec lists
one for later; a skill needs no process and works in every agent that reads skills.

**A better `wurmhol init`.** It detects the dev server's port from `package.json` (Vite 5173,
Next 3000, Astro 4321, else 8787), writes the line with that port, says whether a token is set or
`wurmhol login` is needed, and offers to install the skill into `.claude/skills/wurmhol`.

### 3. An SDK for orchestrators

**`openPipe`, the export of the `wurmhol` package**, which the CLI is rebuilt on:

```ts
import { openPipe } from "wurmhol";

const pipe = await openPipe({ port: 5173, token: process.env.WURMHOL_TOKEN! });
pipe.url; // https://k3x9p2m7qa.pipe.wurmhol.com
pipe.on("request", ({ method, path, status, durationMs }) => {});
pipe.on("close", (reason) => {}); // "stopped", "terminated", "expired", "revoked", ...
await pipe.close();
```

- `openPipe({ port, token, server?, host?, viewers?, ttl?, signal?, log? })` resolves once the relay
  has given the pipe its URL, or rejects with the same one-line fix the CLI prints.
- It runs in the caller's process, no daemon. The CLI's detached daemon is `openPipe` plus
  local state files.
- `request` events carry metadata only and never leave the caller's process.
- `packages/protocol` stays the only codec; the SDK bundles it like the CLI does.
- The package's root export is the SDK and its `bin` is the CLI, as with `vite` or `esbuild`. A
  `wurmhol/sdk` subpath would make every import longer for nothing: nobody imports the CLI.
- `log` passes on the connection's own events (connects, drops, reconnects), the ones the CLI
  writes to its log file, so an orchestrator can tell why a pipe went `disconnected`.
- The SDK's types declare `on`, `once` and `off` themselves instead of extending Node's
  `EventEmitter`, so they do not depend on a recent `@types/node`.

Rejected: a separate `@wurmhol/sdk` package. Two packages from one codebase means two versions
that drift, and an orchestrator that installs one will want the CLI too. One package, MIT, one
changeset.

**Org tokens and a small pipes API.** A token with `scope: org` may also call, on the CLI's host
(**Departs** from ADR 0006 again):

- `GET /v1/pipes`: the org's open pipes (the wall's cards).
- `DELETE /v1/pipes/:id`: terminate, as from the wall.

Tokens already belong to an org, not a person; the console labels the scope "Can list and
close every pipe in the org". `viewers` on `openPipe` is per-pipe access from section 1.

**Webhooks: not now.** An orchestrator that opened a pipe holds its `close` event; one that
didn't can poll `/v1/pipes`. Webhooks add signing secrets, retries and a delivery log to run.
We add them when an orchestrator asks for one we can't serve this way.

## Order of work

Each is one pull request, in a stack on `main`:

1. A privacy and data page on wurmhol.com (`/privacy`), from the table above. Unblocks publishing
   Google sign-in (`TODO.md`).
2. Extract the SDK (`openPipe` from `wurmhol`); rebuild the CLI on it, behavior unchanged.
3. `wurmhol login` (device code).
4. Data minimization: invocation logs off, no IPs, Share DO tombstones, no `X-Forwarded-For`.
5. Token scopes and expiry, and the pipes API.
6. Per-pipe viewers and the view log.
7. Default lifetime and `--ttl`.
8. Retention cron.
9. Console snippet, `init`, the Claude Code plugin.
10. The Deploy to Cloudflare button, checked on a second account.

The privacy page changes with each of 4 to 8: it says what the code does, not what this ADR plans.

## Consequences

- Hosted Wurmhol keeps less: no IPs, no URLs in logs, no titles after a pipe ends, nothing older
  than 90 days except accounts, tokens and billing.
- A viewer who opens a pipe is now recorded as having opened it (time and count), which is new
  data about people; it is visible only to their org and pruned with the pipe's history.
- The CLI's host grows from two paths to `/connect`, `/health`, `/device/*` and `/v1/*`. It still
  serves nothing a browser session can use: every route there takes a bearer token or a device
  code.
- Agents can still read a pipe's traffic if they control the dev server, and the relay still
  could. That remains the stated limit; self-hosting is the answer for those who need more.
