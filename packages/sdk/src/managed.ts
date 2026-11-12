// A pipe that stays open: `keepOpen` opens one, and when the relay ends it for a reason that does
// not mean "stop" (its lifetime ran out, the connection was lost for good), opens another with the
// same options, with backoff between failed attempts. A named pipe comes back at the same URL; an
// unnamed one gets a new one, announced by `open`. This is the policy an embedding app would
// otherwise write itself (ADR 0030).
import { EventEmitter } from "node:events";
import { isString } from "@wurmhol/protocol";
import { FixError } from "./errors.ts";
import {
  type CloseReason,
  type OpenPipeOptions,
  openPipe,
  type Pipe,
  type PipeEvents,
  type RequestEvent,
} from "./pipe.ts";

export interface ReopenPolicy {
  /**
   * Close reasons that end the managed pipe instead of reopening it. Default: every one except
   * `expired` and `disconnected`: a stop, a takedown, a revoked token, a plan limit.
   */
  giveUpOn?: CloseReason[];
  /** The first delay after a failure, in ms. Default 1000. */
  initialDelayMs?: number;
  /** The longest delay, in ms. Default 30000. */
  maxDelayMs?: number;
  /** Each delay is this many times the last. Default 2. */
  factor?: number;
  /** Random spread, 0 to 1: a delay varies by up to this fraction either way. Default 0.2. */
  jitter?: number;
  /** Stop after this many failed attempts in a row. Default: never. */
  maxAttempts?: number;
}

export interface ManagedPipeOptions extends Omit<OpenPipeOptions, "token"> {
  /**
   * The token, or a function that returns it, called before every attempt: a token made or
   * replaced while the pipe is down is picked up by the next one.
   */
  token: string | (() => string | Promise<string>);
  /** `false` opens once and ends with the pipe, like `openPipe`. */
  reopen?: ReopenPolicy | false;
}

/** `opening`: no pipe yet. `open`: serving. `reconnecting`: redialing or reopening. */
export type ManagedState = "opening" | "open" | "reconnecting" | "closed";

export type ManagedCloseReason = CloseReason | "gave_up";

export interface ManagedPipeEvents {
  /** A pipe is serving: the first one, or a reopened one. */
  open: (info: { id: string; url: string; endsAt: Date; reopened: boolean }) => void;
  /** A pipe ended or could not open, and another attempt follows after `delayMs`. */
  reopening: (info: {
    attempt: number;
    delayMs: number;
    reason: CloseReason | "error";
    error?: FixError;
  }) => void;
  request: (event: RequestEvent) => void;
  disconnected: PipeEvents["disconnected"];
  reconnected: PipeEvents["reconnected"];
  /** The managed pipe ended for good. Emitted once. `error` is set when it gave up. */
  closed: (info: { reason: ManagedCloseReason; error?: FixError }) => void;
}

export interface ManagedPipe {
  readonly state: ManagedState;
  /** The current pipe's URL, or null while there is none. */
  readonly url: string | null;
  readonly id: string | null;
  readonly endsAt: Date | null;
  /** Resolves when the first pipe is serving; rejects with the FixError if it can never open. */
  ready(): Promise<void>;
  on<E extends keyof ManagedPipeEvents>(event: E, listener: ManagedPipeEvents[E]): this;
  once<E extends keyof ManagedPipeEvents>(event: E, listener: ManagedPipeEvents[E]): this;
  off<E extends keyof ManagedPipeEvents>(event: E, listener: ManagedPipeEvents[E]): this;
  /** Ends the pipe and stops reopening; resolves once it has ended. */
  close(): Promise<void>;
}

const WITHOUT_REOPEN: CloseReason[] = [
  "stopped",
  "terminated",
  "revoked",
  "limit",
  "no_subscription",
];

/**
 * Failures a retry cannot fix: the caller's options, a missing token, a refusal that ends pipes,
 * and a client error from the relay (a revoked or unknown token, a plan that does not allow it).
 * A rate limit (429), a timeout (408) and the relay's own errors (5xx) are worth another try.
 */
function hopeless(error: unknown): error is FixError {
  if (!(error instanceof FixError)) return false;

  if (error.final || ["invalid_option", "no_token", "unsupported"].includes(error.code))
    return true;
  const status = error.status;

  return (
    error.code === "refused" &&
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

class Managed implements ManagedPipe {
  state: ManagedState = "opening";
  url: string | null = null;
  id: string | null = null;
  endsAt: Date | null = null;
  readonly #events = new EventEmitter();
  readonly #options: ManagedPipeOptions;
  readonly #stop = new AbortController();
  readonly #ready: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (error: FixError) => void;
  #current: Pipe | null = null;
  #loop: Promise<void>;

  constructor(options: ManagedPipeOptions) {
    this.#options = options;
    this.#ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    // A caller that never awaits `ready()` must not crash on its rejection.
    this.#ready.catch(() => {});
    options.signal?.addEventListener("abort", () => void this.close(), { once: true });
    this.#loop = this.#run();
  }

  ready() {
    return this.#ready;
  }

  on<E extends keyof ManagedPipeEvents>(event: E, listener: ManagedPipeEvents[E]) {
    this.#events.on(event, listener);

    return this;
  }
  once<E extends keyof ManagedPipeEvents>(event: E, listener: ManagedPipeEvents[E]) {
    this.#events.once(event, listener);

    return this;
  }
  off<E extends keyof ManagedPipeEvents>(event: E, listener: ManagedPipeEvents[E]) {
    this.#events.off(event, listener);

    return this;
  }
  #emit<E extends keyof ManagedPipeEvents>(event: E, ...args: Parameters<ManagedPipeEvents[E]>) {
    this.#events.emit(event, ...args);
  }

  async close() {
    this.#stop.abort();
    await this.#current?.close();
    await this.#loop;
  }

  #delay(attempt: number) {
    const policy = this.#policy();

    const base = Math.min(
      policy.maxDelayMs,
      policy.initialDelayMs * policy.factor ** Math.max(attempt - 1, 0),
    );

    const spread = base * policy.jitter;

    return Math.max(0, Math.round(base + (Math.random() * 2 - 1) * spread));
  }

  #policy() {
    const given = this.#options.reopen || {};

    return {
      giveUpOn: given.giveUpOn ?? WITHOUT_REOPEN,
      initialDelayMs: given.initialDelayMs ?? 1000,
      maxDelayMs: given.maxDelayMs ?? 30_000,
      factor: given.factor ?? 2,
      jitter: given.jitter ?? 0.2,
      maxAttempts: given.maxAttempts ?? Infinity,
    };
  }

  async #sleep(ms: number) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.#stop.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  #finish(reason: ManagedCloseReason, error?: FixError) {
    if (this.state === "closed") return;
    this.state = "closed";
    this.url = null;
    this.#emit("closed", { reason, error });
  }

  async #run() {
    const policy = this.#policy();
    const once = this.#options.reopen === false;
    let failures = 0;
    let opened = false;

    while (!this.#stop.signal.aborted) {
      let pipe: Pipe;

      try {
        const { token, reopen: _reopen, ...rest } = this.#options;
        pipe = await openPipe({
          ...rest,
          token: isString(token) ? token : await token(),
          signal: this.#stop.signal,
        });
      } catch (error) {
        if (this.#stop.signal.aborted) break;

        const fix =
          error instanceof FixError
            ? error
            : new FixError(error instanceof Error ? error.message : String(error));

        if (hopeless(fix) || once || ++failures > policy.maxAttempts) {
          if (!opened) this.#rejectReady(fix);

          return this.#finish("gave_up", fix);
        }

        const delayMs = this.#delay(failures);
        this.state = opened ? "reconnecting" : "opening";
        this.#emit("reopening", { attempt: failures, delayMs, reason: "error", error: fix });
        await this.#sleep(delayMs);
        continue;
      }

      failures = 0;
      this.#current = pipe;
      this.state = "open";
      this.url = pipe.url;
      this.id = pipe.id;
      this.endsAt = pipe.endsAt;
      pipe.on("request", (event) => this.#emit("request", event));
      pipe.on("disconnected", (info) => {
        this.state = "reconnecting";
        this.#emit("disconnected", info);
      });
      pipe.on("reconnected", () => {
        this.state = "open";
        this.#emit("reconnected");
      });
      this.#emit("open", { id: pipe.id, url: pipe.url, endsAt: pipe.endsAt, reopened: opened });

      if (!opened) this.#resolveReady();
      opened = true;
      const reason = await new Promise<CloseReason>((resolve) => pipe.once("close", resolve));
      this.#current = null;

      if (this.#stop.signal.aborted) return this.#finish("stopped");

      if (once || policy.giveUpOn.includes(reason)) return this.#finish(reason);
      this.state = "reconnecting";
      const delayMs = this.#delay(1);
      this.#emit("reopening", { attempt: 1, delayMs, reason });
      await this.#sleep(delayMs);
    }

    if (!opened)
      this.#rejectReady(new FixError("Closed before the pipe opened.", { code: "error" }));
    this.#finish("stopped");
  }
}

/**
 * Opens a pipe and keeps it open: see `ManagedPipeOptions.reopen`. Returns at once; `ready()`
 * resolves when the first pipe is serving.
 */
export function keepOpen(options: ManagedPipeOptions): ManagedPipe {
  return new Managed(options);
}
