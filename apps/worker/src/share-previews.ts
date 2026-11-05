// A pipe's deployment on the open pull request of its branch (ADR 0016): posted once, when the
// pipe starts or when GitHub says a pull request for its branch opened, and marked inactive at
// the pipe's end.
import { createDb } from "@wurmhol/db";
import { loadConfig } from "./env.ts";
import { postPreview, retirePreview } from "./github.ts";
import type { Meta, ShareState } from "./share-meta.ts";

export class SharePreviews {
  #share: ShareState;
  #posting: Promise<void> | null = null;

  constructor(share: ShareState) {
    this.#share = share;
  }

  /** Posts the pipe to its branch's open pull request, once. Calls at once share one attempt. */
  post() {
    this.#posting ??= this.#post().finally(() => (this.#posting = null));
    return this.#posting;
  }

  async #post() {
    const share = this.#share;
    const meta = share.meta();
    const config = loadConfig(share.env);
    if (!meta?.source || !config.github || meta.previews?.length) return;
    try {
      const preview = await postPreview(config.github, createDb(share.env.DB), meta);
      if (!preview) return;
      const current = share.meta();
      if (!current) {
        // The pipe ended while the deployment was being made: retire it now.
        await retirePreview(config.github, preview);
        return;
      }
      current.previews = [preview];
      share.save(current);
      await share.org(current.orgId).update(current.id, {
        preview: { pullRequest: preview.pullRequest, url: preview.pullRequestUrl },
      });
      share.log.info("share.preview_posted", { shareId: meta.id, orgId: meta.orgId });
    } catch (error) {
      share.log.warn("share.preview_failed", { shareId: meta.id, orgId: meta.orgId, error });
    }
  }

  /** Marks the pipe's deployments inactive; a failure is logged, never fatal to the end. */
  async retire(meta: Meta) {
    const github = loadConfig(this.#share.env).github;
    if (!github) return;
    for (const preview of meta.previews ?? []) {
      try {
        await retirePreview(github, preview);
      } catch (error) {
        this.#share.log.warn("share.preview_retire_failed", { shareId: meta.id, error });
      }
    }
  }
}
