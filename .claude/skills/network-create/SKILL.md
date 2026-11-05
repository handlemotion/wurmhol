---
name: network-create
description: Generates Wurmhol's brand graphics, the network style - hairline 3D wireframes of node clusters, beaded curves and the wormhole throat, with true hidden-line removal, rendered to clean SVG and PNG by scripts. Use whenever you make or change an illustration, hero, backdrop, empty state, diagram, icon or mark for the app, the marketing site or docs, or when asked for brand graphics in "the network style".
---

# Network graphics

Wurmhol's graphics are technical plates: networks of nodes drawn as precise wireframes around one
pivot, the hole. Everything is generated from a scene file, never drawn by hand, so a graphic is
exact, reproducible and editable by changing numbers.

## The style

**One stroke.** Every line shares one color and one width (default 1px, `non-scaling-stroke`).
Hierarchy never comes from weight, gray levels or opacity. It comes from three line states only:

| State  | Means                                        | How                        |
| ------ | -------------------------------------------- | -------------------------- |
| Solid  | Structure you can see                        | default                    |
| Dashed | Far side of a surface, or construction lines | `hidden: "dash"`, `dashed` |
| Dotted | Paths, guides, ground                        | `line: false` with beads   |

**Dots mark points.** Nodes, intersections and beads evenly spaced along a curve, one radius.
Under perspective, beads crowd with distance: that is most of the depth.

**One accent, one pivot.** The brand `primary` marks the single thing the plate is about: the
pivot dot at the throat and, at most, the one thread that passes through it. Never two.

**The hole is the pivot.** Compose around a throat, a ring or a well, with networks (node
globes, lattices, arcs) on either side. The product is a link between two places that can't see
each other; the plate says that.

**Depth from geometry, not effects.** Perspective, occlusion and bead density. No gradients,
shadows, blur, glow or fills (the checker rejects them). Generous empty paper.

## Tools

Everything is in `scripts/` and needs only Node (PNG output uses the pre-installed Playwright).

| File         | What it does                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------- |
| `engine.mjs` | Scene, camera (yaw, pitch, roll, perspective, auto-fit), depth-buffer hidden lines, SVG      |
| `prims.mjs`  | Geometry: `throat`, `sphere`, `cluster`, `sheet`, `torus`, `arc`, `ticks`, `field`, `circle` |
| `render.mjs` | Scene files to SVG, PNG at 2x, both themes, and a contact sheet                              |
| `check.mjs`  | Fails an SVG that breaks the style: widths, colors, dot sizes, effects                       |

How hidden lines work: surfaces (`mesh`) rasterize into a depth buffer at output resolution;
each curve is sampled every 1.5px and split into visible and hidden runs against it, short
flickers are merged, and runs are simplified (RDP, 0.08px). So a curve on the back of a globe
dashes exactly where the globe hides it, with no hand masking.

## Workflow

1. **Concept first.** Say in one sentence what the plate shows and where the pivot is. Pick the
   nearest scene in `scenes/` as a starting point.
2. **Write a scene file** (`scenes/<name>.mjs`, or next to where the graphic ships). It
   default-exports `(o) => scene`, passing `o.ink`, `o.accent`, `o.stroke` into `style`:

   ```js
   import { scene } from "../scripts/engine.mjs";
   import { cluster, throat } from "../scripts/prims.mjs";

   export default (o) => {
     const s = scene({
       width: o.width,
       height: o.height,
       camera: { pitch: 16, yaw: 20, perspective: 24 },
       style: { ink: o.ink, accent: o.accent, stroke: o.stroke },
     });
     s.add(throat({ rs: 1, h: 3.2, rings: 12, meridians: 32, beads: 13 }), { hidden: "none" });
     s.add(cluster({ c: [-4, 3.5, 0], r: 1, n: 44, k: 4, shell: 1, seed: o.seed }));
     s.dot([0, 0, 0], { accent: true, hidden: "solid" });
     return s;
   };
   ```

3. **Render and look**, both themes, at 2x:

   ```bash
   node .claude/skills/network-create/scripts/render.mjs .claude/skills/network-create/scenes/*.mjs --out /tmp/net --theme both --sheet
   ```

   Open the PNGs (or `index.html`) and judge them as a plate: one pivot, clear silhouette,
   nothing tangled at the throat, enough empty paper.

4. **Check** every SVG you ship:

   ```bash
   node .claude/skills/network-create/scripts/check.mjs /tmp/net/*.svg
   ```

5. **Ship.** For UI, render with `--ink currentColor` and use the SVG as a component's markup so
   it follows the theme through `text-*` classes; for the quiet backdrop behind forms use
   `--tone quiet`. Commit the scene file beside the SVG so it can be regenerated.

## Choosing parameters

- **Dense meshes hide, sparse diagrams dash.** A throat or sheet with 20+ lines reads cleaner
  with `hidden: "none"`; a construction sphere or a node globe reads better dashed.
- **Node globes:** `cluster({ shell: 1, n: 30–50, k: 4 })` gives an even near-triangulation
  whose links run as great-circle arcs over an occluding hull. `shell < 1` scatters nodes through
  the volume with straight links (no hull), for looser constellations.
- **Perspective:** `perspective` is the camera distance in world units. 14–24 for heroes (beads
  crowd visibly), 0 (orthographic) for diagrams, marks and anything axonometric.
- **Marks and icons:** draw at 256 with `stroke` 10–14 and `dot` near 1.5x the stroke; check at
  16px. Keep to a ring, a few nodes and the pivot.
- **Seeds:** clusters are seeded. Try a few `--seed` values and keep the best one in the scene.

## Scenes

`throat` (the hero: two node globes linked through the throat), `constellation` (many globes,
one hub), `lattice` (a grid network drained by a well), `axon` (axonometric diagram), `globe`
(a technical plate with an instrument ring and a card), `mark` (icon study).
