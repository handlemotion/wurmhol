// The view log (ADR 0008): per viewer, first and last seen and a request count, never paths, IPs
// or user agents. Counts are kept in memory. They go to D1, the wall's card and storage when a
// viewer first opens the pipe, then at most every `VIEW_FLUSH_MS`, and once more at the pipe's
// end; the object keeps none of it after.
import { createDb, recordShareViews, type ShareView } from "@wurmhol/db";
import type { Meta, ShareState } from "./share-meta.ts";

/** A viewer's counts go to D1 and the wall when they first open the share, then at most this often. */
const VIEW_FLUSH_MS = 30_000;

/** One viewer's line in the view log, with their name for the wall once looked up. */
interface View extends ShareView {
  name: string | null;
  flushedAt: number;
}

export class ViewLog {
  #share: ShareState;
  /** By user id; loaded from storage on first use, which after hibernation is the last flush. */
  #loaded: Map<string, View> | null = null;
  /** The next flush, while counts wait for one; it also keeps the object from hibernating. */
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(share: ShareState) {
    this.#share = share;
  }

  #views() {
    this.#loaded ??= new Map(
      [...this.#share.ctx.storage.kv.list<View>({ prefix: "view:" })].map(([, view]) => [
        view.userId,
        view,
      ]),
    );
    return this.#loaded;
  }

  /** Counts one request for the view log. */
  note(meta: Meta, userId: string) {
    // A request still in flight when the share ended must not write the log back.
    if (!this.#share.meta()) return;
    const now = Date.now();
    const views = this.#views();
    const seen = views.get(userId);
    const view: View = seen
      ? { ...seen, lastSeenAt: now, requests: seen.requests + 1 }
      : { userId, name: null, firstSeenAt: now, lastSeenAt: now, requests: 1, flushedAt: 0 };
    views.set(userId, view);
    const wait = view.flushedAt + VIEW_FLUSH_MS - now;
    if (wait <= 0) {
      this.#share.ctx.waitUntil(this.flush(meta));
    } else {
      this.#timer ??= setTimeout(() => {
        this.#timer = null;
        const current = this.#share.meta();
        if (current) void this.flush(current);
      }, wait);
    }
  }

  /**
   * Writes the view log to D1 and the wall's card, naming viewers seen for the first time, and
   * stores it for after hibernation. `final` is the flush at the share's end, which stores
   * nothing: the tombstone stays all the object keeps.
   */
  async flush(meta: Meta, final = false) {
    const { ctx, env } = this.#share;
    const views = this.#views();
    try {
      const now = Date.now();
      for (const view of views.values()) view.flushedAt = now;
      const db = createDb(env.DB);
      const unnamed = [...views.values()].filter((v) => v.name === null).map((v) => v.userId);
      if (unnamed.length) {
        const users = await db.query.users.findMany({
          where: (u, { inArray }) => inArray(u.id, unnamed),
          columns: { id: true, name: true, email: true },
        });
        for (const user of users) {
          const view = views.get(user.id);
          if (view) view.name = user.name || user.email;
        }
      }
      if (!final && this.#share.meta()) {
        for (const view of views.values()) ctx.storage.kv.put(`view:${view.userId}`, view);
      }
      const all = [...views.values()];
      await recordShareViews(db, meta, all);
      await this.#share.org(meta.orgId).update(meta.id, {
        views: all
          .toSorted((a, b) => b.lastSeenAt - a.lastSeenAt)
          .map((view) => ({ name: view.name ?? "Someone", lastSeenAt: view.lastSeenAt })),
      });
    } catch (error) {
      this.#share.log.warn("share.views_failed", { shareId: meta.id, error });
    }
  }

  /** The pipe ended: the last counts go to D1, and the object keeps none of them. */
  async close(meta: Meta) {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.flush(meta, true);
    for (const [key] of this.#share.ctx.storage.kv.list({ prefix: "view:" })) {
      this.#share.ctx.storage.kv.delete(key);
    }
    this.#loaded = new Map();
  }
}
