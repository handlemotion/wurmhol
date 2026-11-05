// `wurmhol init`: tells the repo's agents how to share, in AGENTS.md or CLAUDE.md, with the dev
// server's port read from package.json; `--skill` also writes the plugin's skill.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import skill from "../../../plugins/wurmhol/skills/wurmhol/SKILL.md";
import { consoleUrl, envToken, savedLogin, server } from "./config.ts";
import { credentialsFile } from "./credentials.ts";

/** The line `init` writes, with the repo's dev port (spec section 7). */
const initLine = (port: number) =>
  `Share the dev server with \`npx wurmhol ${port}\` (or the port it prints) and send the user the URL; end it with \`npx wurmhol stop ${port}\`.`;

/** Dev servers' default ports, first match wins; anything else is a Worker on 8787. */
const DEV_PORTS: [name: string, port: number][] = [
  ["next", 3000],
  ["astro", 4321],
  ["vite", 5173],
];

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

export function init(writeSkill: boolean) {
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
  if (envToken()) {
    say("WURMHOL_TOKEN is set.");
  } else if (savedLogin()) {
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
