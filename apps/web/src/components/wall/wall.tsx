import { LazyMotion } from "motion/react";
import { NPM } from "@ridemountainpig/svgl-react";
import { cn } from "cn";
import { Fragment, useEffect, useRef, useState } from "react";
import { Skeleton } from "skullet/react";
import {
  IconChevronsUpDown,
  IconCreditCard,
  IconDoorOpen,
  IconEllipsis,
  IconArrowUpRight,
  IconCheck,
  IconExternalLink,
  IconLaptop,
  IconPencil,
  IconPlus,
  IconSparkles,
  IconTrash,
  IconKey,
  IconLogOut,
  IconUsers,
} from "@/components/icons/lucide";
import { ActionItem, ActionList } from "@/components/ui/action-list";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import { SkeletonProvider } from "@/components/ui/skeleton-provider";
import { Link } from "@/components/ui/link";
import {
  Menu,
  MenuDescription,
  MenuHeader,
  MenuItem,
  MenuLabel,
  MenuSection,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { Text } from "@/components/ui/text";
import {
  useAppConfig,
  useMe,
  useNow,
  useOpenBilling,
  usePrefetchDialogs,
  useSignOut,
  useSwitchOrg,
  useTerminate,
  useWall,
} from "@/hooks/use-app";
import { useClipboard } from "@/hooks/use-clipboard";
import type { Me, Share } from "@/lib/api";
import { initials } from "@/lib/initials";
import { ago } from "@/lib/time";
import { MembersDialog } from "./members-dialog";
import { type OrgAction, OrgDialog } from "./org-dialogs";
import { Constellation } from "./constellation";
import { ANCHOR } from "./constellation-layout";
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

/** The main page: every open pipe of the active org, live, as one network (ADR 0011). */
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
  const [orgAction, setOrgAction] = useState<OrgAction | null>(null);
  const owner = me.role === "owner";
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
          onAction={(key) => {
            const action = ORG_ACTIONS.find((a) => a.id === key);
            if (action) setOrgAction(action.id);
            else switchOrg.mutate(String(key));
          }}
          popover={{ className: "max-w-72" }}
        >
          <MenuSection aria-label="Signed in as">
            <MenuHeader className="flex items-center gap-3 p-2.5">
              <Avatar
                size="md"
                src={me.user.image}
                initials={initials(me.user.name, me.user.email)}
                alt=""
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm text-foreground">
                  {me.user.name || me.user.email}
                </span>
                {me.user.name && (
                  <span className="truncate text-xs text-muted-foreground">{me.user.email}</span>
                )}
              </span>
            </MenuHeader>
          </MenuSection>
          <MenuSeparator />
          <MenuSection aria-label="Orgs" items={me.orgs}>
            {(org) => (
              <MenuItem id={org.id} textValue={org.name}>
                {/* One letter: two would be specks at 20px. */}
                <Avatar initials={initials(org.name).slice(0, 1)} alt="" />
                <MenuLabel>{org.name}</MenuLabel>
                <MenuDescription>{org.role === "owner" ? "Owner" : "Member"}</MenuDescription>
              </MenuItem>
            )}
          </MenuSection>
          {active && <MenuSeparator />}
          {active && (
            <MenuSection aria-label={active.name}>
              {ORG_ACTIONS.filter((a) => owner || !a.owner).map(({ id, label, Icon, danger }) => (
                <MenuItem key={id} id={id} intent={danger ? "danger" : undefined}>
                  <Icon />
                  <MenuLabel>{label}</MenuLabel>
                </MenuItem>
              ))}
            </MenuSection>
          )}
        </Menu>
      </MenuTrigger>
      <OrgDialog
        action={orgAction}
        orgName={active?.name ?? ""}
        onClose={() => setOrgAction(null)}
      />
      <nav
        aria-label="Org"
        className="absolute start-1/2 hidden -translate-x-1/2 gap-2 sm:flex"
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
        intent="danger"
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
          <MenuItem intent="danger" onAction={() => signOut.mutate()}>
            <IconLogOut />
            <MenuLabel>Log out</MenuLabel>
          </MenuItem>
        </Menu>
      </MenuTrigger>
    </header>
  );
}

/** What the switcher offers for the active org; owners rename and delete. */
const ORG_ACTIONS = [
  { id: "rename", label: "Rename org", Icon: IconPencil, owner: true, danger: false },
  { id: "leave", label: "Leave org", Icon: IconDoorOpen, owner: false, danger: false },
  { id: "delete", label: "Delete org", Icon: IconTrash, owner: true, danger: true },
] as const;

const COMMAND = "npx wurmhol <port>";
const PROMPT =
  "Start the dev server, then run `npx wurmhol <port>` with its port and send me the URL it prints.";

/**
 * Every pipe as a pill on a spoke from the anchor, the Create pipe button. Pressing a pill opens
 * it into a card with its details; pressing Create pipe opens the ways to start one. One is open
 * at a time, and the other pills make room around it.
 */
function Network({ shares }: { shares: Share[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const current = open === ANCHOR || shares.some((share) => share.id === open) ? open : null;

  // Closing returns focus to the pill the card came from.
  const close = () => {
    const id = current;
    setOpen(null);
    if (id) {
      const selector = id === ANCHOR ? "[data-create]" : `[data-pipe="${CSS.escape(id)}"]`;
      requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus());
    }
  };

  // Escape, or a press anywhere outside the open card, closes it. A press on another pill opens
  // that one instead, and presses inside a dialog, menu or tooltip are theirs.
  useEffect(() => {
    if (!current) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    const onPress = (event: PointerEvent) => {
      const target = event.target as Element;
      const keep = "[data-open], [data-pipe], [data-create], [role=dialog], [role=menu]";
      if (target.closest(keep)) return;
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
        <div className="relative">
          {shares.length === 0 && current !== ANCHOR && (
            // Above the button, out of its box, so the button stays the network's centre.
            <Text className="absolute start-1/2 bottom-full mb-3 -translate-x-1/2 text-nowrap">
              No open pipes yet.
            </Text>
          )}
          {current === ANCHOR ? (
            <CreateCard />
          ) : (
            <Button
              intent="secondary"
              data-create
              aria-expanded={false}
              onPress={() => setOpen(ANCHOR)}
            >
              <IconPlus />
              Create pipe
            </Button>
          )}
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

const LOGIN = "npx wurmhol login && npx wurmhol <port>";

/** npm's mark (svgl) at 13px inside the rows' 15px icon slot, as the design draws it. */
function NpmMark() {
  return (
    <span aria-hidden className="flex size-icon shrink-0 items-center justify-center">
      <NPM className="size-3.25" />
    </span>
  );
}

/**
 * The ways to start a pipe, each copied in one press. Every label is the verb and what it
 * copies; once copied, the row names what is on the clipboard.
 */
const CREATE = [
  {
    id: "prompt",
    label: "Copy agent prompt",
    done: "Prompt copied",
    value: PROMPT,
    Icon: IconSparkles,
  },
  {
    id: "command",
    label: "Copy npx command",
    done: "Command copied",
    value: COMMAND,
    Icon: NpmMark,
  },
  // Approves this computer in the browser first, then shares the port from it.
  {
    id: "machine",
    label: "Copy setup for this computer",
    done: "Setup copied",
    value: LOGIN,
    Icon: IconLaptop,
  },
] as const;

/**
 * Create pipe, open: a muted label over the ways to start one. A fixed square, so options can be
 * added without the card changing shape. A row says "Copied" for a moment after its press.
 */
function CreateCard() {
  const { copy, copied } = useClipboard();
  const [last, setLast] = useState<string | null>(null);
  const docs = useAppConfig().data?.docsUrl;
  return (
    <section
      data-open
      aria-label="Create pipe"
      className="flex size-72 animate-in flex-col gap-0.5 border border-border bg-background p-2 duration-200 ease-out fade-in zoom-in-95 motion-reduce:animate-none"
    >
      <span aria-hidden className="flex h-8 items-center px-2 text-xs text-subtle-foreground">
        Create pipe
      </span>
      {/* Focus lands on the first row, so arrows, Enter and Escape work from the start. */}
      <ActionList
        aria-label="Create pipe"
        autoFocus="first"
        onAction={(key) => {
          const option = CREATE.find((item) => item.id === key);
          if (!option) return;
          setLast(option.id);
          void copy(option.value);
        }}
      >
        {CREATE.map(({ id, label, done, Icon }) => (
          <ActionItem key={id} id={id} textValue={label}>
            {copied && last === id ? <IconCheck /> : <Icon aria-hidden />}
            <span className="truncate">{copied && last === id ? done : label}</span>
          </ActionItem>
        ))}
      </ActionList>
      {/* The footer mirrors the label above: same row, same muted type, pinned to the bottom. */}
      {docs && (
        <Link
          href={docs}
          target="_blank"
          rel="noopener"
          className="mt-auto flex h-8 items-center gap-1 px-2 text-xs text-subtle-foreground hover:text-foreground"
        >
          Docs
          <IconArrowUpRight className="size-3" />
        </Link>
      )}
    </section>
  );
}

/** The page's title, else the host; a pill falls back to just the pipe's own label. */
function name(share: Share, short = false) {
  const host = new URL(share.url).host;
  return share.title ?? (short ? host.split(".")[0] : host);
}

/** The pipe's mark: its favicon, or a filled square; hollow while its CLI reconnects. */
function Mark({ share }: { share: Share }) {
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
      data-open
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
