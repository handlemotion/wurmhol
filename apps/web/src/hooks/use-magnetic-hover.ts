// Transitive's magnetic hover (`packages/ui/src/hooks/use-fluid-hover.ts`): one fill that springs
// between a list's rows. While the pointer is over the list the row under it wins, else the
// nearest one, so the gaps between rows never blink the fill off. Rows paint no fill of their own.
//
//   const hover = useMagneticHover({ itemSelector: "[role='menuitem']" });
//   <div className="relative" {...hover.containerProps}>
//     <FluidHoverHighlight {...hover.highlightProps} />
//     {rows}
//   </div>
//
// The keyboard leads once a key is pressed (React Aria moves focus between rows), until the
// pointer moves again.
import { useCallback, useEffect, useRef, useState } from "react";

/** A row's box in the container's padding-box coordinates. */
export interface ItemRect {
  top: number;
  height: number;
  left: number;
  width: number;
}

/** Rows the pointer never lights. */
const SKIP = "[data-disabled]:not([data-disabled='false']), [aria-disabled='true']";

/** Controls between the rows keep their own clicks. */
const CONTROL = "input, textarea, select, button, a, [role='button']";

/** A row's box in the container's layout space: offsets, so a parent mid scale-in reads true. */
function measure(row: HTMLElement, container: HTMLElement): ItemRect {
  let top = row.offsetTop;
  let left = row.offsetLeft;
  let parent = row.offsetParent;

  while (parent instanceof HTMLElement && parent !== container && container.contains(parent)) {
    top += parent.offsetTop + parent.clientTop;
    left += parent.offsetLeft + parent.clientLeft;
    parent = parent.offsetParent;
  }

  // A scroller between the row and the container (a long menu) moves the row up.
  for (let el = row.parentElement; el && el !== container; el = el.parentElement) {
    top -= el.scrollTop;
    left -= el.scrollLeft;
  }

  return { top, left, width: row.offsetWidth, height: row.offsetHeight };
}

export function useMagneticHover({
  itemSelector,
  maxDistance = 12,
}: {
  /** Matches the rows inside the container. */
  itemSelector: string;
  /** How far outside every row the pointer may be and still light the nearest (the list's
   *  padding, a separator). Past it nothing is lit, so a header never promises a row. */
  maxDistance?: number;
}) {
  const containerRef = useRef<HTMLElement | null>(null);
  const [lit, setLit] = useState<{ element: HTMLElement; rect: ItemRect } | null>(null);
  const litRef = useRef(lit);
  litRef.current = lit;
  const [session, setSession] = useState(0);
  const frame = useRef<number | null>(null);

  const light = useCallback((element: HTMLElement | null) => {
    const container = containerRef.current;
    const rect = element && container ? measure(element, container) : null;
    const prev = litRef.current;

    if (!element || !rect) {
      if (prev) setLit(null);

      return;
    }

    if (
      prev?.element === element &&
      prev.rect.top === rect.top &&
      prev.rect.left === rect.left &&
      prev.rect.width === rect.width &&
      prev.rect.height === rect.height
    ) {
      return;
    }

    setLit({ element, rect });
  }, []);

  const pick = useCallback(
    (clientX: number, clientY: number) => {
      const container = containerRef.current;

      if (!container) return;
      const box = container.getBoundingClientRect();
      const scaleX = container.offsetWidth ? box.width / container.offsetWidth : 1;
      const scaleY = container.offsetHeight ? box.height / container.offsetHeight : 1;
      const x = (clientX - box.left) / scaleX - container.clientLeft;
      const y = (clientY - box.top) / scaleY - container.clientTop;
      let best: HTMLElement | null = null;
      let bestDistance = Infinity;

      for (const row of container.querySelectorAll<HTMLElement>(itemSelector)) {
        if (row.matches(SKIP)) continue;
        const r = measure(row, container);
        const dx = Math.max(r.left - x, 0, x - (r.left + r.width));
        const dy = Math.max(r.top - y, 0, y - (r.top + r.height));
        const distance = Math.hypot(dx, dy);

        if (distance < bestDistance) {
          best = row;
          bestDistance = distance;

          if (distance === 0) break;
        }
      }

      light(bestDistance <= maxDistance ? best : null);
    },
    [itemSelector, light, maxDistance],
  );

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  // A list opened from the keyboard starts with its focused row lit.
  const ref = useCallback(
    (element: HTMLElement | null) => {
      containerRef.current = element;

      if (!element) return;
      requestAnimationFrame(() => {
        const focused = element.querySelector<HTMLElement>(
          `:is(${itemSelector})[data-focus-visible]`,
        );

        if (focused && !litRef.current) light(focused);
      });
    },
    [itemSelector, light],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const { clientX, clientY } = event;

      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        pick(clientX, clientY);
      });
    },
    [pick],
  );

  // A fresh visit fades in on its row instead of sliding over from where the last one ended.
  const onPointerEnter = useCallback((event: React.PointerEvent) => {
    if (event.pointerType === "mouse" && !litRef.current) setSession((s) => s + 1);
  }, []);

  const onPointerLeave = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    light(null);
  }, [light]);

  // Keys move React Aria's focus; the fill follows it.
  const onKeyDown = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;

      const focused = containerRef.current?.querySelector<HTMLElement>(
        `:is(${itemSelector})[data-focused]`,
      );

      if (focused) light(focused);
    });
  }, [itemSelector, light]);

  // What is lit is what a click hits: a click in a gap lands on the lit row.
  const onClick = useCallback(
    (event: React.MouseEvent) => {
      const target = event.target;

      if (
        !(target instanceof Element) ||
        !target.isConnected ||
        target.closest(itemSelector) ||
        target.closest(CONTROL)
      ) {
        return;
      }

      litRef.current?.element.click();
    },
    [itemSelector],
  );

  return {
    /** The lit row, for styling the fill by row (a destructive item). */
    activeElement: lit?.element ?? null,
    highlightProps: { rect: lit?.rect ?? null, session },
    containerProps: { ref, onPointerMove, onPointerEnter, onPointerLeave, onKeyDown, onClick },
  };
}
