// Every amount, address, name and time in these tests is invented. None is a reading of any real campaign.
//
// The page views: what the Campaign and Pledge pages say, as plain values.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Backer, State, Terms } from "../../packages/kit/src/index.ts";
import { Outcome } from "../../packages/kit/src/index.ts";
import { quotePledge } from "../src/data/campaign.ts";
import type { LedgerView } from "../src/data/keeper.ts";
import type { CampaignView } from "../src/data/load.ts";
import { utcStamp } from "../src/data/time.ts";
import { campaignPage, CONTROL, lostPage, noSuchCampaign, percentOf } from "../src/views/campaign.ts";
import { FEED_DOWN, feedView } from "../src/views/feed.ts";
import { pledgeForm, requote } from "../src/views/pledge.ts";

const RECIPIENT = "0x00000000000000000000000000000000000000aa" as const;
const SPONSOR = "0x00000000000000000000000000000000000000b1" as const;
const ME = "0x00000000000000000000000000000000000000c3" as const;
const BOOMERANG = "0x00000000000000000000000000000000000000b0" as const;
const USDC = "0x3600000000000000000000000000000000000000" as const;
const usd = (n: number) => BigInt(Math.round(n * 1_000_000));
const OPENS = 1_794_000_000n; // 6 Nov 2026, 21:20 UTC

const terms = (over: Partial<Terms> = {}): Terms => ({
  recipient: RECIPIENT,
  opensAt: OPENS,
  earlyUntil: OPENS + 86_400n,
  closesAt: OPENS + 7n * 86_400n,
  target: usd(2000),
  minPledge: usd(5),
  matchAmount: usd(500),
  bonusPool: usd(100),
  rateBps: 1000,
  linearWeight: false,
  bonusFromRecipient: false,
  ...over,
});
const state = (over: Partial<State> = {}): State => ({
  sponsor: SPONSOR,
  outcome: Outcome.Open,
  matchIn: true,
  bonusIn: true,
  recipientPaid: false,
  matchReturned: false,
  bonusReturned: false,
  backers: 31,
  pledged: usd(1240),
  pledgedEarly: usd(1240),
  weighted: usd(1240) * 1_000_000n,
  bonusPaid: 0n,
  ...over,
});
const campaign = (t: Partial<Terms> = {}, s: Partial<State> = {}): CampaignView => ({ id: 7n, terms: terms(t), state: state(s), outcomeNow: 0 });
const page = (c: CampaignView, now: bigint) => campaignPage({ campaign: c, labels: [], desk: null, now, block: 99n });

describe("dates", function () {
  it("a chain time reads the same for everyone", function () {
    assert.equal(utcStamp(0n), "1 Jan 1970, 00:00 UTC");
    assert.equal(utcStamp(OPENS), "6 Nov 2026, 21:20 UTC");
    assert.equal(utcStamp(1_794_009_599n), "6 Nov 2026, 23:59 UTC");
    assert.equal(utcStamp(-1n), "an unreadable date");
    assert.equal(utcStamp(10n ** 30n), "an unreadable date");
  });
});

describe("the Campaign page", function () {
  it("view.campaign: an open campaign in its early window, word for word", function () {
    assert.deepEqual(page(campaign(), OPENS + 3_600n), {
      name: { title: "Campaign 7", by: "Paid to 0x0000…00aa", sponsorName: "0x0000…00b1", about: "", example: false, labelled: false },
      phase: "early",
      status: "Early bonus open",
      clock: "Early bonus window closes in 23 hours",
      raised: "1,240.00 of 2,000.00 USDC",
      percent: 62,
      gap: "760.00 USDC to go",
      backers: "31 backers",
      promise:
        "If the target is met, the sponsor's 500.00 USDC match is added and everything goes to the recipient. If it is missed, every pledge comes back in full, and early backers split a bonus of up to 100.00 USDC.",
      rows: [
        { label: "Target", value: "2,000.00 USDC" },
        { label: "Smallest pledge", value: "5.00 USDC" },
        { label: "Sponsor's match", value: "500.00 USDC, locked in the contract" },
        { label: "Bonus pool", value: "100.00 USDC from the sponsor, locked in the contract" },
        { label: "Early bonus", value: "Up to 10% of an early pledge, more the more of the target is pledged early. The same for every pledge in the early window." },
        { label: "Opens", value: "6 Nov 2026, 21:20 UTC" },
        { label: "Early window ends", value: "7 Nov 2026, 21:20 UTC" },
        { label: "Closes", value: "13 Nov 2026, 21:20 UTC" },
        { label: "Paid to", value: "0x0000…00aa", address: RECIPIENT },
        { label: "Sponsor", value: "0x0000…00b1", address: SPONSOR },
      ],
      pledgeHref: "#/campaign/7/pledge",
      pledgeWhy: null,
      settle: null,
      dues: [],
      duesNote: null,
      refunds: null,
      control: CONTROL,
      asOf: "As of block 99",
    });
  });

  it("terms with no match and no bonus say so, and a bonus from the recipient with a falling weight is described as such", function () {
    const bare = page(campaign({ matchAmount: 0n, bonusPool: 0n }, { matchIn: false, bonusIn: false }), OPENS + 3_600n);
    assert.equal(bare.promise, "If the target is met, everything goes to the recipient. If it is missed, every pledge comes back in full.");
    assert.deepEqual(bare.rows.slice(2, 5).map((r) => r.label), ["Sponsor's match", "Bonus pool", "Opens"]);
    assert.deepEqual(bare.rows.slice(2, 4).map((r) => r.value), ["None", "None"]);
    const falling = page(campaign({ bonusFromRecipient: true, linearWeight: true, rateBps: 250 }), OPENS + 3_600n);
    assert.equal(falling.rows[3].value, "100.00 USDC from the recipient, locked in the contract");
    assert.equal(falling.rows[4].value, "Up to 2.5% of an early pledge, more the more of the target is pledged early. Worth most at opening, falling to nothing by the end of the early window.");
    assert.deepEqual([1000, 250, 125, 5, 10000].map(percentOf), ["10", "2.5", "1.25", "0.05", "100"]);
  });

  it("with no bonus pool, a campaign in its opening window reads plainly Open, with no early-bonus words", function () {
    const noBonus = page(campaign({ bonusPool: 0n }, { bonusIn: false }), OPENS + 3_600n);
    assert.equal(noBonus.phase, "early");
    assert.equal(noBonus.status, "Open");
    assert.match(noBonus.clock, /^Closes in /);
    assert.ok(!noBonus.rows.some((r) => r.label === "Early bonus"));
    // With a bonus pool the same window still shows the early words.
    const withBonus = page(campaign(), OPENS + 3_600n);
    assert.equal(withBonus.status, "Early bonus open");
    assert.match(withBonus.clock, /^Early bonus window closes in/);
  });

  it("before opening it takes no pledge, and says whether the sponsor's pots are in", function () {
    const ready = page(campaign(), OPENS - 7_200n);
    assert.equal(ready.status, "Opens soon");
    assert.equal(ready.pledgeHref, null);
    assert.equal(ready.pledgeWhy, "It takes pledges once it opens.");
    const short = page(campaign({}, { bonusIn: false }), OPENS - 7_200n);
    assert.equal(short.status, "Waiting for the sponsor");
    assert.equal(short.rows[3].value, "100.00 USDC from the sponsor, not locked yet");
  });

  it("past the deadline and unsettled: anyone may settle it, and the page says what settling does", function () {
    const due = page(campaign(), OPENS + 8n * 86_400n);
    assert.equal(due.phase, "ended");
    assert.equal(due.status, "Waiting to be settled");
    assert.deepEqual(due.settle, { button: "Settle this campaign", note: "Anyone can do this, and it can only do what the rules say. The keeper usually does it within seconds." });
    assert.equal(due.promise, "The deadline passed short of the target. Once it is settled, every pledge goes back to its backer, and early backers share the bonus.");
    assert.equal(due.pledgeWhy, "This campaign is no longer taking pledges.");
    const opensVoid = page(campaign({}, { matchIn: false, backers: 0, pledged: 0n, pledgedEarly: 0n, weighted: 0n }), OPENS + 10n);
    assert.equal(opensVoid.phase, "ended");
    assert.equal(opensVoid.promise, "A pot was not locked before the campaign opened, so it takes no pledges. Once it is closed, whatever the sponsor did lock goes back.");
    assert.equal(opensVoid.backers, "No backers yet");
    assert.equal(opensVoid.gap, "Never opened");
    assert.equal(due.gap, "Ended 760.00 USDC short of the target");
  });

  it("a settled campaign says where the money went, and claims payment only where a flag says so", function () {
    const funded = page(campaign({}, { outcome: Outcome.Funded, pledged: usd(2000), backers: 1 }), OPENS + 8n * 86_400n);
    assert.equal(funded.status, "Funded: owed to the recipient"); // recipientPaid is false here
    assert.doesNotMatch(funded.status, /paid/);
    assert.equal(funded.gap, "Target met");
    assert.equal(funded.percent, 100);
    assert.equal(funded.backers, "1 backer");
    assert.equal(funded.promise, "The target was met. 2,500.00 USDC goes to the recipient, the sponsor's 500.00 match included.");
    assert.equal(funded.settle, null);
    const paid = page(campaign({}, { outcome: Outcome.Funded, pledged: usd(2000), backers: 1, recipientPaid: true }), OPENS + 8n * 86_400n);
    assert.equal(paid.status, "Funded and paid to the recipient");
    assert.equal(paid.promise, "The target was met. 2,500.00 USDC went to the recipient, the sponsor's 500.00 match included.");
    assert.match(funded.clock, /^Deadline was \d{1,2} \w{3} \d{4}, \d\d:\d\d UTC$/);
    const missed = page(campaign({}, { outcome: Outcome.Missed, bonusPaid: usd(61.5) }), OPENS + 8n * 86_400n);
    assert.equal(missed.status, "Missed: pledges go back");
    assert.equal(missed.clock, funded.clock); // a settled campaign's clock line is its deadline, whatever the outcome
    assert.notEqual(missed.clock, missed.status);
    assert.equal(missed.gap, "Ended 760.00 USDC short of the target"); // never "to go" once it takes no pledges
    assert.equal(missed.promise, "The goal was missed. Every pledge goes back to its backer, and early backers share the bonus.");
    // Nobody is said to have been paid: no "paid back", "is paid" or "given back".
    for (const s of [missed.status, missed.promise, missed.clock]) assert.doesNotMatch(s, /paid back|is paid|given back/);
    const noBonus = page(campaign({ bonusPool: 0n }, { outcome: Outcome.Missed, bonusPaid: 0n }), OPENS + 8n * 86_400n);
    assert.equal(noBonus.promise, "The goal was missed. Every pledge goes back to its backer.");
    const dead = page(campaign({}, { outcome: Outcome.Void, backers: 0, pledged: 0n }), OPENS + 8n * 86_400n);
    assert.equal(dead.gap, "Never opened");
    assert.equal(dead.clock, "Void. No pledge was taken");
    assert.equal(dead.status, "Void");
    assert.equal(dead.promise, "A pot was not locked before the campaign opened, so no pledge was taken.");
  });

  it("a label is used only when it matches the chain, and a demo-desk campaign is named as one", function () {
    const labels = [{ id: 7n, sponsor: SPONSOR, recipient: RECIPIENT, title: "Send twelve of us to the regional.", by: "Westbrook Robotics Club", sponsorName: "Alumni fund", about: "", example: true }];
    assert.equal(campaignPage({ campaign: campaign(), labels, desk: null, now: OPENS, block: 1n }).name.title, "Send twelve of us to the regional.");
    assert.equal(campaignPage({ campaign: campaign({}, { sponsor: ME }), labels, desk: null, now: OPENS, block: 1n }).name.title, "Campaign 7");
    assert.equal(campaignPage({ campaign: campaign(), labels: [], desk: SPONSOR, now: OPENS, block: 1n }).name.title, "Ten-minute campaign 7");
    // A desk campaign is named by the time the contract holds it open: the short kind and the long one.
    const ten = campaignPage({ campaign: campaign({ earlyUntil: OPENS + 360n, closesAt: OPENS + 600n }), labels: [], desk: SPONSOR, now: OPENS, block: 1n }).name;
    assert.deepEqual([ten.title, ten.about], ["Ten-minute campaign 7", "A small campaign that takes pledges for at most ten minutes and settles within a minute after, so you can watch every step."]);
    const two = campaignPage({ campaign: campaign({ earlyUntil: OPENS + 72n, closesAt: OPENS + 120n }), labels: [], desk: SPONSOR, now: OPENS, block: 1n }).name;
    assert.deepEqual([two.title, two.about, two.example], ["Two-minute campaign 7", "A small campaign that takes pledges for at most two minutes and settles within a minute after, so you can watch every step.", true]);
  });

  it("view.lost: a number the contract does not have, and an address the app does not know, each get a plain page", function () {
    assert.deepEqual(noSuchCampaign(12n, 4n), { title: "There is no campaign 12", line: "This contract has campaigns 1 to 4.", homeHref: "#/" });
    assert.equal(noSuchCampaign(2n, 1n).line, "This contract has one campaign, number 1.");
    assert.equal(noSuchCampaign(1n, 0n).line, "This contract has no campaigns yet.");
    assert.deepEqual(lostPage("#/admin"), { title: "Nothing is at this address", line: "You asked for #/admin", homeHref: "#/" });
    assert.equal(lostPage(`#/${"x".repeat(500)}`).line.length, "You asked for ".length + 80);
    assert.equal(lostPage("#/a\u0000\nb").line, "You asked for #/ab");
    assert.equal(lostPage("").line, "");
  });
});

describe("the live feed", function () {
  const ledger = (feed: LedgerView["feed"]): LedgerView => ({ lastSeq: 9n, totalOwed: 0n, missing: null, campaigns: [], feed });
  const event = (seq: bigint, id: bigint, name: string, args: Record<string, unknown>, time: bigint | null = OPENS) => ({ name, seq, id, time, txHash: null, args });

  it("view.keeperDown: with no keeper the feed says so, and the Campaign page is the same page", function () {
    assert.deepEqual(feedView({ ledger: null }), { available: false, line: FEED_DOWN });
    // The Campaign page takes nothing from the keeper, so there is nothing for a missing or lying keeper to change.
    assert.equal(campaignPage.length, 1);
    assert.deepEqual(Object.keys({ campaign: 0, labels: 0, desk: 0, now: 0, block: 0 }).sort(), ["block", "campaign", "desk", "labels", "now"]);
  });

  it("newest first, one campaign at a time, with the time when the keeper had it", function () {
    const view = feedView({
      ledger: ledger([
        event(1n, 7n, "CampaignCreated", { sponsor: SPONSOR }),
        event(2n, 8n, "CampaignCreated", { sponsor: SPONSOR }),
        event(3n, 7n, "Pledged", { backer: ME, amount: "25000000", weight: "1000000" }, null),
        event(4n, 7n, "Finalized", { outcome: Outcome.Funded, bonusPaid: "0" }),
      ]),
      campaign: 7n,
      limit: 2,
    });
    assert.deepEqual(view, {
      available: true,
      lines: [
        { key: "4", campaign: 7n, text: "Funded", when: "6 Nov 2026, 21:20 UTC", txHash: null },
        { key: "3", campaign: 7n, text: "0x0000…00c3 pledged 25.00, early", when: null, txHash: null },
      ],
      empty: null,
    });
    assert.deepEqual(feedView({ ledger: ledger([]) }), { available: true, lines: [], empty: "Nothing has happened yet." });
  });
});

describe("the Pledge page", function () {
  const base = { campaign: campaign(), where: { boomerang: BOOMERANG, usdc: USDC }, now: OPENS + 3_600n, account: ME, balance: usd(1000), allowance: 0n, onRightChain: true } as const;
  // What the contract would answer for 25.00 here, by the kit's arithmetic (tested equal to the contract).
  const local = quotePledge(campaign().terms, campaign().state, usd(25), OPENS + 3_600n);
  assert.equal(local.kind, "counts");
  const answer = { wouldFund: false, counted: usd(25), bonus: local.kind === "counts" ? local.bonus : 0n };

  it("nothing typed, or something that is not an amount, cannot be sent and says why", function () {
    const empty = pledgeForm({ ...base, amountText: "  ", answer: null });
    assert.deepEqual([empty.amount, empty.line, empty.canSend, empty.calls.length, empty.button], [null, "Enter an amount.", false, 0, "Pledge"]);
    const junk = pledgeForm({ ...base, amountText: "twenty", answer: null });
    assert.equal(junk.line, "That is not an amount. Use digits, like 25 or 25.50.");
    assert.equal(junk.canSend, false);
  });

  it("view.pledge: with the contract's answer in hand, an account on Arc with enough USDC can send, and is asked only for what is needed", function () {
    const ready = pledgeForm({ ...base, amountText: "25", answer });
    assert.equal(ready.canSend, true);
    assert.deepEqual(ready.blocks, []);
    assert.equal(ready.source, "contract");
    assert.equal(ready.button, "Pledge 25.00 USDC");
    // With one signature the cheque's button is made from this one, so the two can never drift apart.
    assert.equal(signedButton(ready.button), "Sign and pledge 25.00 USDC");
    assert.equal(signedButton("Pledge"), "Sign and pledge");
    assert.equal(signedButton("Connect a wallet"), "Connect a wallet");
    assert.equal(ready.line, local.line);
    assert.match(ready.line, /^If this misses: you get back 25\.00 plus about \d+\.\d\d\.$/);
    assert.deepEqual(ready.calls.map((c) => [c.functionName, c.args]), [["approve", [BOOMERANG, usd(25)]], ["pledge", [7n, usd(25)]]]);
    const allowed = pledgeForm({ ...base, amountText: "25", allowance: usd(25), answer });
    assert.deepEqual(allowed.calls.map((c) => c.functionName), ["pledge"]);
  });

  it("the sentence is the contract's answer, not this page's arithmetic, when the two differ", function () {
    const other = pledgeForm({ ...base, amountText: "25", answer: { wouldFund: false, counted: usd(25), bonus: usd(2) } });
    assert.equal(other.line, "If this misses: you get back 25.00 plus about 2.00.");
    const finishing = pledgeForm({ ...base, amountText: "25", answer: { wouldFund: true, counted: usd(20), bonus: 0n } });
    assert.equal(finishing.line, "This pledge finishes the campaign. 20.00 is taken and 5.00 stays with you.");
    assert.equal(finishing.button, "Pledge 20.00 USDC");
  });

  it("until the contract has answered, the figure is marked an estimate and nothing can be sent", function () {
    const waiting = pledgeForm({ ...base, amountText: "25", answer: null });
    assert.equal(waiting.source, "estimate");
    assert.equal(waiting.line, local.line);
    assert.deepEqual(waiting.blocks, ["Checking the figure with the contract."]);
    assert.equal(waiting.canSend, false);
    assert.deepEqual(waiting.calls, []);
  });

  it("each thing in the way is named: no wallet, another network, a balance not read yet, too little USDC", function () {
    const noWallet = pledgeForm({ ...base, amountText: "25", account: null, balance: null, allowance: null, answer });
    assert.deepEqual([noWallet.blocks, noWallet.button, noWallet.canSend], [["Connect a wallet to pledge."], "Connect a wallet", false]);
    assert.deepEqual(pledgeForm({ ...base, amountText: "25", onRightChain: false, answer }).blocks, ["Your wallet is on another network. Switch it to Arc Testnet."]);
    assert.deepEqual(pledgeForm({ ...base, amountText: "25", balance: null, answer }).blocks, ["Reading your balance."]);
    assert.deepEqual(pledgeForm({ ...base, amountText: "25", balance: usd(24.99), answer }).blocks, ["This account holds 24.99 USDC, which is less than this pledge."]);
  });

  it("the pledge that finishes the campaign is held to the gap: the balance needed is the gap, not what was typed", function () {
    const gap = { wouldFund: true, counted: usd(760), bonus: 0n };
    const finishing = pledgeForm({ ...base, amountText: "1,000", balance: usd(800), answer: gap });
    assert.equal(finishing.line, "This pledge finishes the campaign. 760.00 is taken and 240.00 stays with you.");
    assert.equal(finishing.button, "Pledge 760.00 USDC");
    assert.equal(finishing.canSend, true);
    assert.deepEqual(pledgeForm({ ...base, amountText: "1,000", balance: usd(700), answer: gap }).blocks, ["This account holds 700.00 USDC, which is less than this pledge."]);
  });

  it("a refusal is the only thing said: below the smallest pledge, the sponsor's own account, a closed campaign", function () {
    const small = pledgeForm({ ...base, amountText: "1", answer: { wouldFund: false, counted: 0n, bonus: 0n } });
    assert.deepEqual([small.blocks, small.canSend, small.button, small.source], [["The smallest pledge is 5.00."], false, "Pledge", "none"]);
    assert.deepEqual(pledgeForm({ ...base, amountText: "25", account: SPONSOR, answer }).blocks, ["The sponsor's account cannot pledge to its own campaign."]);
    assert.deepEqual(pledgeForm({ ...base, amountText: "25", now: OPENS + 8n * 86_400n, answer: null }).blocks, ["This campaign is no longer taking pledges."]);
  });

  it("view.requote: asked again just before sending, a figure that moved is shown again instead of sent", function () {
    const t = campaign().terms;
    const s = campaign().state;
    const now = OPENS + 3_600n;
    const shown = quotePledge(t, s, usd(25), now, { answer: { wouldFund: false, counted: usd(25), bonus: usd(1.5) } });
    const fresh = (a: { wouldFund: boolean; counted: bigint; bonus: bigint }, at = now) => quotePledge(t, s, usd(25), at, { answer: a });
    assert.deepEqual(requote(shown, fresh({ wouldFund: false, counted: usd(25), bonus: usd(1.5) })), { same: true });
    // What counts is the figure as the page shows it, cut to the cent. Up within the same cent is the same figure.
    assert.deepEqual(requote(shown, fresh({ wouldFund: false, counted: usd(25), bonus: usd(1.5) + 9_999n })), { same: true });
    // Down by less than a cent, but across a cent's edge: the page would now read 1.49, so it is shown again.
    assert.deepEqual(requote(shown, fresh({ wouldFund: false, counted: usd(25), bonus: usd(1.5) - 1n })), {
      same: false,
      line: "This changed while you were reading. If this misses: you get back 25.00 plus about 1.49.",
    });
    const shown159 = fresh({ wouldFund: false, counted: usd(25), bonus: usd(1.59) + 5_000n });
    assert.deepEqual(requote(shown159, fresh({ wouldFund: false, counted: usd(25), bonus: usd(1.59) })), { same: true }); // still reads 1.59
    assert.equal(requote(shown159, fresh({ wouldFund: false, counted: usd(25), bonus: usd(1.58) + 9_999n })).same, false); // reads 1.58
    // A bonus under a cent that became nothing changes the sentence, so it is shown again.
    const tiny = fresh({ wouldFund: false, counted: usd(25), bonus: 5n });
    assert.equal(requote(tiny, fresh({ wouldFund: false, counted: usd(25), bonus: 1n })).same, true);
    assert.equal(requote(tiny, fresh({ wouldFund: false, counted: usd(25), bonus: 0n })).same, false);
    // The early window closed in between: the bonus is gone and the sentence says so.
    const late = requote(shown, fresh({ wouldFund: false, counted: usd(25), bonus: 0n }, OPENS + 4n * 86_400n));
    assert.equal(late.same, false);
    // Even with no bonus either way, losing the early window is a different sentence and is shown again.
    const earlyNoBonus = fresh({ wouldFund: false, counted: usd(25), bonus: 0n });
    assert.equal(requote(earlyNoBonus, fresh({ wouldFund: false, counted: usd(25), bonus: 0n }, OPENS + 4n * 86_400n)).same, false);
    assert.deepEqual(requote(shown, fresh({ wouldFund: false, counted: usd(25), bonus: usd(1.49) })), {
      same: false,
      line: "This changed while you were reading. If this misses: you get back 25.00 plus about 1.49.",
    });
    // A bonus that only rose is not a reason to stop the visitor.
    assert.deepEqual(requote(shown, fresh({ wouldFund: false, counted: usd(25), bonus: usd(1.51) })).same, true);
    // Someone else pledged first: this one would now finish the campaign and be trimmed.
    assert.deepEqual(requote(shown, fresh({ wouldFund: true, counted: usd(20), bonus: 0n })), {
      same: false,
      line: "This changed while you were reading. This pledge finishes the campaign. 20.00 is taken and 5.00 stays with you.",
    });
    // The campaign closed in between.
    assert.deepEqual(requote(shown, fresh({ wouldFund: false, counted: 0n, bonus: 0n }, OPENS + 8n * 86_400n)), {
      same: false,
      line: "This changed while you were reading. This campaign is no longer taking pledges.",
    });
    // A finishing pledge whose trimmed amount moved.
    const finishing = fresh({ wouldFund: true, counted: usd(20), bonus: 0n });
    assert.deepEqual(requote(finishing, fresh({ wouldFund: true, counted: usd(20), bonus: 0n })), { same: true });
    assert.equal(requote(finishing, fresh({ wouldFund: true, counted: usd(10), bonus: 0n })).same, false);
  });
});

// The Home and My money pages, appended to the same invented campaign.
import { minePage } from "../src/views/mine.ts";
import { homePage } from "../src/views/home.ts";
import { WORDS } from "../src/views/shell.ts";
import type { MyPledge } from "../src/data/load.ts";

describe("the Home page", function () {
  const later = OPENS + 8n * 86_400n;
  const all: CampaignView[] = [
    { ...campaign(), id: 4n }, // open, in its early window at OPENS + 1h
    { ...campaign({}, { outcome: Outcome.Missed, bonusPaid: usd(61.5) }), id: 3n },
    { ...campaign({}, { outcome: Outcome.Funded, pledged: usd(2000), backers: 40 }), id: 2n },
    { ...campaign({}, { outcome: Outcome.Void, backers: 0, pledged: 0n, pledgedEarly: 0n, weighted: 0n, matchIn: false }), id: 1n },
  ];

  it("view.home: totals add up from the contract's figures, and running campaigns come before settled ones", function () {
    const home = homePage({ campaigns: all, labels: [], desk: null, now: OPENS + 3_600n, block: 5n });
    assert.deepEqual(home.totals, [
      { label: "Campaigns", value: "4" },
      { label: "Backers, campaign by campaign", value: "102" },
      { label: "Pledged", value: "4,480.00 USDC" },
      { label: "Raised for recipients", value: "2,500.00 USDC" },
      { label: "Refunds and bonus for backers of missed campaigns", value: "1,301.50 USDC" },
    ]);
    assert.deepEqual(home.running, [
      { href: "#/campaign/4", title: "Campaign 4", by: "Paid to 0x0000…00aa", example: false, status: "Early bonus open", raised: "1,240.00 of 2,000.00 USDC", percent: 62, clock: "Early bonus window closes in 23 hours" },
    ]);
    assert.deepEqual(home.settled.map((c) => [c.href, c.status]), [["#/campaign/3", "Missed: pledges go back"], ["#/campaign/2", "Funded: owed to the recipient"], ["#/campaign/1", "Void"]]);
    assert.equal(home.empty, null);
    assert.equal(home.demo, null);
    assert.equal(home.asOf, "As of block 5");
    // Past its deadline but not settled, a campaign is still on the running list, marked as waiting.
    const due = homePage({ campaigns: [all[0]], labels: [], desk: null, now: later, block: 6n });
    assert.deepEqual(due.running.map((c) => c.status), ["Waiting to be settled"]);
  });

  it("with no campaigns it says so, and offers the desk's campaigns only where a desk exists: the two-minute one first, the ten-minute one beside it", function () {
    const none = homePage({ campaigns: [], labels: [], desk: SPONSOR, now: OPENS, block: 1n });
    assert.equal(none.empty, "No campaign has been created yet.");
    assert.deepEqual(none.demo, { button: "Start a two-minute campaign", other: "Or start a ten-minute one" });
    assert.equal(none.closing, "Start a two-minute campaign and watch the whole thing play out: pledge, deadline, and the money back.");
    const bare = homePage({ campaigns: [], labels: [], desk: null, now: OPENS, block: 1n });
    assert.equal(bare.demo, null);
    assert.equal(bare.closing, "See how the campaigns here played out: pledge, deadline, and the money back.");
    assert.deepEqual([WORDS.cheque.start, WORDS.cheque.startTen], ["Start a two-minute campaign", "Or start a ten-minute one"]);
    assert.equal(WORDS.cheque.deskNote, "Start a two-minute campaign and pledge to it: watch the deadline pass and the money come back.");
    assert.deepEqual(none.totals.map((t) => t.value), ["0", "0", "0.00 USDC", "0.00 USDC", "0.00 USDC"]);
  });
});

describe("My money", function () {
  const ZERO = "0x0000000000000000000000000000000000000000" as const;
  const mine = (c: CampaignView, principal: bigint, over: Partial<MyPledge["backer"]> = {}): MyPledge => ({
    campaign: c,
    backer: { principal, weighted: principal * 1_000_000n, payTo: ZERO, paid: false, ...over },
    owed: { principal: 0n, bonus: 0n },
    ifMissed: { principal: 0n, bonus: 0n },
  });
  const open = { ...campaign(), id: 4n };
  const missed = { ...campaign({}, { outcome: Outcome.Missed, bonusPaid: usd(62) }), id: 3n };
  const funded = { ...campaign({}, { outcome: Outcome.Funded, pledged: usd(2000) }), id: 2n };

  it("view.mine: with no wallet it asks for one; with one and no pledge it says so", function () {
    assert.deepEqual(minePage({ account: null, mine: [], labels: [], desk: null, block: 9n }), {
      account: null, rows: [], empty: "Connect a wallet to see your pledges.", totals: [], asOf: "As of block 9",
      subject: { tag: null, address: null, note: null }, figures: [], connectNote: null,
    });
    const none = minePage({ account: ME, mine: [], labels: [], desk: null, block: 9n });
    assert.equal(none.account, "0x0000…00c3");
    assert.equal(none.empty, "This account has not pledged to any campaign here.");
  });

  it("view.mineFromContract: each pledge says where it stands from the contract's own figures, no keeper input, and only an unpaid refund offers to be sent", function () {
    const page = minePage({
      account: ME,
      mine: [mine(open, usd(25)), mine(missed, usd(124)), mine(missed, usd(124), { paid: true }), mine(funded, usd(40))],
      labels: [],
      desk: null,
      block: 9n,
    });
    assert.deepEqual(page.rows.map((r) => r.kind), ["counted", "owed", "returned", "given"]);
    assert.deepEqual(page.rows.map((r) => r.href), ["#/campaign/4", "#/campaign/3", "#/campaign/3", "#/campaign/2"]);
    assert.match(page.rows[0].line, /^25\.00 is counted\. If the campaign misses as it stands, it comes back with about \d+\.\d\d\.$/);
    // 124 of 1,240 weighted: a tenth of the 62.00 bonus paid.
    assert.equal(page.rows[1].line, "124.00 plus 6.20 bonus is yours. Anyone can send it; you can too.");
    assert.deepEqual(page.rows[1].send, { button: "Send my refund", note: "Anyone can send this, and it can only pay the backer's own refund address. The keeper usually does it within seconds.", campaign: 3n });
    assert.equal(page.rows[2].line, "124.00 came back, plus 6.20 bonus.");
    assert.equal(page.rows[3].line, "40.00 went to the campaign. It was funded.");
    assert.deepEqual(page.rows.map((r) => r.send === null), [true, false, true, true]);
    assert.deepEqual(page.totals, [
      { label: "In campaigns not yet settled", value: "25.00 USDC" },
      { label: "Owed to you now", value: "130.20 USDC" },
      { label: "Came back to you", value: "130.20 USDC" },
      { label: "Went to funded campaigns", value: "40.00 USDC" },
    ]);
  });

  it("a refund pointed at another address is said to go there, owed or paid, and is kept in its own total", function () {
    const elsewhere = minePage({ account: ME, mine: [mine(missed, usd(124), { payTo: RECIPIENT }), mine(missed, usd(124), { payTo: ME })], labels: [], desk: null, block: 9n });
    assert.deepEqual(elsewhere.rows.map((r) => r.refundTo), ["A refund would go to 0x0000…00aa, as this account asked.", null]);
    assert.equal(elsewhere.rows[0].line, "130.20 is owed and will go to 0x0000…00aa, the address you chose.");
    assert.equal(elsewhere.rows[1].line, "124.00 plus 6.20 bonus is yours. Anyone can send it; you can too.");
    // A refund already paid to a chosen address: it reads as paid there and sits in its own total, not "Came back to you".
    const paid = minePage({ account: ME, mine: [mine(missed, usd(124), { payTo: RECIPIENT, paid: true })], labels: [], desk: null, block: 9n });
    assert.equal(paid.rows[0].line, "130.20 was paid to 0x0000…00aa, the address you chose.");
    assert.deepEqual(paid.totals, [
      { label: "In campaigns not yet settled", value: "0.00 USDC" },
      { label: "Owed to you now", value: "0.00 USDC" },
      { label: "Came back to you", value: "0.00 USDC" },
      { label: "Went to funded campaigns", value: "0.00 USDC" },
      { label: "Paid to addresses you chose", value: "130.20 USDC" },
    ]);
  });
});

// The Proof page and the keeper's health, with the same invented campaign.
import { readHealth } from "../src/data/health.ts";
import { LIMITS, proofPage } from "../src/views/proof.ts";
import type { BackerCheck } from "../src/app/world.ts";
import type { Custody } from "../src/data/load.ts";
import type { LedgerBackerView, LedgerCampaignView } from "../src/data/keeper.ts";

describe("the keeper's health", function () {
  const wire = {
    lastSeq: "12", missing: null, pending: 0, repeats: 3, lastBlock: 400, lastTime: "1794000000", lastDeliveryAt: 1_794_000_005_000, lastBeatBlock: 300,
    kvError: null, deliveries: 9, sent: 4, failedSends: 1, rejected: 0, gaveUp: [], lastErrors: ["forced\u0000 hiccup"], settled: true, desk: null,
  };

  it("reads back with whole numbers as numbers, and the keeper's own words as plain text", function () {
    const h = readHealth(wire);
    assert.equal(h.lastSeq, 12n);
    assert.equal(h.lastTime, 1_794_000_000n);
    assert.deepEqual(h.lastErrors, ["forced  hiccup"]);
    assert.equal(readHealth({ ...wire, missing: { from: "4", to: "6" } }).missing?.to, 6n);
    assert.equal(readHealth({ ...wire, lastErrors: ["x".repeat(900)] }).lastErrors[0].length, 200);
    assert.equal(readHealth({ ...wire, desk: "0x00000000000000000000000000000000000000d5" }).desk, "0x00000000000000000000000000000000000000d5");
    // Bidi controls and zero-width characters are stripped; C0/C1 control characters and DEL become a space.
    assert.equal(readHealth({ ...wire, lastErrors: ["a‮b⁦c​d﻿e"] }).lastErrors[0], "abcde");
    assert.equal(readHealth({ ...wire, lastErrors: ["a\u0085b\u007fc"] }).lastErrors[0], "a b c");
  });

  it("health.old: a keeper that sends no node reads it as null, the rest as before", function () {
    const h = readHealth(wire);
    assert.equal(h.node, null);
    assert.equal(h.lastBlock, 400);
  });

  it("health.noFeed: the page keeps nothing about a pushed feed, whether the keeper still sends those fields, sends them oddly, or has dropped them", function () {
    const gone = ["lastDeliveryAt", "lastBeatBlock", "kvError", "deliveries", "streamBlock"];
    const without = Object.fromEntries(Object.entries(wire).filter(([k]) => !gone.includes(k)));
    for (const sent of [wire, without, { ...wire, kvError: 5, lastBeatBlock: "300", deliveries: -1, streamBlock: "x", lastDeliveryAt: "then" }]) {
      const h = readHealth(sent) as Record<string, unknown>;
      for (const k of gone) assert.equal(k in h, false, k);
      assert.equal(h.lastBlock, 400);
    }
  });

  it("health.node: the node's reading is read when the keeper sends it", function () {
    const h = readHealth({ ...wire, node: { reads: 12, lastReadAt: 1_794_000_006_000, readTo: 405, faults: 1 } });
    assert.deepEqual(h.node, { reads: 12, lastReadAt: 1_794_000_006_000, readTo: 405, faults: 1 });
    // null reads of its nullable fields are kept.
    assert.deepEqual(readHealth({ ...wire, node: { reads: 0, lastReadAt: null, readTo: null, faults: 0 } }).node, {
      reads: 0, lastReadAt: null, readTo: null, faults: 0,
    });
  });

  it("health.node.odd: a node with a non-number count throws, naming the field", function () {
    assert.throws(() => readHealth({ ...wire, node: { reads: "3", lastReadAt: null, readTo: null, faults: 0 } }), /at node\.reads/);
  });

  it("health.absent: campaign numbers the contract says it does not have, none when the keeper sends no list", function () {
    assert.deepEqual(readHealth(wire).absent, []);
    assert.deepEqual(readHealth({ ...wire, absent: ["7", "9"] }).absent, [7n, 9n]);
    assert.equal(readHealth({ ...wire, absent: Array.from({ length: 30 }, (_, i) => String(i)) }).absent.length, 20);
    assert.throws(() => readHealth({ ...wire, absent: "7" }), /at absent/);
    assert.throws(() => readHealth({ ...wire, absent: ["seven"] }), /at absent/);
  });

  it("refuses a field that is missing or of the wrong kind, and says which", function () {
    for (const [field, bad] of [["lastSeq", 12], ["pending", -1], ["missing", "none"], ["gaveUp", "x"], ["settled", "yes"], ["desk", "0x12"]] as const) {
      assert.throws(() => readHealth({ ...wire, [field]: bad }), new RegExp(`at ${field}`), field);
    }
    assert.throws(() => readHealth(null), /health/);
    assert.throws(() => readHealth([]), /health/);
  });
});

describe("the Proof page", function () {
  const where = { boomerang: BOOMERANG, usdc: USDC, router: "0x00000000000000000000000000000000000000c0" as const };
  const chain = campaign();
  const custody: Custody = { block: 400n, time: OPENS, held: usd(1740), owed: usd(1740), events: 12n, ok: true };
  const inLedger: LedgerCampaignView = {
    id: 7n, sponsor: SPONSOR, terms: chain.terms, matchIn: true, bonusIn: true, outcome: Outcome.Open, pledged: usd(1240), pledgedEarly: usd(1240), earlyUnknown: 0n,
    weighted: usd(1240) * 1_000_000n, bonusPaid: 0n, expectedBonusPaid: null, recipientPaid: false, matchReturned: false, bonusReturned: false, payFailures: 0,
    backers: Array.from({ length: 31 }, (_, i) => ({ address: `0x${(i + 1).toString(16).padStart(40, "0")}` as typeof ME, principal: usd(40), weighted: usd(40) * 1_000_000n, payTo: null, paid: false, paidPrincipal: 0n, paidBonus: 0n })),
  };
  const ledger = (over: Partial<LedgerView> = {}): LedgerView => ({ lastSeq: 12n, totalOwed: usd(1740), missing: null, campaigns: [inLedger], feed: [], ...over });
  const healthWire = {
    lastSeq: "12", missing: null, pending: 0, repeats: 3, lastBlock: 400, lastTime: "1794000000",
    sent: 4, failedSends: 1, rejected: 0, gaveUp: [], lastErrors: [], settled: true, desk: null,
  };
  const health = readHealth(healthWire);
  const ZERO = "0x0000000000000000000000000000000000000000" as const;
  // The contract's own backer records at the block, matching the ledger's records unless a test changes one.
  const checksFor = (lc: LedgerCampaignView, over: (b: LedgerBackerView) => Partial<Backer> = () => ({})): BackerCheck[] =>
    lc.backers.map((b) => ({ id: lc.id, address: b.address, chain: { principal: b.principal, weighted: b.weighted, payTo: b.payTo ?? ZERO, paid: b.paid, ...over(b) } }));
  const page = (over: Partial<Parameters<typeof proofPage>[0]> = {}) =>
    proofPage({ custody, campaigns: [chain], count: 1n, ledger: ledger(), health, backerChecks: checksFor(inLedger), backerTotal: inLedger.backers.length, where, pace: { state: "prompt" }, ...over });

  it("view.proof: holds against owes at one block, the second ledger in agreement, and the keeper's pulse", function () {
    const p = page();
    assert.deepEqual(p.custody, {
      state: "ok",
      line: "The contract holds 1,740.00 USDC and owes 1,740.00 USDC.",
      detail: "Both figures were read at block 400 (6 Nov 2026, 21:20 UTC). It can pay everyone it owes.",
    });
    assert.deepEqual(p.second, {
      state: "agrees",
      line: "A second ledger, rebuilt only from the contract's 12 events as the keeper received them, agrees with the contract at block 400 on every figure of its one campaign and on 31 backer records.",
      differences: [],
    });
    assert.deepEqual(p.keeper, [
      { label: "Fed by", value: "Arc's node, read by the keeper itself." },
      { label: "Newest block heard", value: "400" },
      { label: "Events missing", value: "None" },
      { label: "Events set aside as not fitting", value: "0" },
      { label: "Campaigns in the events that the contract does not have (or not yet)", value: "None" },
      { label: "Calls sent", value: "4 went through, 1 did not" },
      { label: "Calls given up on", value: "None" },
      { label: "Every settled campaign fully paid, by the keeper's ledger", value: "Yes" },
    ]);
    assert.deepEqual(p.facts.map((f) => [f.label, f.address]), [["Contract", BOOMERANG], ["Token (USDC)", USDC], ["Router for pledges from other chains", where.router], ["Owner", undefined]]);
    // Runnable by someone who has only this page: fetch the code, install, then the one script that builds and checks.
    assert.deepEqual(p.yourself.commands, ["git clone https://github.com/omexe/boomerang-ubc", "cd boomerang-ubc", "npm ci", "npm run verify"]);
    assert.deepEqual(p.limits, [...LIMITS]);
    assert.equal(
      LIMITS[2],
      "The keeper makes payouts prompt; it is not needed for them. When it is off or behind the chain nothing is lost, only later: from this site anyone can settle a campaign, pay its recipient and return the pots that were not paid out, and a backer can send their own refund from the campaign's page or from My money. Anyone can send someone else's refund as well: look the backer's address up under My money.",
    );
    assert.ok(LIMITS.length >= 5);
  });

  it("proof.fedBy: how the keeper is fed, with no row or word about any other feed, and the node-reads row", function () {
    const node = { reads: 12, lastReadAt: 1_794_000_006_000, readTo: 405, faults: 0 };
    const nodeHealth = readHealth({ ...healthWire, node });
    const v = (p: ReturnType<typeof page>, label: string) => p.keeper!.find((r) => r.label === label)!.value;

    // The three "Fed by" values.
    assert.equal(v(page(), "Fed by"), "Arc's node, read by the keeper itself.");
    assert.equal(v(page({ health: nodeHealth }), "Fed by"), "Arc's node, read by the keeper itself.");
    assert.equal(v(page({ pace: { state: "behind", heard: 0, blocks: 901 } }), "Fed by"), "Nothing yet. The keeper has heard no block since it started.");
    assert.equal(v(page({ pace: { state: "behind", heard: 400, blocks: 950 } }), "Fed by"), "Nothing right now. The keeper last heard block 400, 950 blocks behind the chain.");

    // Nothing on the page names any other feed, whatever an old keeper still sends.
    const p = page();
    for (const q of [p, page({ health: nodeHealth }), page({ pace: { state: "behind", heard: 0, blocks: 901 } })]) {
      assert.equal(q.keeper!.some((r) => /stream/i.test(r.label) || /stream/i.test(r.value)), false);
    }
    assert.equal(v(p, "Newest block heard"), "400");

    // The node-reads row shows only when the keeper reads the node, in both of its forms.
    assert.equal(p.keeper!.some((r) => r.label === "Node reads since the keeper started"), false);
    assert.equal(v(page({ health: nodeHealth }), "Node reads since the keeper started"), "12");
    assert.equal(
      v(page({ health: readHealth({ ...healthWire, node: { ...node, faults: 2 } }) }), "Node reads since the keeper started"),
      "12, and 2 that failed",
    );

    // Row order, with the node present.
    assert.deepEqual(page({ health: nodeHealth }).keeper!.map((r) => r.label), [
      "Fed by",
      "Newest block heard",
      "Node reads since the keeper started",
      "Events missing",
      "Events set aside as not fitting",
      "Campaigns in the events that the contract does not have (or not yet)",
      "Calls sent",
      "Calls given up on",
      "Every settled campaign fully paid, by the keeper's ledger",
    ]);
  });

  it("a contract short of what it owes is said in so many words", function () {
    const p = page({ custody: { ...custody, held: usd(1700), ok: false } });
    assert.equal(p.custody.state, "short");
    assert.equal(p.custody.line, "The contract holds 1,700.00 USDC and owes 1,740.00 USDC: it is 40.00 short.");
    assert.match(p.custody.detail, /do not pledge/);
    assert.equal(page({ custody: null }).custody.state, "unread");
  });

  it("view.keeperDown: no keeper, a late one and a foreign one are each named, and none is compared", function () {
    const down = page({ ledger: null, health: null });
    assert.equal(down.second.state, "down");
    assert.equal(down.keeper, null);
    assert.equal(down.custody.state, "ok"); // the contract's own line does not depend on the keeper
    const late = page({ ledger: ledger({ lastSeq: 9n, totalOwed: 1n }) });
    assert.deepEqual([late.second.state, late.second.differences], ["behind", []]);
    assert.equal(late.second.line, "The keeper's ledger is 3 events behind the contract. It is late, not wrong; the figures are compared once it catches up.");
    assert.match(page({ ledger: ledger({ lastSeq: 11n }) }).second.line, /is 1 event behind/);
    // Late for good: a hole in the events means waiting will not help, and the page says so.
    const holed = page({ ledger: ledger({ lastSeq: 9n, missing: { from: 10n, to: 11n } }) });
    assert.equal(holed.second.state, "behind");
    assert.equal(holed.second.line, "The keeper's ledger is 3 events behind the contract, and events 10 to 11 never reached it. It is not compared until the missing events reach it.");
    assert.match(page({ ledger: ledger({ lastSeq: 9n, missing: { from: 10n, to: 10n } }) }).second.line, /and event 10 never reached it/);
    // Behind because events were refused, not because they are late: the page does not call that "late, not wrong".
    const refused = page({ ledger: ledger({ lastSeq: 9n }), health: { ...health, rejected: 2 } });
    assert.equal(refused.second.line, "The keeper's ledger is 3 events behind the contract, and the keeper has set 2 events aside as not fitting. It is not compared until it has caught up.");
    const foreign = page({ ledger: ledger({ lastSeq: 14n }) });
    assert.equal(foreign.second.state, "ahead");
    assert.match(foreign.second.line, /holds 2 more events than the contract had emitted at block 400, so it is not compared at this read/);
  });

  it("a level ledger that disagrees is listed difference by difference, and the page says which side is right", function () {
    const wrong = page({
      ledger: ledger({
        totalOwed: usd(1700),
        campaigns: [{ ...inLedger, pledged: usd(1200) }, { ...inLedger, id: 8n }],
      }),
      campaigns: [chain, { ...chain, id: 9n }],
    });
    assert.equal(wrong.second.state, "differs");
    assert.match(wrong.second.line, /The contract is right/);
    assert.deepEqual(wrong.second.differences, [
      "owed in total: ledger 1,700.00, contract 1,740.00",
      "campaign 7: pledged: ledger 1200000000, contract 1240000000",
      "campaign 9 is not in the ledger",
      "campaign 8 is in the ledger but not in the contract",
    ]);
  });

  it("the agreement names how many backer records were checked, and one wrong record reads differs", function () {
    // The contract's record for the first backer says paid; the ledger's says not.
    const first = inLedger.backers[0].address;
    const wrong = page({ backerChecks: checksFor(inLedger, (b) => (b.address === first ? { paid: true } : {})) });
    assert.equal(wrong.second.state, "differs");
    assert.ok(wrong.second.differences.includes("campaign 7, backer 0x0000…0001: paid: ledger no, contract yes"));
    // When all match, the count is stated, capped as "K of M" when fewer than all were read.
    const some = page({ backerChecks: checksFor(inLedger).slice(0, 10), backerTotal: 31 });
    assert.match(some.second.line, /on 10 of 31 backer records\.$/);
  });

  it("view.proofNewest50: with more campaigns than were read, only those read are compared, and the page says so", function () {
    const older: LedgerCampaignView = { ...inLedger, id: 2n };
    const capped = page({ campaigns: [chain], count: 5n, ledger: ledger({ campaigns: [inLedger, older] }), backerChecks: [], backerTotal: 0 });
    assert.equal(capped.second.state, "agrees");
    assert.equal(
      capped.second.line,
      "A second ledger, rebuilt only from the contract's 12 events as the keeper received them, agrees with the contract at block 400 on every figure of the newest 1 of 5 campaigns and on 0 backer records.",
    );
    // Campaign 2 is older than the window the page read, so it is never called "in the ledger but not in the contract".
    assert.ok(!capped.second.differences.some((d) => /campaign 2/.test(d)));
  });

  it("the keeper's own troubles are shown: a hole in the events, calls given up on, its error lines", function () {
    const troubled = readHealth({
      lastSeq: "12", missing: { from: "4", to: "6" }, pending: 2, repeats: 0, lastBlock: 400, lastTime: "1794000000",
      sent: 0, failedSends: 0, rejected: 2, gaveUp: ["finalize:7"], lastErrors: ["gave up on finalize:7"], settled: false, desk: null,
      absent: ["9", "11"],
    });
    const p = page({ health: troubled });
    const value = (label: string) => p.keeper!.find((r) => r.label === label)!.value;
    assert.equal(value("Events missing"), "Numbers 4 to 6");
    assert.equal(value("Events set aside as not fitting"), "2");
    assert.equal(value("Campaigns in the events that the contract does not have (or not yet)"), "Numbers 9 and 11");
    assert.equal(page({ health: { ...troubled, absent: [9n] } }).keeper!.find((r) => r.label === "Campaigns in the events that the contract does not have (or not yet)")!.value, "Number 9");
    assert.equal(value("Calls given up on"), "1");
    assert.equal(value("Every settled campaign fully paid, by the keeper's ledger"), "Not yet");
    assert.deepEqual(p.keeperErrors, ["gave up on finalize:7"]);
  });
});

// The frame around every page.
import { deskAnswerFor, deskOffer, shell, signedButton, stepLine } from "../src/views/shell.ts";

describe("the frame around every page", function () {
  const arc = { id: 5042002, name: "Arc Testnet", local: false };
  const base = { route: { page: "home" } as const, chain: arc, wallets: 1, account: null, walletChainId: null, block: 400n, readFailed: false };

  it("view.shell: the name, the network, the links with the current one marked, and the block", function () {
    const s = shell(base);
    assert.equal(s.brand, "Boomerang");
    assert.equal(s.disclaimer, "Boomerang runs on Arc Testnet with test USDC. No real money is involved, nothing here is an offer or financial advice, and the contract has not been audited.");
    // The first two links go to parts of the landing page; on that page itself neither is marked.
    assert.deepEqual(s.nav, [
      { href: "#/", label: "How it works", current: false, section: "how" },
      { href: "#/", label: "Campaigns", current: false, section: "ledger" },
      { href: "#/mine", label: "My money", current: false, section: null },
      { href: "#/proof", label: "Proof", current: false, section: null },
    ]);
    // The foot links to the code and to Proof, and to the contract on the explorer when the chain has one.
    assert.deepEqual(s.foot.map((f) => f.label), ["GitHub", "Proof"]);
    assert.deepEqual(
      shell({ ...base, contractLink: "https://explorer.example/address/0x1" }).foot.map((f) => [f.label, f.external]),
      [["GitHub", true], ["Explorer", true], ["Proof", false]],
    );
    assert.equal(s.asOf, "As of block 400");
    assert.equal(s.banner, null);
    // A campaign and its pledge form sit under Campaigns; a lost address is under nothing.
    assert.deepEqual(shell({ ...base, route: { page: "pledge", id: 7n } }).nav.map((n) => n.current), [false, true, false, false]);
    assert.deepEqual(shell({ ...base, route: { page: "proof" } }).nav.map((n) => n.current), [false, false, false, true]);
    assert.deepEqual(shell({ ...base, route: { page: "lost", hash: "#/x" } }).nav.map((n) => n.current), [false, false, false, false]);
    assert.equal(shell({ ...base, chain: { id: 31337, name: "Local chain 31337", local: true } }).disclaimer, "Local chain 31337, a test chain on this machine.");
  });

  it("view.wallet: no wallet, one to connect, one on the wrong network, one ready", function () {
    const none = shell({ ...base, wallets: 0 }).wallet;
    assert.deepEqual([none.state, none.button, none.account], ["none", null, null]);
    assert.match(none.note!, /You can read everything here without one/);
    assert.deepEqual(shell(base).wallet, { state: "connect", account: null, button: "Connect a wallet", note: null });
    const wrong = shell({ ...base, account: ME, walletChainId: 1 }).wallet;
    assert.deepEqual([wrong.state, wrong.button, wrong.account], ["wrong-network", "Switch to Arc Testnet", "0x0000…00c3"]);
    assert.match(wrong.note!, /Nothing is sent until it is on Arc Testnet/);
    assert.deepEqual(shell({ ...base, account: ME, walletChainId: 5042002 }).wallet, { state: "ready", account: "0x0000…00c3", button: null, note: null });
    // A wallet that has not said which network it is on is not called wrong; the send itself checks.
    assert.equal(shell({ ...base, account: ME, walletChainId: null }).wallet.state, "ready");
  });

  it("view.stale: when the chain cannot be read the page says so, and says how old what it shows is", function () {
    assert.equal(
      shell({ ...base, readFailed: true }).banner,
      "The chain could not be read just now. What you see is from block 400 and may be out of date; nothing can be sent until it reads again.",
    );
    const never = shell({ ...base, readFailed: true, block: null });
    assert.equal(never.banner, "The chain cannot be read right now, so there is nothing to show yet. This page keeps trying.");
    assert.equal(never.asOf, null);
    assert.equal(shell({ ...base, block: null }).banner, null);
  });

  it("the desk's offer and the steps of a send", function () {
    assert.equal(deskOffer({ desk: null, account: ME, had: false }), null);
    assert.equal(deskOffer({ desk: SPONSOR, account: null, had: false }), null);
    assert.equal(deskOffer({ desk: SPONSOR, account: ME, had: true }), null, "an address the desk will not send to again is not offered it");
    // The desk's answer is about the address that asked: after a change of wallet it is not shown.
    const sent = "The desk sent 2.00 USDC to your address.";
    assert.equal(deskAnswerFor({ line: sent, askedBy: ME, account: ME.toUpperCase().replace("0X", "0x") as `0x${string}` }), sent);
    assert.equal(deskAnswerFor({ line: sent, askedBy: ME, account: SPONSOR }), null);
    assert.equal(deskAnswerFor({ line: sent, askedBy: ME, account: null }), null);
    assert.equal(deskAnswerFor({ line: null, askedBy: ME, account: ME }), null);
    assert.equal(deskAnswerFor({ line: sent, askedBy: null, account: ME }), null);
    assert.deepEqual(deskOffer({ desk: SPONSOR, account: ME, had: false }), { button: "Get 2.00 USDC", note: "From this site's desk, once per address. Circle's faucet for Arc Testnet gives more." });
    assert.equal(stepLine({ index: 0, label: "Allow the contract to take 25.00 USDC", state: "asking" }, 2), "Step 1 of 2: Allow the contract to take 25.00 USDC. Confirm it in your wallet.");
    assert.equal(stepLine({ index: 1, label: "Pledge 25.00 USDC", state: "sent" }, 2), "Step 2 of 2: Pledge 25.00 USDC. Sent; waiting for the chain.");
    assert.equal(stepLine({ index: 0, label: "Settle campaign 7", state: "done" }, 1), "Settle campaign 7. Done.");
  });
});

import { explorerLink } from "../src/views/links.ts";

describe("links to the explorer", function () {
  const EX = "https://explorer.testnet.arc.io";
  it("view.links: only a well-formed address or hash is ever appended, and only to an https explorer", function () {
    assert.equal(explorerLink(EX, "address", ME), `${EX}/address/${ME}`);
    assert.equal(explorerLink(`${EX}/`, "tx", `0x${"ab".repeat(32)}`), `${EX}/tx/0x${"ab".repeat(32)}`);
    for (const bad of [null, undefined, "", "0x12", `${ME}/../../x`, `${ME}?x=1`, "javascript:alert(1)", ` ${ME}`, `0x${"zz".repeat(20)}`]) {
      assert.equal(explorerLink(EX, "address", bad), null, String(bad));
    }
    assert.equal(explorerLink(EX, "tx", ME), null); // an address is not a transaction
    assert.equal(explorerLink(EX, "address", `0x${"ab".repeat(32)}`), null);
    assert.equal(explorerLink(null, "address", ME), null);
    assert.equal(explorerLink("javascript:alert(1)", "address", ME), null);
    assert.equal(explorerLink("http://explorer.example", "address", ME), null);
    assert.equal(explorerLink("not a url", "address", ME), null);
  });
});
