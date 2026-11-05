// The detached process that holds a share opened by `npx wurmhol <port>` (or by `wurmhol host`),
// so the command can print the URL and return. Both ends of the handoff live here: the CLI runs
// itself with `DAEMON_COMMAND` and the share's options, and the daemon reports over IPC once it
// has the URL or knows why it cannot.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { FixError } from "./errors.ts";
import { openPipe, type Pipe } from "./pipe.ts";
import { detectSource } from "./source.ts";
import { logFile, removeState, writeState } from "./state.ts";

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

/** The daemon: holds the share's pipe until it ends. `argument` is what `startDaemon` passed. */
export async function runDaemon(argument: string, connection: { server: string; token: string }) {
  const { port, ttl, only, name, link, note } = JSON.parse(argument) as ShareOptions;
  const report = (message: ReadyMessage) => process.send?.(message);
  const log = (shareId: string | null, event: string, fields: Record<string, unknown>) => {
    try {
      appendFileSync(
        logFile(shareId ?? `port-${port}`),
        `${JSON.stringify({ time: new Date().toISOString(), event, port, ...fields })}\n`,
      );
    } catch {
      // Logging must never take the share down.
    }
  };
  let pipe: Pipe;
  try {
    const viewers = only
      ?.split(",")
      .map((email) => email.trim())
      .filter(Boolean);
    const source = { ...(await detectSource(process.cwd(), process.env)), link, note };
    pipe = await openPipe({ ...connection, port, ttl, viewers, name, source }, { log });
  } catch (error) {
    report({ type: "error", message: error instanceof FixError ? error.message : String(error) });
    process.exit(1);
  }
  pipe.once("close", () => {
    removeState(pipe.id);
    process.exit(0);
  });
  writeState({
    id: pipe.id,
    url: pipe.url,
    port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    endsAt: pipe.endsAt.toISOString(),
  });
  const stop = () => void pipe.close();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", () => {}); // The terminal that started it may close.
  report({ type: "ready", id: pipe.id, url: pipe.url, endsAt: pipe.endsAt.toISOString() });
  process.disconnect?.();
}
