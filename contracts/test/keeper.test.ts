// Every amount and account in these tests is invented. None is a reading of any real campaign.
//
// The keeper driven against the live contract: deliveries are built from the chain's own logs in
// the shape the keeper's own node reading makes, the keeper's sender signs as an account with no role, and
// the loop must leave the contract owing nothing. These tests exercise the plumbing around the
// two pure modules (the ledger and the planner), not the arithmetic, which keeper-plan covers.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createPublicClient, createWalletClient, custom, encodeAbiParameters, encodeEventTopics, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { Outcome, setup, USD } from "./helpers.ts";
import { boomerangAbi, decodeLogs, emptyLedger, share, type Address, type RawLog } from "../../packages/kit/src/index.ts";
import { makeSender } from "../../services/keeper/src/chain.ts";
import { createDesk, DEMO, DESK_KINDS } from "../../services/keeper/src/demo.ts";
import { createKeeper, type Delivery, type Keeper, type Sender, type SendResult } from "../../services/keeper/src/keeper.ts";
import type { Action } from "../../services/keeper/src/plan.ts";
import { createServer } from "../../services/keeper/src/server.ts";
import { memoryStore, openStore } from "../../services/keeper/src/store.ts";

type W = Awaited<ReturnType<typeof setup>>;

const ZERO = "0x0000000000000000000000000000000000000000";

function toHex(v: bigint | number): `0x${string}` {
  return `0x${BigInt(v).toString(16)}`;
}

function actionKey(a: Action): string {
  if (a.kind === "finalize") return `finalize:${a.id}`;
  if (a.kind === "paySide") return `paySide:${a.id}:${a.side}`;
  return `payMany:${a.id}:${a.backers.join(",")}`;
}

/** One delivery per block that holds a Boomerang log, in block order. */
async function blockDeliveries(w: W): Promise<Delivery[]> {
  const logs = await w.publicClient.getLogs({ address: w.boomerang.address, fromBlock: 0n });
  const byBlock = new Map<bigint, typeof logs>();
  for (const lg of logs) {
    const bn = lg.blockNumber!;
    const arr = byBlock.get(bn) ?? [];
    arr.push(lg);
    byBlock.set(bn, arr);
  }
  const out: Delivery[] = [];
  for (const bn of [...byBlock.keys()].sort((a, b) => (a < b ? -1 : 1))) {
    const block = await w.publicClient.getBlock({ blockNumber: bn });
    const raw: RawLog[] = byBlock.get(bn)!.map((lg) => ({
      address: lg.address,
      topics: lg.topics,
      data: lg.data,
      blockNumber: toHex(bn),
      blockTimestamp: toHex(block.timestamp),
      transactionHash: lg.transactionHash,
      logIndex: lg.logIndex ?? 0,
    }));
    out.push({ fromBlock: Number(bn), toBlock: Number(bn), time: Number(block.timestamp), logs: raw });
  }
  return out;
}

/** A no-log delivery at the latest block: a tick that carries the clock to the keeper. */
async function tick(w: W): Promise<Delivery> {
  const bn = await w.publicClient.getBlockNumber();
  const block = await w.publicClient.getBlock({ blockNumber: bn });
  return { fromBlock: Number(bn), toBlock: Number(bn), time: Number(block.timestamp), logs: [] };
}

/** Re-deliver every block, then a clock tick, `rounds` times, awaiting each round's sends. */
async function pump(w: W, keeper: Keeper, rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    for (const d of await blockDeliveries(w)) keeper.deliver(d);
    await keeper.deliver(await tick(w)).done;
  }
}

/** Drive until the ledger is settled and the contract owes nothing. */
async function settle(w: W, keeper: Keeper, rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    for (const d of await blockDeliveries(w)) keeper.deliver(d);
    await keeper.deliver(await tick(w)).done;
    if (keeper.health().settled && (await w.boomerang.read.totalOwed()) === 0n) return;
  }
  assert.fail("the keeper did not settle in the round budget");
}

/** A missed campaign: three backers (two early, one late), below target, past its close. */
async function missedCampaign(w: W, over: Record<string, bigint> = {}) {
  const m = await w.open(over);
  await w.time.increaseTo(m.t.opensAt);
  await w.pledge(m.id, w.bob, 30n * USD, m.t.opensAt + 10n);
  await w.pledge(m.id, w.carol, 20n * USD, m.t.opensAt + 20n);
  await w.pledge(m.id, w.dave, 10n * USD, m.t.earlyUntil + 5n);
  await w.time.increaseTo(m.t.closesAt);
  return m;
}

/** Compare the keeper's ledger to the contract, field for field, for each campaign id. */
async function compareLedgerToContract(w: W, keeper: Keeper, ids: bigint[]): Promise<void> {
  assert.equal(BigInt(keeper.health().lastSeq), await w.boomerang.read.eventCount());
  assert.equal(keeper.ledger.totalOwed, await w.boomerang.read.totalOwed());
  for (const id of ids) {
    const s = await w.boomerang.read.stateOf([id]);
    const c = keeper.ledger.campaigns.get(id)!;
    assert.equal(c.sponsor.toLowerCase(), s.sponsor.toLowerCase());
    assert.equal(c.outcome, s.outcome);
    assert.equal(c.matchIn, s.matchIn);
    assert.equal(c.bonusIn, s.bonusIn);
    assert.equal(c.recipientPaid, s.recipientPaid);
    assert.equal(c.matchReturned, s.matchReturned);
    assert.equal(c.bonusReturned, s.bonusReturned);
    assert.equal(BigInt(c.backers.size), BigInt(s.backers));
    assert.equal(c.pledged, s.pledged);
    assert.equal(c.pledgedEarly, s.pledgedEarly);
    assert.equal(c.weighted, s.weighted);
    assert.equal(c.bonusPaid, s.bonusPaid);
    for (const [addr, b] of c.backers) {
      const bc = await w.boomerang.read.backerOf([id, addr as Address]);
      assert.equal(b.principal, bc.principal);
      assert.equal(b.weighted, bc.weighted);
      assert.equal(b.paid, bc.paid);
      assert.equal((b.payTo ?? ZERO).toLowerCase(), bc.payTo.toLowerCase());
    }
  }
}

/** A log the contract never emitted, shaped like a real one and stamped with delivery `d`'s block and time. */
function forge(w: W, eventName: string, args: Record<string, unknown>, d: Delivery): RawLog {
  type Input = { name: string; type: string; indexed?: boolean };
  const item = (boomerangAbi as readonly { type: string; name?: string; inputs?: readonly Input[] }[]).find((x) => x.type === "event" && x.name === eventName)!;
  const inputs = item.inputs!;
  const indexed = Object.fromEntries(inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name]]));
  const rest = inputs.filter((i) => !i.indexed);
  return {
    address: w.boomerang.address,
    topics: encodeEventTopics({ abi: boomerangAbi, eventName, args: indexed } as never) as `0x${string}`[],
    data: encodeAbiParameters(rest as never, rest.map((i) => args[i.name]) as never),
    blockNumber: toHex(d.toBlock),
    blockTimestamp: toHex(d.time),
  };
}

/**
 * A keeper over the real sender, signing as an account with no role. Every call put to the
 * sender is recorded; `clock.now` is the keeper's waiting clock; `wrap` may answer in the sender's place.
 */
function watched(w: W, wrap?: (a: Action, inner: Sender) => Promise<SendResult>) {
  const asks: Action[] = [];
  const clock = { now: 0n };
  const inner = makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address });
  const keeper = createKeeper({
    boomerang: w.boomerang.address,
    store: memoryStore(),
    send: async (a) => {
      asks.push(a);
      return wrap ? wrap(a, inner) : inner(a);
    },
    timer: () => clock.now,
  });
  const sent = () => w.publicClient.getTransactionCount({ address: w.stranger.account.address });
  return { keeper, asks, clock, sent };
}

/** `rounds` deliveries twenty seconds apart on the waiting clock: every block again, then a clock tick. */
async function beats(w: W, k: ReturnType<typeof watched>, rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    k.clock.now += 20n;
    for (const d of await blockDeliveries(w)) k.keeper.deliver(d);
    await k.keeper.deliver(await tick(w)).done;
  }
}

describe("keeper against the contract", async function () {
  it("keeper.idempotent: duplicate and shuffled deliveries settle a funded and a missed campaign once", async function () {
    const w = await setup();

    // A funded campaign (alice meets the target) and a missed one (three backers, below target).
    const f = await w.open();
    await w.time.increaseTo(f.t.opensAt);
    await w.pledge(f.id, w.alice, 100n * USD);
    const m = await missedCampaign(w);

    let keeperRef: Keeper;
    const calls: { key: string; time: bigint }[] = [];
    const inner = makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address });
    const sender: Sender = async (action) => {
      calls.push({ key: actionKey(action), time: BigInt(keeperRef.health().lastTime) });
      return inner(action);
    };
    const keeper = createKeeper({ boomerang: w.boomerang.address, store: memoryStore(), send: sender });
    keeperRef = keeper;

    // Deliver every delivery twice, then the whole set once more reversed.
    const ds = await blockDeliveries(w);
    for (const d of ds) {
      keeper.deliver(d);
      keeper.deliver(d);
    }
    for (const d of [...ds].reverse()) keeper.deliver(d);

    await settle(w, keeper);

    await compareLedgerToContract(w, keeper, [f.id, m.id]);
    assert.equal(await w.boomerang.read.totalOwed(), 0n);
    assert.ok(keeper.health().repeats > 0, "duplicates must show as repeats");

    // Each missed backer shows exactly one payout: principal plus the bonus share, no more.
    const s = await w.boomerang.read.stateOf([m.id]);
    for (const who of [w.bob, w.carol, w.dave]) {
      const bk = await w.boomerang.read.backerOf([m.id, who.account.address]);
      const bonus = share(s.bonusPaid, bk.weighted, s.weighted);
      assert.equal(await w.balance(who), bk.principal + bonus);
    }

    // No action key was handed to the sender twice within resendAfter (20) chain seconds.
    const byKey = new Map<string, bigint[]>();
    for (const c of calls) byKey.set(c.key, [...(byKey.get(c.key) ?? []), c.time]);
    for (const [key, times] of byKey) {
      times.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (let i = 1; i < times.length; i++) {
        assert.ok(times[i] - times[i - 1] >= 20n, `action ${key} was re-sent within resendAfter`);
      }
    }
  });

  it("keeper.server: a missed campaign settles end to end, then is read back over /ledger", async function () {
    const w = await setup();
    const m = await missedCampaign(w);

    const keeper = createKeeper({
      boomerang: w.boomerang.address,
      store: memoryStore(),
      send: makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address }),
    });
    // The server is kept only for the /ledger read below; deliveries are handed straight to the keeper.
    const server = createServer({ keeper });
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;

    try {
      for (let i = 0; i < 20; i++) {
        for (const d of await blockDeliveries(w)) await keeper.deliver(d).done;
        // A direct awaited tick drives and lets the queued sends finish before the next read.
        await keeper.deliver(await tick(w)).done;
        if (keeper.health().settled && (await w.boomerang.read.totalOwed()) === 0n) break;
      }
      assert.equal(await w.boomerang.read.totalOwed(), 0n);

      const ledger = (await (await fetch(url + "/ledger")).json()) as {
        campaigns: { id: string; outcome: number; pledged: string; backers: { address: string; paid: boolean; principal: string }[] }[];
      };
      const s = await w.boomerang.read.stateOf([m.id]);
      const cj = ledger.campaigns.find((c) => c.id === m.id.toString())!;
      assert.equal(cj.outcome, s.outcome);
      assert.equal(cj.pledged, s.pledged.toString());
      for (const bj of cj.backers) {
        const bc = await w.boomerang.read.backerOf([m.id, bj.address as Address]);
        assert.equal(bj.paid, bc.paid);
        assert.equal(bj.principal, bc.principal.toString());
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("keeper.restart: a second keeper over the same store has the same state, puts each side to the contract once, and sends nothing", async function () {
    const w = await setup();
    const dir = mkdtempSync(join(tmpdir(), "keeper-"));
    const store = openStore(dir);
    const keeper1 = createKeeper({
      boomerang: w.boomerang.address,
      store,
      send: makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address }),
    });
    const m = await missedCampaign(w);
    await settle(w, keeper1);

    const calls: Action[] = [];
    const answers: SendResult[] = [];
    const real = makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address });
    const sentBefore = await w.publicClient.getTransactionCount({ address: w.stranger.account.address });
    const keeper2 = createKeeper({
      boomerang: w.boomerang.address,
      store: openStore(dir),
      send: async (a) => {
        calls.push(a);
        const r = await real(a);
        answers.push(r);
        return r;
      },
    });
    assert.equal(keeper2.ledger.lastSeq, keeper1.ledger.lastSeq);
    assert.deepEqual([...keeper2.ledger.campaigns.keys()], [...keeper1.ledger.campaigns.keys()]);
    assert.equal(keeper2.ledger.campaigns.get(m.id)!.outcome, keeper1.ledger.campaigns.get(m.id)!.outcome);
    assert.ok(keeper1.feed().length > 5);
    assert.deepEqual(keeper2.feed(), keeper1.feed());
    // Its clock and the block /health shows start from the newest event it replayed, not from zero.
    const newest = keeper1.feed().at(-1)!;
    assert.equal(keeper2.health().lastTime, String(newest.time));
    assert.equal(keeper2.health().lastBlock, Number(newest.blockNumber));
    assert.ok(newest.time !== undefined && newest.time > 0n);

    // What the contract called finished is not kept across a restart, so each side is asked once more.
    await keeper2.deliver(await tick(w)).done;
    assert.deepEqual(calls, [0, 1, 2].map((side) => ({ kind: "paySide", id: m.id, side })));
    assert.ok(answers.every((r) => !r.ok && r.nothing?.final === true), "each is called finished");
    await pump(w, keeper2, 3);
    assert.equal(calls.length, 3, "and nothing is asked after that");
    assert.equal(await w.publicClient.getTransactionCount({ address: w.stranger.account.address }), sentBefore, "a settled keeper sends nothing");
  });

  it("keeper.restartBlocked: a restarted keeper still knows whose payout just failed and does not send it again at once", async function () {
    const w = await setup();
    const store = memoryStore();
    const send = makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address });
    const keeper1 = createKeeper({ boomerang: w.boomerang.address, store, send });
    const m = await missedCampaign(w);
    await w.usdc.write.setBlocked([w.carol.account.address, true]);
    await pump(w, keeper1, 4);
    assert.equal((await w.boomerang.read.backerOf([m.id, w.carol.account.address])).paid, false);
    assert.ok(keeper1.ledger.campaigns.get(m.id)!.payFailures >= 1);

    const calls: Action[] = [];
    const keeper2 = createKeeper({
      boomerang: w.boomerang.address,
      store,
      send: async (a) => {
        calls.push(a);
        return send(a);
      },
    });
    await pump(w, keeper2, 2);
    assert.deepEqual(calls.filter((a) => a.kind !== "paySide"), [], "inside retryFailedAfter the failed payout is not offered again");

    // Once the wait has passed it is offered again.
    await w.time.increaseTo(BigInt(await w.time.latest()) + 601n);
    await pump(w, keeper2, 1);
    assert.ok((calls as Action[]).some((a) => a.kind === "payMany"));
  });

  it("keeper.gap: a withheld delivery shows in health().missing and the keeper still finalizes", async function () {
    const w = await setup();
    const m = await missedCampaign(w);
    const keeper = createKeeper({
      boomerang: w.boomerang.address,
      store: memoryStore(),
      send: makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address }),
    });

    // Withhold the block carrying the middle pledge (seq 5: create 1, match 2, bonus 3, pledges 4/5/6).
    let withheld: Delivery | undefined;
    const kept: Delivery[] = [];
    for (const d of await blockDeliveries(w)) {
      if (decodeLogs(d.logs, w.boomerang.address).some((e) => e.seq === 5n)) withheld = d;
      else kept.push(d);
    }
    assert.ok(withheld, "expected a delivery with seq 5");

    for (const d of kept) keeper.deliver(d);
    await keeper.deliver(await tick(w)).done; // finalize the campaign it knows, past the gap

    assert.deepEqual(keeper.health().missing, { from: "5", to: "5" });
    assert.equal((await w.boomerang.read.stateOf([m.id])).outcome, Outcome.Missed);

    keeper.deliver(withheld!); // fill the gap
    assert.equal(keeper.health().missing, null);
  });

  it("keeper.blocked: a blocked backer fails, is left until a redirect, then paid to the new address", async function () {
    const w = await setup();
    const m = await missedCampaign(w);
    await w.usdc.write.setBlocked([w.carol.account.address, true]);
    const keeper = createKeeper({
      boomerang: w.boomerang.address,
      store: memoryStore(),
      send: makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address }),
    });

    await pump(w, keeper, 3); // finalize, then pay: carol fails, the others are paid
    assert.equal((await w.boomerang.read.backerOf([m.id, w.bob.account.address])).paid, true);
    assert.equal((await w.boomerang.read.backerOf([m.id, w.dave.account.address])).paid, true);
    assert.equal((await w.boomerang.read.backerOf([m.id, w.carol.account.address])).paid, false);
    const owed = await w.boomerang.read.totalOwed();
    assert.ok(owed > 0n, "carol is still owed");

    // Within retryFailedAfter she is not named again: no further failed attempt.
    const failsBefore = keeper.ledger.campaigns.get(m.id)!.payFailures;
    await pump(w, keeper, 2);
    assert.equal(keeper.ledger.campaigns.get(m.id)!.payFailures, failsBefore);
    assert.equal(await w.boomerang.read.totalOwed(), owed);

    // A redirect to an unblocked address clears the skip; she is then paid there.
    await w.boomerang.write.redirect([m.id, w.erin.account.address], { account: w.carol.account });
    await pump(w, keeper, 3);
    assert.equal((await w.boomerang.read.backerOf([m.id, w.carol.account.address])).paid, true);
    assert.equal(await w.boomerang.read.totalOwed(), 0n);
    const s = await w.boomerang.read.stateOf([m.id]);
    const bk = await w.boomerang.read.backerOf([m.id, w.carol.account.address]);
    assert.equal(await w.balance(w.erin), bk.principal + share(s.bonusPaid, bk.weighted, s.weighted));
  });

  it("keeper.blockedSide: a blocked sponsor fails MatchReturn once, is not re-sent inside retryFailedAfter, then paid", async function () {
    const w = await setup();
    const m = await missedCampaign(w, { bonusPool: 0n }); // only the match returns, straight to the sponsor
    await w.usdc.write.setBlocked([w.sponsor.account.address, true]);
    const keeper = createKeeper({
      boomerang: w.boomerang.address,
      store: memoryStore(),
      send: makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address }),
    });

    await pump(w, keeper, 3); // finalize, then MatchReturn fails while the backers are paid
    assert.equal(keeper.health().failedSends, 1);
    assert.equal((await w.boomerang.read.stateOf([m.id])).matchReturned, false);
    for (const who of [w.bob, w.carol, w.dave]) {
      assert.equal((await w.boomerang.read.backerOf([m.id, who.account.address])).paid, true);
    }
    const owed = await w.boomerang.read.totalOwed();

    // Inside retryFailedAfter the paySide is not offered again.
    await pump(w, keeper, 2);
    assert.equal(keeper.health().failedSends, 1);
    assert.equal(await w.boomerang.read.totalOwed(), owed);

    // Unblock and let retryFailedAfter pass: the match is returned and nothing is left owed.
    await w.usdc.write.setBlocked([w.sponsor.account.address, false]);
    await w.time.increaseTo(BigInt(await w.time.latest()) + 601n);
    await settle(w, keeper);
    assert.equal((await w.boomerang.read.stateOf([m.id])).matchReturned, true);
    assert.equal(await w.boomerang.read.totalOwed(), 0n);
  });

  it("keeper.failedSend: a send the contract refused waits retryFailedAfter; a passing failure is retried after resendAfter", async function () {
    const w = await setup();
    const m = await missedCampaign(w);
    const inner = makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address });
    const forced: SendResult[] = [
      { ok: false, error: "forced hiccup" },
      { ok: false, error: "forced refusal", reverted: true },
    ];
    let calls = 0;
    const sender: Sender = async (action) => {
      calls += 1;
      const next = forced.shift();
      return next ?? inner(action);
    };
    const keeper = createKeeper({ boomerang: w.boomerang.address, store: memoryStore(), send: sender });

    for (const d of await blockDeliveries(w)) keeper.deliver(d);
    await keeper.deliver(await tick(w)).done; // finalize: the hiccup
    assert.equal(calls, 1);
    assert.equal(keeper.health().failedSends, 1);
    assert.ok(keeper.health().lastErrors.includes("forced hiccup"));

    // Inside resendAfter the call is not offered again.
    await keeper.deliver(await tick(w)).done;
    assert.equal(calls, 1);

    // After resendAfter (20 chain seconds) it is offered again; this time the contract "refuses".
    await w.time.increaseTo(BigInt(await w.time.latest()) + 21n);
    await keeper.deliver(await tick(w)).done;
    assert.equal(calls, 2);
    assert.equal(keeper.health().failedSends, 2);
    assert.equal((await w.boomerang.read.stateOf([m.id])).outcome, Outcome.Open);

    // A refused call is left alone well past resendAfter...
    await w.time.increaseTo(BigInt(await w.time.latest()) + 300n);
    await keeper.deliver(await tick(w)).done;
    assert.equal(calls, 2);

    // ...and offered again once retryFailedAfter (600) has passed. Then the campaign settles.
    await w.time.increaseTo(BigInt(await w.time.latest()) + 301n);
    await settle(w, keeper);
    assert.equal((await w.boomerang.read.stateOf([m.id])).outcome, Outcome.Missed);
    assert.equal(await w.boomerang.read.totalOwed(), 0n);
    assert.equal(keeper.health().failedSends, 2);
  });

  it("keeper.misfit: an event that does not fit the ledger is set aside; the real one still applies, also after a restart", async function () {
    const w = await setup();
    const m = await missedCampaign(w);
    const store = memoryStore();
    const send = makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address });
    const keeper = createKeeper({ boomerang: w.boomerang.address, store, send });

    const real = await blockDeliveries(w);
    // The first two blocks (the campaign and its first pot), then a made-up "Paid" for someone
    // who never pledged, carrying the sequence number the next real event will have.
    keeper.deliver(real[0]);
    keeper.deliver(real[1]);
    const next = BigInt(keeper.health().lastSeq) + 1n;
    const madeUp = encodeEventTopics({ abi: boomerangAbi, eventName: "Paid", args: { seq: next, id: m.id, backer: w.erin.account.address } });
    const forged: Delivery = {
      ...real[1],
      logs: [{ address: w.boomerang.address, topics: madeUp as `0x${string}`[], data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], [w.erin.account.address, 5n, 0n]), blockNumber: toHex(real[1].toBlock), blockTimestamp: toHex(real[1].time) }],
    };
    assert.doesNotThrow(() => keeper.deliver(forged));
    assert.equal(keeper.health().rejected, 1);
    assert.equal(BigInt(keeper.health().lastSeq), next - 1n);
    assert.ok(keeper.health().lastErrors.some((e) => /did not fit/.test(e)));

    // The real events arrive and the keeper carries on to the end.
    await settle(w, keeper);
    await compareLedgerToContract(w, keeper, [m.id]);
    assert.equal(keeper.health().missing, null);
    assert.ok(!keeper.feed().some((e) => e.name === "Paid" && e.backer.toLowerCase() === w.erin.account.address.toLowerCase()));

    // A second keeper over the same store starts, and has the same ledger and the same feed.
    const again = createKeeper({ boomerang: w.boomerang.address, store, send: async () => ({ ok: false, error: "should not be called" }) });
    assert.equal(again.health().lastSeq, keeper.health().lastSeq);
    assert.equal(again.ledger.totalOwed, keeper.ledger.totalOwed);
    assert.deepEqual(again.feed(), keeper.feed());
    await compareLedgerToContract(w, again, [m.id]);
  });

  it("keeper.farTime: a delivery dated absurdly far ahead costs questions to the contract and no gas; it does not stop the real settlement", async function () {
    const w = await setup();
    const m = await w.open();
    await w.time.increaseTo(m.t.opensAt);
    await w.pledge(m.id, w.bob, 30n * USD, m.t.opensAt + 10n);
    let timer = 1_000n; // this machine's forward-only clock, moved by the test
    let asked = 0;
    const inner = makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address });
    const keeper = createKeeper({
      boomerang: w.boomerang.address,
      store: memoryStore(),
      send: async (a) => {
        asked += 1;
        return inner(a);
      },
      timer: () => timer,
    });
    const sentByKeeper = () => w.publicClient.getTransactionCount({ address: w.stranger.account.address });
    const before = await sentByKeeper();
    for (const d of await blockDeliveries(w)) keeper.deliver(d);

    // The campaign is still open. A delivery claims a time that cannot be.
    await keeper.deliver({ ...(await tick(w)), time: Number.MAX_SAFE_INTEGER }).done;
    assert.equal(asked, 1); // finalize looked due; the contract, asked first, said it is not
    assert.equal(keeper.health().failedSends, 0);
    assert.equal(keeper.health().sent, 0);
    assert.equal(await sentByKeeper(), before);
    assert.equal((await w.boomerang.read.stateOf([m.id])).outcome, Outcome.Open);
    assert.equal(keeper.health().lastTime, String(Number.MAX_SAFE_INTEGER)); // the keeper's clock is now wrong, and stays wrong

    // It asks again after 20, 40, 80 and 160 seconds of the machine's clock, whatever deliveries say, and sends nothing.
    const asksAt: bigint[] = [];
    for (const step of [19n, 1n, 39n, 1n, 79n, 1n, 159n, 1n, 319n]) {
      timer += step;
      const was = asked;
      await keeper.deliver({ ...(await tick(w)), time: Number.MAX_SAFE_INTEGER }).done;
      if (asked > was) asksAt.push(timer - 1_000n);
    }
    assert.deepEqual(asksAt, [20n, 60n, 140n, 300n]);
    assert.equal(await sentByKeeper(), before);

    // The real deadline passes. At the next question (never more than 320 seconds off) the call goes through and the campaign settles.
    await w.time.increaseTo(m.t.closesAt);
    timer += 1n;
    await keeper.deliver(await tick(w)).done;
    assert.equal((await w.boomerang.read.stateOf([m.id])).outcome, Outcome.Missed);
    for (let i = 0; i < 8 && (await w.boomerang.read.totalOwed()) > 0n; i++) {
      timer += 20n;
      for (const d of await blockDeliveries(w)) keeper.deliver(d);
      await keeper.deliver(await tick(w)).done;
    }
    assert.equal(await w.boomerang.read.totalOwed(), 0n);
    assert.equal(keeper.health().failedSends, 0);
  });

  it("keeper.forged: false events for made-up backers cost one question each and no gas, however many follow", async function () {
    const w = await setup();
    const m = await missedCampaign(w);
    let timer = 0n;
    const asks: Action[] = [];
    const inner = makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address });
    const keeper = createKeeper({
      boomerang: w.boomerang.address,
      store: memoryStore(),
      send: async (a) => {
        asks.push(a);
        return inner(a);
      },
      timer: () => timer,
    });
    await settle(w, keeper);
    // Twenty seconds on, the two returns just paid are put to the contract once more and called finished.
    timer += 20n;
    await pump(w, keeper, 1);
    const sentByKeeper = () => w.publicClient.getTransactionCount({ address: w.stranger.account.address });
    const sentBefore = await sentByKeeper();
    const askedBefore = asks.length;

    // Someone who can feed the keeper forges pledges by 80 backers who do not exist.
    const now = await tick(w);
    let seq = BigInt(keeper.health().lastSeq);
    const made = (i: number): Address => `0x${(0xf000 + i).toString(16).padStart(40, "0")}`;
    const forged = (eventName: "Pledged" | "Redirected", backer: Address, data: `0x${string}`): RawLog => ({
      address: w.boomerang.address,
      topics: encodeEventTopics({ abi: boomerangAbi, eventName, args: { seq: ++seq, id: m.id, backer } }) as `0x${string}`[],
      data,
      blockNumber: toHex(now.toBlock),
      blockTimestamp: toHex(now.time),
    });
    const pledged = (i: number) => forged("Pledged", made(i), encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], [made(i), 5n * USD, 0n]));
    await keeper.deliver({ ...now, logs: Array.from({ length: 80 }, (_, i) => pledged(100 + i)) }).done;
    assert.equal(keeper.ledger.campaigns.get(m.id)!.backers.size, 83);
    // Two calls of forty were planned. The contract, asked first, owes none of them anything.
    assert.equal(asks.length - askedBefore, 2);

    // Then one forged redirect every twenty seconds for two hours, and now and then a forged
    // pledge from an address that sorts first and would shift every batch.
    let extra = 0;
    for (let i = 0; i < 360; i++) {
      timer += 20n;
      const logs = [forged("Redirected", made(100 + (i % 80)), encodeAbiParameters([{ type: "address" }], [made(5000 + i)]))];
      if (i % 60 === 0) logs.push(pledged(extra++));
      await keeper.deliver({ ...now, logs }).done;
    }
    assert.equal(extra, 6);
    assert.equal(asks.length - askedBefore, 2 + extra, "one question for each made-up backer's batch, and no more");
    assert.equal(await sentByKeeper(), sentBefore, "no transaction was sent for any of it");
    assert.deepEqual(keeper.health().gaveUp, []);
    assert.equal(await w.boomerang.read.totalOwed(), 0n);
  });

  it("keeper.forgedOutcome: a false 'missed' for an open campaign sends nothing; after a minute of the contract saying 'open' the keeper asks again only when that time has doubled, and when the campaign really ends it settles and pays", async function () {
    const w = await setup();
    const m = await w.open();
    await w.time.increaseTo(m.t.opensAt);
    await w.pledge(m.id, w.bob, 30n * USD, m.t.opensAt + 10n);
    let timer = 0n;
    const asks: Action[] = [];
    const inner = makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address });
    const keeper = createKeeper({
      boomerang: w.boomerang.address,
      store: memoryStore(),
      send: async (a) => {
        asks.push(a);
        return inner(a);
      },
      timer: () => timer,
    });
    for (const d of await blockDeliveries(w)) keeper.deliver(d);
    const now = await tick(w);
    const seq = BigInt(keeper.health().lastSeq) + 1n;
    const finalized: RawLog = {
      address: w.boomerang.address,
      topics: encodeEventTopics({ abi: boomerangAbi, eventName: "Finalized", args: { seq, id: m.id } }) as `0x${string}`[],
      data: encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }], [Outcome.Missed, 0n]),
      blockNumber: toHex(now.toBlock),
      blockTimestamp: toHex(now.time),
    };
    const sentBefore = await w.publicClient.getTransactionCount({ address: w.stranger.account.address });
    await keeper.deliver({ ...now, logs: [finalized] }).done;
    assert.equal(keeper.ledger.campaigns.get(m.id)!.outcome, Outcome.Missed);
    const first = asks.length;
    assert.ok(first >= 2, "the returns and the payout were planned and put to the contract");

    // The contract shows no outcome. A node a block behind the chain's head shows the same, so the
    // calls are asked once more, 20 seconds on. After a minute of "open" the keeper takes the
    // contract's word over the ledger's: the campaign is open and not due. In case the node was
    // only behind, the ledger's outcome is tried again at 2, 4, 8 and 16 minutes.
    // Twenty minutes of deliveries, one every twenty seconds: free reads, and no transaction.
    for (let i = 0; i < 60; i++) {
      timer += 20n;
      await keeper.deliver(now).done;
    }
    assert.equal(asks.length, first * 6);
    assert.equal(await w.publicClient.getTransactionCount({ address: w.stranger.account.address }), sentBefore);
    assert.equal((await w.boomerang.read.stateOf([m.id])).outcome, Outcome.Open);
    assert.ok(keeper.health().lastErrors.some((e) => /still open/.test(e)), "the disagreement is reported");

    // The campaign really ends, missed. The false event still holds the real one's number, so
    // the ledger never hears the true outcome; the keeper settles and pays all the same. Its own
    // finalize went through, which shows the outcome is set: the remembered "open" is dropped.
    await w.time.increaseTo(m.t.closesAt + 10n);
    for (let i = 0; i < 30; i++) {
      timer += 20n;
      for (const d of await blockDeliveries(w)) keeper.deliver(d);
      await keeper.deliver(await tick(w)).done;
    }
    assert.equal((await w.boomerang.read.stateOf([m.id])).outcome, Outcome.Missed);
    assert.equal((await w.boomerang.read.backerOf([m.id, w.bob.account.address])).paid, true);
    assert.equal(await w.boomerang.read.totalOwed(), 0n);
    assert.equal(asks.filter((a) => a.kind === "finalize").length, 1, "one finalize, sent");
  });

  it("keeper.forgedAgain: repeating the false 'missed' does not restart the minute or the doubling", async function () {
    const w = await setup();
    const m = await w.open();
    await w.time.increaseTo(m.t.opensAt);
    await w.pledge(m.id, w.bob, 30n * USD, m.t.opensAt + 10n);
    let timer = 0n;
    let asked = 0;
    const inner = makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address });
    const keeper = createKeeper({
      boomerang: w.boomerang.address,
      store: memoryStore(),
      send: async (a) => {
        asked += 1;
        return inner(a);
      },
      timer: () => timer,
    });
    for (const d of await blockDeliveries(w)) keeper.deliver(d);
    const now = await tick(w);
    let seq = BigInt(keeper.health().lastSeq);
    const forged = (): RawLog => ({
      address: w.boomerang.address,
      topics: encodeEventTopics({ abi: boomerangAbi, eventName: "Finalized", args: { seq: ++seq, id: m.id } }) as `0x${string}`[],
      data: encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }], [Outcome.Missed, 0n]),
      blockNumber: toHex(now.toBlock),
      blockTimestamp: toHex(now.time),
    });
    await keeper.deliver({ ...now, logs: [forged()] }).done;
    const first = asked;
    assert.ok(first >= 2);
    // The same false event again every twenty seconds, each under a new number, for twenty minutes.
    for (let i = 0; i < 60; i++) {
      timer += 20n;
      await keeper.deliver({ ...now, logs: [forged()] }).done;
    }
    assert.equal(keeper.ledger.lastSeq, seq, "every one of them fitted the ledger");
    assert.equal(asked, first * 6, "asked at the start and at 20 seconds; after a minute the contract's 'open' stands, tried again at 2, 4, 8 and 16 minutes");
    assert.equal(await w.publicClient.getTransactionCount({ address: w.stranger.account.address }), 0);
  });

  it("keeper.forgedWrong: a false 'missed' ahead of a campaign that really funds: the keeper pays the recipient on the contract's word", async function () {
    const w = await setup();
    const f = await w.open();
    await w.time.increaseTo(f.t.opensAt);
    let timer = 0n;
    const asks: Action[] = [];
    const inner = makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address });
    const keeper = createKeeper({
      boomerang: w.boomerang.address,
      store: memoryStore(),
      send: async (a) => {
        asks.push(a);
        return inner(a);
      },
      timer: () => timer,
    });
    for (const d of await blockDeliveries(w)) keeper.deliver(d);
    const now = await tick(w);
    let seq = BigInt(keeper.health().lastSeq);
    // The next two numbers are taken by a pledge from a made-up backer and a false "missed".
    const fake = "0x000000000000000000000000000000000000f00d" as Address;
    const logs: RawLog[] = [
      {
        address: w.boomerang.address,
        topics: encodeEventTopics({ abi: boomerangAbi, eventName: "Pledged", args: { seq: ++seq, id: f.id, backer: fake } }) as `0x${string}`[],
        data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], [fake, 5n * USD, 0n]),
        blockNumber: toHex(now.toBlock),
        blockTimestamp: toHex(now.time),
      },
      {
        address: w.boomerang.address,
        topics: encodeEventTopics({ abi: boomerangAbi, eventName: "Finalized", args: { seq: ++seq, id: f.id } }) as `0x${string}`[],
        data: encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }], [Outcome.Missed, 0n]),
        blockNumber: toHex(now.toBlock),
        blockTimestamp: toHex(now.time),
      },
    ];
    await keeper.deliver({ ...now, logs }).done;
    await w.pledge(f.id, w.erin, f.t.target, f.t.opensAt + 10n); // the real campaign funds
    assert.equal((await w.boomerang.read.stateOf([f.id])).outcome, Outcome.Funded);
    for (let i = 0; i < 30; i++) {
      timer += 20n;
      for (const d of await blockDeliveries(w)) keeper.deliver(d);
      await keeper.deliver(await tick(w)).done;
    }
    assert.equal(keeper.ledger.campaigns.get(f.id)!.outcome, Outcome.Missed, "the ledger still holds the false outcome");
    const state = await w.boomerang.read.stateOf([f.id]);
    assert.equal(state.recipientPaid, true);
    assert.equal(state.bonusReturned, true);
    assert.equal(await w.boomerang.read.totalOwed(), 0n);
    assert.ok(keeper.health().lastErrors.some((e) => /the contract shows/.test(e)), "the disagreement is reported");
  });

  it("keeper.behind: a keeper that has not yet heard the outcome asks once, is told it is set, and pays on the contract's word", async function () {
    const w = await setup();
    const m = await missedCampaign(w);
    const before = await blockDeliveries(w); // everything up to the close, no outcome yet
    await w.boomerang.write.finalize([m.id], { account: w.alice.account }); // someone else settles it
    let timer = 0n;
    const asks: Action[] = [];
    const inner = makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address });
    const keeper = createKeeper({
      boomerang: w.boomerang.address,
      store: memoryStore(),
      send: async (a) => {
        asks.push(a);
        return inner(a);
      },
      timer: () => timer,
    });
    for (const d of before) keeper.deliver(d);
    // Clock ticks only: the Finalized event never reaches this keeper (a false event could hold its number).
    const beat = await tick(w);
    // One delivery is enough: told the outcome, the keeper plans again at once and pays.
    await keeper.deliver(beat).done;
    assert.equal(await w.boomerang.read.totalOwed(), 0n, "settled within the one delivery");
    for (let i = 0; i < 100; i++) {
      timer += 20n;
      await keeper.deliver(beat).done;
    }
    assert.deepEqual(asks[0], { kind: "finalize", id: m.id });
    assert.equal(asks.filter((a) => a.kind === "finalize").length, 1, "told once that the outcome is set, never asked again");
    assert.equal(asks.filter((a) => a.kind === "paySide" && a.side === 1).length, 2, "the match is returned, then put to the contract once more and called finished: the outcome it was told is kept");
    assert.equal(keeper.ledger.campaigns.get(m.id)!.outcome, Outcome.Open, "the ledger has not heard");
    assert.equal(await w.boomerang.read.totalOwed(), 0n, "every return and payout was made");
    assert.equal(keeper.health().failedSends, 0);
    // The payout events never come back either, so the calls stay planned; the contract says each is finished and they stop.
    const settledAsks = asks.length;
    for (let i = 0; i < 100; i++) {
      timer += 20n;
      await keeper.deliver(beat).done;
    }
    assert.ok(asks.length - settledAsks <= 4, `asks after everything was paid: ${asks.length - settledAsks}`);
  });

  it("keeper.behindBlocked: the outcome the contract showed is kept while payouts go through one at a time, so a backer unblocked later is still paid", async function () {
    const w = await setup();
    const m = await missedCampaign(w);
    const before = await blockDeliveries(w); // everything up to the close, no outcome yet
    await w.boomerang.write.finalize([m.id], { account: w.alice.account });
    await w.usdc.write.setBlocked([w.carol.account.address, true]);
    await w.usdc.write.setBlocked([w.dave.account.address, true]);
    const k = watched(w);
    for (const d of before) k.keeper.deliver(d);
    // Clock ticks only from here: the ledger never hears the outcome, a payout or a failure.
    const beat = await tick(w);
    const run = async (rounds: number, step: bigint) => {
      for (let i = 0; i < rounds; i++) {
        k.clock.now += step;
        await k.keeper.deliver(beat).done;
      }
    };
    const paid = async (who: W["bob"]) => (await w.boomerang.read.backerOf([m.id, who.account.address])).paid;
    await run(3, 20n);
    assert.deepEqual([await paid(w.bob), await paid(w.carol), await paid(w.dave)], [true, false, false]);

    await w.usdc.write.setBlocked([w.carol.account.address, false]);
    await run(3, 700n);
    assert.deepEqual([await paid(w.carol), await paid(w.dave)], [true, false]);

    await w.usdc.write.setBlocked([w.dave.account.address, false]);
    await run(4, 1300n);
    assert.equal(await paid(w.dave), true, "paid on the outcome the contract showed, three payouts earlier");
    assert.equal(await w.boomerang.read.totalOwed(), 0n);
    assert.equal(k.keeper.ledger.campaigns.get(m.id)!.outcome, Outcome.Open, "the ledger never heard");
  });

  it("keeper.lag: a node behind the chain's head says 'open' after the true outcome is heard; the keeper waits a minute before it believes it, counted from the outcome", async function () {
    const w = await setup();
    const m = await missedCampaign(w);
    const before = await blockDeliveries(w); // closed and due, no outcome yet
    let timer = 0n;
    const asks: Action[] = [];
    // A sender whose node is behind: whatever is asked, the contract it sees is still open and not due.
    const behind: Sender = async (a) => {
      asks.push(a);
      return { ok: false, error: "open", nothing: { final: false, hold: false, owedNothing: [], blocked: [], outcome: Outcome.Open } };
    };
    const keeper = createKeeper({ boomerang: w.boomerang.address, store: memoryStore(), send: behind, timer: () => timer });
    for (const d of before) await keeper.deliver(d).done;
    await keeper.deliver(await tick(w)).done; // a clock tick at the closing time
    assert.deepEqual(asks, [{ kind: "finalize", id: m.id }], "due by the ledger, so asked; the node says not yet");
    // The ledger says open and so does the contract: there is no disagreement to report, however long it lasts.
    timer += 100n;
    await keeper.deliver(await tick(w)).done;
    assert.deepEqual(keeper.health().lastErrors, []);

    // Long after, the campaign is settled and the true Finalized event arrives.
    timer += 1000n;
    await w.boomerang.write.finalize([m.id], { account: w.alice.account });
    const after = await blockDeliveries(w);
    asks.length = 0;
    await keeper.deliver(after[after.length - 1]).done; // the block that carries Finalized
    assert.equal(keeper.ledger.campaigns.get(m.id)!.outcome, Outcome.Missed);
    const finalizes = () => asks.filter((a) => (a.kind as string) === "finalize").length;
    assert.ok(asks.length > 0 && finalizes() === 0, "payouts are asked; the old 'open' does not overrule the outcome just heard");
    const beat = await tick(w);
    timer += 20n;
    await keeper.deliver(beat).done;
    timer += 20n;
    await keeper.deliver(beat).done;
    assert.equal(finalizes(), 0, "inside the minute the ledger's outcome stands");
    assert.deepEqual(keeper.health().lastErrors, []);

    // A node that still says 'open' a minute on is not behind: the contract's word is taken.
    timer += 20n;
    asks.length = 0;
    await keeper.deliver(beat).done;
    assert.deepEqual(asks, [{ kind: "finalize", id: m.id }]);
    assert.ok(keeper.health().lastErrors.some((e) => /still open/.test(e)));
  });

  it("keeper.lagFunded: a campaign that funded early is paid soon after a node that was more than a minute behind catches up, not at its closing second", async function () {
    const w = await setup();
    const f = await w.open();
    await w.time.increaseTo(f.t.opensAt);
    await w.pledge(f.id, w.erin, f.t.target, f.t.opensAt + 10n); // funded, long before the closing second
    // For the first 100 seconds every question lands on a node that has not seen the pledge: "open".
    const k = watched(w, async (a, inner) =>
      k.clock.now <= 100n ? { ok: false, error: "open", nothing: { final: false, hold: false, owedNothing: [], blocked: [], outcome: Outcome.Open } } : inner(a),
    );
    await beats(w, k, 5); // to 100 seconds
    assert.equal((await w.boomerang.read.stateOf([f.id])).recipientPaid, false);
    assert.ok(k.keeper.health().lastErrors.some((e) => /still open/.test(e)), "after a minute of 'open' the keeper says so");
    const asked = k.asks.length;
    // The first "open" came at 20 seconds. The ledger's outcome is tried again two minutes after it, at 140.
    await beats(w, k, 1);
    assert.equal(k.asks.length, asked, "nothing at 120 seconds");
    await beats(w, k, 1);
    assert.ok(k.asks.length > asked, "asked again at 140 seconds");
    await beats(w, k, 2);
    const state = await w.boomerang.read.stateOf([f.id]);
    assert.equal(state.recipientPaid, true);
    assert.equal(state.bonusReturned, true);
    assert.equal(await w.boomerang.read.totalOwed(), 0n);
  });

  it("keeper.setStays: an outcome the contract has set is not unsaid by a later 'open' from a node that is behind", async function () {
    const w = await setup();
    const m = await missedCampaign(w);
    const before = await blockDeliveries(w);
    let timer = 0n;
    const asks: Action[] = [];
    // One node answers the finalize (the outcome is set: missed); the payouts land on a node that is behind.
    const mixed: Sender = async (a) => {
      asks.push(a);
      const outcome = a.kind === "finalize" ? Outcome.Missed : Outcome.Open;
      return { ok: false, error: "nothing", nothing: { final: a.kind === "finalize", hold: false, owedNothing: [], blocked: [], outcome } };
    };
    const keeper = createKeeper({ boomerang: w.boomerang.address, store: memoryStore(), send: mixed, timer: () => timer });
    for (const d of before) await keeper.deliver(d).done;
    const beat = await tick(w);
    for (let i = 0; i < 10; i++) {
      await keeper.deliver(beat).done;
      timer += 20n;
    }
    // The payouts keep being offered (at 0, 20, 60 and 140 seconds): "missed" stands.
    assert.equal(asks.filter((a) => a.kind === "finalize").length, 1);
    assert.equal(asks.filter((a) => a.kind === "payMany").length, 4);
  });

  it("keeper.forgedBonus: a false 'missed' that says the whole bonus pool was paid out does not stop the sponsor's bonus return when the campaign really misses", async function () {
    const w = await setup();
    const m = await w.open();
    await w.time.increaseTo(m.t.opensAt);
    await w.pledge(m.id, w.bob, 30n * USD, m.t.opensAt + 10n);
    const k = watched(w);
    for (const d of await blockDeliveries(w)) k.keeper.deliver(d);
    const now = await tick(w);
    const seq = BigInt(k.keeper.health().lastSeq) + 1n;
    await k.keeper.deliver({ ...now, logs: [forge(w, "Finalized", { seq, id: m.id, outcome: Outcome.Missed, bonusPaid: m.t.bonusPool }, now)] }).done;
    assert.equal(k.keeper.ledger.campaigns.get(m.id)!.bonusPaid, m.t.bonusPool, "the ledger took the false figure");

    await w.time.increaseTo(m.t.closesAt + 10n);
    await beats(w, k, 30);
    const state = await w.boomerang.read.stateOf([m.id]);
    assert.equal(state.outcome, Outcome.Missed);
    assert.ok(state.bonusPaid > 0n && state.bonusPaid < m.t.bonusPool, "the bonus really paid is a part of the pool");
    assert.equal(state.matchReturned, true);
    assert.equal(state.bonusReturned, true, "the rest of the pool went back to the sponsor");
    assert.equal(await w.boomerang.read.totalOwed(), 0n);

    // With everything paid the keeper goes quiet: each side has been called finished by the contract.
    const asked = k.asks.length;
    const sent = await k.sent();
    await beats(w, k, 60);
    assert.equal(k.asks.length, asked);
    assert.equal(await k.sent(), sent);
  });

  it("keeper.forgedSide: a false 'match returned' does not stop the real return; each side of a settled campaign is put to the contract until it says the side is finished", async function () {
    const w = await setup();
    const m = await missedCampaign(w); // closed and due, not settled
    const k = watched(w);
    for (const d of await blockDeliveries(w)) k.keeper.deliver(d);
    const now = await tick(w);
    const seq = BigInt(k.keeper.health().lastSeq);
    const sponsor = (await w.boomerang.read.stateOf([m.id])).sponsor;
    const logs = [
      forge(w, "Finalized", { seq: seq + 1n, id: m.id, outcome: Outcome.Missed, bonusPaid: 0n }, now),
      forge(w, "SidePaid", { seq: seq + 2n, id: m.id, side: 1, to: sponsor, amount: m.t.matchAmount }, now),
    ];
    await k.keeper.deliver({ ...now, logs }).done;
    assert.equal(k.keeper.ledger.campaigns.get(m.id)!.matchReturned, true, "the ledger took the false return");

    await beats(w, k, 30);
    const state = await w.boomerang.read.stateOf([m.id]);
    assert.equal(state.outcome, Outcome.Missed);
    assert.equal(state.matchReturned, true, "the match went back to the sponsor all the same");
    assert.equal(state.bonusReturned, true);
    assert.equal(await w.boomerang.read.totalOwed(), 0n);
    const asked = k.asks.length;
    await beats(w, k, 60);
    assert.equal(k.asks.length, asked, "and then nothing more is asked");
  });

  it("keeper.sides: on an honest ledger each side costs at most one question more than its payment, and a restart asks each side once", async function () {
    const w = await setup();
    const m = await missedCampaign(w);
    const store = memoryStore();
    const asks: Action[] = [];
    let timer = 0n;
    const inner = makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address });
    const make = () =>
      createKeeper({
        boomerang: w.boomerang.address,
        store,
        send: async (a) => {
          asks.push(a);
          return inner(a);
        },
        timer: () => timer,
      });
    const keeper = make();
    for (let i = 0; i < 10; i++) {
      timer += 20n;
      await pump(w, keeper, 1);
    }
    assert.equal(await w.boomerang.read.totalOwed(), 0n);
    const sides = (from: number) => asks.slice(from).filter((a) => a.kind === "paySide").map((a) => (a.kind === "paySide" ? a.side : -1)).sort();
    // Recipient: nothing to pay on a missed campaign, asked once. The two returns: paid, then asked once more and called finished.
    assert.deepEqual(sides(0), [0, 1, 1, 2, 2]);
    assert.equal(await w.publicClient.getTransactionCount({ address: w.stranger.account.address }), 4, "finalize, two returns, one payMany");

    // A keeper started again over the same store does not remember what the contract called finished.
    const from = asks.length;
    const again = make();
    for (let i = 0; i < 10; i++) {
      timer += 20n;
      await pump(w, again, 1);
    }
    assert.deepEqual(sides(from), [0, 1, 2]);
    assert.equal(asks.length - from, 3, "three questions, and nothing else");
    assert.equal(await w.publicClient.getTransactionCount({ address: w.stranger.account.address }), 4);
  });

  it("keeper.voidGap: with an event missing from the ledger, a campaign with a pot missing is still voided at its opening second, and one whose pot was funded in the gap costs questions and no gas", async function () {
    const w = await setup();
    const a = await w.open({}, { skipMatch: true }); // seq 1 created, 2 bonus funded: the match pot never comes
    const b = await w.open(); // seq 3 created, 4 match funded, 5 bonus funded
    const k = watched(w);
    // The block with b's match (seq 4) never reaches the keeper: to its ledger, b has a pot missing too.
    const kept = (await blockDeliveries(w)).filter((d) => !decodeLogs(d.logs, w.boomerang.address).some((e) => e.seq === 4n));
    await w.time.increaseTo(b.t.opensAt + 10n);
    const beat = await tick(w);
    for (let i = 0; i < 10; i++) {
      k.clock.now += 20n;
      for (const d of kept) k.keeper.deliver(d);
      await k.keeper.deliver(beat).done;
    }
    assert.deepEqual(k.keeper.health().missing, { from: "4", to: "4" });
    const voided = await w.boomerang.read.stateOf([a.id]);
    assert.equal(voided.outcome, Outcome.Void, "the campaign with a pot truly missing is void");
    assert.equal(voided.bonusReturned, true, "and its bonus pot went back");
    assert.equal((await w.boomerang.read.stateOf([b.id])).outcome, Outcome.Open, "the funded campaign is untouched");
    assert.ok(k.asks.some((x) => x.kind === "finalize" && x.id === b.id), "the keeper asked about it");
    assert.equal(await k.sent(), 2, "one finalize and one return for the void campaign, nothing for the other");
    assert.deepEqual(k.keeper.health().lastErrors, []);
  });

  it("keeper.voidGuess: a false event on the number of a real 'pot funded' makes the keeper take a funded campaign for void; told 'not due' four times it stops asking until the closing second, then settles", async function () {
    const w = await setup();
    const b = await w.open(); // seq 1 created, 2 match funded, 3 bonus funded
    const k = watched(w);
    // The block with the match (seq 2) is held back, a false event takes its number, and the real one then counts as a repeat.
    const kept = (await blockDeliveries(w)).filter((d) => !decodeLogs(d.logs, w.boomerang.address).some((e) => e.seq === 2n));
    for (const d of kept) k.keeper.deliver(d);
    const now = await tick(w);
    const far = { ...b.t, opensAt: 10n ** 12n, earlyUntil: 10n ** 12n + 1n, closesAt: 10n ** 12n + 2n };
    await k.keeper.deliver({ ...now, logs: [forge(w, "CampaignCreated", { seq: 2n, id: 999n, sponsor: w.alice.account.address, terms: far }, now)] }).done;
    for (const d of await blockDeliveries(w)) k.keeper.deliver(d);
    assert.equal(k.keeper.ledger.campaigns.get(b.id)!.matchIn, false, "to the ledger the match never came");

    // Two hours past the opening second, a delivery every twenty seconds.
    await w.time.increaseTo(b.t.opensAt + 10n);
    const beat = await tick(w);
    for (let i = 0; i < 360; i++) {
      k.clock.now += 20n;
      await k.keeper.deliver(beat).done;
    }
    assert.deepEqual(k.asks, [0, 1, 2, 3].map(() => ({ kind: "finalize", id: b.id })), "asked at 20, 40, 80 and 160 seconds, then no more");
    assert.equal(await k.sent(), 0);
    assert.deepEqual(k.keeper.health().lastErrors, []);

    // At the closing second the contract decides for itself, and the keeper settles and returns both pots.
    await w.time.increaseTo(b.t.closesAt);
    await beats(w, k, 20);
    const state = await w.boomerang.read.stateOf([b.id]);
    assert.equal(state.outcome, Outcome.Missed);
    assert.equal(state.matchReturned, true);
    assert.equal(state.bonusReturned, true);
    assert.equal(await w.boomerang.read.totalOwed(), 0n);
    assert.equal(await k.sent(), 3, "finalize and the two returns");
  });

  it("keeper.absent: a false 'campaign created' for a number the contract does not have is asked about at doubling intervals, with no gas and no error lines", async function () {
    const w = await setup();
    const m = await w.open();
    const k = watched(w);
    for (const d of await blockDeliveries(w)) k.keeper.deliver(d);
    const now = await tick(w);
    const terms = { ...m.t, opensAt: 1n, earlyUntil: 2n, closesAt: 3n };
    const created = forge(w, "CampaignCreated", { seq: BigInt(k.keeper.health().lastSeq) + 1n, id: 999n, sponsor: w.alice.account.address, terms }, now);
    await k.keeper.deliver({ ...now, logs: [created] }).done;
    assert.ok(k.keeper.ledger.campaigns.has(999n), "the false campaign is in the ledger, long past its closing second");
    // Two hours of deliveries, one every twenty seconds.
    for (let i = 0; i < 360; i++) {
      k.clock.now += 20n;
      await k.keeper.deliver(now).done;
    }
    // Asked at 0, 20, 60, 140, 300, 620, 1260, 2540 and 5100 seconds.
    assert.equal(k.asks.length, 9);
    assert.ok(k.asks.every((x) => x.id === 999n));
    assert.deepEqual(k.keeper.health().absent, ["999"], "health names it");
    assert.deepEqual(k.keeper.health().lastErrors, []);
    assert.equal(k.keeper.health().failedSends, 0);
    assert.equal(await k.sent(), 0);
    // A hundred hours more, a delivery an hour. The wait doubles to 81,920 seconds (about 23 hours) and stays there:
    // asked in hours 3, 6, 12, 24, 47, 70 and 93.
    for (let i = 0; i < 100; i++) {
      k.clock.now += 3600n;
      await k.keeper.deliver(now).done;
    }
    assert.equal(k.asks.length, 16);
    assert.equal(await k.sent(), 0);
  });

  it("keeper.absentLag: a real campaign that a node behind the chain's head does not have yet is asked about again and settled", async function () {
    const w = await setup();
    const m = await missedCampaign(w);
    // Asked twice, the node does not have the campaign. The third time it has it, a block short of the closing second.
    const k = watched(w, async (a, inner) => {
      const nth = k.asks.length;
      if (nth <= 2) return { ok: false, error: "none", nothing: { final: false, hold: false, owedNothing: [], blocked: [], absent: true } };
      if (nth === 3) return { ok: false, error: "not due", nothing: { final: false, hold: false, owedNothing: [], blocked: [], outcome: Outcome.Open } };
      return inner(a);
    });
    while (k.asks.length < 2) await beats(w, k, 1);
    assert.deepEqual(k.keeper.health().absent, [String(m.id)]);
    while (k.asks.length < 3) await beats(w, k, 1);
    assert.deepEqual(k.keeper.health().absent, [], "any other answer shows the node has it");
    await beats(w, k, 10);
    assert.equal((await w.boomerang.read.stateOf([m.id])).outcome, Outcome.Missed);
    assert.equal(await w.boomerang.read.totalOwed(), 0n);
    assert.deepEqual(k.keeper.health().absent, [], "once the node has it, it is no longer listed");
    assert.deepEqual(k.keeper.health().lastErrors, []);
  });

  it("keeper.paidMeansSet: a payout that goes through shows the outcome is set, so an earlier 'open' from a node that was behind is dropped", async function () {
    const w = await setup();
    const m = await missedCampaign(w);
    await w.boomerang.write.finalize([m.id], { account: w.alice.account });
    const first = new Set<string>();
    // The first time each call is asked the node is behind and says "open"; after that every call goes through.
    const k = watched(w, async (a) => {
      const key = actionKey(a);
      if (!first.has(key)) {
        first.add(key);
        return { ok: false, error: "open", nothing: { final: false, hold: false, owedNothing: [], blocked: [], outcome: Outcome.Open } };
      }
      return { ok: true, hash: "0x00" };
    });
    for (const d of await blockDeliveries(w)) await k.keeper.deliver(d).done; // the true outcome is heard
    const beat = await tick(w);
    for (let i = 0; i < 6; i++) {
      k.clock.now += 20n;
      await k.keeper.deliver(beat).done;
    }
    assert.equal(k.clock.now, 120n);
    assert.ok(k.asks.some((a) => a.kind === "payMany"));
    assert.equal(k.asks.filter((a) => a.kind === "finalize").length, 0, "the campaign is not taken for open again");
    assert.deepEqual(k.keeper.health().lastErrors, []);
  });

  it("sender.absent: asked about a campaign the contract does not have, the real sender says so for each kind of call and marks nothing refused", async function () {
    const w = await setup();
    await w.open();
    const send = makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address });
    const calls: Action[] = [
      { kind: "finalize", id: 999n },
      { kind: "paySide", id: 999n, side: 1 },
      { kind: "payMany", id: 999n, backers: [w.bob.account.address] },
    ];
    for (const action of calls) {
      const r = await send(action);
      assert.equal(r.ok, false);
      if (r.ok) continue;
      assert.equal(r.reverted, undefined, action.kind);
      assert.deepEqual(r.nothing, { final: false, hold: false, owedNothing: [], blocked: [], absent: true }, action.kind);
    }
    assert.equal(await w.publicClient.getTransactionCount({ address: w.stranger.account.address }), 0);
  });

  it("keeper.noEffect: a call that goes through and changes nothing is sent at doubling intervals, then dropped and reported", async function () {
    const w = await setup();
    const m = await missedCampaign(w);
    let timer = 0n;
    const sentAt: bigint[] = [];
    // A sender that says yes and does nothing: what a keeper fed false events would meet.
    const keeper = createKeeper({
      boomerang: w.boomerang.address,
      store: memoryStore(),
      send: async () => {
        sentAt.push(timer);
        return { ok: true, hash: `0x${"00".repeat(32)}` };
      },
      timer: () => timer,
      maxTries: 4,
    });
    for (const d of await blockDeliveries(w)) keeper.deliver(d);
    const beat = await tick(w);
    for (; timer <= 2_000n; timer += 1n) await keeper.deliver(beat).done;
    // finalize is the only call planned. Waits of 20, 40 and 80 seconds, then no more.
    assert.deepEqual(sentAt, [0n, 20n, 60n, 140n]);
    assert.deepEqual(keeper.health().gaveUp, [`finalize:${m.id}`]);
    assert.equal(keeper.health().lastErrors.filter((e) => /gave up on finalize/.test(e)).length, 1);

    // The campaign then really moves (someone settles it by hand): the keeper takes up the new plan.
    await w.boomerang.write.finalize([m.id], { account: w.stranger.account });
    for (const d of await blockDeliveries(w)) keeper.deliver(d);
    await keeper.deliver(await tick(w)).done;
    assert.deepEqual(keeper.health().gaveUp, []);
    assert.ok(sentAt.length > 4);
  });

  it("keeper.blockedBackoff: a payout that keeps failing is offered after ten minutes, then twenty, then forty, not every ten for ever", async function () {
    const w = await setup();
    const m = await missedCampaign(w);
    await w.usdc.write.setBlocked([w.bob.account.address, true]);
    let timer = 0n;
    const payManyAt: bigint[] = [];
    const inner = makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address });
    const keeper = createKeeper({
      boomerang: w.boomerang.address,
      store: memoryStore(),
      send: async (action) => {
        if (action.kind === "payMany" && action.backers.some((b) => b.toLowerCase() === w.bob.account.address.toLowerCase())) payManyAt.push(timer);
        return inner(action);
      },
      timer: () => timer,
    });
    const round = async () => {
      for (const d of await blockDeliveries(w)) keeper.deliver(d);
      await keeper.deliver(await tick(w)).done;
    };
    for (let i = 0; i < 4; i++) await round(); // finalize, sides, payMany: Bob's payout fails once
    assert.deepEqual(payManyAt, [0n]);
    assert.equal((await w.boomerang.read.backerOf([m.id, w.bob.account.address])).paid, false);

    timer = 599n;
    await round();
    assert.deepEqual(payManyAt, [0n]);
    timer = 600n;
    await round(); // offered again; fails again
    await round();
    assert.deepEqual(payManyAt, [0n, 600n]);
    timer = 600n + 1_199n;
    await round();
    assert.deepEqual(payManyAt, [0n, 600n]);
    timer = 600n + 1_200n;
    await round(); // offered a third time; fails again
    await round(); // the failure reaches the keeper: the next wait is forty minutes
    assert.deepEqual(payManyAt, [0n, 600n, 1_800n]);
    timer = 1_800n + 2_399n;
    await round();
    assert.deepEqual(payManyAt, [0n, 600n, 1_800n]);

    // Unblocked, the next offer pays him. A redirect would have cleared the wait at once (keeper.blocked).
    await w.usdc.write.setBlocked([w.bob.account.address, false]);
    timer = 1_800n + 2_400n;
    await round();
    await round();
    assert.equal((await w.boomerang.read.backerOf([m.id, w.bob.account.address])).paid, true);
    assert.equal(await w.boomerang.read.totalOwed(), 0n);
  });

  it("keeper.late: an old delivery arriving after a newer one does not turn the clock or the newest block back", async function () {
    const w = await setup();
    await missedCampaign(w);
    const keeper = createKeeper({ boomerang: w.boomerang.address, store: memoryStore(), send: async () => ({ ok: false, error: "not sending in this test" }) });
    const now = await tick(w);
    keeper.deliver(now);
    const shown = keeper.health();
    assert.equal(shown.lastBlock, now.toBlock);

    keeper.deliver({ ...now, fromBlock: now.toBlock - 5, toBlock: now.toBlock - 5, time: now.time - 500 });
    const after = keeper.health();
    assert.equal(after.lastTime, shown.lastTime);
    assert.equal(after.lastBlock, shown.lastBlock);
  });

  it("keeper.deliveryShape: a delivery is just its four fields, and health carries none of the removed ones", async function () {
    const w = await setup();
    await missedCampaign(w);
    const keeper = createKeeper({ boomerang: w.boomerang.address, store: memoryStore(), send: async () => ({ ok: false, error: "not sending in this test" }) });
    const [one] = await blockDeliveries(w);
    const d: Delivery = { fromBlock: one.fromBlock, toBlock: one.toBlock, time: one.time, logs: one.logs };
    const taken = keeper.deliver(d);
    await taken.done;
    assert.ok(taken.applied > 0, "the delivery's logs were applied");
    assert.equal(keeper.health().lastBlock, one.toBlock);
    const h = keeper.health() as unknown as Record<string, unknown>;
    for (const gone of ["lastDeliveryAt", "lastBeatBlock", "streamBlock", "kvError", "deliveries"]) {
      assert.equal(gone in h, false, `health should not carry ${gone}`);
    }
  });

  it("keeper.storeDown: when the store cannot be written the delivery fails whole and nothing is applied; it applies once the store is back", async function () {
    const w = await setup();
    await missedCampaign(w);
    const inner = memoryStore();
    let down = true;
    const store = { ...inner, append: (events: Parameters<typeof inner.append>[0]) => {
      if (down) throw new Error("disk full");
      inner.append(events);
    } };
    const keeper = createKeeper({ boomerang: w.boomerang.address, store, send: async () => ({ ok: false, error: "not sending in this test" }) });
    const [first] = await blockDeliveries(w);
    assert.throws(() => keeper.deliver(first), /disk full/);
    assert.equal(keeper.health().lastSeq, "0");
    assert.equal(keeper.feed().length, 0);
    assert.equal(inner.load().length, 0);
    down = false;
    const r = keeper.deliver(first);
    assert.ok(r.applied >= 1);
    assert.equal(inner.load().length, r.applied);
  });

  it("sender.refused: the real sender marks a call the contract refuses, and only that", async function () {
    const w = await setup();
    const m = await missedCampaign(w); // due: the sender's questions pass and it goes on to send
    const send = makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address });
    // No campaign 99 exists. That is nothing to send, and not a refusal (sender.absent has the rest).
    const noSuch = await send({ kind: "finalize", id: 99n });
    assert.equal(noSuch.ok, false);
    assert.equal(noSuch.ok === false && noSuch.reverted, undefined);
    assert.equal(noSuch.ok === false && noSuch.nothing?.absent, true);
    // A side whose payee the token will not pay: the contract refuses, and nothing is sent.
    const settledOne = await missedCampaign(w);
    await w.boomerang.write.finalize([settledOne.id], { account: w.alice.account });
    await w.usdc.write.setBlocked([(await w.boomerang.read.stateOf([settledOne.id])).sponsor, true]);
    const blockedSide = await send({ kind: "paySide", id: settledOne.id, side: 1 });
    assert.equal(blockedSide.ok === false && blockedSide.reverted, true, blockedSide.ok === false ? blockedSide.error : "");
    assert.equal(blockedSide.ok === false && blockedSide.nothing, undefined);
    assert.equal(await w.publicClient.getTransactionCount({ address: w.stranger.account.address }), 0);
    // A node that cannot be reached is not a refusal.
    const dead = createPublicClient({ transport: http("http://127.0.0.1:9", { retryCount: 0, timeout: 500 }) });
    const deadWallet = createWalletClient({ account: w.stranger.account, chain: w.stranger.chain, transport: http("http://127.0.0.1:9", { retryCount: 0, timeout: 500 }) });
    const lost = await makeSender({ publicClient: dead, walletClient: deadWallet, boomerang: w.boomerang.address })({ kind: "finalize", id: 99n });
    assert.equal(lost.ok, false);
    assert.equal(lost.ok === false && lost.reverted, undefined);

    // A wallet whose node answers the sending calls with `fault`; everything else goes to the real chain.
    const sendingFails = (fault: () => Error, also: string[] = []) => {
      const transport = custom({
        request: async (args: { method: string; params?: unknown }) => {
          if (["eth_sendTransaction", "eth_sendRawTransaction", "eth_estimateGas", ...also].includes(args.method)) throw fault();
          return w.publicClient.request(args as never);
        },
      });
      return { transport, wallet: createWalletClient({ account: w.stranger.account, chain: w.stranger.chain, transport }) };
    };

    // A node that answers "internal error: nonce too low" has not run the contract at all. The
    // library files that under the same heading as a revert; the sender must not.
    const flaky = sendingFails(() => Object.assign(new Error("nonce too low"), { code: -32603 }));
    const nonce = await makeSender({ publicClient: w.publicClient, walletClient: flaky.wallet, boomerang: w.boomerang.address })({ kind: "finalize", id: m.id });
    assert.equal(nonce.ok, false);
    assert.equal(nonce.ok === false && nonce.reverted, undefined, nonce.ok === false ? nonce.error : "");
    assert.equal(nonce.ok === false && nonce.nothing, undefined);

    // An account short of gas money is told "gas required exceeds allowance". The library names
    // that like a refusal; it is not the contract saying no.
    const poor = sendingFails(() => Object.assign(new Error("gas required exceeds allowance (0)"), { code: -32000 }));
    const short = await makeSender({ publicClient: w.publicClient, walletClient: poor.wallet, boomerang: w.boomerang.address })({ kind: "finalize", id: m.id });
    assert.equal(short.ok, false);
    assert.equal(short.ok === false && short.reverted, undefined, short.ok === false ? short.error : "");

    // Some nodes answer a refusal with no data, only the words. That is still the contract saying
    // no, whether it comes when the call is sent...
    const bare = sendingFails(() => Object.assign(new Error("execution reverted"), { code: -32000 }));
    const wordless = await makeSender({ publicClient: w.publicClient, walletClient: bare.wallet, boomerang: w.boomerang.address })({ kind: "finalize", id: m.id });
    assert.equal(wordless.ok, false);
    assert.equal(wordless.ok === false && wordless.reverted, true, wordless.ok === false ? wordless.error : "");
    // ...or when the sender first asks.
    const mute = sendingFails(() => Object.assign(new Error("execution reverted"), { code: -32000 }), ["eth_call"]);
    const asked = await makeSender({ publicClient: createPublicClient({ transport: mute.transport }), walletClient: mute.wallet, boomerang: w.boomerang.address })({ kind: "finalize", id: m.id });
    assert.equal(asked.ok === false && asked.reverted, true, asked.ok === false ? asked.error : "");
  });

  it("sender.asks: the real sender asks the contract first and sends only what will change something", async function () {
    const w = await setup();
    const m = await missedCampaign(w);
    const open = await w.open(); // a second campaign, nowhere near due
    const send = makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address });
    const sentCount = () => w.publicClient.getTransactionCount({ address: w.stranger.account.address });
    const events = () => w.boomerang.read.eventCount();
    const none = (r: SendResult) => (r.ok ? undefined : r.nothing);
    const bob = w.bob.account.address;
    const carol = w.carol.account.address;
    const made: Address[] = ["0x000000000000000000000000000000000000f001", "0x000000000000000000000000000000000000f002"];

    // Not due: nothing sent, and the answer may change later.
    const notDue = await send({ kind: "finalize", id: open.id });
    assert.deepEqual(none(notDue), { final: false, hold: false, owedNothing: [], blocked: [], outcome: Outcome.Open });
    // Backers and sides cannot be paid while the contract shows no outcome: nothing is sent, and it is asked again later.
    const early = await send({ kind: "payMany", id: m.id, backers: [bob] });
    assert.deepEqual(none(early), { final: false, hold: false, owedNothing: [], blocked: [], outcome: Outcome.Open });
    const earlySide = await send({ kind: "paySide", id: m.id, side: 1 });
    assert.deepEqual(none(earlySide), { final: false, hold: false, owedNothing: [], blocked: [], outcome: Outcome.Open });
    assert.equal(await sentCount(), 0);

    // Due: sent. Asked again: the outcome is set, for good.
    assert.equal((await send({ kind: "finalize", id: m.id })).ok, true);
    assert.equal(await sentCount(), 1);
    assert.deepEqual(none(await send({ kind: "finalize", id: m.id })), { final: true, hold: false, owedNothing: [], blocked: [], outcome: Outcome.Missed });

    // A side is paid once; after that the contract has nothing to pay there, for good.
    assert.equal((await send({ kind: "paySide", id: m.id, side: 1 })).ok, true);
    assert.deepEqual(none(await send({ kind: "paySide", id: m.id, side: 1 })), { final: true, hold: false, owedNothing: [], blocked: [], outcome: Outcome.Missed });
    assert.equal(await sentCount(), 2);

    // A batch naming a real backer and two made-up ones: only the real one is in the call.
    const mixed = await send({ kind: "payMany", id: m.id, backers: [bob, ...made] });
    assert.equal(mixed.ok, true);
    assert.deepEqual(mixed.ok && mixed.owedNothing, made);
    assert.equal((await w.boomerang.read.backerOf([m.id, bob])).paid, true);
    assert.equal(await sentCount(), 3);
    // Paid or made up, nobody in this batch is owed: nothing is sent.
    const again = await send({ kind: "payMany", id: m.id, backers: [bob, made[0]] });
    assert.deepEqual(none(again), { final: false, hold: false, owedNothing: [bob, made[0]], blocked: [], outcome: Outcome.Missed });

    // A backer the token will not pay: the call would go through and pay no one, so it is not sent.
    await w.usdc.write.setBlocked([carol, true]);
    const eventsBefore = await events();
    const blocked = await send({ kind: "payMany", id: m.id, backers: [carol, made[1]] });
    assert.deepEqual(none(blocked), { final: false, hold: false, owedNothing: [made[1]], blocked: [carol], outcome: Outcome.Missed });
    assert.equal(await events(), eventsBefore);
    assert.equal(await sentCount(), 3);

    // A funded campaign has no backer to pay.
    const f = await w.open();
    await w.time.increaseTo(f.t.opensAt);
    await w.pledge(f.id, w.erin, f.t.target, f.t.opensAt + 10n);
    assert.equal((await w.boomerang.read.stateOf([f.id])).outcome, Outcome.Funded);
    assert.deepEqual(none(await send({ kind: "payMany", id: f.id, backers: [w.erin.account.address] })), { final: false, hold: true, owedNothing: [], blocked: [], outcome: Outcome.Funded });
    assert.equal(await sentCount(), 3);
  });

  it("sender.fresh: each call reads the contract at the node's newest block, not at a block number the client remembered", async function () {
    // Found on a chain that mines on a timer (2026-11-15): a viem client keeps the block number
    // for some seconds unless told not to. The keeper settled a campaign, heard the Finalized
    // event, and then read the contract at the remembered block, from before its own settlement,
    // so the payouts looked refused and waited ten minutes. Hardhat's own test clients switch
    // that memory off, so this test builds its client the way the keeper's main.ts does.
    const w = await setup();
    const m = await missedCampaign(w);
    const asIs = createPublicClient({ chain: w.publicClient.chain, transport: custom({ request: (args: { method: string; params?: unknown }) => w.publicClient.request(args as never) }) });
    assert.ok(asIs.cacheTime > 0, "the client under test must be one that remembers");
    const send = makeSender({ publicClient: asIs as never, walletClient: w.stranger, boomerang: w.boomerang.address });
    assert.equal((await send({ kind: "finalize", id: m.id })).ok, true);
    // At once, well inside the client's memory of the block number:
    const side = await send({ kind: "paySide", id: m.id, side: 1 });
    assert.equal(side.ok, true, side.ok ? "" : side.error);
    const paid = await send({ kind: "payMany", id: m.id, backers: [w.bob.account.address] });
    assert.equal(paid.ok, true, paid.ok ? "" : paid.error);
    assert.equal((await w.boomerang.read.backerOf([m.id, w.bob.account.address])).paid, true);
  });

  it("sender.behind: a node that has not caught up with the settlement is asked again later; nothing is refused and nothing is held", async function () {
    // The keeper may hear one node and its sender read another that is a block or two behind.
    const w = await setup();
    const m = await missedCampaign(w);
    const before = await w.publicClient.getBlockNumber();
    const real = makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address });
    assert.equal((await real({ kind: "finalize", id: m.id })).ok, true);
    // A node that still answers with the block from before the settlement.
    const behind = createPublicClient({
      chain: w.publicClient.chain,
      transport: custom({ request: (args: { method: string; params?: unknown }) => (args.method === "eth_blockNumber" ? Promise.resolve(`0x${before.toString(16)}`) : w.publicClient.request(args as never)) }),
    });
    const send = makeSender({ publicClient: behind as never, walletClient: w.stranger, boomerang: w.boomerang.address });
    const sentCount = () => w.publicClient.getTransactionCount({ address: w.stranger.account.address });
    const sentBefore = await sentCount();
    const waiting = { final: false, hold: false, owedNothing: [], blocked: [], outcome: Outcome.Open };
    for (const action of [
      { kind: "paySide", id: m.id, side: 1 },
      { kind: "paySide", id: m.id, side: 2 },
      { kind: "payMany", id: m.id, backers: [w.bob.account.address] },
    ] as Action[]) {
      const r = await send(action);
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.reverted, undefined, "not a refusal");
      assert.deepEqual(!r.ok && r.nothing, waiting, action.kind);
    }
    assert.equal(await sentCount(), sentBefore);
  });

  it("desk.usdc: gives once, refuses a repeat, a low desk and a bad address, and recovers from a failed transfer", async function () {
    const w = await setup();
    await w.usdc.write.mint([w.erin.account.address, 1_000_000_000n]);
    const desk = createDesk({
      publicClient: w.publicClient,
      walletClient: w.erin,
      boomerang: w.boomerang.address,
      usdc: w.usdc.address,
      recipient: w.recipient.account.address,
      store: memoryStore(),
      ledger: () => emptyLedger(),
    });

    const target = w.alice.account.address;
    const before = await w.balance({ address: target });
    const r = await desk.giveUsdc(target);
    assert.ok(r.ok);
    assert.equal(await w.balance({ address: target }), before + DEMO.usdc);

    // The same address in another letter case is already-given.
    assert.deepEqual(await desk.giveUsdc(target.toLowerCase()), { ok: false, reason: "already-given" });

    // A zero or malformed address is refused.
    assert.deepEqual(await desk.giveUsdc(ZERO), { ok: false, reason: "bad-address" });
    assert.deepEqual(await desk.giveUsdc("not-an-address"), { ok: false, reason: "bad-address" });
    // So are the desk itself, the contract and the token: a slug sent there helps nobody.
    for (const own of [w.erin.account.address, w.boomerang.address, w.usdc.address]) {
      assert.deepEqual(await desk.giveUsdc(own), { ok: false, reason: "bad-address" }, own);
    }

    // A desk below floor + the slug is desk-low.
    await w.usdc.write.mint([w.bob.account.address, DEMO.floor + DEMO.usdc - 1n]);
    const low = createDesk({
      publicClient: w.publicClient,
      walletClient: w.bob,
      boomerang: w.boomerang.address,
      usdc: w.usdc.address,
      recipient: w.recipient.account.address,
      store: memoryStore(),
      ledger: () => emptyLedger(),
    });
    assert.deepEqual(await low.giveUsdc(w.dave.account.address), { ok: false, reason: "desk-low" });

    // A failed transfer answers failed and leaves the address free to ask again.
    const blocked = w.carol.account.address;
    await w.usdc.write.setBlocked([blocked, true]);
    const failed = await desk.giveUsdc(blocked);
    assert.equal(failed.ok, false);
    assert.equal(failed.ok === false && failed.reason, "failed");
    await w.usdc.write.setBlocked([blocked, false]);
    const retry = await desk.giveUsdc(blocked);
    assert.ok(retry.ok);
  });

  it("desk.turns: two requests at once for one address give one slug; two addresses at once are both recorded", async function () {
    const w = await setup();
    await w.usdc.write.mint([w.erin.account.address, 1_000_000_000n]);
    const desk = createDesk({
      publicClient: w.publicClient,
      walletClient: w.erin,
      boomerang: w.boomerang.address,
      usdc: w.usdc.address,
      recipient: w.recipient.account.address,
      store: memoryStore(),
      ledger: () => emptyLedger(),
    });

    const one = w.alice.account.address;
    const before = await w.balance({ address: one });
    const pair = await Promise.all([desk.giveUsdc(one), desk.giveUsdc(one)]);
    assert.deepEqual(pair.map((r) => r.ok).sort(), [false, true]);
    assert.equal(await w.balance({ address: one }), before + DEMO.usdc);

    const two = w.bob.account.address;
    const three = w.carol.account.address;
    const both = await Promise.all([desk.giveUsdc(two), desk.giveUsdc(three)]);
    assert.deepEqual(both.map((r) => r.ok), [true, true]);
    assert.deepEqual(await desk.giveUsdc(two), { ok: false, reason: "already-given" });
    assert.deepEqual(await desk.giveUsdc(three), { ok: false, reason: "already-given" });

    // More requests than the line holds are turned away at once, not queued without end.
    const many = await Promise.all(Array.from({ length: 14 }, () => desk.giveUsdc(w.dave.account.address)));
    assert.ok(many.some((r) => !r.ok && r.reason === "busy"));
    assert.equal(many.filter((r) => r.ok).length, 1);
  });

  it("desk.lag: while the ledger has not heard of the desk's last campaign, a second one is refused; after its deadline a new one is allowed", async function () {
    const w = await setup();
    await w.usdc.write.mint([w.erin.account.address, 1_000_000_000n]);
    const desk = createDesk({
      publicClient: w.publicClient,
      walletClient: w.erin,
      boomerang: w.boomerang.address,
      usdc: w.usdc.address,
      recipient: w.recipient.account.address,
      store: memoryStore(),
      ledger: () => emptyLedger(), // a keeper told nothing yet
    });
    const first = await desk.openCampaign();
    assert.ok(first.ok);
    assert.deepEqual(await desk.openCampaign(), { ok: false, reason: "campaign-open" });
    const t = await w.boomerang.read.termsOf([BigInt(first.ok ? first.id! : "0")]);
    await w.time.increaseTo(t.closesAt);
    const second = await desk.openCampaign();
    assert.ok(second.ok, JSON.stringify(second));
  });

  it("desk.unconfirmed: a transfer that was sent but whose receipt never came is not undone, so the address cannot be paid twice", async function () {
    const w = await setup();
    await w.usdc.write.mint([w.erin.account.address, 1_000_000_000n]);
    let lose = true;
    const lossy = new Proxy(w.publicClient, {
      get(target, prop, receiver) {
        if (prop !== "waitForTransactionReceipt") return Reflect.get(target, prop, receiver);
        return async (args: never) => {
          const receipt = await target.waitForTransactionReceipt(args); // the transfer is mined...
          if (lose) throw new Error("timed out waiting for the receipt"); // ...but the desk never hears
          return receipt;
        };
      },
    });
    const desk = createDesk({
      publicClient: lossy as typeof w.publicClient,
      walletClient: w.erin,
      boomerang: w.boomerang.address,
      usdc: w.usdc.address,
      recipient: w.recipient.account.address,
      store: memoryStore(),
      ledger: () => emptyLedger(),
    });
    const target = w.alice.account.address;
    const before = await w.balance({ address: target });
    const r = await desk.giveUsdc(target);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "unconfirmed");
    assert.equal(await w.balance({ address: target }), before + DEMO.usdc);
    lose = false;
    assert.deepEqual(await desk.giveUsdc(target), { ok: false, reason: "already-given" });
    assert.equal(await w.balance({ address: target }), before + DEMO.usdc);
  });

  it("desk.floor: while a transfer is unconfirmed the desk gives nothing more, so it is never taken below its floor", async function () {
    const w = await setup();
    await w.usdc.write.mint([w.erin.account.address, DEMO.floor + DEMO.usdc + 500_000n]); // 5.50: room for one slug
    let stalled = true;
    const noReceipt = new Proxy(w.publicClient, {
      get(target, prop, receiver) {
        if (prop !== "waitForTransactionReceipt") return Reflect.get(target, prop, receiver);
        return async (args: never) => {
          if (stalled) throw new Error("timed out waiting for the receipt");
          return target.waitForTransactionReceipt(args);
        };
      },
    });
    const desk = createDesk({
      publicClient: noReceipt as typeof w.publicClient,
      walletClient: w.erin,
      boomerang: w.boomerang.address,
      usdc: w.usdc.address,
      recipient: w.recipient.account.address,
      store: memoryStore(),
      ledger: () => emptyLedger(),
    });
    // Blocks stop: a transfer can be sent, but the balance the chain reports does not move.
    await w.publicClient.request({ method: "evm_setAutomine" as never, params: [false] as never });
    try {
      const first = await desk.giveUsdc(w.alice.account.address);
      assert.equal(first.ok === false && first.reason, "unconfirmed");
      // The confirmed balance still reads 5.50, which would pass the floor check a second time.
      assert.equal(await w.balance({ address: w.erin.account.address }), DEMO.floor + DEMO.usdc + 500_000n);
      for (const who of [w.bob, w.carol]) {
        const next = await desk.giveUsdc(who.account.address);
        assert.equal(next.ok === false && next.reason, "busy", JSON.stringify(next));
      }
      const campaign = await desk.openCampaign();
      assert.equal(campaign.ok === false && campaign.reason, "busy", JSON.stringify(campaign));
    } finally {
      await w.publicClient.request({ method: "evm_mine" as never, params: [] as never });
      await w.publicClient.request({ method: "evm_setAutomine" as never, params: [true] as never });
      stalled = false;
    }
    // One slug left, and only one. The desk is at 3.50, above its floor, and now says it is low.
    assert.equal(await w.balance({ address: w.erin.account.address }), DEMO.floor + 500_000n);
    assert.deepEqual(await desk.giveUsdc(w.bob.account.address), { ok: false, reason: "desk-low" });
    // An address turned away while the desk was waiting was not recorded: it may ask again.
    await w.usdc.write.mint([w.erin.account.address, DEMO.usdc]);
    assert.ok((await desk.giveUsdc(w.carol.account.address)).ok);
  });

  it("desk.lostReply: a send whose reply was lost may still have gone out, so the record stays and the address is paid once", async function () {
    const w = await setup();
    await w.usdc.write.mint([w.erin.account.address, 1_000_000_000n]);
    let lose = true;
    const flaky = new Proxy(w.erin, {
      get(target, prop, receiver) {
        if (prop !== "sendTransaction") return Reflect.get(target, prop, receiver);
        return async (args: never) => {
          const hash = await (target.sendTransaction as (a: never) => Promise<`0x${string}`>)(args); // the node takes the transfer...
          if (lose) throw new Error("HTTP request timed out"); // ...and its answer never arrives
          return hash;
        };
      },
    });
    const desk = createDesk({
      publicClient: w.publicClient,
      walletClient: flaky as typeof w.erin,
      boomerang: w.boomerang.address,
      usdc: w.usdc.address,
      recipient: w.recipient.account.address,
      store: memoryStore(),
      ledger: () => emptyLedger(),
    });
    const target = w.alice.account.address;
    const before = await w.balance({ address: target });
    const r = await desk.giveUsdc(target);
    assert.equal(r.ok === false && r.reason, "unconfirmed", JSON.stringify(r));
    lose = false;
    assert.deepEqual(await desk.giveUsdc(target), { ok: false, reason: "already-given" });
    assert.equal(await w.balance({ address: target }), before + DEMO.usdc);

    // A fault before anything is sent (here, the node cannot be asked whether the transfer would
    // go through) records nothing: the address may simply ask again.
    let down = true;
    const unreachable = new Proxy(w.publicClient, {
      get(target, prop, receiver) {
        if (prop !== "simulateContract") return Reflect.get(target, prop, receiver);
        return async (args: never) => {
          if (down) throw new Error("HTTP request failed");
          return (target.simulateContract as (a: never) => Promise<unknown>)(args);
        };
      },
    });
    const store = memoryStore();
    const early = createDesk({
      publicClient: unreachable as typeof w.publicClient,
      walletClient: w.erin,
      boomerang: w.boomerang.address,
      usdc: w.usdc.address,
      recipient: w.recipient.account.address,
      store,
      ledger: () => emptyLedger(),
    });
    const bob = w.bob.account.address;
    const bobBefore = await w.balance({ address: bob });
    const notSent = await early.giveUsdc(bob);
    assert.equal(notSent.ok === false && notSent.reason, "failed", JSON.stringify(notSent));
    assert.equal(store.readNote("demo-given"), undefined);
    assert.equal(await w.balance({ address: bob }), bobBefore);
    down = false;
    assert.ok((await early.giveUsdc(bob)).ok);
    assert.equal(await w.balance({ address: bob }), bobBefore + DEMO.usdc);

    // A transfer the token itself refuses is the other case: nothing was sent, nothing is recorded.
    const blocked = w.carol.account.address;
    await w.usdc.write.setBlocked([blocked, true]);
    const refused = await desk.giveUsdc(blocked);
    assert.equal(refused.ok === false && refused.reason, "failed");
    await w.usdc.write.setBlocked([blocked, false]);
    assert.ok((await desk.giveUsdc(blocked)).ok);
  });

  it("desk.notSent: a fault before the transfer leaves records nothing, and a receipt that came back reverted undoes the record", async function () {
    const w = await setup();
    await w.usdc.write.mint([w.erin.account.address, 1_000_000_000n]);
    const given = (store: ReturnType<typeof memoryStore>) => store.readNote<string[]>("demo-given") ?? [];
    const deskWith = (over: { publicClient?: typeof w.publicClient; walletClient?: typeof w.erin }, store = memoryStore()) => ({
      store,
      desk: createDesk({
        publicClient: over.publicClient ?? w.publicClient,
        walletClient: over.walletClient ?? w.erin,
        boomerang: w.boomerang.address,
        usdc: w.usdc.address,
        recipient: w.recipient.account.address,
        store,
        ledger: () => emptyLedger(),
      }),
    });
    const wallet = (method: "prepareTransactionRequest", instead: (pass: () => Promise<unknown>) => Promise<unknown>) =>
      new Proxy(w.erin, {
        get(target, prop, receiver) {
          if (prop !== method) return Reflect.get(target, prop, receiver);
          return (args: never) => instead(() => (target[method] as (a: never) => Promise<unknown>)(args));
        },
      }) as typeof w.erin;

    // The node cannot be asked for the gas: nothing has been sent, so nothing is recorded and the address may ask again.
    let down = true;
    const a = deskWith({ walletClient: wallet("prepareTransactionRequest", (pass) => (down ? Promise.reject(new Error("HTTP request failed. Status: 503")) : pass())) });
    const alice = w.alice.account.address;
    const before = await w.balance({ address: alice });
    const notSent = await a.desk.giveUsdc(alice);
    assert.equal(notSent.ok === false && notSent.reason, "failed", JSON.stringify(notSent));
    assert.deepEqual(given(a.store), []);
    down = false;
    assert.ok((await a.desk.giveUsdc(alice)).ok);
    assert.equal(await w.balance({ address: alice }), before + DEMO.usdc);

    // A receipt that says the transfer was mined and reverted: the record is undone.
    const reverted = new Proxy(w.publicClient, {
      get(target, prop, receiver) {
        if (prop !== "waitForTransactionReceipt") return Reflect.get(target, prop, receiver);
        return async (args: never) => ({ ...(await target.waitForTransactionReceipt(args)), status: "reverted" });
      },
    }) as typeof w.publicClient;
    const c = deskWith({ publicClient: reverted });
    const r = await c.desk.giveUsdc(w.carol.account.address);
    assert.equal(r.ok === false && r.reason, "failed", JSON.stringify(r));
    assert.deepEqual(given(c.store), []);
  });

  it("desk.ownKey: with a key held by the process, a transfer made ready asks the node nothing more: only the send itself is in doubt", async function () {
    const w = await setup();
    const account = privateKeyToAccount(generatePrivateKey()); // made for this test and thrown away
    await w.publicClient.request({ method: "hardhat_setBalance" as never, params: [account.address, "0x56bc75e2d63100000"] as never });
    await w.usdc.write.mint([account.address, 1_000_000_000n]);
    let fault: "none" | "gas" | "reply" = "gas";
    const sentRaw: string[] = [];
    const transport = custom({
      request: async (args: { method: string; params?: unknown }) => {
        if (args.method === "eth_estimateGas" && fault === "gas") throw new Error("HTTP request failed. Status: 503");
        // Once a transfer is made ready, the node is asked nothing more before it is sent.
        if (args.method === "eth_chainId") throw new Error("HTTP request failed. Status: 503");
        if (args.method === "eth_sendTransaction") throw new Error("a key held by the process never asks the node to sign");
        if (args.method === "eth_sendRawTransaction") {
          sentRaw.push(String((args.params as unknown[])[0]));
          const hash = await w.publicClient.request(args as never);
          if (fault === "reply") throw new Error("HTTP request timed out");
          return hash;
        }
        return w.publicClient.request(args as never);
      },
    });
    const store = memoryStore();
    const desk = createDesk({
      publicClient: createPublicClient({ chain: w.erin.chain, transport }),
      walletClient: createWalletClient({ account, chain: w.erin.chain, transport }),
      boomerang: w.boomerang.address,
      usdc: w.usdc.address,
      recipient: w.recipient.account.address,
      store,
      ledger: () => emptyLedger(),
    });
    const alice = w.alice.account.address;
    const before = await w.balance({ address: alice });

    // The gas cannot be asked for: nothing was signed or sent, nothing recorded.
    const notSent = await desk.giveUsdc(alice);
    assert.equal(notSent.ok === false && notSent.reason, "failed", JSON.stringify(notSent));
    assert.equal(sentRaw.length, 0);
    assert.equal(store.readNote("demo-given"), undefined);

    // The node takes the signed transfer and its answer is lost: it may be out, so the record stays, and it is paid once.
    fault = "reply";
    const lost = await desk.giveUsdc(alice);
    assert.equal(lost.ok === false && lost.reason, "unconfirmed", JSON.stringify(lost));
    assert.equal(sentRaw.length, 1);
    fault = "none";
    assert.deepEqual(await desk.giveUsdc(alice), { ok: false, reason: "already-given" });
    assert.equal(await w.balance({ address: alice }), before + DEMO.usdc);

    // With nothing in the way it gives, and opens a campaign, through the same path.
    assert.ok((await desk.giveUsdc(w.bob.account.address)).ok);
    const opened = await desk.openCampaign();
    assert.ok(opened.ok, JSON.stringify(opened));
    assert.equal((await w.boomerang.read.stateOf([1n])).sponsor.toLowerCase(), account.address.toLowerCase());
  });

  it("desk.restart: a desk started again over the same store still knows the campaign it opened, or began to open", async function () {
    const w = await setup();
    await w.usdc.write.mint([w.erin.account.address, 1_000_000_000n]);
    const store = memoryStore();
    const start = (publicClient = w.publicClient, walletClient = w.erin) =>
      createDesk({
        publicClient,
        walletClient,
        boomerang: w.boomerang.address,
        usdc: w.usdc.address,
        recipient: w.recipient.account.address,
        store,
        ledger: () => emptyLedger(), // no delivery has carried the campaign yet
      });

    // The creation cannot even be made ready: nothing was sent, nothing is remembered.
    const cannotPrepare = new Proxy(w.erin, {
      get(target, prop, receiver) {
        return prop === "prepareTransactionRequest" ? async () => Promise.reject(new Error("HTTP request failed")) : Reflect.get(target, prop, receiver);
      },
    }) as typeof w.erin;
    const none = await start(w.publicClient, cannotPrepare).openCampaign();
    assert.equal(none.ok === false && none.reason, "failed");
    assert.equal(store.readNote("demo-last"), undefined);
    assert.equal(await w.boomerang.read.campaignCount(), 0n);

    // The creation is sent and the process dies before its receipt comes: the campaign exists, unfunded.
    const noReceipt = new Proxy(w.publicClient, {
      get(target, prop, receiver) {
        return prop === "waitForTransactionReceipt" ? async () => Promise.reject(new Error("the process stopped here")) : Reflect.get(target, prop, receiver);
      },
    }) as typeof w.publicClient;
    const cut = await start(noReceipt).openCampaign();
    assert.equal(cut.ok === false && cut.reason, "failed");
    assert.equal(await w.boomerang.read.campaignCount(), 1n);
    // A new process, the same store: it does not open a second one beside it.
    assert.deepEqual(await start().openCampaign(), { ok: false, reason: "campaign-open" });
    assert.equal(await w.boomerang.read.campaignCount(), 1n);

    // Once that one's time is over, a campaign is opened in full, and a restart knows it too.
    await w.time.increaseTo((await w.boomerang.read.termsOf([1n])).closesAt);
    const first = await start().openCampaign();
    assert.ok(first.ok, JSON.stringify(first));
    assert.deepEqual(await start().openCampaign(), { ok: false, reason: "campaign-open" });
    assert.equal(await w.boomerang.read.campaignCount(), 2n);

    // A note that is not what the desk wrote is ignored: not trusted, and not a crash.
    await w.time.increaseTo((await w.boomerang.read.termsOf([2n])).closesAt);
    for (const note of [{ id: "x", closesAt: "5" }, { id: "1", closesAt: "-5" }, { id: 1, closesAt: 2 }, { id: "1" }, "text", { id: "2", closesAt: `1${"0".repeat(29)}` }]) {
      store.writeNote("demo-last", note);
      const again = await start().openCampaign();
      assert.ok(again.ok, `${JSON.stringify(note)} -> ${JSON.stringify(again)}`);
      await w.time.increaseTo((await w.boomerang.read.termsOf([BigInt(again.ok ? again.id! : "0")])).closesAt);
    }
  });

  it("desk.two: a two-minute campaign has the same pots on shorter times, is funded before it opens, pays a lone early backer back with a bonus, and shares the one-at-a-time rule", async function () {
    const w = await setup();
    await w.usdc.write.mint([w.erin.account.address, 1_000_000_000n]);
    const store = memoryStore();
    const keeper = createKeeper({
      boomerang: w.boomerang.address,
      store,
      send: makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address }),
    });
    const desk = createDesk({
      publicClient: w.publicClient,
      walletClient: w.erin,
      boomerang: w.boomerang.address,
      usdc: w.usdc.address,
      recipient: w.recipient.account.address,
      store,
      ledger: () => keeper.ledger,
    });

    // The two kinds, as fixed numbers: the ten-minute one is unchanged.
    assert.deepEqual(DESK_KINDS, {
      ten: { opensIn: 60n, earlyFor: 360n, openFor: 600n, linearWeight: true },
      two: { opensIn: 45n, earlyFor: 72n, openFor: 120n, linearWeight: false },
    });
    assert.deepEqual([DEMO.opensIn, DEMO.earlyFor, DEMO.openFor], [60n, 360n, 600n]);

    const before = BigInt(await w.time.latest());
    const r = await desk.openCampaign("two");
    assert.ok(r.ok && r.id, JSON.stringify(r));
    const id = BigInt(r.id!);

    const t = await w.boomerang.read.termsOf([id]);
    assert.deepEqual([t.opensAt - before, t.earlyUntil - t.opensAt, t.closesAt - t.opensAt], [45n, 72n, 120n]);
    assert.deepEqual([t.target, t.minPledge, t.matchAmount, t.bonusPool, t.rateBps], [DEMO.target, DEMO.minPledge, DEMO.match, DEMO.pool, DEMO.rateBps]);
    // The short kind's bonus does not shrink inside its early window: over 72 seconds a
    // shrinking one falls a cent every few seconds, faster than a visitor can read and press.
    assert.deepEqual([t.linearWeight, t.bonusFromRecipient], [false, false]);
    const s = await w.boomerang.read.stateOf([id]);
    assert.ok(s.matchIn && s.bonusIn, "both pots are in");
    assert.ok(BigInt(await w.time.latest()) < t.opensAt, "it is not open yet");

    // One desk campaign at a time, whatever its kind: before the keeper has heard, and after.
    assert.deepEqual(await desk.openCampaign("ten"), { ok: false, reason: "campaign-open" });
    // A desk started again over the same store believes the note it finds, though the note is
    // for the short kind and the ledger it is handed has heard of nothing.
    const restarted = createDesk({
      publicClient: w.publicClient,
      walletClient: w.erin,
      boomerang: w.boomerang.address,
      usdc: w.usdc.address,
      recipient: w.recipient.account.address,
      store,
      ledger: () => emptyLedger(),
    });
    assert.deepEqual(await restarted.openCampaign("two"), { ok: false, reason: "campaign-open" });
    assert.deepEqual(await restarted.openCampaign("ten"), { ok: false, reason: "campaign-open" });
    assert.deepEqual(await desk.openCampaign("two"), { ok: false, reason: "campaign-open" });
    for (const d of await blockDeliveries(w)) keeper.deliver(d);
    assert.deepEqual(await desk.openCampaign(), { ok: false, reason: "campaign-open" });
    assert.deepEqual(await desk.openCampaign("two"), { ok: false, reason: "campaign-open" });
    assert.equal(await w.boomerang.read.campaignCount(), 1n);

    // A lone early backer cannot meet the target: at the deadline the keeper settles it as
    // missed, and the pledge comes back with a bonus from the pool.
    // The contract's own answer for the desk's 2.00 is the same early and late in the early
    // window, so the figure on the cheque holds still while it is read; after the window, nothing.
    const pledge = DEMO.usdc;
    const answers: bigint[] = [];
    for (const at of [t.opensAt + 5n, t.opensAt + 40n, t.earlyUntil - 20n]) {
      await w.time.increaseTo(at);
      answers.push((await w.boomerang.read.quoteIfMissed([id, pledge]))[2]);
    }
    assert.deepEqual(answers, [200_000n, 200_000n, 200_000n]);
    await w.pledge(id, w.alice, pledge, t.earlyUntil - 5n); // late in the window; the helper mints exactly this much to the backer first
    assert.equal(await w.usdc.read.balanceOf([w.alice.account.address]), 0n);
    await w.time.increaseTo(t.earlyUntil);
    assert.equal((await w.boomerang.read.quoteIfMissed([id, 100_000n]))[2], 0n); // a pledge after the early window earns no bonus
    await w.time.increaseTo(t.closesAt);
    await pump(w, keeper, 4);
    assert.equal((await w.boomerang.read.stateOf([id])).outcome, Outcome.Missed);
    assert.equal(await w.usdc.read.balanceOf([w.alice.account.address]), pledge + 200_000n); // 2.00 back, plus 0.20

    // Once it is settled, either kind may open; the default is still the ten-minute one.
    const r2 = await desk.openCampaign();
    assert.ok(r2.ok && r2.id, JSON.stringify(r2));
    const t2 = await w.boomerang.read.termsOf([BigInt(r2.id!)]);
    assert.deepEqual([t2.earlyUntil - t2.opensAt, t2.closesAt - t2.opensAt, t2.linearWeight], [360n, 600n, true]);
    assert.deepEqual(await desk.openCampaign("two"), { ok: false, reason: "campaign-open" });

    // A kind the desk does not know opens nothing.
    await w.time.increaseTo(t2.closesAt);
    await pump(w, keeper, 4);
    for (const kind of ["an hour", "constructor", "__proto__", "toString", ""]) {
      const odd = await desk.openCampaign(kind as never);
      assert.deepEqual([odd.ok, odd.ok ? "" : odd.reason], [false, "failed"], kind);
    }
    assert.equal(await w.boomerang.read.campaignCount(), 2n);
  });

  it("desk.campaign: opens a DEMO campaign, refuses a second while open, allows a new one once settled, and is desk-low when poor", async function () {
    const w = await setup();
    await w.usdc.write.mint([w.erin.account.address, 1_000_000_000n]);
    const store = memoryStore();
    const keeper = createKeeper({
      boomerang: w.boomerang.address,
      store,
      send: makeSender({ publicClient: w.publicClient, walletClient: w.stranger, boomerang: w.boomerang.address }),
    });
    const desk = createDesk({
      publicClient: w.publicClient,
      walletClient: w.erin,
      boomerang: w.boomerang.address,
      usdc: w.usdc.address,
      recipient: w.recipient.account.address,
      store,
      ledger: () => keeper.ledger,
    });

    const r1 = await desk.openCampaign();
    assert.ok(r1.ok && r1.id);
    const id = BigInt(r1.id!);

    const t = await w.boomerang.read.termsOf([id]);
    assert.equal(t.recipient.toLowerCase(), w.recipient.account.address.toLowerCase());
    assert.equal(t.target, DEMO.target);
    assert.equal(t.minPledge, DEMO.minPledge);
    assert.equal(t.matchAmount, DEMO.match);
    assert.equal(t.bonusPool, DEMO.pool);
    assert.equal(t.rateBps, DEMO.rateBps);
    assert.equal(t.linearWeight, true);
    assert.equal(t.bonusFromRecipient, false);
    assert.equal(t.earlyUntil - t.opensAt, DEMO.earlyFor);
    assert.equal(t.closesAt - t.opensAt, DEMO.openFor);

    const s = await w.boomerang.read.stateOf([id]);
    assert.ok(s.matchIn && s.bonusIn, "both pots are in");
    assert.ok(BigInt(await w.time.latest()) < t.opensAt, "it is not open yet");

    // Let the keeper learn the campaign, then a second open is refused.
    for (const d of await blockDeliveries(w)) keeper.deliver(d);
    assert.deepEqual(await desk.openCampaign(), { ok: false, reason: "campaign-open" });

    // Once the keeper finalizes it, a new one is allowed.
    await w.time.increaseTo(t.closesAt);
    await pump(w, keeper, 3);
    const r3 = await desk.openCampaign();
    assert.ok(r3.ok);

    // That one is funded well before it closes. As soon as the keeper has heard, the desk may
    // open another: it knows which campaign was its last, not only when it would have closed.
    const id3 = BigInt(r3.ok ? r3.id! : "0");
    const t3 = await w.boomerang.read.termsOf([id3]);
    await w.fund(w.alice, DEMO.target);
    await w.pledge(id3, w.alice, DEMO.target, t3.opensAt + 5n); // more than the gap: the contract takes only what completes it
    assert.equal((await w.boomerang.read.stateOf([id3])).outcome, Outcome.Funded);
    assert.ok(BigInt(await w.time.latest()) < t3.closesAt);
    assert.deepEqual(await desk.openCampaign(), { ok: false, reason: "campaign-open" }); // the keeper has not heard yet
    for (const d of await blockDeliveries(w)) keeper.deliver(d);
    const r4 = await desk.openCampaign();
    assert.ok(r4.ok, JSON.stringify(r4));

    // A desk below floor + the two pots is desk-low.
    await w.usdc.write.mint([w.dave.account.address, DEMO.floor + DEMO.match + DEMO.pool - 1n]);
    const low = createDesk({
      publicClient: w.publicClient,
      walletClient: w.dave,
      boomerang: w.boomerang.address,
      usdc: w.usdc.address,
      recipient: w.recipient.account.address,
      store: memoryStore(),
      ledger: () => keeper.ledger,
    });
    assert.deepEqual(await low.openCampaign(), { ok: false, reason: "desk-low" });
  });
});
