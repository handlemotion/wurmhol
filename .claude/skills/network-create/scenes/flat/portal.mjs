// The hole as architecture: an elevation of a portal. A round arch on a φ rectangle, its
// regulating circle and diagonals, a ground line, and dimension lines in modules, as a drawing
// office would set it out. The keystone is the pivot.
import { best, meet, PHI, plate } from "../../scripts/flat.mjs";

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
      const ground = H * 0.8;
      const span = H * (0.42 + rnd() * 0.06); // the opening's width
      const r = span / 2;
      const cx = W / 2 + (rnd() - 0.5) * u * 2;
      const pier = span / PHI ** 2; // pier width
      const spring = ground - span / PHI; // where the arch springs
      const x0 = cx - r - pier;
      const x1 = cx + r + pier;
      const top = spring - r - pier;

      p.ray([0, ground], [W, ground]);
      // The wall: outer frame, the opening, the arch and its extrados.
      p.poly([
        [x0, ground],
        [x0, top],
        [x1, top],
        [x1, ground],
      ]);
      p.line([cx - r, ground], [cx - r, spring]).line([cx + r, ground], [cx + r, spring]);
      p.arc([cx, spring], r, Math.PI, Math.PI * 2);
      p.arc([cx, spring], r + pier, Math.PI, Math.PI * 2, { dashed: true });
      // Regulating lines: the circle through the opening's corners, the diagonals, the axis.
      const R = Math.hypot(r, ground - spring);
      p.circle([cx, spring], R, { dashed: true });
      p.circle([cx, spring], R * PHI, { dashed: true });
      p.line([cx, 0], [cx, H], { dashed: true });
      p.line([x0, ground], [x1, top], { dashed: true }).line([x1, ground], [x0, top], {
        dashed: true,
      });
      p.ray([0, spring], [W, spring], { dashed: true });
      const eye = meet.lines([x0, ground], [x1, top], [x1, ground], [x0, top]);
      // Voussoirs: radial joints across the arch ring.
      for (let i = 1; i < 12; i++) {
        const t = Math.PI + (i / 12) * Math.PI;
        p.line(
          [cx + r * Math.cos(t), spring + r * Math.sin(t)],
          [cx + (r + pier) * Math.cos(t), spring + (r + pier) * Math.sin(t)],
        );
      }
      for (const q of [
        [cx - r, spring],
        [cx + r, spring],
        [x0, ground],
        [x1, ground],
        [cx - r, ground],
        [cx + r, ground],
      ])
        p.node(q, { size: u * 0.34 });
      p.node(eye, { shape: "dot", size: u * 0.3 });
      p.node([cx, spring - r], { size: u * 0.55, accent: true });
      p.dimension([x0, ground], [cx - r, ground], "φ⁻²", { off: u * 1.4 });
      p.dimension([cx - r, ground], [cx + r, ground], "1", { off: u * 1.4 });
      p.dimension([cx + r, ground], [x1, ground], "φ⁻²", { off: u * 1.4 });
      p.dimension([x1, ground], [x1, spring], "φ⁻¹", { off: -u * 1.4 });
      p.label([x0 - u * 0.6, top - u * 0.9], "a7f3.wurmhol.dev", { tag: true });
      return p;
    },
    { seed: o.seed, tries: 8 },
  );
