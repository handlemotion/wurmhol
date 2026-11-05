#!/usr/bin/env node
// wurmhol: share a local dev server at a private HTTPS URL (spec section 7).
//
//   npx wurmhol <port> [--ttl 8h] [--json] [--only <emails>] [--name <name>]
//                      [--link <url>] [--note <text>]
//                                 start a share; prints its URL first, then returns
//   wurmhol ls [--json]           open shares on this machine
//   wurmhol stop <port|id|name>   end one; `--all` ends every one
//   wurmhol init [--skill]        tell the repo's agents how to share
//   wurmhol host                  connect this computer to the wall; open pipes from the browser
//   wurmhol mcp                   a stdio MCP server with the same tools, for agents
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  formatDuration,
  parseDuration,
  PIPE_NAME_RULE,
  pipeName,
  SOURCE_FIXES,
  sourceField,
} from "@wurmhol/protocol";
import pkg from "../package.json" with { type: "json" };
import skill from "../../../plugins/wurmhol/skills/wurmhol/SKILL.md";
import {
  credentialsFile,
  readCredentials,
  removeCredentials,
  writeCredentials,
} from "./credentials.ts";
import { FixError } from "./errors.ts";
import { host as runHost } from "./host.ts";
import { login as deviceLogin } from "./login.ts";
import { DEFAULT_CONSOLE, DEFAULT_SERVER, openPipe, type Pipe } from "./pipe.ts";
import { detectSource } from "./source.ts";
import { alive, listStates, logFile, removeState, writeState } from "./state.ts";

/** The line `init` writes, with the repo's dev port (spec section 7). */
const initLine = (port: number) =>
  `Share the dev server with \`npx wurmhol ${port}\` (or the port it prints) and send the user the URL; end it with \`npx wurmhol stop ${port}\`.`;

/** Dev servers' default ports, first match wins; anything else is a Worker on 8787. */
const DEV_PORTS: [name: string, port: number][] = [
  ["next", 3000],
  ["astro", 4321],
  ["vite", 5173],
];

const HELP = `wurmhol ${pkg.version}: a private HTTPS URL for a local dev server

Usage:
  npx wurmhol <port> [--json]   Open a pipe to a port; prints the URL, then returns
    --ttl <duration>            How long it lasts, like 90m or 8h (default 4h, at most 12h)
    --only a@x.com,b@y.com      Only these members of the org may open it
    --name <name>               Keep the same URL every time (https://<name>.<pipe domain>),
                                e.g. for an OAuth redirect URI
    --link <url>                A link to show with the pipe on the wall, like the issue
    --note <text>               One line to show with the pipe on the wall
  wurmhol ls [--json]           List open pipes
  wurmhol stop <port|id|name>   End a pipe (--all ends every one)
  wurmhol init [--skill]        Tell this repo's agents how to share (AGENTS.md or
                                CLAUDE.md); --skill also writes .claude/skills/wurmhol
  wurmhol host                  Connect this computer to the wall, to open pipes to its
                                ports from Create pipe in the browser; logs in first if needed
  wurmhol login                 Approve this computer in the browser; stores a token
  wurmhol logout                Delete the stored token
  wurmhol mcp                   Run an MCP server on stdio (open_pipe, list_pipes,
                                stop_pipe); pipes end when the MCP session ends

Environment:
  WURMHOL_TOKEN   A token from your org (${DEFAULT_CONSOLE}, menu → Tokens); wins over login
  WURMHOL_HOME    Where wurmhol keeps its state (default ~/.wurmhol)
  WURMHOL_URL     A self-hosted install (default ${DEFAULT_SERVER})

The wall shows where each pipe came from: the git repo, branch and commit of the
directory it was opened in, and the agent session, when the environment names one.
  HTTPS_PROXY     Dial out through this proxy; NODE_EXTRA_CA_CERTS adds its CA
`;

type ReadyMessage =
  | { type: "ready"; id: string; url: string; endsAt: string }
  | { type: "error"; message: string };

function fail(message: string): never {
  process.stderr.write(`wurmhol: ${message}\n`);
  process.exit(1);
}

function parsePort(value: string | undefined) {
  const port = Number(value);
  if (!value || !/^\d+$/.test(value) || port < 1 || port > 65535) return null;
  return port;
}

/** Where people make tokens: the console, or a self-hosted install's own origin. */
function consoleUrl() {
  return process.env.WURMHOL_URL ? server() : DEFAULT_CONSOLE;
}

function server() {
  const url = process.env.WURMHOL_URL || DEFAULT_SERVER;
  try {
    return new URL(url).origin;
  } catch {
    fail(`WURMHOL_URL is not a URL: ${url}`);
  }
}

/** WURMHOL_TOKEN when set, else the token `wurmhol login` stored for this server, else null. */
function findToken() {
  const value = process.env.WURMHOL_TOKEN?.trim();
  if (value) return value;
  const stored = readCredentials();
  return stored && stored.server === server() ? stored.token : null;
}

function token() {
  const found = findToken();
  if (found) return found;
  fail(`Run wurmhol login, or set WURMHOL_TOKEN to a token from ${consoleUrl()} (menu → Tokens).`);
}

async function login() {
  try {
    const granted = await deviceLogin({
      server: server(),
      name: hostname(),
      version: pkg.version,
      prompt: (code) =>
        process.stdout.write(`Open ${code.verification_uri} and enter ${code.user_code}\n`),
    });
    writeCredentials({
      server: server(),
      token: granted.token,
      org: granted.org.name,
      name: granted.name,
    });
    const org = granted.org.name ? ` to ${granted.org.name}` : "";
    process.stdout.write(
      `Logged in${org} as ${granted.name}. Token saved in ${credentialsFile()}\n`,
    );
    if (process.env.WURMHOL_TOKEN?.trim()) {
      process.stdout.write("WURMHOL_TOKEN is set and wins over the saved token.\n");
    }
  } catch (error) {
    fail(error instanceof FixError ? error.message : String(error));
  }
}

function logout() {
  const removed = removeCredentials();
  process.stdout.write(removed ? `Deleted ${credentialsFile()}\n` : "Not logged in.\n");
}

/** Starts the detached daemon and waits for it to report the URL (or the reason it could not). */
async function startDaemon(
  port: number,
  options: {
    ttl?: number;
    only?: string;
    name?: string;
    link?: string;
    note?: string;
    cwd?: string;
  } = {},
): Promise<ReadyMessage> {
  const entry = fileURLToPath(import.meta.url);
  const args = [
    entry,
    "__daemon",
    String(port),
    ...(options.ttl === undefined ? [] : [String(options.ttl)]),
    ...(options.only ? ["--only", options.only] : []),
    ...(options.name ? ["--name", options.name] : []),
    ...(options.link ? ["--link", options.link] : []),
    ...(options.note ? ["--note", options.note] : []),
  ];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: process.env,
    cwd: options.cwd,
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

async function share(
  port: number,
  ttl: number | undefined,
  json: boolean,
  only: string | undefined,
  name: string | undefined,
  extra: { link?: string; note?: string },
) {
  token();
  const message = await startDaemon(port, { ttl, only, name, ...extra });
  if (message.type === "error") fail(message.message);
  const { url, id, endsAt } = message;
  const out = json ? JSON.stringify({ url, port, id, endsAt }) : url;
  process.stdout.write(`${out}\n`);
}

/**
 * `wurmhol host`: logs in if there is no token yet, then keeps this computer connected to the
 * wall. A port picked there opens as `wurmhol <port>` would, from the home directory (its git
 * repo is not this one's to tell), and keeps running if this process ends.
 */
async function serveHost() {
  if (!findToken()) await login();
  const say = (line: string) => process.stdout.write(`${line}\n`);
  try {
    await runHost({
      server: server(),
      token: token(),
      name: hostname(),
      version: pkg.version,
      say,
      open: async (port) => {
        const open = listStates().find((s) => s.port === port);
        if (open) return open.url;
        const message = await startDaemon(port, { cwd: homedir() });
        if (message.type === "error") throw new FixError(message.message);
        return message.url;
      },
    });
  } catch (error) {
    fail(error instanceof FixError ? error.message : String(error));
  }
}

/** The daemon: holds the share's pipe until it ends. Reports readiness over IPC. */
async function daemon(
  port: number,
  ttl: number | undefined,
  only: string | undefined,
  name: string | undefined,
  extra: { link?: string; note?: string },
) {
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
    const source = { ...(await detectSource(process.cwd(), process.env)), ...extra };
    pipe = await openPipe(
      { server: server(), token: token(), port, ttl, viewers, name, source },
      { log },
    );
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

function ls(json: boolean) {
  const states = listStates();
  if (json) {
    process.stdout.write(
      `${JSON.stringify(states.map(({ id, url, port, startedAt, endsAt }) => ({ id, url, port, startedAt, endsAt })))}\n`,
    );
    return;
  }
  if (!states.length) {
    process.stdout.write("No open pipes. Start one with: npx wurmhol <port>\n");
    return;
  }
  for (const s of states) {
    const left = Math.max(0, Math.round((Date.parse(s.endsAt) - Date.now()) / 60_000)) * 60;
    const ends = left ? `ends in ${formatDuration(left)}` : "ends in under a minute";
    process.stdout.write(`${s.port}\t${s.url}\t${s.id}\t${ends}\n`);
  }
}

async function stop(target: string | undefined, all: boolean) {
  const states = listStates();
  const port = parsePort(target);
  const chosen = all
    ? states
    : states.filter(
        (s) =>
          s.id === target ||
          (port !== null && s.port === port) ||
          // A named pipe, by the first label of its host.
          new URL(s.url).hostname.split(".")[0] === target?.toLowerCase(),
      );
  if (!all && !target) fail("Say which share: wurmhol stop <port|id|name>, or --all.");
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

/** The dev server's port, from package.json's dependencies and scripts. */
function devPort(cwd: string): number {
  let manifest: { dependencies?: object; devDependencies?: object; scripts?: object } = {};
  try {
    manifest = JSON.parse(readIfExists(join(cwd, "package.json")) ?? "{}");
  } catch {
    // Not JSON: no hints.
  }
  const deps = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
  const scripts = Object.values(manifest.scripts ?? {}).join("\n");
  for (const [name, port] of DEV_PORTS) {
    if (deps.has(name) || new RegExp(`(^|[\\s;&|(])${name}(\\s|$)`, "m").test(scripts)) return port;
  }
  return 8787;
}

function init(writeSkill: boolean) {
  const cwd = process.cwd();
  const port = devPort(cwd);
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
  const say = (line: string) => process.stdout.write(`${line}\n`);
  if (current.includes("npx wurmhol")) {
    say(`${relative(cwd, target)} already mentions wurmhol`);
  } else {
    const separator = current && !current.endsWith("\n") ? "\n\n" : current ? "\n" : "";
    appendFileSync(target, `${separator}${initLine(port)}\n`);
    say(`Added a line to ${relative(cwd, target)} (port ${port}, from package.json)`);
  }
  if (writeSkill) {
    const dir = join(cwd, ".claude/skills/wurmhol");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), skill);
    say(`Wrote ${relative(cwd, join(dir, "SKILL.md"))}`);
  }
  const stored = readCredentials();
  if (process.env.WURMHOL_TOKEN?.trim()) {
    say("WURMHOL_TOKEN is set.");
  } else if (stored && stored.server === server()) {
    say(`Logged in: wurmhol uses the token in ${credentialsFile()}.`);
  } else {
    const host = new URL(server()).hostname;
    say(
      `No token. On this computer, run wurmhol login. Where the agent runs, set WURMHOL_TOKEN to a token from ${consoleUrl()} (menu → Tokens).`,
    );
    say(
      `In a Claude Code cloud environment: WURMHOL_TOKEN under Environment variables, ${host} under Allowed domains.`,
    );
  }
}

const SEE_FLAGS = "Run `npx wurmhol@latest --help` to see the flags.";

/** parseArgs' own errors, as one line that names the flag; anything else is a bug and rethrows. */
function explainArgsError(error: unknown, args: string[]): string {
  const { code, message } = error as { code?: string; message?: string };
  // `-h=1` reads as the short flags -h, -= and -1, so parseArgs blames '-='. Name the real flag.
  const shortWithValue = args.find((arg) => /^-[^-]=/.test(arg));
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && message?.includes("'-='") && shortWithValue) {
    return `${shortWithValue.slice(0, 2)} takes no value. ${SEE_FLAGS}`;
  }
  // parseArgs quotes the offending token: '--bogus', '-x', or '-h, --help' for a known flag.
  const quoted = /'([^']*)'/.exec(message ?? "")?.[1] ?? "";
  const flag = quoted.match(/-{1,2}[\w-]+/g)?.at(-1) ?? quoted;
  switch (code) {
    case "ERR_PARSE_ARGS_UNKNOWN_OPTION":
      return `Unknown flag ${flag}. ${SEE_FLAGS}`;
    case "ERR_PARSE_ARGS_INVALID_OPTION_VALUE":
      return message?.includes("argument missing")
        ? `${flag} needs a value. ${SEE_FLAGS}`
        : `${flag} takes no value. ${SEE_FLAGS}`;
    case "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL":
      return `Unexpected argument ${quoted}. ${SEE_FLAGS}`;
    default:
      throw error;
  }
}

function parseCommandLine(args = process.argv.slice(2)) {
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        only: { type: "string" },
        name: { type: "string" },
        link: { type: "string" },
        note: { type: "string" },
        all: { type: "boolean", default: false },
        skill: { type: "boolean", default: false },
        ttl: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    fail(explainArgsError(error, args));
  }
}

async function main() {
  const { values, positionals } = parseCommandLine();
  const [command, argument] = positionals;
  if (values.version) return void process.stdout.write(`${pkg.version}\n`);
  if (values.help || !command) return void process.stdout.write(HELP);
  if (command === "__daemon") {
    const ttl = positionals[2] === undefined ? undefined : Number(positionals[2]);
    return daemon(parsePort(argument) ?? fail("bad port"), ttl, values.only, values.name, {
      link: values.link,
      note: values.note,
    });
  }
  if (command === "ls") return ls(values.json);
  if (command === "stop") return stop(argument, values.all);
  if (command === "init") return init(values.skill);
  if (command === "login") return login();
  if (command === "host") return serveHost();
  if (command === "logout") return logout();
  if (command === "mcp") return (await import("./mcp.ts")).serve();
  const port = parsePort(command);
  if (port === null) fail(`Not a port or a command: ${command}. See: wurmhol --help`);
  let ttl: number | undefined;
  if (values.ttl !== undefined) {
    ttl =
      parseDuration(values.ttl) ??
      fail(`Not a lifetime: ${values.ttl}. Use --ttl 90m or --ttl 8h.`);
  }
  if (values.name !== undefined && !pipeName(values.name)) {
    fail(`Not a pipe name: ${values.name}. Use ${PIPE_NAME_RULE}.`);
  }
  for (const field of ["link", "note"] as const) {
    const value = values[field];
    if (value !== undefined && sourceField(field, value) === null) fail(SOURCE_FIXES[field]);
  }
  return share(port, ttl, values.json, values.only, values.name, {
    link: values.link,
    note: values.note,
  });
}

await main();
