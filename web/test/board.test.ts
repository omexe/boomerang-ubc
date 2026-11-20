// The scoreboard's views: the plates, the chart's climb, the two-part receipt and which digits
// flip. Every amount, address and name in these tests is invented.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { State, Terms } from "../../packages/kit/src/index.ts";
import { Outcome } from "../../packages/kit/src/index.ts";
import type { FeedItem, LedgerView } from "../src/data/keeper.ts";
import type { CampaignView } from "../src/data/load.ts";
import { utcStamp } from "../src/data/time.ts";
import { agoLine, agoOf, boardTime, boardView, settledLine } from "../src/views/board.ts";
import { axisEnds, chartPaths, chartView, climbOf, valueLabelY } from "../src/views/chart.ts";
import { changedPositions } from "../src/views/flip.ts";
import { pledgeForm } from "../src/views/pledge.ts";
import { receiptView, shownWhileSending } from "../src/views/receipt.ts";

const RECIPIENT = "0x00000000000000000000000000000000000000aa" as const;
const SPONSOR = "0x00000000000000000000000000000000000000b1" as const;
const BACKER = "0x00000000000000000000000000000000000000c1" as const;
const BOOMERANG = "0x00000000000000000000000000000000000000b0" as const;
const USDC = "0x3600000000000000000000000000000000000000" as const;
const usd = (n: number) => BigInt(Math.round(n * 1_000_000));
const OPENS = 1_794_000_000n;
const HOUR = 3_600n;
const DAY = 86_400n;

const terms = (over: Partial<Terms> = {}): Terms => ({
  recipient: RECIPIENT,
  opensAt: OPENS,
  earlyUntil: OPENS + DAY,
  closesAt: OPENS + 7n * DAY,
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

const event = (name: string, seq: bigint, amount: number, time: bigint | null, id = 7n): FeedItem => ({ name, seq, id, time, txHash: null, args: { amount: usd(amount).toString() } });
const ledger = (feed: FeedItem[]): LedgerView => ({ lastSeq: 9n, totalOwed: 0n, missing: null, campaigns: [], feed });

const form = (c: CampaignView, amountText: string, now: bigint, answer: { wouldFund: boolean; counted: bigint; bonus: bigint } | null) =>
  pledgeForm({ campaign: c, where: { boomerang: BOOMERANG, usdc: USDC }, amountText, now, account: BACKER, balance: usd(5000), allowance: 0n, onRightChain: true, answer });

describe("board.time", () => {
  it("raises its precision as time runs out", () => {
    assert.deepEqual(boardTime(0n), { figure: "0:00", unit: "min" });
    assert.deepEqual(boardTime(-5n), { figure: "0:00", unit: "min" });
    assert.deepEqual(boardTime(59n), { figure: "0:59", unit: "min" });
    assert.deepEqual(boardTime(3_599n), { figure: "59:59", unit: "min" });
    assert.deepEqual(boardTime(HOUR), { figure: "1", unit: "hr" });
    assert.deepEqual(boardTime(2n * HOUR + 59n * 60n), { figure: "2", unit: "hrs" });
    assert.deepEqual(boardTime(48n * HOUR - 1n), { figure: "47", unit: "hrs" });
    assert.deepEqual(boardTime(48n * HOUR), { figure: "2", unit: "days" });
    assert.deepEqual(boardTime(6n * DAY + 22n * HOUR), { figure: "6", unit: "days" });
  });
});

describe("board.plates", () => {
  it("while early with a bonus pool: what is to go, time left, and the bonus clock, the moving ones live", () => {
    const b = boardView({ campaign: campaign(), now: OPENS + 2n * HOUR });
    assert.equal(b.result, null);
    assert.deepEqual(b.plates, [
      { key: "togo", caption: "To go", figure: "760.00", unit: "USDC", live: true },
      { key: "time", caption: "Time left", figure: "6", unit: "days", live: false },
      { key: "bonus", caption: "Early bonus ends in", figure: "22", unit: "hrs", live: true },
    ]);
  });
  it("after the early window: backers takes the bonus plate's place", () => {
    const b = boardView({ campaign: campaign(), now: OPENS + 2n * DAY });
    assert.deepEqual(
      b.plates.map((p) => [p.key, p.figure, p.unit, p.live]),
      [
        ["togo", "760.00", "USDC", true],
        ["time", "5", "days", false],
        ["backers", "31", "", false],
      ],
    );
  });
  it("with no bonus pool there is no bonus clock even while early", () => {
    const b = boardView({ campaign: campaign({ bonusPool: 0n }), now: OPENS + 2n * HOUR });
    assert.deepEqual(
      b.plates.map((p) => p.key),
      ["togo", "time", "backers"],
    );
    assert.equal(b.plates.some((p) => p.caption.includes("BONUS")), false);
  });
});

describe("board.waiting", () => {
  it("before opening: OPENS IN, and nothing on the board is live", () => {
    const b = boardView({ campaign: campaign({}, { pledged: 0n, backers: 0 }), now: OPENS - 90n });
    assert.equal(b.result, null);
    assert.deepEqual(b.plates, [
      { key: "togo", caption: "To go", figure: "2,000.00", unit: "USDC", live: false },
      { key: "opens", caption: "Opens in", figure: "1:30", unit: "min", live: false },
      { key: "backers", caption: "Backers", figure: "0", unit: "", live: false },
    ]);
  });
  it("takes no pledge", () => {
    const r = receiptView({ form: form(campaign({}, { pledged: 0n }), "50", OPENS - 90n, null), campaign: campaign({}, { pledged: 0n }) });
    assert.deepEqual(r, { kind: "none", line: "This campaign opens in 1 min 30 s." });
  });
});

describe("board.result", () => {
  const deadline = (c: CampaignView) => {
    const [day, month, year] = utcStamp(c.terms.closesAt).replace(",", "").split(" ");
    return { figure: `${day} ${month}`, unit: year };
  };
  it("funded: REACHED, the deadline's date and the backers", () => {
    const c = campaign({}, { outcome: Outcome.Funded, pledged: usd(2000), backers: 40 });
    const b = boardView({ campaign: c, now: OPENS + 3n * DAY });
    assert.deepEqual(b.result, { kind: "reached", flag: "Cleared", line: "2,000.00 of 2,000.00 USDC was pledged." });
    assert.deepEqual(b.plates, [
      { key: "time", caption: "Deadline", ...deadline(c), live: false },
      { key: "backers", caption: "Backers", figure: "40", unit: "", live: false },
    ]);
    assert.deepEqual(deadline(c), { figure: "13 Nov", unit: "2026" });
  });
  it("missed, and ended but not yet settled, both read FELL SHORT", () => {
    const missed = boardView({ campaign: campaign({}, { outcome: Outcome.Missed }), now: OPENS + 8n * DAY });
    const ended = boardView({ campaign: campaign(), now: OPENS + 8n * DAY });
    for (const b of [missed, ended]) {
      assert.deepEqual(b.result, { kind: "short", flag: "Returned", line: "1,240.00 of 2,000.00 USDC was pledged. Every pledge goes back." });
      assert.deepEqual(
        b.plates.map((p) => p.key),
        ["time", "backers"],
      );
    }
  });
  it("void: NEVER OPENED", () => {
    const recorded = boardView({ campaign: campaign({}, { outcome: Outcome.Void, pledged: 0n, backers: 0 }), now: OPENS + DAY });
    const pending = boardView({ campaign: campaign({}, { matchIn: false, pledged: 0n, backers: 0 }), now: OPENS + 10n });
    for (const b of [recorded, pending]) {
      assert.deepEqual(b.result, { kind: "void", flag: "Never opened", line: "A pot was not locked in time, so no pledge was taken." });
    }
  });
});

describe("chart.climb", () => {
  const feed = [event("Pledged", 3n, 240, OPENS + 300n), event("Pledged", 1n, 1000, OPENS + 100n), event("Claimed", 4n, 5, OPENS + 400n), event("Pledged", 2n, 70, OPENS + 200n, 8n)];
  it("adds this campaign's pledges in sequence order when they sum to the contract's total", () => {
    assert.deepEqual(climbOf(ledger(feed), 7n, usd(1240)), [
      { t: OPENS + 100n, v: usd(1000) },
      { t: OPENS + 300n, v: usd(1240) },
    ]);
  });
  it("counts a rescue as a step up", () => {
    const withRescue = [...feed, event("Rescued", 5n, 760, OPENS + 500n)];
    assert.deepEqual(climbOf(ledger(withRescue), 7n, usd(2000))?.at(-1), { t: OPENS + 500n, v: usd(2000) });
  });
  it("draws nothing when the keeper disagrees with the contract, is down, or lacks a time", () => {
    assert.equal(climbOf(ledger(feed), 7n, usd(1300)), null);
    assert.equal(climbOf(null, 7n, usd(1240)), null);
    assert.equal(climbOf(ledger([event("Pledged", 1n, 1240, null)]), 7n, usd(1240)), null);
    const unreadable: FeedItem = { ...event("Pledged", 1n, 0, OPENS), args: { amount: "1.5" } };
    assert.equal(climbOf(ledger([unreadable]), 7n, 0n), null);
  });
  it("an untouched campaign has an empty climb, not a missing one", () => {
    assert.deepEqual(climbOf(ledger([]), 7n, 0n), []);
  });
  it("a disagreeing keeper changes no figure: the view keeps the contract's total and says why", () => {
    const v = chartView({ campaign: campaign(), ledger: ledger(feed.slice(1)), now: OPENS + 2n * DAY });
    assert.equal(v.points, null);
    assert.equal(v.total, usd(1240));
    assert.equal(v.why, "The keeper's record does not match the contract yet, so the climb is not drawn.");
    assert.deepEqual(v.table, []);
    assert.equal(chartView({ campaign: campaign(), ledger: null, now: OPENS + 2n * DAY }).why, "The keeper is not answering, so the climb is not drawn.");
  });
  it("names each step in its table and sums up against the steady pace", () => {
    const v = chartView({ campaign: campaign(), ledger: ledger(feed), now: OPENS + 2n * DAY });
    assert.equal(v.why, "");
    assert.deepEqual(v.table, [
      { when: utcStamp(OPENS + 100n), total: "1,000.00" },
      { when: utcStamp(OPENS + 300n), total: "1,240.00" },
    ]);
    assert.equal(v.summary, "1,240.00 of 2,000.00 USDC pledged, ahead of the steady pace to the target.");
    const behind = chartView({ campaign: campaign(), ledger: ledger(feed), now: OPENS + 6n * DAY });
    assert.equal(behind.summary, "1,240.00 of 2,000.00 USDC pledged, behind the steady pace to the target.");
    const settled = chartView({ campaign: campaign({}, { outcome: Outcome.Missed }), ledger: ledger(feed), now: OPENS + 8n * DAY });
    assert.equal(settled.summary, "1,240.00 of 2,000.00 USDC pledged.");
  });
});

describe("chart.paths", () => {
  const t = { opensAt: OPENS, earlyUntil: OPENS + 100n, closesAt: OPENS + 1000n, target: usd(100) };
  const feed = [event("Pledged", 1n, 50, OPENS + 500n)];
  it("steps up at each pledge, runs on to now, and draws the pace and the early band", () => {
    const v = chartView({ campaign: campaign(t, { pledged: usd(50) }), ledger: ledger(feed), now: OPENS + 600n });
    const p = chartPaths(v, { w: 100, h: 50 });
    assert.equal(p.climb, "M0,50 H50 V25 H60");
    assert.equal(p.pace, "M0,50 L100,0");
    assert.equal(p.targetY, 0);
    assert.deepEqual(p.band, { x: 0, w: 10 });
    assert.equal(p.nowX, 60);
    assert.equal(p.nowY, 25);
  });
  it("stops at the deadline, has no band without a bonus pool, and no climb without points", () => {
    const late = chartPaths(chartView({ campaign: campaign({ ...t, bonusPool: 0n }, { pledged: usd(50) }), ledger: ledger(feed), now: OPENS + 5000n }), { w: 100, h: 50 });
    assert.equal(late.climb, "M0,50 H50 V25 H100");
    assert.equal(late.band, null);
    assert.equal(late.nowX, 100);
    const none = chartPaths(chartView({ campaign: campaign(t, { pledged: usd(50) }), ledger: null, now: OPENS + 600n }), { w: 100, h: 50 });
    assert.equal(none.climb, null);
    assert.equal(none.nowY, 25);
  });
});

describe("receipt.two", () => {
  it("while early: what the recipient gets if met, what comes back with the bonus if not", () => {
    const c = campaign();
    const r = receiptView({ form: form(c, "50", OPENS + 2n * HOUR, { wouldFund: false, counted: usd(50), bonus: usd(1.58) }), campaign: c });
    assert.deepEqual(r, {
      kind: "two",
      met: { heading: "If the target is met", figure: "50.00 USDC", line: "goes to the recipient, and the sponsor adds its 500.00 USDC match." },
      missed: { heading: "If it falls short", figure: "51.58 USDC", line: "comes back to you: your 50.00 plus about 1.58 for backing early.", live: true },
    });
  });
  it("no bonus pool and no match: no bonus words and no match words", () => {
    const c = campaign({ bonusPool: 0n, matchAmount: 0n });
    const r = receiptView({ form: form(c, "50", OPENS + 2n * HOUR, { wouldFund: false, counted: usd(50), bonus: 0n }), campaign: c });
    assert.equal(r.kind, "two");
    if (r.kind !== "two") return;
    assert.deepEqual(r.met, { heading: "If the target is met", figure: "50.00 USDC", line: "goes to the recipient." });
    assert.deepEqual(r.missed, { heading: "If it falls short", figure: "50.00 USDC", line: "comes back to you in full.", live: false });
  });
  it("after the early window: says the window has closed", () => {
    const c = campaign();
    const r = receiptView({ form: form(c, "50", OPENS + 2n * DAY, { wouldFund: false, counted: usd(50), bonus: 0n }), campaign: c });
    assert.equal(r.kind === "two" && r.missed.line, "comes back to you in full. The early bonus window has closed.");
    assert.equal(r.kind === "two" && r.missed.live, false);
  });
});

describe("receipt.held", () => {
  // Seen on Arc (campaign 8): a pledge of 2.00 was on its way, the chain already counted it, and
  // the cheque worked the 2.00 still typed out again as a second pledge that would finish the campaign.
  const t = { target: usd(3), minPledge: usd(0.1), matchAmount: usd(1), bonusPool: usd(0.3), rateBps: 2000 };
  const before = campaign(t, { pledged: 0n, pledgedEarly: 0n, weighted: 0n, backers: 0 });
  const after = campaign(t, { pledged: usd(2), pledgedEarly: usd(2), weighted: usd(2) * 1_000_000n, backers: 1 });
  const pressed = form(before, "2.00", OPENS + 50n, { wouldFund: false, counted: usd(2), bonus: usd(0.2) });
  const landed = form(after, "2.00", OPENS + 53n, { wouldFund: true, counted: usd(1), bonus: 0n });
  const kept = { form: pressed, receipt: receiptView({ form: pressed, campaign: before }) };
  const now = { form: landed, receipt: receiptView({ form: landed, campaign: after }) };

  it("is a different receipt once the chain counts the pledge, which is why it must not be shown", () => {
    assert.equal(kept.receipt.kind, "two");
    assert.equal(now.receipt.kind, "completes");
  });

  it("keeps what the cheque showed at the press for as long as the pledge is on its way", () => {
    const { shown, held } = shownWhileSending({ busy: true, id: 7n, kept: { id: 7n, shown: kept }, now });
    assert.equal(held, true);
    assert.equal(shown, kept);
    assert.equal(shown.receipt.kind === "two" && shown.receipt.missed.figure, "2.20 USDC");
    assert.equal(shown.form.button, pressed.button);
  });

  it("shows what is true now as soon as the send ends, whether it went through or not", () => {
    assert.deepEqual(shownWhileSending({ busy: false, id: 7n, kept: { id: 7n, shown: kept }, now }), { shown: now, held: false });
  });

  it("never shows another campaign's cheque, and has nothing to keep when it was opened mid-send", () => {
    // The same form serves every campaign's page: what it kept for campaign 8 is not campaign 7's.
    assert.deepEqual(shownWhileSending({ busy: true, id: 7n, kept: { id: 8n, shown: kept }, now }), { shown: now, held: false });
    assert.deepEqual(shownWhileSending({ busy: true, id: 7n, kept: null, now }), { shown: now, held: false });
  });
});

describe("receipt.completes", () => {
  it("a pledge that finishes the campaign shows one part that says so", () => {
    const c = campaign();
    const r = receiptView({ form: form(c, "800", OPENS + 2n * DAY, { wouldFund: true, counted: usd(760), bonus: 0n }), campaign: c });
    assert.deepEqual(r, { kind: "completes", line: "This pledge finishes the campaign. 760.00 is taken and 40.00 stays with you." });
  });
});

describe("receipt.none", () => {
  it("nothing typed, or not an amount, or too small: the form's own sentence", () => {
    const c = campaign();
    const now = OPENS + 2n * DAY;
    assert.deepEqual(receiptView({ form: form(c, "", now, null), campaign: c }), { kind: "none", line: "Enter an amount." });
    assert.deepEqual(receiptView({ form: form(c, "abc", now, null), campaign: c }), { kind: "none", line: "That is not an amount. Use digits, like 25 or 25.50." });
    assert.deepEqual(receiptView({ form: form(c, "1", now, { wouldFund: false, counted: 0n, bonus: 0n }), campaign: c }), { kind: "none", line: "The smallest pledge is 5.00." });
  });
});

describe("flip.changed", () => {
  it("counts from the right and names only the characters that changed", () => {
    assert.deepEqual(changedPositions("1,240.00", "1,265.00"), [3, 4]);
    assert.deepEqual(changedPositions("760.00", "760.00"), []);
    assert.deepEqual(changedPositions("999.00", "1,000.00"), [3, 4, 5, 6, 7]);
    assert.deepEqual(changedPositions("1,000.00", "999.00"), [3, 4, 5, 6, 7]);
  });
});

describe("board.ago", () => {
  it("names how long ago in the largest whole unit", () => {
    assert.equal(agoLine(OPENS, OPENS + 9n), "9 s ago");
    assert.equal(agoLine(OPENS, OPENS + 125n), "2 min ago");
    assert.equal(agoLine(OPENS, OPENS + HOUR), "1 hr ago");
    assert.equal(agoLine(OPENS, OPENS + 5n * HOUR), "5 hrs ago");
    assert.equal(agoLine(OPENS, OPENS + DAY), "1 day ago");
    assert.equal(agoLine(OPENS, OPENS + 3n * DAY), "3 days ago");
  });
  it("a time ahead of the block, or none, says nothing it cannot know", () => {
    assert.equal(agoLine(OPENS + 5n, OPENS), "0 s ago");
    assert.equal(agoLine(null, OPENS), null);
  });
  it("keys each event of the ledger by its sequence number", () => {
    const m = agoOf(ledger([event("Pledged", 1n, 5, OPENS), event("Pledged", 2n, 5, null)]), OPENS + 120n);
    assert.equal(m.get("1"), "2 min ago");
    assert.equal(m.has("2"), false);
    assert.equal(agoOf(null, OPENS).size, 0);
  });
});

describe("board.settled", () => {
  it("a missed campaign's receipt says what goes back, from the contract's own figures", () => {
    const c = campaign({}, { outcome: Outcome.Missed, bonusPaid: usd(0.12), backers: 3, pledged: usd(1.5) });
    assert.equal(settledLine(c), "1.50 USDC goes back to 3 backers, plus 0.12 USDC of bonus for early backers.");
    const one = campaign({ bonusPool: 0n }, { outcome: Outcome.Missed, bonusPaid: 0n, backers: 1, pledged: usd(20) });
    assert.equal(settledLine(one), "20.00 USDC goes back to 1 backer.");
  });
  it("any other outcome has no such line", () => {
    assert.equal(settledLine(campaign({}, { outcome: Outcome.Funded })), null);
    assert.equal(settledLine(campaign()), null);
  });
});

describe("chart.valueLabel", () => {
  // The target's label is set at y -8, flush right; the pace label under the pace line's end.
  it("chart.valueLabel.cleared: at the right end of a campaign that met its target the total goes under its point, not onto TARGET", () => {
    assert.equal(valueLabelY({ dotRight: false, open: false, nowY: 0, paceLabelY: 40 }), 20);
    assert.equal(valueLabelY({ dotRight: false, open: false, nowY: 10, paceLabelY: 40 }), 30);
  });
  it("chart.valueLabel.missed: at the right end of a closed campaign well under its target the total stays above its point", () => {
    assert.equal(valueLabelY({ dotRight: false, open: false, nowY: 100, paceLabelY: 40 }), 92);
  });
  it("chart.valueLabel.pace: at the right end of an open campaign the total keeps clear of PACE NEEDED, as before", () => {
    assert.equal(valueLabelY({ dotRight: false, open: true, nowY: 50, paceLabelY: 40 }), 70);
    assert.equal(valueLabelY({ dotRight: false, open: true, nowY: 100, paceLabelY: 40 }), 92);
  });
  it("chart.valueLabel.left: away from the right end the total is beside its point and stays above it", () => {
    assert.equal(valueLabelY({ dotRight: true, open: true, nowY: 0, paceLabelY: 40 }), -8);
    assert.equal(valueLabelY({ dotRight: true, open: false, nowY: 50, paceLabelY: 40 }), 42);
  });
});

describe("chart.axis", function () {
  it("a campaign whose two ends fall on one UTC day is marked by the time of day; any other by the day, with the year when the years differ", function () {
    const at = (iso: string) => BigInt(Date.parse(iso) / 1000);
    // The desk's two-minute campaign: the same date at both ends would say nothing.
    assert.deepEqual(axisEnds(at("2026-11-19T01:25:40Z"), at("2026-11-19T01:27:40Z")), { opens: "Opens 01:25 UTC", closes: "Closes 01:27 UTC" });
    assert.deepEqual(axisEnds(at("2026-11-19T00:00:00Z"), at("2026-11-19T23:59:59Z")), { opens: "Opens 00:00 UTC", closes: "Closes 23:59 UTC" });
    // Two days: the day tells the ends apart, however short the campaign. Times alone would
    // read as closing before it opened (10:00 to 09:59 the next day).
    assert.deepEqual(axisEnds(at("2026-11-19T23:59:00Z"), at("2026-11-20T00:01:00Z")), { opens: "Opens 19 Nov", closes: "Closes 20 Nov" });
    assert.deepEqual(axisEnds(at("2026-11-19T10:00:00Z"), at("2026-11-20T09:59:59Z")), { opens: "Opens 19 Nov", closes: "Closes 20 Nov" });
    assert.deepEqual(axisEnds(at("2026-11-06T21:20:00Z"), at("2026-11-13T21:20:00Z")), { opens: "Opens 6 Nov", closes: "Closes 13 Nov" });
    // Across a year end the year is said, so the same day of the month cannot read as one day.
    assert.deepEqual(axisEnds(at("2026-11-19T10:00:00Z"), at("2027-11-19T10:00:00Z")), { opens: "Opens 19 Nov 2026", closes: "Closes 19 Nov 2027" });
    assert.deepEqual(axisEnds(at("2026-12-31T23:59:00Z"), at("2027-01-01T00:01:00Z")), { opens: "Opens 31 Dec 2026", closes: "Closes 1 Jan 2027" });
    // A date the page cannot read is said as that, at either end.
    assert.deepEqual(axisEnds(at("2026-11-19T10:00:00Z"), 999_999_999_999_999n), { opens: "Opens 19 Nov 2026", closes: "Closes an unreadable date" });
    assert.deepEqual(axisEnds(999_999_999_999_999n, 999_999_999_999_999n), { opens: "Opens an unreadable date", closes: "Closes an unreadable date" });
  });
});
