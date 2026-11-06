// Device codes of `wurmhol login` (ADR 0008). Better Auth's device-authorization plugin owns the
// table and its state machine; Wurmhol only records which org an approval is for.
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "./client.ts";
import { deviceCodes, shares, tokens } from "./schema/index.ts";

/** The user code of a live device code, or null. Read before redemption, which deletes the row. */
export async function findDeviceUserCode(db: Db, deviceCode: string) {
  const [row] = await db
    .select({ userCode: deviceCodes.userCode })
    .from(deviceCodes)
    .where(eq(deviceCodes.deviceCode, deviceCode))
    .limit(1);
  return row?.userCode ?? null;
}

/**
 * Where a share's device login has got to (ADR 0026), for the member who approved it: `waiting`
 * until the CLI has redeemed the code and opened its pipe, then the newest open pipe of the
 * token made from it, on `port` when given: the computer may open other ports with the same
 * token, and the approval page asked to open that one. Only tokens `userId` made in `orgId`
 * since `since` count.
 */
export async function findLoginPipe(
  db: Db,
  input: { orgId: string; userId: string; loginCode: string; since: Date; port?: number },
) {
  const [row] = await db
    .select({ id: shares.id, name: shares.name })
    .from(tokens)
    .innerJoin(shares, and(eq(shares.tokenId, tokens.id), isNull(shares.endedAt)))
    .where(
      and(
        eq(tokens.orgId, input.orgId),
        eq(tokens.createdBy, input.userId),
        eq(tokens.loginCode, input.loginCode),
        isNull(tokens.revokedAt),
        gt(tokens.createdAt, input.since),
        input.port === undefined ? undefined : eq(shares.port, input.port),
      ),
    )
    .orderBy(desc(shares.startedAt))
    .limit(1);
  return row ?? null;
}

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
