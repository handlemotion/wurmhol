import { LazyMotion } from "motion/react";
import { useState } from "react";
import { Skeleton } from "skullet/react";
import { Button } from "@/components/ui/button";
import { SkeletonProvider } from "@/components/ui/skeleton-provider";
import { Text } from "@/components/ui/text";
import { useMe, useOpenBilling, useWall } from "@/hooks/use-app";
import { type Me, type Share, toLogin } from "@/lib/api";
import { Header, type WallDialog } from "./header";
import { MembersDialog } from "./members-dialog";
import { Network } from "./network";
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
  source: null,
  preview: null,
}));

// Motion's animation code (the menus' hover highlight) loads after the wall's first paint, off
// the startup path, and long before anyone opens a menu.
const motionFeatures = () => import("@/lib/motion-features").then((m) => m.default);

/** The main page: every open pipe of the active org, live, as one network (ADR 0011). */
export function Wall({ me }: { me: Me }) {
  const shares = useWall(me.activeOrgId);
  const [dialog, setDialog] = useState<WallDialog | null>(null);

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
