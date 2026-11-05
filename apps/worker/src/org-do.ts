// One Org Durable Object per org (spec section 5): the live list of the org's open shares for the
// wall, pushed to every open wall over WebSockets (hibernation API, no polling), and the counts
// behind the org's fair-use limits: active shares and bytes relayed this month.
//
// It also holds the org's machines (ADR 0018): one socket per running `wurmhol host`, which
// reports the ports open on its computer and opens a pipe to one when its owner asks from the
// wall. Each machine is visible to the person whose token it runs on, and no one else.
import { DurableObject } from "cloudflare:workers";
import {
  type Machine,
  type MachinesEvent,
  newShareCard,
  parseHostMessage,
  type RelayMessage,
  type ShareCard,
  type WallEvent,
} from "@wurmhol/protocol";

export type Reservation =
  | { ok: true }
  | { ok: false; reason: "active_limit"; limit: number }
  | { ok: false; reason: "monthly_limit"; limit: number };

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

/** Calendar month in UTC: the window of the monthly byte limit. */
function month(at = Date.now()) {
  return new Date(at).toISOString().slice(0, 7);
}

export class Org extends DurableObject<Env> {
  /** Opens waiting on a machine's answer, by request id. In memory: an RPC keeps it awake. */
  #pending = new Map<string, (result: OpenPortResult) => void>();

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

  #usage() {
    const stored = this.ctx.storage.kv.get<{ month: string; bytes: number }>("usage");
    return stored && stored.month === month() ? stored.bytes : 0;
  }

  /**
   * Holds a slot for a new share, if the org is under both limits. Atomic: the object handles one
   * call at a time and `kv` writes are synchronous, so two CLIs starting at once cannot both get
   * the fifth slot.
   */
  reserve(card: ShareCard, limits: { active: number; monthlyBytes: number }): Reservation {
    if (this.#usage() >= limits.monthlyBytes) {
      return { ok: false, reason: "monthly_limit", limit: limits.monthlyBytes };
    }
    if (this.#cards().length >= limits.active) {
      return { ok: false, reason: "active_limit", limit: limits.active };
    }
    this.ctx.storage.kv.put(`share:${card.id}`, card);
    this.#broadcast({ type: "share.started", share: card });
    return { ok: true };
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
    if (!this.ctx.storage.kv.delete(`share:${id}`)) return;
    this.#broadcast({ type: "share.ended", id });
  }

  /** Adds relayed bytes to this month's count. Returns whether the org is now over its limit. */
  addUsage(bytes: number, monthlyBytes: number) {
    const total = this.#usage() + bytes;
    this.ctx.storage.kv.put("usage", { month: month(), bytes: total });
    return { bytes: total, over: total >= monthlyBytes };
  }

  usage() {
    return { month: month(), bytes: this.#usage() };
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
    // 1005/1006 are reserved and cannot be sent back.
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch {
      // Already closed.
    }
    if (this.ctx.getTags(socket).includes("machine")) {
      const { userId } = socket.deserializeAttachment() as MachineAttachment;
      this.#pushMachines(userId, new Set([socket]));
    }
  }
}
