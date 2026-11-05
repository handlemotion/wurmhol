# 0019: Create from this computer logs in with a setup code

Status: accepted. Amends ADR 0018 (the Create pipe card's steps) and ADR 0008 (`wurmhol login`).

## Context

ADR 0018's card had three steps: run `npx wurmhol host`, approve it at the link it prints, pick a
port. With no token, `wurmhol host` ran the device-code login, so the person copied a command from
the browser, then copied a link from the terminal back to the browser, to approve a request the
browser had in effect just asked for. The person at the card is already signed in, in the org the
computer should join.

Two ways to keep the approval in the card:

- **Show the pending request with an Approve button.** The CLI starts a device code as today and
  the card lists it. The card cannot tell which pending code is this computer's: any code started
  anywhere (a phishing prompt, say) would show up beside it, and approving the wrong one hands a
  stranger a token. Telling them apart needs the user code anyway, which is the step we want gone.
- **Put a code in the command.** The card asks for a short-lived, single-use code already approved
  for the signed-in member, and the command it copies carries it. The CLI redeems it once for a
  login token named after the computer. No request exists for anyone else to slip in, and there is
  no approval step at all.

## Decision

- **A setup code is a device code issued approved.** `POST /api/device/setup` (a member of the
  active org, rate limited like other manage calls) asks Better Auth's device-authorization plugin
  for a code with scope `org:<active org>` and no name, claims and approves it as the caller in the
  same request, and answers `{ code, expires_in }` with the device code. The plugin keeps the
  expiry (30 minutes), the polling rules and the single redemption; nothing new is stored.
- **The card copies `npx wurmhol host --code <code>`.** It mints a fresh code each time the steps
  open while no computer is connected, again before it expires, and drops it from memory once the
  steps close. The steps are two: run the command, pick a port.
- **The CLI redeems it on `/device/token`**, the endpoint `wurmhol login` polls, sending the
  computer's name with the code because a setup code has none. A name already on the code wins.
  The token is the same as a login's: org scope `pipes`, 90 days, owned by the member who minted the
  code, saved where `wurmhol login` saves it. With `--code`, that token wins over `WURMHOL_TOKEN`
  and a saved one: the code names the org the person is looking at.
- **A used or expired code says what to do:** copy the command again from Create pipe.
- **`wurmhol login` and `wurmhol host` without `--code` are unchanged.**

## Consequences

- The device code becomes a bearer credential on the clipboard and in shell history until it is
  redeemed or expires: whoever runs it first, within 30 minutes, gets a token as the person who
  copied it. That is the same exposure as making a token on the Tokens page and pasting it, for a
  shorter time, and once redeemed the code is worthless.
- Every open of the steps mints a code; unused ones expire on their own.
- Self-hosted installs get it with the deploy: no new binding or variable.
