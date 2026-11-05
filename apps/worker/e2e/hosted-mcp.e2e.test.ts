// The hosted MCP server (ADR 0014) against the real stack: the official MCP clients (SDK v2 with
// its OAuth flow, and SDK v1 with a fixed header) over Streamable HTTP to `/mcp` on the CLI's
// host, Better Auth as the authorization server, and pipes opened by the real CLI.
//
// Clients normally register by Client ID Metadata Document, which the Worker fetches over public
// HTTPS; a local stack has none. The suite seeds the client row that discovery would create.
import { randomUUID } from "node:crypto";
import {
  Client,
  type OAuthClientProvider,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  waitFor,
} from "./support.ts";

const CLIENT_ID = "e2e-assistant";
const REDIRECT = "http://127.0.0.1:9/callback";

interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface Pipe {
  id: string;
  url: string;
  port: number;
  org: { id: string; name: string };
}

let stack: Stack;
/** The MCP server, on the CLI's host (127.0.0.1); the app is on localhost. */
let mcpUrl: string;
let ada: Person;
let bob: Person;
const envs: Record<string, string>[] = [];

beforeAll(async () => {
  stack = await startStack({ CONNECT_HOST: "127.0.0.1", RATE_LIMIT_MCP: "off" });
  mcpUrl = `http://127.0.0.1:${stack.port}/mcp`;
  [ada, bob] = await Promise.all([signIn(stack), signIn(stack)]);
  // The first request to Better Auth seeds the MCP resource; the client links to it.
  await fetch(`${stack.url}/.well-known/oauth-authorization-server`);
  const db = stack.db({ write: true });
  try {
    const now = Date.now();
    db.prepare(
      `insert into oauth_clients (id, client_id, name, redirect_uris, token_endpoint_auth_method,
         grant_types, response_types, scopes, require_pkce, created_at, updated_at)
       values (?, ?, 'E2E Assistant', ?, 'none', ?, '["code"]', ?, 1, ?, ?)`,
    ).run(
      randomUUID(),
      CLIENT_ID,
      JSON.stringify([REDIRECT]),
      JSON.stringify(["authorization_code", "refresh_token"]),
      JSON.stringify(["pipes:read", "pipes:write", "offline_access"]),
      now,
      now,
    );
    db.prepare(
      "insert into oauth_client_resources (id, client_id, resource_id, created_at) values (?, ?, ?, ?)",
    ).run(randomUUID(), CLIENT_ID, mcpUrl, now);
  } finally {
    db.close();
  }
});

afterAll(async () => {
  await Promise.all(envs.map(stopAll));
  await stack.stop();
});

/** What an assistant host keeps between runs: its tokens and the PKCE verifier. */
class Assistant implements OAuthClientProvider {
  authorizationUrl: URL | undefined;
  #tokens: Parameters<OAuthClientProvider["saveTokens"]>[0] | undefined;
  #verifier = "";
  readonly redirectUrl = REDIRECT;
  readonly clientMetadata = {
    client_name: "E2E Assistant",
    redirect_uris: [REDIRECT],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  clientInformation() {
    return { client_id: CLIENT_ID };
  }
  tokens() {
    return this.#tokens;
  }
  saveTokens(tokens: Parameters<OAuthClientProvider["saveTokens"]>[0]) {
    this.#tokens = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.#verifier = verifier;
  }
  codeVerifier() {
    return this.#verifier;
  }
}

/** The OAuth flow as a person in a browser walks it: authorize, consent, back to the client. */
async function authorize(person: Person, url: URL, scope?: string) {
  const toConsent = await browserFetch(url.toString(), { cookie: person.cookie });
  const consent = new URL(toConsent.headers.get("location") ?? "", stack.url);
  expect(consent.pathname).toBe("/oauth/consent");
  const decided = await api<{ url: string }>(stack, person, "/api/auth/oauth2/consent", {
    method: "POST",
    body: { accept: true, oauth_query: consent.search.slice(1), ...(scope ? { scope } : {}) },
  });
  expect(decided.status).toBe(200);
  const back = new URL(decided.body.url);
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
  return back.searchParams;
}

/** An assistant connected as `person`, through the whole OAuth flow. */
async function connectAs(person: Person, scope?: string) {
  const provider = new Assistant();
  const first = new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider });
  await expect(new Client({ name: "e2e", version: "0" }).connect(first)).rejects.toThrow(
    UnauthorizedError,
  );
  expect(provider.authorizationUrl).toBeDefined();
  await first.finishAuth(await authorize(person, provider.authorizationUrl!, scope));
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  return { client, call, provider };
}

/** A pipe from the real CLI, with a token of `person`'s active org. */
async function openPipe(person: Person) {
  const local = await localServer((_req, res) => res.end("hello"));
  const env = cliEnv(stack, (await createToken(stack, person)).token);
  envs.push(env);
  return { ...(await share(stack, env, local.port)), local };
}

const pipesOf = (result: ToolResult) => (result.structuredContent as { pipes: Pipe[] }).pipes;

const endReason = (id: string) => {
  const db = stack.db();
  try {
    return (
      db.prepare("select end_reason from shares where id = ?").get(id) as {
        end_reason: string | null;
      }
    ).end_reason;
  } finally {
    db.close();
  }
};

describe("hosted MCP server", () => {
  it("sends a signed-out person through the login page and back to authorize", async () => {
    const provider = new Assistant();
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      authProvider: provider,
    });
    await expect(new Client({ name: "e2e", version: "0" }).connect(transport)).rejects.toThrow(
      UnauthorizedError,
    );
    // Catches discovery that points clients at the wrong place: the token must be for this URL.
    expect(provider.authorizationUrl!.origin).toBe(stack.url);
    expect(provider.authorizationUrl!.searchParams.get("resource")).toBe(mcpUrl);

    const toLogin = await browserFetch(provider.authorizationUrl!.toString());
    const login = new URL(toLogin.headers.get("location") ?? "", stack.url);
    expect(login.pathname).toBe("/oauth/login");
    const toPage = await browserFetch(login.toString());
    const page = new URL(toPage.headers.get("location") ?? "", stack.url);
    expect(page.pathname).toBe("/login");
    // Catches a hand-off that loses the request, or one that loops back to login once signed in.
    const next = page.searchParams.get("next")!;
    expect(next.startsWith("/api/auth/oauth2/authorize?")).toBe(true);
    expect(new URLSearchParams(next.split("?")[1]).get("client_id")).toBe(CLIENT_ID);
    const signedIn = await browserFetch(`${stack.url}${next}`, { cookie: ada.cookie });
    expect(new URL(signedIn.headers.get("location") ?? "", stack.url).pathname).toBe(
      "/oauth/consent",
    );
  });

  it("lists the person's pipes and stop_pipe ends one, as Terminate on the wall does", async () => {
    const pipe = await openPipe(ada);
    const { client, call } = await connectAs(ada);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual([
      "get_pipe",
      "list_orgs",
      "list_pipes",
      "stop_pipe",
    ]);
    // Catches a destructive tool a host would call without asking the person first.
    expect(tools.find((t) => t.name === "stop_pipe")?.annotations?.destructiveHint).toBe(true);

    const orgs = (await call("list_orgs")).structuredContent as {
      orgs: { id: string; openPipes: number }[];
    };
    expect(orgs.orgs).toHaveLength(1);
    expect(orgs.orgs[0]!.openPipes).toBe(1);

    const listed = pipesOf(await call("list_pipes"));
    expect(listed.map((p) => [p.id, p.url, p.port])).toEqual([[pipe.id, pipe.url, pipe.port]]);
    expect((await call("get_pipe", { pipe: pipe.id })).structuredContent).toMatchObject({
      pipe: { id: pipe.id, url: pipe.url },
    });

    const stopped = await call("stop_pipe", { pipe: pipe.id });
    expect(stopped.structuredContent).toEqual({ stopped: { id: pipe.id, url: pipe.url } });
    // The CLI hears `terminated`, and the pipe is gone from the wall and from the tools.
    await waitFor(() => endReason(pipe.id) === "terminated", { what: "pipe terminated" });
    expect(pipesOf(await call("list_pipes"))).toEqual([]);
    expect((await call("get_pipe", { pipe: pipe.id })).isError).toBe(true);

    await client.close();
    await pipe.local.close();
  });

  it("never reaches another org's pipe, and loses an org on the next call after removal", async () => {
    const bobs = await openPipe(bob);
    const { client, call } = await connectAs(ada);

    // Catches a lookup by id that skips the org check.
    expect((await call("get_pipe", { pipe: bobs.id })).isError).toBe(true);
    const refused = await call("stop_pipe", { pipe: bobs.id });
    expect(refused.isError).toBe(true);
    expect(endReason(bobs.id)).toBeNull();
    expect(pipesOf(await call("list_pipes")).map((p) => p.id)).not.toContain(bobs.id);

    // Ada joins Bob's org: the same access token now reaches it.
    const { body: invite } = await api<{ url: string }>(stack, bob, "/api/invites", {
      method: "POST",
    });
    const code = invite.url.split("/join/")[1]!;
    expect((await api(stack, ada, `/api/invites/${code}/accept`, { method: "POST" })).status).toBe(
      200,
    );
    expect(pipesOf(await call("list_pipes")).map((p) => p.id)).toContain(bobs.id);

    // Bob removes her. Catches memberships baked into the token: it is still valid for an hour.
    const { body: members } = await api<{ members: { id: string; email: string }[] }>(
      stack,
      bob,
      "/api/members",
    );
    const member = members.members.find((m) => m.email === ada.email)!;
    expect((await api(stack, bob, `/api/members/${member.id}`, { method: "DELETE" })).status).toBe(
      200,
    );
    expect(pipesOf(await call("list_pipes")).map((p) => p.id)).not.toContain(bobs.id);
    expect((await call("stop_pipe", { pipe: bobs.id })).isError).toBe(true);
    expect(endReason(bobs.id)).toBeNull();

    await client.close();
    await bobs.local.close();
  });

  it("a read-only grant can list but not stop", async () => {
    const pipe = await openPipe(ada);
    const { client, call, provider } = await connectAs(ada, "pipes:read");
    expect(pipesOf(await call("list_pipes")).map((p) => p.id)).toContain(pipe.id);
    // Catches a write scope the person never granted being honoured anyway. The refusal is an
    // insufficient_scope challenge, so the client goes back to ask the person for pipes:write.
    provider.authorizationUrl = undefined;
    await expect(call("stop_pipe", { pipe: pipe.id })).rejects.toThrow(UnauthorizedError);
    expect(provider.authorizationUrl!.searchParams.get("scope")).toContain("pipes:write");
    expect(endReason(pipe.id)).toBeNull();
    await client.close();
    await pipe.local.close();
  });

  it("takes an org token as a fixed header, from a 2025-era client", async () => {
    const pipe = await openPipe(ada);
    const connect = async (token: string) => {
      const client = new LegacyClient({ name: "e2e-legacy", version: "0" });
      await client.connect(
        new LegacyTransport(new URL(mcpUrl), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      return client;
    };
    const org = await connect((await createToken(stack, ada, "mcp", { scope: "org" })).token);
    const listed = (await org.callTool({ name: "list_pipes", arguments: {} })) as ToolResult;
    expect(pipesOf(listed).map((p) => p.id)).toContain(pipe.id);
    await org.close();

    // Catches a pipes-only token (what the CLI holds) reaching every pipe of the org.
    const pipesToken = (await createToken(stack, ada, "cli")).token;
    await expect(connect(pipesToken)).rejects.toThrow("This token can only open pipes.");
    await pipe.local.close();
  });

  it("lives on the CLI's host only, and keeps Better Auth's other OAuth routes closed", async () => {
    const onApp = await fetch(`${stack.url}/mcp`, { method: "POST", body: "{}" });
    expect(onApp.status).toBe(404);
    const metadata = await fetch(
      `http://127.0.0.1:${stack.port}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(await metadata.json()).toMatchObject({
      resource: mcpUrl,
      authorization_servers: [stack.url],
    });
    // Catches client management or session JWTs reachable by any signed-in person.
    for (const path of ["/api/auth/oauth2/get-clients", "/api/auth/token"]) {
      expect((await browserFetch(`${stack.url}${path}`, { cookie: ada.cookie })).status).toBe(404);
    }
    const created = await api(stack, ada, "/api/auth/oauth2/create-client", {
      method: "POST",
      body: { redirect_uris: ["https://evil.example/cb"] },
    });
    expect(created.status).toBe(404);
  });
});
