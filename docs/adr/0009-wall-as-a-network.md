# 0009: The wall is a network of pipes, under a floating header

Status: accepted. Departs from spec v1, section 3 ("Main page: the shares wall" and "Header
menu").

## Context

Spec section 3 describes the wall as an Are.na grid: same-size cards with a thin border, each
opening its share in a new tab, a Terminate button in the corner, and a full-width header bar.
That grid says nothing about how pipes relate to the one thing every pipe starts from (the
command), and it gives every card the same weight whether you're looking at it or not.

## Decision

- **The wall is a network.** The `npx wurmhol <port>` command, in a `CopyField`, is the anchor at
  the centre. Each open pipe is a sharp, grey pill (its mark, its title or pipe id, its port) on
  a hairline spoke from the anchor. Pills drift by a few pixels so the network reads as alive;
  under reduced motion they hold still. A new pipe comes out of the anchor.
- **Pressing a pill opens it in place.** The pill becomes a card with a `primary` border in the
  middle, the anchor just above it, and the other pills move around them to make room. The card
  holds what a pipe has: its URL (`CopyField`), port, status, who started it, when, the last
  request, its viewers, plus Open and Terminate. It has no close button: a press anywhere
  outside it, or Escape, closes it, and focus goes back to the pill.
- **No drop shadows** on pills or the card: border only, like the rest of the sharp look. Nodes
  sit on whole device pixels while they drift, so their 1px edges never smear into a double line.
- **The header floats.** No bar: sharp `secondary` pills sit 16px from the top and the sides.
  The org switcher on the left, Members, Tokens and Billing grouped in the middle, Log out on
  the right. On a phone, the middle and right fold into one menu.
- The empty state is the anchor alone with its one line above it.

Layout is a pure function (`apps/web/src/components/wall/constellation-layout.ts`); one frame
loop eases nodes to it and redraws the spokes from the same positions
(`constellation.tsx`), so React renders only when the data changes.

## Consequences

- Clicking a pipe no longer opens the share: that moved to the card's Open button (and the URL
  field copies it). One more press to visit, in exchange for seeing a pipe's details on the wall.
- Terminate moved from the card corner into the open card.
- The org cap (5 open pipes) keeps the ring small; the layout still grows the ring and stretches
  it downward on narrow screens if that ever changes.
