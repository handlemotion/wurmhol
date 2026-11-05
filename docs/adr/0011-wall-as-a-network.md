# 0011: The wall is a network of pipes, under a floating header

Status: accepted. Departs from spec v1, section 3 ("Main page: the shares wall" and "Header
menu").

## Context

Spec section 3 describes the wall as an Are.na grid: same-size cards with a thin border, each
opening its share in a new tab, a Terminate button in the corner, and a full-width header bar.
That grid says nothing about how pipes relate to the one thing every pipe starts from (the
command), and it gives every card the same weight whether you're looking at it or not.

## Decision

- **The wall is a network.** A **Create pipe** button is the anchor at the centre. Pressed, it
  opens into a fixed 288px square card: a list of ways to start one, each copied in one press
  (a prompt to paste to an agent, the `npx wurmhol <port>` command, and `npx wurmhol login`
  first for this machine). The square leaves room for more. Each open pipe is a sharp, grey pill (its mark, its title or pipe id, its port) on
  a hairline spoke from the anchor. Pills drift by a few pixels so the network reads as alive;
  under reduced motion they hold still. A new pipe comes out of the anchor.
- **Pressing a pill opens it in place.** The pill grows into a card with a `primary` border
  where it stands, away from the anchor (its corner nearest the anchor stays put), and shrinks
  back on close; both are fast springs. Only the pills it would cover step aside, keeping 32px
  clear of it; the rest hold still. A camera pans the whole network until the card sits in the
  middle of the view, then back on close, and pills it pans under the floating header fade out
  there. Create pipe opens the same way, from the centre. The card
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
- The org cap (5 open pipes) keeps the ring small; the layout still grows the ring if that ever
  changes. Where the ring won't fit the width (a phone), the pipes stand in a column above and
  below the hub instead, arranged so their spokes clear the other pills.
