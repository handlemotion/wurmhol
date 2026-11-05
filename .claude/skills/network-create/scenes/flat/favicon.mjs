// The favicon: the backdrop's construction cut to what survives at 16px. Drawn on a 32px grid
// with whole- and half-pixel coordinates, a hairline stroke (`--stroke 1`) that scales with the icon, and inks
// that follow the viewer's color scheme. Seeds are the candidates (`--seed 2` ships):
//   1  link: the circle through both limit points, the axis, the two points, the pivot
//   2  lens (shipped): two circles through each other's centres, the pivot in their lens
//   3  pair: a closing circle around each point, the axis through both, the pivot between
//   4  lens with its two centres as nodes · 5 lens in its holding circle, with the axis
//   6  lens with axis and nodes on every crossing · 7 the backdrop in miniature · 8 lens, framed
import { plate } from "../../scripts/flat.mjs";

export default (o) => {
  const p = plate({
    width: 32,
    height: 32,
    style: {
      ink: o.ink,
      accent: o.accent,
      stroke: o.stroke,
      scaleStroke: true,
      scheme: { light: "#171717", dark: "#ededed" },
    },
  });
  const variant = ((o.seed - 1) % 8) + 1;
  const lens = (r) => {
    p.circle([16 - r / 2, 16], r);
    p.circle([16 + r / 2, 16], r);
    return Math.sqrt(r * r - (r / 2) ** 2); // half the lens's height
  };
  if (variant === 1) {
    p.circle([16, 16], 11);
    p.line([1, 16], [31, 16]);
    p.node([5, 16], { size: 4 });
    p.node([27, 16], { size: 4 });
    p.node([16, 16], { shape: "dot", size: 6, accent: true });
  } else if (variant === 2) {
    // Circles through each other's centres. Nodes at the lens's tips vanish into the stroke at
    // 16px, so the pivot alone marks the link.
    lens(9);
    p.node([16, 16], { shape: "dot", size: 5, accent: true });
  } else if (variant === 3) {
    p.line([1, 16], [31, 16]);
    p.circle([8, 16], 6);
    p.circle([24, 16], 6);
    p.node([8, 16], { size: 4 });
    p.node([24, 16], { size: 4 });
    p.node([16, 16], { shape: "dot", size: 6, accent: true });
  } else if (variant === 4) {
    // The lens with its two centres as square nodes: the two places, and the link between.
    lens(9);
    p.node([11.5, 16], { size: 3 });
    p.node([20.5, 16], { size: 3 });
    p.node([16, 16], { shape: "dot", size: 4, accent: true });
  } else if (variant === 5) {
    // The lens inside the circle that holds it, with the axis through all three.
    p.circle([16, 16], 14.5);
    lens(8);
    p.line([1.5, 16], [30.5, 16]);
    p.node([16, 16], { shape: "dot", size: 4, accent: true });
  } else if (variant === 6) {
    // The lens and its construction: the axis, and nodes where the axis leaves each circle.
    const h = lens(9);
    p.line([0.5, 16], [31.5, 16]);
    p.node([2.5, 16], { size: 3 });
    p.node([29.5, 16], { size: 3 });
    p.node([16, 16 - h], { size: 3 });
    p.node([16, 16 + h], { size: 3 });
    p.node([16, 16], { shape: "dot", size: 4, accent: true });
  } else if (variant === 7) {
    // The backdrop in miniature: an outer circle, the hole off-centre inside it, and the ring's
    // two biggest circles closing the gap on the open side.
    p.circle([16, 16], 14.5);
    p.circle([11, 16], 6.5);
    p.circle([24, 9.6], 5.3);
    p.circle([24, 22.4], 5.3);
    p.node([11, 16], { shape: "dot", size: 4, accent: true });
  } else {
    // The lens, framed: a square around it as the plan, nodes at its corners.
    lens(8);
    p.frame(3.5, 3.5, 25, 25);
    for (const q of [
      [3.5, 3.5],
      [28.5, 3.5],
      [3.5, 28.5],
      [28.5, 28.5],
    ])
      p.node(q, { size: 3 });
    p.node([16, 16], { shape: "dot", size: 4, accent: true });
  }
  return p;
};
