// Vitest globalSetup: builds what every e2e file runs, once. The web app (served as the
// Worker's assets) and the CLI (`packages/cli/dist/cli.js`, the file npm ships). Then writes
// `wrangler.e2e.jsonc`: wrangler.jsonc without its custom build, so each file's `wrangler dev`
// starts in a second instead of rebuilding the web app.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const workerRoot = join(import.meta.dirname, "..");
export const e2eConfig = join(workerRoot, ".wrangler/wrangler.e2e.jsonc");

export default function setup() {
  const repo = join(workerRoot, "../..");
  execFileSync("pnpm", ["--filter", "@wurmhol/web", "build"], {
    cwd: repo,
    stdio: ["ignore", "ignore", "inherit"],
  });
  execFileSync("pnpm", ["--filter", "wurmhol", "build"], {
    cwd: repo,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const config = readFileSync(join(workerRoot, "wrangler.jsonc"), "utf8")
    .replace(/^\s*"build":.*$/m, "")
    // Relative paths resolve from the config's own directory: one level deeper.
    .replaceAll('"src/index.ts"', '"../src/index.ts"')
    .replaceAll('"../web/dist"', '"../../web/dist"')
    .replaceAll('"../../packages/db/migrations"', '"../../../packages/db/migrations"')
    .replaceAll(
      '"./node_modules/wrangler/config-schema.json"',
      '"../node_modules/wrangler/config-schema.json"',
    );
  execFileSync("mkdir", ["-p", join(workerRoot, ".wrangler")]);
  writeFileSync(e2eConfig, config);
}
