// A new pipe's favicon and title reach the wall as soon as it starts, before anyone opens it: the
// relay asks the dev server for `/` through the CLI and reads only the start of the page.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  api,
  browserFetch,
  cliEnv,
  createToken,
  localServer,
  type Person,
  share,
  signIn,
  type Stack,
  startStack,
  stopAll,
  viewerCookie,
  waitFor,
} from "./support.ts";

const ICON = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]);
let stack: Stack;
let ada: Person;
let env: Record<string, string>;

beforeAll(async () => {
  stack = await startStack();
  ada = await signIn(stack);
  env = cliEnv(stack, (await createToken(stack, ada)).token);
});

afterAll(async () => {
  await stopAll(env);
  await stack.stop();
});

interface Card {
  id: string;
  title: string | null;
  favicon: boolean;
  lastRequestAt: number | null;
}

async function card(id: string) {
  const wall = await api<{ shares: Card[] }>(stack, ada, "/api/shares");
  return wall.body.shares.find((s) => s.id === id);
}

function app(
  seen: string[],
  icon: { type: string; body: Buffer } = { type: "image/png", body: ICON },
) {
  return (req: IncomingMessage, res: ServerResponse) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === "/icon.png")
      return void res.writeHead(200, { "content-type": icon.type }).end(icon.body);
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<!doctype html><html><head><title>Shop</title><link rel="icon" href="/icon.png"></head><body>${"x".repeat(200_000)}</body></html>`,
    );
  };
}

it("shows a new pipe's favicon and title before anyone opens it", async () => {
  const seen: string[] = [];
  const local = await localServer(app(seen));
  const started = await share(stack, env, local.port);
  const shown = await waitFor(
    async () => {
      const found = await card(started.id);
      return found?.favicon ? found : null;
    },
    { what: "the favicon on the wall" },
  );
  expect(shown.title).toBe("Shop");
  // The relay's own requests are not a viewer's.
  expect(shown.lastRequestAt).toBeNull();
  expect(seen).toEqual(["GET /", "GET /icon.png"]);
  const icon = await browserFetch(`${stack.url}/api/shares/${started.id}/favicon`, {
    cookie: ada.cookie,
  });
  expect(icon.status).toBe(200);
  expect(Buffer.from(await icon.arrayBuffer())).toEqual(ICON);
  await stopAll(env);
  await local.close();
});

it("waits for a server that starts after its pipe, and never takes the waiting page's title", async () => {
  const seen: string[] = [];
  const server = createServer(app(seen));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));

  const started = await share(stack, env, port);
  // The probe has found nothing to listen yet and got the CLI's waiting page.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(await card(started.id)).toMatchObject({ title: null, favicon: false });

  const late = createServer(app(seen));
  await new Promise<void>((resolve) => late.listen(port, "127.0.0.1", resolve));
  const shown = await waitFor(
    async () => {
      const found = await card(started.id);
      return found?.favicon ? found : null;
    },
    { timeoutMs: 20_000, what: "the favicon once the server is up" },
  );
  expect(shown.title).toBe("Shop");
  await stopAll(env);
  late.closeAllConnections();
  await new Promise((resolve) => late.close(resolve));
});

it("keeps the waiting page's title off the wall when a viewer opens a pipe before its server is up", async () => {
  const placeholder = await localServer(() => {});
  await placeholder.close();
  const started = await share(stack, env, placeholder.port);
  const cookie = await viewerCookie(stack, ada, started.url);
  const waiting = await browserFetch(`${started.url}/`, { cookie });
  expect(waiting.status).toBe(502);
  expect(await waiting.text()).toContain(`Waiting for the server on port ${placeholder.port}`);
  // Catches the viewer's title scan reading the CLI's waiting page as the app's title.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(await card(started.id)).toMatchObject({ title: null, favicon: false });
  await stopAll(env);
});

it.each([
  ["not an image", { type: "text/html", body: Buffer.from("<html></html>") }],
  ["over 100 KB", { type: "image/png", body: Buffer.alloc(100 * 1024 + 1) }],
])("keeps no favicon that is %s", async (_label, icon) => {
  const seen: string[] = [];
  const local = await localServer(app(seen, icon));
  const started = await share(stack, env, local.port);
  await waitFor(() => seen.includes("GET /icon.png"), { what: "the favicon request" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(await card(started.id)).toMatchObject({ title: "Shop", favicon: false });
  await stopAll(env);
  await local.close();
});
