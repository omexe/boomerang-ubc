"use client";

// v3 of the home scene: the hand-drawn isometric garden island as a flat
// pixel image, with a handful of gardeners walking its paths. Scrolling pans
// and zooms the camera to a different corner of the garden per section.

import { useEffect, useRef } from "react";
import { DOORS, doorGlow, maybeEnter, newVisit, stepVisit, type DoorVisit } from "@/components/garden/doors";
import { fitPixels } from "@/components/garden/pixels";
import { EARLY_COUNT, PILGRIMS, paramsAt, story } from "@/lib/story";
import {
  BODY,
  G_H,
  G_W,
  GARDENERS,
  gardenersFor,
  IMG_H,
  IMG_W,
  LEG_L,
  LEG_R,
  MEADOW,
  MIN_GARDENERS,
  NEIGHBOURS,
  NODES,
  STRIDE,
  U,
} from "@/components/garden/garden";

const EARLY_GARDENERS = Math.round((GARDENERS * EARLY_COUNT) / PILGRIMS); // 7

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

// three neighbouring gardens for "why now", placed around the main island
// (top-left corner of each, in main-island image pixels, at the 0.5 zoom)
const OTHERS = [
  { x: 1110, y: -340, s: 0.3 }, // upper right
  { x: -200, y: -300, s: 0.26 }, // upper left
  { x: -190, y: 930, s: 0.32 }, // lower left
];

const smooth = (t: number) => t * t * (3 - 2 * t);
function camAt(p: number, zoom: (z: number) => number = (z) => z) {
  const c = Math.min(Math.max(p, 0), CAM.length - 1);
  const i = Math.min(Math.floor(c), CAM.length - 2);
  const f = smooth(c - i);
  const a = CAM[i];
  const b = CAM[i + 1];
  // zoom in log space so it feels even
  const az = zoom(a.z);
  const bz = zoom(b.z);
  const z = Math.exp(Math.log(az) + (Math.log(bz) - Math.log(az)) * f);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z };
}

type G = {
  x: number;
  y: number;
  at: number; // node it is walking from
  to: number; // node it is walking to
  tx: number;
  ty: number;
  wait: number;
  speed: number;
  face: 1 | -1;
  shown: number;
  token: number;
  phase: number;
  el: HTMLDivElement | null;
  rig: HTMLDivElement | null;
  body: HTMLDivElement | null;
  legL: HTMLDivElement | null;
  legR: HTMLDivElement | null;
  tok: HTMLDivElement | null;
  visit: DoorVisit;
};

type Parts = Pick<G, "el" | "rig" | "body" | "legL" | "legR" | "tok">;

export default function IslandScene2D() {
  const world = useRef<HTMLDivElement>(null);
  const others = useRef<(HTMLImageElement | null)[]>([]);
  const art = useRef<HTMLImageElement>(null);
  const glows = useRef<(HTMLDivElement | null)[]>([]);
  const gEls = useRef<Parts[]>(
    Array.from({ length: GARDENERS }, () => ({ el: null, rig: null, body: null, legL: null, legR: null, tok: null })),
  );

  useEffect(() => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    story.note = "Gardeners grow as the campaign fills: 2 at the start, 12 at the goal.";
    const gs: G[] = Array.from({ length: GARDENERS }, (_, i) => {
      const meadow = [...MEADOW];
      const n = i < MIN_GARDENERS ? meadow[Math.floor(rand() * meadow.length)] : Math.floor(rand() * NODES.length);
      const [x, y] = NODES[n];
      return { x, y, at: n, to: n, tx: x, ty: y, wait: rand() * 2, speed: 11 + rand() * 5, face: 1, shown: 0, token: 0, phase: 0, visit: newVisit(), ...gEls.current[i] };
    });

    // step to a neighbouring node, leaning toward what the camera is looking at
    const pickTarget = (g: G, focus: { x: number; y: number; z: number }, homebody: boolean) => {
      const here = g.to;
      const allowed = NEIGHBOURS[here].filter((n) => !homebody || MEADOW.has(n));
      let options = allowed.filter((n) => n !== g.at);
      if (!options.length) options = allowed.length ? allowed : NEIGHBOURS[here];
      const weights = options.map((n) => {
        const [x, y] = NODES[n];
        const dist = Math.hypot(x - focus.x, y - focus.y);
        return 1 / (1 + (dist * focus.z) / 140) ** 2;
      });
      const total = weights.reduce((a, b) => a + b, 0);
      let r = rand() * total;
      let next = options[0];
      for (let k = 0; k < options.length; k++) {
        r -= weights[k];
        if (r <= 0) {
          next = options[k];
          break;
        }
      }
      g.at = here;
      g.to = next;
      g.tx = NODES[next][0] + (rand() - 0.5) * 6;
      g.ty = NODES[next][1] + (rand() - 0.5) * 4;
    };

    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const t = now / 1000;
      story.p += (story.target - story.p) * (1 - Math.exp(-dt * 3.2));
      const s = paramsAt(story.p);
      // camera: each section's zoom lands on a whole number of screen pixels per island pixel
      const w = window.innerWidth;
      const h = window.innerHeight;
      const dpr = window.devicePixelRatio || 1;
      const base = Math.min((w * 0.56) / IMG_W, (h * 0.86) / IMG_H);
      const cam = camAt(story.p, (z) => fitPixels(base * z, dpr, "nearest").scale / base);
      const scale = base * cam.z;
      const ax = w * 0.68;
      const ay = h * 0.48;
      const moving = Math.abs(story.target - story.p) > 0.002;
      if (world.current) {
        const px = fitPixels(scale, dpr, "nearest");
        const snap = moving ? (v: number) => v : px.snap;
        world.current.style.transform = `translate3d(${snap(ax - cam.x * scale)}px, ${snap(ay - cam.y * scale)}px, 0) scale(${scale})`;
        // while the camera moves, let the browser stretch a snapshot; at rest, redraw sharp
        world.current.style.willChange = moving ? "transform" : "auto";
        if (art.current) art.current.style.imageRendering = px.pixelated ? "pixelated" : "auto";
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
      const progress = (s.early * EARLY_COUNT + s.late * (PILGRIMS - EARLY_COUNT)) / PILGRIMS;
      const active = gardenersFor(Math.max(progress, s.met));
      const goneHome = s.missed > 0.5;

      gs.forEach((g, i) => {
        const on = i < active;
        g.shown += ((on ? 1 : 0) - g.shown) * (1 - Math.exp(-dt * 5));

        const hesitating = i < MIN_GARDENERS && s.hesitate > 0.5;
        if (hesitating) {
          // nobody wants to go first: both edge toward the bridge, then back off
          const k = 0.5 + 0.5 * Math.sin(t * 0.8 + i * 2.4);
          const [ax, ay] = NODES[i === 0 ? 21 : 18];
          const [bx, by] = NODES[19];
          g.tx = ax + (bx - ax) * k * 0.6;
          g.ty = ay + (by - ay) * k * 0.6;
          g.at = i === 0 ? 21 : 18;
          g.to = g.at;
        }

        const dx = g.tx - g.x;
        const dy = g.ty - g.y;
        const d = Math.hypot(dx, dy);
        const door = stepVisit(g, g.visit, dt, d <= 0.8, rand);
        let moving = false;
        if (d > 0.8 && (!door.busy || g.visit.stage === "walk")) {
          // ease out over the last few pixels so arrivals don't snap
          const step = Math.min(d, g.speed * dt * Math.min(1, d / 6 + 0.35));
          g.x += (dx / d) * step;
          g.y += (dy / d) * step;
          g.phase += (step / STRIDE) * Math.PI;
          // only turn around on a clear sideways move, so they don't flicker
          if (Math.abs(dx) / d > 0.35) g.face = dx > 0 ? -1 : 1;
          moving = true;
        } else if (!hesitating && !door.busy) {
          g.wait -= dt;
          if (g.wait <= 0 && i >= MIN_GARDENERS && maybeEnter(g, g.visit, rand)) {
            g.wait = 0;
          } else if (g.wait <= 0) {
            pickTarget(g, cam, i < MIN_GARDENERS);
            // stroll through path bends, linger at ends and junctions
            g.wait = NEIGHBOURS[g.to].length === 2 ? 0.1 + rand() * 0.6 : 1.5 + rand() * 3.5;
          }
        }
        if (!moving) {
          // settle the legs back under the body
          const rest = Math.round(g.phase / Math.PI) * Math.PI;
          g.phase += (rest - g.phase) * (1 - Math.exp(-dt * 10));
        }

        const want = i < EARLY_GARDENERS && goneHome && on ? 1 : 0;
        g.token += (want - g.token) * (1 - Math.exp(-dt * 4));

        // walk cycle, snapped to whole sprite pixels
        const sw = Math.sin(g.phase);
        const liftL = Math.round(Math.max(0, sw) * 2) * U;
        const liftR = Math.round(Math.max(0, -sw) * 2) * U;
        const swingL = Math.round(sw * 1.5) * U;
        const bob = Math.round(Math.abs(sw)) * U;
        const cheer = s.met > 0.5 && on ? Math.round(Math.max(0, Math.sin(t * 4 + i * 1.7)) * 4) * U : 0;

        if (g.el) {
          g.el.style.transform = `translate3d(${(g.x - G_W / 2).toFixed(2)}px, ${(g.y - G_H - cheer).toFixed(2)}px, 0)`;
          g.el.style.opacity = (g.shown * door.show).toFixed(3);
          g.el.style.zIndex = String(Math.round(g.y));
        }
        if (g.rig) g.rig.style.transform = `scaleX(${g.face}) scale(${(0.82 + 0.18 * door.show).toFixed(3)})`;
        if (g.body) g.body.style.transform = `translate3d(0, ${(-bob).toFixed(2)}px, 0)`;
        if (g.legL) g.legL.style.transform = `translate3d(${swingL.toFixed(2)}px, ${(-liftL).toFixed(2)}px, 0)`;
        if (g.legR) g.legR.style.transform = `translate3d(${(-swingL).toFixed(2)}px, ${(-liftR).toFixed(2)}px, 0)`;
        if (g.tok) {
          g.tok.style.opacity = g.token.toFixed(3);
          g.tok.style.transform = `translate3d(-50%, ${(-6 - (1 - g.token) * 20 + Math.sin(t * 2 + i) * 1.2).toFixed(2)}px, 0)`;
        }
      });
      const glow = doorGlow(gs.map((g) => g.visit));
      DOORS.forEach((dr, k) => {
        const el = glows.current[k];
        if (el) el.style.opacity = (glow.get(dr.id) ?? 0).toFixed(3);
      });

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="absolute inset-0 overflow-hidden" style={{ background: "#1d1d1d" }}>
      <div ref={world} className="absolute left-0 top-0 origin-top-left" style={{ width: IMG_W, height: IMG_H }}>
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
            className="absolute left-0 top-0 origin-top-left"
            style={{ width: IMG_W, height: IMG_H, opacity: 0 }}
          />
        ))}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img ref={art} src="/island.png" alt="" draggable={false} className="absolute left-0 top-0" style={{ width: IMG_W, height: IMG_H }} />
        {DOORS.map((dr, k) => (
          <div key={dr.id} ref={(el) => { glows.current[k] = el; }} className="pointer-events-none absolute" style={{ left: dr.at[0] - 9, top: dr.at[1] - 24, width: 18, height: 26, opacity: 0, zIndex: dr.at[1] - 2, background: "radial-gradient(ellipse at 50% 70%, rgba(255,214,130,0.85), rgba(255,214,130,0) 70%)", mixBlendMode: "screen" }} />
        ))}
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
            <div
              ref={(el) => {
                gEls.current[i].rig = el;
              }}
              className="absolute inset-0 origin-bottom"
            >
              {[
                { r: BODY, key: "body" as const },
                { r: LEG_L, key: "legL" as const },
                { r: LEG_R, key: "legR" as const },
              ].map(({ r, key }) => (
                <div
                  key={key}
                  ref={(el) => {
                    gEls.current[i][key] = el;
                  }}
                  className="pixelated absolute"
                  style={{
                    left: r.x * U,
                    top: r.y * U,
                    width: r.w * U,
                    height: r.h * U,
                    backgroundImage: `url(${i < EARLY_GARDENERS ? "/pilgrim.png" : "/pilgrim-late.png"})`,
                    backgroundSize: `${G_W}px ${G_H}px`,
                    backgroundPosition: `${-r.x * U}px ${-r.y * U}px`,
                    zIndex: key === "body" ? 1 : 0,
                  }}
                />
              ))}
            </div>
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
