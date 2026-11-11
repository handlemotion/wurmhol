---
"wurmhol": minor
"@wurmhol/sdk": minor
---

Custom domains: put your own hostname on a pipe name. `wurmhol domain add preview.acme.dev --name acme-app` prints the two DNS records to publish, `verify --wait` follows it to active, and `domains()` (or `wurmhol.domains` on a `Wurmhol` client) does the same from code, with a `signal` on every call. Needs an install with custom domains on and a token that can list and close every pipe. The experimental `PipeDomain` type and the `pending_dns`-style `DomainState` values are replaced by `Domain` and its states (`pending`, `verifying`, `active`, `failed`). `wurmhol stop` and `wurmhol logs` find a named pipe by its name even when its URL is a custom domain.
