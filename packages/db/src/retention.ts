// Retention (ADR 0008), run by the Worker's daily cron: pipe history after a set number of days,
// and sign-in rows and OAuth relay states once they have expired. Accounts, tokens and billing are not pruned.
import { lt } from "drizzle-orm";
import type { Db } from "./client.ts";
import {
  deviceCodes,
  inviteLinks,
  oauthStates,
  sessions,
  shares,
  verifications,
} from "./schema/index.ts";

/** Rows deleted by one run, per table. */
export interface Pruned {
  shares: number;
  sessions: number;
  verifications: number;
  inviteLinks: number;
  deviceCodes: number;
  oauthStates: number;
}

/**
 * Deletes `shares` rows started more than `retentionDays` before `now`, and expired sessions,
 * verifications (magic links, OAuth state), invite links, device codes (`wurmhol login`) and OAuth relay states (ADR 0010).
 */
export async function pruneExpired(
  db: Db,
  { now, retentionDays }: { now: Date; retentionDays: number },
): Promise<Pruned> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const [pipes, signIns, codes, invites, devices, relayed] = await db.batch([
    db.delete(shares).where(lt(shares.startedAt, cutoff)),
    db.delete(sessions).where(lt(sessions.expiresAt, now)),
    db.delete(verifications).where(lt(verifications.expiresAt, now)),
    db.delete(inviteLinks).where(lt(inviteLinks.expiresAt, now)),
    db.delete(deviceCodes).where(lt(deviceCodes.expiresAt, now)),
    db.delete(oauthStates).where(lt(oauthStates.expiresAt, now)),
  ]);
  return {
    shares: pipes.meta.changes,
    sessions: signIns.meta.changes,
    verifications: codes.meta.changes,
    inviteLinks: invites.meta.changes,
    deviceCodes: devices.meta.changes,
    oauthStates: relayed.meta.changes,
  };
}
