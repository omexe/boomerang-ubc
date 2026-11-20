import * as THREE from "three";

const BG = new THREE.Color("#1d1d1d");

/**
 * A floating island: flat grassy top, jagged rocky underside that fades
 * into the page background so it looks like it dissolves into the dark.
 */
export function makeIslandGeometry(R: number, depth: number, seed: number) {
  const radial = 64;
  const rows = 14;
  const g = new THREE.CylinderGeometry(R, R * 0.1, depth, radial, rows, false);
  g.translate(0, -depth / 2, 0);

  const pos = g.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);

  const grassA = new THREE.Color("#bfe6c4");
  const grassB = new THREE.Color("#d7efb8");
  const lip = new THREE.Color("#94c9a0");
  const peach = new THREE.Color("#f1cdb6");
  const lilac = new THREE.Color("#c3b2dc");
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);
    const th = Math.atan2(z, x);
    const t = Math.min(Math.max(-y / depth, 0), 1); // 0 top → 1 bottom
    const m =
      1 +
      0.06 * Math.sin(3 * th + seed) +
      0.035 * Math.sin(7 * th + seed * 2.1) +
      0.018 * Math.sin(15 * th + seed * 3.7);

    if (y > -1e-4) {
      x *= m;
      z *= m;
      y = 0;
      const r = Math.hypot(x, z) / R;
      const n = 0.5 + 0.5 * Math.sin(x * 1.7 + seed) * Math.cos(z * 1.3 - seed);
      c.copy(grassA).lerp(grassB, n * 0.6 * r);
    } else {
      const jag =
        1 +
        0.16 * Math.sin(5 * th + t * 9 + seed) * t +
        0.09 * Math.sin(11 * th - t * 14 + seed) * t +
        0.05 * Math.sin(23 * th + t * 30) * t;
      x *= m * jag;
      z *= m * jag;
      y += 0.12 * Math.sin(9 * th + seed) * t;
      if (t < 0.09) c.copy(lip);
      else if (t < 0.45) c.copy(peach).lerp(lilac, (t - 0.09) / 0.36);
      else c.copy(lilac).lerp(BG, Math.min((t - 0.45) / 0.45, 1));
    }
    pos.setXYZ(i, x, y, z);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  return g;
}

/** Boomerang outline, extruded. Roughly matches the logo's "<" silhouette. */
export function makeBoomerangGeometry() {
  const s = new THREE.Shape();
  s.moveTo(0.92, 0.6);
  s.quadraticCurveTo(-0.15, 0.62, -0.64, 0.02);
  s.quadraticCurveTo(-0.3, -0.48, 0.5, -0.76);
  s.quadraticCurveTo(0.6, -0.76, 0.52, -0.64);
  s.quadraticCurveTo(-0.05, -0.36, -0.3, 0.02);
  s.quadraticCurveTo(0.0, 0.42, 0.88, 0.48);
  s.quadraticCurveTo(0.98, 0.52, 0.92, 0.6);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.06,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.05,
    bevelSegments: 4,
    curveSegments: 24,
  });
  g.center();
  return g;
}

/** Seeded random for stable layouts. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
