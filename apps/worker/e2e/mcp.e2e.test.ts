// `wurmhol mcp` against the real stack: the built CLI runs as a stdio MCP server, driven by the
// official MCP client over its stdin and stdout, as Claude Code or any other agent host would.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  alive,
  api,
  browserFetch,
  cliEnv,
  cliPath,
  createToken,
  localServer,
  type Person,
  signIn,
  type Stack,
  startStack,
  viewerCookie,
  waitFor,
} from "./support.ts";

interface PipeResult {
  id: string;
  url: string;
  port: number;
  name: string | null;
  startedAt: string;
  endsAt: string;
}

interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

let stack: Stack;
let ada: Person;

beforeAll(async () => {
  stack = await startStack();
  ada = await signIn(stack);
});

afterAll(async () => {
  await stack.stop();
});

/** Starts `wurmhol mcp` with `env` and connects the MCP client to it. */
async function connect(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "mcp"],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "wurmhol-e2e", version: "0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  return { client, transport, call };
}

const text = (result: ToolResult) => result.content.map((c) => c.text).join("\n");

const wall = async () =>
  (await api<{ shares: { id: string }[] }>(stack, ada, "/api/shares")).body.shares.map((s) => s.id);

const endReason = (id: string) => {
  const db = stack.db();
  try {
    return (
      (db.prepare("select end_reason from shares where id = ?").get(id) as {
        end_reason: string | null;
      }) ?? { end_reason: "missing" }
    );
  } finally {
    db.close();
  }
};

describe("wurmhol mcp", () => {
  it("opens a pipe a member can use, lists it, and stop_pipe by port ends it", async () => {
    const local = await localServer((req, res) =>
      res.writeHead(200, { "content-type": "text/plain" }).end(`mcp ${req.url}`),
    );
    const { client, call } = await connect(cliEnv(stack, (await createToken(stack, ada)).token));

    // Catches a tool missing from tools/list, or one advertised without its output schema.
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual(["list_pipes", "open_pipe", "stop_pipe"]);
    expect(tools.every((t) => t.outputSchema)).toBe(true);

    const opened = await call("open_pipe", { port: local.port });
    expect(opened.isError).toBeFalsy();
    const pipe = opened.structuredContent as unknown as PipeResult;
    expect(pipe.url).toBe(stack.shareUrl(pipe.id));
    expect(pipe.port).toBe(local.port);
    // The default lifetime reaches the agent, so it can tell the user when the URL dies.
    expect(Math.abs(Date.parse(pipe.endsAt) - Date.now() - 4 * 3600_000)).toBeLessThan(60_000);
    expect(text(opened).split("\n")[0]).toBe(pipe.url);

    const cookie = await viewerCookie(stack, ada, pipe.url);
    expect(await (await browserFetch(`${pipe.url}/hello`, { cookie })).text()).toBe("mcp /hello");
    expect(await wall()).toContain(pipe.id);

    const listed = await call("list_pipes");
    expect(listed.structuredContent).toEqual({ pipes: [pipe] });

    const stopped = await call("stop_pipe", { target: String(local.port) });
    expect(stopped.structuredContent).toEqual({ stopped: [{ id: pipe.id, url: pipe.url }] });
    expect((await browserFetch(`${pipe.url}/`, { cookie })).status).toBe(410);
    expect(endReason(pipe.id)).toEqual({ end_reason: "stopped" });
    expect(await wall()).not.toContain(pipe.id);
    expect((await call("list_pipes")).structuredContent).toEqual({ pipes: [] });

    // Catches a stop that silently succeeds on nothing: the agent would tell the user it ended.
    const again = await call("stop_pipe", { target: String(local.port) });
    expect(again.isError).toBe(true);
    expect(text(again)).toContain("wurmhol stop");

    await client.close();
    await local.close();
  });

  it("passes name and ttl through, and stops a pipe by its name", async () => {
    const local = await localServer((_req, res) => res.end("named"));
    const { client, call } = await connect(cliEnv(stack, (await createToken(stack, ada)).token));

    const before = Date.now();
    const opened = await call("open_pipe", { port: local.port, name: "Mcp-App", ttl: "90m" });
    expect(opened.isError).toBeFalsy();
    const pipe = opened.structuredContent as unknown as PipeResult;
    expect(pipe.url).toBe(stack.shareUrl("mcp-app"));
    expect(pipe.name).toBe("mcp-app");
    expect(Math.abs(Date.parse(pipe.endsAt) - before - 90 * 60_000)).toBeLessThan(60_000);

    expect((await call("stop_pipe", { target: "mcp-app" })).structuredContent).toEqual({
      stopped: [{ id: pipe.id, url: pipe.url }],
    });
    expect(endReason(pipe.id)).toEqual({ end_reason: "stopped" });

    // The relay's limit comes back as the fix, not as a crash or a generic failure.
    const long = await call("open_pipe", { port: local.port, ttl: "13h" });
    expect(long.isError).toBe(true);
    expect(text(long)).toBe("Pipes last at most 12h. Pass --ttl 12h or less.");

    await client.close();
    await local.close();
  });

  it("refuses `only` naming someone outside the org, with the relay's fix", async () => {
    const outsider = await signIn(stack);
    const { client, call } = await connect(cliEnv(stack, (await createToken(stack, ada)).token));
    const before = await wall();
    const result = await call("open_pipe", { port: 3000, only: [outsider.email] });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`${outsider.email} is not a member of the token's org`);
    expect(await wall()).toEqual(before);
    await client.close();
  });

  it("without a token, says to run wurmhol login or set WURMHOL_TOKEN", async () => {
    const { client, call } = await connect({
      WURMHOL_URL: stack.url,
      WURMHOL_HOME: mkdtempSync(join(tmpdir(), "wurmhol-home-")),
    });
    const result = await call("open_pipe", { port: 3000 });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      `No Wurmhol token. Run \`npx wurmhol login\` in a terminal, or set WURMHOL_TOKEN to a token from ${stack.url} (menu → Tokens) in this MCP server's environment, then call the tool again.`,
    );
    await client.close();
  });

  it("passes on the relay's fix for a token it does not know", async () => {
    const { client, call } = await connect(cliEnv(stack, "wh_unknown"));
    const result = await call("open_pipe", { port: 3000 });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      `Create a new token at ${stack.url} (menu → Tokens) and set WURMHOL_TOKEN.`,
    );
    await client.close();
  });

  // Catches pipes outliving the agent's session: shares nobody can stop from the agent any more.
  it("ends its pipes and exits when the client disconnects", async () => {
    const local = await localServer((_req, res) => res.end("ok"));
    const { client, transport, call } = await connect(
      cliEnv(stack, (await createToken(stack, ada)).token),
    );
    const ids = await Promise.all(
      [0, 1].map(
        async () =>
          (
            (await call("open_pipe", { port: local.port }))
              .structuredContent as unknown as PipeResult
          ).id,
      ),
    );
    const pid = transport.pid as number;
    expect(pid).toBeGreaterThan(0);
    expect(await wall()).toEqual(expect.arrayContaining(ids));

    await client.close();
    await waitFor(() => !alive(pid), { what: "the MCP server to exit" });
    for (const id of ids) expect(endReason(id)).toEqual({ end_reason: "stopped" });
    expect((await wall()).filter((id) => ids.includes(id))).toEqual([]);
    await local.close();
  });
});
