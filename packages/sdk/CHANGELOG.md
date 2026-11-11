# @wurmhol/sdk

## 0.2.0

### Minor Changes

- 0a9e319: Embedded tunnels (ADR 0032): `WurmholEmbed` (also `@wurmhol/sdk/embed`) lets a SaaS backend make tenants, subjects and private tunnels for its own users with an integration key, and issue and revoke their grants; `grantHeaders` sends a program's grant; and `tunnelSocket` (also `@wurmhol/sdk/browser`, no Node APIs) opens a page's WebSocket to a tunnel with its grant and renews it when it expires. `openPipe`, `keepOpen` and `wurmhol <port>` accept a tunnel's connector (`whc_…`) as the token, which opens that one tunnel and refuses a name, viewers or an access key.
