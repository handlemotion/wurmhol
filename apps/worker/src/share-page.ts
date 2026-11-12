// A pipe's title and favicon for the wall. A new pipe's are there before anyone opens it: the
// Share object asks the dev server for `/` itself (`probe`) and reads the page's start, the same
// as a viewer's first page. Nothing else of any response is kept, and nothing at all once the
// pipe ends.
import { forwardedHeaders, type RequestHead, WAITING_HEADER } from "@wurmhol/protocol";
import { extractFaviconPath, extractTitle, readStart } from "./html-head.ts";
import { loggedError } from "./log.ts";
import type { Meta, ShareState } from "./share-meta.ts";

/** Bytes of an HTML response read for its `<title>`. */
export const TITLE_SCAN_BYTES = 64 * 1024;
const FAVICON_MAX_BYTES = 100 * 1024;

/**
 * When a new pipe connects, the relay asks the dev server for `/` itself, so the wall has the
 * favicon (and title) before anyone opens it. A server not listening yet answers with the CLI's
 * waiting page (`WAITING_HEADER`); the probe tries again after each of these delays.
 */
const PROBE_RETRY_MS = [2_000, 5_000, 10_000, 20_000];
export const PROBE_FIRST_MS = 1_000;

/** One request through the CLI, as the Share object relays a viewer's, without a title scan. */
export type RelayOwn = (head: RequestHead, meta: Meta) => Promise<Response>;

export interface StoredFavicon {
  type: string;
  body: ArrayBuffer;
}

export class SharePage {
  #share: ShareState;
  #relay: RelayOwn;
  #connected: () => boolean;
  #armAlarm: (meta: Meta) => void;

  constructor(
    share: ShareState,
    io: { relay: RelayOwn; connected: () => boolean; armAlarm: (meta: Meta) => void },
  ) {
    this.#share = share;
    this.#relay = io.relay;
    this.#connected = io.connected;
    this.#armAlarm = io.armAlarm;
  }

  /** The dev server's favicon, as last fetched through the CLI, or null. */
  favicon(): StoredFavicon | null {
    return this.#share.ctx.storage.kv.get<StoredFavicon>("favicon") ?? null;
  }

  /** Forgets the favicon: the pipe ended. */
  clear() {
    this.#share.ctx.storage.kv.delete("favicon");
  }

  /**
   * Reads the start of an HTML page for its title and favicon link. `final`: no more of the page
   * comes, so a page without a `<title>` still gets its favicon looked up.
   */
  note(html: string, final: boolean) {
    const title = extractTitle(html);

    if (!title && !final) return;
    const meta = this.#share.meta();

    if (!meta) return;
    const faviconPath = extractFaviconPath(html) ?? "/favicon.ico";
    const changed = title !== null && title !== meta.title;

    if (title) meta.title = title;
    const fetchFavicon = !meta.favicon || meta.faviconPath !== faviconPath;
    meta.faviconPath = faviconPath;
    this.#share.save(meta);
    const { ctx } = this.#share;

    if (changed) ctx.waitUntil(this.#share.org(meta.orgId).update(meta.id, { title }));

    if (fetchFavicon) ctx.waitUntil(this.fetchFavicon(meta));
  }

  /**
   * Requests `/` through the CLI as soon as the pipe starts and reads the start of the page for
   * its title and favicon, as from a viewer's first page. Nothing else of the response is kept.
   */
  async probe(attempt = 0) {
    const meta = this.#share.meta();

    // Ended, or a viewer's page got there first.
    if (!meta || meta.favicon) return;

    try {
      if (!this.#connected()) throw new Error("the CLI is reconnecting");

      const response = await this.#relay(
        {
          method: "GET",
          path: "/",
          // As on a viewer's request, for apps that build absolute URLs.
          headers: [["accept", "text/html"], ...forwardedHeaders(meta.url)],
        },
        meta,
      );

      if (response.headers.has(WAITING_HEADER)) {
        await response.body?.cancel();
        throw new Error("the dev server is not listening yet");
      }

      const isHtml = /^text\/html\b/i.test(response.headers.get("content-type") ?? "");

      if (response.ok && isHtml && response.body) {
        this.note(await readStart(response.body, TITLE_SCAN_BYTES), true);
      } else {
        await response.body?.cancel();
        // No page to read (a redirect to sign in, JSON): the default favicon may still be there.
        await this.fetchFavicon(meta);
      }
    } catch (error) {
      const delay = PROBE_RETRY_MS[attempt];
      const current = this.#share.meta();

      if (delay === undefined || !current) {
        this.#share.log.info("share.probe_gave_up", {
          shareId: meta.id,
          error: loggedError(error),
        });

        return;
      }

      current.probe = { at: Date.now() + delay, attempt: attempt + 1 };
      this.#share.save(current);
      this.#armAlarm(current);
    }
  }

  /** Fetches the dev server's favicon through the CLI once, for the wall. */
  async fetchFavicon(meta: Meta) {
    try {
      const response = await this.#relay(
        {
          method: "GET",
          path: meta.faviconPath ?? "/favicon.ico",
          headers: [["accept", "image/*"]],
        },
        meta,
      );

      const type = response.headers.get("content-type") ?? "";

      if (!response.ok || !/^image\//i.test(type)) {
        await response.body?.cancel();

        return;
      }

      const body = await response.arrayBuffer();

      if (body.byteLength === 0 || body.byteLength > FAVICON_MAX_BYTES) return;
      // The pipe may have ended while the icon came: never stored next to the tombstone.
      const current = this.#share.meta();

      if (!current) return;
      this.#share.ctx.storage.kv.put("favicon", { type, body } satisfies StoredFavicon);
      current.favicon = true;
      this.#share.save(current);
      await this.#share.org(current.orgId).update(current.id, { favicon: true });
    } catch (error) {
      this.#share.log.warn("share.favicon_failed", { shareId: meta.id, error: loggedError(error) });
    }
  }
}
