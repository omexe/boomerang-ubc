// The second ledger: campaign state rebuilt from the event stream alone, with no contract
// reads. Events may arrive out of order and repeated; the ledger applies them strictly in
// sequence, holds back anything after a gap, and ignores anything it has already seen.
//
// Each handler mirrors the state change at the matching `emit` in Boomerang.sol, so a ledger
// fed every event of a campaign reproduces its State and every Backer exactly.
import type { BoomerangEvent } from "./events.ts";
import { bonusFor } from "./math.ts";
import type { Address, Terms } from "./types.ts";
import { Outcome, Side } from "./types.ts";

// One backer, as the events describe them. `payTo` is null until a Redirected moves it.
export type LedgerBacker = {
  principal: bigint;
  weighted: bigint;
  payTo: Address | null;
  paid: boolean;
  paidPrincipal: bigint;
  paidBonus: bigint;
};

// One campaign. `expectedBonusPaid` is the bonus the math says a missed campaign owes, set at
// finalize to cross-check the event's own figure; null until finalized, 0 unless missed.
// `earlyUnknown` is the sum of pledges whose earliness the events could not settle (see
// Pledged below); while it is above zero `pledgedEarly` may be short by up to that much, and
// `expectedBonusPaid` stays null because the cross-check would mean nothing.
export type LedgerCampaign = {
  id: bigint;
  sponsor: Address;
  terms: Terms;
  matchIn: boolean;
  bonusIn: boolean;
  outcome: number;
  pledged: bigint;
  pledgedEarly: bigint;
  earlyUnknown: bigint;
  weighted: bigint;
  bonusPaid: bigint;
  expectedBonusPaid: bigint | null;
  recipientPaid: boolean;
  matchReturned: boolean;
  bonusReturned: boolean;
  payFailures: number;
  backers: Map<string, LedgerBacker>; // key: lowercase backer address
};

// The whole ledger. `pending` holds events past the next expected seq, waiting for the gap
// to fill. `repeats` counts events dropped as already-seen.
export type Ledger = {
  lastSeq: bigint;
  totalOwed: bigint;
  repeats: number;
  campaigns: Map<bigint, LedgerCampaign>;
  pending: Map<bigint, BoomerangEvent>;
};

export function emptyLedger(): Ledger {
  return { lastSeq: 0n, totalOwed: 0n, repeats: 0, campaigns: new Map(), pending: new Map() };
}

// Take in a batch of events in any order. Each is dropped as a repeat if its seq is already
// applied or already pending, else parked in `pending`; then every event that now continues
// the sequence is applied in order. Nothing after a missing seq is applied.
export function applyEvents(ledger: Ledger, events: readonly BoomerangEvent[]): void {
  for (const ev of events) {
    if (ev.seq <= ledger.lastSeq || ledger.pending.has(ev.seq)) {
      ledger.repeats += 1;
      continue;
    }
    ledger.pending.set(ev.seq, ev);
  }
  let next = ledger.lastSeq + 1n;
  for (;;) {
    const ev = ledger.pending.get(next);
    if (ev === undefined) break;
    ledger.pending.delete(next);
    applyOne(ledger, ev);
    ledger.lastSeq = next;
    next += 1n;
  }
}

// The run of sequence numbers the ledger is still waiting for: from the next expected seq to
// one below the smallest parked event. Null when nothing is parked.
export function missing(ledger: Ledger): { from: bigint; to: bigint } | null {
  if (ledger.pending.size === 0) return null;
  let smallest: bigint | undefined;
  for (const seq of ledger.pending.keys()) {
    if (smallest === undefined || seq < smallest) smallest = seq;
  }
  return { from: ledger.lastSeq + 1n, to: (smallest as bigint) - 1n };
}

function campaignOf(ledger: Ledger, id: bigint, seq: bigint): LedgerCampaign {
  const c = ledger.campaigns.get(id);
  if (c === undefined) throw new Error(`event seq ${seq} refers to unknown campaign ${id}`);
  return c;
}

function backerOf(c: LedgerCampaign, addr: Address, seq: bigint): LedgerBacker {
  const b = c.backers.get(addr.toLowerCase());
  if (b === undefined) throw new Error(`event seq ${seq} refers to unknown backer ${addr}`);
  return b;
}

function applyOne(ledger: Ledger, ev: BoomerangEvent): void {
  switch (ev.name) {
    case "CampaignCreated": {
      ledger.campaigns.set(ev.id, {
        id: ev.id,
        sponsor: ev.sponsor,
        terms: ev.terms,
        matchIn: false,
        bonusIn: false,
        outcome: Outcome.Open,
        pledged: 0n,
        pledgedEarly: 0n,
        earlyUnknown: 0n,
        weighted: 0n,
        bonusPaid: 0n,
        expectedBonusPaid: null,
        recipientPaid: false,
        matchReturned: false,
        bonusReturned: false,
        payFailures: 0,
        backers: new Map(),
      });
      return;
    }
    case "PotFunded": {
      const c = campaignOf(ledger, ev.id, ev.seq);
      if (ev.bonus) c.bonusIn = true;
      else c.matchIn = true;
      ledger.totalOwed += ev.amount;
      return;
    }
    case "Pledged": {
      const c = campaignOf(ledger, ev.id, ev.seq);
      const key = ev.backer.toLowerCase();
      let b = c.backers.get(key);
      if (b === undefined) {
        b = { principal: 0n, weighted: 0n, payTo: null, paid: false, paidPrincipal: 0n, paidBonus: 0n };
        c.backers.set(key, b);
      }
      // weight is 0 whenever the pledge is late, so amount x weight folds in safely either way.
      const w = ev.amount * ev.weight;
      b.principal += ev.amount;
      b.weighted += w;
      c.pledged += ev.amount;
      c.weighted += w;
      ledger.totalOwed += ev.amount;
      // Early = the contract's `block.timestamp < earlyUntil`. A positive weight proves it.
      // Zero weight proves late under flat weight. Under linear weight the last seconds of a
      // long early window also round to zero, so only the block's time can tell; a log that
      // came without it is counted in `earlyUnknown`, never guessed.
      if (ev.weight > 0n) c.pledgedEarly += ev.amount;
      else if (c.terms.linearWeight) {
        if (ev.time === undefined) c.earlyUnknown += ev.amount;
        else if (ev.time < c.terms.earlyUntil) c.pledgedEarly += ev.amount;
      }
      return;
    }
    case "Rescued": {
      const c = campaignOf(ledger, ev.id, ev.seq);
      // rescue closes the gap with new money: pledged rises to target, the money is owed.
      c.pledged += ev.amount;
      ledger.totalOwed += ev.amount;
      return;
    }
    case "Finalized": {
      const c = campaignOf(ledger, ev.id, ev.seq);
      c.outcome = ev.outcome;
      c.bonusPaid = ev.bonusPaid;
      if (ev.outcome !== Outcome.Missed) c.expectedBonusPaid = 0n;
      else c.expectedBonusPaid = c.earlyUnknown > 0n ? null : bonusFor(c.terms, c.pledgedEarly, c.weighted);
      return;
    }
    case "Paid": {
      const c = campaignOf(ledger, ev.id, ev.seq);
      const b = backerOf(c, ev.backer, ev.seq);
      b.paid = true;
      b.paidPrincipal = ev.principal;
      b.paidBonus = ev.bonus;
      ledger.totalOwed -= ev.principal + ev.bonus;
      return;
    }
    case "PayFailed": {
      const c = campaignOf(ledger, ev.id, ev.seq);
      backerOf(c, ev.backer, ev.seq); // must be a backer we know; a failed pay moves nothing else
      c.payFailures += 1;
      return;
    }
    case "SidePaid": {
      const c = campaignOf(ledger, ev.id, ev.seq);
      if (ev.side === Side.Recipient) c.recipientPaid = true;
      else if (ev.side === Side.MatchReturn) c.matchReturned = true;
      else c.bonusReturned = true;
      ledger.totalOwed -= ev.amount;
      return;
    }
    case "Redirected": {
      const c = campaignOf(ledger, ev.id, ev.seq);
      const b = backerOf(c, ev.backer, ev.seq);
      b.payTo = ev.to;
      return;
    }
  }
}
