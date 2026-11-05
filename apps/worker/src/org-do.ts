// One Org Durable Object per org (spec section 5): the live list of the org's open shares for the
// wall, pushed to every open wall over WebSockets (hibernation API, no polling), and the counts
// behind the org's fair-use limits: active shares and bytes relayed this month.
import { DurableObject } from "cloudflare:workers";
import type { PipeSource } from "@wurmhol/protocol";

/** One card on the wall. */
export interface ShareCard {
  id: string;
  url: string;
  port: number;
  /** Name of the person whose token started it. */
  startedBy: string | null;
  startedAt: number;
  /** The last HTML response's `<title>`; null until one passed through. */
  title: string | null;
  /** Whether the relay has seen the dev server serve a favicon. */
  favicon: boolean;
  lastRequestAt: number | null;
  /** Who opened it, most recent first (the view log, ADR 0008). */
  views: { name: string; lastSeenAt: number }[];
  /** `away`: its CLI dropped and has up to 60 s to come back. */
  state: "live" | "away";
  /** Where it came from (ADR 0012): repo, branch, commit, agent session, link and note. */
  source: PipeSource | null;
}

export type WallEvent =
  | { type: "snapshot"; shares: ShareCard[] }
  | { type: "share.started"; share: ShareCard }
  | { type: "share.updated"; share: ShareCard }
  | { type: "share.ended"; id: string };

export type Reservation =
  | { ok: true }
  | { ok: false; reason: "active_limit"; limit: number }
  | { ok: false; reason: "monthly_limit"; limit: number };

/** Calendar month in UTC: the window of the monthly byte limit. */
function month(at = Date.now()) {
  return new Date(at).toISOString().slice(0, 7);
}

/**
 * A stored card in the current shape. Cards written by an older Worker lack the fields added
 * since (`views`, ADR 0008; `source`, ADR 0012); they get those fields' empty values so walls can rely on the shape.
 */
function current(card: Partial<ShareCard> & Pick<ShareCard, "id">): ShareCard {
  return { views: [], source: null, ...card } as ShareCard;
}

export class Org extends DurableObject<Env> {
  #cards(): ShareCard[] {
    return [...this.ctx.storage.kv.list<ShareCard>({ prefix: "share:" })]
      .map(([, card]) => current(card))
      .toSorted((a, b) => b.startedAt - a.startedAt);
  }

  #broadcast(event: WallEvent) {
    const message = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
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
    const next = { ...current(card), ...patch };
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

  /** A wall's WebSocket: a snapshot now, then every change as it happens. */
  override async fetch(request: Request) {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "snapshot", shares: this.#cards() } satisfies WallEvent));
    return new Response(null, { status: 101, webSocket: client });
  }

  // Walls only listen; anything they send is ignored.
  override webSocketMessage() {}

  override webSocketClose(socket: WebSocket, code: number) {
    // 1005/1006 are reserved and cannot be sent back.
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch {
      // Already closed.
    }
  }
}
