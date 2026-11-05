# 0017: The empty wall is a drawing, not a line of text

Status: accepted. Departs from ADR 0011 ("The empty state is the anchor alone with its one line
above it") and spec v1, section 3 ("Empty state: one line plus the command").

## Context

The empty wall was the Create pipe button with "No open pipes yet." above it, on a blank page.
The line restated what the blank page already showed, and the page had none of the brand's
network drawing that the login carries.

## Decision

- **No line of text.** The empty wall is the Create pipe button over a backdrop. Screen readers
  still hear "No open pipes yet." (visually hidden).
- **The backdrop is a net of confocal conics** in the network style (`network-create` skill,
  `scenes/flat/wall.mjs`, generated into `apps/web/src/components/wall/wall-plate.tsx`). Its two
  foci are tagged `container` and `browser`, the two places a pipe joins, and the button sits at
  the centre, on the line between them. The innermost ellipse is a hole the open Create pipe
  card fits inside, so nothing is drawn under the card.
- **Quiet.** One hairline ink (`text-hairline-line`), no accent, no motion beyond a fade in.
- **Anchored to the button.** The constellation places the drawing at the anchor's position each
  frame, without the anchor's drift, so the hole stays around the button at any width.
- **Only while the wall is empty.** Once a pipe is open, its own pills and spokes are the
  network. The drawing in the same ink behind them blurs the spokes, and its tags collide with
  the pills.

## Consequences

- Showing the backdrop with pipes open too is a one-line change in `wall.tsx` (the `backdrop`
  prop's condition), if the drawing is reworked to keep clear of the ring of pills.
