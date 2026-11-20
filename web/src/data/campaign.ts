// A campaign as the page shows it, worked out from the contract's own terms and state with
// the kit's arithmetic (which is tested equal to the contract). Nothing here reads the chain.
import type { Address, Backer, State, Terms } from "../../../packages/kit/src/index.ts";
import { Outcome, bonusFor, outcomeAt, owedTo, potsIn, quoteIfMissed, share } from "../../../packages/kit/src/index.ts";
import { short } from "./keeper.ts";
import { about, formatUsd } from "./money.ts";
import { timeLeft, utcStamp } from "./time.ts";

/**
 * Where a campaign stands at `now`:
 *   waiting  both pots are in (or still may be) and it has not opened;
 *   early    open, and a pledge now earns bonus weight;
 *   open     open, past the early window;
 *   ended    the deadline has passed, or a pot was missing at opening, and nobody has
 *            called `finalize` yet (anyone can);
 *   funded / missed / void   the outcome is recorded.
 */
export type Phase = "waiting" | "early" | "open" | "ended" | "funded" | "missed" | "void";

export function phaseOf(t: Terms, s: State, now: bigint): Phase {
  if (s.outcome === Outcome.Funded) return "funded";
  if (s.outcome === Outcome.Missed) return "missed";
  if (s.outcome === Outcome.Void) return "void";
  if (outcomeAt(t, s, now) !== Outcome.Open) return "ended";
  if (now < t.opensAt) return "waiting";
  return now < t.earlyUntil ? "early" : "open";
}

/** The outcome `finalize` would record now, for a campaign in the "ended" phase. */
export function endsAs(t: Terms, s: State, now: bigint): "missed" | "void" | null {
  if (s.outcome !== Outcome.Open) return null;
  const o = outcomeAt(t, s, now);
  return o === Outcome.Missed ? "missed" : o === Outcome.Void ? "void" : null;
}

export type Progress = {
  pledged: bigint;
  target: bigint;
  gap: bigint;
  /** Whole percent, cut down, so it reads 100 only when the target is truly met. */
  percent: number;
  /** Both pots locked (or not needed). False means a campaign that opens void. */
  potsIn: boolean;
};

export function progressOf(t: Terms, s: State): Progress {
  const gap = t.target > s.pledged ? t.target - s.pledged : 0n;
  return { pledged: s.pledged, target: t.target, gap, percent: Number((s.pledged * 100n) / t.target), potsIn: potsIn(t, s) };
}

/** The line under the clock: what is counting down, and how long is left. */
export function clockLine(t: Terms, s: State, now: bigint): string {
  switch (phaseOf(t, s, now)) {
    case "waiting":
      return `Opens in ${timeLeft(t.opensAt - now)}`;
    case "early":
      // With no bonus pool the early window earns nothing, so there is no bonus clock to show.
      return t.bonusPool > 0n ? `Early bonus window closes in ${timeLeft(t.earlyUntil - now)}` : `Closes in ${timeLeft(t.closesAt - now)}`;
    case "open":
      return `Closes in ${timeLeft(t.closesAt - now)}`;
    case "ended":
      return endsAs(t, s, now) === "void" ? "A pot was not locked in time. Waiting to be closed" : "Deadline passed. Waiting to be settled";
    // A settled campaign has no clock left; the line says when its deadline was, which the status
    // beside it does not. A campaign can be funded before its deadline, which then has not come yet.
    case "funded":
      return now < t.closesAt ? `Funded before its deadline, ${utcStamp(t.closesAt)}` : `Deadline was ${utcStamp(t.closesAt)}`;
    case "missed":
      return `Deadline was ${utcStamp(t.closesAt)}`;
    case "void":
      return "Void. No pledge was taken";
  }
}

/** What a pledge of `amount` would do if made at `now`. */
export type PledgeQuote =
  | { kind: "refused"; why: "zero" | "not-open" | "closed" | "below-minimum" | "sponsor"; line: string }
  | { kind: "completes"; counted: bigint; kept: bigint; line: string }
  | { kind: "counts"; counted: bigint; bonus: bigint; back: bigint; early: boolean; line: string };

/**
 * The sentence a backer reads before pledging. `amount` is what they typed, in millionths.
 * The figures are the contract's `quoteIfMissed` rule; the page also asks the contract itself
 * and shows the contract's answer if the two ever differ.
 */
export function quotePledge(
  t: Terms,
  s: State,
  amount: bigint,
  now: bigint,
  opts: { isSponsor?: boolean; answer?: { wouldFund: boolean; counted: bigint; bonus: bigint } } = {},
): PledgeQuote {
  if (opts.isSponsor) return { kind: "refused", why: "sponsor", line: "The sponsor's account cannot pledge to its own campaign." };
  if (amount <= 0n) return { kind: "refused", why: "zero", line: "Enter an amount." };
  const phase = phaseOf(t, s, now);
  if (phase === "waiting") return { kind: "refused", why: "not-open", line: `This campaign opens in ${timeLeft(t.opensAt - now)}.` };
  if (phase !== "early" && phase !== "open") return { kind: "refused", why: "closed", line: "This campaign is no longer taking pledges." };

  // `answer` is the contract's own reply to quoteIfMissed(id, amount); when the page has it, the
  // sentence is built from it and not from the arithmetic here.
  const q = opts.answer ?? quoteIfMissed(t, s, amount, now);
  if (q.wouldFund) {
    const kept = amount - q.counted;
    const line =
      kept > 0n
        ? `This pledge finishes the campaign. ${formatUsd(q.counted)} is taken and ${formatUsd(kept)} stays with you.`
        : "This pledge finishes the campaign.";
    return { kind: "completes", counted: q.counted, kept, line };
  }
  if (q.counted === 0n) {
    return { kind: "refused", why: "below-minimum", line: `The smallest pledge is ${formatUsd(t.minPledge)}.` };
  }
  const early = phase === "early";
  const line =
    q.bonus > 0n
      ? `If this misses: you get back ${formatUsd(amount)} plus ${about(q.bonus)}.`
      : early
        ? `If this misses: you get back ${formatUsd(amount)}.`
        : `If this misses: you get back ${formatUsd(amount)}. The early bonus window has closed.`;
  return { kind: "counts", counted: q.counted, bonus: q.bonus, back: amount + q.bonus, early, line };
}

/** One backer's pledge, as "My money" shows it. */
export type Standing =
  | { kind: "none"; line: "" }
  | { kind: "counted"; principal: bigint; ifMissedBonus: bigint; line: string }
  | { kind: "given"; principal: bigint; line: string }
  | { kind: "owed"; principal: bigint; bonus: bigint; line: string }
  | { kind: "returned"; principal: bigint; bonus: bigint; line: string };

/**
 * Every figure here is the contract's own: the backer's `principal`, and the bonus worked out
 * from `bonusPaid`, the backer's weight and the campaign's total weight. Nothing is taken from the
 * keeper or its ledger. `redirectTo`, when set, is the address this account pointed its refund at
 * (not the account itself): the refund goes there, and the lines say so. With `third` the sentences
 * are about someone else's pledge ("this backer"), for a page that shows another account's money.
 */
export function standingOf(t: Terms, s: State, b: Backer, redirectTo?: Address | null, third: boolean = false): Standing {
  const chose = third ? "the address this backer chose" : "the address you chose";
  if (b.principal === 0n) return { kind: "none", line: "" };
  if (s.outcome === Outcome.Funded) {
    return { kind: "given", principal: b.principal, line: `${formatUsd(b.principal)} went to the campaign. It was funded.` };
  }
  if (s.outcome === Outcome.Missed) {
    if (b.paid) {
      const bonus = share(s.bonusPaid, b.weighted, s.weighted);
      const principal = b.principal;
      const line = redirectTo
        ? `${formatUsd(principal + bonus)} was paid to ${short(redirectTo)}, ${chose}.`
        : bonus > 0n
          ? `${formatUsd(principal)} came back, plus ${formatUsd(bonus)} bonus.`
          : `${formatUsd(principal)} came back.`;
      return { kind: "returned", principal, bonus, line };
    }
    const owed = owedTo(t, s, b);
    const line = redirectTo
      ? `${formatUsd(owed.principal + owed.bonus)} is owed and will go to ${short(redirectTo)}, ${chose}.`
      : owed.bonus > 0n
        ? `${formatUsd(owed.principal)} plus ${formatUsd(owed.bonus)} bonus is ${third ? "owed to this backer. Anyone can send it." : "yours. Anyone can send it; you can too."}`
        : `${formatUsd(owed.principal)} is ${third ? "owed to this backer. Anyone can send it." : "yours. Anyone can send it; you can too."}`;
    return { kind: "owed", principal: owed.principal, bonus: owed.bonus, line };
  }
  // Open (a void campaign never took a pledge)
  const ifMissedBonus = share(bonusFor(t, s.pledgedEarly, s.weighted), b.weighted, s.weighted);
  const line =
    ifMissedBonus > 0n
      ? `${formatUsd(b.principal)} is counted. If the campaign misses as it stands, it comes back with ${about(ifMissedBonus)}.`
      : `${formatUsd(b.principal)} is counted. If the campaign misses, it comes back in full.`;
  return { kind: "counted", principal: b.principal, ifMissedBonus, line };
}
