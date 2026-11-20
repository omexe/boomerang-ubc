// The keeper's read-only answers, turned back into the kit's types. The keeper writes every
// large number as a decimal string; a field that is missing or of the wrong kind is an error
// here, never a silent zero, because the Proof page compares these figures with the contract's.
import type { Address, Backer, State, Terms } from "../../../packages/kit/src/index.ts";
import { Outcome, Side } from "../../../packages/kit/src/index.ts";
import { formatUsd } from "./money.ts";

export type LedgerBackerView = { address: Address; principal: bigint; weighted: bigint; payTo: Address | null; paid: boolean; paidPrincipal: bigint; paidBonus: bigint };

export type LedgerCampaignView = {
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
  backers: LedgerBackerView[];
};

export type FeedItem = { name: string; seq: bigint; id: bigint; time: bigint | null; txHash: `0x${string}` | null; args: Record<string, unknown> };

export type LedgerView = { lastSeq: bigint; totalOwed: bigint; missing: { from: bigint; to: bigint } | null; campaigns: LedgerCampaignView[]; feed: FeedItem[] };

class Shape extends Error {}
const fail = (path: string, want: string): never => {
  throw new Shape(`the keeper's ledger has no ${want} at ${path}`);
};
const obj = (v: unknown, path: string): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(path, "object"));
const arr = (v: unknown, path: string): unknown[] => (Array.isArray(v) ? v : fail(path, "list"));
const big = (v: unknown, path: string): bigint => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : fail(path, "whole number"));
const bool = (v: unknown, path: string): boolean => (typeof v === "boolean" ? v : fail(path, "yes/no"));
const num = (v: unknown, path: string): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : fail(path, "small number"));
const OUTCOMES: ReadonlySet<number> = new Set<number>(Object.values(Outcome));
const addr = (v: unknown, path: string): Address => (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : fail(path, "address"));

/** Read what GET /ledger returned. Throws if any field is not what the page relies on. */
export function readLedger(json: unknown): LedgerView {
  const root = obj(json, "ledger");
  const missing = root.missing === null ? null : { from: big(obj(root.missing, "missing").from, "missing.from"), to: big(obj(root.missing, "missing").to, "missing.to") };
  if (missing !== null && missing.from > missing.to) fail("missing", "range that runs forwards");
  const campaigns = arr(root.campaigns, "campaigns").map((raw, i) => {
    const p = `campaigns[${i}]`;
    const c = obj(raw, p);
    const t = obj(c.terms, `${p}.terms`);
    const terms: Terms = {
      recipient: addr(t.recipient, `${p}.terms.recipient`),
      opensAt: big(t.opensAt, `${p}.terms.opensAt`),
      earlyUntil: big(t.earlyUntil, `${p}.terms.earlyUntil`),
      closesAt: big(t.closesAt, `${p}.terms.closesAt`),
      target: big(t.target, `${p}.terms.target`),
      minPledge: big(t.minPledge, `${p}.terms.minPledge`),
      matchAmount: big(t.matchAmount, `${p}.terms.matchAmount`),
      bonusPool: big(t.bonusPool, `${p}.terms.bonusPool`),
      rateBps: num(t.rateBps, `${p}.terms.rateBps`),
      linearWeight: bool(t.linearWeight, `${p}.terms.linearWeight`),
      bonusFromRecipient: bool(t.bonusFromRecipient, `${p}.terms.bonusFromRecipient`),
    };
    const backers = arr(c.backers, `${p}.backers`).map((rawB, j) => {
      const q = `${p}.backers[${j}]`;
      const b = obj(rawB, q);
      return {
        address: addr(b.address, `${q}.address`),
        principal: big(b.principal, `${q}.principal`),
        weighted: big(b.weighted, `${q}.weighted`),
        payTo: b.payTo === null ? null : addr(b.payTo, `${q}.payTo`),
        paid: bool(b.paid, `${q}.paid`),
        paidPrincipal: big(b.paidPrincipal, `${q}.paidPrincipal`),
        paidBonus: big(b.paidBonus, `${q}.paidBonus`),
      };
    });
    return {
      id: big(c.id, `${p}.id`),
      sponsor: addr(c.sponsor, `${p}.sponsor`),
      terms,
      matchIn: bool(c.matchIn, `${p}.matchIn`),
      bonusIn: bool(c.bonusIn, `${p}.bonusIn`),
      outcome: OUTCOMES.has(c.outcome as number) ? (c.outcome as number) : fail(`${p}.outcome`, "known outcome"),
      pledged: big(c.pledged, `${p}.pledged`),
      pledgedEarly: big(c.pledgedEarly, `${p}.pledgedEarly`),
      earlyUnknown: big(c.earlyUnknown, `${p}.earlyUnknown`),
      weighted: big(c.weighted, `${p}.weighted`),
      bonusPaid: big(c.bonusPaid, `${p}.bonusPaid`),
      expectedBonusPaid: c.expectedBonusPaid === null ? null : big(c.expectedBonusPaid, `${p}.expectedBonusPaid`),
      recipientPaid: bool(c.recipientPaid, `${p}.recipientPaid`),
      matchReturned: bool(c.matchReturned, `${p}.matchReturned`),
      bonusReturned: bool(c.bonusReturned, `${p}.bonusReturned`),
      payFailures: num(c.payFailures, `${p}.payFailures`),
      backers,
    };
  });
  const seen = new Set<bigint>();
  for (const [i, c] of campaigns.entries()) {
    if (seen.has(c.id)) fail(`campaigns[${i}].id`, "id used only once");
    seen.add(c.id);
  }
  const feed = arr(root.feed, "feed").map((raw, i) => {
    const p = `feed[${i}]`;
    const e = obj(raw, p);
    const { name, seq, id, time, txHash, blockNumber: _blockNumber, ...args } = e;
    return {
      name: typeof name === "string" ? name : fail(`${p}.name`, "name"),
      seq: big(seq, `${p}.seq`),
      id: big(id, `${p}.id`),
      time: time === undefined || time === null ? null : big(time, `${p}.time`),
      txHash: typeof txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(txHash) ? (txHash as `0x${string}`) : null, // the page links it; anything else is dropped
      args,
    };
  });
  return { lastSeq: big(root.lastSeq, "lastSeq"), totalOwed: big(root.totalOwed, "totalOwed"), missing, campaigns, feed };
}

/** A ledger campaign as the contract's State, so the same page code reads either source. */
export function stateOf(c: LedgerCampaignView): State {
  return {
    sponsor: c.sponsor,
    outcome: c.outcome,
    matchIn: c.matchIn,
    bonusIn: c.bonusIn,
    recipientPaid: c.recipientPaid,
    matchReturned: c.matchReturned,
    bonusReturned: c.bonusReturned,
    backers: c.backers.length,
    pledged: c.pledged,
    pledgedEarly: c.pledgedEarly,
    weighted: c.weighted,
    bonusPaid: c.bonusPaid,
  };
}

/** A ledger backer as the contract's Backer. An unset destination is the zero address, as on chain. */
export function backerOf(b: LedgerBackerView): Backer {
  return { principal: b.principal, weighted: b.weighted, payTo: b.payTo ?? "0x0000000000000000000000000000000000000000", paid: b.paid };
}

/**
 * The backer shown as an example when nobody is connected: the address in the most campaigns of
 * the keeper's ledger; between equals the one in the newest campaign, then the lowest address.
 * Only the address is taken from the ledger; its figures are then read from the contract.
 */
export function exampleBacker(ledger: LedgerView): Address | null {
  const seen = new Map<string, { address: Address; campaigns: number; newest: bigint }>();
  for (const c of ledger.campaigns) {
    for (const b of c.backers) {
      const key = b.address.toLowerCase();
      const had = seen.get(key);
      if (had === undefined) seen.set(key, { address: b.address, campaigns: 1, newest: c.id });
      else {
        had.campaigns += 1;
        if (c.id > had.newest) had.newest = c.id;
      }
    }
  }
  let best: { address: Address; campaigns: number; newest: bigint } | null = null;
  for (const one of seen.values()) {
    if (
      best === null ||
      one.campaigns > best.campaigns ||
      (one.campaigns === best.campaigns && (one.newest > best.newest || (one.newest === best.newest && one.address.toLowerCase() < best.address.toLowerCase())))
    ) {
      best = one;
    }
  }
  return best === null ? null : best.address;
}

/** "0x12ab…cd34" */
export function short(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/**
 * Where the contract's own figures and the event-built ledger disagree, in words. An empty list
 * is the Proof page's green line. `chain` is what the page read from the contract at one block.
 */
export function differences(ledger: LedgerCampaignView, chain: { terms: Terms; state: State }): string[] {
  const out: string[] = [];
  const mine = stateOf(ledger);
  for (const key of Object.keys(chain.state) as (keyof State)[]) {
    const a = mine[key];
    const b = chain.state[key];
    const same = typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (!same) out.push(`${key}: ledger ${String(a)}, contract ${String(b)}`);
  }
  for (const key of Object.keys(chain.terms) as (keyof Terms)[]) {
    const a = ledger.terms[key];
    const b = chain.terms[key];
    const same = typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (!same) out.push(`terms.${key}: ledger ${String(a)}, contract ${String(b)}`);
  }
  if (ledger.earlyUnknown > 0n) out.push(`the ledger could not tell whether ${formatUsd(ledger.earlyUnknown)} of pledges were early`);
  if (ledger.expectedBonusPaid !== null && ledger.outcome === Outcome.Missed && ledger.expectedBonusPaid !== ledger.bonusPaid) {
    out.push(`bonus paid: the rule gives ${formatUsd(ledger.expectedBonusPaid)}, the event said ${formatUsd(ledger.bonusPaid)}`);
  }
  return out;
}

/** One backer: where the ledger's record and the contract's differ, in words. */
export function backerDifferences(ledger: LedgerBackerView, chain: Backer): string[] {
  const out: string[] = [];
  const mine = backerOf(ledger);
  if (mine.principal !== chain.principal) out.push(`pledged: ledger ${formatUsd(mine.principal)}, contract ${formatUsd(chain.principal)}`);
  if (mine.weighted !== chain.weighted) out.push(`weight: ledger ${mine.weighted}, contract ${chain.weighted}`);
  if (mine.payTo.toLowerCase() !== chain.payTo.toLowerCase()) out.push(`refund address: ledger ${short(mine.payTo)}, contract ${short(chain.payTo)}`);
  if (mine.paid !== chain.paid) out.push(`paid: ledger ${mine.paid ? "yes" : "no"}, contract ${chain.paid ? "yes" : "no"}`);
  return out;
}

export type Standing =
  | { kind: "level"; differences: string[] } // the ledger has every event the contract has emitted
  | { kind: "behind"; by: bigint } // the keeper has not heard the newest events yet: wait, do not compare
  | { kind: "ahead"; by: bigint }; // more events than the contract has emitted: not this contract's ledger

/**
 * The ledger as a whole against the contract, read at one block. Figures are compared only when
 * the two are level: a ledger a few events behind is late, not wrong, and the page says which.
 */
export function standing(ledger: LedgerView, chain: { owed: bigint; events: bigint }): Standing {
  if (ledger.lastSeq < chain.events) return { kind: "behind", by: chain.events - ledger.lastSeq };
  if (ledger.lastSeq > chain.events) return { kind: "ahead", by: ledger.lastSeq - chain.events };
  const differences: string[] = [];
  if (ledger.missing !== null) differences.push(`events ${ledger.missing.from} to ${ledger.missing.to} never reached the ledger`);
  if (ledger.totalOwed !== chain.owed) differences.push(`owed in total: ledger ${formatUsd(ledger.totalOwed)}, contract ${formatUsd(chain.owed)}`);
  return { kind: "level", differences };
}

// An amount in a feed line. A field that is not a whole number is said to be unreadable, and an
// amount above nothing and under a cent reads "less than 0.01": neither is ever shown as 0.00,
// which would be a figure nobody was paid.
const UNREADABLE = "an unreadable amount";
const amount = (v: unknown): bigint | null => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null);
const usd = (v: unknown): string => {
  const n = amount(v);
  return n === null ? UNREADABLE : formatUsd(n);
};
const sideName = (side: unknown): string =>
  side === Side.Recipient ? "the recipient" : side === Side.MatchReturn ? "the match, back to its funder" : side === Side.BonusReturn ? "the bonus pool, back to its funder" : "an unnamed side";

/** One line of the live feed. */
export function feedLine(e: FeedItem): string {
  const a = e.args;
  const who = (v: unknown) => (typeof v === "string" ? short(v) : "someone");
  switch (e.name) {
    case "CampaignCreated":
      return `Campaign ${e.id} created by ${who(a.sponsor)}`;
    case "PotFunded":
      return `${a.bonus === true ? "Bonus pool" : a.bonus === false ? "Match" : "A pot"} of ${usd(a.amount)} locked`;
    case "Pledged": {
      const weight = amount(a.weight);
      return `${who(a.backer)} pledged ${usd(a.amount)}${weight === null ? "; whether it was early could not be read" : weight > 0n ? ", early" : ""}`;
    }
    case "Rescued":
      return `The sponsor closed the gap with ${usd(a.amount)}`;
    case "Finalized":
      if (a.outcome === Outcome.Funded) return "Funded";
      if (a.outcome === Outcome.Missed) return `Missed. Bonus for early backers: ${usd(a.bonusPaid)}`;
      if (a.outcome === Outcome.Void) return "Void: a pot was not locked in time";
      return "Settled";
    case "Paid": {
      const bonus = amount(a.bonus);
      if (bonus === 0n) return `${who(a.backer)} got ${usd(a.principal)} back`;
      return `${who(a.backer)} got ${usd(a.principal)} back plus ${usd(a.bonus)}`;
    }
    case "PayFailed":
      return `A refund to ${who(a.to)} did not go through. It stays owed`;
    case "SidePaid":
      return `${usd(a.amount)} paid: ${sideName(a.side)}`;
    case "Redirected":
      return `${who(a.backer)} pointed their refund at ${who(a.to)}`;
    default:
      // The event's own name is the keeper's text and is never echoed back to the page.
      return "An event this page does not know";
  }
}
