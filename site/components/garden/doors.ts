// Doors on the island. The art is island.png, the walkable paths are NODES and EDGES in
// garden.ts, and this file holds only the door links: where each doorway is in the image, the
// path node it opens onto, and the door a gardener comes out of after going in.
//
// A gardener standing on a door's node sometimes walks into the doorway, fades into it, waits
// inside, and comes out of the paired door; then it walks back onto that door's node. A
// cooldown keeps it from going straight back in.
import { NODES } from "./garden";

export type Door = { id: string; at: [number, number]; node: number; to: string };

export const DOORS: Door[] = [
  { id: "shed", at: [899, 461], node: 13, to: "potting-shed" }, // the wooden shed, right
  { id: "potting-shed", at: [213, 343], node: 0, to: "shed" }, // the potting shed beside the greenhouse
  { id: "gazebo", at: [712, 361], node: 9, to: "gazebo" }, // in and out of the gazebo
];

const BY_ID = new Map(DOORS.map((d) => [d.id, d]));
const AT_NODE = new Map(DOORS.map((d) => [d.node, d]));

const CHANCE = 0.4; // of taking a door, on reaching its node
const COOLDOWN = 16; // seconds before the same gardener may take any door again
const FADE = 0.4; // seconds to step into, or out of, a doorway

export type DoorVisit = {
  door: Door | null;
  stage: "walk" | "in" | "inside" | "out";
  t: number;
  cool: number;
  /** 1 at the moment someone passes a door, decaying: drives the doorway's glow. */
  flash: Map<string, number>;
};

export const newVisit = (): DoorVisit => ({ door: null, stage: "walk", t: 0, cool: 3 + Math.random() * 8, flash: new Map() });

type Walker = { x: number; y: number; at: number; to: number; tx: number; ty: number };

/** On reaching a node: maybe head into its door. True if the gardener is now going in. */
export function maybeEnter(g: Walker, v: DoorVisit, rand: () => number): boolean {
  if (v.door || v.cool > 0) return false;
  const door = AT_NODE.get(g.to);
  if (!door || rand() > CHANCE) return false;
  v.door = door;
  v.stage = "walk";
  g.tx = door.at[0];
  g.ty = door.at[1];
  return true;
}

/**
 * Move a door visit on by `dt` seconds. `arrived` says whether the gardener has reached its
 * target. Returns how much of the gardener shows (0..1) and whether the visit owns it (the scene
 * then picks no new target and, unless walking, leaves it where it is).
 */
export function stepVisit(g: Walker, v: DoorVisit, dt: number, arrived: boolean, rand: () => number): { show: number; busy: boolean } {
  v.cool = Math.max(0, v.cool - dt);
  for (const [id, f] of v.flash) v.flash.set(id, Math.max(0, f - dt * 1.6));
  const door = v.door;
  if (!door) return { show: 1, busy: false };

  if (v.stage === "walk") {
    if (arrived) {
      v.stage = "in";
      v.t = 0;
      v.flash.set(door.id, 1);
    }
    return { show: 1, busy: true };
  }
  g.tx = g.x;
  g.ty = g.y;
  if (v.stage === "in") {
    v.t += dt;
    if (v.t >= FADE) {
      v.stage = "inside";
      v.t = 0.8 + rand() * 1.8; // time spent inside
    }
    return { show: Math.max(0, 1 - v.t / FADE), busy: true };
  }
  if (v.stage === "inside") {
    v.t -= dt;
    if (v.t <= 0) {
      const out = BY_ID.get(door.to) ?? door;
      g.x = g.tx = out.at[0];
      g.y = g.ty = out.at[1];
      g.at = g.to = out.node;
      v.door = out;
      v.stage = "out";
      v.t = 0;
      v.flash.set(out.id, 1);
    }
    return { show: 0, busy: true };
  }
  // out
  v.t += dt;
  if (v.t < FADE) return { show: v.t / FADE, busy: true };
  const [nx, ny] = NODES[door.node];
  g.tx = nx + (rand() - 0.5) * 4;
  g.ty = ny + (rand() - 0.5) * 3;
  v.door = null;
  v.stage = "walk";
  v.cool = COOLDOWN;
  return { show: 1, busy: false };
}

/** How brightly each doorway glows right now, from every gardener's visit. */
export function doorGlow(visits: DoorVisit[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const v of visits) for (const [id, f] of v.flash) out.set(id, Math.max(out.get(id) ?? 0, f));
  return out;
}
