// Retention (ADR 0008), run by the Worker's daily cron: pipe history after a set number of days,
// sign-in rows, OAuth relay states and embedded launch codes once they have expired, and embedded
// tunnels' grants and grant log after the same number of days. Accounts, tokens and billing are not pruned.
import { lt, or } from "drizzle-orm";
import type { Db } from "./client.ts";
import {
  deviceCodes,
  embedGrantEvents,
  embedGrants,
  embedLaunchCodes,
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
  launchCodes: number;
  grants: number;
  grantEvents: number;
}

/**
 * Deletes `shares` rows started more than `retentionDays` before `now`, and expired sessions,
 * verifications (magic links, OAuth state), invite links, device codes (`wurmhol login`), OAuth relay states (ADR 0010) and embedded tunnels'
 * launch codes (ADR 0032). Embedded grants go `retentionDays` after they expired or were revoked,
 * and grant log entries `retentionDays` after they were written.
 */
export async function pruneExpired(
  db: Db,
  { now, retentionDays }: { now: Date; retentionDays: number },
): Promise<Pruned> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const [pipes, signIns, magicLinks, invites, devices, relayed, launches, events, grants] =
    await db.batch([
      db.delete(shares).where(lt(shares.startedAt, cutoff)),
      db.delete(sessions).where(lt(sessions.expiresAt, now)),
      db.delete(verifications).where(lt(verifications.expiresAt, now)),
      db.delete(inviteLinks).where(lt(inviteLinks.expiresAt, now)),
      db.delete(deviceCodes).where(lt(deviceCodes.expiresAt, now)),
      db.delete(oauthStates).where(lt(oauthStates.expiresAt, now)),
      db.delete(embedLaunchCodes).where(lt(embedLaunchCodes.expiresAt, now)),
      db.delete(embedGrantEvents).where(lt(embedGrantEvents.at, cutoff)),
      db
        .delete(embedGrants)
        .where(or(lt(embedGrants.expiresAt, cutoff), lt(embedGrants.revokedAt, cutoff))),
    ]);
  return {
    shares: pipes.meta.changes,
    sessions: signIns.meta.changes,
    verifications: magicLinks.meta.changes,
    inviteLinks: invites.meta.changes,
    deviceCodes: devices.meta.changes,
    oauthStates: relayed.meta.changes,
    launchCodes: launches.meta.changes,
    grantEvents: events.meta.changes,
    grants: grants.meta.changes,
  };
}
