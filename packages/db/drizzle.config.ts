import { defineConfig } from "drizzle-kit";

// `db:generate` diffs the schema against the snapshots and needs no database. Migrations are
// applied by wrangler (`wrangler d1 migrations apply`), locally and in production (ADR 0001).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  strict: true,
  verbose: true,
});
