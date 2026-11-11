// The SDK's embedded side (ADR 0032, step 7), as published in `wurmhol`, against the real stack:
// a backend's `WurmholEmbed` with its integration key, an agent's `keepOpen` with a connector, a
// program's `grantHeaders`, and a page's `tunnelSocket` that renews its grant over the
// subprotocol. Every failure is a `FixError` with a code to branch on.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FixError,
  grantHeaders,
  keepOpen,
  type ManagedPipe,
  openPipe,
  tunnelSocket,
  WurmholEmbed,
} from "wurmhol";
import { WebSocketServer } from "ws";
import {
  api,
  browserFetch,
  browserSocket,
  localServer,
  type Person,
  signIn,
  type Stack,
  startStack,
} from "./support.ts";

const ORIGIN = "https://app.dorks.example";

let stack: Stack;
let owner: Person;
let embed: WurmholEmbed;
let local: Awaited<ReturnType<typeof localServer>>;
const managed: ManagedPipe[] = [];

beforeAll(async () => {
  stack = await startStack({ CONNECT_HOST: "api.localhost", EMBEDDED_ENABLED: "true" });
  owner = await signIn(stack);
  const app = await api<{ app: { id: string } }>(stack, owner, "/api/apps", {
    method: "POST",
    body: { name: "Dorks", allowedOrigins: [ORIGIN] },
  });
  const made = await api<{ key: string }>(stack, owner, `/api/apps/${app.body.app.id}/keys`, {
    method: "POST",
    body: {
      name: "backend",
      permissions: ["tunnels:read", "tunnels:manage", "subjects:manage", "grants:issue"],
    },
  });
  embed = new WurmholEmbed({
    key: made.body.key,
    server: `http://api.localhost:${stack.port}`,
    client: { name: "dorks-api", version: "1.0.0" },
  });
  const wss = new WebSocketServer({ noServer: true, handleProtocols: () => false });
  local = await localServer((_req, res) => res.end("ok"));
  local.server.on("upgrade", (req, socket, head) =>
    wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (data) => ws.send(data))),
  );
  await embed.tenants.put("acme");
  await embed.subjects.put("acme", "alice", { kind: "user" });
  await embed.subjects.put("acme", "bob", { kind: "user" });
});

afterAll(async () => {
  for (const pipe of managed) await pipe.close();
  await local.close();
  await stack.stop();
});

/** A tunnel for `owner`, kept open by its agent with the connector. */
async function agentTunnel(ownerId: string) {
  const { tunnel, connector } = await embed.tunnels.create({ tenant: "acme", owner: ownerId });
  const pipe = keepOpen({ port: local.port, token: connector.connector, server: stack.url });
  managed.push(pipe);
  await pipe.ready();
  return { tunnel, connector, pipe };
}

describe("a backend's WurmholEmbed", () => {
  it("needs an integration key, and never runs in a page", () => {
    expect(() => new WurmholEmbed({ key: "wh_not-an-integration-key" })).toThrow(FixError);
    const page = globalThis as { document?: unknown };
    page.document = {};
    try {
      expect(() => new WurmholEmbed({ key: `whk_${"A".repeat(43)}` })).toThrow(
        expect.objectContaining({ code: "unsupported" }),
      );
    } finally {
      delete page.document;
    }
  });

  it("refuses with the relay's fix", async () => {
    const { tunnel } = await embed.tunnels.create({ tenant: "acme", owner: "alice" });
    const refused = await embed.grants
      .issue({ tunnel: tunnel.id, subject: "bob", kind: "client" })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(FixError);
    expect(refused).toMatchObject({ code: "refused", status: 403 });
    expect((refused as FixError).message).toContain("access list");
  });
});

describe("an agent's keepOpen with a connector", () => {
  it("serves the tunnel's own URL to the subject's grants", async () => {
    const { tunnel, pipe } = await agentTunnel("alice");
    expect(pipe.url).toBe(tunnel.url);
    expect((await embed.tunnels.get(tunnel.id)).state).toBe("live");
    const grant = await embed.grants.issue({ tunnel: tunnel.id, subject: "alice", kind: "client" });
    const response = await browserFetch(`${tunnel.url}/`, { headers: grantHeaders(grant.token!) });
    expect(response.status).toBe(200);
    const browser = await embed.grants.issue({
      tunnel: tunnel.id,
      subject: "alice",
      kind: "browser",
      next: "/home",
    });
    expect((await browserFetch(browser.launchUrl!)).headers.get("location")).toBe("/home");
    const usage = await embed.usage({ tenants: ["acme"] });
    expect(usage.tenants.acme?.openTunnels).toBeGreaterThanOrEqual(1);
  });

  it("stops for good when its integration stops the tunnel", async () => {
    const { tunnel, pipe } = await agentTunnel("alice");
    const closed = new Promise<string>((resolve) =>
      pipe.once("closed", (info) => resolve(info.reason)),
    );
    await embed.tunnels.stop(tunnel.id);
    expect(await closed).toBe("terminated");
    expect((await embed.tunnels.get(tunnel.id)).state).toBe("stopped");
  });

  it("refuses a name, viewers or an access key before dialling", async () => {
    const { connector } = await embed.tunnels.create({ tenant: "acme", owner: "bob" });
    for (const extra of [
      { name: "my-app" },
      { viewers: ["a@example.com"] },
      { accessKey: "k".repeat(40) },
    ]) {
      const refused = await openPipe({
        port: local.port,
        token: connector.connector,
        server: stack.url,
        ...extra,
      }).catch((error: unknown) => error);
      expect(refused).toMatchObject({ code: "invalid_option" });
    }
  });
});

describe("a page's tunnelSocket", () => {
  /** Opens like a page on `ORIGIN` would: the grant as a subprotocol. */
  const fromPage = (url: string, protocols: string[]) =>
    browserSocket(url, protocols, { origin: ORIGIN }) as never;

  it("connects with a grant, and a revoked grant is final", async () => {
    const { tunnel } = await agentTunnel("bob");
    const issued: string[] = [];
    const socket = tunnelSocket(`${tunnel.url.replace(/^http/, "ws")}/ws`, {
      grant: async () => {
        const grant = await embed.grants.issue({
          tunnel: tunnel.id,
          subject: "bob",
          kind: "client",
        });
        issued.push(grant.id);
        return grant.token!;
      },
      connect: fromPage,
    });
    await new Promise((resolve) => socket.addEventListener("open", resolve));
    expect(socket.protocol).toBe("wurmhol.grant");
    const echoed = new Promise((resolve) =>
      socket.addEventListener("message", (event) => resolve(String(event.data))),
    );
    socket.send("hi");
    expect(await echoed).toBe("hi");
    const closed = new Promise<number | undefined>((resolve) =>
      socket.addEventListener("close", (event) => resolve(event.code)),
    );
    await embed.grants.revoke(issued[0]!);
    expect(await closed).toBe(4403);
    expect(issued).toHaveLength(1);
  });

  it("renews an expired grant and reconnects", { timeout: 120_000 }, async () => {
    const { tunnel } = await agentTunnel("bob");
    let asked = 0;
    const socket = tunnelSocket(`${tunnel.url.replace(/^http/, "ws")}/ws`, {
      grant: async () => {
        asked += 1;
        const grant = await embed.grants.issue({
          tunnel: tunnel.id,
          subject: "bob",
          kind: "client",
          ttlSeconds: 60,
        });
        return grant.token!;
      },
      connect: fromPage,
    });
    await new Promise((resolve) => socket.addEventListener("open", resolve));
    await new Promise((resolve) => socket.addEventListener("renewed", resolve));
    expect(asked).toBe(2);
    socket.close();
  });
});
