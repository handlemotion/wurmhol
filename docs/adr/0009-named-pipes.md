# 0009: Named pipes keep their URL

Status: accepted. Departs from spec v1 section 2 ("A new URL for every share, dead when the share
ends") for pipes opened with a name. Pipes without one are unchanged.

## Context

OAuth providers (Google, GitHub and the rest) redirect only to URIs registered ahead of time. A
pipe's URL is random and new every time, so an app that signs in with OAuth can't be tried
through a pipe: each run would need a new redirect URI registered by hand, and some providers take
minutes to accept one. Local tools solve this with stable names (`portless`, `ngrok --domain`);
Wurmhol needs the same, without giving up "only the org's members get in".

## Decision

- `wurmhol <port> --name my-app` (and `openPipe({ name })`) opens the pipe at
  `my-app.<SHARE_DOMAIN>`. Reopened with the same name, it gets the same URL, so a redirect URI
  like `https://my-app.wurmhol.dev/api/auth/callback/google` is registered once.
- **A name belongs to the first org that uses it** (`pipe_names`), for good. Another org asking
  for it is refused. That keeps a host an OAuth provider trusts for one org from ever serving
  another org's app.
- **One open pipe per name** (a unique index on open shares' names). A second one is refused with
  the fix `wurmhol stop <name>`; it never takes the host over silently.
- Every pipe keeps its own random id, Durable Object and history row. The name is only the host:
  a request to `<name>.<SHARE_DOMAIN>` looks up the name's open share in D1 and is handled as a
  request to that share. With none open, it gets "This pipe has ended."
- Viewer sign-in is unchanged (spec section 6). The share cookie names the share id, so a cookie
  from an earlier pipe of the same name doesn't open the next one: the viewer goes through `/open`
  again, which is one redirect when they are signed in to the console.
- Names are one DNS label of 3 to 40 lowercase letters, digits and hyphens, starting with a
  letter, never `--`, and never 10 letters and digits alone (the shape of a random id, so the two
  never collide). `@wurmhol/protocol`'s `pipeName` is the one check, used by the CLI and the
  Worker.

## Consequences

- A request to a named host costs one indexed D1 read before the Share Durable Object. Random-id
  hosts don't pay it.
- Names are first come, first served on wurmhol.com, and there is no way yet to release one but
  deleting the org. If squatting or releases become a problem, add them then.
- The wall shows a named pipe's URL like any other; it comes from the same `shareOrigin`.
- Nothing new to configure: self-hosted installs get named pipes with the same `SHARE_DOMAIN`.
