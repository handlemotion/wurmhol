// Entry for the Better Auth CLI only: `pnpm --filter @wurmhol/auth auth:generate` writes
// packages/db/src/schema/auth.ts from createAuth's options. Never edit that file by hand.
// The D1 binding is never queried.
import { createDb } from "@wurmhol/db";
import { createAuth, type Auth } from "./src/index.ts";

const unqueried = (): never => {
  throw new Error("auth.config.ts is for schema generation only");
};

const schemaOnlyD1: D1Database = {
  prepare: unqueried,
  batch: unqueried,
  exec: unqueried,
  withSession: unqueried,
  dump: unqueried,
};

export const auth: Auth = createAuth({
  db: createDb(schemaOnlyD1),
  secret: "schema-generation-only-schema-generation-only",
  baseURL: "http://localhost",
  // Billing, magic links and MCP on, so their tables and columns are part of the schema (additive and
  // unused when a deploy leaves them off).
  billing: {
    secretKey: "sk_test_schema_generation_only",
    webhookSecret: "whsec_schema_generation_only",
    prices: {
      friends: "price_schema_generation_only_friends",
      business: "price_schema_generation_only_business",
      businessRequests: "price_schema_generation_only_business_requests",
    },
  },
  sendMagicLink: async () => {
    throw new Error("auth.config.ts is for schema generation only");
  },
  // The hosted MCP server's tables (ADR 0014): signing keys, OAuth clients, tokens and consents.
  mcp: { resource: "http://localhost/mcp" },
});
