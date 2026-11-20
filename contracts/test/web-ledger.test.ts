// Every amount and account in these tests is invented. None is a reading of any real campaign.
//
// The app's reader of the keeper's ledger (web/src/data/keeper.ts) against the keeper's real
// answer: the ledger a real keeper built from the contract's own logs, written as JSON exactly as
// GET /ledger sends it, read back by the app's code, and compared with the contract.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Outcome, setup, USD } from "./helpers.ts";
import type { RawLog } from "../../packages/kit/src/index.ts";
import { makeSender } from "../../services/keeper/src/chain.ts";
import { createKeeper, type Delivery, type Keeper } from "../../services/keeper/src/keeper.ts";
import { ledgerJson } from "../../services/keeper/src/server.ts";
import { memoryStore } from "../../services/keeper/src/store.ts";
import { backerOf, differences, feedLine, readLedger, short, stateOf } from "../../web/src/data/keeper.ts";
import { askForCampaign, askForUsdc, type Fetch } from "../../web/src/data/ask.ts";
import { readHealth } from "../../web/src/data/health.ts";
import { formatUsd } from "../../web/src/data/money.ts";
import { DEMO, DESK_KINDS } from "../../services/keeper/src/demo.ts";

type W = Awaited<ReturnType<typeof setup>>;

const toHex = (v: bigint | number): `0x${string}` => `0x${BigInt(v).toString(16)}`;

/** One delivery per block that holds a Boomerang log, in the keeper's delivery shape, then a clock tick. */
async function deliveries(w: W): Promise<Delivery[]> {
  const logs = await w.publicClient.getLogs({ address: w.boomerang.address, fromBlock: 0n });
  const blocks = [...new Set(logs.map((lg) => lg.blockNumber!))].sort((a, b) => (a < b ? -1 : 1));
  const out: Delivery[] = [];
  for (const bn of blocks) {
    const block = await w.publicClient.getBlock({ blockNumber: bn });
    const raw: RawLog[] = logs
      .filter((lg) => lg.blockNumber === bn)
      .map((lg) => ({ address: lg.address, topics: lg.topics, data: lg.data, blockNumber: toHex(bn), blockTimestamp: toHex(block.timestamp), transactionHash: lg.transactionHash, logIndex: lg.logIndex ?? 0 }));
    out.push({ v: 1, fromBlock: Number(bn), toBlock: Number(bn), time: Number(block.timestamp), logs: raw, opened: [], due: [] });
  }
  const latest = await w.publicClient.getBlock();
  out.push({ v: 1, fromBlock: Number(latest.number), toBlock: Number(latest.number), time: Number(latest.timestamp), logs: [], opened: [], due: [] });
  return out;
}

async function pump(w: W, keeper: Keeper, rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const list = await deliveries(w);
    for (const d of list.slice(0, -1)) keeper.deliver(d);
    await keeper.deliver(list[list.length - 1]).done;
  }
}

/** What the app gets over HTTP: the keeper's answer as JSON text, parsed again. */
const overTheWire = (keeper: Keeper): unknown => JSON.parse(JSON.stringify(ledgerJson(keeper)));

/**
 * A funded campaign and a missed one, settled by a real keeper, with one backer who pointed her
 * refund elsewhere and one whose refund failed and is still owed.
 */
async function world() {
  const w = await setup();
  const keeper = createKeeper({
    boomerang: w.boomerang.address,
    store: memoryStore(),
    send: makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address }),
  });

  const funded = await w.open();
  await w.time.increaseTo(funded.t.opensAt);
  await w.pledge(funded.id, w.alice, 60n * USD, funded.t.opensAt + 10n);
  await w.pledge(funded.id, w.bob, 40n * USD, funded.t.opensAt + 20n);

  const missed = await w.open();
  await w.time.increaseTo(missed.t.opensAt);
  await w.pledge(missed.id, w.bob, 30n * USD, missed.t.opensAt + 10n);
  await w.pledge(missed.id, w.carol, 20n * USD, missed.t.opensAt + 20n);
  await w.pledge(missed.id, w.dave, 10n * USD, missed.t.earlyUntil + 5n);
  await w.boomerang.write.redirect([missed.id, w.erin.account.address], { account: w.carol.account });
  await w.usdc.write.setBlocked([w.dave.account.address, true]);
  await w.time.increaseTo(missed.t.closesAt);

  await pump(w, keeper, 6);
  return { w, keeper, funded, missed };
}

describe("the app's reader of the keeper's ledger", function () {
  it("web.ledger: what GET /ledger sends reads back equal to the contract, campaign by campaign and backer by backer", async function () {
    const { w, keeper, funded, missed } = await world();
    const view = readLedger(overTheWire(keeper));

    assert.equal(view.missing, null);
    assert.equal(view.lastSeq, await w.boomerang.read.eventCount());
    assert.equal(view.totalOwed, await w.boomerang.read.totalOwed());
    assert.deepEqual(view.campaigns.map((c) => c.id), [funded.id, missed.id]);

    let backers = 0;
    for (const c of view.campaigns) {
      const terms = await w.boomerang.read.termsOf([c.id]);
      const state = await w.boomerang.read.stateOf([c.id]);
      assert.deepEqual(differences(c, { terms, state }), [], `campaign ${c.id}`);
      assert.equal(stateOf(c).backers, Number(state.backers));
      for (const b of c.backers) {
        const mine = backerOf(b);
        const chain = await w.boomerang.read.backerOf([c.id, b.address]);
        assert.equal(mine.principal, chain.principal);
        assert.equal(mine.weighted, chain.weighted);
        assert.equal(mine.paid, chain.paid);
        assert.equal(mine.payTo.toLowerCase(), chain.payTo.toLowerCase());
        backers += 1;
      }
    }
    assert.equal(backers, 5);

    // The outcomes the test set up are the ones read back.
    const [f, m] = view.campaigns;
    assert.equal(f.outcome, Outcome.Funded);
    assert.equal(m.outcome, Outcome.Missed);
    assert.equal(m.expectedBonusPaid, m.bonusPaid);
    const carol = m.backers.find((b) => b.address.toLowerCase() === w.carol.account.address.toLowerCase())!;
    assert.equal(carol.payTo!.toLowerCase(), w.erin.account.address.toLowerCase());
    assert.equal(carol.paid, true);
    const dave = m.backers.find((b) => b.address.toLowerCase() === w.dave.account.address.toLowerCase())!;
    assert.equal(dave.paid, false); // his refund was refused by the token and is still owed
    assert.ok(m.payFailures >= 1);
    assert.equal(view.totalOwed, 10n * USD);
  });

  it("web.differences: a figure changed on the way is named, with both values", async function () {
    const { w, keeper, missed } = await world();
    const json = overTheWire(keeper) as { campaigns: { id: string; pledged: string; terms: { target: string } }[] };
    const raw = json.campaigns.find((c) => c.id === missed.id.toString())!;
    raw.pledged = (BigInt(raw.pledged) + 1n).toString();
    raw.terms.target = (BigInt(raw.terms.target) - 1n).toString();
    const c = readLedger(json).campaigns.find((x) => x.id === missed.id)!;
    const terms = await w.boomerang.read.termsOf([missed.id]);
    const state = await w.boomerang.read.stateOf([missed.id]);
    assert.deepEqual(differences(c, { terms, state }), [
      `pledged: ledger ${state.pledged + 1n}, contract ${state.pledged}`,
      `terms.target: ledger ${terms.target - 1n}, contract ${terms.target}`,
    ]);
  });

  it("web.feed: every event the keeper passes on becomes a sentence, in order", async function () {
    const { w, keeper } = await world();
    const view = readLedger(overTheWire(keeper));
    assert.equal(BigInt(view.feed.length), view.lastSeq);
    assert.deepEqual(view.feed.map((e) => e.seq), view.feed.map((_, i) => BigInt(i + 1)));

    const names = new Set(view.feed.map((e) => e.name));
    for (const name of ["CampaignCreated", "PotFunded", "Pledged", "Finalized", "Paid", "PayFailed", "SidePaid", "Redirected"]) {
      assert.ok(names.has(name), `the world has no ${name} event`);
    }
    for (const e of view.feed) {
      const line = feedLine(e);
      assert.notEqual(line, e.name, `${e.name} has no sentence`);
      assert.ok(!/undefined|NaN|\[object/.test(line), line);
      assert.ok(e.time !== null && e.time > 0n);
      assert.match(String(e.txHash), /^0x[0-9a-f]{64}$/);
    }

    const lines = view.feed.map(feedLine);
    const bob = short(w.bob.account.address);
    const carol = short(w.carol.account.address);
    const erin = short(w.erin.account.address);
    const dave = short(w.dave.account.address);
    const has = (line: string) => assert.ok(lines.some((l) => l.toLowerCase() === line.toLowerCase()), `no line "${line}" in:\n${lines.join("\n")}`);
    has("Match of 20.00 locked");
    has("Bonus pool of 10.00 locked");
    has(`${bob} pledged 30.00, early`);
    has(`${dave} pledged 10.00`);
    has(`${carol} pointed their refund at ${erin}`);
    has("Funded");
    has(`A refund to ${dave} did not go through. It stays owed`);
    assert.ok(lines.some((l) => l.startsWith("Missed. Bonus for early backers: ")));
    assert.ok(lines.some((l) => l.toLowerCase().startsWith(`${carol.toLowerCase()} got 20.00 back plus `)));
  });

  it("web.strict: a ledger with a field missing or of the wrong kind is refused, and the message says where", async function () {
    const { keeper } = await world();
    const good = JSON.stringify(overTheWire(keeper));
    const broken = (edit: (j: any) => void): unknown => {
      const j = JSON.parse(good);
      edit(j);
      return j;
    };
    assert.throws(() => readLedger(broken((j) => delete j.campaigns[0].pledged)), /campaigns\[0\]\.pledged/);
    assert.throws(() => readLedger(broken((j) => (j.campaigns[1].pledged = 30))), /campaigns\[1\]\.pledged/);
    assert.throws(() => readLedger(broken((j) => (j.campaigns[0].terms.rateBps = "500"))), /campaigns\[0\]\.terms\.rateBps/);
    assert.throws(() => readLedger(broken((j) => (j.campaigns[1].backers[0].address = "0x12"))), /campaigns\[1\]\.backers\[0\]\.address/);
    assert.throws(() => readLedger(broken((j) => (j.lastSeq = "-1"))), /lastSeq/);
    assert.throws(() => readLedger(broken((j) => (j.feed = {}))), /feed/);
    assert.throws(() => readLedger(null), /ledger/);
    assert.doesNotThrow(() => readLedger(JSON.parse(good)));
  });
  it("web.health: what GET /health sends reads back, and the page's words about the desk are the desk's own amounts", async function () {
    const { w, keeper } = await world();
    // The server answers with the keeper's health plus the desk's address, as JSON.
    const sent = JSON.parse(JSON.stringify({ ...keeper.health(), desk: w.erin.account.address }));
    const h = readHealth(sent);
    assert.equal(h.lastSeq, await w.boomerang.read.eventCount());
    assert.equal(h.missing, null);
    assert.equal(h.desk, w.erin.account.address);
    assert.deepEqual(h.gaveUp, []);
    assert.equal(typeof h.settled, "boolean");
    assert.doesNotThrow(() => readHealth(JSON.parse(JSON.stringify({ ...keeper.health(), desk: null }))));

    // The page says what the desk gives and how long its campaign runs; both are the desk's constants.
    const answer = (body: unknown): Fetch => async () => ({ status: 200, json: async () => body });
    const gave = await askForUsdc({ url: "https://keeper.example", fetch: answer({ ok: true }), address: w.alice.account.address });
    assert.equal(gave.line, `The desk sent ${formatUsd(DEMO.usdc)} USDC to your address.`);
    const opened = await askForCampaign({ url: "https://keeper.example", fetch: answer({ ok: true, id: "3" }), kind: "ten" });
    assert.equal(DEMO.opensIn, 60n);
    assert.equal(DEMO.opensIn + DEMO.openFor, 660n);
    assert.match(opened.line, /about a minute and settles in about eleven/);
    const quick = await askForCampaign({ url: "https://keeper.example", fetch: answer({ ok: true, id: "4" }), kind: "two" });
    assert.ok(DESK_KINDS.two.opensIn < 60n);
    assert.equal(DESK_KINDS.two.opensIn + DESK_KINDS.two.openFor, 165n); // closes 2:45 after the press; settled about 3:30 after it
    assert.match(quick.line, /under a minute and settles in about three and a half minutes/);
  });
});
