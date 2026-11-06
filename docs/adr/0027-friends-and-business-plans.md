# 0027: Friends and Business plans, each with a 14-day trial

Status: accepted. Supersedes ADR 0004 ($12 a year per org, one plan, no trial). Departs from spec
v1 section 4 (pricing).

## Context

ADR 0004 sold one plan to every org: $12 a year, bought before the first pipe. That is a fair
price for one person, does nothing for a business, and with no trial nobody sees a pipe work
before paying. What it found about cost still holds:

- **Cost follows requests.** About $0.66 per million viewer requests on Workers Paid. An open,
  idle pipe costs nothing (its socket hibernates), bandwidth is free on Workers, and members cost
  nothing. A typical org costs about $0.09 a month.
- **Stripe takes $0.30 a charge**, which turns any small monthly price mostly into fees.

So limits on pipes or members protect nothing; a limit on requests does. Developers now run many
agents at once, each opening its own pipe, so a low cap on open pipes only gets in their way.

Every viewer of a pipe is a member of its org (the Share object checks on every request), so a
price per seat would charge for every client invited to look at a preview.

## Decision

Two plans per org, both always paid, both starting with a 14-day trial:

| Per org            | Friends          | Business                                   |
| ------------------ | ---------------- | ------------------------------------------ |
| For                | People sharing   | Developers building Wurmhol into their own |
| Price              | $15 a year       | $20 a month, 10 M requests included        |
| Past that          | Stops at the cap | $1.50 per million requests, metered        |
| Viewer requests    | 2 M a month      | Up to the org's spend cap ($100 default)   |
| Open pipes at once | 25               | 500 (fair use, against abuse only)         |
| Members            | 10               | Any number                                 |
| Traffic            | 100 GB a month   | 10 TB a month (fair use)                   |

- **Friends' 2 M requests is where $15 a year still covers the worst case**: about $1.17 a month
  after fees against about $1.32 of requests. A typical person uses about a fifteenth of it.
- **Business is a base price plus metered requests, not credits.** Credits need a balance, top-ups,
  expiry and an "out of credit" state; a meter is one Stripe price and one invoice a month, and it
  scales without a tier change. $1.50 a million is more than twice our cost.
- **A spend cap per Business org**, set by its owners, $100 a month by default (base included),
  from $20 to $100,000. It becomes a request limit: `BUSINESS_INCLUDED_REQUESTS` plus what the cap
  above `BUSINESS_BASE_CENTS` buys at `BUSINESS_CENTS_PER_MILLION`. Reaching it ends the org's
  pipes and refuses new ones, as every request or byte limit does. A new cap applies at once,
  to open pipes too. A runaway agent can't run up a bill.
- **The trial takes a card up front** and Stripe charges it when the trial ends. A trial costs
  about $0.05 of usage; the risk is abuse (a pipe is a public HTTPS URL), and a card is the
  cheapest deterrent. One trial per org (Better Auth's Stripe plugin checks the org's past
  subscriptions). Stripe bills no usage during a trial, so Business's trial stops at its included
  10 M requests.
- **Business's usage window is its Stripe billing period**, so the spend cap counts what Stripe
  bills. Friends' window is the calendar month (UTC).
- **Moving between plans is cancel, then start the other.** Stripe's customer portal cannot switch
  a subscription that has a metered price, so it is set to cancel at once with the unused time
  credited to the customer, which the next plan's first invoice uses.

### Counting each request once

What is billed must match what was served, so usage moves in steps that can be retried without
counting twice:

1. **Share object → Org object.** A share's usage goes in numbered batches, one send at a time.
   A batch is stored before it is sent and deleted once the Org object has it; a failed send goes
   again with the same number. The Org object keeps each share's last applied number and ignores a
   batch it has already applied.
2. **Org object → Stripe.** A Business org's requests are added to a stored per-customer,
   per-window queue. The Org object's alarm moves one queue entry at a time into an outbox under a
   new identifier, then sends it as a meter event (`wurmhol_requests`). The event leaves the outbox
   only once Stripe has it; a retry reuses the identifier, which Stripe holds unique for at least
   24 hours (a duplicate counts as delivered). Sends run one at a time, since Stripe refuses
   concurrent events for one customer. Retries back off to an hour and stop after 20 hours, before
   the identifier could be reused: billing a request twice is worse than missing one, and the drop
   is logged as an error.
3. **Each event carries the time of its last request**, so a request made just before a billing
   period ends is billed in that period.

## Consequences

- Plan limits are code (`PLAN_LIMITS` in `@wurmhol/auth`); prices are Stripe's, and the Worker
  knows their ids (`STRIPE_PRICE_FRIENDS`, `STRIPE_PRICE_BUSINESS`,
  `STRIPE_PRICE_BUSINESS_REQUESTS`) and Business's three amounts, which must match the Stripe
  prices. Self-hosting with billing off is unchanged: the `LIMIT_*` variables apply.
- An integrator's own users still have to be org members to open a pipe. Viewing without
  membership is a separate feature.
- Each new org gets its own trial, so one person could trial several orgs, each with a card.
- These caps come from list prices and a cost model, not measured traffic: hosted Wurmhol has had
  no paying orgs yet. Revisit them once real orgs show requests a month.
