import { useState } from "react";
import {
  IconBlocks,
  IconChevronsUpDown,
  IconCreditCard,
  IconEllipsis,
  IconGlobe,
  IconKey,
  IconLogOut,
  IconPlus,
  IconSettings,
  IconTrash,
  IconUsers,
  IconWaypoints,
} from "@/components/icons/lucide";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuDescription,
  MenuItem,
  MenuLabel,
  MenuSection,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import {
  useAppConfig,
  useOpenBilling,
  usePrefetchDialogs,
  useSignOut,
  useSwitchOrg,
} from "@/hooks/use-app";
import type { Me } from "@/lib/api";
import { initials } from "@/lib/initials";
import { type OrgAction, OrgDialog } from "./org-dialogs";

/** The org's dialogs the header opens over the wall. */
export type WallDialog = "members" | "tokens" | "domains";

/** What the page shows: the org's pipes, or its embedded apps (ADR 0032). */
export type WallView = "pipes" | "apps";

/** What the switcher offers: anyone starts an org or opens its settings; owners delete it. */
const ORG_ACTIONS = [
  { id: "create", label: "New org", Icon: IconPlus },
  { id: "settings", label: "Org settings", Icon: IconSettings },
] as const;

const DELETE = { id: "delete", label: "Delete org", Icon: IconTrash } as const;

/** The same entries as buttons in the header's middle, and in the phone's menu. */
function useWallLinks(
  me: Me,
  view: WallView,
  onView: (view: WallView) => void,
  onOpen: (dialog: WallDialog) => void,
) {
  const billing = useOpenBilling();
  const customDomains = useAppConfig().data?.customDomains ?? false;
  // Owners manage a plan they have in Stripe's portal. Without one, the wall offers the plans;
  // with billing off (self-hosted) there is nothing to open.
  const canBill = me.role === "owner" && me.standing?.reason === "subscribed";

  return [
    // An owner of an org that may have apps moves between its pipes and its apps.
    ...(me.apps
      ? [
          view === "apps"
            ? { id: "pipes", label: "Pipes", Icon: IconWaypoints, onPress: () => onView("pipes") }
            : { id: "apps", label: "Apps", Icon: IconBlocks, onPress: () => onView("apps") },
        ]
      : []),
    { id: "members", label: "Members", Icon: IconUsers, onPress: () => onOpen("members") },
    { id: "tokens", label: "Tokens", Icon: IconKey, onPress: () => onOpen("tokens") },
    ...(customDomains
      ? [{ id: "domains", label: "Domains", Icon: IconGlobe, onPress: () => onOpen("domains") }]
      : []),
    ...(canBill
      ? [
          {
            id: "billing",
            label: "Billing",
            Icon: IconCreditCard,
            onPress: () => billing.mutate(undefined),
            isPending: billing.isPending,
          },
        ]
      : []),
  ];
}

/**
 * The header floats: sharp pills over the canvas, no bar behind them. The org on the left, the
 * org's dialogs in the middle, logging out on the right. On a phone the middle and right fold
 * into one menu. The same 16px above the pills as beside them, so the row sits balanced.
 */
export function Header({
  me,
  onOpen,
  view,
  onView,
  fade,
}: {
  me: Me;
  onOpen: (dialog: WallDialog) => void;
  view: WallView;
  /** Apps turns into Pipes while the apps show, and back. */
  onView: (view: WallView) => void;
  /** Off on the empty wall: no pill can pan under the header, and the backdrop runs on to the top. */
  fade: boolean;
}) {
  const switchOrg = useSwitchOrg();
  const signOut = useSignOut();
  const prefetchDialogs = usePrefetchDialogs();
  const active = me.orgs.find((org) => org.id === me.activeOrgId);
  const [orgAction, setOrgAction] = useState<OrgAction | null>(null);
  const owner = me.role === "owner";
  const links = useWallLinks(me, view, onView, onOpen);

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
            const action = [...ORG_ACTIONS, DELETE].find((a) => a.id === key);

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
            {ORG_ACTIONS.flatMap(({ id, label, Icon }) =>
              active || id === "create"
                ? [
                    <MenuItem key={id} id={id}>
                      <Icon />
                      <MenuLabel>{label}</MenuLabel>
                    </MenuItem>,
                  ]
                : [],
            )}
          </MenuSection>
          {active && owner && <MenuSeparator />}
          {active && owner && (
            <MenuSection aria-label={`Delete ${active.name}`}>
              <MenuItem id={DELETE.id} intent="danger">
                <DELETE.Icon />
                <MenuLabel>{DELETE.label}</MenuLabel>
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
        {links.map(({ id, label, Icon, onPress, isPending }) => (
          <Button key={id} intent="secondary" isPending={isPending} onPress={onPress}>
            <Icon />
            {label}
          </Button>
        ))}
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
          {links.map(({ id, label, Icon, onPress }) => (
            <MenuItem key={id} onAction={onPress}>
              <Icon />
              <MenuLabel>{label}</MenuLabel>
            </MenuItem>
          ))}
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
