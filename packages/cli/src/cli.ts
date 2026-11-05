#!/usr/bin/env node
// wurmhol: share a local dev server at a private HTTPS URL (spec section 7).
//
//   npx wurmhol <port> [--json]   start a share; prints its URL first, then returns
//   wurmhol ls [--json]           open shares on this machine
//   wurmhol stop <port|id>        end one; `--all` ends every one
//   wurmhol init                  tell the repo's agents how to share
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { FixError } from "./errors.ts";
import { alive, listStates, logFile, removeState, writeState } from "./state.ts";
import { Tunnel } from "./tunnel.ts";

const DEFAULT_SERVER = "https://wurmhol.com";
const INIT_LINE = "Share a local server with `npx wurmhol <port>` and send the user the URL.";

const HELP = `wurmhol ${pkg.version}: a private HTTPS URL for a local dev server

Usage:
  npx wurmhol <port> [--json]   Open a pipe to a port; prints the URL, then returns
  wurmhol ls [--json]           List open pipes
  wurmhol stop <port|id>        End a pipe (--all ends every one)
  wurmhol init                  Add a line about wurmhol to AGENTS.md or CLAUDE.md

Environment:
  WURMHOL_TOKEN   A token from your org (menu → Tokens)
  WURMHOL_URL     A self-hosted install (default ${DEFAULT_SERVER})
  HTTPS_PROXY     Dial out through this proxy; NODE_EXTRA_CA_CERTS adds its CA
`;

type ReadyMessage = { type: "ready"; id: string; url: string } | { type: "error"; message: string };

function fail(message: string): never {
  process.stderr.write(`wurmhol: ${message}\n`);
  process.exit(1);
}

function parsePort(value: string | undefined) {
  const port = Number(value);
  if (!value || !/^\d+$/.test(value) || port < 1 || port > 65535) return null;
  return port;
}

function server() {
  const url = process.env.WURMHOL_URL || DEFAULT_SERVER;
  try {
    return new URL(url).origin;
  } catch {
    fail(`WURMHOL_URL is not a URL: ${url}`);
  }
}

function token() {
  const value = process.env.WURMHOL_TOKEN?.trim();
  if (!value) fail(`Set WURMHOL_TOKEN to a token from ${server()} (menu → Tokens).`);
  return value;
}

/** Starts the detached daemon and waits for it to report the URL (or the reason it could not). */
async function share(port: number, json: boolean) {
  token();
  const entry = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [entry, "__daemon", String(port)], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: process.env,
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
  if (message.type === "error") fail(message.message);
  child.disconnect();
  child.unref();
  const out = json ? JSON.stringify({ url: message.url, port, id: message.id }) : message.url;
  process.stdout.write(`${out}\n`);
}

/** The daemon: holds the share's socket until it ends. Reports readiness over IPC. */
async function daemon(port: number) {
  const report = (message: ReadyMessage) => process.send?.(message);
  const log = (event: string, fields: Record<string, unknown> = {}) => {
    try {
      appendFileSync(
        logFile(tunnel.share?.id ?? `port-${port}`),
        `${JSON.stringify({ time: new Date().toISOString(), event, port, ...fields })}\n`,
      );
    } catch {
      // Logging must never take the share down.
    }
  };
  const tunnel: Tunnel = new Tunnel({
    server: server(),
    token: token(),
    port,
    version: pkg.version,
    log,
    onEnd: (reason) => {
      log("ended", { reason });
      if (tunnel.share) removeState(tunnel.share.id);
      process.exit(0);
    },
  });
  let info;
  try {
    info = await tunnel.start();
  } catch (error) {
    report({ type: "error", message: error instanceof FixError ? error.message : String(error) });
    process.exit(1);
  }
  writeState({ ...info, port, pid: process.pid, startedAt: new Date().toISOString() });
  const stop = () => void tunnel.stop();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", () => {}); // The terminal that started it may close.
  report({ type: "ready", ...info });
  process.disconnect?.();
}

function ls(json: boolean) {
  const states = listStates();
  if (json) {
    process.stdout.write(
      `${JSON.stringify(states.map(({ id, url, port, startedAt }) => ({ id, url, port, startedAt })))}\n`,
    );
    return;
  }
  if (!states.length) {
    process.stdout.write("No open pipes. Start one with: npx wurmhol <port>\n");
    return;
  }
  for (const s of states) process.stdout.write(`${s.port}\t${s.url}\t${s.id}\n`);
}

async function stop(target: string | undefined, all: boolean) {
  const states = listStates();
  const port = parsePort(target);
  const chosen = all
    ? states
    : states.filter((s) => s.id === target || (port !== null && s.port === port));
  if (!all && !target) fail("Say which share: wurmhol stop <port|id>, or --all.");
  if (!chosen.length) {
    if (all) return;
    fail(`No open pipe for ${target}. See: wurmhol ls`);
  }
  for (const s of chosen) {
    try {
      process.kill(s.pid, "SIGTERM");
    } catch {
      removeState(s.id);
    }
  }
  // Return once their processes are gone, so a following `ls` (or a new share) agrees.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && chosen.some((s) => alive(s.pid))) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  for (const s of chosen) removeState(s.id);
  for (const s of chosen) process.stdout.write(`stopped ${s.url}\n`);
}

/** A file's text, or null when it does not exist. */
function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function init() {
  const cwd = process.cwd();
  // Read instead of checking existence first, then append: no window where the file can change
  // between a check and the write.
  let target = join(cwd, "AGENTS.md");
  let current = "";
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const text = readIfExists(join(cwd, name));
    if (text === null) continue;
    target = join(cwd, name);
    current = text;
    break;
  }
  if (current.includes("npx wurmhol")) {
    process.stdout.write(`${target} already mentions wurmhol\n`);
    return;
  }
  const separator = current && !current.endsWith("\n") ? "\n\n" : current ? "\n" : "";
  appendFileSync(target, `${separator}${INIT_LINE}\n`);
  process.stdout.write(`added a line to ${target}\n`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  const [command, argument] = positionals;
  if (values.version) return void process.stdout.write(`${pkg.version}\n`);
  if (values.help || !command) return void process.stdout.write(HELP);
  if (command === "__daemon") return daemon(parsePort(argument) ?? fail("bad port"));
  if (command === "ls") return ls(values.json);
  if (command === "stop") return stop(argument, values.all);
  if (command === "init") return init();
  const port = parsePort(command);
  if (port === null) fail(`Not a port or a command: ${command}. See: wurmhol --help`);
  return share(port, values.json);
}

await main();
