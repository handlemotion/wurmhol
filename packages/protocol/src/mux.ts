// The stream multiplexer's pure parts: stream ids, per-stream flow control and the order rules a
// stream's frames must follow. Both ends drive these from their own I/O.
//
// Flow control (ADR 0002): a body sender may have at most `window` unacknowledged bytes in
// flight on a stream. The receiver grants more with `window` frames as it hands bytes on (to the
// viewer, or to the local server). Without it a fast local server and a slow phone would pile a
// whole download into the Durable Object's memory.
import { ProtocolError, type Frame } from "./frame.ts";

/** Bytes a sender may send on a new stream before its first `window` grant. */
export const INITIAL_WINDOW = 1024 * 1024;

/** Allocates stream ids for the side that opens streams (the relay). Never reuses one. */
export class StreamIds {
  #next = 1;
  next(): number {
    if (this.#next > 0xffff_ffff) throw new ProtocolError("stream ids exhausted");
    return this.#next++;
  }
}

/** The sender's side of one stream's window. */
export class SendWindow {
  #available: number;
  #waiters: (() => void)[] = [];

  constructor(initial = INITIAL_WINDOW) {
    this.#available = initial;
  }

  get available() {
    return this.#available;
  }

  /** Spends `bytes` of credit. Throws if the caller did not wait for enough. */
  take(bytes: number) {
    if (bytes > this.#available) throw new ProtocolError("sent past the flow-control window");
    this.#available -= bytes;
  }

  /** Adds credit from the peer's `window` frame and wakes waiting senders. */
  grant(bytes: number) {
    this.#available += bytes;
    for (const wake of this.#waiters.splice(0)) wake();
  }

  /** Resolves once at least `bytes` (capped at the initial window) can be sent. */
  async ready(bytes: number): Promise<void> {
    while (this.#available < bytes) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }

  /** Wakes every waiter, for a stream that is closing; they re-check and see their stream ended. */
  release() {
    this.#available = Number.POSITIVE_INFINITY;
    for (const wake of this.#waiters.splice(0)) wake();
  }
}

/**
 * The receiver's side of one stream's window. `received` checks the peer stays inside what it
 * was granted; `consumed` says when to grant more: once half the window has been handed on, all
 * of it is re-granted at once, so grants stay few.
 */
export class ReceiveWindow {
  #granted: number;
  #received = 0;
  #consumedSinceGrant = 0;
  readonly #size: number;

  constructor(size = INITIAL_WINDOW) {
    this.#size = size;
    this.#granted = size;
  }

  /** Records bytes that arrived. Throws ProtocolError if the peer sent past its window. */
  received(bytes: number) {
    this.#received += bytes;
    if (this.#received > this.#granted) {
      throw new ProtocolError("peer sent past its flow-control window");
    }
  }

  /** Records bytes handed on. Returns the bytes to grant now in a `window` frame, or 0. */
  consumed(bytes: number): number {
    this.#consumedSinceGrant += bytes;
    if (this.#consumedSinceGrant < this.#size / 2) return 0;
    const grant = this.#consumedSinceGrant;
    this.#consumedSinceGrant = 0;
    this.#granted += grant;
    return grant;
  }
}

type Phase = "head" | "body" | "done";

/**
 * Checks that one HTTP stream's frames arrive in order: a head (`request` or `response`), then
 * `data`, then one `end`. Each side tracks the frames it receives on each stream with one of
 * these, so a confused or hostile peer cannot, say, send a body before its status line.
 */
export class HttpStreamOrder {
  #phase: Phase = "head";
  readonly #head: "request" | "response";

  constructor(head: "request" | "response") {
    this.#head = head;
  }

  get done() {
    return this.#phase === "done";
  }

  accept(frame: Frame) {
    switch (frame.type) {
      case this.#head:
        if (this.#phase !== "head") throw new ProtocolError(`second ${this.#head} on a stream`);
        this.#phase = "body";
        return;
      case "data":
        if (this.#phase !== "body") throw new ProtocolError(`data outside a body`);
        return;
      case "window":
        // Credit for the body flowing the other way: valid whenever that body is still open,
        // which this half of the stream cannot see.
        return;
      case "end":
        // An `end` before the head is an error report (the request never reached the server).
        if (this.#phase === "done") throw new ProtocolError("second end on a stream");
        this.#phase = "done";
        return;
      default:
        throw new ProtocolError(`${frame.type} on an HTTP stream`);
    }
  }
}
