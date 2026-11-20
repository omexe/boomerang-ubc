// Pure ports of Boomerang's arithmetic. Every operation, and every integer division's
// rounding, follows Solidity exactly: `*` and `/` are left-to-right, division truncates
// toward zero, and all values are non-negative, so these match the contract bit for bit.
import type { Backer, State, Terms } from "./types.ts";
import { Outcome, Side } from "./types.ts";

// WEIGHT_ONE: full weight, the value _weightAt returns for a flat-weight early pledge.
export const WEIGHT_ONE = 1_000_000n;

// basis points (1e4) times the weight scale (1e6): the divisor in the by-rate bonus cap.
const RATE_DIVISOR = 10_000_000_000n; // 1e10

// Weight of a pledge landing at `time`, from 0 to WEIGHT_ONE. Mirrors _weightAt.
export function weightAt(t: Terms, time: bigint): bigint {
  if (time < t.opensAt || time >= t.earlyUntil) return 0n;
  if (!t.linearWeight) return WEIGHT_ONE;
  return (WEIGHT_ONE * (t.earlyUntil - time)) / (t.earlyUntil - t.opensAt);
}

// The bonus early backers split if the campaign misses: pledgedEarly x min(byPool, byRate).
// Each product is formed before its single truncating division. Mirrors _bonusFor.
export function bonusFor(t: Terms, pledgedEarly: bigint, weighted: bigint): bigint {
  const byPool = (pledgedEarly * t.bonusPool) / t.target;
  const byRate = (pledgedEarly * BigInt(t.rateBps) * weighted) / (RATE_DIVISOR * t.target);
  return byRate < byPool ? byRate : byPool;
}

// One backer's cut of `pool`, by weight. Mirrors _share. Zero when the pool has no weight.
export function share(pool: bigint, mine: bigint, all: bigint): bigint {
  return all === 0n ? 0n : (pool * mine) / all;
}

// Whether both required pots are in. Mirrors _potsIn.
export function potsIn(t: Terms, s: State): boolean {
  return (t.matchAmount === 0n || s.matchIn) && (t.bonusPool === 0n || s.bonusIn);
}

// The outcome finalize would record at `time`. Mirrors _outcomeNow with time in place of now.
export function outcomeAt(t: Terms, s: State, time: bigint): number {
  if (s.outcome !== Outcome.Open) return s.outcome;
  if (time >= t.opensAt && !potsIn(t, s)) return Outcome.Void;
  if (time >= t.closesAt) return Outcome.Missed;
  return Outcome.Open;
}

// What a fresh pledge of `amount` at `time` would be worth if the campaign then missed with
// no further pledges. Mirrors quoteIfMissed exactly, down to the (false, amount, 0) it returns
// when the early window has closed but the pledge would otherwise be taken.
export function quoteIfMissed(
  t: Terms,
  s: State,
  amount: bigint,
  time: bigint,
): { wouldFund: boolean; counted: bigint; bonus: bigint } {
  if (amount === 0n || outcomeAt(t, s, time) !== Outcome.Open) return { wouldFund: false, counted: 0n, bonus: 0n };
  if (time < t.opensAt || time >= t.closesAt) return { wouldFund: false, counted: 0n, bonus: 0n };
  const gap = t.target - s.pledged;
  if (amount >= gap) return { wouldFund: true, counted: gap, bonus: 0n };
  if (amount < t.minPledge) return { wouldFund: false, counted: 0n, bonus: 0n };
  const counted = amount;
  const weight = weightAt(t, time);
  if (weight === 0n) return { wouldFund: false, counted, bonus: 0n };
  const mine = amount * weight;
  const weighted = s.weighted + mine;
  const pool = bonusFor(t, s.pledgedEarly + amount, weighted);
  const bonus = (pool * mine) / weighted;
  return { wouldFund: false, counted, bonus };
}

// What a backer is owed now: non-zero only for an unpaid backer of a missed campaign.
// Mirrors owedTo. `t` is unused, kept for signature parity with the contract view.
export function owedTo(t: Terms, s: State, b: Backer): { principal: bigint; bonus: bigint } {
  void t;
  if (s.outcome !== Outcome.Missed || b.paid) return { principal: 0n, bonus: 0n };
  return { principal: b.principal, bonus: share(s.bonusPaid, b.weighted, s.weighted) };
}

// What a backer would be owed if the campaign missed with the totals as they stand. Mirrors
// positionIfMissed. The contract view does not read the clock, so there is no time parameter.
export function positionIfMissed(t: Terms, s: State, b: Backer): { principal: bigint; bonus: bigint } {
  if (b.paid || s.outcome === Outcome.Funded || s.outcome === Outcome.Void) return { principal: 0n, bonus: 0n };
  const pool = s.outcome === Outcome.Missed ? s.bonusPaid : bonusFor(t, s.pledgedEarly, s.weighted);
  return { principal: b.principal, bonus: share(pool, b.weighted, s.weighted) };
}

// The amount paySide would move for `side`. Mirrors _sideAmount.
export function sideAmount(t: Terms, s: State, side: number): bigint {
  if (side === Side.Recipient) {
    return s.outcome === Outcome.Funded ? s.pledged + t.matchAmount : 0n;
  }
  if (side === Side.MatchReturn) {
    return s.outcome !== Outcome.Funded && s.matchIn ? t.matchAmount : 0n;
  }
  if (!s.bonusIn) return 0n;
  return s.outcome === Outcome.Missed ? t.bonusPool - s.bonusPaid : t.bonusPool;
}
