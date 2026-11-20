// How the keeper stands against the chain at one read, from its answer and the block the page read.
// The page reads this to choose which sentence about the keeper is true right now.
import type { KeeperAnswer } from "./ask.ts";

/** How the keeper stands against the chain at this read. */
export type Pace = { state: "down" } | { state: "prompt" } | { state: "behind"; heard: number; blocks: number };

/** The three things a sentence about the keeper can turn on. */
export type PaceState = Pace["state"];

/** More blocks than this between the page's block and the newest the keeper has heard, and the keeper is behind. */
export const BEHIND_AFTER = 900;

export function paceOf(keeper: KeeperAnswer, block: bigint): Pace {
  if (!keeper.up) return { state: "down" };
  const health = keeper.health;
  const lag = Number(block) - health.lastBlock;
  // A keeper that has heard no block at all is behind however short the chain is.
  if (lag > BEHIND_AFTER || health.lastBlock === 0) return { state: "behind", heard: health.lastBlock, blocks: Math.max(lag, 0) };
  return { state: "prompt" };
}
