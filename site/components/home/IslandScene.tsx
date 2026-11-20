"use client";

import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { RoundedBox, Sparkles } from "@react-three/drei";
import { makeBoomerangGeometry, makeIslandGeometry, rng } from "./geometry";
import {
  EARLY_COUNT,
  PILGRIMS,
  paramsAt,
  story,
  type StoryParams,
} from "@/lib/story";

const BG = "#1d1d1d";
const ISLAND_R = 5;
const SHORE_R = 4.45;
const PLINTH_R = 1.05;
const PLINTH_H = 0.22;
const RECIPIENT = new THREE.Vector3(7.6, -0.7, -3.4);

const PASTELS = ["#f7b9c4", "#c9b8f2", "#a9d4f5", "#f8e3a1", "#b4e6c5", "#fbc8a4"];
const LATE_CLOAK = "#d6d4ce";

// one params object per frame, shared by every component
const live: { s: StoryParams; t: number } = { s: paramsAt(0), t: 0 };

function Director() {
  const { camera, size } = useThree();
  useFrame((state, dt) => {
    // ease scroll progress
    const k = 1 - Math.exp(-dt * 3.2);
    story.p += (story.target - story.p) * k;
    live.s = paramsAt(story.p);
    live.t = state.clock.elapsedTime;

    const cam = camera as THREE.OrthographicCamera;
    const s = live.s;
    const base = size.height / 16.5;
    cam.zoom = base * s.zoom;
    const target = new THREE.Vector3(0, s.lift, 0);
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
    g.current.rotation.y = -0.35 + live.s.spin * 0.55 + live.t * 0.025;
  });
  return <group ref={g}>{children}</group>;
}


// soft additive halo, used instead of a bloom pass (cheaper and stable everywhere)
let glowTex: THREE.Texture | null = null;
function getGlowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.25, "rgba(255,255,255,0.45)");
  grd.addColorStop(0.6, "rgba(255,255,255,0.08)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

function Glow({
  color,
  update,
}: {
  color: string;
  update: (sprite: THREE.Sprite, mat: THREE.SpriteMaterial) => void;
}) {
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

// ---------------------------------------------------------------- island

function Trees() {
  const trees = useMemo(() => {
    const r = rng(7);
    const out: { x: number; z: number; h: number; c: string; kind: number }[] = [];
    const colors = ["#a7d9b0", "#cde8a8", "#f6c6d3", "#bfe0c9", "#e9d7f5"];
    let tries = 0;
    while (out.length < 18 && tries < 400) {
      tries++;
      const a = r() * Math.PI * 2;
      const d = 2.85 + r() * 1.15;
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      // keep the bridge lane clear
      const lane = Math.atan2(RECIPIENT.z, RECIPIENT.x);
      if (Math.abs(Math.atan2(Math.sin(a - lane), Math.cos(a - lane))) < 0.35) continue;
      if (out.some((o) => Math.hypot(o.x - x, o.z - z) < 0.75)) continue;
      out.push({ x, z, h: 0.38 + r() * 0.4, c: colors[Math.floor(r() * colors.length)], kind: r() > 0.5 ? 1 : 0 });
    }
    return out;
  }, []);
  return (
    <group>
      {trees.map((t, i) => (
        <group key={i} position={[t.x, 0, t.z]}>
          <mesh position={[0, t.h * 0.25, 0]} castShadow>
            <cylinderGeometry args={[0.035, 0.05, t.h * 0.5, 6]} />
            <meshStandardMaterial color="#d8b9a0" flatShading />
          </mesh>
          {t.kind === 0 ? (
            <mesh position={[0, t.h * 0.75, 0]} castShadow>
              <coneGeometry args={[0.2, t.h * 0.8, 7]} />
              <meshStandardMaterial color={t.c} flatShading roughness={0.8} />
            </mesh>
          ) : (
            <mesh position={[0, t.h * 0.7, 0]} castShadow>
              <icosahedronGeometry args={[0.2, 0]} />
              <meshStandardMaterial color={t.c} flatShading roughness={0.8} />
            </mesh>
          )}
        </group>
      ))}
    </group>
  );
}

function Island() {
  const geo = useMemo(() => makeIslandGeometry(ISLAND_R, 5.5, 1.3), []);
  return (
    <group>
      <mesh geometry={geo} receiveShadow>
        <meshStandardMaterial vertexColors flatShading roughness={0.95} />
      </mesh>
      <Trees />
    </group>
  );
}

// ---------------------------------------------------------------- beacon

function Beacon() {
  const fill = useRef<THREE.Mesh>(null);
  const crystal = useRef<THREE.Mesh>(null);
  const fillMat = useRef<THREE.MeshStandardMaterial>(null);
  const crystalMat = useRef<THREE.MeshStandardMaterial>(null);
  const level = useRef(0);
  const COL_H = 2.4;

  useFrame((_, dt) => {
    const s = live.s;
    const arrived = s.early * EARLY_COUNT + s.late * (PILGRIMS - EARLY_COUNT);
    let target = arrived / PILGRIMS;
    target = target * (1 - s.missed);
    target = Math.max(target, s.met);
    level.current += (target - level.current) * (1 - Math.exp(-dt * 2.5));
    const lv = Math.max(level.current, 0.001);
    if (fill.current) {
      fill.current.scale.y = lv;
      fill.current.position.y = PLINTH_H + (COL_H * lv) / 2;
    }
    if (crystal.current) {
      crystal.current.rotation.y = live.t * 0.6;
      crystal.current.position.y = PLINTH_H + COL_H + 0.45 + Math.sin(live.t * 1.4) * 0.06;
    }
    if (fillMat.current) fillMat.current.emissiveIntensity = 0.6 + s.met * 1.8;
    if (crystalMat.current) crystalMat.current.emissiveIntensity = 0.35 + lv * 0.6 + s.met * 2.2;
  });

  return (
    <group>
      <mesh position={[0, PLINTH_H / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[PLINTH_R, PLINTH_R * 1.08, PLINTH_H, 32]} />
        <meshStandardMaterial color="#f2efe8" roughness={0.6} />
      </mesh>
      {/* glass column */}
      <mesh position={[0, PLINTH_H + COL_H / 2, 0]}>
        <cylinderGeometry args={[0.3, 0.3, COL_H, 32, 1, true]} />
        <meshStandardMaterial color="#ffffff" transparent opacity={0.16} roughness={0.1} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <mesh position={[0, PLINTH_H + COL_H + 0.02, 0]}>
        <torusGeometry args={[0.3, 0.025, 8, 32]} />
        <meshStandardMaterial color="#f2efe8" />
      </mesh>
      {/* the pledged amount, rising */}
      <mesh ref={fill}>
        <cylinderGeometry args={[0.24, 0.24, COL_H, 32]} />
        <meshStandardMaterial ref={fillMat} color="#ffe7b0" emissive="#ffd88a" emissiveIntensity={0.6} toneMapped={false} />
      </mesh>
      <mesh ref={crystal} castShadow>
        <octahedronGeometry args={[0.32, 0]} />
        <meshStandardMaterial ref={crystalMat} color="#fff3d6" emissive="#ffe2a0" emissiveIntensity={0.4} flatShading toneMapped={false} />
      </mesh>
      <Glow
        color="#ffe2a0"
        update={(sp, m) => {
          const s = live.s;
          sp.position.set(0, PLINTH_H + COL_H + 0.45, 0);
          sp.scale.setScalar(1.4 + level.current * 0.8 + s.met * 2.6);
          m.opacity = 0.35 + level.current * 0.25 + s.met * 0.45;
        }}
      />
      <Glow
        color="#ffd88a"
        update={(sp, m) => {
          const s = live.s;
          const lv = Math.max(level.current, 0.001);
          sp.position.set(0, PLINTH_H + (COL_H * lv) / 2, 0);
          sp.scale.set(1.2 + s.met * 1.4, COL_H * lv * 1.25 + 0.3 + s.met * 1.2, 1);
          m.opacity = 0.18 + lv * 0.15 + s.met * 0.45;
        }}
      />
    </group>
  );
}

// ---------------------------------------------------------------- match (S)

function MatchBlock() {
  const g = useRef<THREE.Group>(null);
  const home = useMemo(() => new THREE.Vector3(0.62, PLINTH_H + 0.21, 0.42), []);
  const pav = useMemo(() => RECIPIENT.clone().add(new THREE.Vector3(0, 0.45, 0)), []);
  useFrame(() => {
    const s = live.s;
    if (!g.current) return;
    const p = home.clone();
    p.y += (1 - s.match) * 7 + s.missed * 7;
    p.lerp(pav, s.met);
    p.y += Math.sin(Math.PI * s.met) * 2.2; // arc over to the recipient
    g.current.position.copy(p);
    const sc = Math.max(0.0001, Math.min(s.match, 1) * (1 - s.met * 0.35) * (1 - s.missed));
    g.current.scale.setScalar(sc);
    g.current.rotation.y = s.match < 0.99 ? live.t * 1.5 : 0.3;
    g.current.visible = s.match > 0.01;
  });
  return (
    <group ref={g}>
      <RoundedBox args={[0.42, 0.42, 0.42]} radius={0.06} smoothness={3} castShadow>
        <meshStandardMaterial color="#bfe6c4" roughness={0.5} />
      </RoundedBox>
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[0.44, 0.07, 0.44]} />
        <meshStandardMaterial color="#ffe7b0" emissive="#ffd88a" emissiveIntensity={0.35} />
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
    const orbit = new THREE.Vector3(Math.cos(a) * 2.9, 3.3 + Math.sin(live.t * 1.3) * 0.15, Math.sin(a) * 2.9);
    orbit.y += (1 - s.bonus) * 8;
    orbit.lerp(away, s.met);
    g.current.position.copy(orbit);
    const sc = 0.8 * Math.min(s.bonus, 1) * (1 - s.missed) * (1 - s.met * 0.6);
    g.current.scale.setScalar(Math.max(sc, 0.0001));
    g.current.visible = sc > 0.002;
    inner.current.rotation.z = live.t * 4.5;
    g.current.lookAt(camera.position);
  });
  return (
    <group ref={g}>
      <mesh ref={inner} geometry={geo} castShadow>
        <meshStandardMaterial color="#fff7ef" roughness={0.35} metalness={0.05} emissive="#f3dcff" emissiveIntensity={0.3} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------- pilgrims

function usePilgrimLayout() {
  return useMemo(() => {
    const r = rng(42);
    // ring slots around the plinth, inner rings fill first
    const slots: THREE.Vector3[] = [];
    let ring = 0;
    while (slots.length < PILGRIMS) {
      const rad = PLINTH_R + 0.38 + ring * 0.25;
      const n = Math.floor((2 * Math.PI * rad) / 0.25);
      const off = ring * 0.37;
      for (let i = 0; i < n && slots.length < PILGRIMS; i++) {
        const a = off + (i / n) * Math.PI * 2;
        slots.push(new THREE.Vector3(Math.cos(a) * rad, 0, Math.sin(a) * rad));
      }
      ring++;
    }
    // shore spots, shuffled so arrivals come from everywhere
    const order = Array.from({ length: PILGRIMS }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const shore = order.map((k) => {
      const a = (k / PILGRIMS) * Math.PI * 2 + r() * 0.02;
      const d = SHORE_R - (k % 2) * 0.22 + r() * 0.05;
      return new THREE.Vector3(Math.cos(a) * d, 0, Math.sin(a) * d);
    });
    // arrival order: slot i fills when pilgrim i arrives; make the ring
    // assignment start near the pilgrim's own side to shorten walks
    return { slots, shore };
  }, []);
}

function Pilgrims() {
  const body = useRef<THREE.InstancedMesh>(null);
  const head = useRef<THREE.InstancedMesh>(null);
  const orbs = useRef<THREE.InstancedMesh>(null);
  const { slots, shore } = usePilgrimLayout();
  const state = useMemo(
    () => ({
      pos: shore.map((v) => v.clone()),
      moving: new Float32Array(PILGRIMS),
      orb: new Float32Array(PILGRIMS),
    }),
    [shore],
  );
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const colored = useRef(false);

  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const s = live.s;
    const t = live.t;
    if (!body.current || !head.current || !orbs.current) return;

    if (!colored.current) {
      const c = new THREE.Color();
      for (let i = 0; i < PILGRIMS; i++) {
        c.set(i < EARLY_COUNT ? PASTELS[i % PASTELS.length] : LATE_CLOAK);
        body.current.setColorAt(i, c);
      }
      if (body.current.instanceColor) body.current.instanceColor.needsUpdate = true;
      colored.current = true;
    }

    const earlyN = Math.round(s.early * EARLY_COUNT);
    const lateN = Math.round(s.late * (PILGRIMS - EARLY_COUNT));
    const goneHome = s.missed > 0.5;
    const tmp = new THREE.Vector3();

    for (let i = 0; i < PILGRIMS; i++) {
      const isEarly = i < EARLY_COUNT;
      const arrived = (isEarly ? i < earlyN : i - EARLY_COUNT < lateN) && !goneHome;
      const target = tmp.copy(arrived ? slots[i] : shore[i]);
      if (i === 0 && s.hesitate > 0.01 && !arrived) {
        const k = (0.5 + 0.5 * Math.sin(t * 1.1)) * 0.45 * s.hesitate;
        target.lerp(slots[0], k);
      }
      const p = state.pos[i];
      const dx = target.x - p.x;
      const dz = target.z - p.z;
      const d = Math.hypot(dx, dz);
      const speed = 1.5 + (i % 7) * 0.12;
      let facing = Math.atan2(-p.x, -p.z);
      if (d > 0.01) {
        const step = Math.min(d, speed * dt);
        p.x += (dx / d) * step;
        p.z += (dz / d) * step;
        facing = Math.atan2(dx, dz);
        state.moving[i] = Math.min(1, state.moving[i] + dt * 6);
      } else {
        state.moving[i] = Math.max(0, state.moving[i] - dt * 4);
      }
      const walkBob = Math.abs(Math.sin(t * 11 + i)) * 0.045 * state.moving[i];
      const cheer = arrived ? Math.abs(Math.sin(t * 5.5 + i * 0.7)) * 0.12 * s.met : 0;
      const y = walkBob + cheer;

      dummy.position.set(p.x, y + 0.12, p.z);
      dummy.rotation.set(0, facing, Math.sin(t * 11 + i) * 0.08 * state.moving[i]);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      body.current.setMatrixAt(i, dummy.matrix);

      dummy.position.set(p.x, y + 0.29, p.z);
      dummy.updateMatrix();
      head.current.setMatrixAt(i, dummy.matrix);

      // bonus orbs over early backers when the campaign misses
      const wantOrb = isEarly && i < earlyN && goneHome ? 1 : 0;
      state.orb[i] += (wantOrb - state.orb[i]) * (1 - Math.exp(-dt * 4));
      const o = state.orb[i];
      dummy.position.set(p.x, y + 0.5 + Math.sin(t * 2 + i) * 0.03 + (1 - o) * 1.5, p.z);
      dummy.rotation.set(0, t * 2 + i, 0);
      dummy.scale.setScalar(Math.max(o, 0.0001));
      dummy.updateMatrix();
      orbs.current.setMatrixAt(i, dummy.matrix);
    }
    body.current.instanceMatrix.needsUpdate = true;
    head.current.instanceMatrix.needsUpdate = true;
    orbs.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      <instancedMesh ref={body} args={[undefined, undefined, PILGRIMS]} castShadow frustumCulled={false}>
        <coneGeometry args={[0.075, 0.24, 7]} />
        <meshStandardMaterial roughness={0.7} flatShading />
      </instancedMesh>
      <instancedMesh ref={head} args={[undefined, undefined, PILGRIMS]} castShadow frustumCulled={false}>
        <sphereGeometry args={[0.052, 10, 8]} />
        <meshStandardMaterial color="#f6e6d8" roughness={0.6} />
      </instancedMesh>
      <instancedMesh ref={orbs} args={[undefined, undefined, PILGRIMS]} frustumCulled={false}>
        <octahedronGeometry args={[0.055, 0]} />
        <meshStandardMaterial color="#fff1c9" emissive="#ffd88a" emissiveIntensity={1.6} toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

// ---------------------------------------------------------------- recipient

function Recipient() {
  const geo = useMemo(() => makeIslandGeometry(1.9, 2.8, 4.2), []);
  const lantern = useRef<THREE.MeshStandardMaterial>(null);
  const planks = useRef<THREE.InstancedMesh>(null);
  const coins = useRef<THREE.InstancedMesh>(null);
  const N = 22;
  const COINS = 16;

  const path = useMemo(() => {
    const dir = new THREE.Vector3(RECIPIENT.x, 0, RECIPIENT.z).normalize();
    const a = dir.clone().multiplyScalar(ISLAND_R * 0.98);
    const b = RECIPIENT.clone().addScaledVector(dir, -1.7);
    return { a, b, dir };
  }, []);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame(() => {
    const s = live.s;
    if (lantern.current) lantern.current.emissiveIntensity = 0.2 + s.met * 2.4;
    if (planks.current) {
      const shown = s.met * N;
      for (let i = 0; i < N; i++) {
        const u = (i + 0.5) / N;
        const p = path.a.clone().lerp(path.b, u);
        p.y += Math.sin(u * Math.PI) * -0.25;
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
      const start = new THREE.Vector3(0, 2.0, 0);
      const pav = RECIPIENT.clone().add(new THREE.Vector3(0, 0.6, 0));
      for (let i = 0; i < COINS; i++) {
        const u = (live.t * 0.22 + i / COINS) % 1;
        let p: THREE.Vector3;
        if (u < 0.25) p = start.clone().lerp(path.a.clone().setY(0.35), u / 0.25);
        else if (u < 0.85) p = path.a.clone().setY(0.35).lerp(path.b.clone().setY(0.1), (u - 0.25) / 0.6);
        else p = path.b.clone().setY(0.1).lerp(pav, (u - 0.85) / 0.15);
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
        <mesh geometry={geo} receiveShadow>
          <meshStandardMaterial vertexColors flatShading roughness={0.95} />
        </mesh>
        {/* the venue */}
        <mesh position={[0, 0.06, 0]} castShadow receiveShadow>
          <boxGeometry args={[1.3, 0.12, 1.0]} />
          <meshStandardMaterial color="#f2efe8" />
        </mesh>
        {[
          [-0.52, -0.38],
          [0.52, -0.38],
          [-0.52, 0.38],
          [0.52, 0.38],
        ].map(([x, z], i) => (
          <mesh key={i} position={[x, 0.45, z]} castShadow>
            <cylinderGeometry args={[0.045, 0.045, 0.66, 8]} />
            <meshStandardMaterial color="#f7f4ee" />
          </mesh>
        ))}
        <mesh position={[0, 0.98, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
          <coneGeometry args={[0.98, 0.42, 4]} />
          <meshStandardMaterial color="#f4b9ab" flatShading />
        </mesh>
        <mesh position={[0, 0.55, 0]}>
          <sphereGeometry args={[0.12, 16, 12]} />
          <meshStandardMaterial ref={lantern} color="#fff1c9" emissive="#ffd88a" emissiveIntensity={0.2} toneMapped={false} />
        </mesh>
        <Glow
          color="#ffd88a"
          update={(sp, m) => {
            sp.position.set(0, 0.55, 0);
            sp.scale.setScalar(0.6 + live.s.met * 2.2);
            m.opacity = 0.15 + live.s.met * 0.7;
          }}
        />
      </group>
      <instancedMesh ref={planks} args={[undefined, undefined, N]} castShadow frustumCulled={false}>
        <boxGeometry args={[0.42, 0.045, 0.13]} />
        <meshStandardMaterial color="#e3c9b2" flatShading />
      </instancedMesh>
      <instancedMesh ref={coins} args={[undefined, undefined, COINS]} frustumCulled={false}>
        <cylinderGeometry args={[0.07, 0.07, 0.02, 14]} />
        <meshStandardMaterial color="#ffe7b0" emissive="#ffcf70" emissiveIntensity={1.4} toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

// ---------------------------------------------------------------- other campaigns

const OTHERS = [
  { x: -15, z: 6, y: -1.5, s: 0.42, fill: 0.8, c: "#f6c6d3" },
  { x: -9, z: -15, y: 1.2, s: 0.36, fill: 0.35, c: "#c9b8f2" },
  { x: 13, z: 12, y: -2.2, s: 0.4, fill: 1, c: "#a9d4f5" },
  { x: 4, z: -19, y: 0.4, s: 0.3, fill: 0.6, c: "#f8e3a1" },
  { x: -19, z: -6, y: 2.5, s: 0.3, fill: 0.2, c: "#b4e6c5" },
  { x: 18, z: -6, y: 1.8, s: 0.34, fill: 0.9, c: "#fbc8a4" },
  { x: -3, z: 17, y: 1.5, s: 0.33, fill: 0.5, c: "#c9b8f2" },
];

function OtherIslands() {
  const geo = useMemo(() => makeIslandGeometry(ISLAND_R, 5.5, 2.7), []);
  const refs = useRef<(THREE.Group | null)[]>([]);
  useFrame(() => {
    const m = live.s.many;
    refs.current.forEach((g, i) => {
      if (!g) return;
      const o = OTHERS[i];
      const delay = i * 0.06;
      const k = Math.min(Math.max((m - delay) / (1 - delay), 0), 1);
      g.position.set(o.x, o.y - (1 - k) * 30 + Math.sin(live.t * 0.6 + i) * 0.3, o.z);
      g.visible = k > 0.001;
    });
  });
  return (
    <group>
      {OTHERS.map((o, i) => (
        <group key={i} ref={(el) => { refs.current[i] = el; }} scale={o.s} visible={false}>
          <mesh geometry={geo}>
            <meshStandardMaterial vertexColors flatShading roughness={0.95} />
          </mesh>
          <mesh position={[0, 0.15, 0]}>
            <cylinderGeometry args={[1, 1.1, 0.3, 24]} />
            <meshStandardMaterial color="#f2efe8" />
          </mesh>
          <mesh position={[0, 0.3 + 1.2 * o.fill, 0]}>
            <cylinderGeometry args={[0.3, 0.3, 2.4 * o.fill, 20]} />
            <meshStandardMaterial color="#ffe7b0" emissive="#ffd88a" emissiveIntensity={0.9} toneMapped={false} />
          </mesh>
          <mesh position={[0, 3.2, 0]}>
            <octahedronGeometry args={[0.4, 0]} />
            <meshStandardMaterial color={o.c} emissive={o.c} emissiveIntensity={0.5} flatShading />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------- canvas

export default function IslandScene() {
  return (
    <Canvas
      orthographic
      flat
      shadows
      dpr={[1, 1.75]}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
      camera={{ position: [24, 20, 24], zoom: 50, near: 0.1, far: 200 }}
      onCreated={({ gl }) => gl.setClearColor(BG)}
    >
      <Director />
      <hemisphereLight args={["#fff6ea", "#40404c", 1.15]} />
      <directionalLight
        position={[6, 12, 5]}
        intensity={2.2}
        color="#fff3e2"
        castShadow
        shadow-mapSize={[1536, 1536]}
        shadow-camera-left={-9}
        shadow-camera-right={9}
        shadow-camera-top={9}
        shadow-camera-bottom={-9}
        shadow-bias={-0.0004}
      />
      <directionalLight position={[-8, 4, -6]} intensity={0.5} color="#d9d2ff" />
      <World>
        <Island />
        <Beacon />
        <MatchBlock />
        <BonusBoomerang />
        <Pilgrims />
        <Recipient />
        <OtherIslands />
        <Sparkles count={140} scale={[18, 9, 18]} position={[0, 3, 0]} size={2.2} speed={0.25} opacity={0.55} color="#ffffff" />
      </World>
    </Canvas>
  );
}
