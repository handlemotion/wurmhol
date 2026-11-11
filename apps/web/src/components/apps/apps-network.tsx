import { useEffect, useRef, useState } from "react";
import { IconPlus } from "@/components/icons/lucide";
import { Button } from "@/components/ui/button";
import type { App } from "@/lib/api";
import { Constellation } from "../wall/constellation";
import { ANCHOR } from "../wall/constellation-layout";
import { Swap } from "../wall/network";
import { AppCard, AppPill } from "./app-card";
import { CreateAppCard } from "./create-app-card";

/**
 * The org's embedded applications (ADR 0032) as the wall shows pipes: a pill per app on a spoke
 * from New app, each opening into a card with its pipes, keys and settings. One open at a time;
 * Escape or a press outside closes it.
 */
export function AppsNetwork({ apps }: { apps: App[] }) {
  const [open, setOpen] = useState<string | null>(null);
  // A new app's card opens once the list has it.
  const [created, setCreated] = useState<string | null>(null);
  useEffect(() => {
    if (!created || !apps.some((app) => app.id === created)) return;
    setCreated(null);
    setOpen(created);
  }, [created, apps]);
  const current = open === ANCHOR || apps.some((app) => app.id === open) ? open : null;
  const restore = useRef<string | null>(null);

  const close = () => {
    restore.current = current;
    setOpen(null);
  };
  const onClosed = () => {
    const id = restore.current;
    restore.current = null;
    if (!id) return;
    const selector = id === ANCHOR ? "[data-create-app]" : `[data-app="${CSS.escape(id)}"]`;
    // As on the wall: the pill mounts once the card's exit completes.
    const focus = (frames: number) => {
      const pill = [...document.querySelectorAll<HTMLElement>(selector)].find(
        (el) => !el.closest("[inert]"),
      );
      if (pill) pill.focus();
      else if (frames > 0) requestAnimationFrame(() => focus(frames - 1));
    };
    focus(10);
  };

  useEffect(() => {
    if (!current) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    const onPress = (event: PointerEvent) => {
      const target = event.target as Element;
      const keep = "[data-open], [data-app], [data-create-app], [role=dialog], [role=menu]";
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
          {apps.length === 0 && <span className="sr-only">No apps yet.</span>}
          <Swap
            open={current === ANCHOR}
            edge="border-border"
            onClosed={onClosed}
            card={<CreateAppCard onCreated={setCreated} />}
            pill={
              <Button
                intent="secondary"
                data-create-app
                aria-expanded={false}
                onPress={() => setOpen(ANCHOR)}
              >
                <IconPlus />
                New app
              </Button>
            }
          />
        </div>
      }
      nodes={apps.map((app) => ({
        id: app.id,
        render: (
          <Swap
            open={app.id === current}
            edge="border-primary"
            onClosed={onClosed}
            card={<AppCard app={app} onDeleted={() => setOpen(null)} />}
            pill={<AppPill app={app} onPress={() => setOpen(app.id)} />}
          />
        ),
      }))}
    />
  );
}
