"use client";

// The garden on a campaign page: the whole island with as many gardeners as the campaign has
// earned (2 + round(10 × raised ÷ goal), capped at 12). Early backers wear the full-colour
// sprite, late ones the faded one; on a miss the early ones carry a bonus token, on success they hop.

import { useEffect, useRef } from "react";
import { DOORS, doorGlow, maybeEnter, newVisit, stepVisit } from "./doors";
import { BODY, G_H, G_W, GARDENERS, gardenersFor, IMG_H, IMG_W, LEG_L, LEG_R, NEIGHBOURS, NODES, STRIDE, U } from "./garden";
import { fitPixels } from "./pixels";

type Parts = { el: HTMLDivElement | null; rig: HTMLDivElement | null; body: HTMLDivElement | null; legL: HTMLDivElement | null; legR: HTMLDivElement | null; tok: HTMLDivElement | null };

export type GardenState = {
  /** raised ÷ goal, 0..1 (1 once funded). */
  progress: number;
  /** Share of what was raised that came in the early window, 0..1. */
  earlyShare: number;
  outcome: "live" | "met" | "missed" | "void";
};

export function GardenMini({ state }: { state: GardenState }) {
  const box = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const art = useRef<HTMLImageElement>(null);
  const glows = useRef<(HTMLDivElement | null)[]>([]);
  const parts = useRef<Parts[]>(Array.from({ length: GARDENERS }, () => ({ el: null, rig: null, body: null, legL: null, legR: null, tok: null })));
  const live = useRef(state);
  live.current = state;
  const active = gardenersFor(state.outcome === "met" ? 1 : state.progress);
  const early = Math.round(active * Math.min(Math.max(state.earlyShare, 0), 1));

  // fit the island to the card's width
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // whole device pixels per island pixel when zoomed in enough to see them; smooth otherwise
    const fit = () => {
      const f = fitPixels(el.clientWidth / IMG_W, window.devicePixelRatio || 1);
      const dx = (el.clientWidth - IMG_W * f.scale) / 2;
      const dy = (el.clientHeight - IMG_H * f.scale) / 2;
      if (world.current) world.current.style.transform = `translate(${f.snap(dx)}px, ${f.snap(dy)}px) scale(${f.scale})`;
      if (art.current) art.current.style.imageRendering = f.pixelated ? "pixelated" : "auto";
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let seed = 11;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const gs = parts.current.map((p) => {
      const n = Math.floor(rand() * NODES.length);
      return { ...p, x: NODES[n][0], y: NODES[n][1], at: n, to: n, tx: NODES[n][0], ty: NODES[n][1], wait: rand() * 2, speed: 11 + rand() * 5, face: 1, shown: 0, token: 0, phase: 0, visit: newVisit() };
    });
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const t = now / 1000;
      const s = live.current;
      const n = gardenersFor(s.outcome === "met" ? 1 : s.progress);
      const e = Math.round(n * Math.min(Math.max(s.earlyShare, 0), 1));
      gs.forEach((g, i) => {
        g.shown += ((i < n ? 1 : 0) - g.shown) * (1 - Math.exp(-dt * 5));
        const dx = g.tx - g.x;
        const dy = g.ty - g.y;
        const d = Math.hypot(dx, dy);
        const door = stepVisit(g, g.visit, dt, d <= 0.8, rand);
        let moving = false;
        if (d > 0.8 && (!door.busy || g.visit.stage === "walk")) {
          const step = Math.min(d, g.speed * dt * Math.min(1, d / 6 + 0.35));
          g.x += (dx / d) * step;
          g.y += (dy / d) * step;
          g.phase += (step / STRIDE) * Math.PI;
          if (Math.abs(dx) / d > 0.35) g.face = dx > 0 ? -1 : 1;
          moving = true;
        } else if (!door.busy) {
          g.wait -= dt;
          if (g.wait <= 0 && maybeEnter(g, g.visit, rand)) {
            g.wait = 0;
          } else if (g.wait <= 0) {
            const here = g.to;
            let options = NEIGHBOURS[here].filter((k) => k !== g.at);
            if (!options.length) options = NEIGHBOURS[here];
            const next = options[Math.floor(rand() * options.length)];
            g.at = here;
            g.to = next;
            g.tx = NODES[next][0] + (rand() - 0.5) * 6;
            g.ty = NODES[next][1] + (rand() - 0.5) * 4;
            g.wait = NEIGHBOURS[next].length === 2 ? 0.1 + rand() * 0.6 : 1.5 + rand() * 3.5;
          }
        }
        if (!moving) {
          const rest = Math.round(g.phase / Math.PI) * Math.PI;
          g.phase += (rest - g.phase) * (1 - Math.exp(-dt * 10));
        }
        const want = s.outcome === "missed" && i < e && i < n ? 1 : 0;
        g.token += (want - g.token) * (1 - Math.exp(-dt * 4));
        const sw = Math.sin(g.phase);
        const liftL = Math.round(Math.max(0, sw) * 2) * U;
        const liftR = Math.round(Math.max(0, -sw) * 2) * U;
        const swing = Math.round(sw * 1.5) * U;
        const bob = Math.round(Math.abs(sw)) * U;
        const cheer = s.outcome === "met" && i < n ? Math.round(Math.max(0, Math.sin(t * 4 + i * 1.7)) * 4) * U : 0;
        if (g.el) {
          g.el.style.transform = `translate3d(${(g.x - G_W / 2).toFixed(2)}px, ${(g.y - G_H - cheer).toFixed(2)}px, 0)`;
          g.el.style.opacity = (g.shown * door.show).toFixed(3);
          g.el.style.zIndex = String(Math.round(g.y));
        }
        if (g.rig) g.rig.style.transform = `scaleX(${g.face}) scale(${(0.82 + 0.18 * door.show).toFixed(3)})`;
        if (g.body) g.body.style.transform = `translate3d(0, ${(-bob).toFixed(2)}px, 0)`;
        if (g.legL) g.legL.style.transform = `translate3d(${swing.toFixed(2)}px, ${(-liftL).toFixed(2)}px, 0)`;
        if (g.legR) g.legR.style.transform = `translate3d(${(-swing).toFixed(2)}px, ${(-liftR).toFixed(2)}px, 0)`;
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
    <div ref={box} className="relative w-full overflow-hidden" style={{ aspectRatio: `${IMG_W} / ${IMG_H}` }} aria-hidden>
      <div ref={world} className="absolute left-0 top-0 origin-top-left" style={{ width: IMG_W, height: IMG_H }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img ref={art} src="/island.png" alt="" draggable={false} className="absolute left-0 top-0" style={{ width: IMG_W, height: IMG_H }} />
        {DOORS.map((dr, k) => (
          <div key={dr.id} ref={(el) => { glows.current[k] = el; }} className="pointer-events-none absolute" style={{ left: dr.at[0] - 9, top: dr.at[1] - 24, width: 18, height: 26, opacity: 0, zIndex: dr.at[1] - 2, background: "radial-gradient(ellipse at 50% 70%, rgba(255,214,130,0.85), rgba(255,214,130,0) 70%)", mixBlendMode: "screen" }} />
        ))}
        {Array.from({ length: GARDENERS }, (_, i) => (
          <div key={i} ref={(el) => { parts.current[i].el = el; }} className="absolute left-0 top-0" style={{ width: G_W, height: G_H, opacity: 0 }}>
            <div className="absolute left-1/2 rounded-[50%]" style={{ bottom: -2, width: G_W * 0.7, height: 5, marginLeft: -G_W * 0.35, background: "rgba(40,30,15,0.35)" }} />
            <div ref={(el) => { parts.current[i].rig = el; }} className="absolute inset-0 origin-bottom">
              {([
                { r: BODY, key: "body" },
                { r: LEG_L, key: "legL" },
                { r: LEG_R, key: "legR" },
              ] as const).map(({ r, key }) => (
                <div
                  key={key}
                  ref={(el) => { parts.current[i][key] = el; }}
                  className="pixelated absolute"
                  style={{
                    left: r.x * U,
                    top: r.y * U,
                    width: r.w * U,
                    height: r.h * U,
                    backgroundImage: `url(${i < early ? "/pilgrim.png" : "/pilgrim-late.png"})`,
                    backgroundSize: `${G_W}px ${G_H}px`,
                    backgroundPosition: `${-r.x * U}px ${-r.y * U}px`,
                    zIndex: key === "body" ? 1 : 0,
                  }}
                />
              ))}
            </div>
            <div
              ref={(el) => { parts.current[i].tok = el; }}
              className="absolute left-1/2 top-0"
              style={{ width: 7, height: 7, background: "#ffd970", boxShadow: "0 0 0 1px #8a5a20, 0 0 8px 2px rgba(255,217,112,0.6)", opacity: 0 }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
