# 0026: Personal and Team plans, each with a 14-day trial

Status: accepted. Supersedes ADR 0004 ($12 a year per org, one plan, no trial). Departs from spec
v1 section 4 (pricing).

## Context

ADR 0004 sold one plan to every org: $12 a year, bought before the first pipe. That is a fair
price for one person and too little to tell a business apart from them, and the lack of any trial
means nobody can see a pipe work before they pay. Two things from 0004 still hold:

- **Cost follows traffic, not people.** About $0.66 per million viewer requests on Workers Paid,
  and nothing for an idle pipe. A typical org costs about $0.09 a month, a heavy one about $0.66.
  Fixed cost is about $6.50 a month for the whole install (Workers Paid and two domains).
- **Stripe's $0.30 per charge** turns any monthly price under about $5 mostly into fees.

One more fact shapes seats: every viewer of a pipe is a member of its org (the Share object
checks membership on every request). A price per seat would charge a business for each client or
PM they invite to look at a preview, which works against the product.

Businesses can also run Wurmhol themselves: one Cloudflare account, Workers Paid at $5 a month,
and someone to keep it running. Team is priced against that, not against what it costs us.

## Decision

Two plans per org, both always paid, both with a 14-day trial:

| Per org                  | Personal                 | Team                                   |
| ------------------------ | ------------------------ | -------------------------------------- |
| Price                    | $12 a year (yearly only) | $15 a month, or $150 a year            |
| Members (viewers count)  | 3                        | Any number                             |
| Pipes open at once       | 3                        | 15                                     |
| Traffic                  | 25 GB a month            | 250 GB a month                         |
| Viewer requests          | 5 million a month        | 50 million a month                     |
| Kept after Stripe's fees | ~$11.27 a year           | ~$14.16 a month (~$144 a year, yearly) |

- **Flat per org, not per seat**, for the reasons above. Team's members are unlimited.
- **A 14-day trial with a card up front.** Checkout always collects a payment method, and Stripe
  charges it when the trial ends. A trial costs us about $0.05 of usage; the risk worth guarding
  is abuse (a pipe is a public HTTPS URL that could serve phishing), and a card is the cheapest
  deterrent. An org gets one trial: Better Auth's Stripe plugin offers it only when the org has
  never had a trialing subscription. Pipes work while the subscription is `trialing`.
- **A monthly request cap** beside the byte cap. ADR 0004 left requests uncapped, and at 10
  million a month a Personal org would cost more than it pays. Requests and bytes both reset on
  the 1st (UTC), and crossing either ends the org's open pipes, as the byte cap already did.
- **Members are capped at the door.** Personal refuses new invite links and invite acceptances
  at 3 members. An org that moves down from Team keeps the members it has; it cannot add more
  until it is under the cap.
- **Moving between plans and intervals happens in Stripe's customer portal**, configured with
  both products. The plugin reads the new price off the subscription webhook and the org's plan
  follows. The wall's no-plan card offers Personal and Team monthly; Team yearly is one switch
  away in the portal.
- **Plan limits live in code** (`PLAN_LIMITS` in `@wurmhol/auth`), beside the trial length. Prices
  stay in Stripe, and the Worker only knows their ids: `STRIPE_PRICE_PERSONAL`,
  `STRIPE_PRICE_TEAM_MONTHLY` and the optional `STRIPE_PRICE_TEAM_YEARLY`.
- **Billing off is unchanged** for self-hosting: with no `STRIPE_SECRET_KEY`, no org needs a plan,
  members are uncapped, and the `LIMIT_*` variables (now with `LIMIT_MONTHLY_REQUESTS`) set the
  limits.

Break-even on fixed costs is about 8 Personal orgs, or one Team org.

## Consequences

- Each new org gets its own trial, so a person could trial several orgs. Each one needs a card,
  which is the deterrent we chose; if it becomes a pattern, limit trials per user.
- Limits are taken from the plan when a pipe starts. A plan change applies to pipes started
  after it.
- International cards add 1.5% and currency conversion 1%; sales tax, if collected, is extra.
- The numbers above are list prices applied to a cost model, not measured traffic: hosted
  Wurmhol has had no paying orgs yet. Revisit the caps once real orgs show their requests a month
  and members per org.
