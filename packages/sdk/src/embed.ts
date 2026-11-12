// `WurmholEmbed`: a SaaS backend's client for embedded tunnels (ADR 0032), with its integration
// key (`whk_`). Server only: the key manages every tunnel of the application and issues grants,
// so it must never reach a browser or a user's computer. Tenants and subjects are named by the
// SaaS's own ids. Every failure is a `FixError` whose message says the fix.
//
//   const embed = new WurmholEmbed({ key: process.env.WURMHOL_KEY! });
//   await embed.tenants.put("acme");
//   await embed.subjects.put("acme", "alice", { kind: "user" });
//   const { tunnel, connector } = await embed.tunnels.create({ tenant: "acme", owner: "alice" });
//   // Hand `connector.connector` to Alice's agent: keepOpen({ token, port }).
//   const grant = await embed.grants.issue({ tunnel: tunnel.id, subject: "alice", kind: "browser" });
//   // Redirect Alice's browser to grant.launchUrl.
import { embedCredentialKind } from "@wurmhol/protocol";
import pkg from "../package.json" with { type: "json" };
import { explainRefusal, FixError } from "./errors.ts";
import { type Answer, type RequestJson, routeJson, send } from "./http.ts";
import { DEFAULT_SERVER, originOf } from "./pipe.ts";

export interface WurmholEmbedOptions {
  /** The application's integration key (`whk_…`), from the console. Keep it on your server. */
  key: string;
  /** A self-hosted install's origin. Default `https://api.wurmhol.com`. */
  server?: string;
  /** Names your backend in the `User-Agent`: `{ name: "dorks-api", version: "1.2.0" }`. */
  client?: { name: string; version: string };
}

export type SubjectKind = "user" | "service";

export type GrantKind = "client" | "browser";

export type EmbedTunnelState = "never" | "live" | "away" | "stopped" | "ended";

export interface EmbedTenant {
  id: string;
  disabled: boolean;
  monthlyRequests: number | null;
  activeTunnels: number | null;
}

export interface EmbedSubject {
  id: string;
  tenant: string;
  kind: SubjectKind;
  disabled: boolean;
}

/** A tunnel's lifecycle and health: never anything from its pages. */
export interface EmbedTunnel {
  id: string;
  /** Stable across the agent's reconnects and reopens. */
  url: string;
  tenant: string;
  owner: string;
  state: EmbedTunnelState;
  createdAt: string;
  stoppedAt: string | null;
  session: {
    id: string;
    startedAt: string;
    liveSince: string | null;
    awaySince: string | null;
    lastRequestAt: string | null;
    bytes: number;
  } | null;
  lastEnd: { reason: string | null; at: string } | null;
  /** Who may be granted it; on `tunnels.get` only. */
  access?: string[];
}

/** A connector for the tunnel's agent (`whc_…`), shown once. */
export interface EmbedConnector {
  id: string;
  connector: string;
  expiresAt: string;
}

export interface EmbedGrant {
  id: string;
  kind: GrantKind;
  tunnel: string;
  subject: string;
  expiresAt: string;
  /** A `client` grant's token (`whg_…`): send it as `x-wurmhol-grant`, or as a subprotocol. */
  token?: string;
  /** A `browser` grant's one-time link: send the user's browser there within 60 seconds. */
  launchUrl?: string;
}

export interface EmbedGrantEvent {
  grant: string;
  event: "issued" | "revoked";
  subject: string;
  key: string | null;
  at: string;
  expiresAt: string;
}

export interface EmbedCounts {
  requests: number;
  bytes: number;
  openTunnels: number;
}

export interface EmbedUsage {
  /** The usage window: the calendar month, or the org's billing period. */
  window: string;
  app: EmbedCounts & { limits: { monthlyRequests: number | null; activeTunnels: number | null } };
  tenants: Record<
    string,
    EmbedCounts & { limits: { monthlyRequests: number | null; activeTunnels: number } }
  >;
}

const path = (...parts: string[]) => parts.map((part) => encodeURIComponent(part)).join("/");

export class WurmholEmbed {
  readonly server: string;
  readonly #key: string;
  readonly #client: { name: string; version: string };

  constructor(options: WurmholEmbedOptions) {
    // A page's code is anyone's to read: an integration key there would hand out every tunnel.
    if ("document" in globalThis) {
      throw new FixError(
        "WurmholEmbed runs on your server only. Issue grants there and send the browser a launch URL.",
        { code: "unsupported" },
      );
    }

    const key = options.key?.trim();

    if (embedCredentialKind(key) !== "key") {
      throw new FixError(
        "Pass the application's integration key (whk_…). An owner makes one in the console.",
        { code: "no_token" },
      );
    }

    this.#key = key;
    this.server = originOf(options.server ?? DEFAULT_SERVER);
    this.#client = options.client ?? { name: "wurmhol-sdk", version: pkg.version };
  }

  readonly tenants = {
    /** Makes or updates a tenant. `disabled` ends its sessions; limits override the app's. */
    put: async (
      id: string,
      change: {
        disabled?: boolean;
        monthlyRequests?: number | null;
        activeTunnels?: number | null;
      } = {},
    ) => (await this.#json<{ tenant: EmbedTenant }>("PUT", `tenants/${path(id)}`, change)).tenant,
    /** Disables a tenant and deletes its tunnels. */
    remove: async (id: string) => {
      await this.#call("DELETE", `tenants/${path(id)}`);
    },
  };

  readonly subjects = {
    /** Makes or updates a tenant's subject. Disabling one revokes its grants. */
    put: async (tenant: string, id: string, input: { kind: SubjectKind; disabled?: boolean }) =>
      (
        await this.#json<{ subject: EmbedSubject }>(
          "PUT",
          `tenants/${path(tenant, "subjects", id)}`,
          input,
        )
      ).subject,
    /** Disables a subject, takes it off every list, revokes its grants, deletes its tunnels. */
    remove: async (tenant: string, id: string) => {
      await this.#call("DELETE", `tenants/${path(tenant, "subjects", id)}`);
    },
    /** Revokes every grant of a subject, on every tunnel. Returns how many. */
    revokeGrants: async (tenant: string, id: string) =>
      (
        await this.#json<{ revoked: number }>(
          "POST",
          `tenants/${path(tenant, "subjects", id, "revoke-grants")}`,
        )
      ).revoked,
  };

  readonly tunnels = {
    /** A new tunnel for a tenant's subject, and the connector its agent opens it with. */
    create: (input: {
      tenant: string;
      owner: string;
      /** More of the tenant's subjects who may be granted it. */
      access?: string[];
      connectorTtlSeconds?: number;
    }) => this.#json<{ tunnel: EmbedTunnel; connector: EmbedConnector }>("POST", "tunnels", input),
    /** The application's tunnels; of a tenant, or that one of its subjects may be granted. */
    list: async (filter: { tenant?: string; subject?: string } = {}) => {
      const query = new URLSearchParams();

      if (filter.tenant !== undefined) query.set("tenant", filter.tenant);

      if (filter.subject !== undefined) query.set("subject", filter.subject);
      const suffix = query.size ? `?${query}` : "";

      return (await this.#json<{ tunnels: EmbedTunnel[] }>("GET", `tunnels${suffix}`)).tunnels;
    },
    get: async (id: string) =>
      (await this.#json<{ tunnel: EmbedTunnel }>("GET", `tunnels/${path(id)}`)).tunnel,
    /** Ends its session; its agent stops, and may open it again when restarted. */
    stop: async (id: string) => {
      await this.#call("POST", `tunnels/${path(id, "stop")}`);
    },
    /** Ends it for good: its session, connectors and grants. Its URL is never reused. */
    remove: async (id: string) => {
      await this.#call("DELETE", `tunnels/${path(id)}`);
    },
    /** Lets one more of the tenant's subjects be granted it. */
    allow: async (id: string, subject: string) => {
      await this.#call("PUT", `tunnels/${path(id, "access", subject)}`);
    },
    /** Takes a subject off its list, revoking that subject's grants to it. */
    disallow: async (id: string, subject: string) => {
      await this.#call("DELETE", `tunnels/${path(id, "access", subject)}`);
    },
    /** A new connector; `rotate` revokes the others and ends a session they opened. */
    connector: async (id: string, options: { rotate?: boolean; ttlSeconds?: number } = {}) =>
      (
        await this.#json<{ connector: EmbedConnector }>(
          "POST",
          `tunnels/${path(id, "connectors")}`,
          options,
        )
      ).connector,
    /** Revokes a connector; a session it opened ends with `revoked`. */
    revokeConnector: async (id: string, connectorId: string) => {
      await this.#call("DELETE", `tunnels/${path(id, "connectors", connectorId)}`);
    },
    /** The tunnel's grant log, newest first. */
    grantLog: async (id: string) =>
      (await this.#json<{ events: EmbedGrantEvent[] }>("GET", `tunnels/${path(id, "grants")}`))
        .events,
  };

  readonly grants = {
    /** A grant for a subject on the tunnel's list: 1 hour by default, 24 at most. */
    issue: async (input: {
      tunnel: string;
      subject: string;
      kind: GrantKind;
      ttlSeconds?: number;
      /** A browser grant's first page on the tunnel. */
      next?: string;
    }) => (await this.#json<{ grant: EmbedGrant }>("POST", "grants", input)).grant,
    /** Refused at the next request; open WebSockets close with 4403. */
    revoke: async (id: string) => {
      await this.#call("DELETE", `grants/${path(id)}`);
    },
  };

  /** The application's usage this window, and each named tenant's, with the limits in effect. */
  async usage(options: { tenants?: string[] } = {}) {
    const query = new URLSearchParams();

    for (const tenant of options.tenants ?? []) query.append("tenant", tenant);

    return this.#json<EmbedUsage>("GET", `usage${query.size ? `?${query}` : ""}`);
  }

  /** One call to `/v1/embed`: the answer when it is a success, else the fix. */
  async #call(method: string, route: string, json?: RequestJson): Promise<Answer> {
    const answer = await send(new URL(`/v1/embed/${route}`, this.server), {
      server: this.server,
      version: this.#client.version,
      product: this.#client.name,
      method,
      headers: { authorization: `Bearer ${this.#key}` },
      json,
    });

    if (answer.status >= 200 && answer.status < 300) return answer;

    throw explainRefusal(answer.status, answer.body, {
      server: this.server,
      viaProxy: answer.viaProxy,
    });
  }

  /** `#call` for a route whose answer the caller reads: its JSON body. */
  async #json<T extends object>(method: string, route: string, json?: RequestJson): Promise<T> {
    return routeJson<T>(await this.#call(method, route, json), this.server);
  }
}

export interface GrantHeaders {
  "x-wurmhol-grant": string;
}

/** The header a program sends a client grant in, for `fetch` or a WebSocket's handshake. */
export function grantHeaders(token: string): GrantHeaders {
  return { "x-wurmhol-grant": token };
}
