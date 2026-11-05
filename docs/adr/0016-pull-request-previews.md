# 0016: Pipes post themselves to their pull request, through a GitHub App

Status: accepted. Builds on ADR 0015 (a pipe's source). New: Wurmhol calls GitHub's API, only
for orgs that link a GitHub account, and only when an install sets up a GitHub App.

## Context

An agent opens a pipe, pushes its branch and opens a pull request. The reviewer is on the pull
request, not on the wall, and the pipe URL lives in the agent's chat. Hosting platforms solve this
with a "View deployment" button on the pull request; GitHub's Deployments API gives any tool that
button.

## Decision

- **A GitHub App**, configured by env vars (`GITHUB_APP_ID`, `GITHUB_APP_SLUG`,
  `GITHUB_APP_CLIENT_ID`; secrets `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_SECRET`,
  `GITHUB_APP_WEBHOOK_SECRET`; `GITHUB_API_URL`/`GITHUB_WEB_URL` for Enterprise Server), validated
  with zod: all or none. With none, nothing talks to GitHub and the wall shows no new row.
  Rejected: an OAuth App or a personal token per org. Their tokens act as a person, across every
  repo that person can reach; an App installation is limited to the repos it is installed on,
  with only the permissions it asks for (Deployments write, Pull requests read, Metadata read).
- **Linking.** An org owner presses **Connect GitHub** on a pipe card (shown when the pipe's repo
  is on GitHub and no installation of its owner is linked). That opens GitHub's install page;
  GitHub's Setup URL sends them back to `/api/github/setup`, which asks them to authorize the App
  as themselves (a signed state names org, person and installation, for 10 minutes), and
  `/api/github/callback` links the installation only if `GET /user/installations` shows it to
  that person. Installation ids are small, guessable numbers; an id alone links nothing.
  `github_installations` holds org, installation id, account name and who linked it.
- **Posting.** When a pipe with a GitHub source starts, its Share Durable Object finds the org's
  installation on the repo owner's account, lists open pull requests with
  `head=<owner>:<branch>`, and if one exists creates a deployment of its head commit to the
  environment `wurmhol-preview` (transient, not production), with a `success` status whose
  `environment_url` is the pipe URL and `auto_inactive: false`, so parallel pipes of one repo
  don't retire each other. The card gets a **Pull request** row: `#12 ↗`.
- **A pull request opened later.** The App's `pull_request` webhook (opened, reopened, ready for
  review), signed with the webhook secret, finds open pipes of that repo and branch whose org
  linked the sending installation, and asks each to post itself. A pipe posts once.
- **Ending.** When a pipe ends, for any reason, its deployment gets an `inactive` status: GitHub
  hides its button. If posting finishes after the pipe ended, the deployment is retired at once.
- **The key as GitHub gives it.** GitHub downloads App keys as PKCS#1; Web Crypto imports only
  PKCS#8. The Worker wraps a PKCS#1 key in the PKCS#8 envelope itself, so the `.pem` is pasted
  as is. App JWTs are signed by `universal-github-app-jwt`.
- **Failures never touch the pipe.** GitHub errors are logged (`share.preview_failed`, with ids
  only) and the pipe works as before. GitHub's error bodies are not kept.
- **Uninstalling** the App (the `installation` `deleted` webhook) unlinks it from every org.

## Threats

| Threat                                                   | Why it fails, or what it costs                                                                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| An org links another account's installation              | Linking needs a GitHub user who can see the installation, proven by GitHub, not by the URL.                                         |
| A forged webhook                                         | HMAC-SHA256 over the raw body with the webhook secret, compared in constant time; unsigned or wrong calls get 401 and do nothing.   |
| A token holder in the org posts a URL to the org's repos | Any pipe of a linked org can post its own pipe URL to a matching PR. That is the feature; the URL only opens for the org's members. |
| A pipe claims another org's repo                         | It posts only through installations its own org linked; GitHub refuses tokens for repos outside an installation.                    |

## Consequences

- Hosted wurmhol.com needs its App created once (a dashboard step) and its credentials in
  Doppler `prd_worker`; until then the feature is off there.
- A fork's pull request into another repo is not matched: the pipe's repo is the fork's.
- On GitHub Enterprise Server the card's Connect link shows only for `github.com` repos; GHES
  installs link from `/api/github/install` directly.
