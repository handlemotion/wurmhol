// The detached process that holds a share opened by `npx wurmhol <port>` (or by `wurmhol host`),
// so the command can print the URL and return. Both ends of the handoff live here: the CLI runs
// itself with `DAEMON_COMMAND` and the share's options, and the daemon reports over IPC once it
// has the URL or knows why it cannot.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { FixError } from "./errors.ts";
import { appendLog, appendRequest } from "./logs.ts";
import { openPipe, type Pipe, type PipeSource } from "./pipe.ts";
import { detectSource } from "./source.ts";
import { pipeName } from "@wurmhol/protocol";
import { logFile, removeState, type ShareRequest, writeState } from "./state.ts";

/** The hidden command the CLI's entry runs as the daemon. */
export const DAEMON_COMMAND = "__daemon";

/** A share as the command line asked for it, already checked. */
export interface ShareOptions {
  port: number;
  /** Seconds; the relay's default when absent. */
  ttl?: number;
  /** `--only`: comma-separated emails. */
  only?: string;
  name?: string;
  link?: string;
  note?: string;
}

/** The parts of `options` a reused pipe must match. */
export function shareRequest(options: ShareOptions): ShareRequest {
  const only = (options.only ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  return {
    name: options.name === undefined ? null : pipeName(options.name),
    only: [...new Set(only)].toSorted(),
    link: options.link ?? null,
    note: options.note ?? null,
  };
}

export type ReadyMessage =
  | { type: "ready"; id: string; url: string; endsAt: string }
  | { type: "error"; message: string };

/**
 * Starts the daemon by running `entry` (the CLI's own file) detached, in `cwd`, and waits for it
 * to report the URL (or the reason it could not).
 */
export async function startDaemon(
  entry: string,
  options: ShareOptions,
  cwd?: string,
): Promise<ReadyMessage> {
  const child = spawn(process.execPath, [entry, DAEMON_COMMAND, JSON.stringify(options)], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: process.env,
    cwd,
  });
  const message = await new Promise<ReadyMessage>((resolve) => {
    child.once("message", (m) => resolve(m as ReadyMessage));
    child.once("exit", (code) =>
      resolve({
        type: "error",
        message: `the pipe process exited (${code}); see ${logFile("daemon")}`,
      }),
    );
  });
  child.removeAllListeners("exit");
  if (message.type === "ready") {
    child.disconnect();
    child.unref();
  }
  return message;
}

/** Bounds of the wait between reopen attempts: doubling, capped. */
const REOPEN_FIRST_MS = 1000;
const REOPEN_MAX_MS = 60_000;

/** Ends the daemon once its pipe has ended for good. */
function exit(pipe: Pipe): never {
  removeState(pipe.id);
  process.exit(0);
}

/**
 * The daemon: holds the share's pipe until it ends. `argument` is what `startDaemon` passed.
 *
 * A pipe that ends `disconnected` (the relay's reconnect grace ran out, e.g. while a laptop slept)
 * is opened again for the same port and options, with backoff, until one opens or the daemon is
 * stopped: a named pipe gets its URL back, an unnamed one a new URL. The new pipe keeps the old
 * one's end time. Every other reason, and a refusal no retry can get past, ends the daemon.
 */
export async function runDaemon(argument: string, connection: { server: string; token: string }) {
  const options = JSON.parse(argument) as ShareOptions;
  const { port, only, name, link, note } = options;
  const report = (message: ReadyMessage) => process.send?.(message);
  const log = (shareId: string | null, event: string, fields: Record<string, unknown>) =>
    appendLog(shareId ?? `port-${port}`, event, { port, ...fields });
  // SIGTERM (`wurmhol stop`) aborts: it closes the open pipe, or ends a wait to reopen one.
  const stopping = new AbortController();
  const { signal } = stopping;
  const viewers = only
    ?.split(",")
    .map((email) => email.trim())
    .filter(Boolean);
  let source: Partial<PipeSource>;
  const open = (ttl: number | undefined) =>
    openPipe({ ...connection, port, ttl, viewers, name, source, signal }, { log });
  const hold = (pipe: Pipe) => {
    pipe.on("request", (request) => appendRequest(pipe.id, request, { port }));
    pipe.once("close", (reason) => {
      if (reason === "disconnected" && !signal.aborted) void reopen(pipe);
      else exit(pipe);
    });
    writeState({
      id: pipe.id,
      url: pipe.url,
      port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      endsAt: pipe.endsAt.toISOString(),
      request: shareRequest(options),
    });
  };

  // The old pipe's state file stays until the new one is written, so `wurmhol stop` and
  // `wurmhol logs` still find this daemon by its port, id or name while it retries.
  const reopen = async (old: Pipe) => {
    log(old.id, "reopening", {});
    let wait = REOPEN_FIRST_MS;
    while (!signal.aborted) {
      try {
        await sleep(wait, undefined, { signal });
      } catch {
        break;
      }
      wait = Math.min(wait * 2, REOPEN_MAX_MS);
      const left = Math.ceil((old.endsAt.getTime() - Date.now()) / 1000);
      if (left < 1) {
        log(old.id, "reopen.ended", { reason: "expired" });
        break;
      }
      let pipe: Pipe;
      try {
        pipe = await open(left);
      } catch (error) {
        if (signal.aborted) break;
        const message = error instanceof Error ? error.message : String(error);
        log(old.id, "reopen.failed", { message });
        if (error instanceof FixError && error.final) break;
        continue;
      }
      for (const id of [old.id, pipe.id]) log(id, "reopened", { from: old.id, to: pipe.id });
      hold(pipe);
      if (pipe.id !== old.id) removeState(old.id);
      return;
    }
    exit(old);
  };

  let pipe: Pipe;
  try {
    source = { ...(await detectSource(process.cwd(), process.env)), link, note };
    pipe = await open(options.ttl);
  } catch (error) {
    report({ type: "error", message: error instanceof FixError ? error.message : String(error) });
    process.exit(1);
  }
  hold(pipe);
  const stop = () => stopping.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", () => {}); // The terminal that started it may close.
  report({ type: "ready", id: pipe.id, url: pipe.url, endsAt: pipe.endsAt.toISOString() });
  process.disconnect?.();
}
