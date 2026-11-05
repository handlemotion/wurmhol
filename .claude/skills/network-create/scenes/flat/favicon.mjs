// The favicon: the backdrop's construction cut to what survives at 16px. Drawn on a 32px grid
// with whole- and half-pixel coordinates, a hairline stroke (`--stroke 1`) that scales with the icon, and inks
// that follow the viewer's color scheme. Seeds are the candidates (`--seed 2` ships):
//   1  link: the circle through both limit points, the axis, the two points, the pivot
//   2  lens (shipped): two circles through each other's centres, the pivot in their lens
//   3  pair: a closing circle around each point, the axis through both, the pivot between
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
  const variant = ((o.seed - 1) % 3) + 1;
  if (variant === 1) {
    p.circle([16, 16], 11);
    p.line([1, 16], [31, 16]);
    p.node([5, 16], { size: 4 });
    p.node([27, 16], { size: 4 });
    p.node([16, 16], { shape: "dot", size: 6, accent: true });
  } else if (variant === 2) {
    // Circles through each other's centres. Nodes at the lens's tips vanish into the stroke at
    // 16px, so the pivot alone marks the link.
    const r = 9;
    p.circle([16 - r / 2, 16], r);
    p.circle([16 + r / 2, 16], r);
    p.node([16, 16], { shape: "dot", size: 5, accent: true });
  } else {
    p.line([1, 16], [31, 16]);
    p.circle([8, 16], 6);
    p.circle([24, 16], 6);
    p.node([8, 16], { size: 4 });
    p.node([24, 16], { size: 4 });
    p.node([16, 16], { shape: "dot", size: 6, accent: true });
  }
  return p;
};
