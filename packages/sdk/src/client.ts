// `Wurmhol`: one object for an app that embeds the SDK. It remembers the server, the token (or a
// store that holds it) and how the app names itself, and offers what an app does: sign a person in
// (`auth`), open pipes (`pipes.open`, `pipes.keepOpen`), see or end the org's pipes (`pipes.list`,
// `pipes.end`), and give a pipe name its own hostname (`domains`). Everything it does is also
// available as a plain function.
import {
  type DeviceCode,
  type Granted,
  awaitLogin as awaitDeviceLogin,
  redeem as redeemCode,
  startLogin as startDeviceLogin,
} from "./auth.ts";
import { domains, type DomainsClient } from "./domains.ts";
import { explainRefusal, FixError } from "./errors.ts";
import { send } from "./http.ts";
import { keepOpen, type ManagedPipe, type ManagedPipeOptions } from "./managed.ts";
import {
  DEFAULT_SERVER,
  originOf,
  type OpenPipeOptions,
  openPipe,
  type Pipe,
  type PipeSource,
} from "./pipe.ts";
import { memoryTokenStore, type StoredToken, type TokenStore } from "./store.ts";
import type { TransportChoice } from "./transport/index.ts";
import pkg from "../package.json" with { type: "json" };

export interface WurmholOptions {
  /** A self-hosted install's origin. Default `https://api.wurmhol.com`. */
  server?: string;
  /** A token (`wh_…`) to use as is. Wins over `tokenStore`. */
  token?: string;
  /** Where the token a device login grants is kept, and read from. Default: in memory. */
  tokenStore?: TokenStore;
  /** Names the app in the `User-Agent`: `{ name: "dorks", version: "1.2.0" }`. */
  client?: { name: string; version: string };
  /** See `OpenPipeOptions.transport`. */
  transport?: TransportChoice;
  /** Diagnostic events, never request contents or secrets. A throw here is ignored. */
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** What the relay says about one open pipe: the card the wall shows. */
export interface PipeInfo {
  id: string;
  url: string;
  port: number;
  /** The person whose token opened it. */
  startedBy: string | null;
  /** Milliseconds since the epoch. */
  startedAt: number;
  /** The last HTML response's `<title>`. */
  title: string | null;
  favicon: boolean;
  lastRequestAt: number | null;
  /** Who opened it, most recent first. */
  views: { name: string; lastSeenAt: number }[];
  /** `away`: its client dropped and has up to a minute to come back. */
  state: "live" | "away";
  source: PipeSource | null;
  preview: { pullRequest: number; url: string } | null;
}

export type PipeOptions = Omit<OpenPipeOptions, "token" | "server" | "transport" | "client">;
export type KeepOpenOptions = Omit<ManagedPipeOptions, "token" | "server" | "transport" | "client">;

export class Wurmhol {
  readonly server: string;
  readonly #token: string | undefined;
  readonly #store: TokenStore;
  readonly #options: WurmholOptions;
  readonly #client: { name: string; version: string };
  /**
   * The org's custom domains (ADR 0033): attach a hostname to a pipe name, check it, remove it.
   * Needs a token that can list and end every pipe.
   */
  readonly domains: DomainsClient;

  constructor(options: WurmholOptions = {}) {
    this.#options = options;
    this.server = originOf(options.server ?? DEFAULT_SERVER);
    this.#token = options.token?.trim() || undefined;
    this.#store = options.tokenStore ?? memoryTokenStore();
    this.#client = options.client ?? { name: "wurmhol-sdk", version: pkg.version };
    this.domains = domains({
      server: this.server,
      client: this.#client,
      token: () => this.#needToken(),
    });
  }

  /** The token in use: the one given, or the stored one for this server; null when signed out. */
  async token(): Promise<string | null> {
    if (this.#token) return this.#token;
    return (await this.#store.load(this.server))?.token ?? null;
  }

  async #needToken(): Promise<string> {
    const token = await this.token();
    if (!token) {
      throw new FixError(
        `Sign in first: call auth.login(), or pass a token made at ${this.server} (menu → Tokens).`,
        { code: "no_token" },
      );
    }
    return token;
  }

  /** Signing in: the device flow (RFC 8628), a setup code, and what is stored. */
  readonly auth = {
    /**
     * Asks the relay for a code. Show `verification_uri_complete` to the person (open it in a
     * browser) and call `wait` with the result.
     */
    start: (options: { name: string; port?: number }): Promise<DeviceCode> =>
      startDeviceLogin({
        server: this.server,
        name: options.name,
        port: options.port,
        version: this.#client.version,
        product: this.#client.name,
      }),
    /**
     * Polls until the person approves `code`, then stores the token. Rejects with the FixError that
     * says what to do (the code expired, it was denied). `signal` ends the wait.
     */
    wait: async (
      code: DeviceCode,
      options: { signal?: AbortSignal } = {},
    ): Promise<StoredToken> => {
      const granted = await awaitDeviceLogin({
        server: this.server,
        version: this.#client.version,
        code,
        product: this.#client.name,
        signal: options.signal,
      });
      return this.#save(granted);
    },
    /** `start`, `prompt`, `wait` in one call. */
    login: async (options: {
      name: string;
      port?: number;
      /** Tell the person where to go: the code's `verification_uri_complete` and `user_code`. */
      prompt: (code: DeviceCode) => void;
      signal?: AbortSignal;
    }): Promise<StoredToken> => {
      const code = await this.auth.start(options);
      options.prompt(code);
      return this.auth.wait(code, { signal: options.signal });
    },
    /** Redeems a setup code the console made for a signed-in member (a one-time code). */
    redeem: async (options: { code: string; name: string }): Promise<StoredToken> =>
      this.#save(
        await redeemCode({
          server: this.server,
          code: options.code,
          name: options.name,
          version: this.#client.version,
          product: this.#client.name,
        }),
      ),
    /** Forgets the stored token on this computer. The token itself stays valid until revoked. */
    signOut: async (): Promise<void> => {
      await this.#store.clear();
    },
    /** The stored token's org and computer name, or null. Never the token itself. */
    status: async (): Promise<{ server: string; org: string | null; name: string } | null> => {
      const stored = await this.#store.load(this.server);
      return stored ? { server: stored.server, org: stored.org, name: stored.name } : null;
    },
  };

  async #save(granted: Granted): Promise<StoredToken> {
    const stored: StoredToken = {
      server: this.server,
      token: granted.token,
      org: granted.org.name ?? granted.org.id,
      name: granted.name,
    };
    await this.#store.save(stored);
    return stored;
  }

  readonly pipes = {
    /** Opens a pipe to a local port, like `openPipe` with this client's server and token. */
    open: async (options: PipeOptions): Promise<Pipe> =>
      openPipe({ ...options, ...this.#shared(), token: await this.#needToken() }),
    /** Opens a pipe and keeps it open: reopens on expiry, backs off on failure. */
    keepOpen: (options: KeepOpenOptions): ManagedPipe =>
      // The token is read before each attempt, so signing in after this call is fine.
      keepOpen({ ...options, ...this.#shared(), token: () => this.#needToken() }),
    /** The org's open pipes (the wall's cards). Needs a token that can list and end every pipe. */
    list: async (options: { signal?: AbortSignal } = {}): Promise<PipeInfo[]> => {
      const body = await this.#call("GET", "/v1/pipes", options.signal);
      return (body as { pipes: PipeInfo[] }).pipes;
    },
    /** Ends one of the org's pipes, as Terminate does on the wall. */
    end: async (id: string, options: { signal?: AbortSignal } = {}): Promise<void> => {
      await this.#call("DELETE", `/v1/pipes/${encodeURIComponent(id)}`, options.signal);
    },
  };

  #shared() {
    return {
      server: this.server,
      transport: this.#options.transport,
      client: this.#client,
      log: this.#options.log,
    };
  }

  async #call(method: string, path: string, signal?: AbortSignal): Promise<unknown> {
    const token = await this.#needToken();
    const answer = await send(new URL(path, this.server), {
      server: this.server,
      version: this.#client.version,
      product: this.#client.name,
      method,
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    if (answer.status >= 200 && answer.status < 300) {
      try {
        return JSON.parse(answer.body);
      } catch {
        return {};
      }
    }
    throw explainRefusal(answer.status, answer.body, {
      server: this.server,
      viaProxy: answer.viaProxy,
    });
  }
}
