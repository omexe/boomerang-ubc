// Every amount, address and time in these tests is invented. None is a reading of any real campaign.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Backer, State, Terms } from "../../packages/kit/src/index.ts";
import { Outcome } from "../../packages/kit/src/index.ts";
import { clockLine, endsAs, phaseOf, progressOf, quotePledge, standingOf } from "../src/data/campaign.ts";
import { UNIT, exactUsd, formatUsd, parseUsd } from "../src/data/money.ts";
import { timeLeft } from "../src/data/time.ts";

const A = "0x00000000000000000000000000000000000000a1" as const;
const usd = (n: number) => BigInt(Math.round(n * 1_000_000));

const terms = (over: Partial<Terms> = {}): Terms => ({
  recipient: A,
  opensAt: 1_000n,
  earlyUntil: 2_000n,
  closesAt: 3_000n,
  target: usd(100),
  minPledge: usd(1),
  matchAmount: usd(20),
  bonusPool: usd(10),
  rateBps: 500,
  linearWeight: false,
  bonusFromRecipient: false,
  ...over,
});
const state = (over: Partial<State> = {}): State => ({
  sponsor: A,
  outcome: Outcome.Open,
  matchIn: true,
  bonusIn: true,
  recipientPaid: false,
  matchReturned: false,
  bonusReturned: false,
  backers: 0,
  pledged: 0n,
  pledgedEarly: 0n,
  weighted: 0n,
  bonusPaid: 0n,
  ...over,
});
const backer = (principal: bigint, early: boolean, over: Partial<Backer> = {}): Backer => ({
  principal,
  weighted: early ? principal * UNIT : 0n,
  payTo: "0x0000000000000000000000000000000000000000",
  paid: false,
  ...over,
});

describe("money", function () {
  it("shows dollars and cents, cut down, with thousands marks", function () {
    assert.equal(formatUsd(0n), "0.00");
    assert.equal(formatUsd(usd(25)), "25.00");
    assert.equal(formatUsd(1_234_567_890n), "1,234.56"); // 1,234.56789 is cut, not rounded up
    assert.equal(formatUsd(999_999n), "0.99");
    assert.equal(formatUsd(usd(1_000_000)), "1,000,000.00");
    assert.equal(formatUsd(-usd(2.5)), "-2.50");
    // The one formatter: any amount above zero and under a cent reads "less than 0.01"; zero still reads "0.00".
    assert.equal(formatUsd(9_999n), "less than 0.01");
    assert.equal(formatUsd(1n), "less than 0.01");
    assert.equal(formatUsd(10_000n), "0.01");
  });

  it("exactUsd prints all six decimals, trimmed, for a value a person can type", function () {
    assert.equal(exactUsd(0n), "0");
    assert.equal(exactUsd(usd(25)), "25");
    assert.equal(exactUsd(usd(25.5)), "25.5");
    assert.equal(exactUsd(1n), "0.000001");
    assert.equal(exactUsd(9_999n), "0.009999");
    assert.equal(exactUsd(1_234_567_890n), "1,234.56789");
    assert.equal(exactUsd(-usd(2.5)), "-2.5");
    // Whatever exactUsd shows parses back to the same amount.
    for (const units of [0n, 1n, 9_999n, usd(25.5), 1_234_567_890n]) assert.equal(parseUsd(exactUsd(units).replace(/,/g, "")), units);
  });

  it("reads what a person types, and refuses what is not an amount", function () {
    const good: [string, bigint][] = [
      ["25", usd(25)],
      [" 25.5 ", usd(25.5)],
      ["$1,000.25", usd(1000.25)],
      [".5", 500_000n],
      ["0.000001", 1n],
      ["25.", usd(25)],
      ["1,234,567", usd(1_234_567)],
      ["0", 0n],
    ];
    for (const [text, want] of good) assert.equal(parseUsd(text), want, text);
    for (const text of ["", " ", ".", "-5", "+5", "1e3", "5 dollars", "1.2.3", "0.0000001", "1,00", "12,34", "1,0000", "٢٥", "25,", "$", "1234567890123456"]) {
      assert.equal(parseUsd(text), null, JSON.stringify(text));
    }
  });

  it("an amount typed and shown comes back the same to the cent", function () {
    for (const cents of [0, 1, 99, 100, 2_500, 123_456, 99_999_999]) {
      const units = BigInt(cents) * 10_000n;
      assert.equal(parseUsd(formatUsd(units)), units);
    }
  });
});

describe("time left", function () {
  it("gives the two largest units", function () {
    const cases: [bigint, string][] = [
      [-5n, "0 s"],
      [0n, "0 s"],
      [9n, "9 s"],
      [60n, "1 min"],
      [250n, "4 min 10 s"],
      [3_600n, "1 hour"],
      [7_500n, "2 hours 5 min"],
      [86_400n, "1 day"],
      [90_000n, "1 day 1 hour"],
      [273_600n, "3 days 4 hours"],
    ];
    for (const [s, want] of cases) assert.equal(timeLeft(s), want);
  });
});

describe("a campaign as the page shows it", function () {
  it("phases follow the clock and the pots", function () {
    const t = terms();
    assert.equal(phaseOf(t, state(), 999n), "waiting");
    assert.equal(phaseOf(t, state(), 1_000n), "early");
    assert.equal(phaseOf(t, state(), 1_999n), "early");
    assert.equal(phaseOf(t, state(), 2_000n), "open"); // the early deadline's own second earns nothing
    assert.equal(phaseOf(t, state(), 2_999n), "open");
    assert.equal(phaseOf(t, state(), 3_000n), "ended"); // the closing second takes no pledge
    assert.equal(endsAs(t, state(), 3_000n), "missed");
    // a pot missing: still "waiting" before opening, "ended" as void from the opening second
    assert.equal(phaseOf(t, state({ bonusIn: false }), 999n), "waiting");
    assert.equal(phaseOf(t, state({ bonusIn: false }), 1_000n), "ended");
    assert.equal(endsAs(t, state({ bonusIn: false }), 1_000n), "void");
    assert.equal(endsAs(t, state({ bonusIn: false }), 5_000n), "void");
    for (const [outcome, phase] of [[Outcome.Funded, "funded"], [Outcome.Missed, "missed"], [Outcome.Void, "void"]] as const) {
      assert.equal(phaseOf(t, state({ outcome }), 1_500n), phase);
      assert.equal(endsAs(t, state({ outcome }), 9_000n), null);
    }
  });

  it("progress reads 100 percent only when the target is met", function () {
    const t = terms();
    assert.equal(progressOf(t, state({ pledged: usd(99.999999) })).percent, 99);
    assert.equal(progressOf(t, state({ pledged: usd(100) })).percent, 100);
    assert.deepEqual(progressOf(t, state({ pledged: usd(60) })), { pledged: usd(60), target: usd(100), gap: usd(40), percent: 60, potsIn: true });
    assert.equal(progressOf(t, state({ matchIn: false })).potsIn, false);
    assert.equal(progressOf(terms({ matchAmount: 0n, bonusPool: 0n }), state({ matchIn: false, bonusIn: false })).potsIn, true);
  });

  it("the clock line names what is counting down", function () {
    const t = terms();
    assert.equal(clockLine(t, state(), 940n), "Opens in 1 min");
    assert.equal(clockLine(t, state(), 1_400n), "Early bonus window closes in 10 min");
    assert.equal(clockLine(t, state(), 2_750n), "Closes in 4 min 10 s");
    assert.equal(clockLine(t, state(), 3_000n), "Deadline passed. Waiting to be settled");
    assert.equal(clockLine(t, state({ matchIn: false }), 1_000n), "A pot was not locked in time. Waiting to be closed");
    // A campaign funded ahead of its deadline does not say the deadline "was": it has not come yet.
    assert.match(clockLine(t, state({ outcome: Outcome.Funded }), 2_000n), /^Funded before its deadline, .+ UTC$/);
    assert.match(clockLine(t, state({ outcome: Outcome.Funded }), 3_000n), /^Deadline was .+ UTC$/);
    assert.match(clockLine(t, state({ outcome: Outcome.Missed }), 3_000n), /^Deadline was .+ UTC$/);
  });

  it("the worked example: with Alice's 30 in, Bob's 20 early would bring back 20.50 on a miss", function () {
    // ECONOMICS.md: target 100, pool 10, rate 5%, flat weight; Alice 30 and Bob 20 early.
    const t = terms();
    const afterAlice = state({ backers: 1, pledged: usd(30), pledgedEarly: usd(30), weighted: usd(30) * UNIT });
    const q = quotePledge(t, afterAlice, usd(20), 1_500n);
    assert.equal(q.kind, "counts");
    assert.deepEqual(q.kind === "counts" && [q.bonus, q.back, q.early], [usd(0.5), usd(20.5), true]);
    assert.equal(q.line, "If this misses: you get back 20.00 plus about 0.50.");
  });

  it("the mockup's campaign: 25 pledged early into 1,240 of 2,000 would bring back 26.58", function () {
    const t = terms({ target: usd(2_000), matchAmount: usd(500), bonusPool: usd(200), rateBps: 1_000 });
    const s = state({ backers: 31, pledged: usd(1_240), pledgedEarly: usd(1_240), weighted: usd(1_240) * UNIT });
    const q = quotePledge(t, s, usd(25), 1_500n);
    assert.equal(q.line, "If this misses: you get back 25.00 plus about 1.58.");
    assert.equal(q.kind === "counts" && formatUsd(q.back), "26.58");
  });

  it("a late pledge, a pledge with no bonus on offer, the finishing pledge and each refusal read differently", function () {
    const t = terms();
    const s = state({ backers: 1, pledged: usd(30), pledgedEarly: usd(30), weighted: usd(30) * UNIT });
    assert.equal(quotePledge(t, s, usd(10), 2_500n).line, "If this misses: you get back 10.00. The early bonus window has closed.");
    assert.equal(quotePledge(terms({ bonusPool: 0n }), s, usd(10), 1_500n).line, "If this misses: you get back 10.00.");
    const exact = quotePledge(t, s, usd(70), 1_500n);
    assert.deepEqual([exact.kind, exact.line], ["completes", "This pledge finishes the campaign."]);
    const over = quotePledge(t, s, usd(100), 1_500n);
    assert.equal(over.line, "This pledge finishes the campaign. 70.00 is taken and 30.00 stays with you.");
    assert.deepEqual(over.kind === "completes" && [over.counted, over.kept], [usd(70), usd(30)]);
    // below the minimum, unless it is the last bit that finishes the campaign
    assert.deepEqual([quotePledge(t, s, usd(0.5), 1_500n).kind, quotePledge(t, s, usd(0.5), 1_500n).line], ["refused", "The smallest pledge is 1.00."]);
    assert.equal(quotePledge(t, state({ pledged: usd(99.5) }), usd(0.5), 1_500n).kind, "completes");
    assert.equal(quotePledge(t, s, 0n, 1_500n).line, "Enter an amount.");
    assert.equal(quotePledge(t, s, usd(5), 940n).line, "This campaign opens in 1 min.");
    assert.equal(quotePledge(t, s, usd(5), 3_000n).line, "This campaign is no longer taking pledges.");
    assert.equal(quotePledge(t, state({ outcome: Outcome.Funded }), usd(5), 1_500n).kind, "refused");
    assert.equal(quotePledge(t, state({ bonusIn: false }), usd(5), 1_500n).kind, "refused"); // void from opening
    assert.equal(quotePledge(t, s, usd(5), 1_500n, { isSponsor: true }).line, "The sponsor's account cannot pledge to its own campaign.");
  });

  it("a tiny bonus is said as less than a cent, never as zero", function () {
    const t = terms({ target: usd(100_000), bonusPool: usd(10) });
    const q = quotePledge(t, state(), usd(100), 1_500n);
    assert.ok(q.kind === "counts" && q.bonus > 0n && q.bonus < 10_000n, "the case needs a bonus under one cent");
    assert.equal(q.line, "If this misses: you get back 100.00 plus less than 0.01.");
  });

  it("my money: counted, given, owed and returned", function () {
    const t = terms();
    const open = state({ backers: 2, pledged: usd(50), pledgedEarly: usd(50), weighted: usd(50) * UNIT });
    assert.deepEqual(standingOf(t, open, backer(0n, false)), { kind: "none", line: "" });
    assert.equal(standingOf(t, open, backer(usd(30), true)).line, "30.00 is counted. If the campaign misses as it stands, it comes back with about 0.75.");
    assert.equal(standingOf(t, open, backer(usd(10), false)).line, "10.00 is counted. If the campaign misses, it comes back in full.");
    assert.equal(standingOf(t, state({ outcome: Outcome.Funded }), backer(usd(30), true)).line, "30.00 went to the campaign. It was funded.");
    const missed = state({ outcome: Outcome.Missed, backers: 3, pledged: usd(60), pledgedEarly: usd(50), weighted: usd(50) * UNIT, bonusPaid: usd(1.25) });
    const owed = standingOf(t, missed, backer(usd(30), true));
    assert.deepEqual([owed.kind, owed.line], ["owed", "30.00 plus 0.75 bonus is yours. Anyone can send it; you can too."]);
    assert.equal(standingOf(t, missed, backer(usd(10), false)).line, "10.00 is yours. Anyone can send it; you can too.");
    assert.equal(standingOf(t, missed, backer(usd(20), true, { paid: true })).line, "20.00 came back, plus 0.50 bonus.");
    assert.equal(standingOf(t, missed, backer(usd(10), false, { paid: true })).line, "10.00 came back.");
  });

  it("my money: a refund pointed at another address is said to go there, and is not called 'came back'", function () {
    const t = terms();
    const missed = state({ outcome: Outcome.Missed, backers: 3, pledged: usd(60), pledgedEarly: usd(50), weighted: usd(50) * UNIT, bonusPaid: usd(1.25) });
    // A is the address this account chose; short(A) is "0x0000…00a1".
    const paid = standingOf(t, missed, backer(usd(20), true, { paid: true }), A);
    assert.deepEqual([paid.kind, paid.line], ["returned", "20.50 was paid to 0x0000…00a1, the address you chose."]);
    const owed = standingOf(t, missed, backer(usd(30), true), A);
    assert.deepEqual([owed.kind, owed.line], ["owed", "30.75 is owed and will go to 0x0000…00a1, the address you chose."]);
  });
});
