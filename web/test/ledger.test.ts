// Every amount, address, name and time in these tests is invented. None is a reading of any real campaign.
//
// The landing page's campaigns table: the order, the stamp for each outcome, the deadline format.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { State, Terms } from "../../packages/kit/src/index.ts";
import { Outcome } from "../../packages/kit/src/index.ts";
import type { CampaignView } from "../src/data/load.ts";
import { homePage } from "../src/views/home.ts";
import { ledgerView } from "../src/views/ledger.ts";

const RECIPIENT = "0x00000000000000000000000000000000000000aa" as const;
const SPONSOR = "0x00000000000000000000000000000000000000b1" as const;
const usd = (n: number) => BigInt(Math.round(n * 1_000_000));
const OPENS = 1_794_000_000n; // 6 Nov 2026, 21:20 UTC
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
const campaign = (id: bigint, t: Partial<Terms> = {}, s: Partial<State> = {}): CampaignView => ({ id, terms: terms(t), state: state(s), outcomeNow: 0 });
const view = (campaigns: CampaignView[], now: bigint) => ledgerView({ campaigns, labels: [], desk: null, now, block: 9n });

describe("the landing ledger", function () {
  it("opens the deadline as a UTC day and time, with no year", function () {
    const open = view([campaign(4n)], OPENS + 3_600n).rows[0];
    assert.equal(open.deadline, "13 Nov, 21:20"); // closesAt is OPENS + 7 days
    assert.equal(view([campaign(4n, { closesAt: OPENS })], OPENS + 3_600n).rows[0].deadline, "6 Nov, 21:20");
  });

  it("a campaign whose opening time has not come says when it opens, not when it closes", function () {
    const row = view([campaign(4n, {}, { backers: 0, pledged: 0n, pledgedEarly: 0n, weighted: 0n })], OPENS - 600n).rows[0];
    assert.deepEqual(row.mark, { kind: "open", word: "Opens soon", small: "opens in 10 min" });
  });

  it("hands on the Home page's running totals", function () {
    const table = view([campaign(4n)], OPENS + 3_600n);
    assert.ok(table.totals.length > 0);
    assert.deepEqual(table.totals, homePage({ campaigns: [campaign(4n)], labels: [], desk: null, now: OPENS + 3_600n, block: 9n }).totals);
  });

  it("an open campaign reads its raised, its backers and how long until it closes", function () {
    const row = view([campaign(4n)], OPENS + 3_600n).rows[0];
    assert.equal(row.href, "#/campaign/4");
    assert.equal(row.name, "Campaign 4");
    assert.equal(row.note, "Early bonus open");
    assert.equal(row.raised, "1,240.00 of 2,000.00");
    assert.equal(row.backers, "31");
    assert.deepEqual(row.mark, { kind: "open", word: "Open", small: "closes in 6 days 23 hours" });
  });

  it("a funded campaign is Cleared, with its pledged total and the sponsor's match", function () {
    const row = view([campaign(2n, {}, { outcome: Outcome.Funded, pledged: usd(2000), backers: 2 })], OPENS + 8n * DAY).rows[0];
    assert.equal(row.raised, "2,000.00 of 2,000.00");
    assert.equal(row.backers, "2");
    assert.deepEqual(row.mark, { kind: "cleared", word: "Cleared", small: "2,000.00 + 500.00 match" });
  });

  it("a missed campaign is Returned, with what came back and the bonus the contract paid", function () {
    const row = view([campaign(3n, {}, { outcome: Outcome.Missed, pledged: usd(1.5), bonusPaid: usd(0.14), backers: 1 })], OPENS + 8n * DAY).rows[0];
    assert.equal(row.raised, "1.50 of 2,000.00");
    assert.equal(row.backers, "1");
    assert.deepEqual(row.mark, { kind: "returned", word: "Returned", small: "1.50 + 0.14 bonus" });
  });

  it("a void campaign says it never opened, in plain text and not in vermilion", function () {
    const row = view([campaign(1n, {}, { outcome: Outcome.Void, backers: 0, pledged: 0n, pledgedEarly: 0n, weighted: 0n, matchIn: false })], OPENS + DAY).rows[0];
    assert.equal(row.raised, "0.00 of 2,000.00");
    assert.equal(row.backers, "0");
    assert.deepEqual(row.mark, { kind: "void", word: "Never opened", small: "no pledge was taken" });
  });

  it("a campaign past its deadline and not yet settled is awaiting settlement, with no stamp", function () {
    const row = view([campaign(5n)], OPENS + 8n * DAY).rows[0];
    assert.deepEqual(row.mark, { kind: "waiting", word: "Awaiting settlement", small: "" });
  });

  it("open campaigns come before settled ones, each newest first", function () {
    const all = [
      campaign(6n), // open
      campaign(5n), // open
      campaign(3n, {}, { outcome: Outcome.Missed, bonusPaid: usd(61.5) }),
      campaign(2n, {}, { outcome: Outcome.Funded, pledged: usd(2000), backers: 40 }),
      campaign(1n, {}, { outcome: Outcome.Void, backers: 0, pledged: 0n, pledgedEarly: 0n, weighted: 0n, matchIn: false }),
    ];
    const table = view(all, OPENS + 3_600n);
    assert.deepEqual(
      table.rows.map((r) => [r.href, r.mark.kind]),
      [
        ["#/campaign/6", "open"],
        ["#/campaign/5", "open"],
        ["#/campaign/3", "returned"],
        ["#/campaign/2", "cleared"],
        ["#/campaign/1", "void"],
      ],
    );
    assert.equal(table.empty, null);
  });

  it("with no campaigns the table is empty and says so", function () {
    const table = view([], OPENS);
    assert.deepEqual(table.rows, []);
    assert.equal(table.empty, "No campaign has been created yet.");
  });
});
