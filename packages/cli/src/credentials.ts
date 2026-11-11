// The token `wurmhol login` stored: `~/.wurmhol/credentials.json` (under WURMHOL_HOME), mode 0600.
// It is kept with the server it belongs to and used only against that server, so a token for one
// install is never sent to another. The file format and its safe writing are the SDK's token store.
import { readTokenFile, removeTokenFile, type StoredToken, writeTokenFile } from "@wurmhol/sdk";
import { join } from "node:path";
import { home } from "./state.ts";

export type Credentials = StoredToken;

export function credentialsFile() {
  return join(home(), "credentials.json");
}

export function readCredentials(): Credentials | null {
  return readTokenFile(credentialsFile());
}

export function writeCredentials(credentials: Credentials) {
  writeTokenFile(credentialsFile(), credentials);
}

/** Deletes the stored token. False when there was none. */
export function removeCredentials() {
  return removeTokenFile(credentialsFile());
}
