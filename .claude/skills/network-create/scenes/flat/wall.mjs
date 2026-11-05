// The wall's backdrop. (0, 0) is the wall's anchor, the Create pipe button, and it is the centre
// of a net of confocal conics: ellipses and hyperbolas sharing two foci, `container` on the left
// and `browser` on the right, the two places a pipe joins. The button sits on the line between
// them, where a pipe would run. The innermost ellipse is the hole: it clears the open Create pipe
// card (a 288 px square) with air on every side, and inside it there is only the focal axis, the
// foci and their tags. Hyperbolas start at the hole's rim, so the net never crosses the card.
// Every node is an exact crossing in elliptic coordinates (μ, ν).
import { best, plate } from "../../scripts/flat.mjs";

const W = 3600;
const H = 2400;
const C = 250; // centre to each focus: its tag clears the open card (half width 144)
const MU0 = 0.77; // the hole: semi-axes 327 × 212, the card's corners sit well inside
const BUTTON = 96; // the focal axis stops this far from the centre, short of the button

export default (o) =>
  best(
    (rnd) => {
      const p = plate({
        width: W,
        height: H,
        origin: [W / 2, H / 2],
        style: {
          ink: o.ink,
          accent: o.accent,
          stroke: o.stroke,
          paper: o.paper,
          dash: [6, 5],
          text: 11,
        },
      });
      const at = (mu, nu) => [C * Math.cosh(mu) * Math.cos(nu), C * Math.sinh(mu) * Math.sin(nu)];
      const mus = [MU0, 1.08, 1.42, 1.76, 2.12, 2.5, 2.9];
      const nus = Array.from({ length: 16 }, (_, i) => ((i + 0.5) / 16) * Math.PI * 2);

      mus.forEach((mu, i) =>
        p.ellipse([0, 0], C * Math.cosh(mu), C * Math.sinh(mu), 0, { dashed: i % 2 === 1 }),
      );
      // Hyperbolas from the hole's rim outwards, past the page.
      for (const nu of nus) {
        const pts = [];
        for (let k = 0; k <= 160; k++) pts.push(at(MU0 + (k / 160) * 2.6, nu));
        p.poly(pts, { dashed: true });
      }
      // The focal axis: outside the hole it runs off both edges; inside, from each focus towards
      // the button, stopping short of it.
      const rim = C * Math.cosh(MU0);
      p.line([-W / 2, 0], [-rim, 0]).line([rim, 0], [W / 2, 0]);
      p.line([-C, 0], [-BUTTON, 0]).line([BUTTON, 0], [C, 0]);
      p.line([0, -H / 2], [0, -C * Math.sinh(MU0)], { dashed: true });
      p.line([0, C * Math.sinh(MU0)], [0, H / 2], { dashed: true });

      // Nodes on a sparse, seeded set of the net's crossings, and where the axes meet the rings.
      mus.slice(0, 5).forEach((mu, i) => {
        for (const nu of nus) if (rnd() < 0.34 - i * 0.03) p.node(at(mu, nu), { size: 6 });
      });
      for (const mu of mus.slice(0, 5)) {
        p.node(at(mu, 0), { size: 5 }).node(at(mu, Math.PI), { size: 5 });
      }
      p.node([-C, 0], { size: 10 }).node([C, 0], { size: 10 });
      p.label([-C, -20], "container", { tag: true, anchor: "middle" });
      p.label([C, 28], "browser", { tag: true, anchor: "middle" });
      return p;
    },
    { seed: o.seed, tries: 16 },
  );
