// The SDK inside a compiled Bun binary (ADR 0030): the example app is compiled with
// `bun build --compile` and run as a separate process against the real stack, as an app that ships
// the SDK would. Bun's `ws` shim has no handshake response and no refusal body, and a failed
// connection there ends the process; this is what the built-in transport exists to fix.
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { WebSocketServer } from "ws";
import { z } from "zod";
import {
  api,
  browserFetch,
  browserSocket,
  createToken,
  parseJson,
  listeningPort,
  type Person,
  signIn,
  type Stack,
  startStack,
  viewerCookie,
  waitFor,
} from "./support.ts";
import { workerRoot } from "./global-setup.ts";

const bun = join(workerRoot, "node_modules/.bin/bun");
const example = join(workerRoot, "../../packages/sdk/examples/embed.ts");

let stack: Stack;
let ada: Person;
let token: string;
let dir: string;
let binary: string;

beforeAll(async () => {
  stack = await startStack();
  ada = await signIn(stack);
  token = (await createToken(stack, ada)).token;
  dir = mkdtempSync(join(tmpdir(), "wurmhol-bun-"));
  binary = join(dir, "embed");
  await promisify(execFile)(bun, ["build", "--compile", example, "--outfile", binary], {
    cwd: workerRoot,
  });
}, 120_000);

afterAll(async () => {
  await stack.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** One JSON line the app prints; each event carries its own fields beside `event`. */
const line = z.looseObject({ event: z.string() });

type Line = z.infer<typeof line>;

const opened = z.object({ url: z.string(), id: z.string() });

/** Runs the compiled app; `lines` fills as it prints, `exited` resolves with its exit code. */
function run(env: Record<string, string>) {
  const child = spawn(binary, [], {
    env: { PATH: process.env.PATH ?? "", HOME: dir, WURMHOL_URL: stack.url, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const lines: Line[] = [];
  let stderr = "";
  let pending = "";
  child.stdout.on("data", (data: Buffer) => {
    pending += data.toString();

    for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
      lines.push(parseJson(line, pending.slice(0, end)));
      pending = pending.slice(end + 1);
    }
  });
  child.stderr.on("data", (data: Buffer) => (stderr += data.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));

  const next = (event: string, after = 0) =>
    waitFor(() => lines.slice(after).find((line) => line.event === event), {
      what: `"${event}" from the binary (stderr: ${stderr.slice(0, 300)})`,
    });

  return { child, lines, exited, next, stderr: () => stderr };
}

it("opens a pipe from a compiled Bun binary, relays HTTP and WebSocket, and ends on SIGTERM", async () => {
  const http = createServer((_req, res) => res.writeHead(200).end("from bun"));
  new WebSocketServer({ server: http }).on("connection", (socket) =>
    socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary })),
  );
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = listeningPort(http);
  const app = run({ WURMHOL_TOKEN: token, PORT: String(port) });

  try {
    const { url, id } = opened.parse(await app.next("open"));
    expect(url).toBe(stack.shareUrl(id));
    const cookie = await viewerCookie(stack, ada, url);
    expect(await (await browserFetch(`${url}/x`, { cookie })).text()).toBe("from bun");
    await app.next("request");

    const viewer = browserSocket(url, [], { cookie });

    const echoed = new Promise<string>((resolve) =>
      viewer.once("message", (data: Buffer) => resolve(data.toString())),
    );

    await new Promise((resolve) => viewer.once("open", resolve));
    viewer.send("ping through bun");
    expect(await echoed).toBe("ping through bun");
    viewer.close();

    app.child.kill("SIGTERM");
    expect(await app.exited).toBe(0);
    expect(app.lines.map((l) => l.event)).toContain("closed");
    expect(app.lines.at(-1)).toMatchObject({ event: "closed", reason: "stopped" });

    const wall = (
      await api(
        stack,
        ada,
        "/api/shares",
        {},
        z.object({ shares: z.array(z.object({ id: z.string() })) }),
      )
    ).body.shares;

    expect(wall.map((s) => s.id)).not.toContain(id);
  } finally {
    app.child.kill("SIGKILL");
    http.closeAllConnections();
    http.close();
  }
});

it("reports the relay's refusal as a typed error instead of crashing", async () => {
  const app = run({ WURMHOL_TOKEN: "wh_nope", PORT: "3000" });
  const error = await app.next("error");
  expect(error).toMatchObject({ code: "refused" });
  // `closed` with an error ends the app with its own exit code, not a runtime crash.
  expect(await app.exited).toBe(3);
  expect(app.stderr()).not.toMatch(/ErrorEvent|Unhandled|panic/i);
});

it("reopens a named pipe at the same URL when its lifetime runs out", async () => {
  const http = createServer((_req, res) => res.writeHead(200).end("ok"));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = listeningPort(http);

  const app = run({
    WURMHOL_TOKEN: token,
    PORT: String(port),
    PIPE_NAME: "bun-reopen",
    PIPE_TTL: "2s",
  });

  try {
    const first = opened.parse(await app.next("open"));
    const reopening = await app.next("reopening");
    expect(reopening).toMatchObject({ reason: "expired" });

    const again = opened
      .extend({ reopened: z.boolean() })
      .parse(await app.next("open", app.lines.indexOf(reopening)));

    expect(again.reopened).toBe(true);
    expect(again.url).toBe(first.url);
  } finally {
    app.child.kill("SIGKILL");
    http.closeAllConnections();
    http.close();
  }
});
