import { cn } from "cn";
import { Fragment, useEffect, useRef, useState } from "react";
import { Skeleton } from "skullet/react";
import {
  IconCircleStop,
  IconEllipsis,
  IconKey,
  IconSettings,
  IconTrash,
} from "@/components/icons/lucide";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { useNow } from "@/hooks/use-app";
import { useAppTunnels, useEndTunnel } from "@/hooks/use-apps";
import type { App, AppTunnel } from "@/lib/api";
import { ago } from "@/lib/time";
import { AppKeysDialog } from "./app-keys-dialog";
import { AppSettingsDialog } from "./app-settings-dialog";

/** An app's mark: filled while any of its pipes is open, hollow otherwise, like a pipe's. */
function Mark({ live }: { live: boolean }) {
  return (
    <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
      <span
        className={cn("size-3 border border-muted-foreground", live && "bg-muted-foreground")}
      />
    </span>
  );
}

/** `data-app` lets the network tell a press on a pill from one outside, and refocus it on close. */
export function AppPill({ app, onPress }: { app: App; onPress: () => void }) {
  return (
    <Button
      intent="outline"
      data-app={app.id}
      aria-expanded={false}
      onPress={onPress}
      className="max-w-64"
    >
      <Mark live={app.usage.openTunnels > 0} />
      <span className="truncate">{app.name}</span>
      <span className="text-muted-foreground tabular-nums">{app.usage.openTunnels}</span>
    </Button>
  );
}

/** Pipes listed on the card; the rest are counted. Open ones first, then the latest active. */
const PIPES_SHOWN = 5;

const STATE: Record<AppTunnel["state"], string> = {
  live: "Live",
  away: "Reconnecting",
  stopped: "Stopped",
  ended: "Closed",
  never: "Not opened yet",
};

function activity(tunnel: AppTunnel) {
  const open = tunnel.state === "live" || tunnel.state === "away" ? 1 : 0;
  const at = tunnel.session?.lastRequestAt ?? tunnel.session?.startedAt ?? tunnel.createdAt;

  return [open, Date.parse(at)] as const;
}

function byActivity(a: AppTunnel, b: AppTunnel) {
  const [aOpen, aAt] = activity(a);
  const [bOpen, bAt] = activity(b);

  return bOpen - aOpen || bAt - aAt;
}

const SAMPLE: AppTunnel[] = [1, 2].map((n) => ({
  id: `sample${n}`,
  url: "https://esample.wurmhol.dev",
  tenant: "customer",
  owner: "user",
  state: "live",
  createdAt: "",
  stoppedAt: null,
  session: null,
  lastEnd: null,
}));

/**
 * An app's card: what it uses this month, its pipes with their health, and its keys and
 * settings. Pipes can be stopped or deleted, never opened: an owner's session reaches no
 * embedded pipe (ADR 0032).
 */
export function AppCard({ app, onDeleted }: { app: App; onDeleted: () => void }) {
  const card = useRef<HTMLElement>(null);
  useEffect(() => card.current?.focus({ preventScroll: true }), []);
  const tunnels = useAppTunnels(app.id, true);
  const [dialog, setDialog] = useState<"keys" | "settings" | null>(null);

  const rows = [
    { term: "Pipes open", value: String(app.usage.openTunnels) },
    { term: "Requests", value: `${app.usage.requests.toLocaleString()} this month` },
    { term: "Sign-in page", value: app.launchUrl ? new URL(app.launchUrl).host : "None set" },
  ];

  return (
    <section
      ref={card}
      tabIndex={-1}
      data-open
      aria-label={app.name}
      className="flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-4 border border-primary bg-background p-4 outline-0"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-4 shrink-0 items-center">
          <Mark live={app.usage.openTunnels > 0} />
        </span>
        <span className="line-clamp-2 min-w-0 flex-1 text-sm text-foreground">{app.name}</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
        {rows.map(({ term, value }) => (
          <Fragment key={term}>
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="min-w-0 truncate text-foreground tabular-nums">{value}</dd>
          </Fragment>
        ))}
      </dl>
      <Skeleton
        id={`app-pipes-${app.id}`}
        data={tunnels.data?.tunnels}
        sample={SAMPLE}
        label="Loading pipes"
      >
        {(list) => <Pipes app={app.id} tunnels={list} />}
      </Skeleton>
      <div className="flex gap-2">
        <Button intent="outline" size="xs" onPress={() => setDialog("keys")}>
          <IconKey />
          Keys
        </Button>
        <Button intent="outline" size="xs" onPress={() => setDialog("settings")}>
          <IconSettings />
          Settings
        </Button>
      </div>
      <AppKeysDialog app={app} isOpen={dialog === "keys"} onOpenChange={() => setDialog(null)} />
      <AppSettingsDialog
        app={app}
        isOpen={dialog === "settings"}
        onOpenChange={() => setDialog(null)}
        onDeleted={onDeleted}
      />
    </section>
  );
}

/** The app's pipes: who owns each, its state and last request, and a menu to stop or delete it. */
function Pipes({ app, tunnels }: { app: string; tunnels: AppTunnel[] }) {
  const now = useNow();
  const end = useEndTunnel(app);

  if (tunnels.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No pipes yet. Your backend opens them with a key.
      </p>
    );
  }

  const shown = [...tunnels].sort(byActivity).slice(0, PIPES_SHOWN);

  return (
    <section aria-label="Pipes" className="flex flex-col gap-1">
      <ul className="flex flex-col divide-y divide-border">
        {shown.map((tunnel) => {
          const last = ago(tunnel.session?.lastRequestAt ?? null, now);
          const pending = end.isPending && end.variables?.tunnel === tunnel.id;

          return (
            <li key={tunnel.id} className="flex items-center justify-between gap-3 py-2">
              <div className="flex min-w-0 flex-col">
                <span
                  className="truncate text-xs text-foreground"
                  title={`${tunnel.tenant} · ${tunnel.owner}`}
                >
                  {tunnel.tenant} · {tunnel.owner}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {[STATE[tunnel.state], last && `last request ${last}`]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <MenuTrigger>
                <Button
                  intent="plain"
                  size="sq-xs"
                  isPending={pending}
                  aria-label={`Actions for ${tunnel.tenant} · ${tunnel.owner}`}
                >
                  <IconEllipsis />
                </Button>
                <Menu
                  placement="bottom end"
                  onAction={(key) =>
                    end.mutate({ tunnel: tunnel.id, how: key === "stop" ? "stop" : "delete" })
                  }
                >
                  {(tunnel.state === "live" || tunnel.state === "away") && (
                    <MenuItem id="stop">
                      <IconCircleStop />
                      <MenuLabel>Stop</MenuLabel>
                    </MenuItem>
                  )}
                  <MenuItem id="delete" intent="danger">
                    <IconTrash />
                    <MenuLabel>Delete for good</MenuLabel>
                  </MenuItem>
                </Menu>
              </MenuTrigger>
            </li>
          );
        })}
      </ul>
      {tunnels.length > shown.length && (
        <span className="text-xs text-muted-foreground tabular-nums">
          +{tunnels.length - shown.length} more
        </span>
      )}
    </section>
  );
}
