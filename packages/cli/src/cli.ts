#!/usr/bin/env node
// wurmhol: share a local dev server at a private HTTPS URL (spec section 7).
//
//   npx wurmhol <port> [--ttl 8h] [--json] [--only <emails>] [--name <name>]
//                      [--link <url>] [--note <text>] [--path </page>]
//                                 start a share; prints its URL first, then returns
//   wurmhol ls [--json]           open shares on this machine
//   wurmhol stop <port|id|name>   end one; `--all` ends every one
//   wurmhol logs <port|id|name>   a pipe's recent requests and events (`--follow`, `--json`)
//   wurmhol init [--skill]        tell the repo's agents how to share
//   wurmhol host                  connect this computer to the wall; open pipes from the browser
//                                 (--install runs it at login, --uninstall removes that)
//   wurmhol doctor [--port N]     check the token, proxy, allowlist and port a pipe needs
//   wurmhol mcp                   a stdio MCP server with the same tools, for agents
//   wurmhol domain add|ls|verify|rm   your own hostname on a pipe name (ADR 0033)
import { homedir, hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  formatDuration,
  isPort,
  parseDuration,
  PIPE_NAME_RULE,
  pipeName,
  SOURCE_FIXES,
  sourceField,
} from "@wurmhol/protocol";
import pkg from "../package.json" with { type: "json" };
import { allowlistLine, consoleUrl, envToken, findToken, savedLogin, server } from "./config.ts";
import { credentialsFile, removeCredentials, writeCredentials } from "./credentials.ts";
import {
  DAEMON_COMMAND,
  type LoginMessage,
  runDaemon,
  type ShareOptions,
  shareRequest,
  startDaemon,
} from "./daemon.ts";
import { doctor as runDoctor, formatCheck } from "./doctor.ts";
import {
  type Domain,
  domains as domainsClient,
  FixError,
  login as deviceLogin,
  redeem,
  startLogin,
} from "@wurmhol/sdk";
import {
  DEFAULT_CONSOLE,
  DEFAULT_SERVER,
  errorCode,
  pagePath,
  pageUrl,
} from "@wurmhol/sdk/internal";
import { host as runHost } from "./host.ts";
import { init } from "./init.ts";
import { followLog, type LogRecord, readLog, requestOf } from "./logs.ts";
import { checkService, installService, stableEntry, uninstallService } from "./service.ts";
import { alive, listStates, logFile, matches, removeState, type ShareState } from "./state.ts";

/** This file: the daemon and the login service run it again. */
const entry = fileURLToPath(import.meta.url);

const HELP = `wurmhol ${pkg.version}: a private HTTPS URL for a local dev server

Usage:
  npx wurmhol <port> [--json]   Open a pipe to a port; prints the URL, then returns.
                                Run again with the same flags, it prints the open pipe's
                                URL; wurmhol stop <port> first for a new one (--ttl always
                                opens a new one). With no token it prints a link instead:
                                approving this computer there opens the pipe
    --ttl <duration>            How long it lasts, like 90m or 8h (default 4h, at most 12h)
    --only a@x.com,b@y.com      Only these members of the org may open it
    --name <name>               Keep the same URL every time (https://<name>.<pipe domain>),
                                e.g. for an OAuth redirect URI
    --link <url>                A link to show with the pipe on the wall, like the issue
    --note <text>               One line to show with the pipe on the wall
    --path </page>              Print the URL opened at this page, like /checkout?step=2
                                (also pageUrl in --json); the same pipe either way
  wurmhol ls [--json]           List open pipes
  wurmhol stop <port|id|name>   End a pipe (--all ends every one)
  wurmhol logs <port|id|name>   A pipe's recent requests (method, path, status, time) and
                                connection events, kept on this machine only
    -f, --follow                Keep printing new lines
    --json                      One JSON object a line
  wurmhol init [--skill]        Tell this repo's agents how to share (AGENTS.md or
                                CLAUDE.md); --skill also writes .claude/skills/wurmhol
  wurmhol host                  Connect this computer to the wall, to open pipes to its
                                ports from Create pipe in the browser; logs in first if needed
    --code <code>               Log in with the setup code in Create pipe's command
    --install                   Run it at login and keep it running (macOS, Linux with
                                systemd); needs npm install -g wurmhol
    --uninstall                 Stop running it at login
  wurmhol doctor                Check what a pipe needs: the token, HTTPS_PROXY and its CA,
                                and that the network allows the CLI's host and the pipe
                                domain; one line each, ok or the fix. Exits 1 if any fails
    --port <port>               Also check that the port answers HTTP (127.0.0.1 or ::1)
    --json                      {checks: [{name, ok, detail, fix}]}
  wurmhol domain add <hostname> --name <pipe>
                                Put your own hostname on a pipe name, like
                                preview.acme.dev on acme-app: prints the two DNS records to
                                publish; needs a token that can list and close every pipe
  wurmhol domain verify <hostname>
                                Check it now (--wait keeps checking until it is active)
  wurmhol domain ls [--json]    List the org's domains and where each stands
  wurmhol domain rm <hostname>  Remove one
  wurmhol login                 Approve this computer in the browser; stores a token
  wurmhol logout                Delete the stored token
  wurmhol mcp                   Run an MCP server on stdio (open_pipe, list_pipes,
                                recent_requests, stop_pipe); pipes end when the MCP
                                session ends

Environment:
  WURMHOL_TOKEN   A token from your org (${DEFAULT_CONSOLE}, menu → Tokens); wins over login
  WURMHOL_HOME    Where wurmhol keeps its state (default ~/.wurmhol)
  WURMHOL_ACCESS_KEY  Lets clients with no browser session open the pipe: they send it as the
                      x-wurmhol-key header (32 to 128 of A-Z a-z 0-9 - _); only its hash is kept
  WURMHOL_URL     A self-hosted install (default ${DEFAULT_SERVER})
  WURMHOL_HOST_IGNORE  Ports wurmhol host never lists, like 9229,5555

The wall shows where each pipe came from: the git repo, branch and commit of the
directory it was opened in, and the agent session, when the environment names one.
  HTTPS_PROXY     Dial out through this proxy; NODE_EXTRA_CA_CERTS adds its CA
`;

/** Exits with one line: a FixError's fix, or what went wrong. */
function fail(cause: unknown): never {
  const message = cause instanceof FixError ? cause.message : String(cause);
  process.stderr.write(`wurmhol: ${message}\n`);
  process.exit(1);
}

function parsePort(value: string | undefined) {
  const port = Number(value);

  if (!value || !/^\d+$/.test(value) || !isPort(port)) return null;

  return port;
}

function token() {
  const found = findToken();

  if (found) return found;
  fail(`Run wurmhol login, or set WURMHOL_TOKEN to a token from ${consoleUrl()} (menu → Tokens).`);
}

/** Stores a granted token as this server's login and says so. */
function saveLogin(granted: { token: string; org: { name: string | null }; name: string }) {
  writeCredentials({
    server: server(),
    token: granted.token,
    org: granted.org.name,
    name: granted.name,
  });
  const org = granted.org.name ? ` to ${granted.org.name}` : "";
  process.stdout.write(`Logged in${org} as ${granted.name}. Token saved in ${credentialsFile()}\n`);
}

async function login() {
  process.stdout.write(`${allowlistLine()}\n`);

  try {
    const granted = await deviceLogin({
      server: server(),
      name: hostname(),
      version: pkg.version,
      prompt: (code) =>
        process.stdout.write(`Open ${code.verification_uri} and enter ${code.user_code}\n`),
    });

    saveLogin(granted);

    if (envToken()) {
      process.stdout.write("WURMHOL_TOKEN is set and wins over the saved token.\n");
    }
  } catch (error) {
    fail(error);
  }
}

function logout() {
  const removed = removeCredentials();
  process.stdout.write(removed ? `Deleted ${credentialsFile()}\n` : "Not logged in.\n");
}

/**
 * The live pipe this machine already has for the same command, if any: same port, name, `--only`,
 * link and note, and no `--ttl` (asking for a lifetime asks for a new pipe).
 */
function reusable(options: ShareOptions): ShareState | undefined {
  if (options.ttl !== undefined) return undefined;
  const wanted = JSON.stringify(shareRequest(options));

  return listStates().find(
    (s) => s.port === options.port && s.request && JSON.stringify(s.request) === wanted,
  );
}

/** A pipe as `--json` prints it. `approval` is only there when set. */
interface PrintedPipe {
  url: string;
  port: number;
  id: string;
  endsAt: string;
  pageUrl?: string;
  approval?: true;
}

function printedPipe(
  pipe: Pick<PrintedPipe, "url" | "port" | "id" | "endsAt">,
  page: string | undefined,
  approval: boolean | undefined,
): PrintedPipe {
  const printed: PrintedPipe = { ...pipe };

  if (page) printed.pageUrl = page;

  if (approval) printed.approval = true;

  return printed;
}

/** A pipe as `wurmhol ls --json` lists it. `approval` is only there when set. */
interface ListedPipe {
  id: string;
  url: string;
  port: number;
  startedAt: string;
  endsAt: string;
  approval?: true;
}

/**
 * What `wurmhol <port>` prints: the URL (at `--path`, when given), or the JSON for `--json`. A
 * share waiting for approval prints its approval link instead (ADR 0026).
 */
function printPipe(
  pipe: {
    url: string;
    port: number;
    id: string;
    endsAt: string;
    approval?: boolean;
    follows?: string;
  },
  path: string | undefined,
  json: boolean,
) {
  const { url, port, id, endsAt, approval, follows } = pipe;
  const page = path === undefined || approval ? undefined : pageUrl(url, path);

  const out = json
    ? JSON.stringify(printedPipe({ url, port, id, endsAt }, page, approval))
    : (page ?? url);

  process.stdout.write(`${out}\n`);

  if (follows) {
    process.stderr.write(
      "Not logged in yet, and another share is already waiting on this link: this pipe opens once someone in your org approves it.\n",
    );
  } else if (approval) {
    process.stderr.write(
      "Not logged in yet. Send this link to someone in your org: it opens the pipe once they approve this computer.\n",
    );
  }
}

async function share(options: ShareOptions, json: boolean, path: string | undefined) {
  const { port } = options;
  // Agents re-run commands: the same command again prints the same pipe, not a second one.
  const open = reusable(options);

  if (open) {
    printPipe(open, path, json);

    if (!json && !open.approval) {
      process.stderr.write(
        `Already open. For a new URL: wurmhol stop ${port}, then run this again.\n`,
      );
    }

    return;
  }

  // No token: the link it prints logs this computer in and then opens the pipe (ADR 0026). One
  // login per computer: while another share waits on its link, this one waits on the same link.
  let pending: LoginMessage | undefined;
  let follows: string | undefined;

  if (!findToken()) {
    const leader = listStates().find((s) => s.approval && !s.follows);

    if (leader) {
      follows = leader.id;
      pending = {
        type: "follow",
        leader: { id: leader.id, url: leader.url, endsAt: leader.endsAt },
      };
    } else {
      try {
        const code = await startLogin({
          server: server(),
          name: hostname(),
          version: pkg.version,
          port,
        });

        pending = { type: "login", code };
      } catch (error) {
        fail(error);
      }
    }
  }

  const message = await startDaemon(entry, options, undefined, pending);

  if (message.type === "error") fail(message.message);
  printPipe({ ...message, port, approval: message.type === "approval", follows }, path, json);
}

/**
 * `wurmhol host`: logs in with Create pipe's setup code when given one (ADR 0020), else if there
 * is no token yet, then keeps this computer connected to the wall. A port picked there opens as
 * `wurmhol <port>` would, from the home directory (its git repo is not this one's to tell), and
 * keeps running if this process ends.
 */
async function serveHost(code: string | undefined) {
  const say = (line: string) => process.stdout.write(`${line}\n`);
  let granted: string | null = null;

  if (code) {
    try {
      const redeemed = await redeem({
        server: server(),
        code,
        name: hostname(),
        version: pkg.version,
      });

      saveLogin(redeemed);
      granted = redeemed.token;
    } catch (error) {
      fail(error);
    }
  } else if (!findToken()) {
    await login();
  }

  try {
    await runHost({
      server: server(),
      // The card's code names the org the person is looking at, so it wins over WURMHOL_TOKEN.
      token: granted ?? token(),
      name: hostname(),
      version: pkg.version,
      say,
      open: async (port) => {
        const open = listStates().find((s) => s.port === port);

        if (open) return open.url;
        const message = await startDaemon(entry, { port }, homedir());

        if (message.type === "error") throw new FixError(message.message);

        return message.url;
      },
    });
  } catch (error) {
    fail(error);
  }
}

/**
 * `wurmhol host --install`: logs in if this computer has no saved token (the service reads that
 * file, never WURMHOL_TOKEN), then runs this installed CLI's `host` at login.
 */
async function installHost() {
  try {
    const stable = stableEntry(entry);
    checkService();

    if (!savedLogin()) await login();
    const env: Record<string, string> = {};

    for (const name of ["WURMHOL_HOME", "WURMHOL_URL"] as const) {
      const value = process.env[name];

      if (value) env[name] = value;
    }

    const log = logFile("host");
    const file = installService({ node: process.execPath, entry: stable, env, log });
    process.stdout.write(
      `Installed ${file}: wurmhol host is running and starts at login. Logs: ${log}\n`,
    );
  } catch (error) {
    fail(error);
  }
}

function uninstallHost() {
  try {
    const file = uninstallService();
    process.stdout.write(file ? `Removed ${file}\n` : "wurmhol host is not installed.\n");
  } catch (error) {
    fail(error);
  }
}

function ls(json: boolean) {
  const states = listStates();

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        states.map(({ id, url, port, startedAt, endsAt, approval }) => {
          const listed: ListedPipe = { id, url, port, startedAt, endsAt };

          if (approval) listed.approval = true;

          return listed;
        }),
      )}\n`,
    );

    return;
  }

  if (!states.length) {
    process.stdout.write("No open pipes. Start one with: npx wurmhol <port>\n");

    return;
  }

  for (const s of states) {
    const left = Math.max(0, Math.round((Date.parse(s.endsAt) - Date.now()) / 60_000)) * 60;

    const ends = s.approval
      ? "waiting for approval"
      : left
        ? `ends in ${formatDuration(left)}`
        : "ends in under a minute";

    process.stdout.write(`${s.port}\t${s.url}\t${s.id}\t${ends}\n`);
  }
}

async function stop(target: string | undefined, all: boolean) {
  const states = listStates();
  const chosen = all ? states : states.filter((s) => target !== undefined && matches(s, target));

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

/** `wurmhol doctor`: every check, one line each; exits 1 when any fails. */
async function doctor(portText: string | undefined, json: boolean) {
  let port: number | undefined;

  if (portText !== undefined) {
    port = parsePort(portText) ?? fail(`Not a port: ${portText}. Use --port 5173.`);
  }

  const checks = await runDoctor({ port, version: pkg.version });

  if (json) {
    process.stdout.write(`${JSON.stringify({ checks })}\n`);
  } else {
    process.stdout.write(`${allowlistLine()}\n`);

    for (const check of checks) process.stdout.write(`${formatCheck(check)}\n`);
  }

  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

/** Lines `wurmhol logs` prints before it follows. */
const LOG_LINES = 50;

/** One domain, as `wurmhol domain` prints it: the state, and the DNS records still to publish. */
function formatDomain(domain: Domain) {
  const lines = [`${domain.hostname}  ${domain.pipe}  ${domain.state}`];

  if (domain.state === "active" && domain.url) lines.push(`  ${domain.url}`);

  if (domain.error) lines.push(`  ${domain.error.message} ${domain.error.fix}`);

  if (domain.state !== "active" && domain.state !== "failed") {
    for (const record of domain.dns) {
      const done = record.done ? "ok     " : "publish";
      const why = record.purpose === "ownership" ? "proves you own it" : "sends traffic to Wurmhol";
      lines.push(`  ${done}  ${record.type.padEnd(5)} ${record.name}  ${record.value}  (${why})`);
    }
  }

  return lines.join("\n");
}

/**
 * `wurmhol domain add|verify|ls|rm` (ADR 0033): a hostname you own on one of your pipe names, so
 * the pipe's URL is yours. Needs a token of scope `org`.
 */
async function domain(
  action: string | undefined,
  hostname: string | undefined,
  options: { name: string | undefined; json: boolean; wait: boolean },
) {
  const client = domainsClient({ token: token(), server: server() });

  const print = (value: Domain) =>
    process.stdout.write(options.json ? `${JSON.stringify(value)}\n` : `${formatDomain(value)}\n`);

  const need = () =>
    hostname ?? fail(`Say which hostname: wurmhol domain ${action} preview.example.com.`);

  try {
    if (action === "ls") {
      const all = await client.list();

      if (options.json) return void process.stdout.write(`${JSON.stringify({ domains: all })}\n`);

      return void process.stdout.write(
        all.length ? `${all.map(formatDomain).join("\n")}\n` : "No custom domains.\n",
      );
    }

    if (action === "add") {
      const pipe = options.name ?? fail("Say which pipe name: --name acme-app.");
      const added = await client.add({ hostname: need(), pipe });

      if (!options.wait) {
        print(added);

        if (!options.json) {
          process.stdout.write(
            `Publish the records above at ${added.hostname}'s DNS host, then: wurmhol domain verify ${added.hostname} --wait\n`,
          );
        }

        return;
      }

      if (!options.json) process.stdout.write(`${formatDomain(added)}\n`);
    }

    if (action === "verify" || action === "add") {
      const host = need();

      const done = options.wait
        ? await client.waitActive(host, {
            onUpdate: (d) => {
              if (!options.json && d.state !== "active")
                process.stderr.write(`${d.hostname}  ${d.state}\n`);
            },
          })
        : await client.verify(host);

      return print(done);
    }

    if (action === "rm") {
      await client.remove(need());

      return void process.stdout.write(options.json ? '{"ok":true}\n' : `removed ${hostname}\n`);
    }
  } catch (error) {
    fail(error);
  }

  fail(`Unknown domain command: ${action ?? "(none)"}. Use add, verify, ls or rm.`);
}

/** The log `target` names: an open pipe's (the newest one on a port), or an ended pipe's id. */
function logOf(target: string): string | null {
  const open = listStates().filter((s) => matches(s, target));

  if (open.length) return open.at(-1)!.id;

  // A daemon that never got a pipe, such as a share's login whose pipe was refused, logs under
  // its port and has exited by the time anyone asks.
  if (isPort(Number(target)) && readLog(`port-${target}`)) return `port-${target}`;

  return /^[a-z0-9]{1,40}$/.test(target) && readLog(target) ? target : null;
}

function formatRecord(record: LogRecord) {
  const request = requestOf(record);

  if (request) {
    const { time, method, path, status, durationMs } = request;

    return `${time}  ${method} ${path}  ${status}  ${durationMs} ms`;
  }

  const { time, event, port: _port, ...fields } = record;

  return `${time}  ${event}${Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : ""}`;
}

/** `wurmhol logs <port|id|name>`: the pipe's recent requests and connection events. */
function logs(target: string | undefined, json: boolean, follow: boolean) {
  if (!target) fail("Say which pipe: wurmhol logs <port|id|name>.");
  const name = logOf(target);

  if (!name) fail(`No log for ${target}. See: wurmhol ls`);

  const print = (record: LogRecord) =>
    process.stdout.write(`${json ? JSON.stringify(record) : formatRecord(record)}\n`);

  for (const record of (readLog(name) ?? []).slice(-LOG_LINES)) print(record);

  if (follow) followLog(name, print, new AbortController().signal);
}

const SEE_FLAGS = "Run `npx wurmhol@latest --help` to see the flags.";

/** parseArgs' own errors, as one line that names the flag; anything else is a bug and rethrows. */
function explainArgsError(cause: unknown, args: string[]): string {
  const code = errorCode(cause);
  const message = cause instanceof Error ? cause.message : undefined;
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
      throw cause;
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
        path: { type: "string" },
        all: { type: "boolean", default: false },
        follow: { type: "boolean", short: "f", default: false },
        wait: { type: "boolean", default: false },
        skill: { type: "boolean", default: false },
        install: { type: "boolean", default: false },
        uninstall: { type: "boolean", default: false },
        ttl: { type: "string" },
        code: { type: "string" },
        port: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    fail(explainArgsError(error, args));
  }
}

type CommandLine = ReturnType<typeof parseCommandLine>;

/** Runs `command` when it names one; false when it names none, and so should be a port. */
async function runCommand(command: string, { values, positionals }: CommandLine) {
  const argument = positionals[1];

  switch (command) {
    case DAEMON_COMMAND:
      await runDaemon(argument ?? fail("no share options"), {
        server: server(),
        token: findToken(),
      });
      break;
    case "ls":
      await ls(values.json);
      break;
    case "stop":
      await stop(argument, values.all);
      break;
    case "logs":
      await logs(argument, values.json, values.follow);
      break;
    case "init":
      await init(values.skill);
      break;
    case "domain":
      await domain(argument, positionals[2], {
        name: values.name,
        json: values.json,
        wait: values.wait,
      });
      break;
    case "login":
      await login();
      break;
    case "doctor":
      await doctor(values.port, values.json);
      break;
    case "host":
      if (values.install) await installHost();
      else if (values.uninstall) await uninstallHost();
      else await serveHost(values.code?.trim() || undefined);
      break;
    case "logout":
      await logout();
      break;
    case "mcp":
      await (await import("./mcp.ts")).serve();
      break;
    default:
      return false;
  }

  return true;
}

/** `wurmhol <port>`: the flags, checked, then the pipe. */
function shareFromFlags(command: string, values: CommandLine["values"]) {
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

  let path: string | undefined;

  if (values.path !== undefined) {
    try {
      path = pagePath(values.path);
    } catch (error) {
      fail(error);
    }
  }

  const { only, name, link, note } = values;

  return share({ port, ttl, only, name, link, note }, values.json, path);
}

async function main() {
  const line = parseCommandLine();
  const [command] = line.positionals;

  if (line.values.version) return void process.stdout.write(`${pkg.version}\n`);

  if (line.values.help || !command) return void process.stdout.write(HELP);

  if (await runCommand(command, line)) return;

  return shareFromFlags(command, line.values);
}

try {
  await main();
} catch (error) {
  // Config read deep inside a command (WURMHOL_URL) throws its fix; anything else is a bug.
  if (error instanceof FixError) fail(error);
  throw error;
}
