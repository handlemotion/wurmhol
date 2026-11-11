// A pipe's public URL (ADR 0033): its name's oldest active custom domain, else `<name>.<SHARE_DOMAIN>`
// (or `<id>.<SHARE_DOMAIN>` for a pipe with no name).
import {
  type Db,
  findOpenShareByName,
  findShare,
  isActiveDomainOf,
  primaryDomain,
} from "@wurmhol/db";
import { customHostname } from "@wurmhol/protocol";
import { type Config, customDomainOrigin, shareOrigin } from "./env.ts";
import { orgStub } from "./org-do.ts";
import { shareStub } from "./share-do.ts";

export async function shareUrl(
  db: Db,
  config: Config,
  share: { id: string; name?: string | null },
) {
  if (share.name && config.customDomains) {
    const host = await primaryDomain(db, share.name);
    if (host) return customDomainOrigin(config, host);
  }
  return shareOrigin(config, share);
}

/**
 * Where a viewer goes back to after signing in, or after an OAuth provider: the host they came
 * from when it is an active custom domain of this pipe's org and name, else the pipe's own host.
 * A `host` that is not that (a link someone crafted) is ignored, never followed (ADR 0033).
 */
export async function viewerOrigin(
  db: Db,
  config: Config,
  share: { id: string; orgId: string; name: string | null },
  host: string | null | undefined,
) {
  const hostname = host ? customHostname(host) : null;
  if (
    hostname &&
    share.name &&
    config.customDomains &&
    (await isActiveDomainOf(db, { hostname, orgId: share.orgId, pipeName: share.name }))
  ) {
    return customDomainOrigin(config, hostname);
  }
  return shareOrigin(config, share);
}

/**
 * Gives the open pipe of `name` its current URL, after a custom domain of the name became active
 * or stopped being: its Durable Object (what the CLI is told when it reconnects) and its card on
 * the wall and `/v1/pipes`. Nothing when no pipe of that org has the name open.
 */
export async function refreshPipeUrl(
  env: Env,
  db: Db,
  config: Config,
  pipe: { orgId: string; name: string },
) {
  const open = await findOpenShareByName(db, pipe.name);
  if (!open) return;
  const share = await findShare(db, open.id);
  if (!share || share.orgId !== pipe.orgId || share.tunnelId) return;
  const url = await shareUrl(db, config, { id: share.id, name: pipe.name });
  if (await shareStub(env, share.id).setUrl(url)) {
    await orgStub(env, pipe.orgId).update(share.id, { url });
  }
}
