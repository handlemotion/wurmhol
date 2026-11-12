// Wrangler config policy. The root wrangler.jsonc (the Deploy to Cloudflare button) must describe
// the same Worker as apps/worker/wrangler.jsonc: same bindings, Durable Object migrations, flags
// and var names. Only paths (resolved to the same files), the build command and var values (the
// root has deploy defaults) may differ. A binding added to one file alone fails here.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "jsonc-parser";

const root = join(import.meta.dirname, "..");

function read(path) {
  const errors = [];
  const config = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true });

  if (errors.length > 0) throw new Error(`${path}: not valid JSONC`);
  const dir = dirname(path);
  const at = (relative) => resolve(dir, relative);
  delete config.$schema;
  delete config.build;
  config.main = at(config.main);
  config.assets.directory = at(config.assets.directory);

  for (const db of config.d1_databases) db.migrations_dir = at(db.migrations_dir);
  config.vars = Object.keys(config.vars).sort();

  return config;
}

const button = read(join(root, "wrangler.jsonc"));
const worker = read(join(root, "apps/worker/wrangler.jsonc"));
const keys = [...new Set([...Object.keys(button), ...Object.keys(worker)])];

const problems = keys.flatMap((key) =>
  isDeepStrictEqual(button[key], worker[key])
    ? []
    : [`  ${key}: wrangler.jsonc and apps/worker/wrangler.jsonc differ`],
);

if (problems.length > 0) {
  console.error(`Wrangler configs drifted apart:\n${problems.join("\n")}`);
  process.exit(1);
}
