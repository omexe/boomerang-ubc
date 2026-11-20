// The pieces the look-up, the backers table and the practice wallet all stand on: an address in
// the route, a backer's standing said of someone else, which backer stands as the example, and
// the block the contract was created in. Every amount and account here is invented.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Backer, State, Terms } from "../../packages/kit/src/index.ts";
import { Outcome } from "../../packages/kit/src/index.ts";
import { configFrom } from "../src/app/config.ts";
import { hrefFor, routeOf } from "../src/app/route.ts";
import { standingOf } from "../src/data/campaign.ts";
import { exampleBacker, type LedgerBackerView, type LedgerCampaignView, type LedgerView } from "../src/data/keeper.ts";

const RECIPIENT = "0x00000000000000000000000000000000000000aa" as const;
const SPONSOR = "0x00000000000000000000000000000000000000b1" as const;
const A = "0x00000000000000000000000000000000000000c1" as const;
const B = "0x00000000000000000000000000000000000000c2" as const;
const C = "0x00000000000000000000000000000000000000c3" as const;
const ELSEWHERE = "0x00000000000000000000000000000000000000d4" as const;
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
  backers: 2, pledged: usd(400), pledgedEarly: usd(400), weighted: usd(400) * 1_000_000n, bonusPaid: 0n, ...over,
});
const backer = (principal: bigint, early: boolean, over: Partial<Backer> = {}): Backer => ({ principal, weighted: early ? principal * 1_000_000n : 0n, payTo: ZERO, paid: false, ...over });

describe("an address in the route", function () {
  it("route.who: #/mine/<address> names whose money to show, and comes back as the same hash", function () {
    const who = "0xAbCdEf0123456789abcdef0123456789ABCDEF01";
    assert.deepEqual(routeOf(`#/mine/${who}`), { page: "mine", who });
    assert.equal(hrefFor({ page: "mine", who }), `#/mine/${who}`);
    assert.deepEqual(routeOf("#/mine"), { page: "mine" });
    assert.equal(hrefFor({ page: "mine" }), "#/mine");
    assert.deepEqual(routeOf(hrefFor(routeOf(`#/mine/${who}/`))), { page: "mine", who });
  });

  it("route.who: anything after #/mine that is not an address is not a page", function () {
    for (const bad of ["#/mine/0x1234", "#/mine/abc", `#/mine/0x${"g".repeat(40)}`, `#/mine/0x${"a".repeat(40)}/more`, `#/mine/0x${"a".repeat(41)}`]) {
      assert.deepEqual(routeOf(bad), { page: "lost", hash: bad }, bad);
    }
  });
});

describe("a backer's standing, said of someone else", function () {
  const t = terms();

  it("standing.third: what is owed is owed to this backer, never to you", function () {
    const missed = state({ outcome: Outcome.Missed, bonusPaid: usd(40) });
    assert.equal(standingOf(t, missed, backer(usd(100), true), null, true).line, "100.00 plus 10.00 bonus is owed to this backer. Anyone can send it.");
    assert.equal(standingOf(t, missed, backer(usd(100), false), null, true).line, "100.00 is owed to this backer. Anyone can send it.");
    assert.equal(standingOf(t, missed, backer(usd(100), false), ELSEWHERE, true).line, "100.00 is owed and will go to 0x0000…00d4, the address this backer chose.");
    assert.equal(standingOf(t, missed, backer(usd(100), false, { paid: true }), ELSEWHERE, true).line, "100.00 was paid to 0x0000…00d4, the address this backer chose.");
  });

  it("standing.third: the sentences that never said you are the same, and so are the figures", function () {
    const open = state();
    const missedPaid = state({ outcome: Outcome.Missed, bonusPaid: usd(40) });
    const funded = state({ outcome: Outcome.Funded });
    for (const [s, b] of [[open, backer(usd(100), true)], [funded, backer(usd(100), true)], [missedPaid, backer(usd(100), true, { paid: true })]] as const) {
      assert.deepEqual(standingOf(t, s, b, null, true), standingOf(t, s, b, null));
    }
    // Owed: only the words change.
    const missed = state({ outcome: Outcome.Missed, bonusPaid: usd(40) });
    const first = standingOf(t, missed, backer(usd(100), true), null);
    const third = standingOf(t, missed, backer(usd(100), true), null, true);
    assert.equal(first.line, "100.00 plus 10.00 bonus is yours. Anyone can send it; you can too.");
    assert.deepEqual({ ...third, line: "" }, { ...first, line: "" });
  });
});

describe("which backer stands as the example", function () {
  const lb = (address: `0x${string}`): LedgerBackerView => ({ address, principal: usd(1), weighted: 0n, payTo: null, paid: false, paidPrincipal: 0n, paidBonus: 0n });
  const lc = (id: bigint, backers: `0x${string}`[]): LedgerCampaignView => ({
    id, sponsor: SPONSOR, terms: terms(), matchIn: true, bonusIn: true, outcome: Outcome.Open, pledged: 0n, pledgedEarly: 0n, earlyUnknown: 0n, weighted: 0n,
    bonusPaid: 0n, expectedBonusPaid: null, recipientPaid: false, matchReturned: false, bonusReturned: false, payFailures: 0, backers: backers.map(lb),
  });
  const ledger = (campaigns: LedgerCampaignView[]): LedgerView => ({ lastSeq: 0n, totalOwed: 0n, missing: null, campaigns, feed: [] });

  it("example.most: the address in the most campaigns", function () {
    assert.equal(exampleBacker(ledger([lc(1n, [A, B]), lc(2n, [B]), lc(3n, [C, B])])), B);
  });

  it("example.tie: between equals, the one in the newest campaign, then the lowest address", function () {
    assert.equal(exampleBacker(ledger([lc(1n, [A]), lc(2n, [C]), lc(3n, [B])])), B);
    assert.equal(exampleBacker(ledger([lc(4n, [C, A, B])])), A);
    // The same address written in two cases is one backer.
    const upper = A.toUpperCase().replace("0X", "0x") as `0x${string}`;
    assert.equal(exampleBacker(ledger([lc(1n, [upper, B]), lc(2n, [A]), lc(3n, [C])]))?.toLowerCase(), A);
  });

  it("example.none: a ledger with no backers has no example", function () {
    assert.equal(exampleBacker(ledger([])), null);
    assert.equal(exampleBacker(ledger([lc(1n, [])])), null);
  });
});

describe("the block the contract was created in", function () {
  const at = { boomerang: A, usdc: B, router: C } as const;

  it("config.deployBlock: from the deployment on Arc, and the first block on a local chain", function () {
    assert.equal(configFrom({}, () => ({ ...at, deployBlock: 72_640_266n })).deployBlock, 72_640_266n);
    assert.equal(configFrom({}, () => at).deployBlock, 0n);
    const local = { VITE_CHAIN_ID: "31337", VITE_RPC_URL: "http://127.0.0.1:8545", VITE_BOOMERANG: A, VITE_USDC: B, VITE_ROUTER: C };
    assert.equal(configFrom(local, () => at).deployBlock, 0n);
  });
});
