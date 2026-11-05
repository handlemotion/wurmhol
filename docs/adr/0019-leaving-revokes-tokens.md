# 0019: Leaving an org revokes the tokens you made there

Status: accepted. Extends spec v1 section 3 (Members: remove) and section 6 (Token leaked), and
ADR 0018 (machines).

## Context

Removing a member deleted their membership row and nothing else. Their tokens stayed live, so
their open pipes stayed on the org's wall, `wurmhol <port>` went on opening new ones, and
`wurmhol host` stayed connected. Removing someone is how an owner cuts off their access, and it
did not.

## Decision

- **Removing a member, or leaving, revokes every live token that person made in that org.** It
  takes the same path as revoking one token from the Tokens list: their open pipes end with
  `revoked` and their machines disconnect. The CLI says why and stops.
- **A token works only while its maker is a member of its org.** Every bearer-authenticated
  route (`/connect`, `/host`, the pipes API) checks it, so a token used in the moment between
  leaving and revocation is refused too. A token whose maker deleted their account (no maker)
  keeps the behaviour it had.
- **Rejoining does not bring old tokens back.** Revoked is final; the person makes new ones.
- **Deleting an org** deletes its tokens with it, ends its open pipes, and disconnects its
  machines.

## Consequences

- A CI or orchestrator token made by someone who later leaves stops working. Whoever stays makes
  a new one. Revoked tokens leave the Tokens list, so an owner sees what went.
- One more D1 read on each bearer-authenticated request (the maker's membership).
