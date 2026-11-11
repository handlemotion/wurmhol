// An embedded tunnel's health as `/v1/embed` and the console show it (ADR 0032): its state, its
// session's start, last request and bytes, and how its last session ended. Nothing from inside it.
import { type Db, findEmbedTunnel, latestSharesOfTunnels } from "@wurmhol/db";
import { type Config, shareOrigin } from "./env.ts";
import { shareStub } from "./share-do.ts";

export type EmbedTunnelRow = NonNullable<Awaited<ReturnType<typeof findEmbedTunnel>>>;

/**
 * Tunnels as their integration and the org's owners see them: lifecycle and health, never their
 * pages (ADR 0032).
 */
export async function describeTunnels(
  c: { env: Env; var: { db: Db; config: Config } },
  tunnels: EmbedTunnelRow[],
) {
  const latest = await latestSharesOfTunnels(
    c.var.db,
    tunnels.map((tunnel) => tunnel.id),
  );
  return Promise.all(
    tunnels.map(async (tunnel) => {
      const session = latest.get(tunnel.id);
      const open = session && !session.endedAt;
      const health = open ? await shareStub(c.env, session.id).health() : null;
      const state = health
        ? health.state
        : tunnel.stoppedAt
          ? "stopped"
          : session
            ? "ended"
            : "never";
      return {
        id: tunnel.id,
        url: shareOrigin(c.var.config, { id: tunnel.id, name: tunnel.name }),
        tenant: tunnel.tenant,
        owner: tunnel.owner,
        state,
        createdAt: tunnel.createdAt.toISOString(),
        stoppedAt: tunnel.stoppedAt?.toISOString() ?? null,
        session:
          health && session
            ? {
                id: session.id,
                startedAt: session.startedAt.toISOString(),
                liveSince: health.liveSince ? new Date(health.liveSince).toISOString() : null,
                awaySince: health.awaySince ? new Date(health.awaySince).toISOString() : null,
                lastRequestAt: health.lastRequestAt
                  ? new Date(health.lastRequestAt).toISOString()
                  : null,
                bytes: health.bytes,
              }
            : null,
        lastEnd:
          session?.endedAt && !health
            ? { reason: session.endReason, at: session.endedAt.toISOString() }
            : null,
      };
    }),
  );
}
