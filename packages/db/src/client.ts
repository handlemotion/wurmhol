import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema/index.ts";

/** Drizzle over D1 with our schema. */
export type Db = DrizzleD1Database<typeof schema>;

/** Drizzle over a D1 binding. Cheap: make one per request. */
export function createDb(d1: D1Database): Db {
  return drizzle(d1, { schema });
}
