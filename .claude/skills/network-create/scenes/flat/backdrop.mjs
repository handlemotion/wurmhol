// The login backdrop: the form sits in the hole. (0, 0) is the centre of the form column, and
// the hole is a circle of radius 310 px around it: the tallest form (three providers, a
// two-line notice) reaches 249 px from the centre, so the form keeps about 60 px of air. Around the hole runs an eccentric Steiner chain: nine circles,
// each tangent to its neighbours, to the hole and to the outer circle, built concentric and then
// inverted so the ring is tight on the form's left and opens wide into the page on its right.
// Nothing crosses the hole, and every node is an exact tangency. The rim is drawn in the same ink
// as the rest: the form inside it is what the eye goes to, so the plate carries no accent.
import { meet, PHI, plate } from "../../scripts/flat.mjs";

const HOLE = 310;
const N = 9;
const E = 0.45; // where the inversion point sits inside the concentric hole: the eccentricity

export default (o) => {
  const p = plate({
    width: 3600,
    height: 2000,
    origin: [1000, 1000],
    style: { ink: o.ink, accent: o.accent, stroke: o.stroke, paper: o.paper, dash: [6, 5] },
  });
  // Concentric chain: hole R1 = 1, outer R2, ring of N tangent circles between them.
  const s = Math.sin(Math.PI / N);
  const R2 = (1 + s) / (1 - s);
  const rho = (1 + R2) / 2;
  const rr = (R2 - 1) / 2;
  const ring = Array.from({ length: N }, (_, i) => {
    const t = Math.PI + (o.set?.phase ? Number(o.set.phase) : 0) + (i / N) * Math.PI * 2;
    return { c: [rho * Math.cos(t), rho * Math.sin(t)], r: rr };
  });
  // Invert through a point inside the hole: R1 maps to the new outer circle, R2 to the new hole.
  const O = [E, 0];
  const inv = (C) => meet.invertCircle(C.c, C.r, O, 1);
  const outer0 = inv({ c: [0, 0], r: 1 });
  const hole0 = inv({ c: [0, 0], r: R2 });
  // Scale so the hole is HOLE px, centred on the form; mirror so the ring opens to the right.
  const k = HOLE / hole0.r;
  const flip = outer0.c[0] > hole0.c[0] ? 1 : -1;
  const T = (C) => ({
    c: [flip * (C.c[0] - hole0.c[0]) * k, (C.c[1] - hole0.c[1]) * k],
    r: C.r * k,
  });
  const hole = T(hole0);
  const outer = T(outer0);
  const chain = ring.map((C) => T(inv(C)));

  // Construction outside the hole: the axis through both centres, and verticals through the
  // outer centre and the hole's centre, all stopping at the hole's rim.
  p.line([-1000, 0], [-HOLE, 0]).line([HOLE, 0], [2600, 0]);
  p.line([0, -1000], [0, -HOLE], { dashed: true }).line([0, HOLE], [0, 1000], { dashed: true });
  p.line([outer.c[0], -1000], [outer.c[0], 1000], { dashed: true });

  p.circle(outer.c, outer.r);
  p.ticks(outer.c, outer.r, { count: 240, length: 7, every: 12 });
  p.circle(outer.c, outer.r * 1.08, { dashed: true });
  p.circle(outer.c, outer.r * PHI, { dashed: true });
  p.circle(hole.c, hole.r);
  p.node([outer.c[0], 0], { size: 10 });
  p.node([outer.c[0] + outer.r, 0], { size: 8 });

  // The chain. The app draws it live and rolls it around the hole (Steiner's porism: any
  // starting phase closes), so `--set chain=off` leaves it out of the static export.
  if (o.set?.chain === "off") return p;
  for (const C of chain) p.circle(C.c, C.r);

  // The network: chain centres joined in a loop, spokes from the hole's rim to each centre.
  p.poly(
    chain.map((C) => C.c),
    { closed: true, dashed: true },
  );
  const towards = (from, to, d) => {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const L = Math.hypot(dx, dy);
    return [from[0] + (dx / L) * d, from[1] + (dy / L) * d];
  };
  for (const C of chain) p.line(towards(hole.c, C.c, HOLE), C.c, { dashed: true });
  chain.forEach((C, i) => {
    const next = chain[(i + 1) % N];
    p.node(towards(C.c, next.c, C.r), { size: 8 }); // touches its neighbour
    p.node(towards(hole.c, C.c, HOLE), { size: 6 }); // touches the hole
    p.node(towards(outer.c, C.c, outer.r), { size: 6 }); // touches the outer circle
    p.node(C.c, { shape: "dot", size: 5 });
  });
  return p;
};
