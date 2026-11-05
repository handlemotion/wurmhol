import { describe, expect, it } from "vitest";
import {
  chunk,
  decodeFrame,
  encodeFrame,
  type Frame,
  MAX_CHUNK_BYTES,
  PING_TEXT,
  PONG_TEXT,
  ProtocolError,
} from "./frame.ts";
import { parseRefusal, refusal } from "./connect.ts";
import {
  forwardable,
  pipeSetCookie,
  readCookie,
  SHARE_COOKIE,
  viewerRequestHeaders,
  withoutCookie,
} from "./headers.ts";
import { HttpStreamOrder, INITIAL_WINDOW, ReceiveWindow, SendWindow } from "./mux.ts";

const bytes = (...values: number[]) => new Uint8Array(values);

describe("frame round-trips", () => {
  // Catches: a field dropped or mangled by the codec (repeated set-cookie headers, a high stream
  // id losing its top bit to a signed read, binary flag inverted).
  const frames: Frame[] = [
    {
      stream: 1,
      type: "request",
      payload: {
        method: "POST",
        path: "/api/x?y=1&z=%C3%A9",
        headers: [
          ["content-type", "application/json"],
          ["x-émoji", "🐛"],
        ],
      },
    },
    {
      stream: 0xffff_ffff,
      type: "response",
      payload: {
        status: 200,
        headers: [
          ["set-cookie", "a=1"],
          ["set-cookie", "b=2"],
        ],
      },
    },
    { stream: 7, type: "data", payload: bytes(0, 255, 10, 13) },
    { stream: 7, type: "end", payload: {} },
    { stream: 7, type: "end", payload: { error: "ECONNREFUSED" } },
    { stream: 9, type: "ws-open", payload: { path: "/", headers: [], protocols: ["vite-hmr"] } },
    { stream: 9, type: "ws-open", payload: { accepted: true, protocol: "vite-hmr" } },
    { stream: 9, type: "ws-message", payload: { binary: false, data: bytes(104, 105) } },
    { stream: 9, type: "ws-message", payload: { binary: true, data: bytes() } },
    { stream: 9, type: "ws-close", payload: { code: 1001, reason: "going away" } },
    { stream: 3, type: "window", payload: { bytes: 524_288 } },
  ];

  for (const frame of frames) {
    it(`${frame.type} on stream ${frame.stream}`, () => {
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    });
  }

  it("decodes a frame that is a view into a larger buffer", () => {
    // Catches: reading the stream id at buffer offset 1 instead of byteOffset + 1 (Node hands
    // `ws` messages over as slices of a pooled buffer).
    const encoded = encodeFrame({ stream: 42, type: "data", payload: bytes(1, 2, 3) });
    const pool = new Uint8Array(encoded.byteLength + 16);
    pool.fill(0xee);
    pool.set(encoded, 8);
    const view = pool.subarray(8, 8 + encoded.byteLength);
    expect(decodeFrame(view)).toEqual({ stream: 42, type: "data", payload: bytes(1, 2, 3) });
  });

  it("ping is text both ways, so the hibernated Durable Object can answer it", () => {
    expect(decodeFrame(PING_TEXT)).toEqual({ stream: 0, type: "ping", payload: null });
    expect(decodeFrame(PONG_TEXT)).toEqual({ stream: 0, type: "ping", payload: null });
    expect(() => encodeFrame({ stream: 0, type: "ping", payload: null })).toThrow(ProtocolError);
  });
});

describe("malformed frames are refused", () => {
  // Catches: a hostile CLI crashing the Durable Object, or smuggling a request with a path that
  // is not a path (an absolute URL would let it pick the upstream).
  const json = (type: number, payload: unknown) => {
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const frame = new Uint8Array(5 + body.byteLength);
    frame[0] = type;
    frame.set(body, 5);
    return frame;
  };
  const cases: [string, string | Uint8Array][] = [
    ["short", bytes(1, 0, 0)],
    ["unknown type", bytes(200, 0, 0, 0, 1)],
    ["text other than ping", "hello"],
    ["request with an absolute URL", json(1, { method: "GET", path: "http://x/", headers: [] })],
    ["request with a lowercase method", json(1, { method: "get", path: "/", headers: [] })],
    ["request headers as an object", json(1, { method: "GET", path: "/", headers: { a: "b" } })],
    ["response status out of range", json(2, { status: 99, headers: [] })],
    ["response without headers", json(2, { status: 200 })],
    ["end that is an array", json(4, [])],
    ["window of zero", json(9, { bytes: 0 })],
    ["window that is not whole", json(9, { bytes: 1.5 })],
    ["ws-open with an absolute URL", json(5, { path: "@evil.example/", headers: [] })],
    ["ws-open protocols that are not strings", json(5, { path: "/", protocols: [1] })],
    ["ws-message kind other than 0 or 1", bytes(6, 0, 0, 0, 1, 2, 65)],
    ["invalid UTF-8 JSON", bytes(4, 0, 0, 0, 1, 0xff, 0xfe)],
    ["oversized data", new Uint8Array(5 + MAX_CHUNK_BYTES + 1).fill(3, 0, 1)],
  ];
  it.each(cases)("%s", (_name, message) => {
    expect(() => decodeFrame(message)).toThrow(ProtocolError);
  });

  it("refuses to encode a data frame over the chunk size", () => {
    // Catches: a caller skipping `chunk()` and sending a 50 MB body as one frame, which the
    // Workers runtime would refuse (1 MiB message limit) and close the socket over.
    const payload = new Uint8Array(MAX_CHUNK_BYTES + 1);
    expect(() => encodeFrame({ stream: 1, type: "data", payload })).toThrow(ProtocolError);
  });
});

describe("chunking", () => {
  it("splits a body into chunks of at most 64 KB that join back exactly", () => {
    // Catches: an off-by-one that drops or repeats the last partial chunk of a large asset.
    const body = new Uint8Array(3 * MAX_CHUNK_BYTES + 17);
    for (let i = 0; i < body.length; i++) body[i] = (i * 31) & 0xff;
    const chunks = [...chunk(body)];
    expect(chunks.map((c) => c.byteLength)).toEqual([
      MAX_CHUNK_BYTES,
      MAX_CHUNK_BYTES,
      MAX_CHUNK_BYTES,
      17,
    ]);
    const joined = new Uint8Array(body.length);
    let offset = 0;
    for (const c of chunks) {
      const decoded = decodeFrame(encodeFrame({ stream: 5, type: "data", payload: c }));
      if (decoded.type !== "data") throw new Error("expected data");
      joined.set(decoded.payload, offset);
      offset += decoded.payload.byteLength;
    }
    expect(joined).toEqual(body);
  });

  it("an empty body has no data frames", () => {
    expect([...chunk(new Uint8Array(0))]).toEqual([]);
  });
});

describe("stream interleaving", () => {
  it("frames of streams interleaved on one socket reassemble per stream", () => {
    // Catches: per-stream state keyed wrongly, so chunks of two concurrent downloads (an asset
    // and an SSE stream) end up in each other's bodies.
    const bodies = new Map<number, Uint8Array>([
      [1, new Uint8Array(200_000).fill(1)],
      [2, new Uint8Array(70_000).fill(2)],
      [3, new Uint8Array(5).fill(3)],
    ]);
    const queues = [...bodies].map(([stream, body]) =>
      [...chunk(body)].map((payload) => encodeFrame({ stream, type: "data", payload })),
    );
    const wire: Uint8Array[] = [];
    while (queues.some((q) => q.length))
      for (const q of queues) if (q.length) wire.push(q.shift()!);

    const received = new Map<number, number[]>();
    for (const message of wire) {
      const frame = decodeFrame(message);
      if (frame.type !== "data") throw new Error("expected data");
      const list = received.get(frame.stream) ?? [];
      list.push(...frame.payload);
      received.set(frame.stream, list);
    }
    for (const [stream, body] of bodies) expect(received.get(stream)).toEqual([...body]);
  });

  it("enforces head, body, end order per stream", () => {
    // Catches: a body accepted before its status line, or a second response smuggled onto a
    // stream that already ended.
    const order = new HttpStreamOrder("response");
    const data: Frame = { stream: 1, type: "data", payload: bytes(1) };
    expect(() => order.accept(data)).toThrow(ProtocolError);

    const fresh = new HttpStreamOrder("response");
    fresh.accept({ stream: 1, type: "response", payload: { status: 200, headers: [] } });
    fresh.accept(data);
    fresh.accept({ stream: 1, type: "window", payload: { bytes: 10 } });
    fresh.accept({ stream: 1, type: "end", payload: {} });
    expect(fresh.done).toBe(true);
    expect(() =>
      fresh.accept({ stream: 1, type: "response", payload: { status: 200, headers: [] } }),
    ).toThrow(ProtocolError);
    expect(() => fresh.accept({ stream: 1, type: "end", payload: {} })).toThrow(ProtocolError);
    // Credit for the other direction may still arrive after this direction ended.
    fresh.accept({ stream: 1, type: "window", payload: { bytes: 10 } });
  });

  it("an end before the head reports an error for a request that never got an answer", () => {
    const order = new HttpStreamOrder("response");
    order.accept({ stream: 1, type: "end", payload: { error: "ECONNREFUSED" } });
    expect(order.done).toBe(true);
  });
});

describe("flow control", () => {
  it("a sender waits once its window is spent and resumes on a grant", async () => {
    // Catches: a sender that ignores the window and buffers a whole download in the Durable
    // Object's 128 MB of memory while a phone reads slowly.
    const window = new SendWindow(100);
    window.take(100);
    let resumed = false;
    const waiting = window.ready(40).then(() => {
      resumed = true;
    });
    await Promise.resolve();
    expect(resumed).toBe(false);
    window.grant(20);
    await Promise.resolve();
    expect(resumed).toBe(false);
    window.grant(20);
    await waiting;
    expect(resumed).toBe(true);
    expect(() => window.take(41)).toThrow(ProtocolError);
  });

  it("release wakes a waiting sender so a cancelled stream does not hang", async () => {
    const window = new SendWindow(0);
    const waiting = window.ready(1);
    window.release();
    await expect(waiting).resolves.toBeUndefined();
  });

  it("the receiver re-grants after half the window and catches a peer that overruns it", () => {
    // Catches: grants that never come (every big download stalls at 1 MiB), and a peer that
    // ignores its window going unnoticed.
    const window = new ReceiveWindow(INITIAL_WINDOW);
    window.received(INITIAL_WINDOW);
    expect(window.consumed(INITIAL_WINDOW / 2 - 1)).toBe(0);
    expect(window.consumed(1)).toBe(INITIAL_WINDOW / 2);
    window.received(INITIAL_WINDOW / 2);
    expect(() => window.received(1)).toThrow(ProtocolError);
  });

  it("a whole body moves through a window smaller than it, with every byte accounted for", async () => {
    // Catches: credit leaking (granted twice or never) over many grant cycles of a 50 MB body.
    const size = 64 * 1024;
    const send = new SendWindow(size);
    const receive = new ReceiveWindow(size);
    const body = new Uint8Array(50 * 1024 * 1024 + 123);
    let sent = 0;
    let delivered = 0;
    for (const piece of chunk(body)) {
      await send.ready(piece.byteLength);
      send.take(piece.byteLength);
      sent += piece.byteLength;
      receive.received(piece.byteLength);
      delivered += piece.byteLength;
      const grant = receive.consumed(piece.byteLength);
      if (grant) send.grant(grant);
    }
    expect(sent).toBe(body.byteLength);
    expect(delivered).toBe(body.byteLength);
  });
});

describe("headers", () => {
  it("drops hop-by-hop headers and the ones Connection names", () => {
    // Catches: a viewer's `transfer-encoding` or `connection: x-secret` reaching the dev
    // server, which desyncs its parser or leaks a header meant for one hop.
    expect(
      forwardable([
        ["Host", "abcdefghij.wurmhol.dev"],
        ["Connection", "keep-alive, X-Hop"],
        ["x-hop", "1"],
        ["Transfer-Encoding", "chunked"],
        ["Content-Length", "5"],
        ["accept", "text/html"],
        ["set-cookie", "a=1"],
        ["set-cookie", "b=2"],
      ]),
    ).toEqual([
      ["accept", "text/html"],
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"],
    ]);
  });

  it("strips only the share cookie, by exact name", () => {
    // Catches: the viewer's share cookie reaching the dev server (spec section 6.4), or a
    // prefix match deleting the app's own cookies.
    const header = `sid=1; ${SHARE_COOKIE}=secret; ${SHARE_COOKIE}-x=2; x${SHARE_COOKIE}=3`;
    expect(withoutCookie(header, SHARE_COOKIE)).toBe(
      `sid=1; ${SHARE_COOKIE}-x=2; x${SHARE_COOKIE}=3`,
    );
    expect(withoutCookie(`${SHARE_COOKIE}=a;${SHARE_COOKIE}=b`, SHARE_COOKIE)).toBeNull();
    expect(withoutCookie(` ${SHARE_COOKIE} = a `, SHARE_COOKIE)).toBeNull();
  });

  it("keeps the viewer's identity and the relay's own headers from the dev server", () => {
    // Catches: the viewer's IP, user id or share cookie reaching the dev server, or a
    // compressed body the relay cannot read a title from.
    const headers = viewerRequestHeaders(
      [
        ["accept", "text/html"],
        ["cookie", `${SHARE_COOKIE}=secret; sid=1`],
        ["x-wurmhol-viewer", "user_1"],
        ["cf-connecting-ip", "203.0.113.9"],
        ["X-Forwarded-For", "203.0.113.9"],
        ["accept-encoding", "gzip"],
      ],
      "https://abcdefghij.wurmhol.dev",
    );
    expect(headers).toEqual([
      ["accept", "text/html"],
      ["cookie", "sid=1"],
      ["x-forwarded-host", "abcdefghij.wurmhol.dev"],
      ["x-forwarded-proto", "https"],
    ]);
  });

  it("keeps a dev server's cookies on its own pipe host", () => {
    // Catches: a pipe setting `Domain=<pipe domain>`, so its cookie reaches every other pipe
    // while the pipe domain is not on the Public Suffix List.
    expect(pipeSetCookie("sid=1; Path=/; Domain=wurmhol.dev; HttpOnly")).toBe(
      "sid=1; Path=/; HttpOnly",
    );
    expect(pipeSetCookie("sid=1;domain=.wurmhol.dev;Secure; DOMAIN = x")).toBe("sid=1;Secure");
    // A value or another attribute that only mentions domain stays.
    expect(pipeSetCookie("domain=a.b; Path=/domain")).toBe("domain=a.b; Path=/domain");
  });

  it("never lets a dev server set or clear the share cookie", () => {
    // Catches: a dev server overwriting or deleting the viewer's sign-in on its pipe host.
    expect(pipeSetCookie(`${SHARE_COOKIE}=forged; Path=/; Secure`)).toBeNull();
    expect(pipeSetCookie(` ${SHARE_COOKIE.toLowerCase()} = ; Max-Age=0`)).toBeNull();
    expect(pipeSetCookie(`${SHARE_COOKIE}-x=1`)).toBe(`${SHARE_COOKIE}-x=1`);
  });

  it("reads a cookie by exact name", () => {
    expect(readCookie(`a${SHARE_COOKIE}=1; ${SHARE_COOKIE}=v.sig; z=2`, SHARE_COOKIE)).toBe(
      "v.sig",
    );
    expect(readCookie("a=1", SHARE_COOKIE)).toBeNull();
    expect(readCookie(null, SHARE_COOKIE)).toBeNull();
  });
});

describe("refusals", () => {
  it("end a share only when retrying cannot help", () => {
    // Catches: a plan or token refusal on reconnect leaving the CLI to retry, or closing as
    // `disconnected`; a rate limit ending a share a retry would have kept.
    const read = (...args: Parameters<typeof refusal>) =>
      parseRefusal(JSON.stringify(refusal(...args)))?.reason;
    expect(read(402, "no subscription", "Subscribe.")).toBe("no_subscription");
    expect(read(401, "token expired", "Make a token.")).toBe("revoked");
    expect(read(410, "share ended", "Start again.", { reason: "expired" })).toBe("expired");
    expect(read(429, "too many requests", "Wait.", { retryAfter: 3 })).toBeUndefined();
    expect(parseRefusal("<html>proxy</html>")).toBeNull();
  });
});
