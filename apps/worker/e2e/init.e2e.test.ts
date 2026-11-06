// `wurmhol init` in real temp projects: the built CLI reads package.json, writes the agent line
// with the dev port, optionally the skill, and says whether a token is set.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { workerRoot } from "./global-setup.ts";
import { cliPath } from "./support.ts";

function project(manifest: object | null, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wurmhol-init-"));
  if (manifest) writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

function init(dir: string, args: string[] = [], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [cliPath, "init", ...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      WURMHOL_HOME: mkdtempSync(join(tmpdir(), "wurmhol-home-")),
      ...env,
    },
  });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  return result.stdout;
}

const line = (port: number) =>
  `Share the dev server with \`npx wurmhol ${port}\` (or the port it prints) and send the user the URL; end it with \`npx wurmhol stop ${port}\`.`;

it("in a Vite project, appends the line with 5173 to CLAUDE.md once, and says the token is missing", () => {
  const dir = project(
    { scripts: { dev: "vite", build: "vite build" }, devDependencies: { vite: "^8.0.0" } },
    { "CLAUDE.md": "# Rules\n" },
  );
  const first = init(dir);
  // Catches a sandbox learning which hosts to allowlist only after a refused call.
  expect(first.split("\n")[0]).toBe(
    "With Limited network access, allowlist api.wurmhol.com (the CLI's host) and *.wurmhol.dev (pipe URLs, to open them from the sandbox).",
  );
  expect(first).toContain("Added a line to CLAUDE.md (port 5173");
  expect(first).toContain("No token. On this computer, run wurmhol login.");
  expect(first).toContain("api.wurmhol.com under Allowed domains");
  expect(init(dir)).toContain("CLAUDE.md already mentions wurmhol");
  expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(`# Rules\n\n${line(5173)}\n`);
});

it("picks the framework's port over Vite's, and 8787 for anything else", () => {
  const cases: [object | null, number][] = [
    // Astro and Next projects often carry Vite too; their own port is the one that serves.
    [{ dependencies: { astro: "^5", vite: "^8" } }, 4321],
    [{ scripts: { dev: "next dev --turbopack" } }, 3000],
    [{ scripts: { dev: "wrangler dev" } }, 8787],
    [null, 8787],
  ];
  for (const [manifest, port] of cases) {
    const dir = project(manifest);
    init(dir);
    expect({ manifest, agents: readFileSync(join(dir, "AGENTS.md"), "utf8") }).toEqual({
      manifest,
      agents: `${line(port)}\n`,
    });
  }
});

it("--skill writes the plugin's skill, and a set token is reported without printing it", () => {
  const dir = project({ devDependencies: { vite: "^8" } });
  const token = "wh_e2e_not_a_real_token";
  const out = init(dir, ["--skill"], { WURMHOL_TOKEN: token });
  expect(out).toContain("Wrote .claude/skills/wurmhol/SKILL.md");
  expect(out).toContain("WURMHOL_TOKEN is set.");
  expect(out).not.toContain(token);
  expect(readFileSync(join(dir, ".claude/skills/wurmhol/SKILL.md"), "utf8")).toBe(
    readFileSync(join(workerRoot, "../../plugins/wurmhol/skills/wurmhol/SKILL.md"), "utf8"),
  );
});

it("a token from wurmhol login counts as set, but only for the server it belongs to", () => {
  const home = mkdtempSync(join(tmpdir(), "wurmhol-home-"));
  const stored = { token: "wh_e2e_stored", org: "Acme", name: "laptop" };
  writeFileSync(
    join(home, "credentials.json"),
    JSON.stringify({ ...stored, server: "https://api.wurmhol.com" }),
  );
  const out = init(project(null), [], { WURMHOL_HOME: home });
  expect(out).toContain(`Logged in: wurmhol uses the token in ${join(home, "credentials.json")}.`);
  expect(out).not.toContain(stored.token);
  const elsewhere = init(project(null), [], {
    WURMHOL_HOME: home,
    WURMHOL_URL: "https://wurmhol.example.com",
  });
  expect(elsewhere).toContain("No token.");
});
