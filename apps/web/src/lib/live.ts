// The wall's live feed: the active org's open shares over `/api/live`. The Org Durable Object
// pushes a snapshot, then every start, change and end (spec section 3, no polling). Reconnects
// with backoff if the socket drops. Its own small module, so the entry chunk can open the socket
// (main.tsx) while the wall's code is still downloading.
import type { Share, WallEvent } from "./api";

export interface LiveWall {
  /** The latest list, or undefined until the first snapshot. */
  readonly shares: Share[] | undefined;
  /** The one listener, called with each new list. */
  listen(listener: (shares: Share[]) => void): void;
  close(): void;
}

function apply(current: Share[] | undefined, event: WallEvent): Share[] {
  if (event.type === "snapshot") return event.shares;
  const list = current ?? [];
  if (event.type === "share.ended") return list.filter((s) => s.id !== event.id);
  const others = list.filter((s) => s.id !== event.share.id);
  return [event.share, ...others].toSorted((a, b) => b.startedAt - a.startedAt);
}

export function connectWall(): LiveWall {
  let shares: Share[] | undefined;
  let listener: ((shares: Share[]) => void) | null = null;
  let socket: WebSocket | null = null;
  let stopped = false;
  let delay = 500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    const url = new URL("/api/live", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(url);
    socket.onmessage = (message) => {
      delay = 500;
      shares = apply(shares, JSON.parse(String(message.data)) as WallEvent);
      listener?.(shares);
    };
    socket.onclose = () => {
      if (stopped) return;
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 10_000);
    };
  };
  connect();
  return {
    get shares() {
      return shares;
    },
    listen(next) {
      listener = next;
    },
    close() {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    },
  };
}

let early: LiveWall | null = null;

/** Opens the wall's socket at startup, for the first `takeWall` to adopt. */
export function preconnectWall() {
  early ??= connectWall();
}

/** The socket opened at startup, if no one has taken it yet; else a new one. */
export function takeWall(): LiveWall {
  const wall = early ?? connectWall();
  early = null;
  return wall;
}

/** What the startup socket has received so far, for the wall's first render. */
export function earlyShares() {
  return early?.shares;
}
