# Launch to-do

Outstanding hosted setup that needs accounts, dashboards, or decisions. Code changes go
through pull requests; operational procedures live in [Operations](docs/operations/doppler.md).
Verify external account state before acting, and delete an item when it is done.

## Google sign-in

- [ ] Google Cloud project `wurmhol-513804` → Branding: use
      `https://wurmhol.com/privacy` as the privacy policy URL, then publish the OAuth app.
      Verify its current publishing status; Testing restricts sign-in to listed test users.

## Pipe domain (ADR 0007)

After verifying pipes at `<id>.wurmhol.dev`, check whether these old resources remain before
removing or cancelling anything:

- [ ] Cancel Advanced Certificate Manager on wurmhol.com if no remaining hostname needs it.
- [ ] Remove the `*.pipe` DNS record and the Worker route `*.pipe.wurmhol.com/*` if still present.

## Public Suffix List

Put `wurmhol.dev` on the PSL so browsers treat every pipe as its own site. Wurmhol's own
`__Host-` cookies do not need it, but without the entry a page on one pipe can set a cookie
for the domain that other pipes receive.

Review the existing work on `handlemotion/list`, branch `add-wurmhol`, before submitting.
The PSL maintainers expect an established user base, a long enough domain registration, and
a role contact address:

- [ ] Ensure the entry uses `wurmhol.dev`, not `pipe.wurmhol.com`.
- [ ] Ensure more than two years of registration remain on `wurmhol.dev`.
- [ ] Confirm the project meets the maintainers' current established-use guidelines.
- [ ] Set up a role address such as `security@wurmhol.com`, and use it in "Submitted by".
- [ ] Open the pull request with the current PSL template, then set `_psl.wurmhol.dev` TXT
      to that pull request's URL.

The public [security page](apps/site/src/pages/security.astro) and
[privacy policy](apps/site/src/pages/privacy.astro) are implemented; keep their details current.
