import type { PipeSource } from "@wurmhol/protocol";
import { cn } from "cn";
import { Fragment, useEffect, useRef, useState } from "react";
import { IconArrowUpRight, IconExternalLink } from "@/components/icons/lucide";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import { Link } from "@/components/ui/link";
import { useMe, useNow, useTerminate } from "@/hooks/use-app";
import { useGithub } from "@/hooks/use-github";
import type { ShareCard } from "@wurmhol/protocol";
import { ago } from "@/lib/time";

/** The page's title, else the host; a pill falls back to just the pipe's own label. */
function name(share: ShareCard, short = false) {
  const host = new URL(share.url).host;

  return share.title ?? (short ? host.split(".")[0] : host);
}

/** The pipe's mark: its favicon, or a filled square; hollow while its CLI reconnects. */
function Mark({ share }: { share: ShareCard }) {
  // A favicon that won't load falls back to the square rather than a broken image.
  const [broken, setBroken] = useState(false);

  // One 16px slot for both, so every pill's label starts at the same place.
  return (
    <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
      {share.favicon && !broken ? (
        <img
          src={`/api/shares/${share.id}/favicon`}
          alt=""
          width={16}
          height={16}
          className="size-4"
          onError={() => setBroken(true)}
        />
      ) : (
        <span
          className={cn(
            "size-3 border border-muted-foreground",
            share.state === "live" && "bg-muted-foreground",
          )}
        />
      )}
    </span>
  );
}

/** `data-pipe` lets the network tell a press on a pill from one outside, and refocus it on close. */
export function PipePill({ share, onPress }: { share: ShareCard; onPress: () => void }) {
  return (
    <Button
      intent="outline"
      data-pipe={share.id}
      aria-expanded={false}
      onPress={onPress}
      className="max-w-64"
    >
      <Mark share={share} />
      <span className="truncate">{name(share, true)}</span>
      <span className="text-muted-foreground tabular-nums">:{share.port}</span>
    </Button>
  );
}

/** An external link in a card's row: the value's own colour, the arrow muted until hover. */
function RowLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group inline-flex items-center gap-0.5"
    >
      {children}
      <IconArrowUpRight className="size-3 text-muted-foreground group-hover:text-foreground" />
    </Link>
  );
}

/**
 * "Claude Code session ↗ · feat/checkout @ a1b2c3d": the agent (a link to its session when the
 * environment named one), then the branch and short commit, else the repo. Empty when the source
 * names none of them.
 */
function fromParts(source: PipeSource): React.ReactNode[] {
  const git = [source.branch, source.commit && `@ ${source.commit.slice(0, 7)}`]
    .filter(Boolean)
    .join(" ");

  const agent = source.agent ?? (source.agentUrl ? "Agent" : null);

  return [
    agent &&
      (source.agentUrl ? (
        <RowLink key="agent" href={source.agentUrl}>
          {agent} session
        </RowLink>
      ) : (
        <span key="agent">{agent}</span>
      )),
    git ? <span key="git">{git}</span> : source.repo && <span key="git">{source.repo}</span>,
  ].filter(Boolean);
}

/** The From row's parts: they wrap onto a second line rather than cut off the commit; each one truncates alone. */
function From({ parts }: { parts: React.ReactNode[] }) {
  return (
    <span className="flex flex-wrap gap-x-1">
      {parts.map((part, i) => (
        <span key={i} className="flex max-w-full min-w-0 gap-x-1">
          <span className="truncate">{part}</span>
          {i < parts.length - 1 && <span className="text-muted-foreground">·</span>}
        </span>
      ))}
    </span>
  );
}

/**
 * The pull request the pipe is posted to (ADR 0016). Before it is, an owner of an org with no
 * GitHub account linked for the pipe's repo gets the way to link one. Null: no row.
 */
function usePullRequest(share: ShareCard): React.ReactNode {
  const me = useMe();
  const onGithub = share.source?.repoHost === "github.com" && Boolean(share.source.repo);
  const github = useGithub(me.data?.role === "owner" && onGithub && !share.preview);

  if (share.preview) {
    return <RowLink href={share.preview.url}>#{share.preview.pullRequest}</RowLink>;
  }

  const account = share.source?.repo?.split("/")[0]?.toLowerCase();
  const linked = github.data?.installations.some((i) => i.account.toLowerCase() === account);

  if (!github.data?.available || linked) return null;

  return <RowLink href="/api/github/install">Connect GitHub</RowLink>;
}

/** A link's host and path, short enough for a row. */
function shortUrl(href: string) {
  const url = new URL(href);

  return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
}

/** One line of a card's details; `title` is its full text on hover. */
interface Row {
  term: string;
  value: React.ReactNode;
  title?: string;
}

/** Viewers named in a card; the rest are counted. */
const VIEWS_SHOWN = 3;

export function PipeCard({ share }: { share: ShareCard }) {
  // Focus moves to the card on opening, so Escape and Tab start from it.
  const card = useRef<HTMLElement>(null);
  useEffect(() => card.current?.focus({ preventScroll: true }), []);
  const now = useNow();
  const terminate = useTerminate();
  const shown = share.views.slice(0, VIEWS_SHOWN);

  const views = [
    ...shown.map((view) => `${view.name}, ${ago(view.lastSeenAt, now)}`),
    share.views.length > shown.length ? `+${share.views.length - shown.length}` : null,
  ].filter(Boolean);

  const { source } = share;
  const pullRequest = usePullRequest(share);
  const from = source ? fromParts(source) : [];

  const details: (Row | false | null)[] = [
    source &&
      from.length > 0 && {
        term: "From",
        value: <From parts={from} />,
        // The full repo, branch and commit on hover; the row shows them short.
        title: [source.repo, source.branch, source.commit].filter(Boolean).join(" · "),
      },
    source?.note ? { term: "Note", value: source.note, title: source.note } : null,
    source?.link
      ? {
          term: "Link",
          value: <RowLink href={source.link}>{shortUrl(source.link)}</RowLink>,
          title: source.link,
        }
      : null,
    pullRequest ? { term: "Pull request", value: pullRequest } : null,
    { term: "Port", value: String(share.port) },
    { term: "Status", value: share.state === "live" ? "Live" : "Reconnecting" },
    { term: "Started by", value: share.startedBy ?? "Unknown" },
    { term: "Started", value: ago(share.startedAt, now) ?? "" },
    { term: "Last request", value: ago(share.lastRequestAt, now) ?? "None yet" },
    { term: "Viewers", value: views.length > 0 ? views.join(" · ") : "None yet" },
  ];

  const rows = details.filter((row) => row !== false && row !== null);

  return (
    <section
      ref={card}
      tabIndex={-1}
      data-open
      aria-label={name(share)}
      className="flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-4 border border-primary bg-background p-4 outline-0"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-4 shrink-0 items-center">
          <Mark share={share} />
        </span>
        <span className="line-clamp-2 min-w-0 flex-1 text-sm text-foreground">{name(share)}</span>
      </div>
      <CopyField label="URL" value={share.url} />
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
        {rows.map(({ term, value, title }) => (
          <Fragment key={term}>
            <dt className="text-muted-foreground">{term}</dt>
            <dd title={title} className="min-w-0 truncate text-foreground tabular-nums">
              {value}
            </dd>
          </Fragment>
        ))}
      </dl>
      <div className="flex justify-between gap-2">
        <Button
          intent="outline"
          size="xs"
          onPress={() => window.open(share.url, "_blank", "noopener")}
        >
          <IconExternalLink />
          Open
        </Button>
        <Button
          intent="danger"
          size="xs"
          isPending={terminate.isPending}
          onPress={() => terminate.mutate(share.id)}
        >
          Terminate
        </Button>
      </div>
    </section>
  );
}
