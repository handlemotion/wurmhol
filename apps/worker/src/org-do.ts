// One Org Durable Object per org (spec section 5): the live list of the org's open shares for the
// wall, pushed to every open wall over WebSockets (hibernation API, no polling), and the counts
// behind the org's limits: active shares, and bytes and viewer requests relayed this month.
//
// A Business org's requests are also metered to Stripe (ADR 0027). Usage arrives from each Share
// object in numbered batches that are applied once, however often one is retried, and its
// requests go out as meter events from a stored outbox, each with an identifier it keeps across
// retries, so Stripe counts each request exactly once.
//
// It also holds the org's machines (ADR 0018): one socket per running `wurmhol host`, which
// reports the ports open on its computer and opens a pipe to one when its owner asks from the
// wall. Each machine is visible to the person whose token it runs on, and no one else.
import { DurableObject } from "cloudflare:workers";
import { createStripeClient, METER_EVENT_NAME } from "@wurmhol/auth";
import { loadConfig } from "./env.ts";
import { createLogger } from "./log.ts";
import {
  type Machine,
  type MachinesEvent,
  newShareCard,
  parseHostMessage,
  type RelayMessage,
  sendableCloseCode,
  type ShareCard,
  type WallEvent,
} from "@wurmhol/protocol";

export type Reservation =
  | { ok: true }
  | { ok: false; reason: "active_limit"; limit: number }
  | { ok: false; reason: "monthly_limit"; limit: number }
  | { ok: false; reason: "request_limit"; limit: number };

/** Relayed in the current window: bytes both ways, and viewer requests. */
export interface Usage {
  bytes: number;
  requests: number;
}

/** One Share object's usage since its last batch, numbered in the order it sends them. */
export interface UsageBatch extends Usage {
  seq: number;
}

/** What the org's usage counts against (`plan.ts`). */
export interface UsageLimits {
  monthlyBytes: number;
  monthlyRequests: number;
  /** Business: its Stripe billing period, which the window follows. Null: the calendar month. */
  period: { start: number; end: number } | null;
  /** Business: the Stripe customer its requests are metered to. */
  meter: { customer: string } | null;
}

/** Limits the org's object keeps: the latest the Worker gave it. */
type StoredLimits = UsageLimits & { active: number };

/** An embedded tunnel's open session (ADR 0032): counted and listed, never a card on the wall. */
export interface EmbeddedSession {
  id: string;
  appId: string;
  tenantId: string;
  tunnelId: string;
}

/** Requests not yet sent to Stripe, per customer and window: `at` is the last one's time. */
type MeterPending = Record<string, { customer: string; value: number; at: number }>;

/** The meter event being sent: kept until Stripe has it, so a retry reuses its identifier. */
interface MeterOutbox {
  identifier: string;
  customer: string;
  value: number;
  at: number;
  attempts: number;
  /** When it first went out: past `METER_GIVE_UP_MS`, a resend could be counted twice. */
  firstSentAt: number;
}

/** How soon pending requests go to Stripe, and the longest wait between retries. */
const METER_FLUSH_MS = 60_000;
const METER_RETRY_MAX_MS = 60 * 60_000;
/**
 * Stripe holds an identifier unique for at least 24 hours. An event still failing after this
 * long is dropped and logged: billing a request twice is worse than missing it.
 */
const METER_GIVE_UP_MS = 20 * 60 * 60_000;

/** Who a machine's socket belongs to: kept on the socket, so it survives hibernation. */
interface MachineAttachment extends Machine {
  userId: string;
  tokenId: string;
}

/** The headers `/host` and `/api/machines/live` hand the Org object; never a client's own. */
const ORG_SOCKET_HEADERS = {
  kind: "x-wurmhol-org-socket",
  userId: "x-wurmhol-org-user",
  tokenId: "x-wurmhol-org-token",
  name: "x-wurmhol-org-machine-name",
} as const;

/** Which socket a route opens on the Org object: a wall, an owner's Create pipe card, a machine. */
export type OrgSocket =
  | { kind: "wall" }
  | { kind: "watch"; userId: string }
  | { kind: "machine"; userId: string; tokenId: string; name: string };

/** The org's Durable Object: one per org, named by its id. */
export function orgStub(env: Env, orgId: string) {
  return env.ORG.get(env.ORG.idFromName(orgId));
}

/** The upgrade request to forward to the Org object, carrying only the socket fields set here. */
export function toOrg(raw: Request, socket: OrgSocket): Request {
  const headers = new Headers(raw.headers);
  for (const name of Object.values(ORG_SOCKET_HEADERS)) headers.delete(name);
  if (socket.kind !== "wall") {
    for (const [key, value] of Object.entries(socket)) {
      headers.set(ORG_SOCKET_HEADERS[key as keyof typeof ORG_SOCKET_HEADERS], value);
    }
  }
  return new Request(raw, { headers });
}

export type OpenPortResult =
  | { ok: true; url: string }
  | { ok: false; status: 404 | 409 | 502 | 504; error: string };

/** How long the wall waits for a machine to open a pipe: the CLI's own connect is 15 s. */
const OPEN_TIMEOUT_MS = 30_000;

/** Calendar month in UTC: the window of the monthly limits. */
function month(at = Date.now()) {
  return new Date(at).toISOString().slice(0, 7);
}

/**
 * The usage window's key: a Business org's billing period, or the calendar month. Past a
 * period's end, before Stripe's renewal reaches us, the next period has already begun at it.
 */
function windowOf(limits: Pick<UsageLimits, "period"> | null, at = Date.now()) {
  const period = limits?.period;
  if (!period) return month(at);
  return `period:${at >= period.end ? period.end : period.start}`;
}

/** Whether Stripe already has this event: its identifier was used. */
function isDuplicate(error: unknown) {
  return /duplicate/i.test(String((error as { code?: string })?.code ?? ""));
}

export class Org extends DurableObject<Env> {
  /** Opens waiting on a machine's answer, by request id. In memory: an RPC keeps it awake. */
  #pending = new Map<string, (result: OpenPortResult) => void>();
  #log = createLogger({ component: "org" });

  #cards(): ShareCard[] {
    return [...this.ctx.storage.kv.list<ShareCard>({ prefix: "share:" })]
      .map(([, card]) => newShareCard(card))
      .toSorted((a, b) => b.startedAt - a.startedAt);
  }

  #broadcast(event: WallEvent) {
    const message = JSON.stringify(event);
    // Walls are the untagged sockets; machines and their owners' cards carry tags.
    for (const socket of this.ctx.getWebSockets()) {
      if (this.ctx.getTags(socket).length) continue;
      try {
        socket.send(message);
      } catch {
        // A wall that went away mid-send; its close event cleans it up.
      }
    }
  }

  #limits() {
    return this.ctx.storage.kv.get<StoredLimits>("limits") ?? null;
  }

  /** This window's usage. `month` is the window's key (a calendar month, or a billing period). */
  #usage(limits: Pick<UsageLimits, "period"> | null = this.#limits()): Usage {
    const stored = this.ctx.storage.kv.get<{ month: string } & Partial<Usage>>("usage");
    return stored && stored.month === windowOf(limits)
      ? { bytes: stored.bytes ?? 0, requests: stored.requests ?? 0 }
      : { bytes: 0, requests: 0 };
  }

  #over(usage: Usage, limits: Pick<UsageLimits, "monthlyBytes" | "monthlyRequests">) {
    return usage.bytes >= limits.monthlyBytes || usage.requests >= limits.monthlyRequests;
  }

  /**
   * The org's current limits, from the Worker: when a share starts, and when an owner changes
   * the spend cap. Open shares count against these, not the ones they started with.
   */
  setLimits(limits: StoredLimits) {
    this.ctx.storage.kv.put("limits", limits);
  }

  /**
   * Holds a slot for a new share, if the org is under every limit. Atomic: the object handles one
   * call at a time and `kv` writes are synchronous, so two CLIs starting at once cannot both get
   * the last slot.
   */
  reserve(card: ShareCard, limits: StoredLimits): Reservation {
    this.setLimits(limits);
    const usage = this.#usage(limits);
    if (usage.bytes >= limits.monthlyBytes) {
      return { ok: false, reason: "monthly_limit", limit: limits.monthlyBytes };
    }
    if (usage.requests >= limits.monthlyRequests) {
      return { ok: false, reason: "request_limit", limit: limits.monthlyRequests };
    }
    if (this.#cards().length >= limits.active) {
      return { ok: false, reason: "active_limit", limit: limits.active };
    }
    this.ctx.storage.kv.put(`share:${card.id}`, card);
    this.#broadcast({ type: "share.started", share: card });
    return { ok: true };
  }

  /**
   * Holds a slot for an embedded tunnel's session: the org's usage limits apply as to any pipe,
   * and its open sessions count against `active` (`LIMIT_EMBED_ACTIVE`), apart from the wall's.
   */
  reserveEmbedded(session: EmbeddedSession, limits: StoredLimits): Reservation {
    this.setLimits({ ...limits, active: this.#limits()?.active ?? limits.active });
    const usage = this.#usage(limits);
    if (usage.bytes >= limits.monthlyBytes) {
      return { ok: false, reason: "monthly_limit", limit: limits.monthlyBytes };
    }
    if (usage.requests >= limits.monthlyRequests) {
      return { ok: false, reason: "request_limit", limit: limits.monthlyRequests };
    }
    if (this.listEmbedded().length >= limits.active) {
      return { ok: false, reason: "active_limit", limit: limits.active };
    }
    this.ctx.storage.kv.put(`embed:${session.id}`, session);
    return { ok: true };
  }

  /** The org's open embedded sessions. */
  listEmbedded(): EmbeddedSession[] {
    return [...this.ctx.storage.kv.list<EmbeddedSession>({ prefix: "embed:" })].map(
      ([, session]) => session,
    );
  }

  /** Changes a card (title, favicon, last request, live or away). A removed card stays removed. */
  update(id: string, patch: Partial<Omit<ShareCard, "id">>) {
    const card = this.ctx.storage.kv.get<ShareCard>(`share:${id}`);
    if (!card) return;
    const next = newShareCard({ ...card, ...patch });
    this.ctx.storage.kv.put(`share:${id}`, next);
    this.#broadcast({ type: "share.updated", share: next });
  }

  /** Takes an ended share off the wall and frees its slot. Safe to call twice. */
  remove(id: string) {
    // Its last batch came before this (the Share object sends them in order, then ends).
    this.ctx.storage.kv.delete(`applied:${id}`);
    this.ctx.storage.kv.delete(`embed:${id}`);
    if (!this.ctx.storage.kv.delete(`share:${id}`)) return;
    this.#broadcast({ type: "share.ended", id });
  }

  /**
   * Adds a share's batch to the window's counts, once: a batch whose number this share already
   * sent is a retry and changes nothing. `fallback` is what the share started with, for an org
   * whose object has no limits stored yet. Returns whether the org is now over a limit.
   */
  async addUsage(shareId: string, batch: UsageBatch, fallback: UsageLimits) {
    const limits = this.#limits() ?? fallback;
    const usage = this.#usage(limits);
    if (batch.seq <= (this.ctx.storage.kv.get<number>(`applied:${shareId}`) ?? 0)) {
      return { ...usage, over: this.#over(usage, limits) };
    }
    const total = { bytes: usage.bytes + batch.bytes, requests: usage.requests + batch.requests };
    this.ctx.storage.kv.put("usage", { month: windowOf(limits), ...total });
    this.ctx.storage.kv.put(`applied:${shareId}`, batch.seq);
    if (limits.meter && batch.requests > 0) await this.#meter(limits, batch.requests);
    return { ...total, over: this.#over(total, limits) };
  }

  usage() {
    return { month: windowOf(this.#limits()), ...this.#usage() };
  }

  /** Queues requests for Stripe, per customer and window, and makes sure an alarm sends them. */
  async #meter(limits: UsageLimits, requests: number) {
    const customer = limits.meter!.customer;
    const now = Date.now();
    const key = `${customer}|${windowOf(limits, now)}`;
    const pending = this.ctx.storage.kv.get<MeterPending>("meter:pending") ?? {};
    const entry = pending[key] ?? { customer, value: 0, at: now };
    pending[key] = { customer, value: entry.value + requests, at: now };
    this.ctx.storage.kv.put("meter:pending", pending);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + METER_FLUSH_MS);
    }
  }

  /**
   * Sends metered requests to Stripe, one event at a time (Stripe refuses concurrent events for
   * one customer). An event stays in the outbox until Stripe has it, and a retry keeps its
   * identifier, which Stripe holds unique for at least 24 hours: retries stop well before that.
   */
  override async alarm() {
    const key = loadConfig(this.env).auth.billing?.secretKey;
    if (!key) {
      // Billing went off: nothing to send to.
      this.ctx.storage.kv.delete("meter:pending");
      this.ctx.storage.kv.delete("meter:outbox");
      return;
    }
    const stripe = createStripeClient(key);
    for (;;) {
      let outbox = this.ctx.storage.kv.get<MeterOutbox>("meter:outbox");
      if (!outbox) {
        const pending = this.ctx.storage.kv.get<MeterPending>("meter:pending") ?? {};
        const [next] = Object.keys(pending);
        if (next === undefined) return;
        const seq = (this.ctx.storage.kv.get<number>("meter:seq") ?? 0) + 1;
        outbox = {
          identifier: `${this.ctx.id.toString()}-${seq}`,
          ...pending[next]!,
          attempts: 0,
          firstSentAt: Date.now(),
        };
        delete pending[next];
        // One synchronous write set: the requests leave pending as the event enters the outbox.
        this.ctx.storage.kv.put("meter:seq", seq);
        this.ctx.storage.kv.put("meter:outbox", outbox);
        this.ctx.storage.kv.put("meter:pending", pending);
      }
      try {
        await stripe.billing.meterEvents.create({
          event_name: METER_EVENT_NAME,
          identifier: outbox.identifier,
          timestamp: Math.floor(outbox.at / 1000),
          payload: { stripe_customer_id: outbox.customer, value: String(outbox.value) },
        });
      } catch (error) {
        if (!isDuplicate(error)) {
          const attempts = outbox.attempts + 1;
          const fields = {
            identifier: outbox.identifier,
            value: outbox.value,
            attempts,
            code: (error as { code?: string })?.code ?? null,
          };
          if (Date.now() - outbox.firstSentAt < METER_GIVE_UP_MS) {
            this.ctx.storage.kv.put("meter:outbox", { ...outbox, attempts });
            this.#log.warn("meter.send_failed", fields);
            const wait = Math.min(METER_FLUSH_MS * 2 ** attempts, METER_RETRY_MAX_MS);
            await this.ctx.storage.setAlarm(Date.now() + wait);
            return;
          }
          this.#log.error("meter.dropped", fields);
        }
      }
      this.ctx.storage.kv.delete("meter:outbox");
    }
  }

  list() {
    return this.#cards();
  }

  #machines(userId: string, except: ReadonlySet<WebSocket> = new Set()): Machine[] {
    return this.ctx
      .getWebSockets(`user:${userId}`)
      .filter((socket) => !except.has(socket) && this.ctx.getTags(socket).includes("machine"))
      .map((socket) => {
        const { id, name, ports, connectedAt } =
          socket.deserializeAttachment() as MachineAttachment;
        return { id, name, ports, connectedAt };
      })
      .toSorted((a, b) => a.connectedAt - b.connectedAt);
  }

  /** Tells the owner's open cards what their machines are now. */
  #pushMachines(userId: string, except?: ReadonlySet<WebSocket>) {
    const message = JSON.stringify({
      type: "machines",
      machines: this.#machines(userId, except),
    } satisfies MachinesEvent);
    for (const socket of this.ctx.getWebSockets(`watch:${userId}`)) {
      try {
        socket.send(message);
      } catch {
        // Gone mid-send; its close event cleans it up.
      }
    }
  }

  /**
   * Asks one of the caller's machines to open a pipe to a port it reported. Resolves with the
   * pipe's URL once the machine has it, or with why not.
   */
  async openPort(userId: string, machineId: string, port: number): Promise<OpenPortResult> {
    const socket = this.ctx
      .getWebSockets(`machine:${machineId}`)
      .find((s) => (s.deserializeAttachment() as MachineAttachment).userId === userId);
    if (!socket) return { ok: false, status: 404, error: "That computer is not connected." };
    const machine = socket.deserializeAttachment() as MachineAttachment;
    // Only a port the machine itself reported: the wall cannot reach one it did not offer.
    if (!machine.ports.some((p) => p.port === port)) {
      return { ok: false, status: 409, error: `Nothing is serving port ${port} there now.` };
    }
    const id = crypto.randomUUID();
    const answer = new Promise<OpenPortResult>((resolve) => {
      this.#pending.set(id, resolve);
      setTimeout(
        () => resolve({ ok: false, status: 504, error: "That computer did not answer." }),
        OPEN_TIMEOUT_MS,
      );
    });
    try {
      socket.send(JSON.stringify({ type: "open", id, port } satisfies RelayMessage));
    } catch {
      this.#pending.delete(id);
      return { ok: false, status: 404, error: "That computer is not connected." };
    }
    const result = await answer;
    this.#pending.delete(id);
    return result;
  }

  /** Disconnects the machines a revoked token runs. */
  dropToken(tokenId: string) {
    this.#drop((machine) => machine.tokenId === tokenId, "token revoked");
  }

  /** Disconnects every machine: the org is being deleted. */
  dropAll() {
    this.#drop(() => true, "org deleted");
  }

  /** Closes the matching machines' sockets (4001: the CLI says why) and updates their owners. */
  #drop(match: (machine: MachineAttachment) => boolean, reason: string) {
    const dropped = new Set<WebSocket>();
    const owners = new Set<string>();
    for (const socket of this.ctx.getWebSockets("machine")) {
      const machine = socket.deserializeAttachment() as MachineAttachment;
      if (!match(machine)) continue;
      try {
        socket.close(4001, reason);
      } catch {
        // Already closed.
      }
      dropped.add(socket);
      owners.add(machine.userId);
    }
    for (const userId of owners) this.#pushMachines(userId, dropped);
  }

  /**
   * A WebSocket: a wall's feed (a snapshot now, then every change as it happens), a machine's
   * connection, or an owner's Create pipe card watching their machines. The route that forwards
   * it sets which, in `ORG_SOCKET_HEADERS`.
   */
  override async fetch(request: Request) {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    const kind = request.headers.get(ORG_SOCKET_HEADERS.kind);
    const userId = request.headers.get(ORG_SOCKET_HEADERS.userId);
    const { 0: client, 1: server } = new WebSocketPair();
    if (kind === "machine" && userId) {
      const machine: MachineAttachment = {
        id: crypto.randomUUID(),
        name: request.headers.get(ORG_SOCKET_HEADERS.name) ?? "",
        ports: [],
        connectedAt: Date.now(),
        userId,
        tokenId: request.headers.get(ORG_SOCKET_HEADERS.tokenId) ?? "",
      };
      this.ctx.acceptWebSocket(server, ["machine", `user:${userId}`, `machine:${machine.id}`]);
      server.serializeAttachment(machine);
      this.#pushMachines(userId);
    } else if (kind === "watch" && userId) {
      this.ctx.acceptWebSocket(server, ["watch", `watch:${userId}`]);
      server.send(
        JSON.stringify({
          type: "machines",
          machines: this.#machines(userId),
        } satisfies MachinesEvent),
      );
    } else {
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: "snapshot", shares: this.#cards() } satisfies WallEvent));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Walls and cards only listen; a machine reports its ports and answers opens. */
  override webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    if (!this.ctx.getTags(socket).includes("machine") || typeof data !== "string") return;
    let message;
    try {
      message = parseHostMessage(JSON.parse(data));
    } catch {
      return;
    }
    if (!message) return;
    if (message.type === "ports") {
      const machine = socket.deserializeAttachment() as MachineAttachment;
      socket.serializeAttachment({ ...machine, ports: message.ports });
      this.#pushMachines(machine.userId);
      return;
    }
    const resolve = this.#pending.get(message.id);
    if (!resolve) return;
    resolve(
      message.type === "opened"
        ? { ok: true, url: message.url }
        : { ok: false, status: 502, error: message.message },
    );
  }

  override webSocketClose(socket: WebSocket, code: number) {
    try {
      socket.close(sendableCloseCode(code), "bye");
    } catch {
      // Already closed.
    }
    if (this.ctx.getTags(socket).includes("machine")) {
      const { userId } = socket.deserializeAttachment() as MachineAttachment;
      this.#pushMachines(userId, new Set([socket]));
    }
  }
}
