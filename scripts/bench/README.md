# Bench

Measures a pipe end to end on the real local stack: the Worker under `wrangler dev` with local
D1 and Durable Objects, the built CLI, a real Node HTTP server, and Chromium for the Vite page.
Nothing is mocked. Each case runs several times. The report gives the median and the spread
(min–max, plus p95 where there are at least 20 samples), and puts the pipe beside the same
request made directly to the server, so the cost of the pipe reads straight off the table.

```bash
pnpm stack:serve                       # the Worker on :8787, ENVIRONMENT=development
pnpm --filter wurmhol build            # the CLI the bench runs (packages/cli/dist/cli.js)
pnpm bench                             # about 3 minutes
pnpm bench --runs 9 --small 100 --sse 600 --json out.json
```

| Flag      | Default | Means                                                                |
| --------- | ------- | -------------------------------------------------------------------- |
| `--runs`  | 5       | Repeats of each case (time to URL, 50 MB transfers, page loads, HMR) |
| `--small` | 50      | Requests per sample in the small-request and latency cases           |
| `--sse`   | 0       | Also hold an SSE stream open this many seconds and check every event |
| `--json`  |         | Write every sample to this file                                      |

`WURMHOL_BENCH_URL` points at another local stack (default `http://localhost:8787`). The bench
signs in with the magic link the Worker logs (`auth.dev_link`), so it needs a development stack.

## Cases

- **Time to URL.** `wurmhol <port> --json` from spawn to exit with the URL printed, then
  `wurmhol stop`. The spec's bar is 3 s.
- **Small request.** One GET at a time on a warm connection: time to first byte and total, then
  1 and 6 at a time (a browser's per-host connection limit) as requests per second.
- **Throughput.** A 50 MB download and a 50 MB upload of random bytes, checked by SHA-256.
- **Latency while busy.** Small GETs next to a 50 MB download that is read as it arrives, then
  next to one nobody reads (flow control must keep the stalled stream from blocking the rest).
- **SSE** (with `--sse`). One event a second; fails if any is missing or out of order.
- **Vite.** A generated vanilla Vite app with 342 modules (JS and CSS), served by the Vite in
  `apps/web` with no config. Chromium signs in through the real viewer redirects once, then each
  load runs with the cache off and counts its requests. Then a file write, timed until the DOM
  shows it, with a check that the page hot-updated and did not reload.

Numbers depend on the machine: compare runs from the same machine only, and keep other load off
it while the bench runs. Locally the Worker, its Durable Objects and D1 share one `workerd`
process, so local numbers show the relay's own cost, not the network's.
