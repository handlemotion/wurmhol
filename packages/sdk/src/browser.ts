// `@wurmhol/sdk/browser`: a page's side of an embedded tunnel (ADR 0032). No dependencies and no
// Node APIs, so a web bundler takes it as is. A page cannot set headers on a WebSocket, so a
// client grant travels as a subprotocol; the relay accepts it only from the application's allowed
// origins and never passes it to the dev server. Your backend issues the grant (WurmholEmbed,
// `kind: "client"`) and hands its token to the page; the page never sees the integration key.
//
//   const socket = tunnelSocket(`${tunnelUrl.replace("http", "ws")}/ws`, {
//     grant: () => fetch("/api/tunnel-grant").then((r) => r.text()),
//     protocols: ["graphql-ws"],
//   });
//   socket.addEventListener("message", (event) => …);
import * as protocol from "@wurmhol/protocol";

// Typed here, not re-exported, so the public `.d.ts` stands alone (tsdown cannot emit protocol's
// types); the values and the logic are protocol's.
/** The subprotocol that marks a grant, and that the relay answers when the app picks none. */
export const GRANT_PROTOCOL: string = protocol.GRANT_PROTOCOL;

/** The subprotocol list that carries a client grant, then the app's own protocols. */
export function grantProtocols(token: string, own: readonly string[] = []): string[] {
  return protocol.grantProtocols(token, own);
}

export interface GrantCloseCodes {
  /** The grant expired: issue a new one and reconnect. */
  expired: number;
  /** The grant was revoked: final. */
  revoked: number;
}

/** The close codes the relay ends a grant's WebSocket with. */
export const GRANT_CLOSE_CODES: GrantCloseCodes = {
  expired: protocol.GRANT_CLOSE.expired.code,
  revoked: protocol.GRANT_CLOSE.revoked.code,
};

/** The part of a WebSocket the helper uses: the browser's, or any with the same shape. */
export interface SocketLike {
  readonly protocol: string;
  readonly readyState: number;
  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: never) => void): void;
}

/** A tunnel's WebSocket that renews its grant. A `close` event carries `code` and `reason`. */
export interface TunnelSocket {
  addEventListener(
    type: "open" | "renewed" | "message" | "close",
    listener: (event: Event & { data?: unknown; code?: number; reason?: string }) => void,
  ): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  /** The subprotocol the app's server chose, or `wurmhol.grant` when it chose none. */
  readonly protocol: string;
  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void;
  close(code?: number, reason?: string): void;
}

export interface TunnelSocketOptions {
  /** A fresh client grant's token, from your backend. Called for each connection. */
  grant: () => Promise<string> | string;
  /** Your app's own subprotocols, offered after the grant's. */
  protocols?: string[];
  /** How many times in a row to reconnect after an expired grant. Default 5. */
  reconnects?: number;
  /** Opens the socket. Default: the page's `WebSocket`. */
  connect?: (url: string, protocols: string[]) => SocketLike;
}

/**
 * A WebSocket to an embedded tunnel that carries a grant and renews it: when the relay closes
 * the socket because its grant expired (4401), it asks `grant` for a new one and reconnects.
 * A revoked grant (4403) and any other close are final. Events: `open`, `message`, `close`
 * (with the last close's code and reason), and `renewed` after a reconnect.
 */
export function tunnelSocket(url: string, options: TunnelSocketOptions): TunnelSocket {
  const events = new EventTarget();

  const connect =
    options.connect ??
    ((target: string, protocols: string[]) =>
      // SAFETY: a WebSocket has every member SocketLike names. SocketLike types a listener's event
      // as `never` so any listener fits; the socket calls each with its event type's own event.
      new WebSocket(target, protocols) as SocketLike);

  const limit = options.reconnects ?? 5;
  let socket: SocketLike | null = null;
  let renewals = 0;
  let closedByUs = false;

  const open = async (renewed: boolean) => {
    const token = await options.grant();
    const current = connect(url, grantProtocols(token, options.protocols ?? []));
    socket = current;
    current.addEventListener("open", () => {
      renewals = 0;
      events.dispatchEvent(new Event(renewed ? "renewed" : "open"));
    });
    current.addEventListener("message", (event: MessageEvent) =>
      events.dispatchEvent(new MessageEvent("message", { data: event.data })),
    );
    current.addEventListener("close", (event: CloseEvent) => {
      if (socket !== current) return;

      if (!closedByUs && event.code === GRANT_CLOSE_CODES.expired && renewals < limit) {
        renewals += 1;
        void open(true).catch((cause: unknown) => finish(1006, String(cause)));

        return;
      }

      finish(event.code, event.reason);
    });
  };

  const finish = (code: number, reason: string) => {
    socket = null;
    events.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
  };

  void open(false).catch((cause: unknown) => finish(1006, String(cause)));

  return {
    addEventListener: (type, listener) =>
      // SAFETY: `events` dispatches only plain Events, MessageEvents (with `data`) and close Events
      // given `code` and `reason`, so every event the listener gets has the shape it is typed for.
      events.addEventListener(type, listener as (e: Event) => void),
    removeEventListener: (type, listener) => events.removeEventListener(type, listener),
    get protocol() {
      return socket?.protocol ?? "";
    },
    send(data: string | ArrayBufferLike | ArrayBufferView | Blob) {
      if (!socket) throw new Error("the tunnel's socket is not open");
      socket.send(data);
    },
    close(code = 1000, reason = "") {
      closedByUs = true;
      socket?.close(code, reason);
    },
  };
}
