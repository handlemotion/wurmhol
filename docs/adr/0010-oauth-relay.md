# 0010: One OAuth redirect URI for every pipe, through a relay

Status: accepted. Extends ADR 0009 (named pipes). Departs from spec v1 section 5 (a new kind of
host, the relay) and, narrowly, from the rule that pipe traffic is never recorded: the relay
keeps a hash of one query parameter of one response header, for minutes.

## Context

OAuth providers redirect only to URIs registered ahead of time. Named pipes give each name a
stable host, so one pipe of an app can sign in. Several pipes of the same app at once (parallel
agents, one per branch) still need one registered URI per name, and a GitHub OAuth App allows
exactly one callback URL, matched on its host: it cannot serve two pipes at all.

What we want: register one redirect URI per provider, once, and have it work for any number of
pipes, named or not, without changing how the app does OAuth.

## Decision

- **A relay host**, `OAUTH_RELAY_HOST` (`oauth.wurmhol.dev` on wurmhol.com; empty, the default,
  turns it off). Same scheme and port as `BETTER_AUTH_URL`. Under `SHARE_DOMAIN` it must be one
  label that is not shaped like a share id, and that label is reserved: `--name oauth` is
  refused. The pipe domain's wildcard record, route and certificate already cover it.
- **The app registers the relay.** Redirect URI = relay origin + the app's own callback path
  (`https://oauth.wurmhol.dev/api/auth/callback/google`). For a GitHub OAuth App, the relay
  origin: GitHub accepts any path under the registered one.
- **Recording, from headers only.** When a pipe's response carries a `Location` whose
  `redirect_uri` is on the relay's origin, the Worker records that URL's `state` against the
  pipe. Any status counts, not only 3xx: Better Auth's `signIn.social` answers 200 with the
  provider URL in the body _and_ in `Location`. Response bodies are never read for this.
- **The store is D1**, `oauth_states`: SHA-256 of the state (primary key), `org_id`, `share_id`
  and an expiry 10 minutes out. Insert-if-absent, so the first pipe to record a state keeps it.
  Rejected: a Durable Object. The lookup arrives on the relay's host with nothing but the state,
  so it would need one global object, a single point every sign-in goes through; D1's indexed
  read and delete is one round trip, and the daily retention job prunes leftovers.
- **The callback.** `GET <relay>/<path>?<query>` takes the state's row (deleted in the same
  statement, so it works once), checks the pipe is still open, and answers 302 to
  `<that pipe's origin><path>?<query>`, unchanged. From there the pipe's own viewer sign-in
  (spec section 6) applies: only a signed-in member of the pipe's org gets the request through.
  An unknown, used or expired state gets a plain page: "This sign-in has expired or was already
  used." An ended pipe: "This pipe has ended."
- **`response_mode=form_post` is out of scope.** The provider's POST to the relay is cross-site,
  so after a 307 it reaches the pipe without the SameSite=Lax share cookie and the pipe refuses
  it. Making it work would mean a cross-site share cookie or reading the form body; neither is
  worth it before someone asks. The relay answers non-GET with 405.
- **Never logged or stored:** the code, tokens, the URLs, bodies. Log lines carry the share and
  org ids only (`oauth.recorded`, `oauth.relayed`, `oauth.unknown`, `oauth.ended`).
- **Membership on the relay route.** It reads `oauth_states` without a signed-in caller: the
  browser arrives from the provider. That is the same exception as a named pipe's host lookup
  (ADR 0009): the route reveals nothing but a redirect to a pipe host, which checks membership
  itself.

## Threats

| Threat                                           | Why it fails                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guessing a state                                 | States are the app's own random values. A correct guess only sends the guesser's own browser to the pipe, where they must sign in as a member, carrying no code but their own.                                                                                                                                                                     |
| Replaying a callback URL (history, logs, shared) | The row is deleted on first use; a second visit gets the error page.                                                                                                                                                                                                                                                                               |
| Another pipe claiming a state                    | Insert-if-absent: the first record wins. A state is made when its flow starts, so another pipe cannot know it in time to record it first.                                                                                                                                                                                                          |
| A member of another org                          | The relay sends the browser to the recording pipe, where the share cookie and membership check apply. A foreign viewer is sent to sign in; the code never reaches the dev server.                                                                                                                                                                  |
| Another org's app starting a flow on your client | Client ids are public, so another org's pipe can send someone to your provider with `redirect_uri` on the relay and its own state. The callback then goes to _that_ org's pipe, which only its members can open, and a confidential client's code is useless without your client secret. Per-org relay paths would close it fully; not needed yet. |
| An ended or replaced pipe                        | The state names the share id, not the host. If that pipe ended, even with its name reopened by a new pipe, the relay answers "This pipe has ended."                                                                                                                                                                                                |
| An open redirect through the path                | The target is the pipe's origin with the path appended as a string, never resolved against it: `//evil.example/x` stays a path on the pipe's host.                                                                                                                                                                                                 |
| The relay as a free redirector                   | It only ever redirects to a pipe host that recorded the state.                                                                                                                                                                                                                                                                                     |

## Consequences

- An app opts in by pointing its redirect URI at the relay. Apps that don't are unaffected,
  except that responses with such a `Location` cost one D1 write.
- Apps that hand the browser the provider URL only in a body (some SPA flows) are not covered;
  sending a redirect or a `Location` header is the fix.
- One relay is shared by every org on wurmhol.com, with the trade-off in the threats table.
  Self-hosters get their own.
- The privacy page lists the new row: a state's hash and its pipe, for at most 10 minutes.
