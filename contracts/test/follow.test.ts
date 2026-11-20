// Every amount and account in these tests is invented. None is a reading of any real campaign.
//
// The keeper's one source of events: its follower (services/keeper/src/follow.ts) reads the
// node's own JSON-RPC, as it would Arc's, and hands the keeper what it finds. Nothing is built by
// hand in between: the contract's real logs, the real follower, the real keeper and its real
// sender. The only thing stood in is time: the follower's clock is a number the test moves.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Outcome, setup, USD } from "./helpers.ts";
import type { RawLog } from "../../packages/kit/src/index.ts";
import { makeSender } from "../../services/keeper/src/chain.ts";
import { createFollower, nodeFrom } from "../../services/keeper/src/follow.ts";
import { createKeeper, type Delivery, type Sender } from "../../services/keeper/src/keeper.ts";
import { memoryStore } from "../../services/keeper/src/store.ts";

type W = Awaited<ReturnType<typeof setup>>;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toHex = (v: bigint | number): `0x${string}` => `0x${BigInt(v).toString(16)}`;

/** The contract, the keeper with its real sender, and a follower on the node's own JSON-RPC. */
function rig(w: W) {
  let inFlight = 0;
  const calls: string[] = [];
  const direct = makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address });
  const send: Sender = async (action) => {
    inFlight += 1;
    calls.push(action.kind === "payMany" ? `payMany:${action.id}` : action.kind === "paySide" ? `paySide:${action.id}:${action.side}` : `finalize:${action.id}`);
    try {
      return await direct(action);
    } finally {
      inFlight -= 1;
    }
  };
  const clock = { now: 50_000_000 };
  const keeper = createKeeper({ boomerang: w.boomerang.address, store: memoryStore(), send, clock: () => clock.now });
  const rpc = (args: { method: string; params?: unknown[] }) => w.publicClient.request(args as never) as Promise<unknown>;
  const follower = createFollower({ keeper, node: nodeFrom(rpc, w.boomerang.address), startBlock: 0n, healAfterMs: 60_000, clock: () => clock.now });

  async function quiet(): Promise<void> {
    for (let still = 0; still < 4; ) {
      await pause(5);
      still = inFlight === 0 ? still + 1 : 0;
    }
  }

  /** Tick the follower until the chain stops growing (the keeper's own calls make blocks). */
  async function run(): Promise<void> {
    for (let round = 0; round < 60; round++) {
      const before = await w.publicClient.getBlockNumber();
      await follower.tick();
      await quiet();
      if ((await w.publicClient.getBlockNumber()) === before && round > 0) return;
    }
    assert.fail("the chain kept growing: the keeper did not come to rest");
  }

  return { keeper, follower, run, calls, clock, quiet };
}

/** One delivery per block that holds a Boomerang log, in block order. */
async function blockDeliveries(w: W): Promise<Delivery[]> {
  const logs = await w.publicClient.getLogs({ address: w.boomerang.address, fromBlock: 0n });
  const byBlock = new Map<bigint, RawLog[]>();
  const times = new Map<bigint, bigint>();
  for (const lg of logs) {
    const bn = lg.blockNumber!;
    if (!times.has(bn)) times.set(bn, (await w.publicClient.getBlock({ blockNumber: bn })).timestamp);
    const list = byBlock.get(bn) ?? [];
    list.push({ address: lg.address, topics: lg.topics, data: lg.data, blockNumber: toHex(bn), blockTimestamp: toHex(times.get(bn)!), transactionHash: lg.transactionHash, logIndex: lg.logIndex ?? 0 });
    byBlock.set(bn, list);
  }
  return [...byBlock.keys()]
    .sort((a, b) => (a < b ? -1 : 1))
    .map((bn) => ({ fromBlock: Number(bn), toBlock: Number(bn), time: Number(times.get(bn)!), logs: byBlock.get(bn)! }));
}

describe("contract -> node -> the keeper's follower -> keeper -> contract", function () {
  it("follow.settles: a funded, a missed and a void campaign are settled from the follower's reading of the node alone, and the keeper's ledger equals the contract", async function () {
    const w = await setup();
    const r = rig(w);

    const funded = await w.open();
    await w.time.increaseTo(funded.t.opensAt);
    await w.pledge(funded.id, w.alice, 60n * USD, funded.t.opensAt + 10n);
    await w.pledge(funded.id, w.bob, 40n * USD, funded.t.opensAt + 20n);
    await r.run();
    assert.equal((await w.boomerang.read.stateOf([funded.id])).recipientPaid, true);
    assert.equal((await w.boomerang.read.stateOf([funded.id])).bonusReturned, true);

    const empty = await w.open({}, { skipBonus: true });
    await r.run();
    assert.equal((await w.boomerang.read.stateOf([empty.id])).outcome, Outcome.Open);
    await w.time.increaseTo(empty.t.opensAt);
    await r.run();
    assert.equal((await w.boomerang.read.stateOf([empty.id])).outcome, Outcome.Void);
    assert.equal((await w.boomerang.read.stateOf([empty.id])).matchReturned, true);

    const missed = await w.open();
    await w.time.increaseTo(missed.t.opensAt);
    await w.pledge(missed.id, w.bob, 30n * USD, missed.t.opensAt + 10n);
    await w.pledge(missed.id, w.carol, 20n * USD, missed.t.opensAt + 20n);
    await w.pledge(missed.id, w.dave, 10n * USD, missed.t.earlyUntil + 5n);
    await r.run();
    assert.equal((await w.boomerang.read.stateOf([missed.id])).outcome, Outcome.Open);
    assert.ok(!r.calls.includes(`finalize:${missed.id}`), "nothing is finalized before its deadline");
    await w.time.increaseTo(missed.t.closesAt);
    await r.run();

    const s = await w.boomerang.read.stateOf([missed.id]);
    assert.equal(s.outcome, Outcome.Missed);
    assert.equal(s.matchReturned, true);
    assert.equal(s.bonusReturned, true);
    for (const who of [w.bob, w.carol, w.dave]) {
      assert.equal((await w.boomerang.read.backerOf([missed.id, who.account.address])).paid, true);
    }
    assert.ok((await w.boomerang.read.totalOwed()) < 3n, `left owed: ${await w.boomerang.read.totalOwed()}`);
    await w.assertCustody();

    // The keeper's ledger, built from nothing but what its follower read, equals the contract.
    const h = r.keeper.health();
    assert.equal(h.missing, null);
    assert.equal(BigInt(h.lastSeq), await w.boomerang.read.eventCount());
    assert.equal(r.keeper.ledger.totalOwed, await w.boomerang.read.totalOwed());
    assert.equal(h.settled, true);
    assert.equal(h.failedSends, 0);
    for (const id of [funded.id, empty.id, missed.id]) {
      const c = r.keeper.ledger.campaigns.get(id)!;
      const chain = await w.boomerang.read.stateOf([id]);
      assert.equal(c.outcome, chain.outcome);
      assert.equal(c.pledged, chain.pledged);
      assert.equal(c.bonusPaid, chain.bonusPaid);
    }
    // Every event carries its block's time.
    assert.ok(r.keeper.feed(500).every((e) => e.time !== undefined && e.time > 0n && e.blockNumber !== undefined));

    assert.equal(h.lastBlock, Number(await w.publicClient.getBlockNumber()));
    const f = r.follower.state();
    assert.equal(f.faults, 0);
    assert.ok(f.reads > 0);

    assert.equal(r.calls.filter((c) => c === `finalize:${missed.id}`).length, 1);
    assert.equal(r.calls.filter((c) => c === `finalize:${empty.id}`).length, 1);
    assert.equal(r.calls.filter((c) => c === `finalize:${funded.id}`).length, 0);
  });

  it("follow.heals: a missing event number leaves a hole the follower fills from the node a minute on", async function () {
    const w = await setup();
    const r = rig(w);

    const c = await w.open();
    await w.time.increaseTo(c.t.opensAt);
    await w.pledge(c.id, w.bob, 30n * USD, c.t.opensAt + 10n);
    await w.pledge(c.id, w.carol, 20n * USD, c.t.opensAt + 20n);
    const all = await blockDeliveries(w);
    assert.ok(all.length >= 3);
    // Every delivery but one in the middle, handed to the keeper directly as the follower would.
    const lost = all.length - 2;
    for (const [i, d] of all.entries()) if (i !== lost) r.keeper.deliver(d);
    await r.quiet();
    assert.notEqual(r.keeper.health().missing, null);

    await r.follower.tick();
    await r.quiet();
    assert.notEqual(r.keeper.health().missing, null, "a hole just seen is given a minute");

    r.clock.now += 60_000;
    await r.follower.tick();
    await r.quiet();

    const h = r.keeper.health();
    assert.equal(h.missing, null);
    assert.equal(h.pending, 0);
    assert.equal(BigInt(h.lastSeq), await w.boomerang.read.eventCount());
    const led = r.keeper.ledger.campaigns.get(c.id)!;
    assert.equal(led.pledged, (await w.boomerang.read.stateOf([c.id])).pledged);
  });
});
