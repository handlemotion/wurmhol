// The SDK's two WebSocket transports against the real stack (ADR 0030): the `ws` package that Node
// uses, and the built-in client that Bun and compiled Bun binaries use. The same cases run on
// both, on Node, so the built-in one is proven where the stack can be driven; the compiled Bun
// binary has its own suite (sdk-bun.e2e.test.ts).
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { WebSocketServer } from "ws";
import { FixError, openPipe, type TransportChoice } from "wurmhol";
import {
  browserFetch,
  browserSocket,
  connectProxy,
  createToken,
  listeningPort,
  localServer,
  type Person,
  signIn,
  type Stack,
  startStack,
  viewerCookie,
  waitFor,
} from "./support.ts";

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

describe.each<TransportChoice>(["node", "builtin"])("transport %s", (transport) => {
  let stack: Stack;
  let ada: Person;
  let token: string;

  beforeAll(async () => {
    stack = await startStack();
    ada = await signIn(stack);
    token = (await createToken(stack, ada)).token;
  });
  afterAll(async () => {
    await stack.stop();
  });

  it("relays large bodies both ways and WebSocket messages of every size, fragmented or not", async () => {
    // A dev server with an upload check, a big download, and a WebSocket that echoes, plus one
    // message it sends in two frames: the cases where a frame parser gets lengths or joins wrong.
    const http = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        res
          .writeHead(200, { "x-upload-sha": sha(body), "content-type": "application/octet-stream" })
          .end(Buffer.alloc(700_000, 7));
      });
    });

    const sockets = new WebSocketServer({ server: http });
    sockets.on("connection", (socket) => {
      socket.on("message", (data, isBinary) => {
        if (!isBinary && data.toString() === "split") {
          socket.send("fir", { fin: false });
          socket.send("st", { fin: true });

          return;
        }

        socket.send(data, { binary: isBinary });
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const port = listeningPort(http);

    const pipe = await openPipe({ port, token, server: stack.url, transport });

    try {
      const cookie = await viewerCookie(stack, ada, pipe.url);
      const upload = randomBytes(300_000);

      const response = await browserFetch(`${pipe.url}/upload`, {
        method: "POST",
        cookie,
        body: upload,
      });

      expect(response.headers.get("x-upload-sha")).toBe(sha(upload));
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.alloc(700_000, 7));

      const viewer = browserSocket(pipe.url, [], { cookie });
      const received: { data: Buffer; binary: boolean }[] = [];
      viewer.on("message", (data: Buffer, binary: boolean) => received.push({ data, binary }));
      await new Promise((resolve, reject) => {
        viewer.once("open", resolve);
        viewer.once("error", reject);
      });
      // 125, 126 and 65536 bytes are where the length field changes size; 300 KB is the
      // two-byte-then-eight-byte case in both directions.
      const sizes = [0, 5, 125, 126, 65_535, 65_536, 300_000];

      for (const size of sizes) viewer.send(Buffer.alloc(size, 0x61), { binary: true });
      viewer.send("t".repeat(70_000));
      viewer.send("split");
      await waitFor(() => (received.length >= sizes.length + 2 ? received : null), {
        what: "every echo",
      });
      expect(received.slice(0, sizes.length).map((m) => m.data.length)).toEqual(sizes);
      expect(received.slice(0, sizes.length).every((m) => m.binary)).toBe(true);
      expect(received[sizes.length]!.data.toString()).toBe("t".repeat(70_000));
      expect(received[sizes.length + 1]!.data.toString()).toBe("first");
      viewer.close();
    } finally {
      await pipe.close();
      http.closeAllConnections();
      http.close();
    }
  });

  it("delivers what a dev server sends the moment a WebSocket opens", async () => {
    // Catches: listeners attached after the connection settled, losing a greeting that arrives
    // in the same packet as the handshake answer.
    const http = createServer();
    new WebSocketServer({ server: http }).on("connection", (socket) => socket.send("greeting"));
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const port = listeningPort(http);
    const pipe = await openPipe({ port, token, server: stack.url, transport });

    try {
      const cookie = await viewerCookie(stack, ada, pipe.url);
      const viewer = browserSocket(pipe.url, [], { cookie });

      const greeting = await new Promise<string>((resolve, reject) => {
        viewer.once("message", (data: Buffer) => resolve(data.toString()));
        viewer.once("error", reject);
      });

      expect(greeting).toBe("greeting");
      viewer.close();
    } finally {
      await pipe.close();
      http.closeAllConnections();
      http.close();
    }
  });

  it("says the relay's own fix when it refuses, and does not crash when nothing answers", async () => {
    const refused = openPipe({ port: 3000, token: "wh_nope", server: stack.url, transport });

    await expect(refused).rejects.toBeInstanceOf(FixError);
    await expect(refused).rejects.toMatchObject({
      code: "refused",
      status: 401,
      // More than ten characters: the relay's own fix, not a bare code.
      message: expect.stringMatching(/.{11}/su),
    });

    // A port nothing listens on: a typed failure, never an unhandled error event.
    const down = openPipe({ port: 3000, token, server: "http://127.0.0.1:9", transport });

    await expect(down).rejects.toBeInstanceOf(FixError);
    await expect(down).rejects.toMatchObject({ code: "unreachable" });
  });

  it("reaches the relay through a CONNECT proxy and keeps its URL across a cut connection", async () => {
    const proxy = await connectProxy([stack.port]);
    const local = await localServer((_req, res) => res.writeHead(200).end("ok"));
    const saved = { HTTP_PROXY: process.env.HTTP_PROXY, NO_PROXY: process.env.NO_PROXY };
    process.env.HTTP_PROXY = proxy.url;
    process.env.NO_PROXY = "";

    try {
      const pipe = await openPipe({ port: local.port, token, server: stack.url, transport });
      expect(proxy.connects).toBeGreaterThan(0);
      const events: string[] = [];
      pipe.on("disconnected", () => events.push("disconnected"));
      pipe.on("reconnected", () => events.push("reconnected"));
      const url = pipe.url;
      proxy.cutAll();
      await waitFor(() => (events.includes("reconnected") ? true : null), {
        what: "the pipe to redial",
      });
      expect(events).toEqual(["disconnected", "reconnected"]);
      expect(pipe.url).toBe(url);
      expect(pipe.state).toBe("open");
      const cookie = await viewerCookie(stack, ada, pipe.url);
      expect(await (await browserFetch(pipe.url, { cookie })).text()).toBe("ok");
      await pipe.close();
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }

      await proxy.close();
      await local.close();
    }
  });
});
