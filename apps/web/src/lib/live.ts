// The Worker's live feeds. The wall's: the active org's open shares over `/api/live`. The Org
// Durable Object pushes a snapshot, then every start, change and end (spec section 3, no
// polling). And the person's own computers over `/api/machines/live`. Each reconnects with
// backoff if its socket drops. Its own small module, so the entry chunk can open the wall's
// socket (main.tsx) while the wall's code is still downloading.
import type { Machine, MachinesEvent, ShareCard, WallEvent } from "@wurmhol/protocol";

export interface LiveWall {
  /** The latest list, or undefined until the first snapshot. */
  readonly shares: ShareCard[] | undefined;
  /** The one listener, called with each new list. */
  listen(listener: (shares: ShareCard[]) => void): void;
  close(): void;
}

function apply(current: ShareCard[] | undefined, event: WallEvent): ShareCard[] {
  if (event.type === "snapshot") return event.shares;
  const list = current ?? [];
  if (event.type === "share.ended") return list.filter((s) => s.id !== event.id);
  const others = list.filter((s) => s.id !== event.share.id);
  return [event.share, ...others].toSorted((a, b) => b.startedAt - a.startedAt);
}

/**
 * A socket to one of the Worker's live feeds, reopened if it drops: after `retry.first` ms,
 * doubling up to `retry.max`, and back to the first wait once a message arrives. Returns its close.
 */
function live<T>(path: string, onEvent: (event: T) => void, retry: { first: number; max: number }) {
  let socket: WebSocket | null = null;
  let stopped = false;
  let delay = retry.first;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    const url = new URL(path, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(url);
    socket.onmessage = (message) => {
      delay = retry.first;
      onEvent(JSON.parse(String(message.data)) as T);
    };
    socket.onclose = () => {
      if (stopped) return;
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, retry.max);
    };
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    socket?.close();
  };
}

export function connectWall(): LiveWall {
  let shares: ShareCard[] | undefined;
  let listener: ((shares: ShareCard[]) => void) | null = null;
  const close = live<WallEvent>(
    "/api/live",
    (event) => {
      shares = apply(shares, event);
      listener?.(shares);
    },
    { first: 500, max: 10_000 },
  );
  return {
    get shares() {
      return shares;
    },
    listen(next) {
      listener = next;
    },
    close,
  };
}

/**
 * The signed-in person's computers running `wurmhol host` (ADR 0018), each time the Org object
 * pushes a change. Returns its close.
 */
export function connectMachines(listener: (machines: Machine[]) => void) {
  return live<MachinesEvent>(
    "/api/machines/live",
    (event) => {
      if (event.type === "machines") listener(event.machines);
    },
    { first: 2000, max: 2000 },
  );
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
