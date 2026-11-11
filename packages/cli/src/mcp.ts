// `wurmhol mcp`: a stdio MCP server for agents that call tools instead of running commands.
// Each pipe is an `openPipe` held in this process (ADR 0008, section 3), so it lives as long as
// the agent's MCP session and ends with it; no daemon is left behind. With no token, open_pipe
// returns a share login's approval link at once and opens the pipe here once it is approved
// (ADR 0026).
import { hostname } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MAX_PORT, PIPE_NAME_RULE, parseDuration, pipeName } from "@wurmhol/protocol";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { findToken, server } from "./config.ts";
import { writeCredentials } from "./credentials.ts";
import { awaitLogin, FixError, type Pipe, startLogin } from "@wurmhol/sdk";
import { pagePath, pageUrl } from "@wurmhol/sdk/internal";
import { appendRequest, recentRequests } from "./logs.ts";
import { openPipe } from "./open.ts";
import { listStates, matches } from "./state.ts";

const INSTRUCTIONS = `Wurmhol gives a local dev server a private HTTPS URL that only members of the user's org can open, in their own browser, on any device.
When the user wants to see or try a server running here, call open_pipe with its port and send them the URL. Call stop_pipe when they are done. Pipes end when this MCP session ends.
If this computer is not logged in yet, open_pipe returns an approval link instead: send it to the user. The pipe opens once they approve it, and the page becomes the pipe; list_pipes then shows its URL.
When the user says something is broken on the page they opened, call recent_requests to see what their browser asked for and what the dev server answered.
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

/**
 * A share login this process started because it had no token (ADR 0026): its approval link, and
 * the pipes to open once someone approves it, one per port.
 */
interface PendingLogin {
  id: string;
  url: string;
  startedAt: Date;
  endsAt: Date;
  opens: Map<number, (token: string) => Promise<unknown>>;
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

  /** Holds `pipe` until it ends: listed, logged, stopped with the session. */
  const hold = (pipe: Pipe, name: string | null) => {
    const held: Held = { pipe, name, startedAt: new Date() };
    pipes.set(pipe.id, held);
    pipe.on("request", (request) => appendRequest(pipe.id, request, { port: pipe.port }));
    pipe.once("close", () => pipes.delete(pipe.id));
    return held;
  };

  // One login per process: a second port asked for while it waits opens with the same approval.
  let login: Promise<PendingLogin> | null = null;
  const pendingLogin = (port: number) => {
    login ??= (async () => {
      const code = await startLogin({
        server: server(),
        name: hostname(),
        version: pkg.version,
        port,
      });
      const pending: PendingLogin = {
        id: `login-${code.user_code}`,
        url: code.verification_uri_complete,
        startedAt: new Date(),
        endsAt: new Date(Date.now() + code.expires_in * 1000),
        opens: new Map(),
      };
      void (async () => {
        try {
          const granted = await awaitLogin({ server: server(), version: pkg.version, code });
          writeCredentials({
            server: server(),
            token: granted.token,
            org: granted.org.name,
            name: granted.name,
          });
          login = null;
          for (const [waiting, open] of pending.opens) {
            open(granted.token).catch((error: unknown) =>
              process.stderr.write(`wurmhol: port ${waiting}: ${String(error)}\n`),
            );
          }
        } catch (error) {
          login = null;
          const message = error instanceof FixError ? error.message : String(error);
          process.stderr.write(`wurmhol: login: ${message}\n`);
        }
      })();
      return pending;
    })();
    // A code that could not be started is not kept: the next call asks again.
    login.catch(() => (login = null));
    return login;
  };

  mcp.registerTool(
    "open_pipe",
    {
      title: "Open a pipe",
      description:
        "Give a local port a private HTTPS URL that members of the user's org can open in their own browser. Returns once the URL works. Send the URL to the user. If this computer is not logged in, returns an approval link at once instead (approval: true): send that to the user, and the pipe opens once they approve it.",
      inputSchema: {
        port: z.number().int().min(1).max(MAX_PORT).describe("The port the dev server listens on"),
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
        path: z
          .string()
          .optional()
          .describe(
            "A page to send the user to, like /checkout?step=2: the result's pageUrl opens there",
          ),
      },
      outputSchema: {
        ...pipeShape,
        pageUrl: z.string().optional().describe("The URL at `path`, when one was given"),
        approval: z
          .boolean()
          .optional()
          .describe(
            "True when `url` is an approval link: this computer is not logged in yet, and the pipe opens once the user approves it",
          ),
      },
      annotations: { openWorldHint: true },
    },
    async ({ port, ttl, name, only, path }) => {
      try {
        const page = path === undefined ? undefined : pagePath(path);
        let seconds: number | undefined;
        if (ttl !== undefined) {
          seconds = parseDuration(ttl) ?? undefined;
          if (seconds === undefined) throw new FixError(`Not a lifetime: ${ttl}. Use 90m or 8h.`);
        }
        if (name !== undefined && !pipeName(name)) {
          throw new FixError(`Not a pipe name: ${name}. Use ${PIPE_NAME_RULE}.`);
        }
        const viewers = only?.map((email) => email.trim()).filter(Boolean);
        const open = async (token: string) =>
          hold(
            await openPipe({
              server: server(),
              token,
              port,
              ttl: seconds,
              viewers,
              name,
              log: (event, fields) => {
                if (event === "connected") return;
                process.stderr.write(`wurmhol: port ${port}: ${event} ${JSON.stringify(fields)}\n`);
              },
            }),
            name ? pipeName(name) : null,
          );
        const token = findToken();
        if (!token) {
          const pending = await pendingLogin(port);
          if (!pending.opens.has(port)) pending.opens.set(port, open);
          return ok(
            `${pending.url}\nNot logged in yet. Send this link to the user: once someone in their org approves this computer there, port ${port} opens and the page becomes the pipe. list_pipes shows its URL after.`,
            {
              id: pending.id,
              url: pending.url,
              port,
              name: name ? pipeName(name) : null,
              startedAt: pending.startedAt.toISOString(),
              endsAt: pending.endsAt.toISOString(),
              approval: true,
            },
          );
        }
        const held = await open(token);
        const { pipe } = held;
        const result = describe(held);
        const at = page === undefined ? undefined : pageUrl(pipe.url, page);
        return ok(`${at ?? pipe.url}\nPort ${port}, ends ${result.endsAt}. Id ${pipe.id}.`, {
          ...result,
          ...(at ? { pageUrl: at } : {}),
        });
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
    "recent_requests",
    {
      title: "Recent requests",
      description:
        "The last requests the user's browser made through a pipe on this machine, oldest first: method, path (query values left out), the dev server's status and how long it took. Use it to see what failed, e.g. a 500 on /api/checkout. Works for pipes opened here and with `npx wurmhol`.",
      inputSchema: {
        target: z.string().describe("The pipe's port, id or name"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("How many requests, newest last. Default 20"),
      },
      outputSchema: {
        id: z.string(),
        url: z.string(),
        requests: z.array(
          z.object({
            time: z.string().describe("When the request finished (ISO 8601)"),
            method: z.string(),
            path: z.string(),
            status: z.number().int(),
            durationMs: z.number(),
          }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ target, limit }) => {
      try {
        const wanted = target.trim().toLowerCase();
        const own = [...pipes.values()]
          .filter(
            ({ pipe, name }) =>
              pipe.id === target ||
              String(pipe.port) === wanted ||
              name === wanted ||
              new URL(pipe.url).hostname.split(".")[0] === wanted,
          )
          .map(({ pipe }) => ({ id: pipe.id, url: pipe.url }));
        const found =
          own.at(-1) ??
          listStates()
            .filter((s) => matches(s, target))
            .at(-1);
        if (!found) {
          throw new FixError(
            `No open pipe for ${target} on this machine. See list_pipes, or \`wurmhol ls\`.`,
          );
        }
        const requests = recentRequests(found.id, limit ?? 20) ?? [];
        const text = requests.length
          ? requests
              .map((r) => `${r.time}  ${r.method} ${r.path}  ${r.status}  ${r.durationMs} ms`)
              .join("\n")
          : `No requests through ${found.url} yet.`;
        return ok(text, { id: found.id, url: found.url, requests });
      } catch (error) {
        return failure(error);
      }
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
