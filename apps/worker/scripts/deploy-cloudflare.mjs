#!/usr/bin/env node
// Deploys the Worker with this install's production values, which never live in the repo
// (wrangler.jsonc keeps neutral self-hosting defaults). From Omni (ADR 0019 there). Cloudflare
// Workers Builds runs it as the deploy command (`pnpm --filter @wurmhol/worker deploy:cloudflare`);
// the values are build variables:
//
//   D1_DATABASE_ID      replaces the placeholder D1 id (required)
//   WORKER_DOMAIN       custom domains for the app, comma-separated (e.g. wurmhol.com)
//   WORKER_ROUTE        routes, comma-separated, for the share wildcard (e.g. *.on.wurmhol.com/*):
//                       custom domains cannot be wildcards
//   WORKER_VAR_<NAME>   the Worker var <NAME>; `--var` wins over wrangler.jsonc's value
//
// `--config-only` writes wrangler.deploy.jsonc and stops: the production workflow applies D1
// migrations with it. Secrets are not here: deploys keep them, and the Doppler sync sets them.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..");
const PLACEHOLDER = '"database_id": "00000000-0000-0000-0000-000000000000"';

const database = process.env.D1_DATABASE_ID;
if (!database || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(database)) {
  console.error("D1_DATABASE_ID is missing or not a D1 database id (a UUID)");
  process.exit(1);
}
const config = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
if (!config.includes(PLACEHOLDER)) {
  console.error("wrangler.jsonc no longer has the D1 placeholder id this script replaces");
  process.exit(1);
}
// Next to wrangler.jsonc, so its relative paths (main, assets, migrations) resolve the same.
const deployConfig = join(dir, "wrangler.deploy.jsonc");
writeFileSync(deployConfig, config.replace(PLACEHOLDER, `"database_id": "${database}"`));
const args = process.argv.slice(2);
if (args.includes("--config-only")) process.exit(0);

const wrangler = ["exec", "wrangler", "deploy", "--config", deployConfig, ...args];
for (const [name, value] of Object.entries(process.env)) {
  if (name.startsWith("WORKER_VAR_") && value !== undefined) {
    wrangler.push("--var", `${name.slice("WORKER_VAR_".length)}:${value}`);
  }
}
for (const domain of (process.env.WORKER_DOMAIN ?? "").split(",")) {
  if (domain.trim()) wrangler.push("--domain", domain.trim());
}
for (const route of (process.env.WORKER_ROUTE ?? "").split(",")) {
  if (route.trim()) wrangler.push("--route", route.trim());
}
const result = spawnSync("pnpm", wrangler, { cwd: dir, stdio: "inherit" });
rmSync(deployConfig, { force: true });
process.exit(result.status ?? 1);
