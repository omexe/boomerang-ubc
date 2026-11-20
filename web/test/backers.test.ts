// The backers table on a campaign's page: who backed it, by the contract's own figures read
// through the keeper's list of addresses, ending in the contract's own total at the block read.
// The addresses come from the keeper; every figure is the contract's.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Address, Backer, State, Terms } from "../../packages/kit/src/index.ts";
import { Outcome } from "../../packages/kit/src/index.ts";
import type { CampaignView } from "../src/data/load.ts";
import type { World } from "../src/app/world.ts";
import { backersTable } from "../src/views/backers.ts";

const RECIPIENT = "0x00000000000000000000000000000000000000aa" as const;
const SPONSOR = "0x00000000000000000000000000000000000000b1" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const A1 = "0x00000000000000000000000000000000000000a1" as const;
const A2 = "0x00000000000000000000000000000000000000a2" as const;
const A3 = "0x00000000000000000000000000000000000000a3" as const;
const usd = (n: number) => BigInt(Math.round(n * 1_000_000));
const OPENS = 1_794_000_000n;
const DAY = 86_400n;
const BLOCK = 99n;

const terms = (over: Partial<Terms> = {}): Terms => ({
  recipient: RECIPIENT, opensAt: OPENS, earlyUntil: OPENS + DAY, closesAt: OPENS + 7n * DAY, target: usd(2000), minPledge: usd(5),
  matchAmount: usd(500), bonusPool: usd(100), rateBps: 1000, linearWeight: false, bonusFromRecipient: false, ...over,
});
const state = (over: Partial<State> = {}): State => ({
  sponsor: SPONSOR, outcome: Outcome.Open, matchIn: true, bonusIn: true, recipientPaid: false, matchReturned: false, bonusReturned: false,
  backers: 2, pledged: usd(150), pledgedEarly: usd(100), weighted: usd(300), bonusPaid: 0n, ...over,
});
const campaign = (t: Partial<Terms> = {}, s: Partial<State> = {}, id = 7n): CampaignView => ({ id, terms: terms(t), state: state(s), outcomeNow: 0 });

const backer = (over: Partial<Backer> = {}): Backer => ({ principal: usd(100), weighted: usd(100), payTo: ZERO, paid: false, ...over });
type Row = NonNullable<World["shownBackers"]>["rows"][number];
const row = (
  address: Address,
  b: Backer,
  owed: { principal: bigint; bonus: bigint } = { principal: 0n, bonus: 0n },
  ifMissed: { principal: bigint; bonus: bigint } = { principal: 0n, bonus: 0n },
): Row => ({ address, backer: b, owed, ifMissed });
const shown = (id: bigint, rows: Row[], listed = rows.length): World["shownBackers"] => ({ id, rows, listed });

const table = (o: { campaign: CampaignView; shown: World["shownBackers"]; keeperUp?: boolean }) =>
  backersTable({ campaign: o.campaign, shown: o.shown, keeperUp: o.keeperUp ?? true, block: BLOCK });

describe("the backers table", function () {
  it("backers.none: nobody has pledged", function () {
    const t = table({ campaign: campaign({}, { backers: 0, pledged: 0n }), shown: null });
    assert.equal(t.title, "Backers");
    assert.deepEqual(t.head, ["Account", "Pledged", "When", "Comes back"]);
    assert.equal(t.state, "none");
    assert.deepEqual(t.rows, []);
    assert.equal(t.total, null);
    assert.equal(t.note, "Nobody has pledged yet.");
  });

  it("backers.down: the keeper is not answering, singular and plural", function () {
    const one = table({ campaign: campaign({}, { backers: 1, pledged: usd(40) }), shown: null, keeperUp: false });
    assert.equal(one.state, "down");
    assert.deepEqual(one.rows, []);
    assert.equal(one.total, null);
    assert.equal(
      one.note,
      "The contract keeps no list of its backers, so the list comes from the keeper, which is not answering. The contract counts 1 backer and 40.00 USDC pledged.",
    );
    const many = table({ campaign: campaign({}, { backers: 3, pledged: usd(150) }), shown: null, keeperUp: false });
    assert.equal(
      many.note,
      "The contract keeps no list of its backers, so the list comes from the keeper, which is not answering. The contract counts 3 backers and 150.00 USDC pledged.",
    );
  });

  it("backers.waiting: not read yet (null and a stale other id) is said as reading, never as the keeper's fault", function () {
    const none = table({ campaign: campaign({}, { backers: 1, pledged: usd(40) }, 7n), shown: null });
    assert.equal(none.state, "waiting");
    assert.deepEqual(none.rows, []);
    assert.equal(none.total, null);
    assert.equal(none.note, "Reading this campaign's backers. The contract counts 1 backer and 40.00 USDC pledged.");
    // A list for another campaign lags one read behind the route: treated as not listed.
    const stale = table({ campaign: campaign({}, { backers: 2, pledged: usd(150) }, 7n), shown: shown(6n, [row(A1, backer())]) });
    assert.equal(stale.state, "waiting");
    assert.deepEqual(stale.rows, []);
    assert.equal(stale.note, "Reading this campaign's backers. The contract counts 2 backers and 150.00 USDC pledged.");
    // Read, and the keeper's ledger has no backers for it: that is the keeper's, and is said so.
    const unlisted = table({ campaign: campaign({}, { backers: 2, pledged: usd(150) }, 7n), shown: { id: 7n, rows: [], listed: 0 } });
    assert.equal(unlisted.state, "waiting");
    assert.equal(unlisted.note, "The keeper has not listed this campaign's backers yet. The contract counts 2 backers and 150.00 USDC pledged.");
  });

  it("backers.rows: an open campaign with an early and a late backer", function () {
    const c = campaign({}, { outcome: Outcome.Open, backers: 2, pledged: usd(150) }, 7n);
    const rows = [
      row(A1, backer({ principal: usd(100), weighted: usd(100) }), { principal: 0n, bonus: 0n }, { principal: usd(100), bonus: usd(1.58) }),
      row(A2, backer({ principal: usd(50), weighted: 0n }), { principal: 0n, bonus: 0n }, { principal: usd(50), bonus: 0n }),
    ];
    const t = table({ campaign: c, shown: shown(7n, rows) });
    assert.equal(t.state, "listed");
    assert.deepEqual(t.rows[0], {
      key: "0x00000000000000000000000000000000000000a1",
      href: "#/mine/0x00000000000000000000000000000000000000a1",
      account: "0x0000…00a1",
      pledged: "100.00",
      when: "Early",
      back: "100.00 plus about 1.58 if it misses",
      kind: "counted",
    });
    assert.deepEqual(t.rows[1], {
      key: "0x00000000000000000000000000000000000000a2",
      href: "#/mine/0x00000000000000000000000000000000000000a2",
      account: "0x0000…00a2",
      pledged: "50.00",
      when: "Late",
      back: "50.00 if it misses",
      kind: "counted",
    });
    assert.deepEqual(t.total, { label: "2 backers, by the contract at block 99", pledged: "150.00 USDC" });
    assert.equal(t.note, null);
  });

  it("backers.missed: one unpaid and owed, one paid and returned with its bonus share", function () {
    // s.weighted 300, bonusPaid 60; the paid backer's weight 100 → its share is 60 * 100 / 300 = 20.
    const c = campaign({}, { outcome: Outcome.Missed, backers: 2, pledged: usd(224), weighted: usd(300), bonusPaid: usd(60) }, 7n);
    const rows = [
      row(A1, backer({ principal: usd(124), weighted: usd(124), paid: false }), { principal: usd(124), bonus: usd(6.2) }),
      row(A2, backer({ principal: usd(100), weighted: usd(100), paid: true })),
    ];
    const t = table({ campaign: c, shown: shown(7n, rows) });
    assert.equal(t.rows[0].kind, "owed");
    assert.equal(t.rows[0].back, "130.20 owed");
    assert.equal(t.rows[1].kind, "returned");
    assert.equal(t.rows[1].back, "120.00 came back");
    assert.deepEqual(t.total, { label: "2 backers, by the contract at block 99", pledged: "224.00 USDC" });
    assert.equal(t.note, null);
  });

  it("backers.cleared: given rows, then the sponsor closing the gap, summing to the total", function () {
    const c = campaign({}, { outcome: Outcome.Funded, backers: 2, pledged: usd(2000) }, 7n);
    const rows = [row(A1, backer({ principal: usd(600) })), row(A2, backer({ principal: usd(400) }))];
    const t = table({ campaign: c, shown: shown(7n, rows) });
    assert.equal(t.rows.length, 3);
    assert.equal(t.rows[0].kind, "given");
    assert.equal(t.rows[0].back, "Nothing. The campaign cleared.");
    assert.deepEqual(t.rows[2], {
      key: "sponsor",
      href: null,
      account: "The sponsor, closing the gap",
      pledged: "1,000.00",
      when: "",
      back: "Nothing. The campaign cleared.",
      kind: "sponsor",
    });
    assert.deepEqual(t.total, { label: "2 backers, by the contract at block 99", pledged: "2,000.00 USDC" });
    assert.equal(t.note, null);
    // The backer rows plus the sponsor row equal the contract's total, as the view printed them.
    const cents = (text: string) => Math.round(Number(text.replace(/,/g, "")) * 100);
    assert.equal(t.rows.reduce((sum, r) => sum + cents(r.pledged), 0), cents(t.total!.pledged.replace(" USDC", "")));
  });

  it("backers.short: the keeper lists fewer than the contract counts; no sponsor is invented", function () {
    const c = campaign({}, { outcome: Outcome.Open, backers: 3, pledged: usd(900) }, 7n);
    const rows = [
      row(A1, backer({ principal: usd(300), weighted: usd(300) }), { principal: 0n, bonus: 0n }, { principal: usd(300), bonus: 0n }),
      row(A2, backer({ principal: usd(200), weighted: 0n }), { principal: 0n, bonus: 0n }, { principal: usd(200), bonus: 0n }),
    ];
    const t = table({ campaign: c, shown: shown(7n, rows) });
    assert.equal(t.rows.length, 2);
    assert.equal(t.rows.some((r) => r.kind === "sponsor"), false);
    assert.equal(
      t.note,
      "The keeper lists 2 of the contract's 3 backers, and the rows above add up to 500.00 of the 900.00 USDC pledged. The contract's figures are the true ones.",
    );
  });

  it("backers.extra: a listed address the contract has no pledge for is left out", function () {
    const c = campaign({}, { outcome: Outcome.Open, backers: 1, pledged: usd(100) }, 7n);
    const rows = [
      row(A1, backer({ principal: usd(100), weighted: usd(100) }), { principal: 0n, bonus: 0n }, { principal: usd(100), bonus: 0n }),
      row(A2, backer({ principal: 0n, weighted: 0n })),
    ];
    const t = table({ campaign: c, shown: shown(7n, rows) });
    assert.equal(t.rows.length, 1);
    assert.equal(t.rows[0].key, "0x00000000000000000000000000000000000000a1");
    assert.equal(t.rows.some((r) => r.key === "0x00000000000000000000000000000000000000a2"), false);
    assert.equal(t.note, null);
  });

  it("backers.capped: more listed than rows given, so the first N of M note", function () {
    const c = campaign({}, { outcome: Outcome.Open, backers: 5, pledged: usd(900) }, 7n);
    const rows = [
      row(A1, backer({ principal: usd(300), weighted: usd(300) }), { principal: 0n, bonus: 0n }, { principal: usd(300), bonus: 0n }),
      row(A3, backer({ principal: usd(200), weighted: 0n }), { principal: 0n, bonus: 0n }, { principal: usd(200), bonus: 0n }),
    ];
    const t = table({ campaign: c, shown: shown(7n, rows, 5) });
    assert.equal(t.state, "listed");
    assert.equal(t.rows.length, 2);
    assert.equal(t.rows.some((r) => r.kind === "sponsor"), false);
    assert.notEqual(t.total, null);
    assert.equal(t.note, "The keeper lists 5 backers; the first 2 were read.");
    // One of those read has no pledge on the contract: the note still says what was read, not what is shown.
    const withEmpty = table({ campaign: c, shown: shown(7n, [...rows, row(A2, backer({ principal: 0n, weighted: 0n }))], 5) });
    assert.equal(withEmpty.rows.length, 2);
    assert.equal(withEmpty.note, "The keeper lists 5 backers; the first 3 were read.");
  });

  it("backers.twice: an address the keeper lists twice, in any case, is one row, and no sponsor row is made up from it", function () {
    // The contract has A1 (300) and one more backer (100) the keeper does not list; the keeper lists A1 twice.
    const c = campaign({}, { outcome: Outcome.Open, backers: 2, pledged: usd(400) }, 7n);
    const a1 = row(A1, backer({ principal: usd(300), weighted: usd(300) }), { principal: 0n, bonus: 0n }, { principal: usd(300), bonus: 0n });
    const upper = { ...a1, address: A1.toUpperCase().replace("0X", "0x") as Address };
    const t = table({ campaign: c, shown: shown(7n, [a1, upper]) });
    assert.deepEqual(t.rows.map((r) => r.key), [A1]);
    assert.equal(t.note, "The keeper lists 1 of the contract's 2 backers, and the rows above add up to 300.00 of the 400.00 USDC pledged. The contract's figures are the true ones.");
  });

  it("backers.over: rows that add up to more than the contract's total are said to disagree with it", function () {
    const c = campaign({}, { outcome: Outcome.Open, backers: 1, pledged: usd(100) }, 7n);
    const t = table({ campaign: c, shown: shown(7n, [row(A1, backer({ principal: usd(250), weighted: 0n }), { principal: 0n, bonus: 0n }, { principal: usd(250), bonus: 0n })]) });
    assert.equal(t.rows.some((r) => r.kind === "sponsor"), false);
    assert.equal(t.note, "The keeper lists 1 of the contract's 1 backer, and the rows above add up to 250.00 of the 100.00 USDC pledged. The contract's figures are the true ones.");
  });

  it("backers.unlisted: when none of the addresses the keeper lists has a pledge on the contract, there is no table and nothing speaks of rows", function () {
    const c = campaign({}, { outcome: Outcome.Open, backers: 1, pledged: usd(100) }, 7n);
    const t = table({ campaign: c, shown: shown(7n, [row(A2, backer({ principal: 0n, weighted: 0n }))]) });
    assert.equal(t.state, "waiting");
    assert.deepEqual(t.rows, []);
    assert.equal(t.total, null);
    assert.equal(t.note, "The keeper has not listed this campaign's backers yet. The contract counts 1 backer and 100.00 USDC pledged.");
  });

  it("backers.none: nobody pledged is said even with the keeper down", function () {
    assert.equal(table({ campaign: campaign({}, { backers: 0, pledged: 0n }), shown: null, keeperUp: false }).note, "Nobody has pledged yet.");
  });
});
