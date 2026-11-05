# Security policy

Wurmhol relays traffic between a developer's local server and the people they share it with, so
a security bug can expose someone's unreleased app or let a stranger in. We take reports
seriously and thank everyone who sends one.

## Reporting a vulnerability

Report privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability** ([direct link](https://github.com/handlemotion/wurmhol/security/advisories/new)).
Please do not open a public issue, pull request, or discussion for a suspected vulnerability.

Include what you can: the affected component and commit, steps to reproduce or a proof of
concept, and the impact you expect. We aim to acknowledge a report within 3 business days and to
agree a disclosure date with you once a fix is ready. We credit reporters in the advisory unless
you ask us not to.

Test only against your own self-hosted instance or the local stack (`pnpm stack:serve`). Do not
access other people's shares or data, degrade hosted Wurmhol, or run automated scans against it.

## Scope

In scope is the code in this repository, especially:

- **Share access.** Only signed-in members of the org that owns a share may reach it. Anything
  that lets a signed-out viewer, a member of another org, or a removed member load a share's
  pages is in scope, as is forging or replaying the one-time code or the `__Host-wurmhol` cookie.
- **Isolation between shares and the app.** A share's JavaScript must not read or set cookies of
  the app or another share, or act as the signed-in user on wurmhol.com.
- **Tokens.** Tokens are stored hashed and scoped to one org. Anything that reveals a token,
  lets one start shares for another org, or keeps working after revocation is in scope.
- **The relay.** Request smuggling between streams, reading another share's traffic, or using
  the relay as an open proxy.
- Authentication and authorization (Better Auth sessions, passkeys, OAuth), and any way to read
  or change another org's data.

Out of scope: vulnerabilities in Cloudflare or Stripe themselves (report those to the vendor),
what a member's own dev server does to that member, findings that need a compromised device,
missing hardening headers without a demonstrated impact, and denial of service by volume.

The relay can technically read the traffic it carries; that is stated plainly in the docs, and
request bodies are never logged or stored.

## Supported versions

Wurmhol has no tagged releases yet. Security fixes land on `main` and ship from there; hosted
Wurmhol runs `main`, and the CLI is published from it.
