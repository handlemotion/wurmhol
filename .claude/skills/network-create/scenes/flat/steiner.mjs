// A Steiner chain: a ring of circles, each tangent to its neighbours and to the two circles it
// sits between. Built concentric, then inverted through a point inside the hole, so the ring
// crowds to one side like a lens. Tangencies are preserved by inversion, so every node is an
// exact touching point. The hole is the inner circle; its centre is the pivot.
import { best, meet, plate } from "../../scripts/flat.mjs";

export default (o) =>
  best(
    (rnd) => {
      const W = o.width;
      const H = o.height;
      const p = plate({
        width: W,
        height: H,
        style: { ink: o.ink, accent: o.accent, stroke: o.stroke, paper: o.paper },
      });
      const u = Math.min(W, H) / 24;
      const n = [7, 8, 9, 11][Math.floor(rnd() * 4)];
      const s = Math.sin(Math.PI / n);
      const R1 = 1;
      const R2 = (R1 * (1 + s)) / (1 - s);
      const rho = (R1 + R2) / 2;
      const rr = (R2 - R1) / 2;
      const spin = rnd() * Math.PI;
      const ring = Array.from({ length: n }, (_, i) => {
        const t = spin + (i / n) * Math.PI * 2;
        return { c: [rho * Math.cos(t), rho * Math.sin(t)], r: rr };
      });
      // Invert through a point inside the hole, off centre.
      const e = 0.35 + rnd() * 0.35;
      const O = [e, 0];
      const inv = (C) => meet.invertCircle(C.c, C.r, O, 1);
      const outer = inv({ c: [0, 0], r: R1 }); // the hole's image contains everything
      const inner = inv({ c: [0, 0], r: R2 });
      const chain = ring.map(inv);
      // Fit: the outer circle runs a little past the frame's height.
      const S = (H * 0.56) / outer.r;
      const cx = W / 2;
      const cy = H / 2;
      const T = (C) => ({
        c: [cx + (C.c[0] - outer.c[0]) * S, cy + (C.c[1] - outer.c[1]) * S],
        r: C.r * S,
      });
      const out = T(outer);
      const hole = T(inner);
      const cs = chain.map(T);

      p.ray([0, cy], [W, cy], { dashed: true });
      p.circle(out.c, out.r);
      p.ticks(out.c, out.r, { count: 180, length: u * 0.25, every: 15 });
      p.circle(out.c, out.r * 1.18, { dashed: true });
      p.circle(hole.c, hole.r, { accent: false });
      for (const C of cs) p.circle(C.c, C.r);
      // The network: centres joined in a loop, spokes from the hole.
      p.poly(
        cs.map((C) => C.c),
        { closed: true, dashed: true },
      );
      for (const C of cs) p.line(hole.c, C.c, { dashed: true });
      const touch = (A, B, sign) => {
        const dx = B.c[0] - A.c[0];
        const dy = B.c[1] - A.c[1];
        const d = Math.hypot(dx, dy);
        return [A.c[0] + (dx / d) * A.r * sign, A.c[1] + (dy / d) * A.r * sign];
      };
      cs.forEach((C, i) => {
        p.node(touch(C, cs[(i + 1) % n], 1), { size: u * 0.32 });
        p.node(touch(hole, C, 1), { size: u * 0.24 });
        p.node(touch(out, C, 1), { size: u * 0.24 });
        p.node(C.c, { shape: "dot", size: u * 0.2 });
      });
      p.node(hole.c, { shape: "dot", size: u * 0.5, accent: true });
      p.label([out.c[0] + out.r * 0.72, out.c[1] - out.r * 0.78], `n = ${n}`, { tag: true });
      return p;
    },
    { seed: o.seed, tries: 24 },
  );
