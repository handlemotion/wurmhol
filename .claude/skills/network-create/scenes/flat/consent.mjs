// The consent page: an assistant asks to reach the orgs' pipes. Two circles and their common
// tangents. (0, 0) is the centre of the form column, and the form sits in the large circle, the
// hole (radius 300 px: the consent form reaches about 245 px from its centre). The small circle
// is the assistant, r = R/φ², out in the page on the form's right, touching the hole's φ ring
// (the bezel) from outside. Their two inner tangents cross at the internal centre of similitude:
// the one point through which one circle maps onto the other, the grant. That point is the
// accent. The outer tangents meet at the external centre, past the right edge of the page.
// Every line stops at the hole's rim; every node is a tangency or an exact crossing.
import { meet, PHI, plate } from "../../scripts/flat.mjs";

const R = 300;

export default (o) => {
  const p = plate({
    width: 3600,
    height: 2000,
    origin: [1000, 1000],
    style: { ink: o.ink, accent: o.accent, stroke: o.stroke, paper: o.paper, dash: [6, 5] },
  });
  const hole = [0, 0];
  const r = R / PHI ** 2;
  const d = R * PHI + r; // the assistant touches the bezel from outside, at (Rφ, 0)
  const small = [d, 0];
  const I = [(d * R) / (R + r), 0]; // internal centre of similitude
  const E = [(d * R) / (R - r), 0]; // external centre, off the page at 1440 px

  // The axis through both centres, stopping at the rim; verticals through the hole's centre
  // (dashed, outside the rim), the grant and the assistant.
  p.line([-1000, 0], [-R, 0]).line([R, 0], [2600, 0]);
  p.line([0, -1000], [0, -R], { dashed: true }).line([0, R], [0, 1000], { dashed: true });
  p.line([I[0], -1000], [I[0], 1000], { dashed: true });
  p.line([d, -1000], [d, 1000], { dashed: true });

  // On the left, the org's side: a half square circumscribing the hole (its sides tangent to the
  // hole, ending at the tangent points), and a vertical tangent to the bezel.
  p.line([-1000, -R], [0, -R]).line([-1000, R], [0, R]);
  p.line([-R, -1000], [-R, -R], { dashed: true }).line([-R, R], [-R, 1000], { dashed: true });
  p.line([-R, -R], [-R, R]);
  p.line([-R * PHI, -1000], [-R * PHI, 1000], { dashed: true });
  for (const [x, y] of [
    [-R, -R],
    [-R, R],
  ])
    p.node([x, y], { size: 8 });
  for (const y of [-R, R]) p.node([0, y], { size: 6 });
  for (const q of meet.lineCircle([-R * PHI, -1000], [-R * PHI, 1000], hole, R * PHI ** 2))
    p.node(q, { size: 6 });

  // The hole and its φ rings: the first is the bezel the grant sits inside.
  p.circle(hole, R);
  p.circle(hole, R * PHI);
  p.ticks(hole, R * PHI, { count: 180, length: 7, every: 15 });
  p.circle(hole, R * PHI ** 2, { dashed: true });

  // The assistant: its circle, a φ echo, and a bezel of its own.
  p.circle(small, r);
  p.circle(small, r * PHI, { dashed: true });
  p.circle(small, r / PHI);

  // Inner tangents through the grant (solid: the two scopes), outer ones through E (dashed).
  const holeIn = meet.tangents(I, hole, R);
  const smallIn = meet.tangents(I, small, r);
  for (const t of holeIn) p.line(I, t);
  for (const t of smallIn) p.line(I, t);
  const holeOut = meet.tangents(E, hole, R);
  const smallOut = meet.tangents(E, small, r);
  holeOut.forEach((t, i) => p.line(t, smallOut[i], { dashed: true }));
  for (const t of smallOut)
    p.line(t, [t[0] + (E[0] - t[0]) * 0.6, t[1] + (E[1] - t[1]) * 0.6], { dashed: true });

  // Nodes: tangent points, where the grant's vertical crosses the hole's φ ring, the centres.
  for (const t of [...holeIn, ...holeOut]) p.node(t, { size: 8 });
  for (const t of [...smallIn, ...smallOut]) p.node(t, { size: 6 });
  for (const q of meet.lineCircle([I[0], -1000], [I[0], 1000], hole, R * PHI))
    p.node(q, { size: 6 });
  for (const q of meet.lineCircle([d, -1000], [d, 1000], hole, R * PHI ** 2))
    p.node(q, { size: 6 });
  p.node([R * PHI, 0], { size: 10 }); // where the assistant touches the bezel
  p.node([-R * PHI, 0], { size: 8 });
  p.node([-R * PHI ** 2, 0], { size: 6 });
  p.node(small, { shape: "dot", size: 6 });
  p.node(I, { shape: "dot", size: 12, accent: true });

  // One tag: the assistant. The form beside it names the rest.
  p.label([I[0] + 12, r * PHI + 34], "assistant", { tag: true });
  return p;
};
