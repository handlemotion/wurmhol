// Device codes of `wurmhol login` (ADR 0008). Better Auth's device-authorization plugin owns the
// table and its state machine; Wurmhol only records which org an approval is for.
import { and, eq } from "drizzle-orm";
import type { Db } from "./client.ts";
import { deviceCodes } from "./schema/index.ts";

/**
 * Sets the scope of a pending code that `userId` has claimed. False when there is no such code:
 * someone else claimed it, or it was already approved or denied.
 */
export async function setPendingDeviceScope(
  db: Db,
  input: { userCode: string; userId: string; scope: string },
) {
  const updated = await db
    .update(deviceCodes)
    .set({ scope: input.scope })
    .where(
      and(
        eq(deviceCodes.userCode, input.userCode),
        eq(deviceCodes.userId, input.userId),
        eq(deviceCodes.status, "pending"),
      ),
    )
    .returning({ id: deviceCodes.id });
  return updated.length > 0;
}
