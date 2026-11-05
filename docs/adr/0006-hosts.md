# 0006: dirt for the console, api for the CLI, the apex for marketing

Status: accepted. Departs from spec v1 section 5 ("Domains"), which serves the app, the API and
`/connect` all at `wurmhol.com`.

## Decision

| Host                 | Serves                                                     | Runs on                           |
| -------------------- | ---------------------------------------------------------- | --------------------------------- |
| `wurmhol.com`        | The marketing site                                         | `apps/site` (its own Worker)      |
| `dirt.wurmhol.com`   | The console: sign-in, the pipes wall, its API, `/open`     | `apps/worker` (`BETTER_AUTH_URL`) |
| `app.wurmhol.com`    | A 301 to the same path on `dirt.wurmhol.com`               | `apps/worker` (`APP_ALIASES`)     |
| `api.wurmhol.com`    | What the CLI dials: `/connect` and `/health`, nothing else | `apps/worker` (`CONNECT_HOST`)    |
| `*.pipe.wurmhol.com` | Pipes (ADR 0003)                                           | `apps/worker` (`SHARE_DOMAIN`)    |

- **dirt**: worms live in it. `app` stays as the obvious name people type, and redirects.
- **The console's API stays on the console's host.** Its session cookies are `__Host-` cookies
  (spec section 4): locked to one host, sent only same-site. Serving the API from `api.` would
  need cross-site cookies and CORS, which is the isolation the spec buys with the Public Suffix
  List. The CLI authenticates with a bearer token, not a cookie, so it alone moves to `api.`.
- `CONNECT_HOST` answers nothing but `/connect` and `/health`, so no part of the app is
  reachable on it.

## Consequences

- A sandbox with a Limited network policy allowlists one host: `api.wurmhol.com`. The CLI's
  "proxy refused" error names only that host; pipes are opened from people's devices, not from
  the sandbox.
- OAuth callbacks and the passkey relying party are `dirt.wurmhol.com`.
- Self-hosting works with a single host: leave `CONNECT_HOST` and `APP_ALIASES` empty and point
  `WURMHOL_URL` at the app.
