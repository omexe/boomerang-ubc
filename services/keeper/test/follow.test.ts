// Every address, block, time and log in these tests is invented. None is a reading of any chain.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createFollower, nodeFrom, type Node } from "../src/follow.ts";
import { type Delivery, type Health, type Keeper } from "../src/keeper.ts";
import type { Address, RawLog } from "../../../packages/kit/src/index.ts";

const BOOMERANG = "0xB00000000000000000000000000000000000000B" as Address;
// What a node's own error might say. It must never be kept or shown: an RPC address can carry a key.
const NODE_WORDS = "https://rpc.invented.example/v1/SECRET-KEY-INVENTED refused the request";

const health: Health = {
  lastSeq: "0",
  missing: null,
  pending: 0,
  repeats: 0,
  lastBlock: 0,
  lastTime: "0",
  sent: 0,
  failedSends: 0,
  rejected: 0,
  gaveUp: [],
  absent: [],
  lastErrors: [],
  settled: true,
};

const log = (block: number): RawLog => ({ address: BOOMERANG, topics: [`0x${String(block).padStart(64, "0")}`], data: "0x", blockNumber: block, blockTimestamp: 1000 + block });

function rig(o: { startBlock?: bigint; span?: bigint } = {}) {
  const s = {
    now: 10_000_000,
    h: { ...health },
    head: { number: 100n, time: 5_000n },
    /** Blocks that hold one log each. */
    logBlocks: [] as number[],
    headFails: false,
    /** Fail the logs call with this number (1 is the first ever made). */
    logsFailOn: null as number | null,
    storeFails: false,
    headWait: null as Promise<void> | null,
  };
  const taken: { d: Delivery }[] = [];
  const asked: [bigint, bigint][] = [];
  let heads = 0;
  const keeper: Pick<Keeper, "deliver" | "health"> = {
    health: () => ({ ...s.h }),
    deliver(d) {
      if (s.storeFails) throw new Error("the store cannot be written");
      taken.push({ d });
      if (d.toBlock > s.h.lastBlock) s.h.lastBlock = d.toBlock;
      return { applied: d.logs.length, repeats: 0, done: Promise.resolve([]) };
    },
  };
  const node: Node = {
    async head() {
      heads += 1;
      if (s.headWait) await s.headWait;
      if (s.headFails) throw new Error(NODE_WORDS);
      return s.head;
    },
    async logs(from, to) {
      asked.push([from, to]);
      if (s.logsFailOn !== null && asked.length === s.logsFailOn) throw new Error(NODE_WORDS);
      return s.logBlocks.filter((b) => BigInt(b) >= from && BigInt(b) <= to).map(log);
    },
  };
  const follower = createFollower({
    keeper,
    node,
    startBlock: o.startBlock ?? 0n,
    healAfterMs: 60_000,
    span: o.span ?? 5_000n,
    clock: () => s.now,
  });
  return { s, taken, asked, follower, heads: () => heads };
}

describe("the follower: the keeper's reading of the node", () => {
  it("follow.first: a new follower reads on its very first tick, from the block after the last one the keeper's store heard", async () => {
    const r = rig();
    r.s.h.lastBlock = 90;
    await r.follower.tick();
    assert.deepEqual(r.asked, [[91n, 100n]]);
    assert.equal(r.taken.length, 1);
    assert.equal(r.taken[0].d.fromBlock, 91);
  });

  it("follow.stateShape: state() has exactly the keys reads, lastReadAt, readTo, faults", async () => {
    const r = rig();
    assert.deepEqual(Object.keys(r.follower.state()).sort(), ["faults", "lastReadAt", "readTo", "reads"]);
  });

  it("follow.reads: it reads from the block after the last one heard and hands over one delivery of just that run's logs", async () => {
    const r = rig();
    r.s.h.lastBlock = 90;
    r.s.logBlocks = [85, 93, 97, 104];
    await r.follower.tick();

    assert.deepEqual(r.asked, [[91n, 100n]]);
    assert.equal(r.taken.length, 1);
    assert.deepEqual(r.taken[0].d, { fromBlock: 91, toBlock: 100, time: 5000, logs: [log(93), log(97)] });
    assert.deepEqual(r.follower.state(), { reads: 1, lastReadAt: 10_000_000, readTo: 100, faults: 0 });
  });

  it("follow.keepsPlace: the next read starts where the last one ended; with no new block it still hands the keeper the time", async () => {
    const r = rig();
    r.s.h.lastBlock = 90;
    await r.follower.tick();
    r.s.head = { number: 110n, time: 5_005n };
    r.s.now += 5_000;
    await r.follower.tick();
    assert.deepEqual(r.asked, [[91n, 100n], [101n, 110n]]);

    // No new block: nothing to ask for, but the keeper still gets a delivery, so calls it put off are tried again.
    r.s.now += 5_000;
    await r.follower.tick();
    assert.equal(r.asked.length, 2);
    assert.equal(r.taken.length, 3);
    assert.deepEqual(r.taken[2].d, { fromBlock: 110, toBlock: 110, time: 5005, logs: [] });
    assert.equal(r.follower.state().reads, 3);

    // A node behind the keeper: the place is kept, nothing goes backwards.
    r.s.head = { number: 105n, time: 5_002n };
    await r.follower.tick();
    assert.equal(r.asked.length, 2);
    r.s.head = { number: 112n, time: 5_006n };
    await r.follower.tick();
    assert.deepEqual(r.asked[2], [111n, 112n]);
  });

  it("follow.spans: a long way behind, the logs are asked for a span at a time, two calls a read, never below the contract's first block; the clock moves only when the newest block is reached", async () => {
    const r = rig({ startBlock: 1_000n, span: 5_000n });
    r.s.head = { number: 12_500n, time: 9_000n };
    r.s.logBlocks = [500, 1_000, 5_999, 6_000, 12_500];
    await r.follower.tick();
    assert.deepEqual(r.asked, [
      [1_000n, 5_999n],
      [6_000n, 10_999n],
    ]);
    assert.equal(r.taken.length, 1);
    // Part of a catch-up: it carries the time of the newest log in it, never the newest block's.
    assert.deepEqual(r.taken[0].d, { fromBlock: 1_000, toBlock: 10_999, time: 7_000, logs: [log(1_000), log(5_999), log(6_000)] });
    assert.equal(r.follower.state().readTo, 10_999);

    await r.follower.tick();
    assert.deepEqual(r.asked.slice(2), [[11_000n, 12_500n]]);
    assert.deepEqual(r.taken[1].d, { fromBlock: 11_000, toBlock: 12_500, time: 9_000, logs: [log(12_500)] });

    // A part with no log in it moves the block and leaves the clock alone.
    const quietPart = rig({ span: 10n });
    quietPart.s.h.lastBlock = 50;
    await quietPart.follower.tick();
    assert.deepEqual(quietPart.taken[0].d, { fromBlock: 51, toBlock: 70, time: 0, logs: [] });
  });

  it("follow.spanLimit: a read never asks for more blocks in one call than the span", async () => {
    const r = rig({ span: 10_000n });
    r.s.h.lastBlock = 99;
    r.s.head = { number: 50_000n, time: 9_000n };
    await r.follower.tick();
    assert.deepEqual(r.asked, [
      [100n, 10_099n],
      [10_100n, 20_099n],
    ]);
    assert.ok(r.asked.every(([a, b]) => b - a + 1n <= 10_000n));
  });

  it("follow.nodeFails: a node that fails part-way delivers nothing, keeps its place, and is counted without its words", async () => {
    const r = rig({ span: 10n });
    r.s.h.lastBlock = 70;
    r.s.logBlocks = [75, 95];
    r.s.logsFailOn = 2;
    await r.follower.tick();
    assert.deepEqual(r.asked, [[71n, 80n], [81n, 90n]]);
    assert.equal(r.taken.length, 0);
    assert.deepEqual(r.follower.state(), { reads: 0, lastReadAt: null, readTo: null, faults: 1 });

    r.s.headFails = true;
    await r.follower.tick();
    assert.equal(r.follower.state().faults, 2);
    assert.equal(r.taken.length, 0);
    assert.ok(!JSON.stringify(r.follower.state()).includes("SECRET"), "a node's words are never kept");

    // The next tick starts again from the same place and gets through; the one after finishes.
    r.s.headFails = false;
    await r.follower.tick();
    assert.deepEqual(r.asked.slice(2), [[71n, 80n], [81n, 90n]]);
    assert.equal(r.taken.length, 1);
    assert.deepEqual(r.taken[0].d.logs, [log(75)]);
    await r.follower.tick();
    assert.deepEqual(r.asked.slice(4), [[91n, 100n]]);
    assert.deepEqual(r.taken[1].d.logs, [log(95)]);
    assert.equal(r.follower.state().reads, 2);
  });

  it("follow.storeFails: a delivery the keeper could not keep is read again", async () => {
    const r = rig();
    r.s.h.lastBlock = 90;
    r.s.storeFails = true;
    await r.follower.tick();
    assert.equal(r.follower.state().faults, 1);
    assert.equal(r.follower.state().reads, 0);
    r.s.storeFails = false;
    await r.follower.tick();
    assert.deepEqual(r.asked, [[91n, 100n], [91n, 100n]]);
    assert.equal(r.taken.length, 1);
  });

  it("follow.heals: an event number missing for a minute is looked for from the contract's first block, once for that gap", async () => {
    // The node sits at its head and the keeper has heard it, so the reading of new blocks asks the
    // node nothing each tick; `asked` then holds only the reads made for the hole.
    const r = rig({ startBlock: 40n });
    r.s.h.lastBlock = 100;
    r.s.head = { number: 100n, time: 5_000n };
    r.s.h.missing = { from: "7", to: "9" };
    await r.follower.tick();
    assert.deepEqual(r.asked, [], "a gap just seen may only be events still arriving out of order");

    r.s.now += 59_999;
    await r.follower.tick();
    assert.deepEqual(r.asked, []);

    r.s.now += 1;
    await r.follower.tick();
    assert.deepEqual(r.asked, [[40n, 100n]]);

    // The same gap is not read for again.
    r.s.now += 120_000;
    await r.follower.tick();
    assert.equal(r.asked.length, 1);

    // Another gap is.
    r.s.h.missing = { from: "12", to: "12" };
    await r.follower.tick();
    r.s.now += 60_000;
    await r.follower.tick();
    assert.deepEqual(r.asked[1], [40n, 100n]);

    // A gap that closes and opens again at the same number is a new gap.
    r.s.h.missing = null;
    await r.follower.tick();
    r.s.h.missing = { from: "12", to: "12" };
    await r.follower.tick();
    r.s.now += 60_000;
    await r.follower.tick();
    assert.equal(r.asked.length, 3);
  });

  it("follow.heals.quiet: the read for a gap starts from the contract's first block and the place moves on from the newest", async () => {
    const r = rig({ startBlock: 40n });
    r.s.h.lastBlock = 90;
    r.s.h.missing = { from: "3", to: "3" };
    await r.follower.tick();
    assert.deepEqual(r.asked, [[91n, 100n]]);
    r.s.now += 60_000;
    r.s.head = { number: 104n, time: 5_002n };
    await r.follower.tick();
    // The new blocks first, as on any tick; then the read for the hole, as a delivery of its own.
    assert.deepEqual(r.asked.slice(1), [[101n, 104n], [40n, 104n]]);
    assert.equal(r.taken.length, 3);
    r.s.head = { number: 106n, time: 5_003n };
    await r.follower.tick();
    assert.deepEqual(r.asked[3], [105n, 106n]);
  });

  it("follow.heals.fails: the read for a hole goes one call a tick and keeps its place; a call that fails does not stop the new blocks being read, and is tried again later from where it was", async () => {
    const r = rig({ startBlock: 40n, span: 30n });
    r.s.h.lastBlock = 90;
    r.s.h.missing = { from: "3", to: "3" };
    await r.follower.tick(); // call 1: [91,100]
    r.s.now += 60_000;
    r.s.head = { number: 104n, time: 5_002n };
    r.s.logsFailOn = 3; // call 2 is the new blocks, call 3 the first of the read for the hole
    await r.follower.tick();
    assert.deepEqual(r.asked.slice(1), [[101n, 104n], [40n, 69n]]);
    assert.equal(r.taken.length, 2, "the new blocks were handed over; the failed read for the hole was not");
    assert.deepEqual([r.follower.state().reads, r.follower.state().faults], [2, 1]);

    // New blocks go on being read on every tick; the hole is left alone for two minutes this time.
    r.s.head = { number: 108n, time: 5_004n };
    r.s.now += 119_999;
    await r.follower.tick();
    assert.deepEqual(r.asked.slice(3), [[105n, 108n]]);
    r.s.now += 1;
    r.s.head = { number: 110n, time: 5_005n };
    await r.follower.tick();
    assert.deepEqual(r.asked.slice(4), [[109n, 110n], [40n, 69n]]);
    // Then one call a tick, from where it was, with no more waiting.
    await r.follower.tick();
    await r.follower.tick();
    assert.deepEqual(r.asked.slice(6), [[70n, 99n], [100n, 110n]]);
    assert.equal(r.follower.state().faults, 1);
    // A part of that read never moves the keeper's clock: it carries only its newest log's time.
    assert.ok(r.taken.filter((t) => t.d.fromBlock === 40 || t.d.fromBlock === 70).every((t) => t.d.time === 0));

    // Read for once, the same hole is not read for again.
    r.s.now += 600_000;
    r.s.head = { number: 111n, time: 5_006n };
    await r.follower.tick();
    assert.deepEqual(r.asked.slice(8), [[111n, 111n]]);
  });

  it("follow.heals.moves: a hole that the read itself is filling keeps the read's place; it does not start again each time the hole's first number moves", async () => {
    const r = rig({ startBlock: 40n, span: 30n });
    // The node sits at its head and the keeper has heard it, so only the hole is read.
    r.s.h.lastBlock = 130;
    r.s.head = { number: 130n, time: 5_000n };
    r.s.h.missing = { from: "5", to: "9" };
    await r.follower.tick();
    r.s.now += 60_000;
    await r.follower.tick(); // [40,69]
    // That part held event 5: the hole now starts at 6.
    r.s.h.missing = { from: "6", to: "9" };
    await r.follower.tick(); // [70,99], at once and from where it was
    r.s.h.missing = { from: "8", to: "9" };
    await r.follower.tick(); // [100,129]
    await r.follower.tick(); // [130,130]
    assert.deepEqual(r.asked, [
      [40n, 69n],
      [70n, 99n],
      [100n, 129n],
      [130n, 130n],
    ]);
    // The read is done and the hole is still there (this node did not have those events).
    // It is not read for again at once, but it is not given up for good: after 64 times the wait.
    r.s.now += 64 * 60_000 - 1;
    await r.follower.tick();
    assert.equal(r.asked.length, 4);
    r.s.now += 1;
    await r.follower.tick();
    assert.deepEqual(r.asked[4], [40n, 69n]);
  });

  it("follow.noReread: a node behind the keeper's last block is not asked again for blocks the keeper has already heard", async () => {
    const r = rig();
    r.s.h.lastBlock = 120; // heard already; this node is behind
    r.s.head = { number: 100n, time: 5_000n }; // this node is behind
    await r.follower.tick();
    assert.deepEqual(r.asked, []);
    r.s.head = { number: 115n, time: 5_007n };
    await r.follower.tick();
    assert.deepEqual(r.asked, []);
    r.s.head = { number: 123n, time: 5_011n };
    await r.follower.tick();
    assert.deepEqual(r.asked, [[121n, 123n]]);
  });

  it("follow.oneAtATime: a tick that starts while another is still reading does nothing", async () => {
    const r = rig();
    r.s.h.lastBlock = 90;
    let release!: () => void;
    r.s.headWait = new Promise<void>((resolve) => (release = resolve));
    const first = r.follower.tick();
    const second = r.follower.tick();
    await second;
    assert.equal(r.heads(), 1);
    release();
    await first;
    assert.equal(r.taken.length, 1);
  });
});

describe("nodeFrom: the node's own answers, in the shape a delivery carries", () => {
  const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`;

  function fakeRpc(o: { logs: unknown; times?: Record<number, number> }) {
    const calls: { method: string; params: unknown[] }[] = [];
    const rpc = async (args: { method: string; params?: unknown[] }): Promise<unknown> => {
      calls.push({ method: args.method, params: args.params ?? [] });
      if (args.method === "eth_getBlockByNumber") {
        const which = (args.params ?? [])[0];
        if (which === "latest") return { number: hex(321), timestamp: hex(9_000) };
        const n = Number(BigInt(which as string));
        const t = o.times?.[n];
        return t === undefined ? null : { number: hex(n), timestamp: hex(t) };
      }
      if (args.method === "eth_getLogs") return o.logs;
      throw new Error("not a method these tests know");
    };
    return { rpc, calls };
  }

  it("node.head: the newest block's number and time", async () => {
    const { rpc } = fakeRpc({ logs: [] });
    assert.deepEqual(await nodeFrom(rpc, BOOMERANG).head(), { number: 321n, time: 9_000n });
  });

  it("node.logs: asks for the contract's logs in the range, leaves out removed ones, and gives each its block's time, asking once per block", async () => {
    const raw = (block: number, extra: Record<string, unknown> = {}) => ({ address: BOOMERANG, topics: ["0x01"], data: "0x02", blockNumber: hex(block), transactionHash: "0xaa", logIndex: "0x3", ...extra });
    const { rpc, calls } = fakeRpc({
      logs: [raw(10), raw(10), raw(11, { removed: true }), raw(12, { blockTimestamp: hex(777) })],
      times: { 10: 500 },
    });
    const logs = await nodeFrom(rpc, BOOMERANG).logs(10n, 20n);
    assert.deepEqual(calls[0], { method: "eth_getLogs", params: [{ address: BOOMERANG, fromBlock: "0xa", toBlock: "0x14" }] });
    assert.deepEqual(
      calls.slice(1).map((c) => c.params[0]),
      ["0xa"],
      "one block is asked for its time, once; a log that carries its time needs none",
    );
    assert.deepEqual(logs, [
      { address: BOOMERANG, topics: ["0x01"], data: "0x02", blockNumber: 10n, blockTimestamp: 500n, transactionHash: "0xaa", logIndex: "0x3" },
      { address: BOOMERANG, topics: ["0x01"], data: "0x02", blockNumber: 10n, blockTimestamp: 500n, transactionHash: "0xaa", logIndex: "0x3" },
      { address: BOOMERANG, topics: ["0x01"], data: "0x02", blockNumber: 12n, blockTimestamp: 777n, transactionHash: "0xaa", logIndex: "0x3" },
    ]);
  });

  it("node.odd: an answer that is not what a node gives is a fault, not a delivery", async () => {
    for (const logs of [null, "0x", [{ address: BOOMERANG, topics: ["0x01"], data: "0x02" }], [{ address: 5, topics: [], data: "0x", blockNumber: "0x1" }], [{ address: BOOMERANG, topics: "0x01", data: "0x", blockNumber: "0x1" }]]) {
      const { rpc } = fakeRpc({ logs, times: { 1: 5 } });
      await assert.rejects(nodeFrom(rpc, BOOMERANG).logs(1n, 2n));
    }
    // A block the node does not have yet: its logs cannot be timed.
    const { rpc } = fakeRpc({ logs: [{ address: BOOMERANG, topics: ["0x01"], data: "0x", blockNumber: "0x9" }] });
    await assert.rejects(nodeFrom(rpc, BOOMERANG).logs(1n, 20n));
    await assert.rejects(nodeFrom(async () => ({ number: "12", timestamp: null }), BOOMERANG).head());
  });
});
