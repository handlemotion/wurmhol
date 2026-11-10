---
"wurmhol": minor
---

Custom domains: put your own hostname on a pipe name. `wurmhol domain add preview.acme.dev --name acme-app` prints the two DNS records to publish, `verify --wait` follows it to active, and `domains()` from the package does the same from code. Needs an install with custom domains on and a token that can list and close every pipe.
