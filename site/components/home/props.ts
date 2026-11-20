// The props that come into focus on the home page, one theme per section. The sprites are
// drawn by scripts/props.py into public/props/; this file says where each one stands on the
// island (bottom centre, in island-image pixels), how big it is drawn (island pixels per sprite
// pixel), which section brings it in, and how it moves.

export type Prop = {
  id: string;
  src: string;
  w: number; // sprite size, in sprite pixels
  h: number;
  at: [number, number];
  scale: number;
  section: number;
  move?: "wobble" | "sway" | "orbit" | "drift" | "fill";
};

export const PROPS: Prop[] = [
  // 1 · nobody wants to go first: an empty jar by the bridge
  { id: "jar", src: "/props/jar.png", w: 22, h: 32, at: [528, 616], scale: 1.5, section: 1, move: "wobble" },
  // 2 · a DAO puts money down first: the match and the bonus, locked at the gazebo
  { id: "chest-match", src: "/props/chest-match.png", w: 30, h: 26, at: [686, 376], scale: 1.3, section: 2 },
  { id: "chest-bonus", src: "/props/chest-bonus.png", w: 30, h: 26, at: [741, 386], scale: 1.3, section: 2 },
  // 3 · pledge early and win either way: seedlings with a gold bud
  { id: "seedlings", src: "/props/seedlings.png", w: 28, h: 24, at: [266, 434], scale: 1.5, section: 3 },
  // 4 · late pledges still count: a goal meter that fills as pledges come in
  { id: "goal-sign", src: "/props/goal-sign.png", w: 20, h: 38, at: [500, 450], scale: 1.6, section: 4, move: "fill" },
  // 5 · the cause gets every pledge plus the match: bunting on the pergola
  { id: "bunting", src: "/props/bunting.png", w: 76, h: 22, at: [758, 528], scale: 1.3, section: 5, move: "sway" },
  // 6 · everyone gets their money back: a boomerang circling the shed
  { id: "boomerang", src: "/props/boomerang.png", w: 26, h: 18, at: [880, 398], scale: 1.5, section: 6, move: "orbit" },
  // 7 · money already moves onchain: a balloon drifting between the gardens
  { id: "balloon", src: "/props/balloon.png", w: 32, h: 46, at: [840, 190], scale: 3.2, section: 7, move: "drift" },
  // 8 · back one, or start one: a signpost at the front
  { id: "signpost", src: "/props/signpost.png", w: 36, h: 36, at: [590, 622], scale: 1.8, section: 8 },
];

// the goal meter's tube, in sprite pixels (from scripts/props.py)
export const GOAL_FILL = { x: 8, y: 5, w: 4, h: 13 };

const easeOutBack = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;

/** Place and animate every prop for story position `p` at time `t` (seconds). */
export function updateProps(els: (HTMLDivElement | null)[], fills: (HTMLDivElement | null)[], p: number, t: number, o: { progress: number; met: boolean }) {
  PROPS.forEach((prop, i) => {
    const el = els[i];
    if (!el) return;
    const near = Math.min(Math.max(1 - Math.abs(p - prop.section) * 1.6, 0), 1);
    const k = near * near * (3 - 2 * near);
    el.style.opacity = k.toFixed(3);
    el.style.visibility = k < 0.01 ? "hidden" : "visible";
    const pop = 0.7 + 0.3 * easeOutBack(k);
    let dx = 0;
    let dy = 0;
    let turn = 0;
    if (prop.move === "wobble") turn = Math.sin(t * 2.2) * 3;
    if (prop.move === "sway") turn = Math.sin(t * 1.4) * 1.2;
    if (prop.move === "orbit") {
      const a = t * 1.8;
      dx = Math.cos(a) * 40;
      dy = Math.sin(a) * 14 - 8;
      turn = (t * 720) % 360;
    }
    if (prop.move === "drift") {
      dx = Math.sin(t * 0.25) * 40;
      dy = Math.sin(t * 0.8) * 4;
    }
    el.style.transform = `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0) rotate(${turn.toFixed(2)}deg) scale(${pop.toFixed(3)})`;
    const fill = fills[i];
    if (fill && prop.move === "fill") {
      const f = Math.min(Math.max(o.progress, 0), 1);
      fill.style.top = `${(GOAL_FILL.y + GOAL_FILL.h * (1 - f)) * prop.scale}px`;
      fill.style.height = `${GOAL_FILL.h * f * prop.scale}px`;
      fill.style.background = o.met ? "#708a45" : "#b8543c";
    }
  });
}
