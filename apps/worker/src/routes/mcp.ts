// The hosted MCP server (ADR 0014): `POST /mcp` on the CLI's host, for a person's assistant
// (claude.ai, Claude Desktop, ChatGPT, Claude Code) to list and end their orgs' pipes. It cannot
// open one: a hosted server cannot reach anyone's localhost. That stays with the CLI.
//
// Two bearers: an OAuth access token issued by our Better Auth to a client the person consented
// to (the path assistants take), or an `org`-scope `wh_` token for clients that send a fixed
// header. Every call reads the person's memberships afresh, so removing someone from an org takes
// effect on their next call, not when their token expires.
import { MCP_SCOPES, verifyMcpAccessToken } from "@wurmhol/auth";
import { findOpenShareByName, findShare, listOrgsForUser, schema, TOKEN_PREFIX } from "@wurmhol/db";
import { eq } from "drizzle-orm";
import { createMcpHandler, McpServer, requireScopes } from "@modelcontextprotocol/server";
import { z } from "zod";
import { checkToken } from "../bearer.ts";
import type { AppEnv } from "../context.ts";
import { SHARE_ID, type ShareCard } from "@wurmhol/protocol";
import { endShare } from "../ending.ts";
import { loggedError } from "../log.ts";
import { orgStub } from "../org-do.ts";
import { checkRateLimit } from "../rate-limiter.ts";

type Vars = AppEnv["Variables"];

/** An org the caller may act in. */
interface Reach {
  id: string;
  name: string;
}

/** Who is calling, and the orgs they reach. */
interface Caller {
  /** The rate-limit key: one person, or one token. */
  key: string;
  clientId: string;
  scopes: string[];
  orgs: Reach[];
}

/** The well-known path of this server's protected resource metadata (RFC 9728). */
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource/mcp";

function resourceMetadataUrl(resource: string) {
  return new URL(PROTECTED_RESOURCE_PATH, resource).toString();
}

/** A 401 an MCP client can act on: where to find the authorization server, and what to ask for. */
function challenge(resource: string, error?: { code: string; description: string }) {
  const params = [
    `resource_metadata="${resourceMetadataUrl(resource)}"`,
    `scope="${MCP_SCOPES.join(" ")}"`,
    ...(error ? [`error="${error.code}"`, `error_description="${error.description}"`] : []),
  ];

  return Response.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: error?.description ?? "sign in to Wurmhol first" },
    },
    { status: 401, headers: { "www-authenticate": `Bearer ${params.join(", ")}` } },
  );
}

/** A refusal that re-authorizing cannot fix, as a JSON-RPC error. */
function forbidden(message: string) {
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code: -32003, message } },
    { status: 403 },
  );
}

/** The caller behind the request's bearer, or the response that refuses them. */
async function authenticate(
  request: Request,
  vars: Vars,
  resource: string,
): Promise<Caller | Response> {
  const presented = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];

  if (!presented) return challenge(resource);

  if (presented.startsWith(TOKEN_PREFIX)) {
    const token = await checkToken(vars.db, vars.config, presented, { org: true });

    if (!token.ok) {
      return token.status === 403
        ? forbidden(token.fix)
        : challenge(resource, { code: "invalid_token", description: token.fix });
    }

    const [org] = await vars.db
      .select({ name: schema.organizations.name })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, token.orgId))
      .limit(1);

    return {
      key: `token:${token.id}`,
      clientId: `token:${token.id}`,
      scopes: [...MCP_SCOPES],
      orgs: [{ id: token.orgId, name: org?.name ?? token.orgId }],
    };
  }

  const grant = await verifyMcpAccessToken(vars.auth, presented, resource);

  if (!grant) {
    return challenge(resource, {
      code: "invalid_token",
      description: "The access token is invalid or expired.",
    });
  }

  const orgs = await listOrgsForUser(vars.db, grant.userId);

  return {
    key: `user:${grant.userId}`,
    clientId: grant.clientId,
    scopes: [...grant.scopes],
    orgs: orgs.map(({ id, name }) => ({ id, name })),
  };
}

/** A tool's result: the JSON as text, and as structured content for clients that read it. */
function result<T extends Record<string, unknown>>(value: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** The wall's card, with the org it belongs to. Nothing the wall does not show. */
function pipeOf(card: ShareCard, org: Reach) {
  return { ...card, org: { id: org.id, name: org.name } };
}

/** The tools, for one request and one caller. */
function buildServer(env: Env, vars: Vars, caller: Caller, waitSeconds: number) {
  const server = new McpServer({ name: "wurmhol", version: "1.0.0" });
  const cards = (orgId: string) => orgStub(env, orgId).list();
  const tooMany = () => toolError(`Too many requests. Wait ${waitSeconds} s and try again.`);
  const inReach = (orgId: string) => caller.orgs.find((o) => o.id === orgId);
  const read = requireScopes("pipes:read");

  /** A pipe by id or name, in one of the caller's orgs; null when there is none they reach. */
  const findPipe = async (pipe: string) => {
    const target = pipe.trim().toLowerCase();

    const id = SHARE_ID.test(target)
      ? target
      : ((await findOpenShareByName(vars.db, target))?.id ?? null);

    const share = id ? await findShare(vars.db, id) : null;
    const org = share ? inReach(share.orgId) : undefined;

    if (!share || !org) return null;
    const card = (await cards(org.id)).find((c) => c.id === share.id);

    return card ? { card, org } : null;
  };

  const notFound = (pipe: string) =>
    toolError(`No open pipe "${pipe}" in your orgs. list_pipes shows the open ones.`);

  server.registerTool(
    "list_orgs",
    {
      title: "List orgs",
      description: "The Wurmhol orgs you belong to, with how many pipes each has open.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      scopeChallenge: read,
    },
    async () => {
      if (waitSeconds) return tooMany();

      const orgs = await Promise.all(
        caller.orgs.map(async (org) => ({ ...org, openPipes: (await cards(org.id)).length })),
      );

      return result({ orgs });
    },
  );

  server.registerTool(
    "list_pipes",
    {
      title: "List open pipes",
      description:
        "Open pipes (private HTTPS URLs to dev servers) in your orgs, as the wall shows them: URL, port, page title, who started it and when, last request, viewers and where it came from (repo, branch, agent). Pass `org` (an id from list_orgs) for one org; every org by default.",
      inputSchema: z.object({
        org: z.string().optional().describe("An org id from list_orgs. Default: every org."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      scopeChallenge: read,
    },
    async ({ org }) => {
      if (waitSeconds) return tooMany();
      const orgs = org ? caller.orgs.filter((o) => o.id === org) : caller.orgs;

      if (org && orgs.length === 0)
        return toolError(`You are not in org "${org}". list_orgs shows yours.`);

      const pipes = (
        await Promise.all(orgs.map(async (o) => (await cards(o.id)).map((c) => pipeOf(c, o))))
      ).flat();

      return result({ pipes });
    },
  );

  server.registerTool(
    "get_pipe",
    {
      title: "Get a pipe",
      description: "One open pipe by its id or name, as the wall shows it.",
      inputSchema: z.object({ pipe: z.string().min(1).describe("The pipe's id or name.") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      scopeChallenge: read,
    },
    async ({ pipe }) => {
      if (waitSeconds) return tooMany();
      const found = await findPipe(pipe);

      return found ? result({ pipe: pipeOf(found.card, found.org) }) : notFound(pipe);
    },
  );

  server.registerTool(
    "stop_pipe",
    {
      title: "Stop a pipe",
      description:
        "Ends an open pipe now, as Terminate on the wall does: its URL stops working and the CLI that opened it hears it was terminated. Any member of the org may.",
      inputSchema: z.object({ pipe: z.string().min(1).describe("The pipe's id or name.") }),
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
      scopeChallenge: requireScopes("pipes:write"),
    },
    async ({ pipe }) => {
      if (waitSeconds) return tooMany();
      const found = await findPipe(pipe);

      if (!found) return notFound(pipe);
      await endShare(
        { env, var: vars },
        { id: found.card.id, orgId: found.org.id },
        "terminated",
        "mcp",
      );

      return result({ stopped: { id: found.card.id, url: found.card.url } });
    },
  );

  return server;
}

/** `/mcp`: authenticate, count the call, then serve it with a server built for this caller. */
export async function serveMcp(
  c: { env: Env; req: { raw: Request }; var: Vars },
  resource: string,
): Promise<Response> {
  const request = c.req.raw;
  const caller = await authenticate(request, c.var, resource);

  if (caller instanceof Response) return caller;
  const wait = await checkRateLimit(c.env, c.var.config, "mcp", caller.key);

  const handler = createMcpHandler(() => buildServer(c.env, c.var, caller, wait), {
    responseMode: "json",
    onerror: (error) => c.var.log.warn("mcp.error", { error: loggedError(error) }),
  });

  const response = await handler.fetch(request, {
    authInfo: {
      token: "",
      clientId: caller.clientId,
      scopes: caller.scopes,
      resource: new URL(resource),
      resourceMetadataUrl: resourceMetadataUrl(resource),
    },
  });

  if (!wait) return response;
  const headers = new Headers(response.headers);
  headers.set("retry-after", String(wait));

  return new Response(response.body, { status: response.status, headers });
}
