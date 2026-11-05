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
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Text } from "@/components/ui/text";
import {
  useMe,
  useNow,
  useOpenBilling,
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
  url: "https://sample.on.wurmhol.com",
  port: 5173,
  startedBy: "Someone",
  startedAt: 0,
  title: "A dev server",
  favicon: false,
  lastRequestAt: null,
  state: "live",
}));

/** The main page: every open share of the active org, live (spec section 3, Are.na style). */
export function Wall({ me }: { me: Me }) {
  const shares = useWall(me.activeOrgId);
  const [dialog, setDialog] = useState<"members" | "tokens" | null>(null);

  return (
    <div className="min-h-dvh bg-background">
      <Header me={me} onOpen={setDialog} />
      <main className="mx-auto w-full max-w-6xl px-4 pt-6 pb-16 sm:px-8 sm:pt-10">
        {me.standing && !me.standing.ok && (
          <Text className="mb-6 text-sm text-warning-subtle-foreground">
            The trial has ended: new shares need a plan.
            {me.role === "owner" ? " Open Billing in the menu." : " Ask an owner to subscribe."}
          </Text>
        )}
        <Skeleton id="wall" data={shares} sample={SAMPLE} label="Loading shares">
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
      <MenuTrigger>
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
      <Text className="line-clamp-2 text-xs text-muted-foreground tabular-nums">
        {details.join(" · ")}
      </Text>
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

function Empty() {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-3 pt-16 text-center">
      <Text>No open shares. From a dev server's machine, run:</Text>
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
  return me.data ? <Wall me={me.data} /> : null;
}
