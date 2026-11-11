// Local stand-ins for the two services the custom domains feature calls out to (ADR 0033):
// Cloudflare's custom hostnames API and a DNS-over-HTTPS JSON resolver. They speak the real wire
// shapes over HTTP, because no test may create real hostnames or publish real DNS records.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const ZONE = "0123456789abcdef0123456789abcdef";
export const TOKEN = "cf-e2e-token";

interface Hostname {
  id: string;
  hostname: string;
  status: string;
  sslStatus: string;
}

/** Cloudflare's custom hostnames API, as much of it as the Worker calls. */
export async function fakeCloudflare() {
  const hostnames = new Map<string, Hostname>();
  const calls: string[] = [];
  let down = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (down) {
      return send(503, {
        success: false,
        errors: [{ code: 10001, message: "Service unavailable" }],
      });
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return send(401, {
        success: false,
        errors: [{ code: 10000, message: "Authentication error" }],
      });
    }
    const match = new RegExp(`^/client/v4/zones/${ZONE}/custom_hostnames(?:/([^/]+))?$`).exec(
      url.pathname,
    );
    if (!match) return send(404, { success: false, errors: [{ message: "no route" }] });
    const id = match[1];
    const shape = (h: Hostname) => ({
      id: h.id,
      hostname: h.hostname,
      status: h.status,
      ssl: { status: h.sslStatus },
      verification_errors:
        h.status === "pending" ? ["custom hostname does not CNAME to this zone."] : [],
    });
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk));
    req.on("end", () => {
      calls.push(`${req.method} ${id ? "/:id" : ""}`);
      if (req.method === "POST" && !id) {
        const input = JSON.parse(body) as { hostname: string; ssl: { method: string } };
        if (input.ssl.method !== "http")
          return send(400, { success: false, errors: [{ message: "bad method" }] });
        if (hostnames.has(input.hostname)) {
          return send(400, {
            success: false,
            errors: [{ code: 1406, message: "Duplicate custom hostname found." }],
          });
        }
        const made = {
          id: crypto.randomUUID(),
          hostname: input.hostname,
          status: "pending",
          sslStatus: "pending_validation",
        };
        hostnames.set(input.hostname, made);
        return send(200, { success: true, result: shape(made) });
      }
      if (req.method === "GET" && !id) {
        const found = [...hostnames.values()].filter(
          (h) => h.hostname === url.searchParams.get("hostname"),
        );
        return send(200, { success: true, result: found.map(shape) });
      }
      const found = [...hostnames.values()].find((h) => h.id === id);
      if (!found) return send(404, { success: false, errors: [{ message: "not found" }] });
      if (req.method === "DELETE") {
        hostnames.delete(found.hostname);
        return send(200, { success: true, result: { id: found.id } });
      }
      return send(200, { success: true, result: shape(found) });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`,
    has: (hostname: string) => hostnames.has(hostname),
    calls,
    /** Cloudflare's API answering 503 to everything, or back. */
    setDown: (value: boolean) => (down = value),
    /** What the customer's DNS and Cloudflare's validation would do. */
    set(hostname: string, state: Partial<Pick<Hostname, "status" | "sslStatus">>) {
      Object.assign(hostnames.get(hostname)!, state);
    },
    close: () => stop(server),
  };
}

/** A DNS-over-HTTPS JSON resolver that answers from a table. */
export async function fakeResolver() {
  const records = new Map<string, string[]>();
  const failing = new Set<string>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const name = url.searchParams.get("name") ?? "";
    const values = records.get(name);
    res.writeHead(200, { "content-type": "application/dns-json" });
    res.end(
      JSON.stringify({
        // SERVFAIL for a name set to fail: the resolver's trouble, not an answer.
        Status: failing.has(name) ? 2 : values ? 0 : 3,
        Answer: (values ?? []).map((v) => ({ type: 16, data: `"${v}"` })),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/dns-query`,
    publish: (name: string, value: string) => records.set(name, [value]),
    unpublish: (name: string) => records.delete(name),
    fail: (name: string) => failing.add(name),
    close: () => stop(server),
  };
}

function stop(server: Server) {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}
