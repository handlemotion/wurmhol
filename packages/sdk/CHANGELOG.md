# @wurmhol/sdk

## 0.3.0

### Minor Changes

- 2aa8314: Custom domains: put your own hostname on a pipe name. `wurmhol domain add preview.acme.dev --name acme-app` prints the two DNS records to publish, `verify --wait` follows it to active, and `domains()` (or `wurmhol.domains` on a `Wurmhol` client) does the same from code, with a `signal` on every call. Needs an install with custom domains on and a token that can list and close every pipe. The experimental `PipeDomain` type and the `pending_dns`-style `DomainState` values are replaced by `Domain` and its states (`pending`, `verifying`, `active`, `failed`). `wurmhol stop` and `wurmhol logs` find a named pipe by its name even when its URL is a custom domain.

## 0.2.0

### Minor Changes

- 0a9e319: Embedded tunnels (ADR 0032): `WurmholEmbed` (also `@wurmhol/sdk/embed`) lets a SaaS backend make tenants, subjects and private tunnels for its own users with an integration key, and issue and revoke their grants; `grantHeaders` sends a program's grant; and `tunnelSocket` (also `@wurmhol/sdk/browser`, no Node APIs) opens a page's WebSocket to a tunnel with its grant and renews it when it expires. `openPipe`, `keepOpen` and `wurmhol <port>` accept a tunnel's connector (`whc_…`) as the token, which opens that one tunnel and refuses a name, viewers or an access key.
