// Entry for the Better Auth CLI only: `pnpm --filter @wurmhol/auth auth:generate` writes
// packages/db/src/schema/auth.ts from createAuth's options. Never edit that file by hand.
// The sqlite-proxy database is never queried.
import { schema, type Db } from "@wurmhol/db";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { createAuth, type Auth } from "./src/index.ts";

export const auth: Auth = createAuth({
  db: drizzle(
    async () => {
      throw new Error("auth.config.ts is for schema generation only");
    },
    { schema },
  ) as unknown as Db,
  secret: "schema-generation-only-schema-generation-only",
  baseURL: "http://localhost",
  // Billing and magic links on, so their tables and columns are part of the schema (additive and
  // unused when a deploy leaves them off).
  billing: {
    secretKey: "sk_test_schema_generation_only",
    webhookSecret: "whsec_schema_generation_only",
    yearlyPriceId: "price_schema_generation_only",
    monthlyPriceId: undefined,
  },
  sendMagicLink: async () => {
    throw new Error("auth.config.ts is for schema generation only");
  },
});
