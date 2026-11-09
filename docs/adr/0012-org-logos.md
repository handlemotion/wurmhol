# 0012: Org logos

Status: proposed. Would extend spec v1, section 3 (header menu); not built.

## Context

An org shows in the org switcher as a square avatar with its first initial. Better Auth's
organization plugin already has a `logo` column (`organizations.logo`, a URL), unused. People
asked whether owners could upload a logo, so their orgs are easier to tell apart in the switcher.

A logo upload needs somewhere to keep the image. Today Wurmhol runs on one Worker, D1, Durable
Objects and static assets (spec section 5, [self-hosting](../../apps/docs/self-hosting/index.mdx)): one Cloudflare account, two
hostnames, `wrangler deploy`. Every binding we add is one more thing every self-hoster must create
before the Worker deploys.

## Options

1. **R2 bucket.** Owners upload a PNG, JPEG or WebP (resized in the browser to 128px, at most
   ~64 KB); the Worker checks type and size, writes it to `LOGOS/<org id>`, and serves it from
   `/api/orgs/<id>/logo` to members only, with the CSP the favicon route already uses. Costs: a
   new required R2 binding (or an optional one, with logos off without it, which is one more
   configuration to test), an upload route, and deleting the object when the org goes.
2. **D1 blob.** The same small, resized image in a D1 column or table. No new binding, but it puts
   binary data in the database every request path reads, and D1 rows are capped (2 MB), so the
   size limit becomes a correctness rule rather than a cost one.
3. **A URL only.** Owners paste a logo URL into `organizations.logo`. Nothing to store, but the
   app's CSP then has to allow images from anywhere, and every member's browser fetches a
   third-party image the owner chose: an IP leak and a tracking pixel inside a product that
   promises privacy.
4. **No logos.** Keep the initial. Orgs are few per person; the name sits next to the mark.

## Proposal

**Option 4 now; option 1, with the binding optional, if people still ask after the beta.** The
switcher already names every org, so a logo is decoration, and decoration should not add a
required binding to the self-hosting path or a second storage system to the security review. If
we build it, R2 is the right store (the binary stays out of D1, and the Worker serves it like the
favicons, members only), and with no `LOGOS` binding the feature is simply off, documented in
[self-hosting docs](../../apps/docs/self-hosting/index.mdx) and `.dev.vars.example` alongside `MAIL_FROM`.

## Consequences

- Nothing changes until this is accepted.
- If option 1 is accepted: an R2 bucket in `wrangler.jsonc` (optional binding), an owner-only
  upload route, logo deletion in the org delete route, and the switcher's avatar shows the logo
  with the initial as its fallback, which the `Avatar` primitive already does.
- The plugin's `logo` field stays unset meanwhile. The plugin's own `organization/update` route
  must stay closed to browsers (orgs are renamed through the Worker's `/api/org`), so nobody can
  set it to an arbitrary URL.
