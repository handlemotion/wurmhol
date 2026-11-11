// Custom domains (ADR 0033): adding one, checking it, removing it. Routes and the daily job call
// these; Cloudflare and DNS are reached only through `provider` and `txt`.
import {
  addDomain,
  type Db,
  deleteDomain,
  type DomainRow,
  domainsToCheck,
  findDomain,
  listDomains,
  releasePipeName,
  updateDomain,
} from "@wurmhol/db";
import {
  CUSTOM_HOSTNAME_RULE,
  customHostname,
  type Domain,
  type DomainErrorCode,
  type DomainRecord,
  nextDomainState,
  ownershipRecordName,
  ownershipRecordValue,
  PIPE_NAME_RULE,
  pipeName,
} from "@wurmhol/protocol";
import { type Config, customDomainOrigin, isServedHost, reservedPipeNames } from "../env.ts";
import { createLogger } from "../log.ts";
import { refreshPipeUrl } from "../share-url.ts";
import { orgPlan } from "../plan.ts";
import { DnsError, lookupTxt } from "./dns.ts";
import { cloudflareProvider, type HostnameProvider, ProviderError } from "./provider.ts";

/** A refusal with the status, the machine code and the one line that fixes it (ADR 0033). */
export class DomainRefusal extends Error {
  readonly status: number;
  readonly code: string;
  readonly fix: string;
  constructor(status: number, code: string, error: string, fix: string) {
    super(error);
    this.status = status;
    this.code = code;
    this.fix = fix;
  }

  body() {
    return { error: this.message, fix: this.fix, code: this.code };
  }
}

export interface DomainDeps {
  db: Db;
  config: Config;
  provider: HostnameProvider;
  txt: (name: string) => Promise<string[]>;
  /** Called when a domain of a pipe name became active or stopped being, so its open pipe's URL follows. */
  urlChanged?: (domain: { orgId: string; pipeName: string }) => Promise<void>;
}

/**
 * The deps for this install, or null when custom domains are off. With `env`, an open pipe's URL
 * follows its name's domains.
 */
export function domainDeps(config: Config, db: Db, env?: Env): DomainDeps | null {
  const custom = config.customDomains;
  if (!custom) return null;
  return {
    db,
    config,
    provider: cloudflareProvider({
      apiUrl: custom.apiUrl,
      zoneId: custom.zoneId,
      token: custom.apiToken,
    }),
    txt: (name) => lookupTxt(custom.resolverUrl, name),
    urlChanged: env
      ? (domain) => refreshPipeUrl(env, db, config, { orgId: domain.orgId, name: domain.pipeName })
      : undefined,
  };
}

/** Lets the name's open pipe know its URL changed. Best effort: the pipe keeps working either way. */
async function noteUrlChange(deps: DomainDeps, row: DomainRow) {
  try {
    await deps.urlChanged?.(row);
  } catch (error) {
    createLogger({ component: "domains" }).warn("domain.url_refresh_failed", {
      error,
      orgId: row.orgId,
    });
  }
}

/** Wraps a provider or DNS failure as the refusal a caller sees. */
function unavailable(error: unknown): never {
  if (error instanceof DnsError) {
    throw new DomainRefusal(
      503,
      "dns_unavailable",
      error.message,
      "Try again in a minute: nothing was changed.",
    );
  }
  if (error instanceof ProviderError) {
    throw new DomainRefusal(
      502,
      "provider_error",
      error.message,
      "Try again in a minute. If it keeps failing, tell the operator.",
    );
  }
  throw error;
}

const ERROR_TEXT: Record<DomainErrorCode, { message: string; fix: (hostname: string) => string }> =
  {
    expired: {
      message: "The domain was not verified in time.",
      fix: () => "Remove it and add it again, then publish both DNS records before it expires.",
    },
    certificate_refused: {
      message: "A certificate could not be issued for this domain.",
      fix: (hostname) =>
        `Check that ${hostname} has no CAA record that forbids Let's Encrypt, Google Trust Services or SSL.com, then remove the domain and add it again.`,
    },
    hostname_blocked: {
      message: "This domain was blocked from being served.",
      fix: () => "Remove it and pick another hostname, or ask the operator why it was blocked.",
    },
  };

/** A domain as the API returns it. */
export function domainView(config: Config, row: DomainRow): Domain {
  const target = config.customDomains?.target ?? "";
  const records: DomainRecord[] = [
    {
      type: "TXT",
      name: ownershipRecordName(row.hostname),
      value: ownershipRecordValue(row.challenge),
      purpose: "ownership",
      done: row.verifiedAt !== null,
    },
    {
      type: "CNAME",
      name: row.hostname,
      value: target,
      purpose: "traffic",
      done: row.providerStatus === "active",
    },
  ];
  const code = row.errorCode;
  return {
    hostname: row.hostname,
    pipe: row.pipeName,
    state: row.state,
    url: row.state === "active" ? customDomainOrigin(config, row.hostname) : null,
    dns: records,
    error: code
      ? {
          code,
          message: row.errorDetail
            ? `${ERROR_TEXT[code].message} ${row.errorDetail}`
            : ERROR_TEXT[code].message,
          fix: ERROR_TEXT[code].fix(row.hostname),
        }
      : null,
    createdAt: row.createdAt.toISOString(),
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

function randomChallenge() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The org's domains. */
export async function list(deps: DomainDeps, orgId: string) {
  return (await listDomains(deps.db, orgId)).map((row) => domainView(deps.config, row));
}

/** One of the org's domains. Another org's hostname does not exist here. */
export async function get(deps: DomainDeps, orgId: string, hostname: string) {
  const host = customHostname(hostname);
  const row = host ? await findDomain(deps.db, host) : null;
  if (!row || row.orgId !== orgId) {
    throw new DomainRefusal(
      404,
      "not_found",
      "no such domain",
      "List the org's domains with GET /v1/domains.",
    );
  }
  return row;
}

/**
 * Adds a domain: checks the hostname and the name, the org's limit, reserves both, and makes the
 * Cloudflare hostname so its `CNAME` check can start while the org publishes DNS. The same call
 * again, for the same hostname and name, returns the domain it made.
 */
export async function add(
  deps: DomainDeps,
  orgId: string,
  input: { hostname: string; pipe: string },
) {
  const { db, config, provider } = deps;
  const hostname = customHostname(input.hostname);
  if (!hostname) {
    throw new DomainRefusal(
      400,
      "invalid_hostname",
      `"${input.hostname}" is not a usable hostname.`,
      `Use ${CUSTOM_HOSTNAME_RULE}.`,
    );
  }
  const name = pipeName(input.pipe);
  if (!name) {
    throw new DomainRefusal(
      400,
      "invalid_pipe",
      `"${input.pipe}" is not a pipe name.`,
      `Pick a pipe name of ${PIPE_NAME_RULE}.`,
    );
  }
  if (isServedHost(config, hostname)) {
    throw new DomainRefusal(
      409,
      "hostname_reserved",
      `${hostname} is a host this install already serves.`,
      "Pick a hostname on a domain you own.",
    );
  }
  if (reservedPipeNames(config).includes(name)) {
    throw new DomainRefusal(
      409,
      "pipe_reserved",
      `The pipe name ${name} is reserved.`,
      "Pick another pipe name.",
    );
  }

  const plan = await orgPlan(db, config, orgId);
  if (!plan) {
    throw new DomainRefusal(
      402,
      "no_subscription",
      "The org has no plan yet.",
      `An owner starts a trial at ${config.auth.baseURL}.`,
    );
  }

  // The limit is checked as the row is written, so two adds at once cannot both pass it.
  const added = await addDomain(db, {
    orgId,
    hostname,
    pipeName: name,
    challenge: randomChallenge(),
    expiresAt: new Date(Date.now() + config.customDomains!.pendingSeconds * 1000),
    limit: plan.customDomains,
  });
  if (!added.ok) {
    if (added.reason === "domain_limit") {
      throw new DomainRefusal(
        plan.plan ? 402 : 403,
        "domain_limit",
        plan.customDomains === 0
          ? "This org's plan does not include custom domains."
          : `This org may have ${plan.customDomains} custom domains.`,
        plan.plan
          ? `Move the org to a plan that includes more at ${config.auth.baseURL} (menu → Billing), or remove a domain.`
          : "Remove a domain you no longer use.",
      );
    }
    throw added.reason === "pipe_taken"
      ? new DomainRefusal(
          409,
          "pipe_taken",
          `Another org has the pipe name ${name}.`,
          "Pick another pipe name.",
        )
      : new DomainRefusal(
          409,
          "hostname_taken",
          `${hostname} is already attached to another pipe name or another org.`,
          "Pick another hostname, or remove it from the org that has it.",
        );
  }
  if (!added.created) return added.domain;

  const claim = added.domain;
  let made;
  try {
    made = await provider.create(hostname);
  } catch (error) {
    // Nothing to keep: the org can retry without a half-made domain, or a name, in the way.
    await deleteDomain(db, claim);
    if (added.nameClaimed) await releasePipeName(db, orgId, name);
    return unavailable(error);
  }
  const updated = await updateDomain(db, claim, {
    providerId: made.id,
    providerStatus: made.status,
    providerSslStatus: made.ssl,
    checkedAt: new Date(),
  });
  if (updated) return updated;
  // Removed while Cloudflare made it: the hostname made for it has no row to remove it later.
  await provider.delete(made.id).catch(() => {});
  return claim;
}

/**
 * Looks at a domain now: our TXT record (until it was seen once), Cloudflare's hostname and
 * certificate, and moves the state as `nextDomainState` says. `nudge` asks Cloudflare to validate
 * again at once (a person pressed verify); the daily job leaves it to Cloudflare's own schedule.
 */
export async function check(deps: DomainDeps, row: DomainRow, options: { nudge: boolean }) {
  const { db, config, provider } = deps;
  const now = new Date();
  let verifiedAt = row.verifiedAt;
  if (!verifiedAt) {
    const values = await deps.txt(ownershipRecordName(row.hostname)).catch(unavailable);
    if (values.includes(ownershipRecordValue(row.challenge))) verifiedAt = now;
  }

  let providerId = row.providerId;
  let snapshot = null;
  try {
    if (providerId) {
      snapshot =
        options.nudge && verifiedAt && row.state !== "active"
          ? await provider.recheck(providerId, row.hostname)
          : await provider.get(providerId);
    }
    let facts = nextDomainState({
      ownership: verifiedAt !== null,
      hostname: snapshot,
      expired: row.expiresAt !== null && row.expiresAt <= now,
    });
    if (facts.recreate && verifiedAt && facts.state !== "failed") {
      snapshot = await provider.create(row.hostname);
      providerId = snapshot.id;
      facts = nextDomainState({
        ownership: true,
        hostname: snapshot,
        expired: row.expiresAt !== null && row.expiresAt <= now,
      });
    }

    // A domain that will not come back (expired, blocked, or refused a certificate) frees its
    // Cloudflare hostname now: the daily job never looks at a failed one again.
    if (facts.state === "failed" && providerId) {
      await provider.delete(providerId);
      providerId = null;
    }

    const becameActive = facts.state === "active";
    const lostActive = row.state === "active" && facts.state !== "active";
    // Written only to the claim this check started from: one removed meanwhile, or removed and
    // added again by anyone, is not touched, and the result is dropped.
    const updated = await updateDomain(db, row, {
      state: facts.state,
      errorCode: facts.error,
      errorDetail: facts.state === "failed" ? snapshot?.errors.join("; ") || null : null,
      verifiedAt,
      providerId,
      providerStatus: snapshot?.status ?? null,
      providerSslStatus: snapshot?.ssl ?? null,
      activatedAt: becameActive ? (row.activatedAt ?? now) : row.activatedAt,
      // Active is not on a clock; falling out of it starts one again.
      expiresAt: becameActive
        ? null
        : lostActive
          ? new Date(now.getTime() + config.customDomains!.pendingSeconds * 1000)
          : row.expiresAt,
      checkedAt: now,
    });
    if (updated && (becameActive || lostActive) && row.state !== updated.state) {
      await noteUrlChange(deps, updated);
    }
    if (updated && updated.state !== row.state) {
      createLogger({ component: "domains" }).info("domain.state", {
        orgId: row.orgId,
        from: row.state,
        to: updated.state,
        error: updated.errorCode,
      });
    }
    if (!updated && providerId && providerId !== row.providerId) {
      // A hostname this check made for a claim that is gone: nothing else would remove it.
      await provider.delete(providerId).catch(() => {});
    }
    return updated ?? row;
  } catch (error) {
    return unavailable(error);
  }
}

/** Removes a domain here and at Cloudflare. A hostname Cloudflare no longer holds is fine. */
export async function remove(deps: DomainDeps, row: DomainRow) {
  if (row.providerId) {
    try {
      await deps.provider.delete(row.providerId);
    } catch (error) {
      unavailable(error);
    }
  }
  await deleteDomain(deps.db, row);
  if (row.state === "active") await noteUrlChange(deps, row);
}

/**
 * Takes an org's domains out of Cloudflare before its rows go with the org. Each one released is
 * marked so (`providerId` null), so a second attempt only retries the rest. Throws the refusal
 * when Cloudflare does not answer: the org must not be deleted then, since nothing would find
 * those hostnames again once the rows are gone.
 */
export async function releaseOrgDomains(deps: DomainDeps, orgId: string) {
  for (const row of await listDomains(deps.db, orgId)) {
    if (!row.providerId) continue;
    try {
      await deps.provider.delete(row.providerId);
    } catch (error) {
      createLogger({ component: "domains" }).error("domain.release_failed", { error, orgId });
      return unavailable(error);
    }
    await updateDomain(deps.db, row, { providerId: null });
  }
}

/** The daily job: looks again at the domains least recently checked. */
export async function refreshDomains(deps: DomainDeps, limit = 100) {
  const log = createLogger({ component: "domains" });
  let checked = 0;
  for (const row of await domainsToCheck(deps.db, limit)) {
    try {
      await check(deps, row, { nudge: false });
      checked += 1;
    } catch (error) {
      // One unreachable resolver or a Cloudflare error must not stop the rest, nor keep its
      // place at the front of the queue: it goes to the back like a domain that was checked.
      log.warn("domain.check_failed", { error, orgId: row.orgId });
      await updateDomain(deps.db, row, { checkedAt: new Date() }).catch(() => {});
    }
  }
  log.info("domain.refreshed", { checked });
}
