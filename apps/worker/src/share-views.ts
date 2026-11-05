// The view log (ADR 0008): per viewer, first and last seen and a request count, never paths, IPs
// or user agents. It goes to D1 and the wall's card when a viewer first opens the pipe, then at
// most every `VIEW_FLUSH_MS`, and once more at the pipe's end; the object keeps none of it after.
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

  constructor(share: ShareState) {
    this.#share = share;
  }

  /** Counts one request for the view log. */
  note(meta: Meta, userId: string) {
    const { ctx } = this.#share;
    // A request still in flight when the share ended must not write the log back.
    if (!this.#share.meta()) return;
    const now = Date.now();
    const key = `view:${userId}`;
    const seen = ctx.storage.kv.get<View>(key);
    const view: View = seen
      ? { ...seen, lastSeenAt: now, requests: seen.requests + 1 }
      : { userId, name: null, firstSeenAt: now, lastSeenAt: now, requests: 1, flushedAt: 0 };
    ctx.storage.kv.put(key, view);
    if (now - view.flushedAt >= VIEW_FLUSH_MS) ctx.waitUntil(this.flush(meta));
  }

  #views() {
    return [...this.#share.ctx.storage.kv.list<View>({ prefix: "view:" })].map(([, view]) => view);
  }

  /**
   * Writes the view log to D1 and the wall's card, naming viewers seen for the first time.
   * `final` is the flush at the share's end; any other flush stops writing to storage once the
   * share has ended, so the tombstone stays all the object keeps.
   */
  async flush(meta: Meta, final = false) {
    const { ctx, env } = this.#share;
    const put = (view: View) => {
      if (final || this.#share.meta()) ctx.storage.kv.put(`view:${view.userId}`, view);
    };
    try {
      const now = Date.now();
      for (const view of this.#views()) put({ ...view, flushedAt: now });
      const db = createDb(env.DB);
      const unnamed = this.#views()
        .filter((view) => view.name === null)
        .map((view) => view.userId);
      if (unnamed.length) {
        const users = await db.query.users.findMany({
          where: (u, { inArray }) => inArray(u.id, unnamed),
          columns: { id: true, name: true, email: true },
        });
        for (const user of users) {
          const view = ctx.storage.kv.get<View>(`view:${user.id}`);
          if (view) put({ ...view, name: user.name || user.email });
        }
      }
      const views = this.#views();
      await recordShareViews(db, meta, views);
      await this.#share.org(meta.orgId).update(meta.id, {
        views: views
          .toSorted((a, b) => b.lastSeenAt - a.lastSeenAt)
          .map((view) => ({ name: view.name ?? "Someone", lastSeenAt: view.lastSeenAt })),
      });
    } catch (error) {
      this.#share.log.warn("share.views_failed", { shareId: meta.id, error });
    }
  }

  /** The pipe ended: the last counts go to D1, and the object keeps none of them. */
  async close(meta: Meta) {
    await this.flush(meta, true);
    for (const [key] of this.#share.ctx.storage.kv.list({ prefix: "view:" })) {
      this.#share.ctx.storage.kv.delete(key);
    }
  }
}
