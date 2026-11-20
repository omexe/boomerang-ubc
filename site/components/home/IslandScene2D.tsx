"use client";

// v3 of the home scene: the hand-drawn isometric garden island as a flat
// pixel image, with a handful of gardeners walking its paths. Scrolling pans
// and zooms the camera to a different corner of the garden per section.

import { useEffect, useRef } from "react";
import { EARLY_COUNT, PILGRIMS, paramsAt, story } from "@/lib/story";

const IMG_W = 986;
const IMG_H = 853;
const GARDENERS = 12;
const EARLY_GARDENERS = Math.round((GARDENERS * EARLY_COUNT) / PILGRIMS); // 7
const G_H = 38; // gardener height in island-image pixels
const G_W = G_H * (53 / 67);

// Walkable spots on the island image (paths, lawns, meadow), in image pixels.
const SPOTS: [number, number][] = [
  [235, 345], [300, 352], [365, 365], [430, 348], [472, 272], [522, 300], [602, 266],
  [642, 300], [690, 362], [760, 420], [818, 452], [858, 470], [560, 372], [622, 420],
  [700, 452], [762, 500], [822, 522], [472, 470], [522, 442], [582, 470], [422, 432],
  [202, 430], [262, 410], [242, 462], [302, 520], [362, 546], [440, 560], [512, 540],
  [590, 560], [652, 590], [702, 560], [762, 602], [422, 642], [482, 690], [562, 662],
  [622, 622], [382, 602],
];

// Camera per section: focus point on the image and zoom (1 = whole island).
const CAM: { x: number; y: number; z: number }[] = [
  { x: 493, y: 430, z: 1.0 }, // 0 hero: the whole garden
  { x: 470, y: 610, z: 2.1 }, // 1 problem: the empty front meadow
  { x: 712, y: 330, z: 2.5 }, // 2 sponsor: the gazebo
  { x: 236, y: 430, z: 2.1 }, // 3 early backers: the vegetable beds
  { x: 505, y: 440, z: 1.6 }, // 4 late backers: the big meadow
  { x: 760, y: 520, z: 2.0 }, // 5 goal met: the pergola
  { x: 880, y: 430, z: 2.2 }, // 6 goal missed: the shed
  { x: 493, y: 430, z: 0.5 }, // 7 why now: pull back to see other gardens
  { x: 493, y: 430, z: 1.05 }, // 8 call to action
];

const OTHERS = [
  { x: -260, y: -620, s: 0.3 },
  { x: 1180, y: -330, s: 0.34 },
  { x: 1250, y: 520, s: 0.34 },
  { x: 1380, y: -60, s: 0.26 },
  { x: 260, y: 1080, s: 0.36 },
  { x: 900, y: 1150, s: 0.28 },
];

const smooth = (t: number) => t * t * (3 - 2 * t);
function camAt(p: number) {
  const c = Math.min(Math.max(p, 0), CAM.length - 1);
  const i = Math.min(Math.floor(c), CAM.length - 2);
  const f = smooth(c - i);
  const a = CAM[i];
  const b = CAM[i + 1];
  // zoom in log space so it feels even
  const z = Math.exp(Math.log(a.z) + (Math.log(b.z) - Math.log(a.z)) * f);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z };
}

type G = {
  x: number;
  y: number;
  tx: number;
  ty: number;
  wait: number;
  speed: number;
  face: 1 | -1;
  shown: number;
  token: number;
  el: HTMLDivElement | null;
  img: HTMLImageElement | null;
  tok: HTMLDivElement | null;
};

export default function IslandScene2D() {
  const world = useRef<HTMLDivElement>(null);
  const others = useRef<(HTMLImageElement | null)[]>([]);
  const gEls = useRef<{ el: HTMLDivElement | null; img: HTMLImageElement | null; tok: HTMLDivElement | null }[]>(
    Array.from({ length: GARDENERS }, () => ({ el: null, img: null, tok: null })),
  );

  useEffect(() => {
    story.note = "";
    let seed = 7;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const gs: G[] = Array.from({ length: GARDENERS }, (_, i) => {
      const [x, y] = SPOTS[Math.floor(rand() * SPOTS.length)];
      return { x, y, tx: x, ty: y, wait: rand() * 2, speed: 26 + rand() * 14, face: 1, shown: 0, token: 0, ...gEls.current[i] };
    });

    const pickTarget = (g: G, focus: { x: number; y: number; z: number }) => {
      // prefer spots inside the current view so the camera always has company
      const radius = 520 / focus.z;
      const near = SPOTS.filter(([x, y]) => Math.hypot(x - focus.x, y - focus.y) < radius && Math.hypot(x - g.x, y - g.y) < 260);
      const pool = near.length ? near : SPOTS.filter(([x, y]) => Math.hypot(x - g.x, y - g.y) < 200);
      const [x, y] = (pool.length ? pool : SPOTS)[Math.floor(rand() * (pool.length || SPOTS.length))];
      g.tx = x + (rand() - 0.5) * 16;
      g.ty = y + (rand() - 0.5) * 10;
    };

    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const t = now / 1000;
      story.p += (story.target - story.p) * (1 - Math.exp(-dt * 3.2));
      const s = paramsAt(story.p);
      const cam = camAt(story.p);

      // camera
      const w = window.innerWidth;
      const h = window.innerHeight;
      const base = Math.min((w * 0.56) / IMG_W, (h * 0.86) / IMG_H);
      const scale = base * cam.z;
      const ax = w * 0.68;
      const ay = h * 0.48;
      if (world.current) {
        world.current.style.transform = `translate3d(${ax - cam.x * scale}px, ${ay - cam.y * scale}px, 0) scale(${scale})`;
      }

      // other gardens rise in for "why now"
      others.current.forEach((el, i) => {
        if (!el) return;
        const delay = i * 0.08;
        const k = Math.min(Math.max((s.many - delay) / (1 - delay), 0), 1);
        el.style.transform = `translate3d(${OTHERS[i].x}px, ${OTHERS[i].y + (1 - smooth(k)) * 900}px, 0) scale(${OTHERS[i].s})`;
        el.style.opacity = String(k);
      });

      // how many gardeners are out
      const fill = s.early * 0.6 + s.late * 0.4;
      const active = s.hesitate > 0.5 ? 1 : Math.round(3 + fill * (GARDENERS - 3));
      const goneHome = s.missed > 0.5;

      gs.forEach((g, i) => {
        const on = i < active;
        g.shown += ((on ? 1 : 0) - g.shown) * (1 - Math.exp(-dt * 5));

        if (i === 0 && s.hesitate > 0.5) {
          // the one who almost goes first: steps toward the gate, then back
          const k = 0.5 + 0.5 * Math.sin(t * 0.9);
          g.tx = 440 + k * 60;
          g.ty = 640 - k * 30;
        }

        const dx = g.tx - g.x;
        const dy = g.ty - g.y;
        const d = Math.hypot(dx, dy);
        let moving = false;
        if (d > 1.5) {
          const step = Math.min(d, g.speed * dt);
          g.x += (dx / d) * step;
          g.y += (dy / d) * step;
          if (Math.abs(dx) > 0.5) g.face = dx > 0 ? -1 : 1;
          moving = true;
        } else if (!(i === 0 && s.hesitate > 0.5)) {
          g.wait -= dt;
          if (g.wait <= 0) {
            pickTarget(g, cam);
            g.wait = 1.2 + rand() * 3;
          }
        }

        const want = i < EARLY_GARDENERS && goneHome && on ? 1 : 0;
        g.token += (want - g.token) * (1 - Math.exp(-dt * 4));

        // hops snap to whole image pixels so motion stays crisp
        const hop = moving ? Math.round(Math.abs(Math.sin(t * 9 + i)) * 2) : 0;
        const cheer = s.met > 0.5 && on ? Math.round(Math.abs(Math.sin(t * 5 + i)) * 4) : 0;
        if (g.el) {
          g.el.style.transform = `translate3d(${Math.round(g.x - G_W / 2)}px, ${Math.round(g.y - G_H - hop - cheer)}px, 0)`;
          g.el.style.opacity = g.shown.toFixed(3);
          g.el.style.zIndex = String(Math.round(g.y));
        }
        if (g.img) g.img.style.transform = `scaleX(${g.face})`;
        if (g.tok) {
          g.tok.style.opacity = g.token.toFixed(3);
          g.tok.style.transform = `translate3d(-50%, ${Math.round(-6 - (1 - g.token) * 20 + Math.sin(t * 3 + i) * 1.5)}px, 0)`;
        }
      });

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="absolute inset-0 overflow-hidden" style={{ background: "#1d1d1d" }}>
      <div ref={world} className="absolute left-0 top-0 origin-top-left will-change-transform" style={{ width: IMG_W, height: IMG_H }}>
        {OTHERS.map((_, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={`o${i}`}
            ref={(el) => {
              others.current[i] = el;
            }}
            src="/island.png"
            alt=""
            draggable={false}
            className="pixelated absolute left-0 top-0 origin-top-left"
            style={{ width: IMG_W, height: IMG_H, opacity: 0 }}
          />
        ))}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/island.png" alt="" draggable={false} className="pixelated absolute left-0 top-0" style={{ width: IMG_W, height: IMG_H }} />
        {Array.from({ length: GARDENERS }, (_, i) => (
          <div
            key={i}
            ref={(el) => {
              gEls.current[i].el = el;
            }}
            className="absolute left-0 top-0"
            style={{ width: G_W, height: G_H, opacity: 0 }}
          >
            {/* ground shadow */}
            <div className="absolute left-1/2 rounded-[50%]" style={{ bottom: -2, width: G_W * 0.7, height: 5, marginLeft: -G_W * 0.35, background: "rgba(40,30,15,0.35)" }} />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={(el) => {
                gEls.current[i].img = el;
              }}
              src={i < EARLY_GARDENERS ? "/pilgrim.png" : "/pilgrim-late.png"}
              alt=""
              draggable={false}
              className="pixelated absolute inset-0 h-full w-full"
            />
            {/* bonus token, shown over early backers when a campaign misses */}
            <div
              ref={(el) => {
                gEls.current[i].tok = el;
              }}
              className="absolute left-1/2 top-0"
              style={{ width: 7, height: 7, background: "#ffd970", boxShadow: "0 0 0 1px #8a5a20, 0 0 8px 2px rgba(255,217,112,0.6)", opacity: 0 }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
