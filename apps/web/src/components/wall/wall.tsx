import { LazyMotion } from "motion/react";
import { cn } from "cn";
import { Fragment, useEffect, useRef, useState } from "react";
import { Skeleton } from "skullet/react";
import {
  IconChevronsUpDown,
  IconCreditCard,
  IconEllipsis,
  IconExternalLink,
  IconKey,
  IconLogOut,
  IconUsers,
} from "@/components/icons/lucide";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import { SkeletonProvider } from "@/components/ui/skeleton-provider";
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Text } from "@/components/ui/text";
import {
  useMe,
  useNow,
  useOpenBilling,
  usePrefetchDialogs,
  useSignOut,
  useSwitchOrg,
  useTerminate,
  useWall,
} from "@/hooks/use-app";
import type { Me, Share } from "@/lib/api";
import { ago } from "@/lib/time";
import { MembersDialog } from "./members-dialog";
import { Constellation } from "./constellation";
import { TokensDialog } from "./tokens-dialog";

const SAMPLE: Share[] = [1, 2, 3].map((n) => ({
  id: `sample${n}`,
  url: "https://sample.wurmhol.dev",
  port: 5173,
  startedBy: "Someone",
  startedAt: 0,
  title: "A dev server",
  favicon: false,
  lastRequestAt: null,
  views: [],
  state: "live",
}));

// Motion's animation code (the menus' hover highlight) loads after the wall's first paint, off
// the startup path, and long before anyone opens a menu.
const motionFeatures = () => import("@/lib/motion-features").then((m) => m.default);

/** The main page: every open pipe of the active org, live, as one network (ADR 0009). */
export function Wall({ me }: { me: Me }) {
  const shares = useWall(me.activeOrgId);
  const [dialog, setDialog] = useState<"members" | "tokens" | null>(null);

  return (
    <div className="min-h-dvh bg-background">
      <Header me={me} onOpen={setDialog} />
      <main className="w-full px-4 sm:px-8">
        {me.standing && !me.standing.ok && <NeedsPlan owner={me.role === "owner"} />}
        <Skeleton id="wall" data={shares} sample={SAMPLE} label="Loading pipes">
          {(list) => <Network shares={list} />}
        </Skeleton>
      </main>
      <MembersDialog me={me} isOpen={dialog === "members"} onOpenChange={() => setDialog(null)} />
      <TokensDialog isOpen={dialog === "tokens"} onOpenChange={() => setDialog(null)} />
    </div>
  );
}

/**
 * The header floats: sharp pills over the canvas, no bar behind them. The org on the left, the
 * org's dialogs in the middle, logging out on the right. On a phone the middle and right fold
 * into one menu. The same 16px above the pills as beside them, so the row sits balanced.
 */
function Header({ me, onOpen }: { me: Me; onOpen: (dialog: "members" | "tokens") => void }) {
  const switchOrg = useSwitchOrg();
  const signOut = useSignOut();
  const billing = useOpenBilling();
  const prefetchDialogs = usePrefetchDialogs();
  const active = me.orgs.find((org) => org.id === me.activeOrgId);
  // Owners manage billing; with billing off (self-hosted) there is nothing to open.
  const canBill = me.role === "owner" && me.standing?.reason !== "billing_off";
  return (
    <header className="sticky top-0 z-10 flex items-center justify-between gap-3 p-4">
      <MenuTrigger>
        <Button
          intent="secondary"
          className="min-w-0"
          isPending={switchOrg.isPending}
          aria-label={`Switch org, currently ${active?.name ?? "none"}`}
        >
          <span className="text-muted-foreground">Wurmhol</span>
          <span className="truncate">{active?.name ?? "No org"}</span>
          <IconChevronsUpDown />
        </Button>
        <Menu
          placement="bottom start"
          selectionMode="single"
          selectedKeys={me.activeOrgId ? [me.activeOrgId] : []}
          onAction={(key) => switchOrg.mutate(String(key))}
        >
          {me.orgs.map((org) => (
            <MenuItem key={org.id} id={org.id} textValue={org.name}>
              <MenuLabel>{org.name}</MenuLabel>
            </MenuItem>
          ))}
        </Menu>
      </MenuTrigger>
      <nav
        aria-label="Org"
        className="absolute start-1/2 hidden -translate-x-1/2 gap-0.5 sm:flex"
        onPointerEnter={prefetchDialogs}
      >
        <Button intent="secondary" onPress={() => onOpen("members")}>
          <IconUsers />
          Members
        </Button>
        <Button intent="secondary" onPress={() => onOpen("tokens")}>
          <IconKey />
          Tokens
        </Button>
        {canBill && (
          <Button intent="secondary" isPending={billing.isPending} onPress={() => billing.mutate()}>
            <IconCreditCard />
            Billing
          </Button>
        )}
      </nav>
      <Button
        intent="secondary"
        className="hidden sm:inline-flex"
        isPending={signOut.isPending}
        onPress={() => signOut.mutate()}
      >
        <IconLogOut />
        Log out
      </Button>
      <MenuTrigger onOpenChange={(open) => open && prefetchDialogs()}>
        <Button intent="secondary" className="sm:hidden" aria-label="Menu">
          <IconEllipsis />
        </Button>
        <Menu placement="bottom end">
          <MenuItem onAction={() => onOpen("members")}>
            <IconUsers />
            <MenuLabel>Members</MenuLabel>
          </MenuItem>
          <MenuItem onAction={() => onOpen("tokens")}>
            <IconKey />
            <MenuLabel>Tokens</MenuLabel>
          </MenuItem>
          {canBill && (
            <MenuItem onAction={() => billing.mutate()}>
              <IconCreditCard />
              <MenuLabel>Billing</MenuLabel>
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem onAction={() => signOut.mutate()}>
            <IconLogOut />
            <MenuLabel>Log out</MenuLabel>
          </MenuItem>
        </Menu>
      </MenuTrigger>
    </header>
  );
}

const COMMAND = "npx wurmhol <port>";

/**
 * Every pipe as a pill on a spoke from the anchor, the command that opens another. Pressing a
 * pill opens it into a card with its details; the other pills make room around it.
 */
function Network({ shares }: { shares: Share[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const current = shares.some((share) => share.id === open) ? open : null;

  // Closing returns focus to the pill the card came from.
  const close = () => {
    const id = current;
    setOpen(null);
    if (id) {
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(`[data-pipe="${CSS.escape(id)}"]`)?.focus(),
      );
    }
  };

  // Escape, or a press anywhere outside the card, closes it. A press on another pill opens that
  // one instead, and presses inside a dialog or menu are theirs.
  useEffect(() => {
    if (!current) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    const onPress = (event: PointerEvent) => {
      const target = event.target as Element;
      if (target.closest("[data-open-pipe], [data-pipe], [role=dialog], [role=menu]")) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPress);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPress);
    };
  });

  return (
    <Constellation
      open={current}
      anchor={
        <div className="relative w-60">
          {shares.length === 0 && (
            // Above the field, out of its box, so the field stays the network's centre.
            <Text className="absolute inset-x-0 bottom-full mb-3 text-center">
              No open pipes. From a dev server's machine, run:
            </Text>
          )}
          <CopyField label="New pipe" value={COMMAND} className="border border-border" />
        </div>
      }
      nodes={shares.map((share) => ({
        id: share.id,
        render:
          share.id === current ? (
            <PipeCard share={share} />
          ) : (
            <PipePill share={share} onPress={() => setOpen(share.id)} />
          ),
      }))}
    />
  );
}

/** The page's title, else the host; a pill falls back to just the pipe's own label. */
function name(share: Share, short = false) {
  const host = new URL(share.url).host;
  return share.title ?? (short ? host.split(".")[0] : host);
}

/** The pipe's mark: its favicon, or a filled square; hollow while its CLI reconnects. */
function Mark({ share }: { share: Share }) {
  if (share.favicon) {
    return (
      <img
        src={`/api/shares/${share.id}/favicon`}
        alt=""
        width={16}
        height={16}
        className="size-4 shrink-0"
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "size-3 shrink-0 border border-muted-foreground",
        share.state === "live" && "bg-muted-foreground",
      )}
    />
  );
}

function PipePill({ share, onPress }: { share: Share; onPress: () => void }) {
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

/** Viewers named in a card; the rest are counted. */
const VIEWS_SHOWN = 3;

function PipeCard({ share }: { share: Share }) {
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
  const rows: [string, string][] = [
    ["Port", String(share.port)],
    ["Status", share.state === "live" ? "Live" : "Reconnecting"],
    ["Started by", share.startedBy ?? "Unknown"],
    ["Started", ago(share.startedAt, now) ?? ""],
    ["Last request", ago(share.lastRequestAt, now) ?? "None yet"],
    ["Viewers", views.length > 0 ? views.join(" · ") : "None yet"],
  ];

  return (
    <section
      ref={card}
      tabIndex={-1}
      data-open-pipe
      aria-label={name(share)}
      className="flex w-[min(22rem,calc(100vw-2rem))] animate-in outline-0 flex-col gap-4 border border-primary bg-background p-4 duration-200 ease-out fade-in zoom-in-95 motion-reduce:animate-none"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-4 shrink-0 items-center">
          <Mark share={share} />
        </span>
        <span className="line-clamp-2 min-w-0 flex-1 text-sm text-foreground">{name(share)}</span>
      </div>
      <CopyField label="URL" value={share.url} />
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
        {rows.map(([term, value]) => (
          <Fragment key={term}>
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="min-w-0 truncate text-foreground tabular-nums">{value}</dd>
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

/** No plan yet (ADR 0004: no trial): pipes refuse to start until an owner subscribes. */
function NeedsPlan({ owner }: { owner: boolean }) {
  const billing = useOpenBilling();
  return (
    <div className="mx-auto mt-4 flex max-w-xl flex-wrap items-center justify-between gap-3 border border-border p-5">
      <Text>
        {owner
          ? "Subscribe to open pipes from your agents."
          : "Pipes start once an owner of this org subscribes."}
      </Text>
      {owner && (
        <Button isPending={billing.isPending} onPress={() => billing.mutate()}>
          Subscribe
        </Button>
      )}
    </div>
  );
}

export function WallPage() {
  const me = useMe();
  if (me.isError) {
    location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    return null;
  }
  return me.data ? (
    <SkeletonProvider>
      <LazyMotion features={motionFeatures} strict>
        <Wall me={me.data} />
      </LazyMotion>
    </SkeletonProvider>
  ) : null;
}
