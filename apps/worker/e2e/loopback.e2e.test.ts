// A dev server bound only to ::1, as Vite is on its default `localhost` with Node 17+ on macOS:
// the pipe and `wurmhol host` reach it with no --host, on a machine with an IPv6 loopback.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createVite, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  browserFetch,
  browserSocket,
  cli,
  cliEnv,
  cliPath,
  createToken,
  type Person,
  share,
  signIn,
  type Stack,
  startStack,
  stopAll,
  viewerCookie,
  waitFor,
} from "./support.ts";

let stack: Stack;
let ada: Person;
let env: Record<string, string>;
let vite: ViteDevServer;
let port: number;

/** Fails with the reason when this machine cannot listen on ::1 (a kernel without IPv6). */
async function requireIpv6Loopback() {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", (error) =>
      reject(new Error(`this suite needs an IPv6 loopback (::1): ${(error as Error).message}`)),
    );
    probe.listen(0, "::1", resolve);
  });
  await new Promise((resolve) => probe.close(resolve));
}

beforeAll(async () => {
  await requireIpv6Loopback();
  stack = await startStack();
  ada = await signIn(stack);
  env = cliEnv(stack, (await createToken(stack, ada)).token);
  const root = mkdtempSync(join(tmpdir(), "wurmhol-vite6-"));
  writeFileSync(
    join(root, "index.html"),
    '<!doctype html><title>IPv6 app</title><script type="module" src="/main.js"></script>',
  );
  writeFileSync(join(root, "main.js"), "document.title = 'one';\n");
  vite = await createVite({
    root,
    configFile: false,
    logLevel: "silent",
    server: { host: "::1", port: 0 },
  });
  await vite.listen();
  port = (vite.httpServer!.address() as { port: number }).port;
});

afterAll(async () => {
  if (env) await stopAll(env);
  await vite?.close();
  await stack?.stop();
});

it("a pipe serves a dev server listening only on ::1, hot reload included", async () => {
  const { url } = await share(stack, env, port);
  const cookie = await viewerCookie(stack, ada, url);
  // Catches: the pipe dialing only 127.0.0.1 and showing "Waiting for the server" forever.
  const page = await browserFetch(`${url}/`, { cookie });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("<title>IPv6 app</title>");
  const client = await (await browserFetch(`${url}/@vite/client`, { cookie })).text();
  const token = /const wsToken = "([^"]+)"/.exec(client)?.[1];
  expect(token).toBeTruthy();
  // Catches: the browser's WebSocket stream still dialing 127.0.0.1 after HTTP falls back.
  const socket = browserSocket(`${url}/?token=${token}`, ["vite-hmr"], { cookie, origin: url });
  const messages: { type: string }[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as { type: string }));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  await waitFor(() => messages.some((m) => m.type === "connected"), { what: "vite connected" });
  socket.close();
  await cli(["stop", String(port)], env);
});

it("wurmhol host offers a port that answers only on ::1", async () => {
  const host = spawn(process.execPath, [cliPath, "host"], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const feed = browserSocket(`${stack.url}/api/machines/live`, [], {
      cookie: ada.cookie,
      origin: stack.url,
    });
    let ports: { port: number; title: string | null }[] = [];
    feed.on("message", (data) => {
      const event = JSON.parse(String(data)) as {
        type: string;
        machines: { ports: typeof ports }[];
      };
      if (event.type === "machines") ports = event.machines.flatMap((m) => m.ports);
    });
    // Catches: the probe asking only 127.0.0.1, so the port never shows in Create pipe.
    const offered = await waitFor(() => ports.find((p) => p.port === port), {
      timeoutMs: 15_000,
      what: `port ${port} offered`,
    });
    expect(offered.title).toBe("IPv6 app");
    feed.close();
  } finally {
    host.kill();
  }
});
