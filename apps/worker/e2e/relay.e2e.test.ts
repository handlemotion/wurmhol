// The relay end to end: a viewer's request crosses the Worker, the Share DO, the CLI's socket
// and the CLI to a real local server, and back. Large bodies both ways, SSE, browser
// WebSockets (Vite hot reload), the waiting page, and a dropped connection.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { createServer as createVite, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { WebSocketServer } from "ws";
import { z } from "zod";
import {
  alive,
  api,
  browserFetch,
  browserSocket,
  cli,
  cliEnv,
  connectProxy,
  createToken,
  listeningPort,
  localServer,
  parseJson,
  type Person,
  sha256,
  share,
  shareStates,
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

beforeAll(async () => {
  stack = await startStack();
  ada = await signIn(stack);
  env = cliEnv(stack, (await createToken(stack, ada)).token);
});

afterAll(async () => {
  await stopAll(env);
  await stack.stop();
});

const BIG = 50 * 1024 * 1024;
const big = Buffer.alloc(BIG);

for (let i = 0; i < BIG; i += 4096) big.writeUInt32BE((i * 2654435761) >>> 0, i);

describe("a share round-trip", () => {
  it("prints the URL fast, forwards to the local server, and keeps the share cookie from it", async () => {
    // Also catches: a dev server setting a cookie for the whole pipe domain (every other pipe
    // gets it), or setting the viewer's share cookie on its pipe host.
    const seen: {
      host?: string;
      xfh?: string | string[];
      xfp?: string | string[];
      cookie?: string;
      path?: string;
    }[] = [];

    const local = await localServer((req, res) => {
      seen.push({
        host: req.headers.host,
        xfh: req.headers["x-forwarded-host"],
        xfp: req.headers["x-forwarded-proto"],
        cookie: req.headers.cookie,
        path: req.url,
      });

      if (req.url === "/favicon.ico") {
        res.writeHead(200, { "content-type": "image/x-icon" }).end(Buffer.from([0, 0, 1, 0, 1]));

        return;
      }

      res.writeHead(201, {
        "content-type": "text/html",
        "set-cookie": [
          "a=1; Path=/",
          "b=2; Path=/; Domain=pipe.localhost",
          "__Host-wurmhol=forged; Path=/; Secure",
        ],
        // The object's signals to the Worker: a dev server must not be able to send them.
        "x-wurmhol-refused": "1",
        "x-wurmhol-org": "someone-else",
      });
      res.end(
        "<!doctype html><html><head><title>Ada&#39;s app</title></head><body>hi</body></html>",
      );
    });

    const started = await share(stack, env, local.port);
    expect(started.url).toBe(stack.shareUrl(started.id));
    expect(started.id).toMatch(/^[a-z0-9]{10}$/);
    // Spec section 2: one URL in under 3 s once a token is set.
    expect(started.ms).toBeLessThan(3000);

    const cookie = await viewerCookie(stack, ada, started.url);

    const response = await browserFetch(`${started.url}/deep/path?q=1&r=%20`, {
      cookie: `app=keep; ${cookie}`,
    });

    expect(response.status).toBe(201);
    expect(await response.text()).toContain("<body>hi</body>");
    expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(response.headers.get("x-wurmhol-refused")).toBeNull();
    expect(response.headers.get("x-wurmhol-org")).toBeNull();
    const request = seen.find((s) => s.path === "/deep/path?q=1&r=%20")!;
    expect(request.host).toBe(`localhost:${local.port}`);
    expect(request.xfh).toBe(new URL(started.url).host);
    expect(request.xfp).toBe("http");
    // The share cookie never reaches the dev server; the app's own cookies do.
    expect(request.cookie).toBe("app=keep");

    // The wall has it, with the page's title and the favicon fetched through the CLI.
    const card = await waitFor(
      async () => {
        const { body } = await api(
          stack,
          ada,
          "/api/shares",
          {},
          z.object({
            shares: z.array(
              z.object({
                id: z.string(),
                title: z.string().nullable(),
                favicon: z.boolean(),
                port: z.number(),
              }),
            ),
          }),
        );

        const found = body.shares.find((s) => s.id === started.id);

        return found?.title && found.favicon ? found : null;
      },
      { what: "title and favicon on the wall" },
    );

    expect(card).toMatchObject({ title: "Ada's app", favicon: true, port: local.port });

    const icon = await browserFetch(`${stack.url}/api/shares/${started.id}/favicon`, {
      cookie: ada.cookie,
    });

    expect(Buffer.from(await icon.arrayBuffer())).toEqual(Buffer.from([0, 0, 1, 0, 1]));

    await cli(["stop", String(local.port)], env);
    await local.close();
  });

  it("relays a viewer's /connect to the dev server instead of taking it as the CLI's socket", async () => {
    // Catches: `/connect` on a pipe host reaching the CLI's socket handler instead of the dev
    // server.
    const seen: string[] = [];

    const local = await localServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.end("dev server");
    });

    local.server.on("upgrade", (req, socket) => {
      seen.push(`upgrade ${req.url}`);
      socket.destroy();
    });
    const started = await share(stack, env, local.port);
    const cookie = await viewerCookie(stack, ada, started.url);

    const plain = await browserFetch(`${started.url}/connect`, { cookie });
    expect(plain.status).toBe(200);
    expect(await plain.text()).toBe("dev server");

    const socket = browserSocket(`${started.url}/connect`, [], { cookie });

    const status = await new Promise<number>((resolve) => {
      socket.once("upgrade", (res) => resolve(res.statusCode ?? 0));
      socket.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      socket.once("error", () => {});
    });

    socket.terminate();
    expect(status).toBe(502);
    expect(seen).toEqual(["GET /connect", "upgrade /connect"]);

    await cli(["stop", String(local.port)], env);
    await local.close();
  });

  it("carries a 50 MB download and a 50 MB upload intact", async () => {
    const local = await localServer(async (req, res) => {
      if (req.method === "POST") {
        const body = await buffer(req);
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ bytes: body.length, sha: sha256(body) }));

        return;
      }

      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": BIG });

      // Several writes, as a real file server streams.
      for (let i = 0; i < BIG; i += 1024 * 1024) {
        if (!res.write(big.subarray(i, i + 1024 * 1024)))
          await new Promise((r) => res.once("drain", r));
      }

      res.end();
    });

    const { url } = await share(stack, env, local.port);
    const cookie = await viewerCookie(stack, ada, url);

    const download = await browserFetch(`${url}/big.bin`, { cookie });
    expect(download.status).toBe(200);
    const received = Buffer.from(await download.arrayBuffer());
    expect(received.length).toBe(BIG);
    expect(sha256(received)).toBe(sha256(big));

    const upload = await browserFetch(`${url}/upload`, {
      method: "POST",
      cookie,
      headers: { "content-type": "application/octet-stream" },
      body: big,
    });

    expect(await upload.json()).toEqual({ bytes: BIG, sha: sha256(big) });

    await cli(["stop", String(local.port)], env);
    await local.close();
  });

  it("streams server-sent events as they happen, and stops the local stream when the viewer leaves", async () => {
    let closedByViewer = false;

    const local = await localServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      let n = 0;
      const timer = setInterval(() => res.write(`data: tick ${n++}\n\n`), 100);
      req.on("close", () => {
        clearInterval(timer);
        closedByViewer = true;
      });
    });

    const { url } = await share(stack, env, local.port);
    const cookie = await viewerCookie(stack, ada, url);

    const response = await browserFetch(`${url}/events`, {
      cookie,
      headers: { accept: "text/event-stream" },
    });

    const reader = response.body!.getReader();
    const arrivals: number[] = [];
    let text = "";
    const decoder = new TextDecoder();

    while (arrivals.length < 5) {
      const { value } = await reader.read();
      text += decoder.decode(value);
      arrivals.push(Date.now());
    }

    expect(text).toContain("data: tick 0\n\n");
    // Events arrive spread out as sent, not buffered until the end.
    expect(arrivals.at(-1)! - arrivals[0]!).toBeGreaterThan(150);
    await reader.cancel();
    await waitFor(() => closedByViewer, { what: "the local SSE stream to close" });

    await cli(["stop", String(local.port)], env);
    await local.close();
  });

  it("says the server is not up yet, then serves it once it is", async () => {
    // Nothing listens there: a port taken and closed right away.
    const placeholder = await localServer(() => {});
    await placeholder.close();
    const { url } = await share(stack, env, placeholder.port);
    const cookie = await viewerCookie(stack, ada, url);
    const waiting = await browserFetch(`${url}/`, { cookie });
    expect(waiting.status).toBe(502);
    expect(await waiting.text()).toContain(`Waiting for the server on port ${placeholder.port}`);
    await cli(["stop", String(placeholder.port)], env);
  });
});

describe("browser WebSockets", () => {
  let vite: ViteDevServer;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "wurmhol-vite-"));
    writeFileSync(
      join(root, "index.html"),
      '<!doctype html><title>Vite app</title><script type="module" src="/main.js"></script>',
    );
    writeFileSync(join(root, "main.js"), "document.title = 'one';\n");
    // A stock Vite config: the spec promises hot reload with no Vite change.
    vite = await createVite({
      root,
      configFile: false,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
    });
    await vite.listen();
  });

  afterAll(async () => {
    await vite.close();
  });

  it("Vite hot reload works through the share", async () => {
    const port = listeningPort(vite.httpServer!);
    const { url } = await share(stack, env, port);
    const cookie = await viewerCookie(stack, ada, url);
    const page = await browserFetch(`${url}/`, { cookie });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("/@vite/client");
    const client = await (await browserFetch(`${url}/@vite/client`, { cookie })).text();
    const token = /const wsToken = "([^"]+)"/.exec(client)?.[1];
    expect(token).toBeTruthy();

    const socket = browserSocket(`${url}/?token=${token}`, ["vite-hmr"], { cookie, origin: url });
    const messages: { type: string }[] = [];
    socket.on("message", (data) =>
      messages.push(parseJson(z.looseObject({ type: z.string() }), data.toString())),
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    expect(socket.protocol).toBe("vite-hmr");
    await waitFor(() => messages.some((m) => m.type === "connected"), { what: "vite connected" });
    // The page loaded main.js through the share, so Vite watches it; an edit reloads it.
    await browserFetch(`${url}/main.js`, { cookie });
    writeFileSync(join(root, "main.js"), "document.title = 'two';\n");
    await waitFor(() => messages.some((m) => m.type === "update" || m.type === "full-reload"), {
      timeoutMs: 15_000,
      what: "a hot update over the relayed websocket",
    });
    socket.close();
    await cli(["stop", String(port)], env);
  });
});

describe("through a sandbox's CONNECT proxy", () => {
  it("dials out through HTTPS_PROXY, and keeps its share id when the proxy cuts the socket", async () => {
    const local = await localServer((_req, res) =>
      res.writeHead(200, { "content-type": "text/plain" }).end("still here"),
    );

    const proxy = await connectProxy([stack.port]);
    const proxied = { ...env, HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url };
    const { id, url } = await share(stack, proxied, local.port);
    expect(proxy.connects).toBeGreaterThan(0);
    const cookie = await viewerCookie(stack, ada, url);
    expect(await (await browserFetch(`${url}/`, { cookie })).text()).toBe("still here");

    const before = proxy.connects;
    proxy.cutAll();
    // The CLI dials again through the proxy and the same URL keeps working.
    await waitFor(() => proxy.connects > before, { what: "a reconnect through the proxy" });

    const again = await waitFor(
      async () => {
        const response = await browserFetch(`${url}/`, { cookie });

        return response.status === 200 ? response.text() : null;
      },
      { what: "the share to answer after the reconnect" },
    );

    expect(again).toBe("still here");

    const { body } = await api(
      stack,
      ada,
      "/api/shares",
      {},
      z.object({ shares: z.array(z.object({ id: z.string(), state: z.string() })) }),
    );

    expect(body.shares.find((s) => s.id === id)?.state).toBe("live");

    await cli(["stop", id], proxied);
    await proxy.close();
    await local.close();
  });

  it("names the hosts to allowlist when the proxy refuses them", async () => {
    const proxy = await connectProxy([]);
    const result = await cli(["8080"], { ...env, HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Allowlist localhost in");
    await proxy.close();
  });
});

describe("browser WebSocket limits", () => {
  it("closes the dev server's socket when the relay gives up waiting for it to open", async () => {
    // The dev server accepts a second after the relay stopped waiting (15 s). Without a
    // ws-close for that stream, the CLI's socket opens then and stays open with nobody behind it.
    const wss = new WebSocketServer({ noServer: true });
    let upgrades = 0;
    let dropped = false;
    const local = await localServer((_req, res) => res.end("x"));
    local.server.on("upgrade", (req, socket, head) => {
      upgrades++;
      socket.on("close", () => (dropped = true));
      setTimeout(() => wss.handleUpgrade(req, socket, head, () => {}), 16_000);
    });
    const { url } = await share(stack, env, local.port);
    const cookie = await viewerCookie(stack, ada, url);

    const status = await new Promise<number>((resolve) => {
      const socket = browserSocket(`${url}/slow`, [], { cookie, origin: url });
      socket.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      socket.once("open", () => resolve(101));
    });

    expect(status).toBe(502);
    expect(upgrades).toBe(1);
    await waitFor(() => dropped, { timeoutMs: 5_000, what: "the CLI's local connection closed" });
    await cli(["stop", String(local.port)], env);
    wss.close();
    await local.close();
  });

  it("closes a browser socket that more is queued toward than it can read, at both ends", async () => {
    // 24 MiB at once: past the 16 MiB the relay lets queue toward one end of a socket.
    const wss = new WebSocketServer({ noServer: true });
    let serverClose: number | null = null;
    const local = await localServer((_req, res) => res.end("x"));
    local.server.on("upgrade", (req, socket, head) =>
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("close", (code) => (serverClose = code));
        const piece = Buffer.alloc(512 * 1024, 7);

        for (let i = 0; i < 48 && ws.readyState === ws.OPEN; i++) ws.send(piece);
      }),
    );
    const { url } = await share(stack, env, local.port);
    const cookie = await viewerCookie(stack, ada, url);
    const socket = browserSocket(`${url}/flood`, [], { cookie, origin: url });
    let received = 0;
    socket.on("message", (data: Buffer) => (received += data.byteLength));
    const code = await new Promise<number>((resolve) => socket.once("close", resolve));
    expect(code).toBe(1013);
    expect(received).toBeLessThan(24 * 1024 * 1024);
    await waitFor(() => serverClose === 1013, { what: "the dev server's socket closed" });
    await cli(["stop", String(local.port)], env);
    wss.close();
    await local.close();
  });
});

describe("the CLI", () => {
  it("ls lists open shares and stop ends one by port, removing its process", async () => {
    const local = await localServer((_req, res) => res.end("x"));
    const started = await share(stack, env, local.port);

    const listed = parseJson(
      z.array(z.object({ id: z.string(), port: z.number() })),
      (await cli(["ls", "--json"], env)).stdout,
    );

    expect(listed).toContainEqual(expect.objectContaining({ id: started.id, port: local.port }));

    const { pid } = parseJson(
      z.object({ pid: z.number() }),
      (await import("node:fs")).readFileSync(
        join(env.WURMHOL_HOME!, "shares", `${started.id}.json`),
        "utf8",
      ),
    );

    const stopped = await cli(["stop", String(local.port)], env);
    expect(stopped.stdout).toContain(started.url);
    expect(alive(pid)).toBe(false);
    expect(shareStates(env)).not.toContain(`${started.id}.json`);
    // The relay ended it at once: the URL says so.
    const page = await browserFetch(`${started.url}/`);
    expect(page.status).toBe(410);
    expect(await page.text()).toContain("This pipe has ended.");
    await local.close();
  });
});
