// Every address and amount in these tests is invented. None is a reading of any campaign.
//
// The pure parts of the keeper reader: feed sentences, the transaction link, and the two
// comparisons the Proof page makes beyond a campaign's own figures.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Outcome, Side, type Backer } from "../../packages/kit/src/index.ts";
import { backerDifferences, differences, feedLine, readLedger, standing, stateOf, type FeedItem, type LedgerBackerView, type LedgerView } from "../src/data/keeper.ts";

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const item = (name: string, args: Record<string, unknown>): FeedItem => ({ name, seq: 1n, id: 7n, time: 100n, txHash: null, args });

describe("feed sentences", function () {
  it("each kind of event has its own sentence", function () {
    assert.equal(feedLine(item("CampaignCreated", { sponsor: A })), "Campaign 7 created by 0x0000…00a1");
    assert.equal(feedLine(item("PotFunded", { bonus: false, amount: "1000000" })), "Match of 1.00 locked");
    assert.equal(feedLine(item("PotFunded", { bonus: true, amount: "300000" })), "Bonus pool of 0.30 locked");
    assert.equal(feedLine(item("Pledged", { backer: A, amount: "25000000", weight: "25000000" })), "0x0000…00a1 pledged 25.00, early");
    assert.equal(feedLine(item("Pledged", { backer: A, amount: "25000000", weight: "0" })), "0x0000…00a1 pledged 25.00");
    assert.equal(feedLine(item("Rescued", { amount: "760000000" })), "The sponsor closed the gap with 760.00");
    assert.equal(feedLine(item("Finalized", { outcome: Outcome.Funded, bonusPaid: "0" })), "Funded");
    assert.equal(feedLine(item("Finalized", { outcome: Outcome.Missed, bonusPaid: "1580000" })), "Missed. Bonus for early backers: 1.58");
    assert.equal(feedLine(item("Finalized", { outcome: Outcome.Missed, bonusPaid: "9" })), "Missed. Bonus for early backers: less than 0.01");
    assert.equal(feedLine(item("Finalized", { outcome: Outcome.Void, bonusPaid: "0" })), "Void: a pot was not locked in time");
    assert.equal(feedLine(item("Paid", { backer: A, principal: "20000000", bonus: "500000" })), "0x0000…00a1 got 20.00 back plus 0.50");
    // A late backer gets the pledge back and no bonus: the sentence says nothing about a bonus.
    assert.equal(feedLine(item("Paid", { backer: A, principal: "20000000", bonus: "0" })), "0x0000…00a1 got 20.00 back");
    assert.equal(feedLine(item("PayFailed", { to: B })), "A refund to 0x0000…00b2 did not go through. It stays owed");
    assert.equal(feedLine(item("SidePaid", { amount: "2000000000", side: Side.Recipient })), "2,000.00 paid: the recipient");
    assert.equal(feedLine(item("SidePaid", { amount: "1000000", side: Side.MatchReturn })), "1.00 paid: the match, back to its funder");
    assert.equal(feedLine(item("SidePaid", { amount: "300000", side: Side.BonusReturn })), "0.30 paid: the bonus pool, back to its funder");
    assert.equal(feedLine(item("Redirected", { backer: A, to: B })), "0x0000…00a1 pointed their refund at 0x0000…00b2");
    // An event this page does not know is a fixed sentence; the keeper's own event name is never echoed.
    assert.equal(feedLine(item("SomethingNew", {})), "An event this page does not know");
    assert.equal(feedLine(item("<img src=x onerror=1>", {})), "An event this page does not know");
  });

  it("a field that is not a whole number is said to be unreadable, never shown as 0.00", function () {
    const lines = [
      feedLine(item("PotFunded", { bonus: false })),
      feedLine(item("Pledged", { backer: A, amount: "-5", weight: "x" })),
      feedLine(item("Rescued", { amount: 760 })),
      feedLine(item("Finalized", { outcome: Outcome.Missed, bonusPaid: null })),
      feedLine(item("Paid", { backer: A, principal: "1e6", bonus: "abc" })),
      feedLine(item("SidePaid", { amount: "", side: 9 })),
    ];
    for (const line of lines) {
      assert.match(line, /an unreadable amount/, line);
      assert.doesNotMatch(line, /0\.00/, line);
    }
    assert.equal(lines[1], "0x0000…00a1 pledged an unreadable amount; whether it was early could not be read");
    assert.equal(lines[4], "0x0000…00a1 got an unreadable amount back plus an unreadable amount");
    assert.equal(lines[5], "an unreadable amount paid: an unnamed side");
    // An outcome the page does not know is not called Void.
    assert.equal(feedLine(item("Finalized", { outcome: 7, bonusPaid: "0" })), "Settled");
    assert.equal(feedLine(item("Finalized", {})), "Settled");
    // A pot whose kind cannot be read is not called the match.
    assert.equal(feedLine(item("PotFunded", { bonus: "yes", amount: "300000" })), "A pot of 0.30 locked");
    assert.equal(feedLine(item("PotFunded", { amount: "300000" })), "A pot of 0.30 locked");
  });

  it("an amount above nothing and under a cent reads less than 0.01, never 0.00", function () {
    assert.equal(feedLine(item("Paid", { backer: A, principal: "4999", bonus: "0" })), "0x0000…00a1 got less than 0.01 back");
    assert.equal(feedLine(item("Paid", { backer: A, principal: "20000000", bonus: "1" })), "0x0000…00a1 got 20.00 back plus less than 0.01");
    assert.equal(feedLine(item("Pledged", { backer: A, amount: "9999", weight: "0" })), "0x0000…00a1 pledged less than 0.01");
    assert.equal(feedLine(item("SidePaid", { amount: "1", side: Side.Recipient })), "less than 0.01 paid: the recipient");
    assert.equal(feedLine(item("Rescued", { amount: "10000" })), "The sponsor closed the gap with 0.01");
  });
});

describe("the ledger's shape", function () {
  const T = { recipient: B, opensAt: "100", earlyUntil: "200", closesAt: "300", target: "3000000", minPledge: "100000", matchAmount: "1000000", bonusPool: "300000", rateBps: 1000, linearWeight: false, bonusFromRecipient: false };
  const C = {
    id: "7", sponsor: A, terms: T, matchIn: true, bonusIn: true, outcome: 0, pledged: "0", pledgedEarly: "0", earlyUnknown: "0", weighted: "0", bonusPaid: "0",
    expectedBonusPaid: null, recipientPaid: false, matchReturned: false, bonusReturned: false, payFailures: 0, backers: [],
  };
  const wire = (over: Record<string, unknown> = {}) => ({ lastSeq: "3", totalOwed: "1300000", missing: null, campaigns: [C], feed: [], ...over });

  it("a well-formed ledger reads back", function () {
    const l = readLedger(wire());
    assert.equal(l.campaigns[0].id, 7n);
    assert.equal(l.campaigns[0].terms.target, 3_000_000n);
    assert.deepEqual(readLedger(wire({ missing: { from: "2", to: "2" } })).missing, { from: 2n, to: 2n });
  });

  it("an outcome that is not one of the four, a campaign listed twice and a hole that runs backwards are refused", function () {
    for (const bad of [99, 4, -1, 1.5, "1", null]) assert.throws(() => readLedger(wire({ campaigns: [{ ...C, outcome: bad }] })), /known outcome at campaigns\[0\]\.outcome/, String(bad));
    for (const good of [0, 1, 2, 3]) assert.equal(readLedger(wire({ campaigns: [{ ...C, outcome: good }] })).campaigns[0].outcome, good);
    assert.throws(() => readLedger(wire({ campaigns: [C, { ...C }] })), /id used only once at campaigns\[1\]\.id/);
    assert.equal(readLedger(wire({ campaigns: [C, { ...C, id: "8" }] })).campaigns.length, 2);
    assert.throws(() => readLedger(wire({ missing: { from: "6", to: "4" } })), /runs forwards at missing/);
  });
});

describe("the feed's transaction link", function () {
  const ledger = (txHash: unknown) => ({ lastSeq: "1", totalOwed: "0", missing: null, campaigns: [], feed: [{ name: "Finalized", seq: "1", id: "7", time: "5", txHash, outcome: 1, bonusPaid: "0" }] });

  it("a transaction hash is kept only when it is 0x and 64 hex digits", function () {
    const good = `0x${"ab".repeat(32)}`;
    assert.equal(readLedger(ledger(good)).feed[0].txHash, good);
    for (const bad of [`0x${"ab".repeat(31)}`, `${"ab".repeat(33)}`, `0x${"zz".repeat(32)}`, `0x${"ab".repeat(32)}"><script>`, "javascript:alert(1)", 5, null, undefined]) {
      assert.equal(readLedger(ledger(bad)).feed[0].txHash, null, String(bad));
    }
    // What is left over is the event's own fields.
    assert.deepEqual(readLedger(ledger(good)).feed[0].args, { outcome: 1, bonusPaid: "0" });
  });
});

describe("one backer against the contract", function () {
  const mine: LedgerBackerView = { address: A, principal: 30_000_000n, weighted: 30_000_000n, payTo: null, paid: false, paidPrincipal: 0n, paidBonus: 0n };
  const zero = "0x0000000000000000000000000000000000000000";

  it("the same record reads as no difference; an unset refund address is the zero address on chain", function () {
    assert.deepEqual(backerDifferences(mine, { principal: 30_000_000n, weighted: 30_000_000n, payTo: zero, paid: false }), []);
    assert.deepEqual(backerDifferences({ ...mine, payTo: B.toUpperCase().replace("0X", "0x") as typeof A }, { principal: 30_000_000n, weighted: 30_000_000n, payTo: B, paid: false }), []);
  });

  it("each field that differs is named with both values", function () {
    assert.deepEqual(backerDifferences(mine, { principal: 31_000_000n, weighted: 0n, payTo: B, paid: true }), [
      "pledged: ledger 30.00, contract 31.00",
      "weight: ledger 30000000, contract 0",
      "refund address: ledger 0x0000…0000, contract 0x0000…00b2",
      "paid: ledger no, contract yes",
    ]);
  });

  it("changed one field at a time, each backer field is still named", function () {
    const chain: Backer = { principal: 30_000_000n, weighted: 30_000_000n, payTo: zero as `0x${string}`, paid: false };
    const changes: [Partial<Backer>, RegExp][] = [
      [{ principal: 31_000_000n }, /^pledged:/],
      [{ weighted: 1n }, /^weight:/],
      [{ payTo: B }, /^refund address:/],
      [{ paid: true }, /^paid:/],
    ];
    for (const [over, label] of changes) {
      const diffs = backerDifferences(mine, { ...chain, ...over });
      assert.equal(diffs.length, 1, String(label));
      assert.match(diffs[0], label);
    }
  });
});

// The campaign comparison covers every Terms field and every State field, bonusPaid included.
describe("the campaign comparison covers every Terms and State field", function () {
  const T = { recipient: B, opensAt: "100", earlyUntil: "200", closesAt: "300", target: "3000000", minPledge: "100000", matchAmount: "1000000", bonusPool: "300000", rateBps: 1000, linearWeight: false, bonusFromRecipient: false };
  const C = {
    id: "7", sponsor: A, terms: T, matchIn: true, bonusIn: true, outcome: 2, pledged: "2000000", pledgedEarly: "1000000", earlyUnknown: "0", weighted: "1000000000000",
    bonusPaid: "250000", expectedBonusPaid: "250000", recipientPaid: false, matchReturned: false, bonusReturned: false, payFailures: 0, backers: [],
  };
  const ledger = readLedger({ lastSeq: "1", totalOwed: "0", missing: null, campaigns: [C], feed: [] }).campaigns[0];
  const terms = ledger.terms;
  const state = stateOf(ledger);

  it("matching terms and state report no difference", function () {
    assert.deepEqual(differences(ledger, { terms, state }), []);
    assert.ok("bonusPaid" in state, "bonusPaid is one of the State fields compared");
  });

  it("each State field, changed on the contract side, is named", function () {
    for (const key of Object.keys(state) as (keyof typeof state)[]) {
      const v = state[key];
      const changed = typeof v === "bigint" ? v + 1n : typeof v === "boolean" ? !v : typeof v === "number" ? v + 1 : `${v}0`;
      const diffs = differences(ledger, { terms, state: { ...state, [key]: changed } });
      assert.ok(
        diffs.some((d) => d.startsWith(`${key}:`)),
        `${key} not named: ${diffs.join(" | ")}`,
      );
    }
  });

  it("each Terms field, changed on the contract side, is named", function () {
    for (const key of Object.keys(terms) as (keyof typeof terms)[]) {
      const v = terms[key];
      const changed = typeof v === "bigint" ? v + 1n : typeof v === "boolean" ? !v : typeof v === "number" ? v + 1 : `${v}0`;
      const diffs = differences(ledger, { terms: { ...terms, [key]: changed }, state });
      assert.ok(
        diffs.some((d) => d.startsWith(`terms.${key}:`)),
        `terms.${key} not named: ${diffs.join(" | ")}`,
      );
    }
  });
});

describe("the ledger as a whole against the contract", function () {
  const view = (over: Partial<LedgerView>): LedgerView => ({ lastSeq: 12n, totalOwed: 50_000_000n, missing: null, campaigns: [], feed: [], ...over });

  it("level and equal: nothing to report", function () {
    assert.deepEqual(standing(view({}), { owed: 50_000_000n, events: 12n }), { kind: "level", differences: [] });
  });

  it("a ledger with fewer events than the contract is behind, and its figures are not compared", function () {
    assert.deepEqual(standing(view({ lastSeq: 9n, totalOwed: 1n }), { owed: 50_000_000n, events: 12n }), { kind: "behind", by: 3n });
  });

  it("a ledger with more events than the contract is not this contract's ledger", function () {
    assert.deepEqual(standing(view({ lastSeq: 14n }), { owed: 50_000_000n, events: 12n }), { kind: "ahead", by: 2n });
  });

  it("level but different: the total owed and any hole in the events are named", function () {
    assert.deepEqual(standing(view({ totalOwed: 49_000_000n, missing: { from: 4n, to: 6n } }), { owed: 50_000_000n, events: 12n }), {
      kind: "level",
      differences: ["events 4 to 6 never reached the ledger", "owed in total: ledger 49.00, contract 50.00"],
    });
  });
});
