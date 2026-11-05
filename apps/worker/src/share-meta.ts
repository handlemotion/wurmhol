// The Share object's stored state, and what its parts (`share-page.ts`, `share-views.ts`,
// `share-previews.ts`) need from the object that owns it.
import type { EndReason, PipeSource } from "@wurmhol/protocol";
import type { Preview } from "./github.ts";
import type { Logger } from "./log.ts";
import { orgStub } from "./org-do.ts";

/** What the Worker tells a new share's object when its CLI first connects. */
export interface ShareInit {
  id: string;
  orgId: string;
  tokenId: string;
  port: number;
  url: string;
  startedBy: string | null;
  startedAt: number;
  /** User ids that may open it (`--only`); null: every member of the org. */
  viewers: string[] | null;
  /** Where it came from (ADR 0015), as the CLI said; null when it said nothing. */
  source: PipeSource | null;
  limits: { seconds: number; monthlyBytes: number };
}

export interface Meta extends ShareInit {
  state: "live" | "away";
  awaySince: number | null;
  /** When the CLI's current socket connected; absent in pipes from before it. */
  liveSince?: number;
  title: string | null;
  faviconPath: string | null;
  favicon: boolean;
  lastRequestAt: number | null;
  bytes: number;
  /** When the start-of-pipe probe runs again, and which retry that is; null: done. */
  probe?: { at: number; attempt: number } | null;
  /** Deployments on the pipe's pull request (ADR 0016); absent in pipes from before it. */
  previews?: Preview[];
}

/** All an ended share keeps: enough to answer "ended", and why, to a viewer or its CLI. */
export interface Tombstone {
  state: "ended";
  endReason: EndReason;
}

/** What a part of the Share object reads and writes through the object. */
export interface ShareState {
  readonly ctx: DurableObjectState;
  readonly env: Env;
  readonly log: Logger;
  /** The open share's meta; undefined when it never started or has ended. */
  meta(): Meta | undefined;
  /** Writes an open share's meta; never over a tombstone. */
  save(meta: Meta): void;
  org(orgId: string): ReturnType<typeof orgStub>;
}
