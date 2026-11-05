// Which install the CLI talks to and with which token: WURMHOL_URL, WURMHOL_TOKEN, and the token
// `wurmhol login` saved for that install. Every command and the MCP server resolve them here.
import { type Credentials, readCredentials } from "./credentials.ts";
import { DEFAULT_CONSOLE, DEFAULT_SERVER, originOf } from "./pipe.ts";

/** The install's origin: WURMHOL_URL, or wurmhol.com. Throws a FixError when it is not a URL. */
export function server() {
  return originOf(process.env.WURMHOL_URL || DEFAULT_SERVER);
}

/** Where people make tokens: the console, or a self-hosted install's own origin. */
export function consoleUrl() {
  return process.env.WURMHOL_URL ? server() : DEFAULT_CONSOLE;
}

/** WURMHOL_TOKEN, when set. */
export function envToken() {
  return process.env.WURMHOL_TOKEN?.trim() || null;
}

/** The saved login, when it belongs to this install: a token is never sent to another one. */
export function savedLogin(): Credentials | null {
  const stored = readCredentials();
  return stored && stored.server === server() ? stored : null;
}

/** WURMHOL_TOKEN when set, else the token `wurmhol login` saved for this install, else null. */
export function findToken() {
  return envToken() ?? savedLogin()?.token ?? null;
}
