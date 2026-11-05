import { LazyMotion } from "motion/react";
import { useState } from "react";
import { Skeleton } from "skullet/react";
import {
  IconChevronsUpDown,
  IconCreditCard,
  IconEllipsis,
  IconKey,
  IconLogOut,
  IconUsers,
} from "@/components/icons/lucide";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import { Link } from "@/components/ui/link";
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

/** The main page: every open share of the active org, live (spec section 3, Are.na style). */
export function Wall({ me }: { me: Me }) {
  const shares = useWall(me.activeOrgId);
  const [dialog, setDialog] = useState<"members" | "tokens" | null>(null);

  return (
    <div className="min-h-dvh bg-background">
      <Header me={me} onOpen={setDialog} />
      <main className="mx-auto w-full max-w-6xl px-4 pt-6 pb-16 sm:px-8 sm:pt-10">
        {me.standing && !me.standing.ok && <NeedsPlan owner={me.role === "owner"} />}
        <Skeleton id="wall" data={shares} sample={SAMPLE} label="Loading pipes">
          {(list) =>
            list.length === 0 ? (
              <Empty />
            ) : (
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {list.map((share) => (
                  <ShareCard key={share.id} share={share} />
                ))}
              </ul>
            )
          }
        </Skeleton>
      </main>
      <MembersDialog me={me} isOpen={dialog === "members"} onOpenChange={() => setDialog(null)} />
      <TokensDialog isOpen={dialog === "tokens"} onOpenChange={() => setDialog(null)} />
    </div>
  );
}

function Header({ me, onOpen }: { me: Me; onOpen: (dialog: "members" | "tokens") => void }) {
  const switchOrg = useSwitchOrg();
  const signOut = useSignOut();
  const billing = useOpenBilling();
  const prefetchDialogs = usePrefetchDialogs();
  const active = me.orgs.find((org) => org.id === me.activeOrgId);
  return (
    <header className="flex h-14 items-center justify-between gap-3 border-b border-border px-4 sm:px-8">
      <div className="flex min-w-0 items-center gap-3">
        <span className="text-sm text-foreground">Wurmhol</span>
        <span className="text-sm text-subtle-foreground">/</span>
        <MenuTrigger>
          <Button
            intent="plain"
            size="sm"
            className="min-w-0"
            isPending={switchOrg.isPending}
            aria-label={`Switch org, currently ${active?.name ?? "none"}`}
          >
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
      </div>
      <MenuTrigger onOpenChange={(open) => open && prefetchDialogs()}>
        <Button intent="plain" size="sq-sm" aria-label="Menu">
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
          {/* Owners manage billing; with billing off (self-hosted) there is nothing to open. */}
          {me.role === "owner" && me.standing?.reason !== "billing_off" && (
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

/** Viewers named on a card; the rest are counted. */
const VIEWS_SHOWN = 2;

function ShareCard({ share }: { share: Share }) {
  const now = useNow();
  const terminate = useTerminate();
  const host = new URL(share.url).host;
  const details = [
    `:${share.port}`,
    share.startedBy,
    ago(share.startedAt, now),
    share.lastRequestAt ? `last request ${ago(share.lastRequestAt, now)}` : "no requests yet",
    share.state === "away" ? "reconnecting" : null,
  ].filter(Boolean);
  // Who opened it, most recent first: "Ana, 2 min ago · Bo, 1 h ago · +3".
  const shown = share.views.slice(0, VIEWS_SHOWN);
  const views = [
    ...shown.map((view) => `${view.name}, ${ago(view.lastSeenAt, now)}`),
    share.views.length > shown.length ? `+${share.views.length - shown.length}` : null,
  ].filter(Boolean);

  return (
    // Same size everywhere: a fixed height, the title clamped to two lines.
    <li className="relative flex h-40 flex-col justify-between rounded-xl border border-border bg-background p-5">
      <div className="flex items-start gap-3 pe-20">
        {share.favicon ? (
          <img
            src={`/api/shares/${share.id}/favicon`}
            alt=""
            width={16}
            height={16}
            className="mt-0.5 size-4 shrink-0"
          />
        ) : (
          <span aria-hidden className="mt-0.5 size-4 shrink-0 rounded-sm bg-accent" />
        )}
        {/* The whole card opens the share: this link's hit area covers it. */}
        <Link
          href={share.url}
          target="_blank"
          rel="noopener"
          className="line-clamp-2 text-sm text-foreground after:absolute after:inset-0 after:rounded-xl"
        >
          {share.title ?? host}
        </Link>
      </div>
      <div className="flex flex-col gap-1">
        {views.length > 0 && (
          <Text className="truncate text-xs text-foreground tabular-nums">{views.join(" · ")}</Text>
        )}
        <Text className="line-clamp-2 text-xs text-muted-foreground tabular-nums">
          {details.join(" · ")}
        </Text>
      </div>
      <div className="absolute end-4 top-4">
        {/* xs, not sm: Intent UI's sm grows to a 36px touch target, larger than md. */}
        <Button
          intent="danger"
          size="xs"
          isPending={terminate.isPending}
          onPress={() => terminate.mutate(share.id)}
        >
          Terminate
        </Button>
      </div>
    </li>
  );
}

/** No plan yet (ADR 0004: no trial): pipes refuse to start until an owner subscribes. */
function NeedsPlan({ owner }: { owner: boolean }) {
  const billing = useOpenBilling();
  return (
    <div className="mb-8 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-5">
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

function Empty() {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-3 pt-16 text-center">
      <Text>No open pipes. From a dev server's machine, run:</Text>
      <CopyField label="Run" value="npx wurmhol <port>" />
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
