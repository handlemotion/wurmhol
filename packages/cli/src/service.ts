// `wurmhol host --install` and `--uninstall` (ADR 0019): run `wurmhol host` at login and keep it
// running, as a launchd user agent on macOS and a systemd user unit on Linux.
//
// The service runs this CLI by absolute path (the Node binary and the CLI's own file), so it needs
// a copy that stays put: not one in npx's or another runner's throwaway cache. It reads the token
// `wurmhol login` saved, like `wurmhol host` in a terminal; no token is ever written into the
// service definition, only WURMHOL_HOME and WURMHOL_URL when they are set. A WURMHOL_TOKEN in the
// systemd user manager's environment is unset, so the saved login is the one it uses. Stopping
// the service stops only `wurmhol host`: pipes it opened keep running, as they do when
// `wurmhol host` ends in a terminal (ADR 0018).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { FixError } from "./errors.ts";

export interface ServiceSpec {
  /** The Node binary that runs the CLI. */
  node: string;
  /** The CLI's entry file, run as `<node> <entry> host`. */
  entry: string;
  /** Plain config the service needs to find the saved token and the server. Never a token. */
  env: Record<string, string>;
  /** Where its output goes. */
  log: string;
}

const LABEL = "com.wurmhol.host";
const UNIT = "wurmhol-host.service";
/** Seconds between restarts, so a revoked token or a dead network does not spin. */
const RESTART_SECONDS = 30;

const GLOBAL_INSTALL =
  "Install it first with npm install -g wurmhol, then run wurmhol host --install.";

/**
 * The CLI's real path, refused when it lives in a cache that is cleared or replaced: npx
 * (`_npx`), `pnpm dlx`, `bunx`, or anything under the temporary directory.
 */
export function stableEntry(entry: string): string {
  const real = realpathSync(entry);
  const parts = real.split(sep);
  const temp = realpathSync(tmpdir());
  const throwaway =
    parts.includes("_npx") ||
    parts.includes("dlx") ||
    parts.some((part) => part.startsWith("dlx-") || part.startsWith("bunx-")) ||
    real.startsWith(temp + sep);
  if (throwaway) {
    throw new FixError(
      `wurmhol host --install needs wurmhol installed, not run through npx. ${GLOBAL_INSTALL}`,
    );
  }
  return real;
}

function run(command: string, args: string[]) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A failed command's first line of stderr, or its error message. */
function why(error: unknown): string {
  const { stderr, message } = error as { stderr?: string; message?: string };
  return (stderr?.trim() || message || String(error)).split("\n")[0] ?? "";
}

// ---------- Linux: systemd user unit ----------

function unitFile() {
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(config, "systemd", "user", UNIT);
}

/** A quoted value with systemd's specifiers (%) escaped; ExecStart also expands `$`. */
function systemdQuote(value: string, { exec }: { exec: boolean }) {
  let escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  if (exec) escaped = escaped.replaceAll("$", "$$$$");
  return `"${escaped}"`;
}

export function systemdUnit(spec: ServiceSpec): string {
  const exec = [spec.node, spec.entry, "host"]
    .map((arg) => systemdQuote(arg, { exec: true }))
    .join(" ");
  const env = Object.entries(spec.env).map(
    ([name, value]) => `Environment=${systemdQuote(`${name}=${value}`, { exec: false })}\n`,
  );
  const log = spec.log.replaceAll("%", "%%");
  return `[Unit]
Description=wurmhol host: open pipes to this computer from the wall

[Service]
ExecStart=${exec}
${env.join("")}UnsetEnvironment=WURMHOL_TOKEN
KillMode=process
Restart=always
RestartSec=${RESTART_SECONDS}
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}

function systemctl(...args: string[]) {
  return run("systemctl", ["--user", ...args]);
}

/** Throws the fix when this Linux has no systemd user manager to talk to. */
function requireSystemd() {
  try {
    systemctl("show-environment");
  } catch (error) {
    const detail = (error as NodeJS.ErrnoException).code === "ENOENT" ? "no systemctl" : why(error);
    throw new FixError(
      `systemd user services are not available here (${detail}). Keep wurmhol host running in a terminal instead.`,
    );
  }
}

function installSystemd(spec: ServiceSpec): string {
  const file = unitFile();
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, systemdUnit(spec));
  try {
    systemctl("daemon-reload");
    systemctl("enable", UNIT);
    // Restart, not start: a reinstall picks up the new definition.
    systemctl("restart", UNIT);
  } catch (error) {
    throw new FixError(`systemctl --user could not start ${UNIT}: ${why(error)}`);
  }
  return file;
}

function uninstallSystemd(): string | null {
  const file = unitFile();
  if (readIfExists(file) === null) return null;
  try {
    systemctl("disable", "--now", UNIT);
  } catch {
    // The manager is gone or never loaded it: removing the file is what is left to do.
  }
  rmSync(file, { force: true });
  try {
    systemctl("daemon-reload");
  } catch {
    // As above.
  }
  return file;
}

// ---------- macOS: launchd user agent ----------

function plistFile() {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function launchdPlist(spec: ServiceSpec): string {
  const string = (value: string) => `<string>${xml(value)}</string>`;
  const env = Object.entries(spec.env)
    .map(([name, value]) => `\n      <key>${xml(name)}</key>${string(value)}`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>${string(LABEL)}
    <key>ProgramArguments</key>
    <array>${[spec.node, spec.entry, "host"].map((arg) => `\n      ${string(arg)}`).join("")}
    </array>
    <key>EnvironmentVariables</key>
    <dict>${env}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>AbandonProcessGroup</key><true/>
    <key>ThrottleInterval</key><integer>${RESTART_SECONDS}</integer>
    <key>ProcessType</key>${string("Background")}
    <key>StandardOutPath</key>${string(spec.log)}
    <key>StandardErrorPath</key>${string(spec.log)}
  </dict>
</plist>
`;
}

function domain() {
  return `gui/${process.getuid?.() ?? 0}`;
}

function installLaunchd(spec: ServiceSpec): string {
  const file = plistFile();
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, launchdPlist(spec));
  try {
    // Unload an earlier install first, so a reinstall picks up the new definition.
    run("launchctl", ["bootout", `${domain()}/${LABEL}`]);
  } catch {
    // Not loaded.
  }
  try {
    run("launchctl", ["bootstrap", domain(), file]);
  } catch (error) {
    throw new FixError(`launchctl could not load ${file}: ${why(error)}`);
  }
  return file;
}

function uninstallLaunchd(): string | null {
  const file = plistFile();
  if (readIfExists(file) === null) return null;
  try {
    run("launchctl", ["bootout", `${domain()}/${LABEL}`]);
  } catch {
    // Not loaded: removing the file is what is left to do.
  }
  rmSync(file, { force: true });
  return file;
}

// ---------- both ----------

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function unsupported(): never {
  throw new FixError(
    `wurmhol host --install does not support ${process.platform} yet. Keep wurmhol host running in a terminal instead.`,
  );
}

/** Throws the fix when this computer cannot run the service, before anything asks for a login. */
export function checkService() {
  if (process.platform === "darwin") return;
  if (process.platform === "linux") return requireSystemd();
  unsupported();
}

/** Installs and starts the service (after `checkService`); returns the file that defines it. */
export function installService(spec: ServiceSpec): string {
  if (process.platform === "darwin") return installLaunchd(spec);
  if (process.platform === "linux") return installSystemd(spec);
  unsupported();
}

/** Stops and removes the service; returns the file it removed, or null when none was installed. */
export function uninstallService(): string | null {
  if (process.platform === "darwin") return uninstallLaunchd();
  if (process.platform === "linux") return uninstallSystemd();
  unsupported();
}
