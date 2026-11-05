// `wurmhol mcp`: a stdio MCP server for agents that call tools instead of running commands.
// Each pipe is an `openPipe` held in this process (ADR 0008, section 3), so it lives as long as
// the agent's MCP session and ends with it; no daemon is left behind.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PIPE_NAME_RULE, parseDuration, pipeName } from "@wurmhol/protocol";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { readCredentials } from "./credentials.ts";
import { FixError } from "./errors.ts";
import { DEFAULT_CONSOLE, DEFAULT_SERVER, openPipe, type Pipe } from "./pipe.ts";

const INSTRUCTIONS = `Wurmhol gives a local dev server a private HTTPS URL that only members of the user's org can open, in their own browser, on any device.
When the user wants to see or try a server running here, call open_pipe with its port and send them the URL. Call stop_pipe when they are done. Pipes end when this MCP session ends.
Errors say the fix in one line: pass them on to the user as they are.`;

/** How long shutdown waits for the relay to confirm each pipe ended. */
const SHUTDOWN_MS = 5000;

interface Held {
  pipe: Pipe;
  name: string | null;
  startedAt: Date;
}

const pipeShape = {
  id: z.string().describe("The pipe's id, as on the wall"),
  url: z.string().describe("The private URL to send the user"),
  port: z.number().int(),
  name: z.string().nullable().describe("The pipe's name, when it keeps its URL"),
  startedAt: z.string().describe("ISO 8601"),
  endsAt: z.string().describe("When the pipe ends on its own (ISO 8601)"),
};

/** The install the CLI talks to: WURMHOL_URL, or wurmhol.com. */
function server() {
  const url = process.env.WURMHOL_URL || DEFAULT_SERVER;
  try {
    return new URL(url).origin;
  } catch {
    throw new FixError(`WURMHOL_URL is not a URL: ${url}`);
  }
}

/** The CLI's own rule: WURMHOL_TOKEN when set, else the token `wurmhol login` stored. */
function token() {
  const value = process.env.WURMHOL_TOKEN?.trim();
  if (value) return value;
  const origin = server();
  const stored = readCredentials();
  if (stored && stored.server === origin) return stored.token;
  const console = process.env.WURMHOL_URL ? origin : DEFAULT_CONSOLE;
  throw new FixError(
    `No Wurmhol token. Run \`npx wurmhol login\` in a terminal, or set WURMHOL_TOKEN to a token from ${console} (menu → Tokens) in this MCP server's environment, then call the tool again.`,
  );
}

function describe(held: Held) {
  const { pipe } = held;
  return {
    id: pipe.id,
    url: pipe.url,
    port: pipe.port,
    name: held.name,
    startedAt: held.startedAt.toISOString(),
    endsAt: pipe.endsAt.toISOString(),
  };
}

function ok<T extends Record<string, unknown>>(text: string, structuredContent: T) {
  return { content: [{ type: "text" as const, text }], structuredContent };
}

function failure(error: unknown) {
  const text = error instanceof FixError ? error.message : `Wurmhol failed: ${String(error)}`;
  return { content: [{ type: "text" as const, text }], isError: true };
}

/** Builds the server around `pipes`, the ones this process holds. */
export function createServer(pipes: Map<string, Held>) {
  const mcp = new McpServer(
    { name: "wurmhol", version: pkg.version },
    { instructions: INSTRUCTIONS },
  );

  mcp.registerTool(
    "open_pipe",
    {
      title: "Open a pipe",
      description:
        "Give a local port a private HTTPS URL that members of the user's org can open in their own browser. Returns once the URL works. Send the URL to the user.",
      inputSchema: {
        port: z.number().int().min(1).max(65535).describe("The port the dev server listens on"),
        ttl: z
          .string()
          .optional()
          .describe("How long the pipe lasts, like 90m or 8h. Default 4h, at most 12h"),
        name: z
          .string()
          .optional()
          .describe(
            `Keep the same URL every time (https://<name>.<pipe domain>), e.g. for an OAuth redirect URI. ${PIPE_NAME_RULE}`,
          ),
        only: z
          .array(z.string())
          .optional()
          .describe("Emails of the org members who may open it. Default: every member"),
      },
      outputSchema: pipeShape,
      annotations: { openWorldHint: true },
    },
    async ({ port, ttl, name, only }) => {
      try {
        let seconds: number | undefined;
        if (ttl !== undefined) {
          seconds = parseDuration(ttl) ?? undefined;
          if (seconds === undefined) throw new FixError(`Not a lifetime: ${ttl}. Use 90m or 8h.`);
        }
        if (name !== undefined && !pipeName(name)) {
          throw new FixError(`Not a pipe name: ${name}. Use ${PIPE_NAME_RULE}.`);
        }
        const viewers = only?.map((email) => email.trim()).filter(Boolean);
        const pipe = await openPipe({
          server: server(),
          token: token(),
          port,
          ttl: seconds,
          viewers,
          name,
          log: (event, fields) => {
            if (event === "connected") return;
            process.stderr.write(`wurmhol: port ${port}: ${event} ${JSON.stringify(fields)}\n`);
          },
        });
        const held: Held = { pipe, name: name ? pipeName(name) : null, startedAt: new Date() };
        pipes.set(pipe.id, held);
        pipe.once("close", () => pipes.delete(pipe.id));
        const result = describe(held);
        return ok(`${pipe.url}\nPort ${port}, ends ${result.endsAt}. Id ${pipe.id}.`, result);
      } catch (error) {
        return failure(error);
      }
    },
  );

  mcp.registerTool(
    "list_pipes",
    {
      title: "List pipes",
      description:
        "The pipes this MCP server has open. Pipes started with `npx wurmhol` in a terminal are listed by `wurmhol ls` instead.",
      outputSchema: { pipes: z.array(z.object(pipeShape)) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const list = [...pipes.values()].map(describe);
      const text = list.length
        ? list.map((p) => `${p.port}\t${p.url}\t${p.id}\tends ${p.endsAt}`).join("\n")
        : "No open pipes. Open one with open_pipe.";
      return ok(text, { pipes: list });
    },
  );

  mcp.registerTool(
    "stop_pipe",
    {
      title: "Stop a pipe",
      description:
        "End a pipe this MCP server opened, by port, id or name; its URL stops working at once. `all` ends every one.",
      inputSchema: {
        target: z.string().optional().describe("The pipe's port, id or name"),
        all: z.boolean().optional().describe("End every pipe this server has open"),
      },
      outputSchema: { stopped: z.array(z.object({ id: z.string(), url: z.string() })) },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ target, all }) => {
      try {
        if (!all && !target) throw new FixError("Say which pipe: a port, id or name, or all.");
        const wanted = target?.trim().toLowerCase();
        const chosen = [...pipes.values()].filter(
          ({ pipe, name }) =>
            all ||
            pipe.id === target ||
            String(pipe.port) === wanted ||
            name === wanted ||
            new URL(pipe.url).hostname.split(".")[0] === wanted,
        );
        if (!chosen.length && !all) {
          throw new FixError(
            `No open pipe for ${target} in this MCP session. See list_pipes; pipes started with \`npx wurmhol\` stop with \`wurmhol stop ${target}\`.`,
          );
        }
        await Promise.all(chosen.map(({ pipe }) => pipe.close()));
        const stopped = chosen.map(({ pipe }) => ({ id: pipe.id, url: pipe.url }));
        const text = stopped.length
          ? stopped.map((s) => `stopped ${s.url}`).join("\n")
          : "No open pipes.";
        return ok(text, { stopped });
      } catch (error) {
        return failure(error);
      }
    },
  );

  return mcp;
}

/** Serves MCP on stdin and stdout until the client goes away, then ends every pipe it opened. */
export async function serve() {
  const pipes = new Map<string, Held>();
  const mcp = createServer(pipes);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const closing = Promise.all([...pipes.values()].map(({ pipe }) => pipe.close()));
    await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, SHUTDOWN_MS))]);
    process.exit(0);
  };
  // The client ends the session by closing our stdin (MCP stdio transport).
  process.stdin.once("end", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  await mcp.connect(new StdioServerTransport());
}
