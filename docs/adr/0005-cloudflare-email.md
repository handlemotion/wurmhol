# 0005: Magic links through Cloudflare Email Service

Status: accepted. Answers spec v1 open question 4.

## Decision

Sign-in mail goes out through Cloudflare Email Service's `send_email` Worker binding
(`env.EMAIL.send()`), from `MAIL_FROM` on a domain onboarded under Email Service → Email Sending.
The domain is bought and served on Cloudflare, so there is no other vendor and no API key: the
binding is the credential.

- Magic links are on whenever `MAIL_FROM` is set, beside passkeys, Google and GitHub.
  Development and test also turn them on without a sender and log the link instead.
- Each address gets 5 links per 15 minutes (`RATE_LIMIT_MAGIC_LINK`), on top of the per-IP
  sign-in limit, so nobody can mail-bomb an inbox through us.
- `wrangler dev` simulates the binding and writes each email to a file. The e2e suite signs in
  from that email's text.

## Consequences

- Email Sending needs Workers Paid: 3,000 emails a month are included, then $0.35 per 1,000.
  Sign-in mail stays inside that for a long time.
- Self-hosters onboard their own domain or leave `MAIL_FROM` empty and sign in with passkeys or
  OAuth.
