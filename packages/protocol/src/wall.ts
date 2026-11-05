// The wall's live feed (spec section 5): the Org Durable Object keeps one card per open pipe and
// sends every change to the open walls. The Worker writes these shapes and the web app reads them.
import type { PipeSource } from "./source.ts";

/** One card on the wall. */
export interface ShareCard {
  id: string;
  url: string;
  port: number;
  /** Name of the person whose token started it. */
  startedBy: string | null;
  startedAt: number;
  /** The last HTML response's `<title>`; null until one passed through. */
  title: string | null;
  /** Whether the relay has seen the dev server serve a favicon. */
  favicon: boolean;
  lastRequestAt: number | null;
  /** Who opened it, most recent first (the view log, ADR 0008). */
  views: { name: string; lastSeenAt: number }[];
  /** `away`: its CLI dropped (or went silent) and has `AWAY_GRACE_MS` to come back. */
  state: "live" | "away";
  /** Where it came from (ADR 0015): repo, branch, commit, agent session, link and note. */
  source: PipeSource | null;
  /** The pull request it is posted to as a deployment (ADR 0016), once it is. */
  preview: { pullRequest: number; url: string } | null;
}

export type ShareCardInit = Pick<ShareCard, "id" | "url" | "port" | "startedBy" | "startedAt"> &
  Partial<ShareCard>;

/**
 * A card with every field `init` leaves out set to a new pipe's value. Cards stored by an older
 * Worker lack the fields added since (`views`, `source`, `preview`); this fills those in too.
 */
export function newShareCard(init: ShareCardInit): ShareCard {
  return {
    title: null,
    favicon: false,
    lastRequestAt: null,
    views: [],
    state: "live",
    source: null,
    preview: null,
    ...init,
  };
}

export type WallEvent =
  | { type: "snapshot"; shares: ShareCard[] }
  | { type: "share.started"; share: ShareCard }
  | { type: "share.updated"; share: ShareCard }
  | { type: "share.ended"; id: string };
