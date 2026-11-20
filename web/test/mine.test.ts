// My money's look-up field, another account's money (and the example backer shown when nobody is
// connected), and the four figures above the rows. Every sentence a visitor reads comes from a view
// function and is asserted here against its exact words. Fixture style follows holes.test.ts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { State, Terms } from "../../packages/kit/src/index.ts";
import { Outcome } from "../../packages/kit/src/index.ts";
import type { CampaignView, MyPledge } from "../src/data/load.ts";
import { LOOKUP, lookupForm, minePage } from "../src/views/mine.ts";

const RECIPIENT = "0x00000000000000000000000000000000000000aa" as const;
const SPONSOR = "0x00000000000000000000000000000000000000b1" as const;
const ME = "0x00000000000000000000000000000000000000c3" as const;
const OTHER = "0x00000000000000000000000000000000000000d4" as const;
const CHOSEN = "0x00000000000000000000000000000000000000e5" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const usd = (n: number) => BigInt(Math.round(n * 1_000_000));
const OPENS = 1_794_000_000n;
const DAY = 86_400n;

const terms = (over: Partial<Terms> = {}): Terms => ({
  recipient: RECIPIENT, opensAt: OPENS, earlyUntil: OPENS + DAY, closesAt: OPENS + 7n * DAY, target: usd(2000), minPledge: usd(5),
  matchAmount: usd(500), bonusPool: usd(100), rateBps: 1000, linearWeight: false, bonusFromRecipient: false, ...over,
});
const state = (over: Partial<State> = {}): State => ({
  sponsor: SPONSOR, outcome: Outcome.Open, matchIn: true, bonusIn: true, recipientPaid: false, matchReturned: false, bonusReturned: false,
  backers: 31, pledged: usd(1240), pledgedEarly: usd(1240), weighted: usd(1240) * 1_000_000n, bonusPaid: 0n, ...over,
});
const campaign = (t: Partial<Terms> = {}, s: Partial<State> = {}, id = 7n): CampaignView => ({ id, terms: terms(t), state: state(s), outcomeNow: 0 });
const pledge = (c: CampaignView, principal: bigint, over: Partial<MyPledge["backer"]> = {}): MyPledge => ({
  campaign: c,
  backer: { principal, weighted: principal * 1_000_000n, payTo: ZERO, paid: false, ...over },
  owed: { principal: 0n, bonus: 0n },
  ifMissed: { principal: 0n, bonus: 0n },
});

// Campaigns used across the tests.
const funded = campaign({}, { outcome: Outcome.Funded, pledged: usd(2000) }, 2n);
const missed = (id: bigint) => campaign({}, { outcome: Outcome.Missed, bonusPaid: usd(62) }, id);

describe("My money: look up any address", function () {
  const PROBLEM = "That is not an address. An address is 0x followed by 40 letters and digits.";

  it("lookup.form: empty, good, 0X and mixed case, spaces, wrong length and non-hex", function () {
    assert.deepEqual(LOOKUP, { label: "Look up any address", button: "Look up", back: "Back to my own money" });
    // Empty, or whitespace only: nothing asked, no problem.
    assert.deepEqual(lookupForm(""), { href: null, problem: null });
    assert.deepEqual(lookupForm("   "), { href: null, problem: null });
    // A good address: the href carries a lowercase 0x and the digits as typed.
    const good = "0x" + "a".repeat(40);
    assert.deepEqual(lookupForm(good), { href: `#/mine/${good}`, problem: null });
    // 0X prefix and mixed-case digits: the prefix is lowered, the digits are kept as typed.
    const digits = "aB".repeat(20); // 40 hex, mixed case
    assert.deepEqual(lookupForm("0X" + digits), { href: `#/mine/0x${digits}`, problem: null });
    // Leading and trailing spaces are trimmed, not refused.
    assert.deepEqual(lookupForm("  " + good + "  "), { href: `#/mine/${good}`, problem: null });
    // 39 and 41 digits, and a non-hex digit: the exact problem sentence, no href.
    assert.deepEqual(lookupForm("0x" + "a".repeat(39)), { href: null, problem: PROBLEM });
    assert.deepEqual(lookupForm("0x" + "a".repeat(41)), { href: null, problem: PROBLEM });
    assert.deepEqual(lookupForm("0x" + "g".repeat(40)), { href: null, problem: PROBLEM });
  });
});

describe("My money: another account", function () {
  // Two owed refunds for OTHER: one to its own address, one pointed elsewhere.
  const mine = [pledge(missed(3n), usd(124)), pledge(missed(7n), usd(124), { payTo: CHOSEN })];
  const other = minePage({ account: OTHER, mine, labels: [], desk: null, block: 9n, whose: "other" });

  it("mine.other: the sentences, send, refundTo and totals read in the third person", function () {
    assert.deepEqual(other.subject, {
      tag: "Another account",
      address: OTHER,
      note: "Read from the contract, as anyone can. Nothing here needs that account's permission.",
    });
    assert.equal(other.account, "0x0000…00d4");
    // The owed line reads about this backer, not "you".
    assert.equal(other.rows[0].line, "124.00 plus 6.20 bonus is owed to this backer. Anyone can send it.");
    assert.deepEqual(other.rows[0].send, {
      button: "Send this refund",
      note: "Anyone can send this, and it can only pay this backer's refund address. The keeper usually does it within seconds.",
      campaign: 3n,
    });
    assert.equal(other.rows[0].refundTo, null);
    // A refund pointed elsewhere says where it goes, as this backer asked.
    assert.equal(other.rows[1].line, "130.20 is owed and will go to 0x0000…00e5, the address this backer chose.");
    assert.equal(other.rows[1].refundTo, "A refund would go to 0x0000…00e5, as this backer asked.");
    // Totals carry the third-person labels.
    assert.deepEqual(other.totals, [
      { label: "In campaigns not yet settled", value: "0.00 USDC" },
      { label: "Owed to this account now", value: "260.40 USDC" },
      { label: "Came back to this account", value: "0.00 USDC" },
      { label: "Went to funded campaigns", value: "0.00 USDC" },
    ]);
    assert.equal(other.connectNote, "Connect a wallet to send it.");
  });

  it("mine.other.noWallet: with no wallet in the browser, the note does not tell the visitor to connect one", function () {
    const none = minePage({ account: OTHER, mine, labels: [], desk: null, block: 9n, whose: "other", hasWallet: false });
    assert.equal(none.connectNote, "Sending it takes a wallet, and this browser has none.");
    // Nothing owed: no note at all, whatever the browser has.
    const settled = minePage({ account: OTHER, mine: [pledge(funded, usd(40))], labels: [], desk: null, block: 9n, whose: "other", hasWallet: false });
    assert.equal(settled.connectNote, null);
  });

  it("mine.other.chosen: refunds paid elsewhere, and how far the page looked, are said of this account", function () {
    const paid = [pledge(missed(5n), usd(124), { paid: true, payTo: CHOSEN })];
    const p = minePage({ account: OTHER, mine: paid, labels: [], desk: null, block: 9n, whose: "other", count: 80n, read: 50 });
    assert.deepEqual(p.totals.slice(4), [
      { label: "Paid to addresses it chose", value: "130.20 USDC" },
      { label: "Looked for in", value: "the newest 50 of 80 campaigns" },
    ]);
    assert.equal(p.connectNote, null);
  });

  it("mine.other.empty: an account with no pledge here says so, for another account and for the example alike", function () {
    for (const whose of ["other", "example"] as const) {
      const all = minePage({ account: OTHER, mine: [], labels: [], desk: null, block: 9n, whose, count: 3n, read: 3 });
      assert.equal(all.empty, "This account has not pledged to any campaign here.");
      assert.deepEqual(all.rows, []);
      assert.deepEqual(all.figures.map((f) => f.value), ["0", "0", "0.00 USDC", "0.00 USDC"]);
      const capped = minePage({ account: OTHER, mine: [], labels: [], desk: null, block: 9n, whose, count: 80n, read: 50 });
      assert.equal(capped.empty, "This account has not pledged to any of the newest 50 campaigns. Older ones are not read by this page.");
    }
  });

  it("mine.other.keeperDown: the send note says the keeper is not answering", function () {
    const down = minePage({ account: OTHER, mine, labels: [], desk: null, block: 9n, pace: "down", whose: "other" });
    assert.equal(
      down.rows[0].send?.note,
      "Anyone can send this, and it can only pay this backer's refund address. The keeper is not answering right now, so it waits for someone to press it.",
    );
  });
});

describe("My money: an example backer", function () {
  const mine = [pledge(missed(3n), usd(124)), pledge(missed(7n), usd(124), { payTo: CHOSEN })];
  const other = minePage({ account: OTHER, mine, labels: [], desk: null, block: 9n, whose: "other" });
  const example = minePage({ account: OTHER, mine, labels: [], desk: null, block: 9n, whose: "example" });

  it("mine.example: its own tag and note, and the same rows as another account", function () {
    assert.deepEqual(example.subject, {
      tag: "An example",
      address: OTHER,
      note: "A real backer on this contract, shown so the page is not empty. Connect a wallet to see your own money, or look any address up.",
    });
    // The rows are read exactly as another account's are.
    assert.deepEqual(example.rows, other.rows);
    assert.deepEqual(example.totals, other.totals);
  });
});

describe("My money: the four figures", function () {
  // A mix: one counted, one given, one only owed, two returned (one pointed elsewhere).
  const open = campaign({}, {}, 4n);
  const mine = [
    pledge(open, usd(25)), // counted, early (weighted > 0)
    pledge(funded, usd(40), { weighted: 0n }), // given, not early
    pledge(missed(3n), usd(124)), // owed only — must not count as paid back
    pledge(missed(5n), usd(124), { paid: true }), // returned, came back
    pledge(missed(6n), usd(124), { paid: true, payTo: CHOSEN }), // returned, paid elsewhere
  ];

  it("mine.figures: four labels in order; counts and sums over the mix", function () {
    const p = minePage({ account: ME, mine, labels: [], desk: null, block: 9n });
    assert.deepEqual(p.figures, [
      { label: "Campaigns backed", value: "5" },
      { label: "Backed early", value: "4" }, // every row but the given one has weight
      { label: "Paid back", value: "260.40 USDC" }, // the two returned pledges only (130.20 each); the owed one is not here
      { label: "Went to cleared campaigns", value: "40.00 USDC" },
    ]);
  });
});

describe("My money: own account unchanged, and nobody to show", function () {
  it("mine.own: with whose left out, rows, empty, totals, account and asOf keep their values", function () {
    const p = minePage({ account: ME, mine: [pledge(funded, usd(40))], labels: [], desk: null, block: 9n });
    // Expectation computed by hand from the view's rules, not from the function itself.
    assert.equal(p.account, "0x0000…00c3");
    assert.equal(p.asOf, "As of block 9");
    assert.equal(p.empty, null);
    assert.deepEqual(p.rows, [
      { href: "#/campaign/2", title: "Campaign 2", kind: "given", line: "40.00 went to the campaign. It was funded.", refundTo: null, send: null },
    ]);
    assert.deepEqual(p.totals, [
      { label: "In campaigns not yet settled", value: "0.00 USDC" },
      { label: "Owed to you now", value: "0.00 USDC" },
      { label: "Came back to you", value: "0.00 USDC" },
      { label: "Went to funded campaigns", value: "40.00 USDC" },
    ]);
  });

  it("mine.none: a null account gives no figures, a null subject and no connect note", function () {
    const p = minePage({ account: null, mine: [], labels: [], desk: null, block: 9n });
    assert.deepEqual(p.figures, []);
    assert.deepEqual(p.subject, { tag: null, address: null, note: null });
    assert.equal(p.connectNote, null);
  });
});
