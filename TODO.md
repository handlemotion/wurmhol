# Launch to-do

Setup for hosted wurmhol.com that is still open. Code changes go through pull requests as usual;
this file lists what waits on accounts, dashboards or decisions. Delete an item when it's done.

## Billing (Stripe)

Billing stays off until `STRIPE_SECRET_KEY` is set, so every org can open pipes without a plan.

- [ ] Sandbox profile: one product with a yearly price ($12, ADR 0004), the customer portal turned
      on, and a webhook endpoint `https://dirt.wurmhol.com/api/auth/stripe/webhook` for
      `checkout.session.completed` and `customer.subscription.created`, `.updated`, `.deleted`.
- [ ] Doppler: `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in `prd_worker`;
      `WORKER_VAR_STRIPE_PRICE_YEARLY` in `prd_github` and as a Workers Builds variable.
- [ ] Repeat with live mode once the sandbox flow is checked end to end.

## Google sign-in

- [ ] A privacy policy page on wurmhol.com. Google won't publish the OAuth app without one.
- [ ] Google Cloud project `wurmhol-513804` → Branding: add the privacy policy URL, then publish
      the app. Until then it is in Testing, and only listed test users can sign in with Google.

## Pipe domain (ADR 0007)

Pipes moved to `<id>.wurmhol.dev`. Once they are verified there:

- [ ] Cancel Advanced Certificate Manager: wurmhol.com → SSL/TLS → Edge Certificates.
- [ ] Remove the `*.pipe` DNS record on wurmhol.com and the Worker route `*.pipe.wurmhol.com/*`.

## Public Suffix List

Puts `wurmhol.dev` (the pipe domain, ADR 0007) on the PSL so browsers treat every pipe as its own
site. Wurmhol's own cookies are `__Host-` cookies and don't need it, but until it lands, a page
served through one pipe can set a cookie for `wurmhol.dev` that other pipes receive.

The entry is committed on `handlemotion/list`, branch `add-wurmhol`, and the pull request is
held.

- [ ] Change the entry on `add-wurmhol` from `pipe.wurmhol.com` to `wurmhol.dev`.

The PSL maintainers expect, before they accept a private entry:

- [ ] More than two years of registration left: renew `wurmhol.dev` (Cloudflare Registrar) for
      several years before filing. It is registered for one.
- [ ] An established user base (their guidelines say roughly 2,000–3,000 distinct users).
- [ ] A role contact address, such as `security@wurmhol.com` (Cloudflare Email Routing can forward
      it). Update the "Submitted by" line on the branch to match.
- [ ] A public abuse and security contact page on wurmhol.com (`SECURITY.md` has the content).
- [ ] Then open the pull request from `add-wurmhol` with their template, and add the TXT record
      `_psl.wurmhol.dev` with the pull request's URL as its value.

## Small things

- [ ] Marketing site: an `og:image` for link previews.
- [ ] `packages/cli/package.json`: `bin` as `dist/cli.js` (no `./`), which silences npm's
      "script name was invalid" publish warning. Ride along with the next CLI change.
