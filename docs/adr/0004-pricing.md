# 0004: $12 a year per org, bought up front, no trial

Status: accepted. Departs from spec v1 section 4 ($3 a month or $30 a year, 7-day trial) and
answers open questions 3 (per org) and 5 (no trial, no free tier) for v1.

## What one org costs us

Cloudflare list prices on Workers Paid, past each included allowance (Workers: 10 M requests,
30 M CPU-ms; Durable Objects: 1 M requests, 400,000 GB-s), checked November 2026:

| Driver                      | Unit price                                 | Per viewer request       |
| --------------------------- | ------------------------------------------ | ------------------------ |
| Worker request              | $0.30 / M                                  | 1 request                |
| Durable Object requests     | $0.15 / M                                  | 2 (`status`, `fetch`)    |
| CLI → DO WebSocket messages | billed 20:1 as requests                    | ~3 frames ≈ 0.15 request |
| CPU (Worker and DO)         | $0.02 / M CPU-ms                           | ~2 ms                    |
| DO duration                 | $12.50 / M GB-s at 128 MB, only while busy | idle pipes hibernate: $0 |
| Bandwidth                   | $0 (no egress fees on Workers)             |                          |
| D1, Email Service sign-ins  | within the included allowances             |                          |

So about **$0.66 per million viewer requests**, and nothing for an idle pipe: the CLI's
heartbeat is answered by the runtime without waking the Durable Object (ADR 0002), and an open
Vite hot-reload socket hibernates too. Duration only accrues while requests are in flight:
about 2 s per page load, or 0.25 GB-s, which is $0.000003.

| Org                                                           | Requests / month | Cost / month |
| ------------------------------------------------------------- | ---------------- | ------------ |
| Typical: 20 page loads a day × ~300 requests (unbundled Vite) | ~130 k           | ~$0.09       |
| Heavy: 5 pipes, agents and people all day                     | ~1 M             | ~$0.66       |

Fixed: Workers Paid $5 and the two domains, `wurmhol.com` and `wurmhol.dev`, about $1.50 a month
together, so about **$6.50 a month** whatever the number of orgs. Pipes on their own domain need no
Advanced Certificate Manager (ADR 0007).

## What a charge costs

Stripe, US card: 2.9% + $0.30 per charge, plus Stripe Billing's 0.7% of recurring volume.

| Price          | Fees per charge | Kept per month |
| -------------- | --------------- | -------------- |
| $1 a month     | $0.34 (34%)     | $0.66          |
| $3 a month     | $0.41 (14%)     | $2.59          |
| **$12 a year** | **$0.73 (6%)**  | **$0.94**      |
| $30 a year     | $1.38 (5%)      | $2.39          |

The $0.30 floor makes any cheap monthly price mostly fees.

## Decision

- **One plan: $12 a year per org, yearly only.** It is the cheapest price where fees stay small,
  it covers a heavy org's usage about 1.4 times, and a typical org's about 10 times.
  Break-even on the fixed costs is about 8 paying orgs.
- **Per org, not per member.** Cost follows traffic, not seats, and one charge per org keeps
  the $0.30 floor paid once.
- **No trial and no free tier in v1.** A new org subscribes before its first pipe; until then
  `/connect` refuses with "no plan yet" and the wall shows a Subscribe button to owners. Nothing
  free means nothing to abuse while the beta measures real use.
- Prices live in Stripe; the Worker only knows their ids (`STRIPE_PRICE_YEARLY`, and an
  optional `STRIPE_PRICE_MONTHLY` that stays unset on hosted Wurmhol).

## Risks and follow-ups

- Requests are not capped, only active pipes and bytes. One org at 10 M requests a month would
  cost ~$6.60, more than it pays. If the beta shows that happening, add a monthly request limit
  beside `LIMIT_MONTHLY_BYTES` in the Org Durable Object.
- International cards add 1.5% and currency conversion 1%; sales tax, if collected, is extra.
- Each viewer request makes two Durable Object calls; folding `status` into `fetch` would cut
  the per-request cost by about a quarter.
