// Guilloche line patterns, ported from the mockup's inline generator. Pure math, no DOM: a
// rosette of four hypotrochoids for the flight scene, and eighteen fine waves for the cheque.
// The numbers never change, so both sets are drawn once at module load and handed out as is.

export interface GuillochePath {
  d: string;
  stroke: string;
  width: number;
  opacity: number;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

// One hypotrochoid, sampled into a polyline. Same curve and rounding as the mockup's troch().
function troch(R: number, r: number, d: number, k: number, steps = 2600): string {
  let s = "";
  const turns = r / gcd(R, r);
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2 * turns;
    s +=
      (i ? "L" : "M") +
      (((R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t)) * k).toFixed(2) +
      " " +
      (((R - r) * Math.sin(t) - d * Math.sin(((R - r) / r) * t)) * k).toFixed(2);
  }
  return s;
}

const ROSETTE: GuillochePath[] = [
  { d: troch(96, 36, 62, 0.78), stroke: "#9db99a", width: 0.6, opacity: 0.9 },
  { d: troch(80, 22, 40, 0.94), stroke: "#b6cbb3", width: 0.55, opacity: 1 },
  { d: troch(60, 26, 50, 0.62), stroke: "#8aac87", width: 0.55, opacity: 0.85 },
  { d: troch(50, 15, 30, 0.5), stroke: "#c3d4c0", width: 0.5, opacity: 1 },
];

const WAVES: GuillochePath[] = [];
for (let k = 0; k < 18; k++) {
  let d = "";
  for (let x = 0; x <= 600; x += 5) {
    const y = 150 + Math.sin(x / 46 + k * 0.32) * (60 + k * 4) * Math.sin(x / 300 + k * 0.07);
    d += (x ? "L" : "M") + x + " " + y.toFixed(1);
  }
  WAVES.push({ d, stroke: "#d5e2d1", width: 0.8, opacity: 0.8 });
}

export function rosettePaths(): GuillochePath[] {
  return ROSETTE;
}

export function wavePaths(): GuillochePath[] {
  return WAVES;
}
