// Generates the wax-seal perimeter: N lobes with controlled irregularity.
// A die press is broadly round; molten wax spreads unevenly. Deterministic
// jitter (no Math.random) so the path is reproducible across builds.
import { writeFileSync } from 'node:fs';

const cx = 512;
const cy = 552;
const N = 22;
const base = 250;
const jitter = [0, 3, -2, 4, -3, 2, 5, -1, 3, -4, 1, 4, -2, 2, -5, 3, 1, -3, 4, -1, 2, -4];

const pts = [];
for (let i = 0; i < N; i += 1) {
  const a = (i / N) * Math.PI * 2 - Math.PI / 2;
  const lobe = i % 2 === 0 ? base + 16 : base - 13;
  const r = lobe + jitter[i % jitter.length];
  pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
}

// Catmull-Rom through the lobe tips, converted to cubic beziers, so the
// scallops are smooth and even rather than hand-guessed.
const P = (i) => pts[(i + N) % N];
const f = (n) => n.toFixed(1);
let d = `M${f(P(0)[0])} ${f(P(0)[1])}`;
for (let i = 0; i < N; i += 1) {
  const p0 = P(i - 1);
  const p1 = P(i);
  const p2 = P(i + 1);
  const p3 = P(i + 2);
  const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
  const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
  d += ` C${f(c1[0])} ${f(c1[1])}, ${f(c2[0])} ${f(c2[1])}, ${f(p2[0])} ${f(p2[1])}`;
}
d += ' Z';

writeFileSync(new URL('wax-path.txt', import.meta.url), d);
console.log(`lobes: ${N} · radius ${base} · path ${d.length} chars`);
