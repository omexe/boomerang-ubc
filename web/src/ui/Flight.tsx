// The landing page's right-hand scene. A guilloche rosette, a hand-drawn fallback, and a canvas
// that the three.js flight takes over once it has loaded. Two pins ride the thrower and the
// target; two captions alternate with the flight's phase. three.js is imported dynamically so it
// sits in its own chunk and never blocks first paint; until it draws, the fallback is what shows.
import { useEffect, useRef } from "react";

import { Rosette } from "./Guilloche.tsx";

export function Flight() {
  const sceneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const goalRef = useRef<HTMLSpanElement>(null);
  const homeRef = useRef<HTMLSpanElement>(null);
  const metRef = useRef<HTMLParagraphElement>(null);
  const missedRef = useRef<HTMLParagraphElement>(null);
  const roseRef = useRef<SVGGElement>(null);

  // Load and mount the flight after first paint. A failed import or no WebGL leaves the fallback.
  useEffect(() => {
    const canvas = canvasRef.current, scene = sceneRef.current;
    if (!canvas || !scene) return;
    let dispose: (() => void) | null = null;
    let cancelled = false;
    import("./flight.ts")
      .then(({ mountFlight }) => {
        if (cancelled) return;
        dispose = mountFlight(canvas, {
          style: "security",
          scale: 0.95,
          parallax: true,
          sequence: [["met", 4.0], ["hold-met", 1.9], ["missed", 6.0], ["hold-missed", 1.9]],
          colors: { ink: "#12392c", trail: "#b8352a", trailMet: "#12392c", mark: "#2f5546" },
          anchors: { goal: goalRef.current, home: homeRef.current },
          onPhase(p) {
            metRef.current?.classList.toggle("on", p === "met");
            missedRef.current?.classList.toggle("on", p === "missed");
            goalRef.current?.classList.toggle("on", p === "met");
            homeRef.current?.classList.toggle("on", p === "missed");
          },
        });
        scene.classList.add("live");
      })
      .catch(() => {
        // Leave the fallback drawing in place; the scene never gets the "live" class.
      });
    return () => { cancelled = true; dispose?.(); scene.classList.remove("live"); };
  }, []);

  // Trace the rosette in once, then turn it forever about its own centre. Neither under reduced
  // motion. The trace needs each path's measured length, so it runs through the Web Animations
  // API; the turn is the rose-turn keyframe, started inline so this file carries no new selector.
  useEffect(() => {
    const g = roseRef.current;
    if (!g) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const anims: Animation[] = [];
    g.querySelectorAll<SVGPathElement>("path").forEach((p, i) => {
      const length = p.getTotalLength();
      p.style.strokeDasharray = String(length);
      anims.push(
        p.animate([{ strokeDashoffset: String(length) }, { strokeDashoffset: "0" }], {
          duration: 2600,
          delay: 200 + i * 180,
          easing: "cubic-bezier(0.45, 0, 0.55, 1)",
          fill: "forwards",
        }),
      );
    });
    g.style.transformBox = "fill-box";
    g.style.transformOrigin = "center";
    g.style.animation = "rose-turn 240s linear infinite";
    return () => {
      for (const a of anims) a.cancel();
      g.style.animation = "";
    };
  }, []);

  return (
    <div className="scene" ref={sceneRef}>
      <Rosette groupRef={roseRef} />
      <svg className="fallback" viewBox="0 0 200 200" aria-hidden="true">
        <path d="M100 170 C 30 150, 30 40, 100 40 C 170 40, 170 150, 104 166" fill="none" stroke="#b8352a" strokeWidth="1.2" strokeDasharray="4 4" />
        <ellipse cx="100" cy="174" rx="16" ry="5" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <g transform="translate(100 40) rotate(-12) scale(1.3)">
          <path d="M-17 6 Q-11 -9 0 -9 Q11 -9 17 6 Q18.5 9 16 9.6 Q11 -1 0 -1 Q-11 -1 -16 9.6 Q-18.5 9 -17 6Z" fill="currentColor" />
        </g>
      </svg>
      <canvas ref={canvasRef} aria-hidden="true" />
      <span className="pin goal" ref={goalRef} aria-hidden="true">Recipient</span>
      <span className="pin home" ref={homeRef} aria-hidden="true">You</span>
      <div className="caps" aria-hidden="true">
        <p className="cap met" ref={metRef}><b>Cleared.</b> Target met: it lands with the recipient.</p>
        <p className="cap missed" ref={missedRef}><b>Returned.</b> Target missed: it comes back to you, with a bonus.</p>
      </div>
      <p className="sr-only">A boomerang in flight. When a campaign meets its target it lands with the recipient. When it misses, it comes back to you, with a bonus.</p>
    </div>
  );
}
