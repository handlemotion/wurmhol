import { AnimatePresence, LazyMotion, m, useReducedMotion } from "motion/react";
import { NPM } from "@ridemountainpig/svgl-react";
import { cn } from "cn";
import { Fragment, useEffect, useRef, useState } from "react";
import { Skeleton } from "skullet/react";
import {
  IconArrowLeft,
  IconChevronsUpDown,
  IconCreditCard,
  IconEllipsis,
  IconArrowUpRight,
  IconCheck,
  IconExternalLink,
  IconLaptop,
  IconSettings,
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
import { Loader } from "@/components/ui/loader";
import {
  Menu,
  MenuDescription,
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
  useMachines,
  useOpenBilling,
  useOpenPort,
  usePrefetchDialogs,
  useSetupCode,
  useSignOut,
  useSwitchOrg,
  useTerminate,
  useWall,
} from "@/hooks/use-app";
import { useClipboard } from "@/hooks/use-clipboard";
import { useGithub } from "@/hooks/use-github";
import type { Machine, Me, PipeSource, Share } from "@/lib/api";
import { initials } from "@/lib/initials";
import { ago } from "@/lib/time";
import { MembersDialog } from "./members-dialog";
import { type OrgAction, OrgDialog } from "./org-dialogs";
import { Constellation } from "./constellation";
import { ANCHOR } from "./constellation-layout";
import { TokensDialog } from "./tokens-dialog";
import { WallPlate } from "./wall-plate";

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
  source: null,
  preview: null,
}));

// Motion's animation code (the menus' hover highlight) loads after the wall's first paint, off
// the startup path, and long before anyone opens a menu.
const motionFeatures = () => import("@/lib/motion-features").then((m) => m.default);

/** The main page: every open pipe of the active org, live, as one network (ADR 0011). */
export function Wall({ me }: { me: Me }) {
  const shares = useWall(me.activeOrgId);
  const [dialog, setDialog] = useState<"members" | "tokens" | null>(null);

  return (
    // Clipped at the page's edges, not the canvas's: a network the camera pans runs on under the
    // floating header and off the sides of the window, never against an invisible box.
    <div className="min-h-dvh overflow-clip bg-background">
      <Header me={me} onOpen={setDialog} fade={shares?.length !== 0} />
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
function Header({
  me,
  onOpen,
  fade,
}: {
  me: Me;
  onOpen: (dialog: "members" | "tokens") => void;
  /** Off on the empty wall: no pill can pan under the header, and the backdrop runs on to the top. */
  fade: boolean;
}) {
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
      {/* No bar, but a fade: pills the camera pans up dissolve under the header's pills. */}
      {fade && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[calc(100%+2rem)] bg-linear-to-b from-background from-50% to-transparent"
        />
      )}
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
          onAction={(key) => {
            const action = ORG_ACTIONS.find((a) => a.id === key);
            if (action) setOrgAction(action.id);
            else switchOrg.mutate(String(key));
          }}
        >
          {/* The orgs lead: switching is what the menu is for. Then starting one, then what can be
              done to the active one, with deleting set apart at the bottom. */}
          <MenuSection
            aria-label="Orgs"
            items={me.orgs}
            // Only the orgs are chosen between; the rows below are plain actions.
            selectionMode="single"
            selectedKeys={me.activeOrgId ? [me.activeOrgId] : []}
          >
            {(org) => (
              <MenuItem id={org.id} textValue={org.name}>
                {/* Your own personal org wears your picture; any other org, its initials. */}
                <Avatar
                  src={org.personal && org.role === "owner" ? me.user.image : null}
                  initials={initials(org.name)}
                  alt=""
                />
                <MenuLabel>{org.name}</MenuLabel>
                <MenuDescription>{org.role === "owner" ? "Owner" : "Member"}</MenuDescription>
              </MenuItem>
            )}
          </MenuSection>
          <MenuSeparator />
          <MenuSection aria-label="Org actions">
            {ORG_ACTIONS.filter(
              (a) => !a.danger && (owner || !a.owner) && (active || a.id === "create"),
            ).map(({ id, label, Icon }) => (
              <MenuItem key={id} id={id}>
                <Icon />
                <MenuLabel>{label}</MenuLabel>
              </MenuItem>
            ))}
          </MenuSection>
          {active && owner && <MenuSeparator />}
          {active && owner && (
            <MenuSection aria-label={`Delete ${active.name}`}>
              <MenuItem id="delete" intent="danger">
                <IconTrash />
                <MenuLabel>Delete org</MenuLabel>
              </MenuItem>
            </MenuSection>
          )}
        </Menu>
      </MenuTrigger>
      <OrgDialog
        action={orgAction}
        orgName={active?.name ?? ""}
        isOwner={owner}
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

/** What the switcher offers: anyone starts an org or opens its settings; owners delete it. */
const ORG_ACTIONS = [
  { id: "create", label: "New org", Icon: IconPlus, owner: false, danger: false },
  { id: "settings", label: "Org settings", Icon: IconSettings, owner: false, danger: false },
  { id: "delete", label: "Delete org", Icon: IconTrash, owner: true, danger: true },
] as const;

const COMMAND = "npx wurmhol <port>";
const PROMPT =
  "Start the dev server, then run `npx wurmhol <port>` with its port and send me the URL it prints.";

/**
 * Every pipe as a pill on a spoke from the anchor, the Create pipe button. Pressing a pill opens
 * it into a card with its details; pressing Create pipe opens the ways to start one. One is open
 * at a time; it opens where its pill stands, and the view pans to it while every other pill
 * holds its place.
 */
function Network({ shares }: { shares: Share[] }) {
  const [open, setOpen] = useState<string | null>(null);
  // A pipe opened from this computer: its card opens once the wall has it.
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => {
    const share = opened && shares.find((s) => s.url === opened);
    if (!share) return;
    setOpened(null);
    setOpen(share.id);
  }, [opened, shares]);
  const current = open === ANCHOR || shares.some((share) => share.id === open) ? open : null;
  // The pill to focus once its card has gone.
  const restore = useRef<string | null>(null);

  // Closing returns focus to the pill the card came from, once the card's exit lets it back.
  const close = () => {
    restore.current = current;
    setOpen(null);
  };
  const onClosed = () => {
    const id = restore.current;
    restore.current = null;
    if (!id) return;
    const selector = id === ANCHOR ? "[data-create]" : `[data-pipe="${CSS.escape(id)}"]`;
    // The pill mounts after the card's exit completes, and until then the only match can be the
    // card's inert copy of it, which takes no focus: wait a few frames for the real one.
    const focus = (frames: number) => {
      const pill = [...document.querySelectorAll<HTMLElement>(selector)].find(
        (el) => !el.closest("[inert]"),
      );
      if (pill) pill.focus();
      else if (frames > 0) requestAnimationFrame(() => focus(frames - 1));
    };
    focus(10);
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
      // Only while the wall is empty: it draws what a pipe is (a container and a browser, the
      // button on the line between them). Once pipes are open, their own network is the picture.
      backdrop={
        shares.length === 0 && (
          <WallPlate className="text-hairline-line animate-in duration-700 ease-out fade-in motion-reduce:animate-none" />
        )
      }
      anchor={
        <div className="relative">
          {/* The backdrop says it to the eye; this says it to a screen reader. */}
          {shares.length === 0 && <span className="sr-only">No open pipes yet.</span>}
          <Swap
            open={current === ANCHOR}
            edge="border-border"
            onClosed={onClosed}
            card={<CreateCard onOpened={setOpened} />}
            pill={
              <Button
                intent="secondary"
                data-create
                aria-expanded={false}
                onPress={() => setOpen(ANCHOR)}
              >
                <IconPlus />
                Create pipe
              </Button>
            }
          />
        </div>
      }
      nodes={shares.map((share) => ({
        id: share.id,
        render: (
          <Swap
            open={share.id === current}
            edge="border-primary"
            onClosed={onClosed}
            card={<PipeCard share={share} />}
            pill={<PipePill share={share} onPress={() => setOpen(share.id)} />}
          />
        ),
      }))}
    />
  );
}

/**
 * The card's box, at `--open` from 0 (the pill's rect inside it, from `--pill-*`, which the
 * constellation sets) to 1 (the whole card). Inset clipping, so the content unfolds unscaled.
 */
const unfold = (edge: "x" | "y", side: "start" | "end") => {
  const at = `var(--pill-${edge})`;
  const half = `var(--pill-${edge === "x" ? "w" : "h"}) / 2`;
  const inset = side === "start" ? `(${at} - ${half})` : `(100% - ${at} - ${half})`;
  return `calc(${inset} * (1 - var(--open)))`;
};
const TOP = unfold("y", "start");
const RIGHT = unfold("x", "end");
const BOTTOM = unfold("y", "end");
const LEFT = unfold("x", "start");

/**
 * A still copy of the pill at its own rect inside the card: opaque while the card is nearly
 * folded and gone by halfway, so on close the pill's fill and label fade in as the card folds
 * into it, and the real pill takes over without a fade.
 */
const GHOST = {
  left: "calc(var(--pill-x) - var(--pill-w) / 2)",
  top: "calc(var(--pill-y) - var(--pill-h) / 2)",
  opacity: "clamp(0, calc(1 - var(--open) * 2), 1)",
};

/** The unfold's spring: interrupted (a press mid-open), it turns back from where it stands. */
const UNFOLD = { type: "spring", stiffness: 380, damping: 36, mass: 1 } as const;

const morph = {
  closed: { "--open": 0 },
  open: { "--open": 1 },
} as const;
const content = {
  closed: { opacity: 0, transition: { duration: 0.08, ease: "easeIn" } },
  open: { opacity: 1, transition: { duration: 0.18, delay: 0.06, ease: "easeOut" } },
} as const;

/**
 * A node's pill or its card. The card unfolds out of its pill's rect (its border drawn on the
 * unfolding edge) while its content fades in, and folds back into it on close, the pill fading
 * in over the fold's second half; the real pill returns once the card has gone.
 */
function Swap(props: {
  open: boolean;
  pill: React.ReactNode;
  card: React.ReactNode;
  /** The card's border colour, drawn on the edge that unfolds. */
  edge: string;
  onClosed: () => void;
}) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence mode="wait" initial={false} onExitComplete={props.onClosed}>
      {props.open ? (
        <m.div
          key="card"
          className="relative"
          variants={morph}
          initial="closed"
          animate="open"
          exit="closed"
          transition={reduce ? { duration: 0 } : UNFOLD}
          style={{ clipPath: `inset(${TOP} ${RIGHT} ${BOTTOM} ${LEFT})` }}
        >
          <m.div variants={content}>{props.card}</m.div>
          <span
            aria-hidden
            className={cn("pointer-events-none absolute border", props.edge)}
            style={{ top: TOP, right: RIGHT, bottom: BOTTOM, left: LEFT }}
          />
          <div aria-hidden inert className="pointer-events-none absolute" style={GHOST}>
            {props.pill}
          </div>
        </m.div>
      ) : (
        <div key="pill">{props.pill}</div>
      )}
    </AnimatePresence>
  );
}

/** The command Create from this computer copies, with its setup code (ADR 0020). */
const host = (code: string) => `npx wurmhol host --code ${code}`;

/** npm's mark (svgl) at 13px inside the rows' 15px icon slot, as the design draws it. */
function NpmMark() {
  return (
    <span aria-hidden className="flex size-icon shrink-0 items-center justify-center">
      <NPM className="size-3.25" />
    </span>
  );
}

/**
 * The ways to start a pipe. Every copy row's label is the verb and what it copies; once copied,
 * the row names what is on the clipboard. The last row opens this computer's steps in place.
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
  {
    id: "machine",
    label: "Create from this computer",
    done: null,
    value: null,
    Icon: IconLaptop,
  },
] as const;

/**
 * Create pipe, open: a muted label over the ways to start one. A fixed square, so options can be
 * added, and this computer's steps shown in its place, without the card changing shape. A row
 * says "Copied" for a moment after its press.
 */
function CreateCard({ onOpened }: { onOpened: (url: string) => void }) {
  const { copy, copied } = useClipboard();
  const [last, setLast] = useState<string | null>(null);
  const [view, setView] = useState<"ways" | "machine">("ways");
  const docs = useAppConfig().data?.docsUrl;
  return (
    <section
      data-open
      aria-label="Create pipe"
      className="flex size-72 flex-col gap-0.5 border border-border bg-background p-2"
    >
      {view === "machine" ? (
        <MachineSteps onBack={() => setView("ways")} onOpened={onOpened} />
      ) : (
        <>
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
              if (option.value === null) return setView("machine");
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
        </>
      )}
    </section>
  );
}

/** A step's mark: its number while ahead or open, a check once done. In the rows' icon slot. */
function StepMark({ n, done }: { n: number; done: boolean }) {
  return (
    <span
      aria-hidden
      className="flex size-icon shrink-0 items-center justify-center text-xs text-muted-foreground tabular-nums"
    >
      {done ? <IconCheck className="size-icon" /> : n}
    </span>
  );
}

/**
 * Create from this computer (ADR 0018, 0020): run the command here, then pick a port it found.
 * The command carries a setup code for the signed-in person, so the CLI needs no approval. The
 * first step collapses to its answer once a computer connects; picking a port opens its pipe and
 * its card.
 */
function MachineSteps({
  onBack,
  onOpened,
}: {
  onBack: () => void;
  onOpened: (url: string) => void;
}) {
  const machines = useMachines(true);
  const openPort = useOpenPort();
  const [picked, setPicked] = useState<string | null>(null);
  const connected = machines?.length ? machines : null;
  const setup = useSetupCode(!connected);
  const row = "flex h-8 items-center gap-2.5 px-2 text-sm";
  return (
    <>
      <div className="flex h-8 items-center gap-1">
        <Button intent="plain" size="sq-xs" aria-label="Back" autoFocus onPress={onBack}>
          <IconArrowLeft />
        </Button>
        <span className="text-xs text-subtle-foreground">Create from this computer</span>
      </div>
      <ol className="flex min-h-0 flex-1 flex-col gap-0.5">
        <li className="flex flex-col gap-1">
          <span className={cn(row, connected ? "text-muted-foreground" : "text-foreground")}>
            <StepMark n={1} done={Boolean(connected)} />
            <span className="truncate">
              {connected
                ? `Running on ${connected.map((m) => m.name).join(", ")}`
                : "Run the CLI here"}
            </span>
          </span>
          {!connected && (
            <div className="ps-8.25 pe-2">
              {setup.isError ? (
                <span role="alert" className="text-xs text-danger-subtle-foreground">
                  {setup.error.message}
                </span>
              ) : (
                <Skeleton
                  id="setup-code"
                  data={setup.data}
                  sample={{ code: "x".repeat(40), expires_in: 1800 }}
                  label="Loading the command"
                >
                  {({ code }) => <CopyField label="Run" value={host(code)} />}
                </Skeleton>
              )}
            </div>
          )}
        </li>
        <li className="flex min-h-0 flex-1 flex-col">
          <span className={cn(row, connected ? "text-foreground" : "text-subtle-foreground")}>
            <StepMark n={2} done={false} />
            <span className="truncate">Pick a port</span>
          </span>
          {connected && (
            <Ports
              machines={connected}
              pending={openPort.isPending ? picked : null}
              onPick={(machine, port) => {
                setPicked(`${machine}:${port}`);
                openPort.mutate({ machine, port }, { onSuccess: ({ url }) => onOpened(url) });
              }}
            />
          )}
        </li>
      </ol>
      {openPort.error && (
        <span
          role="alert"
          className="flex h-8 items-center px-2 text-xs text-danger-subtle-foreground"
        >
          <span className="truncate">{openPort.error.message}</span>
        </span>
      )}
    </>
  );
}

/** The web servers a connected computer found, one row each; with two computers, under each name. */
function Ports(props: {
  machines: Machine[];
  pending: string | null;
  onPick: (machine: string, port: number) => void;
}) {
  const several = props.machines.length > 1;
  const items = props.machines.flatMap((machine) =>
    machine.ports.map((p) => ({ key: `${machine.id}:${p.port}`, machine, ...p })),
  );
  if (!items.length) {
    return (
      <span className="flex min-h-8 items-center gap-2.5 px-2 text-xs text-muted-foreground">
        <span aria-hidden className="size-icon shrink-0" />
        No web server is running there yet. Start one and it shows up here.
      </span>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ActionList
        aria-label="Ports"
        onAction={(key) => {
          const item = items.find((i) => i.key === key);
          if (item && !props.pending) props.onPick(item.machine.id, item.port);
        }}
      >
        {items.map(({ key, machine, port, title }) => (
          <ActionItem key={key} id={key} textValue={`${port} ${title ?? ""}`}>
            {/* The steps' mark slot, so ports line up under "Pick a port". */}
            {props.pending === key ? (
              <Loader className="size-icon" />
            ) : (
              <span aria-hidden className="size-icon shrink-0" />
            )}
            <span className="shrink-0 tabular-nums">:{port}</span>
            <span className="truncate text-muted-foreground">
              {[title, several ? machine.name : null].filter(Boolean).join(" · ")}
            </span>
          </ActionItem>
        ))}
      </ActionList>
    </div>
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
 * environment named one), then the branch and short commit. Null when the source names neither.
 */
function From({ source }: { source: PipeSource }) {
  const git = [source.branch, source.commit && `@ ${source.commit.slice(0, 7)}`]
    .filter(Boolean)
    .join(" ");
  const agent = source.agent ?? (source.agentUrl ? "Agent" : null);
  const parts = [
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
  if (!parts.length) return null;
  // The parts wrap onto a second line rather than cut off the commit; each one truncates alone.
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
function usePullRequest(share: Share): React.ReactNode {
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
  const { source } = share;
  const pullRequest = usePullRequest(share);
  const from =
    source && (source.agent || source.agentUrl || source.branch || source.commit || source.repo);
  const rows: [string, React.ReactNode, string?][] = [
    ...(from
      ? [
          [
            "From",
            <From source={source} />,
            // The full repo, branch and commit on hover; the row shows them short.
            [source.repo, source.branch, source.commit].filter(Boolean).join(" · "),
          ] as [string, React.ReactNode, string],
        ]
      : []),
    ...(source?.note ? [["Note", source.note, source.note] as [string, string, string]] : []),
    ...(source?.link
      ? [
          ["Link", <RowLink href={source.link}>{shortUrl(source.link)}</RowLink>, source.link] as [
            string,
            React.ReactNode,
            string,
          ],
        ]
      : []),
    ...(pullRequest ? [["Pull request", pullRequest] as [string, React.ReactNode]] : []),
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
        {rows.map(([term, value, title]) => (
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
