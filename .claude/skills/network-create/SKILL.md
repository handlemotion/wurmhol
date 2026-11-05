---
name: network-create
description: Generates Wurmhol's brand graphics in the network style - flat construction drawings (circles, axes, frames and rays laid out by proportion, with square nodes exactly where shapes meet), plus a 3D wireframe mode for depth plates - rendered to clean SVG and PNG by scripts and held to the style by a checker. Use whenever you make or change an illustration, hero, backdrop, empty state, diagram, icon or mark for the app, the marketing site or docs, or when asked for brand graphics in "the network style".
---

# Network graphics

Wurmhol's graphics are construction drawings of a network around one pivot, the hole. They read
like architecture: proportion, axes and exact intersections. Everything is generated from a
scene file, never drawn by hand, so a graphic is exact, reproducible and editable by changing
numbers.

## The style

- **Flat first.** 2D construction geometry: circles, axes, frames, rays and tangents. The 3D mode
  (below) is for the rare plate that needs depth.
- **Nodes only where shapes meet.** A node marks a computed point: an axis crossing a circle,
  two circles crossing, a tangent point, a diagonal's crossing, a centre of similitude. Never a
  point placed by eye. `meet.*` computes them exactly.
- **Proportion, not taste.** Radii, offsets and frames come from a ratio (φ, √2, √3) or the
  module `u` (a fraction of the short side). Node sizes come from `u` too, in two or three steps.
- **One stroke.** One color, one width (1px). Hierarchy comes only from solid (structure), dashed
  (construction) and dotted lines. No gray levels, opacity, gradients, shadows or blur.
- **Square nodes, mono tags.** Filled squares for nodes (a dot for the pivot or a crossing),
  mono labels, and `tag` readouts (swatch plus value) for the few names that matter: `container`,
  `browser`, `:5173`, a `*.wurmhol.dev` host. No real tokens or user data.
- **One accent, one pivot.** The brand `primary` marks the single thing the plate is about, plus
  at most the one line or tag tied to it.
- **Complete and balanced.** A plate fills its frame: outer layers run past the edge, so it reads
  as part of a larger drawing. The ink's centre of mass sits near the frame's centre. Two shapes
  and a line is not a plate.

## Tools

Everything is in `scripts/` and needs only Node (PNG output uses the pre-installed Playwright).

| File         | What it does                                                                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flat.mjs`   | `plate()`: `line`, `ray`, `circle`, `arc`, `ellipse`, `poly`, `frame`, `ticks`, `cross`, `dimension`, `node`, `label`, `fan`, `transpose`; `meet` (intersections, tangents, circle inversion); `best` |
| `engine.mjs` | 3D mode: scene, camera, depth-buffer hidden lines (curves dash exactly where a surface hides them)                                                                                                    |
| `prims.mjs`  | 3D geometry: `throat`, `sphere`, `cluster`, `sheet`, `torus`, `arc`, `ticks`, `field`; also `connect` (MST + kNN)                                                                                     |
| `render.mjs` | Scene files to SVG, PNG at 2x, light and dark, `--ink currentColor`, a contact sheet                                                                                                                  |
| `check.mjs`  | Fails a plate that is thick, off-palette, incomplete (under 85% coverage) or unbalanced (centre over 7% off)                                                                                          |

`best(build, { seed, tries })` is the generative step. It builds `tries` candidates from seeded
randomness and keeps the most balanced one that fills the frame. Put the variation (offsets,
which step of a scale, which crossings get nodes) in `build`, and let the search choose.

`render.mjs` flags worth knowing: `--seeds n` renders seeds 1..n of each scene side by side, so
you pick a variant instead of guessing. `--tsx Name` writes a React component of the plate.
`--ink currentColor --accent "var(--primary)" --paper none` makes it follow the app's theme.

## Workflow

1. **Concept first.** In one sentence: what construction, where the pivot is, and which two
   places it links. Start from the nearest scene in `scenes/flat/`.
2. **Write the scene** (`scenes/flat/<name>.mjs`, or beside where the graphic ships):

   ```js
   import { best, meet, PHI, plate } from "../../scripts/flat.mjs";

   export default (o) =>
     best(
       (rnd) => {
         const p = plate({
           width: o.width,
           height: o.height,
           style: { ink: o.ink, accent: o.accent, stroke: o.stroke, paper: o.paper },
         });
         const u = Math.min(o.width, o.height) / 24;
         const y = o.height / 2;
         const r = o.height * (0.3 + rnd() * 0.04);
         const a = [o.width / 2 - r / 2, y];
         const b = [o.width / 2 + r / 2, y];
         p.ray([0, y], [o.width, y])
           .circle(a, r)
           .circle(b, r)
           .circle(a, r * PHI, { dashed: true });
         const [t0, t1] = meet.circles(a, r, b, r);
         p.line(t0, t1, { accent: true })
           .node(t0, { size: u * 0.5 })
           .node(t1, { size: u * 0.5 });
         return p;
       },
       { seed: o.seed },
     );
   ```

3. **Render and look**, both themes, at 2x (flat plates are usually 1600x1000):

   ```bash
   node .claude/skills/network-create/scripts/render.mjs .claude/skills/network-create/scenes/flat/*.mjs --size 1600x1000 --theme both --out /tmp/net --sheet
   ```

   Judge each plate: is every node on a real crossing, does it fill the frame, is the pivot the
   one thing you see first, is anything tangled where lines converge?

4. **Check** every SVG you ship, and fix what it reports:

   ```bash
   node .claude/skills/network-create/scripts/check.mjs /tmp/net/*.svg
   ```

5. **Ship.** Into the app as a generated component, never hand-edited:

   ```bash
   node .claude/skills/network-create/scripts/render.mjs .claude/skills/network-create/scenes/flat/backdrop.mjs --size 1600x1000 --ink currentColor --accent "var(--primary)" --paper none --tsx WormholeLandscape --out /tmp/ship
   ```

   Copy `/tmp/ship/backdrop.tsx` into place. The caller's text class sets the ink
   (`text-hairline-line` for a quiet backdrop). Check it on the real stack in both themes and
   at phone width.

   **A backdrop is designed around the layout, not thrown behind it.** The thing on the page
   (a form, a panel) must sit inside a shape of the construction (a hole, a frame), with the
   drawing built outward from it. Never cover the drawing with a fill or fade it out to make
   room. `plate({ origin })` draws in that element's coordinates, and `--tsx` emits the SVG
   unscaled, offset so (0, 0) lands on its positioned parent. Anchor at a point CSS can place
   exactly at any size (the column's centre, `top-1/2 left-1/2`), not at a child whose position
   depends on content. The login (`apps/web/src/components/auth/wormhole*.tsx`, scene
   `backdrop`) puts the form in the hole of a Steiner chain. `void()` is the fallback for text
   that can't sit inside a shape.

   Check an anchored plate through real viewports with `check.mjs --frame x,y,w,h` (the window
   a screen shows, in the plate's coordinates), then on the real stack at 1440, 1024 and 390.

   **Favicon** (`favicon`): named candidates (`lens`, `holding`, `chain`, `flower`, `bezel`,
   `tangents`, `tunnel`, `spiral`, `portal`, `graph`, `funnel`), each one construction cut to
   what survives at 16px; `SHIPPED` names the live one (`--set name=tangents --set tile=on
   --stroke 0.75`: black on a white tile, barely rounded, the same on every tab bar). Render one with `--set name=<name>`, all
   with `--seeds 11`. On a 32px grid. `--stroke 1` with
   `scaleStroke` (a hairline at any size) and `scheme` (inks switch with the viewer's color
   scheme inside the file). Copy it to `apps/web/public/` and `apps/site/public/`. Preview it at
   16, 32, 64 and 128px on light and dark before shipping; drop any mark that vanishes at 16.

## Constructions that work

- **Apollonian circles** (`apollonian`): two limit points are the two places. One family of
  circles passes through both, the other closes around each, and they cross at right angles.
- **Common tangents** (`tangents`): a small and a large circle. The inner tangents cross at the
  internal centre of similitude, which is the pivot.
- **Vesica chain** (`vesica`): equal circles through each other's centres. Lenses stand √3·r
  tall, and the middle chord is the link.
- **One-point perspective** (`corridor`): frames shrinking by 1/φ to a vanishing point, which is
  the pivot. Floor and ceiling lines on a modular step, starting at a frame, not the point.
- **Golden subdivision** (`frames`): squares cut off a φ rectangle, quarter arcs for the spiral.
  The eye is exactly where the two diagonals cross.
- **Readout graph** (`readout`): tagged nodes on a grid, MST plus crossing edges, construction
  crosses on the grid.
- **System loop** (`orbits`): places as circles, the request as the accent arc with arrowheads,
  steps as labelled nodes.

- **Steiner chain** (`steiner`): a ring of mutually tangent circles between two others, built
  concentric, then inverted through a point in the hole so it crowds to one side. Inversion
  keeps every tangency exact.
- **Confocal conics** (`confocal`): ellipses and hyperbolas sharing two foci (the two places),
  crossing at right angles; nodes on elliptic-coordinate crossings.
- **Portal elevation** (`portal`): a round arch on φ proportions, with regulating circle,
  diagonals, voussoir joints and dimension lines in modules. The keystone is the pivot.
- **Polar instrument** (`polar`): rings on a √2 scale, spokes every 15°, a hatched bezel, and
  routes that hop between grid crossings into the centre.
- **Backdrop** (`backdrop`): the login. The form sits in a 260px hole, ringed by an eccentric
  Steiner chain that is tight on the form's left and opens into the page on its right; the hole's
  rim is the accent.

- **Wall** (`wall`): the empty wall. Confocal conics centred on the Create pipe button, foci
  tagged `container` and `browser`; the innermost ellipse is the hole the open Create pipe card
  fits in, and the hyperbolas start at its rim.

When lines converge on a point, stop them short of it (as `corridor` does). A fan of 20 lines
into one pixel reads as a smudge.

## Depth mode (3D)

`engine.mjs` and `prims.mjs` draw wireframe plates with true hidden lines: node globes,
throats, spacetime sheets. Scenes are in `scenes/*.mjs` (`globe` is the reference plate). Use
them where depth carries the idea. Dense meshes read best with `hidden: "none"`; sparse ones
dashed. The checker and the rules above apply unchanged.
