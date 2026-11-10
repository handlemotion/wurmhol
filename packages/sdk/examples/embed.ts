// A small app that embeds Wurmhol: opens a pipe to a local port, keeps it open, and prints one
// JSON line per event. Runs on Node 22+ (`node examples/embed.ts`) and on Bun, and compiles to a
// single binary (`bun build --compile examples/embed.ts --outfile embed`); the repository's e2e
// does exactly that and drives the binary. In your own app, import from "@wurmhol/sdk".
//
//   WURMHOL_TOKEN=wh_… PORT=5173 node examples/embed.ts
//
// Environment: WURMHOL_TOKEN (required), PORT (the local server's port, required), WURMHOL_URL
// (a self-hosted install), PIPE_NAME (a URL that stays the same), ACCESS_KEY (lets a client with no
// browser session in), PIPE_TTL (e.g. "2h").
import { FixError, Wurmhol } from "../src/index.ts";

const out = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, ...fields }));

const wurmhol = new Wurmhol({
  server: process.env.WURMHOL_URL,
  token: process.env.WURMHOL_TOKEN,
  client: { name: "embed-example", version: "1.0.0" },
});

const pipe = wurmhol.pipes.keepOpen({
  port: Number(process.env.PORT),
  name: process.env.PIPE_NAME,
  accessKey: process.env.ACCESS_KEY,
  ttl: process.env.PIPE_TTL,
  // A short wait between attempts keeps the example quick to try; the defaults suit an app.
  reopen: { initialDelayMs: 200, maxDelayMs: 2000 },
});

pipe.on("open", ({ url, id, reopened }) => out("open", { url, id, reopened }));
pipe.on("reopening", ({ attempt, delayMs, reason }) =>
  out("reopening", { attempt, delayMs, reason }),
);
pipe.on("disconnected", ({ code }) => out("disconnected", { code }));
pipe.on("reconnected", () => out("reconnected"));
pipe.on("request", ({ method, path, status }) => out("request", { method, path, status }));
pipe.on("closed", ({ reason, error }) => {
  out("closed", { reason, code: error?.code });
  // Nothing is left running once the pipe has closed, so the process ends by itself.
  process.exitCode = error ? 3 : 0;
});

pipe.ready().catch((error: unknown) => {
  out("error", { code: error instanceof FixError ? error.code : "error", message: String(error) });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void pipe.close());
}
