"use client";

// v2 of the home scene: an isometric pixel-art island. The 3D scene is
// rendered at a fraction of screen resolution and scaled up with
// nearest-neighbour sampling, and every surface uses three-step toon
// shading, so the result reads as hand-placed pixels while staying live.

import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Sparkles } from "@react-three/drei";
import { makeBoomerangGeometry, rng } from "./geometry";
import { EARLY_COUNT, PILGRIMS, paramsAt, story, type StoryParams } from "@/lib/story";

// The money still runs on 200 backers (0.5% each, see lib/story.ts). The pixel
// island draws one farmer per 5 backers so each figure stays readable.
const PER_FIGURE = 5;
const FIGS = PILGRIMS / PER_FIGURE; // 40
const EARLY_FIGS = EARLY_COUNT / PER_FIGURE; // 24

const BG = "#1d1d1d";
const H = 5; // island half-size (10 x 10)
const SHORE = 4.35;
const PLINTH_R = 1.05;
const PLINTH_H = 0.22;
const RECIPIENT = new THREE.Vector3(8.4, -0.9, -3.6);
const PIXEL_RATIO = 0.36; // render scale; lower = chunkier pixels

const C = {
  grass: "#86955a",
  grassLight: "#a2a866",
  grassDark: "#647443",
  path: "#a08463",
  soil1: "#8a6440",
  soil2: "#6e4c31",
  soil3: "#553923",
  soil4: "#3e2b1d",
  stone: "#9a9581",
  stoneDark: "#77725f",
  water: "#5f93a6",
  waterLight: "#8fbac4",
  wood: "#7a5236",
  woodLight: "#a4744a",
  roof: "#8d5636",
  leafA: "#7d8c3e",
  leafB: "#a3a447",
  leafC: "#c2b35a",
  pine: "#3f5a3a",
  flowerA: "#efe6c8",
  flowerB: "#e3c35d",
  flowerC: "#d99a6c",
  glow: "#ffe2a0",
};

const live: { s: StoryParams; t: number } = { s: paramsAt(0), t: 0 };

// ---------------------------------------------------------------- materials

let gradient: THREE.DataTexture | null = null;
function toonGradient() {
  if (gradient) return gradient;
  const d = new Uint8Array([90, 90, 90, 255, 170, 170, 170, 255, 255, 255, 255, 255]);
  gradient = new THREE.DataTexture(d, 3, 1, THREE.RGBAFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.needsUpdate = true;
  return gradient;
}

function Toon({ color, ...rest }: { color: string } & Partial<THREE.MeshToonMaterialParameters>) {
  return <meshToonMaterial color={color} gradientMap={toonGradient()} {...rest} />;
}

// ---------------------------------------------------------------- camera

function Director() {
  const { camera, size } = useThree();
  useFrame((state, dt) => {
    const k = 1 - Math.exp(-dt * 3.2);
    story.p += (story.target - story.p) * k;
    live.s = paramsAt(story.p);
    live.t = state.clock.elapsedTime;

    const cam = camera as THREE.OrthographicCamera;
    const s = live.s;
    cam.zoom = (size.height / 17.5) * s.zoom;
    const target = new THREE.Vector3(0, s.lift - 0.4, 0);
    const dir = new THREE.Vector3(1, 0.82, 1).normalize();
    cam.position.copy(target).addScaledVector(dir, 40);
    cam.lookAt(target);
    cam.setViewOffset(size.width, size.height, -s.offsetX * size.width, 0, size.width, size.height);
    cam.updateProjectionMatrix();
  });
  return null;
}

function World({ children }: { children: React.ReactNode }) {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!g.current) return;
    // small sway around the classic 45° isometric view
    g.current.rotation.y = Math.sin(live.s.spin * 0.5) * 0.35 + Math.sin(live.t * 0.15) * 0.04;
  });
  return <group ref={g}>{children}</group>;
}

// ---------------------------------------------------------------- slab

/** A square floating block: grass top, banded soil, fading into the dark. */
function Slab({ size, depth, seed = 1 }: { size: number; depth: number; seed?: number }) {
  const bands = [C.soil1, C.soil2, C.soil3, C.soil4, "#2b2219"];
  const bandH = (depth - 0.32) / bands.length;
  const r = useMemo(() => rng(seed), [seed]);
  const tufts = useMemo(() => {
    const out: [number, number, number][] = [];
    const n = Math.round(size * 3);
    for (let i = 0; i < n; i++) {
      const side = Math.floor(r() * 2);
      const u = (r() - 0.5) * size;
      out.push(side === 0 ? [size / 2 + 0.02, -0.32 - r() * 0.25, u] : [u, -0.32 - r() * 0.25, size / 2 + 0.02]);
    }
    return out;
  }, [r, size]);
  return (
    <group>
      <mesh position={[0, -0.16, 0]} receiveShadow castShadow>
        <boxGeometry args={[size, 0.32, size]} />
        <Toon color={C.grass} />
      </mesh>
      {bands.map((c, i) => (
        <mesh key={i} position={[0, -0.32 - bandH * (i + 0.5), 0]}>
          <boxGeometry args={[size - i * 0.02, bandH, size - i * 0.02]} />
          <Toon color={c} />
        </mesh>
      ))}
      {/* grass hanging over the edge */}
      {tufts.map((p, i) => (
        <mesh key={i} position={p}>
          <boxGeometry args={[0.18, 0.22, 0.18]} />
          <Toon color={C.grassDark} />
        </mesh>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------- scenery

type TreeSpec = { x: number; z: number; y?: number; s: number; kind: "round" | "pine"; c: string };

function Tree({ x, z, y = 0, s, kind, c }: TreeSpec) {
  if (kind === "pine") {
    return (
      <group position={[x, y, z]} scale={s}>
        <mesh position={[0, 0.2, 0]} castShadow>
          <boxGeometry args={[0.12, 0.4, 0.12]} />
          <Toon color={C.wood} />
        </mesh>
        {[0, 1, 2].map((i) => (
          <mesh key={i} position={[0, 0.55 + i * 0.32, 0]} castShadow>
            <coneGeometry args={[0.5 - i * 0.12, 0.6, 6]} />
            <Toon color={C.pine} />
          </mesh>
        ))}
      </group>
    );
  }
  return (
    <group position={[x, y, z]} scale={s}>
      <mesh position={[0, 0.35, 0]} castShadow>
        <boxGeometry args={[0.14, 0.7, 0.14]} />
        <Toon color={C.wood} />
      </mesh>
      <mesh position={[0, 0.95, 0]} castShadow>
        <icosahedronGeometry args={[0.5, 0]} />
        <Toon color={c} />
      </mesh>
      <mesh position={[0.28, 0.8, 0.18]} castShadow>
        <icosahedronGeometry args={[0.32, 0]} />
        <Toon color={C.leafB} />
      </mesh>
      <mesh position={[-0.22, 1.2, -0.1]} castShadow>
        <icosahedronGeometry args={[0.3, 0]} />
        <Toon color={C.leafC} />
      </mesh>
    </group>
  );
}

const TREES: TreeSpec[] = [
  { x: -4.3, z: -4.3, y: 0.55, s: 1.1, kind: "round", c: C.leafA },
  { x: -2.4, z: -4.4, y: 0.55, s: 0.9, kind: "round", c: C.leafB },
  { x: -4.4, z: -2.2, y: 0.55, s: 0.95, kind: "round", c: C.leafA },
  { x: 4.3, z: -4.3, s: 0.9, kind: "pine", c: C.pine },
  { x: 3.6, z: -4.5, s: 0.75, kind: "pine", c: C.pine },
  { x: 4.5, z: -3.4, s: 0.8, kind: "pine", c: C.pine },
  { x: -4.4, z: 4.3, s: 1.0, kind: "round", c: C.leafA },
  { x: -4.5, z: 1.4, s: 0.8, kind: "round", c: C.leafB },
  { x: 4.4, z: 4.4, s: 0.85, kind: "round", c: C.leafC },
  { x: 4.5, z: 1.0, s: 0.75, kind: "round", c: C.leafA },
  { x: 1.2, z: 4.5, s: 0.8, kind: "round", c: C.leafB },
  { x: 2.6, z: -4.4, s: 0.7, kind: "round", c: C.leafA },
];

/** Raised stone terrace in the back corner with a greenhouse on it. */
function Terrace() {
  return (
    <group position={[-3.4, 0, -3.4]}>
      <mesh position={[0, 0.27, 0]} castShadow receiveShadow>
        <boxGeometry args={[3.2, 0.55, 3.2]} />
        <Toon color={C.stone} />
      </mesh>
      <mesh position={[0, 0.57, 0]} receiveShadow>
        <boxGeometry args={[3.0, 0.06, 3.0]} />
        <Toon color={C.grassLight} />
      </mesh>
      {/* steps down toward the middle */}
      {[0, 1, 2].map((i) => (
        <mesh key={i} position={[1.75 + i * 0.18, 0.4 - i * 0.16, 0.6]} castShadow receiveShadow>
          <boxGeometry args={[0.2, 0.14, 0.7]} />
          <Toon color={C.stoneDark} />
        </mesh>
      ))}
      {/* greenhouse */}
      <group position={[0.5, 0.6, 0.6]}>
        <mesh position={[0, 0.3, 0]}>
          <boxGeometry args={[1.0, 0.6, 0.7]} />
          <meshToonMaterial color="#cfe3e0" transparent opacity={0.55} gradientMap={toonGradient()} />
        </mesh>
        <mesh position={[0, 0.72, 0]} rotation={[0, 0, Math.PI / 4]}>
          <boxGeometry args={[0.52, 0.52, 0.72]} />
          <meshToonMaterial color="#dcebe8" transparent opacity={0.5} gradientMap={toonGradient()} />
        </mesh>
      </group>
    </group>
  );
}

/** Wooden shed in the back-right corner. */
function Shed() {
  return (
    <group position={[3.3, 0, -2.6]} rotation={[0, -0.2, 0]}>
      <mesh position={[0, 0.3, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.9, 0.6, 0.7]} />
        <Toon color={C.woodLight} />
      </mesh>
      <mesh position={[0, 0.72, 0]} rotation={[Math.PI / 4, 0, 0]} castShadow>
        <boxGeometry args={[1.0, 0.5, 0.5]} />
        <Toon color={C.roof} />
      </mesh>
      <mesh position={[0, 0.22, 0.36]}>
        <boxGeometry args={[0.22, 0.4, 0.02]} />
        <Toon color={C.wood} />
      </mesh>
    </group>
  );
}

/** Garden beds with rows of crops. */
function Beds() {
  const beds = [
    [2.6, 3.4],
    [3.7, 3.4],
  ];
  return (
    <group>
      {beds.map(([x, z], i) => (
        <group key={i} position={[x, 0, z]}>
          <mesh position={[0, 0.05, 0]} receiveShadow>
            <boxGeometry args={[0.9, 0.1, 1.2]} />
            <Toon color={C.soil1} />
          </mesh>
          {[-0.4, -0.13, 0.13, 0.4].map((dz, j) => (
            <mesh key={j} position={[0, 0.14, dz]} castShadow>
              <boxGeometry args={[0.7, 0.1, 0.1]} />
              <Toon color={j % 2 ? C.leafB : C.leafA} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

/** A small stream with a wooden footbridge. */
function Stream() {
  const pts: [number, number][] = [
    [-1.8, -4.9],
    [-1.6, -3.6],
    [-2.4, -2.6],
    [-3.6, -1.6],
    [-3.9, 0.2],
    [-3.3, 1.8],
    [-3.6, 3.4],
    [-3.1, 4.95],
  ];
  const segs = useMemo(() => {
    const out: { x: number; z: number; len: number; rot: number }[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, z0] = pts[i];
      const [x1, z1] = pts[i + 1];
      out.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, len: Math.hypot(x1 - x0, z1 - z0) + 0.3, rot: Math.atan2(x1 - x0, z1 - z0) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const shimmer = useRef<THREE.MeshToonMaterial[]>([]);
  useFrame(() => {
    shimmer.current.forEach((m, i) => {
      if (m) m.color.set(Math.sin(live.t * 2 + i * 1.3) > 0.6 ? C.waterLight : C.water);
    });
  });
  return (
    <group>
      {segs.map((s, i) => (
        <mesh key={i} position={[s.x, 0.012, s.z]} rotation={[0, s.rot, 0]}>
          <boxGeometry args={[0.5, 0.03, s.len]} />
          <meshToonMaterial ref={(m) => { if (m) shimmer.current[i] = m; }} color={C.water} gradientMap={toonGradient()} />
        </mesh>
      ))}
      {/* footbridge */}
      <group position={[-3.6, 0.06, 2.6]} rotation={[0, 0.3, 0]}>
        {[-0.25, -0.08, 0.09, 0.26].map((dz, i) => (
          <mesh key={i} position={[0, 0.03, dz]} castShadow>
            <boxGeometry args={[0.9, 0.06, 0.14]} />
            <Toon color={C.woodLight} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

/** Fence along the two front edges. */
function Fence() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const count = useMemo(() => {
    const items: THREE.Matrix4[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const step = 0.55;
    for (let u = -H + 0.25; u <= H - 0.2; u += step) {
      // posts on +x edge and +z edge
      items.push(m.clone().compose(new THREE.Vector3(H - 0.12, 0.2, u), q, new THREE.Vector3(0.08, 0.4, 0.08)));
      items.push(m.clone().compose(new THREE.Vector3(u, 0.2, H - 0.12), q, new THREE.Vector3(0.08, 0.4, 0.08)));
    }
    // rails
    for (const y of [0.18, 0.32]) {
      items.push(m.clone().compose(new THREE.Vector3(H - 0.12, y, 0), q, new THREE.Vector3(0.04, 0.05, 2 * H - 0.3)));
      items.push(m.clone().compose(new THREE.Vector3(0, y, H - 0.12), q, new THREE.Vector3(2 * H - 0.3, 0.05, 0.04)));
    }
    return items;
  }, []);
  useFrame(() => {
    if (!ref.current || ref.current.userData.done) return;
    count.forEach((mat, i) => ref.current!.setMatrixAt(i, mat));
    ref.current.instanceMatrix.needsUpdate = true;
    ref.current.userData.done = true;
  });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count.length]} castShadow frustumCulled={false}>
      <boxGeometry args={[1, 1, 1]} />
      <Toon color={C.wood} />
    </instancedMesh>
  );
}

/** Stepping-stone paths and a meadow of tiny flowers. */
function Ground() {
  const flowers = useRef<THREE.InstancedMesh>(null);
  const stones = useRef<THREE.InstancedMesh>(null);
  const data = useMemo(() => {
    const r = rng(11);
    const fl: { p: THREE.Vector3; c: string }[] = [];
    const cols = [C.flowerA, C.flowerA, C.flowerB, C.flowerC, C.grassLight];
    while (fl.length < 520) {
      const x = (r() - 0.5) * 9.4;
      const z = (r() - 0.5) * 9.4;
      if (x < -1.7 && z < -1.7) continue; // terrace
      const d = Math.hypot(x, z);
      if (d < 1.3) continue; // plinth
      fl.push({ p: new THREE.Vector3(x, 0.03, z), c: cols[Math.floor(r() * cols.length)] });
    }
    const st: THREE.Vector3[] = [];
    // two stepping-stone paths from the plinth to the front corners
    for (const [ax, az] of [
      [1, 0.15],
      [0.15, 1],
      [-0.2, -1],
    ]) {
      for (let t = 1.4; t < 4.6; t += 0.42) {
        st.push(new THREE.Vector3(ax * t + (r() - 0.5) * 0.15, 0.015, az * t + (r() - 0.5) * 0.15));
      }
    }
    return { fl, st };
  }, []);
  useFrame(() => {
    if (!flowers.current || !stones.current || flowers.current.userData.done) return;
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    data.fl.forEach((f, i) => {
      m.makeTranslation(f.p.x, f.p.y, f.p.z);
      flowers.current!.setMatrixAt(i, m);
      flowers.current!.setColorAt(i, c.set(f.c));
    });
    data.st.forEach((p, i) => {
      m.makeTranslation(p.x, p.y, p.z);
      stones.current!.setMatrixAt(i, m);
    });
    flowers.current.instanceMatrix.needsUpdate = true;
    if (flowers.current.instanceColor) flowers.current.instanceColor.needsUpdate = true;
    stones.current.instanceMatrix.needsUpdate = true;
    flowers.current.userData.done = true;
  });
  return (
    <group>
      <instancedMesh ref={flowers} args={[undefined, undefined, data.fl.length]} frustumCulled={false}>
        <boxGeometry args={[0.07, 0.06, 0.07]} />
        <meshToonMaterial gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh ref={stones} args={[undefined, undefined, data.st.length]} receiveShadow frustumCulled={false}>
        <boxGeometry args={[0.3, 0.03, 0.24]} />
        <Toon color={C.path} />
      </instancedMesh>
    </group>
  );
}

function Island() {
  return (
    <group>
      <Slab size={2 * H} depth={3.6} seed={3} />
      <Ground />
      <Terrace />
      <Stream />
      <Beds />
      <Shed />
      <Fence />
      {TREES.map((t, i) => (
        <Tree key={i} {...t} />
      ))}
    </group>
  );
}

// ---------------------------------------------------------------- glow

let glowTex: THREE.Texture | null = null;
function getGlowTexture() {
  if (glowTex) return glowTex;
  // stepped rings so the halo reads as pixel art
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  const rings = [
    [16, 0.08],
    [11, 0.18],
    [7, 0.35],
    [4, 0.7],
  ] as const;
  rings.forEach(([r, a]) => {
    g.fillStyle = `rgba(255,255,255,${a})`;
    g.beginPath();
    g.arc(16, 16, r, 0, Math.PI * 2);
    g.fill();
  });
  glowTex = new THREE.CanvasTexture(c);
  glowTex.magFilter = THREE.NearestFilter;
  glowTex.minFilter = THREE.NearestFilter;
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

function Glow({ color, update }: { color: string; update: (s: THREE.Sprite, m: THREE.SpriteMaterial) => void }) {
  const ref = useRef<THREE.Sprite>(null);
  const tex = useMemo(() => getGlowTexture(), []);
  useFrame(() => {
    if (ref.current) update(ref.current, ref.current.material as THREE.SpriteMaterial);
  });
  return (
    <sprite ref={ref}>
      <spriteMaterial map={tex} color={color} transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
    </sprite>
  );
}

// ---------------------------------------------------------------- beacon

function Beacon() {
  const fill = useRef<THREE.Mesh>(null);
  const crystal = useRef<THREE.Mesh>(null);
  const fillMat = useRef<THREE.MeshBasicMaterial>(null);
  const level = useRef(0);
  const COL_H = 2.2;

  useFrame((_, dt) => {
    const s = live.s;
    const arrived = s.early * EARLY_COUNT + s.late * (PILGRIMS - EARLY_COUNT);
    let target = (arrived / PILGRIMS) * (1 - s.missed);
    target = Math.max(target, s.met);
    level.current += (target - level.current) * (1 - Math.exp(-dt * 2.5));
    const lv = Math.max(level.current, 0.001);
    if (fill.current) {
      fill.current.scale.y = lv;
      fill.current.position.y = PLINTH_H + (COL_H * lv) / 2;
    }
    if (crystal.current) {
      crystal.current.rotation.y = live.t * 0.8;
      crystal.current.position.y = PLINTH_H + COL_H + 0.42 + Math.round(Math.sin(live.t * 1.6) * 2) * 0.03;
    }
    if (fillMat.current) fillMat.current.color.set(s.met > 0.5 ? "#fff3c4" : "#ffd98a");
  });

  return (
    <group>
      {/* stone circle */}
      <mesh position={[0, PLINTH_H / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[PLINTH_R, PLINTH_R + 0.08, PLINTH_H, 10]} />
        <Toon color={C.stone} />
      </mesh>
      <mesh position={[0, PLINTH_H + 0.01, 0]} receiveShadow>
        <cylinderGeometry args={[PLINTH_R - 0.15, PLINTH_R - 0.15, 0.02, 10]} />
        <Toon color={C.stoneDark} />
      </mesh>
      {/* lantern column: four wooden posts and glass */}
      {[0, 1, 2, 3].map((i) => {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        return (
          <mesh key={i} position={[Math.cos(a) * 0.3, PLINTH_H + COL_H / 2, Math.sin(a) * 0.3]} castShadow>
            <boxGeometry args={[0.07, COL_H, 0.07]} />
            <Toon color={C.wood} />
          </mesh>
        );
      })}
      <mesh position={[0, PLINTH_H + COL_H / 2, 0]}>
        <boxGeometry args={[0.5, COL_H, 0.5]} />
        <meshToonMaterial color="#ffffff" transparent opacity={0.14} depthWrite={false} gradientMap={toonGradient()} />
      </mesh>
      <mesh position={[0, PLINTH_H + COL_H + 0.06, 0]} castShadow>
        <boxGeometry args={[0.62, 0.1, 0.62]} />
        <Toon color={C.roof} />
      </mesh>
      <mesh ref={fill}>
        <boxGeometry args={[0.36, COL_H, 0.36]} />
        <meshBasicMaterial ref={fillMat} color="#ffd98a" toneMapped={false} />
      </mesh>
      <mesh ref={crystal} castShadow>
        <octahedronGeometry args={[0.3, 0]} />
        <meshBasicMaterial color="#fff3d0" toneMapped={false} />
      </mesh>
      <Glow
        color={C.glow}
        update={(sp, m) => {
          const s = live.s;
          sp.position.set(0, PLINTH_H + COL_H + 0.42, 0);
          sp.scale.setScalar(1.3 + level.current * 0.6 + s.met * 1.4);
          m.opacity = 0.35 + level.current * 0.2 + s.met * 0.25;
        }}
      />
      <Glow
        color="#ffd88a"
        update={(sp, m) => {
          const s = live.s;
          const lv = Math.max(level.current, 0.001);
          sp.position.set(0, PLINTH_H + (COL_H * lv) / 2, 0);
          sp.scale.set(1.0 + s.met * 0.6, COL_H * lv * 1.25 + 0.3 + s.met * 0.5, 1);
          m.opacity = 0.14 + lv * 0.12 + s.met * 0.2;
        }}
      />
    </group>
  );
}

// ---------------------------------------------------------------- match (S)

function MatchCrate() {
  const g = useRef<THREE.Group>(null);
  const home = useMemo(() => new THREE.Vector3(0.66, PLINTH_H + 0.2, 0.36), []);
  const pav = useMemo(() => RECIPIENT.clone().add(new THREE.Vector3(0, 0.4, 0)), []);
  useFrame(() => {
    const s = live.s;
    if (!g.current) return;
    const p = home.clone();
    p.y += (1 - s.match) * 7 + s.missed * 7;
    p.lerp(pav, s.met);
    p.y += Math.sin(Math.PI * s.met) * 2.2;
    g.current.position.copy(p);
    const sc = Math.max(0.0001, Math.min(s.match, 1) * (1 - s.met * 0.35) * (1 - s.missed));
    g.current.scale.setScalar(sc);
    g.current.rotation.y = s.match < 0.99 ? live.t * 1.5 : 0.3;
    g.current.visible = s.match > 0.01;
  });
  return (
    <group ref={g}>
      <mesh castShadow>
        <boxGeometry args={[0.4, 0.4, 0.4]} />
        <Toon color={C.woodLight} />
      </mesh>
      <mesh>
        <boxGeometry args={[0.42, 0.08, 0.42]} />
        <meshBasicMaterial color="#e8c46a" toneMapped={false} />
      </mesh>
      <mesh>
        <boxGeometry args={[0.08, 0.42, 0.42]} />
        <Toon color={C.wood} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------- bonus (B)

function BonusBoomerang() {
  const { camera } = useThree();
  const g = useRef<THREE.Group>(null);
  const inner = useRef<THREE.Mesh>(null);
  const geo = useMemo(() => makeBoomerangGeometry(), []);
  const away = useMemo(() => new THREE.Vector3(-11, 10, -7), []);
  useFrame(() => {
    const s = live.s;
    if (!g.current || !inner.current) return;
    const a = live.t * 0.7;
    const orbit = new THREE.Vector3(Math.cos(a) * 3.0, 3.4 + Math.sin(live.t * 1.3) * 0.15, Math.sin(a) * 3.0);
    orbit.y += (1 - s.bonus) * 8;
    orbit.lerp(away, s.met);
    g.current.position.copy(orbit);
    const sc = 0.75 * Math.min(s.bonus, 1) * (1 - s.missed) * (1 - s.met * 0.6);
    g.current.scale.setScalar(Math.max(sc, 0.0001));
    g.current.visible = sc > 0.002;
    inner.current.rotation.z = live.t * 4.5;
    g.current.lookAt(camera.position);
  });
  return (
    <group ref={g}>
      <mesh ref={inner} geometry={geo} castShadow>
        <Toon color="#d9a560" />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------- pilgrims

function usePilgrimLayout() {
  return useMemo(() => {
    const r = rng(42);
    const slots: THREE.Vector3[] = [];
    let ring = 0;
    while (slots.length < FIGS) {
      const rad = PLINTH_R + 0.6 + ring * 0.62;
      const n = Math.floor((2 * Math.PI * rad) / 0.72);
      const off = ring * 0.37;
      for (let i = 0; i < n && slots.length < FIGS; i++) {
        const a = off + (i / n) * Math.PI * 2;
        const x = Math.cos(a) * rad;
        const z = Math.sin(a) * rad;
        if (x < -1.55 && z < -1.55) continue; // raised terrace
        slots.push(new THREE.Vector3(x, 0, z));
      }
      ring++;
    }
    // waiting spots along the inside of the square edge, shuffled
    const spots: THREE.Vector3[] = [];
    const perim = 8 * SHORE;
    for (let i = 0; i < FIGS; i++) {
      const u = (i / FIGS) * perim;
      const side = Math.floor(u / (2 * SHORE));
      const w = (u % (2 * SHORE)) - SHORE;
      const inset = (i % 2) * 0.35 + r() * 0.08;
      const d = SHORE - inset;
      const p =
        side === 0 ? new THREE.Vector3(d, 0, w) : side === 1 ? new THREE.Vector3(-w, 0, d) : side === 2 ? new THREE.Vector3(-d, 0, -w) : new THREE.Vector3(w, 0, -d);
      // the terrace corner is raised; keep people off it
      if (p.x < -1.6 && p.z < -1.6) p.set(Math.max(p.x, -1.5), 0, Math.max(p.z, -1.5));
      spots.push(p);
    }
    for (let i = spots.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [spots[i], spots[j]] = [spots[j], spots[i]];
    }
    return { slots, shore: spots };
  }, []);
}

function Pilgrims() {
  const [texEarly, texLate] = useLoader(THREE.TextureLoader, ["/pilgrim.png", "/pilgrim-late.png"]);
  useMemo(() => {
    for (const t of [texEarly, texLate]) {
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.colorSpace = THREE.SRGBColorSpace;
    }
  }, [texEarly, texLate]);

  const { slots, shore } = usePilgrimLayout();
  const sprites = useRef<(THREE.Sprite | null)[]>([]);
  const orbs = useRef<THREE.InstancedMesh>(null);
  const state = useMemo(
    () => ({ pos: shore.map((v) => v.clone()), moving: new Float32Array(FIGS), orb: new Float32Array(FIGS) }),
    [shore],
  );
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const HEIGHT = 1.0;
  const WIDTH = HEIGHT * (53 / 67);

  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const s = live.s;
    const t = live.t;
    const earlyN = Math.round(s.early * EARLY_FIGS);
    const lateN = Math.round(s.late * (FIGS - EARLY_FIGS));
    const goneHome = s.missed > 0.5;
    const target = new THREE.Vector3();

    for (let i = 0; i < FIGS; i++) {
      const sp = sprites.current[i];
      if (!sp) continue;
      const isEarly = i < EARLY_FIGS;
      const arrived = (isEarly ? i < earlyN : i - EARLY_FIGS < lateN) && !goneHome;
      target.copy(arrived ? slots[i] : shore[i]);
      if (i === 0 && s.hesitate > 0.01 && !arrived) {
        const k = (0.5 + 0.5 * Math.sin(t * 1.1)) * 0.45 * s.hesitate;
        target.lerp(slots[0], k);
      }
      const p = state.pos[i];
      const dx = target.x - p.x;
      const dz = target.z - p.z;
      const d = Math.hypot(dx, dz);
      const speed = 1.5 + (i % 7) * 0.12;
      if (d > 0.01) {
        const step = Math.min(d, speed * dt);
        p.x += (dx / d) * step;
        p.z += (dz / d) * step;
        state.moving[i] = Math.min(1, state.moving[i] + dt * 6);
        // face the way you walk (screen-right is world +x/-z in this view)
        const right = dx - dz;
        if (Math.abs(right) > 0.02) sp.scale.x = right > 0 ? -WIDTH : WIDTH;
      } else {
        state.moving[i] = Math.max(0, state.moving[i] - dt * 4);
      }
      // hop in whole steps so motion stays pixel-crisp
      const hop = Math.round(Math.abs(Math.sin(t * 10 + i)) * 2) * 0.03 * state.moving[i];
      const cheer = arrived ? Math.round(Math.abs(Math.sin(t * 5 + i * 0.7)) * 3) * 0.04 * s.met : 0;
      sp.position.set(p.x, hop + cheer, p.z);

      const wantOrb = isEarly && i < earlyN && goneHome ? 1 : 0;
      state.orb[i] += (wantOrb - state.orb[i]) * (1 - Math.exp(-dt * 4));
      const o = state.orb[i];
      dummy.position.set(p.x, HEIGHT + 0.2 + (1 - o) * 1.5, p.z);
      dummy.rotation.set(0, t * 2 + i, 0);
      dummy.scale.setScalar(Math.max(o, 0.0001));
      dummy.updateMatrix();
      orbs.current?.setMatrixAt(i, dummy.matrix);
    }
    if (orbs.current) orbs.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      {Array.from({ length: FIGS }, (_, i) => (
        <sprite
          key={i}
          ref={(el) => {
            sprites.current[i] = el;
            if (el) {
              el.center.set(0.5, 0);
              if (el.scale.y !== HEIGHT) el.scale.set(WIDTH, HEIGHT, 1);
            }
          }}
          position={shore[i].toArray()}
        >
          <spriteMaterial map={i < EARLY_FIGS ? texEarly : texLate} alphaTest={0.5} transparent={false} toneMapped={false} />
        </sprite>
      ))}
      <instancedMesh ref={orbs} args={[undefined, undefined, FIGS]} frustumCulled={false}>
        <octahedronGeometry args={[0.13, 0]} />
        <meshBasicMaterial color="#ffe08a" toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

// ---------------------------------------------------------------- recipient

function Gazebo() {
  return (
    <group>
      <mesh position={[0, 0.05, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.75, 0.8, 0.1, 8]} />
        <Toon color={C.woodLight} />
      </mesh>
      {Array.from({ length: 8 }, (_, i) => {
        const a = (i / 8) * Math.PI * 2;
        return (
          <mesh key={i} position={[Math.cos(a) * 0.62, 0.45, Math.sin(a) * 0.62]} castShadow>
            <boxGeometry args={[0.07, 0.7, 0.07]} />
            <Toon color={C.wood} />
          </mesh>
        );
      })}
      <mesh position={[0, 0.98, 0]} castShadow>
        <coneGeometry args={[0.92, 0.55, 8]} />
        <Toon color={C.roof} />
      </mesh>
    </group>
  );
}

function Recipient() {
  const planks = useRef<THREE.InstancedMesh>(null);
  const coins = useRef<THREE.InstancedMesh>(null);
  const lantern = useRef<THREE.MeshBasicMaterial>(null);
  const N = 22;
  const COINS = 14;
  const path = useMemo(() => {
    const dir = new THREE.Vector3(RECIPIENT.x, 0, RECIPIENT.z).normalize();
    // leave from the island's +x face
    const a = new THREE.Vector3(H, 0, RECIPIENT.z * (H / RECIPIENT.x));
    const b = RECIPIENT.clone().add(new THREE.Vector3(-1.75, 0, 0));
    return { a, b, dir: b.clone().sub(a).normalize() };
  }, []);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame(() => {
    const s = live.s;
    if (lantern.current) lantern.current.color.set(s.met > 0.5 ? "#fff1c0" : "#8a7a5a");
    if (planks.current) {
      const shown = s.met * N;
      for (let i = 0; i < N; i++) {
        const u = (i + 0.5) / N;
        const p = path.a.clone().lerp(path.b, u);
        p.y += Math.sin(u * Math.PI) * -0.2;
        const vis = Math.min(Math.max(shown - i, 0), 1);
        dummy.position.copy(p);
        dummy.position.y += (1 - vis) * -0.6;
        dummy.lookAt(p.clone().add(path.dir));
        dummy.scale.setScalar(Math.max(vis, 0.0001));
        dummy.updateMatrix();
        planks.current.setMatrixAt(i, dummy.matrix);
      }
      planks.current.instanceMatrix.needsUpdate = true;
    }
    if (coins.current) {
      const on = Math.max(0, (s.met - 0.6) / 0.4);
      const start = new THREE.Vector3(0, 1.8, 0);
      const pav = RECIPIENT.clone().add(new THREE.Vector3(0, 0.55, 0));
      for (let i = 0; i < COINS; i++) {
        const u = (live.t * 0.22 + i / COINS) % 1;
        let p: THREE.Vector3;
        if (u < 0.25) p = start.clone().lerp(path.a.clone().setY(0.35), u / 0.25);
        else if (u < 0.85) p = path.a.clone().setY(0.35).lerp(path.b.clone().setY(0.0), (u - 0.25) / 0.6);
        else p = path.b.clone().setY(0.0).lerp(pav, (u - 0.85) / 0.15);
        dummy.position.copy(p);
        dummy.rotation.set(0, live.t * 3 + i, 0);
        dummy.scale.setScalar(Math.max(on, 0.0001));
        dummy.updateMatrix();
        coins.current.setMatrixAt(i, dummy.matrix);
      }
      coins.current.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group>
      <group position={RECIPIENT}>
        <Slab size={3.4} depth={2.2} seed={9} />
        <Gazebo />
        <mesh position={[0, 0.55, 0]}>
          <boxGeometry args={[0.16, 0.16, 0.16]} />
          <meshBasicMaterial ref={lantern} color="#8a7a5a" toneMapped={false} />
        </mesh>
        <Glow
          color="#ffd88a"
          update={(sp, m) => {
            sp.position.set(0, 0.55, 0);
            sp.scale.setScalar(0.5 + live.s.met * 2.4);
            m.opacity = live.s.met * 0.75;
            sp.visible = live.s.met > 0.02;
          }}
        />
        <Tree x={1.1} z={-1.1} s={0.7} kind="round" c={C.leafA} />
        <Tree x={-1.2} z={-1.0} s={0.6} kind="pine" c={C.pine} />
      </group>
      <instancedMesh ref={planks} args={[undefined, undefined, N]} castShadow frustumCulled={false}>
        <boxGeometry args={[0.46, 0.05, 0.14]} />
        <Toon color={C.woodLight} />
      </instancedMesh>
      <instancedMesh ref={coins} args={[undefined, undefined, COINS]} frustumCulled={false}>
        <boxGeometry args={[0.12, 0.12, 0.03]} />
        <meshBasicMaterial color="#ffd970" toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

// ---------------------------------------------------------------- other campaigns

const OTHERS = [
  { x: -16, z: 6, y: -1.5, s: 0.4, fill: 0.8 },
  { x: -9, z: -16, y: 1.2, s: 0.34, fill: 0.35 },
  { x: 14, z: 12, y: -2.2, s: 0.38, fill: 1 },
  { x: 4, z: -20, y: 0.4, s: 0.3, fill: 0.6 },
  { x: -20, z: -6, y: 2.5, s: 0.3, fill: 0.2 },
  { x: 19, z: -6, y: 1.8, s: 0.33, fill: 0.9 },
  { x: -3, z: 18, y: 1.5, s: 0.32, fill: 0.5 },
];

function OtherIslands() {
  const refs = useRef<(THREE.Group | null)[]>([]);
  useFrame(() => {
    const m = live.s.many;
    refs.current.forEach((g, i) => {
      if (!g) return;
      const o = OTHERS[i];
      const delay = i * 0.06;
      const k = Math.min(Math.max((m - delay) / (1 - delay), 0), 1);
      g.position.set(o.x, o.y - (1 - k) * 30 + Math.round(Math.sin(live.t * 0.6 + i) * 3) * 0.1, o.z);
      g.visible = k > 0.001;
    });
  });
  return (
    <group>
      {OTHERS.map((o, i) => (
        <group key={i} ref={(el) => { refs.current[i] = el; }} scale={o.s} visible={false}>
          <Slab size={2 * H} depth={3.6} seed={20 + i} />
          <mesh position={[0, 0.15, 0]}>
            <cylinderGeometry args={[1, 1.1, 0.3, 10]} />
            <Toon color={C.stone} />
          </mesh>
          <mesh position={[0, 0.3 + 1.2 * o.fill, 0]}>
            <boxGeometry args={[0.5, 2.4 * o.fill, 0.5]} />
            <meshBasicMaterial color="#ffd98a" toneMapped={false} />
          </mesh>
          <Tree x={-3.5} z={-3.5} s={1.4} kind="round" c={C.leafA} />
          <Tree x={3.4} z={-3.6} s={1.3} kind="pine" c={C.pine} />
          <Tree x={-3.6} z={3.2} s={1.2} kind="round" c={C.leafB} />
        </group>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------- canvas

export default function IslandScenePixel() {
  useEffect(() => {
    story.note = `Each farmer stands for ${PER_FIGURE} backers.`;
  }, []);
  return (
    <Canvas
      className="pixel-canvas"
      orthographic
      flat
      shadows
      dpr={PIXEL_RATIO}
      gl={{ antialias: false, alpha: false, powerPreference: "high-performance" }}
      camera={{ position: [24, 20, 24], zoom: 50, near: 0.1, far: 200 }}
      onCreated={({ gl }) => gl.setClearColor(BG)}
    >
      <Director />
      <hemisphereLight args={["#fff4e0", "#4a4036", 1.25]} />
      <directionalLight
        position={[5, 12, 7]}
        intensity={2.0}
        color="#fff1dc"
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-9}
        shadow-camera-right={9}
        shadow-camera-top={9}
        shadow-camera-bottom={-9}
        shadow-bias={-0.0006}
      />
      <World>
        <Island />
        <Beacon />
        <MatchCrate />
        <BonusBoomerang />
        <Suspense fallback={null}>
          <Pilgrims />
        </Suspense>
        <Recipient />
        <OtherIslands />
        <Sparkles count={60} scale={[16, 6, 16]} position={[0, 2.5, 0]} size={5} speed={0.3} opacity={0.8} color="#fff2b0" />
      </World>
    </Canvas>
  );
}
