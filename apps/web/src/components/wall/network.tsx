import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { cn } from "cn";
import { useEffect, useRef, useState } from "react";
import { IconPlus } from "@/components/icons/lucide";
import { Button } from "@/components/ui/button";
import type { Share } from "@/lib/api";
import { Constellation } from "./constellation";
import { ANCHOR } from "./constellation-layout";
import { CreateCard } from "./create-card";
import { PipeCard, PipePill } from "./pipe-card";
import { WallPlate } from "./wall-plate";

/**
 * Every pipe as a pill on a spoke from the anchor, the Create pipe button. Pressing a pill opens
 * it into a card with its details; pressing Create pipe opens the ways to start one. One is open
 * at a time; it opens where its pill stands, and the view pans to it while every other pill
 * holds its place.
 */
export function Network({ shares }: { shares: Share[] }) {
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
    document.querySelector<HTMLElement>(selector)?.focus();
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
