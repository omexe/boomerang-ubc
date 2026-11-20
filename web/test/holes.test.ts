// What the page must still do, and say truthfully, when the keeper is down, when a visitor has
// no wallet, and at the edges of the terms (no match, no bonus paid, a bonus the recipient funded,
// more campaigns than one read takes in). Each case here was a hole found by running the app with
// the keeper frozen, or by an audit of the page's sentences against the contract.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { State, Terms } from "../../packages/kit/src/index.ts";
import { Outcome } from "../../packages/kit/src/index.ts";
import type { CampaignView, MyPledge } from "../src/data/load.ts";
import { paySideCall } from "../src/flows/calls.ts";
import { campaignPage, missingPage } from "../src/views/campaign.ts";
import { homePage } from "../src/views/home.ts";
import { ledgerSub, ledgerView } from "../src/views/ledger.ts";
import { minePage } from "../src/views/mine.ts";
import { pledgeForm } from "../src/views/pledge.ts";

const RECIPIENT = "0x00000000000000000000000000000000000000aa" as const;
const SPONSOR = "0x00000000000000000000000000000000000000b1" as const;
const ME = "0x00000000000000000000000000000000000000c3" as const;
const BOOMERANG = "0x00000000000000000000000000000000000000b0" as const;
const USDC = "0x3600000000000000000000000000000000000000" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const usd = (n: number) => BigInt(Math.round(n * 1_000_000));
const OPENS = 1_794_000_000n;
const DAY = 86_400n;
const AFTER = OPENS + 8n * DAY;

const terms = (over: Partial<Terms> = {}): Terms => ({
  recipient: RECIPIENT, opensAt: OPENS, earlyUntil: OPENS + DAY, closesAt: OPENS + 7n * DAY, target: usd(2000), minPledge: usd(5),
  matchAmount: usd(500), bonusPool: usd(100), rateBps: 1000, linearWeight: false, bonusFromRecipient: false, ...over,
});
const state = (over: Partial<State> = {}): State => ({
  sponsor: SPONSOR, outcome: Outcome.Open, matchIn: true, bonusIn: true, recipientPaid: false, matchReturned: false, bonusReturned: false,
  backers: 31, pledged: usd(1240), pledgedEarly: usd(1240), weighted: usd(1240) * 1_000_000n, bonusPaid: 0n, ...over,
});
const campaign = (t: Partial<Terms> = {}, s: Partial<State> = {}, id = 7n): CampaignView => ({ id, terms: terms(t), state: state(s), outcomeNow: 0 });
const page = (c: CampaignView, pace: "prompt" | "behind" | "down" = "prompt", now = AFTER) => campaignPage({ campaign: c, labels: [], desk: null, now, block: 99n, pace });

describe("what a settled campaign still owes, and who can send it", function () {
  it("dues.funded: the recipient and the unused bonus, each with a button anyone may press", function () {
    const p = page(campaign({}, { outcome: Outcome.Funded, pledged: usd(2000) }));
    assert.deepEqual(p.dues, [
      { side: 0, button: "Pay the recipient", line: "2,500.00 USDC is owed to the recipient." },
      { side: 2, button: "Return the bonus", line: "100.00 USDC of bonus that was not paid out is owed back to the sponsor." },
    ]);
    assert.equal(p.duesNote, "Anyone can send these, and each can only pay the address the contract names. The keeper usually does it within seconds.");
  });

  it("dues.missed: the match, and only the part of the bonus the backers did not earn", function () {
    const p = page(campaign({}, { outcome: Outcome.Missed, bonusPaid: usd(62) }));
    assert.deepEqual(p.dues, [
      { side: 1, button: "Return the match", line: "The sponsor's 500.00 USDC match is owed back to the sponsor." },
      { side: 2, button: "Return the bonus", line: "38.00 USDC of bonus that was not paid out is owed back to the sponsor." },
    ]);
    // Every cent of the bonus earned: nothing of it is owed back.
    assert.deepEqual(page(campaign({}, { outcome: Outcome.Missed, bonusPaid: usd(100) })).dues.map((d) => d.side), [1]);
  });

  it("dues.funder: a bonus the recipient locked goes back to the recipient", function () {
    const p = page(campaign({ bonusFromRecipient: true }, { outcome: Outcome.Void, pledged: 0n, backers: 0 }));
    assert.deepEqual(p.dues.map((d) => d.line), [
      "The sponsor's 500.00 USDC match is owed back to the sponsor.",
      "100.00 USDC of bonus that was not paid out is owed back to the recipient.",
    ]);
  });

  it("dues.none: nothing while it is open, nothing once the contract's flags say paid, nothing for a pot never locked or of zero", function () {
    assert.deepEqual(page(campaign(), "prompt", OPENS + DAY).dues, []);
    assert.deepEqual(page(campaign({}, { outcome: Outcome.Funded, pledged: usd(2000), recipientPaid: true, bonusReturned: true })).dues, []);
    assert.deepEqual(page(campaign({}, { outcome: Outcome.Missed, matchReturned: true, bonusReturned: true })).dues, []);
    assert.deepEqual(page(campaign({}, { outcome: Outcome.Void, matchIn: false, bonusIn: false })).dues, []);
    assert.deepEqual(page(campaign({ matchAmount: 0n, bonusPool: 0n }, { outcome: Outcome.Missed, matchIn: false, bonusIn: false })).dues, []);
    assert.equal(page(campaign({}, { outcome: Outcome.Funded, pledged: usd(2000), recipientPaid: true, bonusReturned: true })).duesNote, null);
  });

  it("dues.keeperDown: no sentence promises the keeper while it is not answering", function () {
    const due = page(campaign({}, { outcome: Outcome.Funded, pledged: usd(2000) }), "down");
    assert.equal(due.duesNote, "Anyone can send these, and each can only pay the address the contract names. The keeper is not answering right now, so they wait for someone to press them.");
    const ended = page(campaign(), "down");
    assert.deepEqual(ended.settle, { button: "Settle this campaign", note: "Anyone can do this, and it can only do what the rules say. The keeper is not answering right now, so it waits for someone to press this." });
    const mine: MyPledge = {
      campaign: campaign({}, { outcome: Outcome.Missed, bonusPaid: usd(62) }, 3n),
      backer: { principal: usd(124), weighted: usd(124) * 1_000_000n, payTo: ZERO, paid: false },
      owed: { principal: usd(124), bonus: usd(6.2) },
      ifMissed: { principal: 0n, bonus: 0n },
    };
    const my = minePage({ account: ME, mine: [mine], labels: [], desk: null, block: 9n, pace: "down" });
    assert.equal(my.rows[0].send?.note, "Anyone can send this, and it can only pay the backer's own refund address. The keeper is not answering right now, so it waits for someone to press it.");
  });

  it("campaign.behind: a keeper behind the chain waits to be pressed, in each of the three sentences", function () {
    const settle = page(campaign(), "behind");
    assert.deepEqual(settle.settle, {
      button: "Settle this campaign",
      note: "Anyone can do this, and it can only do what the rules say. The keeper is behind the chain right now, so it waits for someone to press this.",
    });
    const dues = page(campaign({}, { outcome: Outcome.Funded, pledged: usd(2000) }), "behind");
    assert.equal(dues.duesNote, "Anyone can send these, and each can only pay the address the contract names. The keeper is behind the chain right now, so they wait for someone to press them.");
    const missed = page(campaign({}, { outcome: Outcome.Missed, bonusPaid: usd(62) }), "behind");
    assert.equal(missed.refunds, "A backer can send their own refund from this page with their wallet connected. The keeper is behind the chain right now, so it may not send it first.");
  });

  it("mine.behind: both send-note forms say the keeper is behind the chain", function () {
    const mine: MyPledge = {
      campaign: campaign({}, { outcome: Outcome.Missed, bonusPaid: usd(62) }, 3n),
      backer: { principal: usd(124), weighted: usd(124) * 1_000_000n, payTo: ZERO, paid: false },
      owed: { principal: usd(124), bonus: usd(6.2) },
      ifMissed: { principal: 0n, bonus: 0n },
    };
    const own = minePage({ account: ME, mine: [mine], labels: [], desk: null, block: 9n, pace: "behind" });
    assert.equal(own.rows[0].send?.note, "Anyone can send this, and it can only pay the backer's own refund address. The keeper is behind the chain right now, so it waits for someone to press it.");
    const other = minePage({ account: ME, mine: [mine], labels: [], desk: null, block: 9n, pace: "behind", whose: "other" });
    assert.equal(other.rows[0].send?.note, "Anyone can send this, and it can only pay this backer's refund address. The keeper is behind the chain right now, so it waits for someone to press it.");
  });

  it("dues.call: the call is paySide with the side's number", function () {
    const call = paySideCall({ boomerang: BOOMERANG, id: 7n, side: 1, label: "Return the match" });
    assert.deepEqual([call.to, call.functionName, call.args, call.label], [BOOMERANG, "paySide", [7n, 1], "Return the match"]);
  });

  it("a missed campaign promises a bonus only when early backers earned one", function () {
    assert.equal(page(campaign({}, { outcome: Outcome.Missed, bonusPaid: usd(62) })).promise, "The goal was missed. Every pledge goes back to its backer, and early backers share the bonus.");
    assert.equal(page(campaign({}, { outcome: Outcome.Missed, bonusPaid: 0n })).promise, "The goal was missed. Every pledge goes back to its backer.");
  });

  it("after settling, a backer is pointed to their refund", function () {
    assert.equal(page(campaign({}, { outcome: Outcome.Missed, bonusPaid: usd(62) })).refunds, "A backer can send their own refund from this page with their wallet connected. The keeper usually sends it first, within seconds.");
    assert.equal(page(campaign({}, { outcome: Outcome.Missed, bonusPaid: usd(62) }), "down").refunds, "A backer can send their own refund from this page with their wallet connected. The keeper is not answering right now.");
    assert.equal(page(campaign({}, { outcome: Outcome.Funded, pledged: usd(2000) })).refunds, null);
  });
});

describe("a visitor with no wallet", function () {
  const form = (hasWallet: boolean) =>
    pledgeForm({ campaign: campaign(), where: { boomerang: BOOMERANG, usdc: USDC }, amountText: "25", now: OPENS + 60n, account: null, balance: null, allowance: null, onRightChain: false, answer: { wouldFund: false, counted: usd(25), bonus: usd(2.5) }, hasWallet });

  it("noWallet.cheque: the button does not offer to connect a wallet that is not there", function () {
    const none = form(false);
    assert.equal(none.button, "No wallet in this browser");
    assert.equal(none.canSend, false);
    assert.deepEqual(none.blocks, ["To pledge you need a wallet with USDC on Arc Testnet, and this browser has none. Everything else here can be read without one."]);
    const some = form(true);
    assert.equal(some.button, "Connect a wallet");
    assert.deepEqual(some.blocks, ["Connect a wallet to pledge."]);
  });

  it("noWallet.mine: My money says there is no wallet instead of asking to connect one", function () {
    assert.equal(minePage({ account: null, mine: [], labels: [], desk: null, block: 9n, hasWallet: false }).empty, "No wallet found in this browser, so there are no pledges to show. Every campaign can be read without one.");
    assert.equal(minePage({ account: null, mine: [], labels: [], desk: null, block: 9n }).empty, "Connect a wallet to see your pledges.");
  });
});

describe("the approval is for what the contract will take", function () {
  it("approve.taken: typing more than the campaign still needs approves only the part that is taken", function () {
    const c = campaign({}, { pledged: usd(1990) });
    const f = pledgeForm({ campaign: c, where: { boomerang: BOOMERANG, usdc: USDC }, amountText: "25", now: OPENS + 60n, account: ME, balance: usd(100), allowance: 0n, onRightChain: true, answer: { wouldFund: true, counted: usd(10), bonus: 0n } });
    assert.deepEqual(f.calls.map((x) => [x.functionName, x.args]), [["approve", [BOOMERANG, usd(10)]], ["pledge", [7n, usd(25)]]]);
    // An allowance that already covers what is taken needs no approval.
    const g = pledgeForm({ campaign: c, where: { boomerang: BOOMERANG, usdc: USDC }, amountText: "25", now: OPENS + 60n, account: ME, balance: usd(100), allowance: usd(10), onRightChain: true, answer: { wouldFund: true, counted: usd(10), bonus: 0n } });
    assert.deepEqual(g.calls.map((x) => x.functionName), ["pledge"]);
  });
});

describe("gas paid in USDC", function () {
  const c = campaign();
  const form = (balance: bigint, gasReserve: bigint) =>
    pledgeForm({ campaign: c, where: { boomerang: BOOMERANG, usdc: USDC }, amountText: "2", now: OPENS + 60n, account: ME, balance, allowance: 0n, onRightChain: true, answer: { wouldFund: false, counted: usd(2), bonus: 0n }, gasReserve });

  it("gas.reserve: a pledge the visitor sends themself must leave something for gas; one the keeper sends need not", function () {
    const short = form(usd(2), 20_000n);
    assert.equal(short.canSend, false);
    assert.deepEqual(short.blocks, ["Gas on this network is paid in USDC, so this account must keep about 0.02 for it. It holds 2.00 USDC and can pledge up to 1.98."]);
    assert.equal(form(usd(2.02), 20_000n).canSend, true);
    assert.equal(form(usd(2), 0n).canSend, true);
  });
});

describe("more campaigns than one read takes in", function () {
  it("cap.missing: a number the contract has is being read, not missing; one it does not have is missing", function () {
    assert.deepEqual(missingPage({ id: 1n, count: 60n, expected: false }), { loading: true, title: "Reading campaign 1", line: "", homeHref: "#/" });
    assert.deepEqual(missingPage({ id: 61n, count: 60n, expected: true }), { loading: true, title: "Reading campaign 61", line: "", homeHref: "#/" });
    assert.deepEqual(missingPage({ id: 61n, count: 60n, expected: false }), { loading: false, title: "There is no campaign 61", line: "This contract has campaigns 1 to 60.", homeHref: "#/" });
  });

  it("cap.words: the table and the totals say how many the contract has, and how many were read", function () {
    assert.equal(ledgerSub({ count: 5n, read: 5 }), "Every campaign on the contract, read from the chain. Each one that has closed paid out at most one of its two pots.");
    assert.equal(ledgerSub({ count: 60n, read: 50 }), "The newest 50 of the contract's 60 campaigns, read from the chain. Each one that has closed paid out at most one of its two pots.");
    const home = homePage({ campaigns: [campaign()], count: 60n, labels: [], desk: null, now: OPENS + 60n, block: 9n });
    assert.deepEqual(home.totals[0], { label: "Campaigns", value: "60" });
    assert.deepEqual(home.totals[home.totals.length - 1], { label: "The sums of backers and money cover", value: "the newest 1 of 60 campaigns" });
    const all = homePage({ campaigns: [campaign()], count: 1n, labels: [], desk: null, now: OPENS + 60n, block: 9n });
    assert.equal(all.totals.length, home.totals.length - 1);
    const my = minePage({ account: ME, mine: [], labels: [], desk: null, block: 9n, count: 60n, read: 50 });
    assert.equal(my.empty, "This account has not pledged to any of the newest 50 campaigns. Older ones are not read by this page.");
    const some: MyPledge = { campaign: campaign(), backer: { principal: usd(25), weighted: 0n, payTo: ZERO, paid: false }, owed: { principal: 0n, bonus: 0n }, ifMissed: { principal: 0n, bonus: 0n } };
    const capped = minePage({ account: ME, mine: [some], labels: [], desk: null, block: 9n, count: 60n, read: 50 });
    assert.deepEqual(capped.totals[capped.totals.length - 1], { label: "Looked for in", value: "the newest 50 of 60 campaigns" });
  });
});

describe("the campaigns table", function () {
  const view = (c: CampaignView) => ledgerView({ campaigns: [c], labels: [], desk: null, now: AFTER, block: 9n }).rows[0].mark;

  it("marks.zero: a stamp never shows a pot of 0.00", function () {
    assert.equal(view(campaign({ matchAmount: 0n }, { outcome: Outcome.Funded, pledged: usd(2000), matchIn: false })).small, "2,000.00");
    assert.equal(view(campaign({}, { outcome: Outcome.Funded, pledged: usd(2000) })).small, "2,000.00 + 500.00 match");
    assert.equal(view(campaign({}, { outcome: Outcome.Missed, bonusPaid: 0n })).small, "1,240.00");
    assert.equal(view(campaign({}, { outcome: Outcome.Missed, bonusPaid: usd(62) })).small, "1,240.00 + 62.00 bonus");
  });
});
