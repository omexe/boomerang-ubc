// What the keeper should do next, decided from the ledger, and from the outcome the contract
// itself has shown where the keeper has asked it.
//
// The keeper has no rights in the contract. Every call it makes (finalize, paySide, payMany)
// is open to anyone, and each is harmless to repeat: finalize does nothing once the outcome
// is set, a side pays once, a backer is paid once. So this plan may be computed again on
// every delivery, and a call that was already made costs only its gas.
import type { Ledger, LedgerCampaign } from "../../../packages/kit/src/index.ts";
import { Outcome, Side, potsIn, sideAmount } from "../../../packages/kit/src/index.ts";

export type Action =
  | { kind: "finalize"; id: bigint }
  | { kind: "paySide"; id: bigint; side: number }
  | { kind: "payMany"; id: bigint; backers: `0x${string}`[] };

/** How many backers one payMany call names. */
export const BATCH = 40;

/** The ledger's campaign as the contract's State, for the kit's arithmetic. */
function stateOf(c: LedgerCampaign) {
  return {
    sponsor: c.sponsor,
    outcome: c.outcome,
    matchIn: c.matchIn,
    bonusIn: c.bonusIn,
    recipientPaid: c.recipientPaid,
    matchReturned: c.matchReturned,
    bonusReturned: c.bonusReturned,
    backers: c.backers.size,
    pledged: c.pledged,
    pledgedEarly: c.pledgedEarly,
    weighted: c.weighted,
    bonusPaid: c.bonusPaid,
  };
}

/**
 * Every call that would move a campaign forward at chain time `time`, in the order to make them.
 * `skip` names backers not to pay this round, as `<campaign id>:<backer address>` in any letter
 * case (for example, ones whose payout just failed).
 *
 * `told` holds, by campaign, the outcome the contract itself has shown the sender. It outranks
 * the ledger's: the ledger is built from deliveries, which can be late, or false. The amounts
 * are still the ledger's; the contract, asked first by the sender, has the last word on each call.
 *
 * The plan is only as good as the ledger. A `paySide` it names reverts while the token refuses
 * that payee; the caller is expected to back off an action that failed, not to resend it at once.
 */
export function nextActions(ledger: Ledger, time: bigint, skipped: ReadonlySet<string> = new Set(), told: ReadonlyMap<bigint, number> = new Map()): Action[] {
  const actions: Action[] = [];
  const skip = new Set([...skipped].map((key) => key.toLowerCase()));
  const ids = [...ledger.campaigns.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const id of ids) {
    const c = ledger.campaigns.get(id)!;
    const outcome = told.get(id) ?? c.outcome;
    const s = { ...stateOf(c), outcome };

    if (outcome === Outcome.Open) {
      // Due when a pot is missing at the opening second (void), or at the closing second. With
      // events missing from the ledger a pot may have been funded unseen; the sender asks the
      // contract before it sends, so a campaign wrongly taken for void costs a question and no gas.
      const isVoid = time >= c.terms.opensAt && !potsIn(c.terms, s);
      if (isVoid || time >= c.terms.closesAt) actions.push({ kind: "finalize", id });
      continue; // payouts wait for the outcome: the Finalized event, or the contract's own word
    }

    const flags = [c.recipientPaid, c.matchReturned, c.bonusReturned];
    for (const side of [Side.Recipient, Side.MatchReturn, Side.BonusReturn]) {
      if (!flags[side] && sideAmount(c.terms, s, side) > 0n) actions.push({ kind: "paySide", id, side });
    }

    if (outcome === Outcome.Missed) {
      const unpaid: `0x${string}`[] = [];
      for (const [backer, b] of c.backers) {
        if (!b.paid && b.principal > 0n && !skip.has(`${id}:${backer}`)) unpaid.push(backer as `0x${string}`);
      }
      unpaid.sort();
      for (let i = 0; i < unpaid.length; i += BATCH) {
        actions.push({ kind: "payMany", id, backers: unpaid.slice(i, i + BATCH) });
      }
    }
  }
  return actions;
}

/** True when the ledger shows nothing left to do for any campaign whose outcome is set. */
export function settled(ledger: Ledger): boolean {
  for (const c of ledger.campaigns.values()) {
    if (c.outcome === Outcome.Open) continue;
    const s = stateOf(c);
    const flags = [c.recipientPaid, c.matchReturned, c.bonusReturned];
    for (const side of [Side.Recipient, Side.MatchReturn, Side.BonusReturn]) {
      if (!flags[side] && sideAmount(c.terms, s, side) > 0n) return false;
    }
    if (c.outcome === Outcome.Missed) {
      for (const b of c.backers.values()) if (!b.paid && b.principal > 0n) return false;
    }
  }
  return true;
}
