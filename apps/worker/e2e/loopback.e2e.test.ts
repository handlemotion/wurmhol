// A dev server bound only to ::1, as Vite is on its default `localhost` with Node 17+ on macOS:
// a pipe reaches it with no --host, on a machine with an IPv6 loopback. `wurmhol host` offering
// such a port is in machines.e2e.test.ts, beside the one host that suite already runs: every
// `wurmhol host` probes every dev server on the machine, other suites' included.
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createVite, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  browserFetch,
  browserSocket,
  cli,
  cliEnv,
  createToken,
  listeningPort,
  parseJson,
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
    probe.once("error", (error: Error) =>
      reject(new Error(`this suite needs an IPv6 loopback (::1): ${error.message}`)),
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
  port = listeningPort(vite.httpServer!);
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
  const message = z.object({ type: z.string() });
  socket.on("message", (data) => messages.push(parseJson(message, data.toString())));

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  await waitFor(() => messages.some((m) => m.type === "connected"), { what: "vite connected" });
  socket.close();
  await cli(["stop", String(port)], env);
});
