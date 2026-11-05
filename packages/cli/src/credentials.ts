// The token `wurmhol login` stored: `~/.wurmhol/credentials.json` (under WURMHOL_HOME), mode 0600.
// It is kept with the server it belongs to and used only against that server, so a token for one
// install is never sent to another.
import {
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { home } from "./state.ts";

export interface Credentials {
  server: string;
  token: string;
  org: string | null;
  name: string;
}

export function credentialsFile() {
  return join(home(), "credentials.json");
}

export function readCredentials(): Credentials | null {
  let text: string;
  try {
    text = readFileSync(credentialsFile(), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Partial<Credentials>;
    if (typeof parsed.server !== "string" || typeof parsed.token !== "string") return null;
    return {
      server: parsed.server,
      token: parsed.token,
      org: parsed.org ?? null,
      name: parsed.name ?? "",
    };
  } catch {
    return null;
  }
}

export function writeCredentials(credentials: Credentials) {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  // `mode` applies only when the file is created, so an existing file is tightened too, through
  // the same descriptor that is written: no window where the token sits in a wider file.
  const fd = openSync(credentialsFile(), "w", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(credentials, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
}

/** Deletes the stored token. False when there was none. */
export function removeCredentials() {
  const existed = readCredentials() !== null;
  rmSync(credentialsFile(), { force: true });
  return existed;
}
