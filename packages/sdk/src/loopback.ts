// Where a dev server on this computer listens when its owner names no host. Most bind 127.0.0.1
// or every address, but Node 17+ resolves `localhost` to ::1 first, so Vite and others on their
// default host listen on ::1 alone (macOS especially). Every connection is given both loopback
// addresses and Node tries the next on refusal (`autoSelectFamily`), before any byte is sent, so
// a request body is never lost to the retry. The address that answered a port goes first next
// time; a later refusal there falls back to the other one again, since servers restart.
import type { LookupFunction, Socket } from "node:net";

const V4 = { address: "127.0.0.1", family: 4 };
const V6 = { address: "::1", family: 6 };

/** Connection options for `http.request`, `ws` and `net.connect`. */
export interface Target {
  host: string;
  lookup?: LookupFunction;
  autoSelectFamily?: boolean;
}

export class Loopback {
  /** Ports whose server last answered on ::1. */
  readonly #v6 = new Set<number>();

  /** How to reach `port`: the named host as is, or both loopback addresses. */
  target(port: number, host: string | undefined): Target {
    if (host) return { host };
    const order = this.#v6.has(port) ? [V6, V4] : [V4, V6];
    const lookup = ((_name, options, callback) => {
      if (options.all) (callback as (e: null, a: typeof order) => void)(null, order);
      else callback(null, order[0]!.address, order[0]!.family);
    }) as LookupFunction;
    // The name is never resolved: `lookup` answers for it.
    return { host: "localhost", lookup, autoSelectFamily: true };
  }

  /** Records which address answered, once `socket` has connected. */
  watch(port: number, socket: Socket) {
    const note = () => {
      if (socket.remoteAddress === V6.address) this.#v6.add(port);
      else if (socket.remoteAddress === V4.address) this.#v6.delete(port);
    };
    if (socket.remoteAddress) note();
    else socket.once("connect", note);
  }
}

/** Whether nothing listens: a refusal on some address tried, with every other one failing too. */
export function refused(error: NodeJS.ErrnoException & { errors?: NodeJS.ErrnoException[] }) {
  return error.code === "ECONNREFUSED" || Boolean(error.errors?.some(isRefusal));
}

function isRefusal(error: NodeJS.ErrnoException) {
  return error.code === "ECONNREFUSED";
}
