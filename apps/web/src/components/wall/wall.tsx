import { LazyMotion } from "motion/react";
import { useEffect, useState } from "react";
import { Skeleton } from "skullet/react";
import { Button } from "@/components/ui/button";
import { SkeletonProvider } from "@/components/ui/skeleton-provider";
import { Text } from "@/components/ui/text";
import { useMe, useOpenBilling, useWall } from "@/hooks/use-app";
import { useApps } from "@/hooks/use-apps";
import { newShareCard, type ShareCard } from "@wurmhol/protocol";
import { type App, type Me, toLogin } from "@/lib/api";
import { AppsNetwork } from "../apps/apps-network";
import { Header, type WallDialog, type WallView } from "./header";
import { MembersDialog } from "./members-dialog";
import { Network } from "./network";
import { DomainsDialog } from "./domains-dialog";
import { TokensDialog } from "./tokens-dialog";

const SAMPLE: ShareCard[] = [1, 2, 3].map((n) =>
  newShareCard({
    id: `sample${n}`,
    url: "https://sample.wurmhol.dev",
    port: 5173,
    startedBy: "Someone",
    startedAt: 0,
    title: "A dev server",
  }),
);

// Motion's animation code (the menus' hover highlight) loads after the wall's first paint, off
// the startup path, and long before anyone opens a menu.
const motionFeatures = () => import("@/lib/motion-features").then((m) => m.default);

const SAMPLE_APPS: App[] = [1, 2].map((n) => ({
  id: `sample${n}`,
  name: "An app",
  launchUrl: null,
  allowedOrigins: [],
  monthlyRequests: null,
  activeTunnels: null,
  tenantMonthlyRequests: null,
  tenantActiveTunnels: null,
  createdAt: "",
  usage: { requests: 0, openTunnels: 0 },
}));

/** `/apps` shows the org's embedded apps (ADR 0032), for an owner who may manage them. */
function useView(me: Me): [WallView, (view: WallView) => void] {
  const [view, setView] = useState<WallView>(() =>
    location.pathname === "/apps" ? "apps" : "pipes",
  );

  // Back and forward move between the two, as the address bar shows.
  useEffect(() => {
    const onPop = () => setView(location.pathname === "/apps" ? "apps" : "pipes");
    addEventListener("popstate", onPop);

    return () => removeEventListener("popstate", onPop);
  }, []);

  const go = (next: WallView) => {
    history.pushState(null, "", next === "apps" ? "/apps" : "/");
    setView(next);
  };

  // An org (or a role) without apps shows its pipes, wherever the address points.
  return [me.apps ? view : "pipes", go];
}

/**
 * The main page: every open pipe of the active org, live, as one network (ADR 0011), or, for an
 * owner of an org on Business, its embedded apps in the same shape.
 */
export function Wall({ me }: { me: Me }) {
  const [view, setView] = useView(me);
  const shares = useWall(me.activeOrgId);
  const apps = useApps(view === "apps");
  const [dialog, setDialog] = useState<WallDialog | null>(null);

  return (
    // Clipped at the page's edges, not the canvas's: a network the camera pans runs on under the
    // floating header and off the sides of the window, never against an invisible box.
    <div className="min-h-dvh overflow-clip bg-background">
      <Header
        me={me}
        onOpen={setDialog}
        view={view}
        onView={setView}
        fade={view === "apps" ? apps.data?.apps.length !== 0 : shares?.length !== 0}
      />
      <main className="w-full px-4 sm:px-8">
        {me.standing && !me.standing.ok && <NeedsPlan owner={me.role === "owner"} />}
        {view === "apps" ? (
          <Skeleton id="apps" data={apps.data?.apps} sample={SAMPLE_APPS} label="Loading apps">
            {(list) => <AppsNetwork apps={list} />}
          </Skeleton>
        ) : (
          <Skeleton id="wall" data={shares} sample={SAMPLE} label="Loading pipes">
            {(list) => <Network shares={list} />}
          </Skeleton>
        )}
      </main>
      <MembersDialog me={me} isOpen={dialog === "members"} onOpenChange={() => setDialog(null)} />
      <TokensDialog isOpen={dialog === "tokens"} onOpenChange={() => setDialog(null)} />
      <DomainsDialog isOpen={dialog === "domains"} onOpenChange={() => setDialog(null)} />
    </div>
  );
}

/** No plan yet (ADR 0027): pipes refuse to start until an owner starts a trial of a plan. */
function NeedsPlan({ owner }: { owner: boolean }) {
  const billing = useOpenBilling();
  const pending = billing.isPending ? billing.variables : undefined;

  return (
    <div className="mx-auto mt-4 flex max-w-xl flex-wrap items-center justify-between gap-3 border border-border p-5">
      <Text>
        {owner
          ? "Start a 14-day trial to open pipes. Friends is for sharing with people, Business grows with your usage."
          : "Pipes start once an owner of this org starts a trial."}
      </Text>
      {owner && (
        <div className="flex gap-3">
          <Button
            intent="outline"
            isPending={pending === "friends"}
            isDisabled={billing.isPending}
            onPress={() => billing.mutate("friends")}
          >
            Friends
          </Button>
          <Button
            isPending={pending === "business"}
            isDisabled={billing.isPending}
            onPress={() => billing.mutate("business")}
          >
            Business
          </Button>
        </div>
      )}
    </div>
  );
}

export function WallPage() {
  const me = useMe();

  if (me.isError) {
    toLogin();

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
