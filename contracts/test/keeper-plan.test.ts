// Every amount and account in these tests is invented. None is a reading of any real campaign.
//
// The keeper's planner, driven against the live contract: the plan is computed from the
// event-built ledger alone, each planned call is made by an account with no role, and the
// loop must end with the contract owing nothing but rounding dust.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress } from "viem";

import { setup, Outcome, Side, USD } from "./helpers.ts";
import { applyEvents, decodeLogs, emptyLedger, type Ledger, type RawLog } from "../../packages/kit/src/index.ts";
import { BATCH, nextActions, settled, type Action } from "../../services/keeper/src/plan.ts";

type Setup = Awaited<ReturnType<typeof setup>>;

/** Every Boomerang log so far, with its block's time, in the shape a delivery carries. */
async function ledgerOf(w: Setup): Promise<Ledger> {
  const logs = await w.publicClient.getLogs({ address: w.boomerang.address, fromBlock: 0n });
  const raw: RawLog[] = [];
  for (const lg of logs) {
    const block = await w.publicClient.getBlock({ blockNumber: lg.blockNumber! });
    raw.push({ address: lg.address, topics: lg.topics, data: lg.data, blockNumber: lg.blockNumber, blockTimestamp: block.timestamp });
  }
  const ledger = emptyLedger();
  applyEvents(ledger, decodeLogs(raw, w.boomerang.address));
  return ledger;
}

/** Make one planned call from an account with no role in any campaign. */
async function act(w: Setup, a: Action) {
  const from = { account: w.stranger.account };
  if (a.kind === "finalize") return w.boomerang.write.finalize([a.id], from);
  if (a.kind === "paySide") return w.boomerang.write.paySide([a.id, a.side], from);
  return w.boomerang.write.payMany([a.id, a.backers], from);
}

/** Plan, act, re-read, until the plan is empty. Returns every action taken, in order. */
async function runToEnd(w: Setup, rounds = 10): Promise<Action[]> {
  const taken: Action[] = [];
  for (let i = 0; i < rounds; i++) {
    const ledger = await ledgerOf(w);
    const plan = nextActions(ledger, BigInt(await w.time.latest()));
    if (plan.length === 0) {
      assert.ok(settled(ledger), "an empty plan must mean a settled ledger");
      return taken;
    }
    for (const a of plan) await act(w, a);
    taken.push(...plan);
  }
  assert.fail(`the plan did not empty in ${rounds} rounds`);
}

describe("keeper plan", async function () {
  it("before any deadline there is nothing to do", async function () {
    const w = await setup();
    const { id, t } = await w.open();
    await w.pledge(id, w.alice, 30n * USD, t.opensAt + 10n);
    const ledger = await ledgerOf(w);
    assert.deepEqual(nextActions(ledger, t.closesAt - 1n), []);
    assert.deepEqual(nextActions(ledger, t.closesAt), [{ kind: "finalize", id }]);
  });

  it("a missed campaign: finalize, then both returns and every backer, and nothing is left owed but dust", async function () {
    const w = await setup();
    const { id, t } = await w.open();
    await w.pledge(id, w.alice, 30n * USD, t.opensAt + 10n);
    await w.pledge(id, w.bob, 20n * USD, t.opensAt + 20n);
    await w.pledge(id, w.carol, 10n * USD, t.earlyUntil + 5n);
    await w.time.increaseTo(t.closesAt);

    const taken = await runToEnd(w);
    assert.deepEqual(taken[0], { kind: "finalize", id });
    assert.deepEqual(
      taken.slice(1).map((a) => (a.kind === "paySide" ? `side${a.side}` : a.kind)),
      [`side${Side.MatchReturn}`, `side${Side.BonusReturn}`, "payMany"],
    );
    const backers = (taken[3] as Extract<Action, { kind: "payMany" }>).backers;
    assert.equal(backers.length, 3);
    assert.equal((await w.boomerang.read.stateOf([id])).outcome, Outcome.Missed);
    assert.equal(await w.balance(w.alice), 30n * USD + 750_000n);
    assert.equal(await w.balance(w.bob), 20n * USD + 500_000n);
    assert.equal(await w.balance(w.carol), 10n * USD);
    assert.equal(await w.boomerang.read.totalOwed(), 0n);
  });

  it("a funded campaign pays the recipient and returns the bonus pool; no backer is paid", async function () {
    const w = await setup();
    const { id, t } = await w.open();
    await w.pledge(id, w.alice, 100n * USD, t.opensAt + 10n);
    const taken = await runToEnd(w);
    assert.deepEqual(taken, [
      { kind: "paySide", id, side: Side.Recipient },
      { kind: "paySide", id, side: Side.BonusReturn },
    ]);
    assert.equal(await w.balance(w.recipient), 120n * USD);
    assert.equal(await w.boomerang.read.totalOwed(), 0n);
  });

  it("a void campaign is finalized at its opening second and only the funded pot goes back", async function () {
    const w = await setup();
    const { id, t } = await w.open({}, { skipBonus: true });
    assert.deepEqual(nextActions(await ledgerOf(w), t.opensAt - 1n), []);
    await w.time.increaseTo(t.opensAt);
    const taken = await runToEnd(w);
    assert.deepEqual(taken, [
      { kind: "finalize", id },
      { kind: "paySide", id, side: Side.MatchReturn },
    ]);
    assert.equal((await w.boomerang.read.stateOf([id])).outcome, Outcome.Void);
    assert.equal(await w.boomerang.read.totalOwed(), 0n);
  });

  it("many backers are paid in batches, a skipped backer is left for the next round, and repeating the plan pays no one twice", async function () {
    const w = await setup();
    const { id, t } = await w.open({ target: 1_000n * USD, matchAmount: 0n, bonusPool: 0n });
    const wallets = await w.viem.getWalletClients();
    const many = wallets.slice(2, 2 + 12);
    await w.time.increaseTo(t.opensAt);
    for (const who of many) await w.pledge(id, who, 2n * USD);
    await w.time.increaseTo(t.closesAt);
    await act(w, { kind: "finalize", id });

    const ledger = await ledgerOf(w);
    const now = BigInt(await w.time.latest());
    const skipped = many[0].account.address.toLowerCase();
    const plan = nextActions(ledger, now, new Set([`${id}:${skipped}`]));
    const named = plan.flatMap((a) => (a.kind === "payMany" ? a.backers : []));
    assert.equal(named.length, 11);
    assert.ok(!named.includes(skipped as `0x${string}`));
    assert.ok(plan.every((a) => a.kind !== "payMany" || a.backers.length <= BATCH));

    // the same stale plan made twice: the second pass must move no money
    for (const a of plan) await act(w, a);
    const owedAfterOnce = await w.boomerang.read.totalOwed();
    for (const a of plan) await act(w, a);
    assert.equal(await w.boomerang.read.totalOwed(), owedAfterOnce);
    assert.equal(owedAfterOnce, 2n * USD, "only the skipped backer is still owed");

    const rest = await runToEnd(w);
    assert.deepEqual(rest, [{ kind: "payMany", id, backers: [skipped] }]);
    assert.equal(await w.boomerang.read.totalOwed(), 0n);
  });

  it("a skip key is matched whatever its letter case", async function () {
    const w = await setup();
    const { id, t } = await w.open({ matchAmount: 0n, bonusPool: 0n });
    await w.pledge(id, w.alice, 5n * USD, t.opensAt + 10n);
    await w.time.increaseTo(t.closesAt);
    await act(w, { kind: "finalize", id });
    const ledger = await ledgerOf(w);
    const checksummed = getAddress(w.alice.account.address); // as viem decodes it from an event
    assert.notEqual(checksummed, checksummed.toLowerCase(), "the test needs a mixed-case address");
    assert.deepEqual(nextActions(ledger, t.closesAt, new Set([`${id}:${checksummed}`])), []);
    assert.equal(nextActions(ledger, t.closesAt).length, 1);
  });

  it("95 backers are named once each, in batches of 40, 40 and 15", async function () {
    const w = await setup();
    const { id, t } = await w.open({ target: 1_000n * USD, matchAmount: 0n, bonusPool: 0n });
    await w.time.increaseTo(t.opensAt);
    const payer = w.alice;
    await w.fund(payer, 95n * USD);
    const backers: `0x${string}`[] = [];
    for (let i = 1; i <= 95; i++) {
      const backer = `0x${i.toString(16).padStart(40, "0")}` as `0x${string}`;
      backers.push(backer);
      await w.boomerang.write.pledgeFor([id, backer, 1n * USD], { account: payer.account });
    }
    await w.time.increaseTo(t.closesAt);
    await act(w, { kind: "finalize", id });
    const plan = nextActions(await ledgerOf(w), t.closesAt);
    const batches = plan.filter((a) => a.kind === "payMany") as Extract<Action, { kind: "payMany" }>[];
    assert.deepEqual(batches.map((b) => b.backers.length), [40, 40, 15]);
    assert.deepEqual(batches.flatMap((b) => b.backers).sort(), [...backers].sort());
    for (const a of plan) await act(w, a);
    assert.equal(await w.boomerang.read.totalOwed(), 0n);
    for (const backer of [backers[0], backers[39], backers[40], backers[94]]) {
      assert.equal(await w.balance({ address: backer }), 1n * USD);
    }
  });

  it("with events missing, a campaign whose pot the ledger has not seen is still planned as void: the sender asks the contract before it sends", async function () {
    const w = await setup();
    const { id, t } = await w.open();
    const logs = await w.publicClient.getLogs({ address: w.boomerang.address, fromBlock: 0n });
    const events = decodeLogs(logs as unknown as RawLog[], w.boomerang.address);
    assert.equal(events.length, 3, "created, match funded, bonus funded");
    // the match's PotFunded (seq 2) never arrives: the ledger stops at seq 1 with seq 3 parked
    const gapped = emptyLedger();
    applyEvents(gapped, [events[0], events[2]]);
    assert.equal(gapped.lastSeq, 1n);
    assert.deepEqual(nextActions(gapped, t.opensAt - 1n), []);
    // sent blind this finalize would revert NotDue; the sender asks first (keeper.voidGap), so it costs a question
    assert.deepEqual(nextActions(gapped, t.opensAt), [{ kind: "finalize", id }]);
    assert.deepEqual(nextActions(gapped, t.closesAt), [{ kind: "finalize", id }]);
    // the complete ledger, with a pot truly missing, finalizes at the opening second
    const { id: id2, t: t2 } = await w.open({}, { skipMatch: true });
    assert.deepEqual(nextActions(await ledgerOf(w), t2.opensAt).filter((a) => a.id === id2), [{ kind: "finalize", id: id2 }]);
  });

  it("a side whose payee the token refuses: the call fails whole, the backers are still paid, and it pays once the payee can receive", async function () {
    const w = await setup();
    const { id, t } = await w.open();
    await w.pledge(id, w.alice, 30n * USD, t.opensAt + 10n);
    await w.time.increaseTo(t.closesAt);
    await act(w, { kind: "finalize", id });
    await w.usdc.write.setBlocked([w.sponsor.account.address, true]);

    const plan = nextActions(await ledgerOf(w), t.closesAt);
    assert.equal(plan.filter((a) => a.kind === "paySide").length, 2, "both returns go to the sponsor");
    let failed = 0;
    for (const a of plan) {
      try {
        await act(w, a);
      } catch {
        failed++;
        assert.equal(a.kind, "paySide", "only the sponsor's sides may fail");
      }
    }
    assert.equal(failed, 2);
    assert.equal(await w.balance(w.alice), 30n * USD + 450_000n); // 5% of 30, scaled by 30/100 pledged early
    // the plan keeps naming the unpaid sides: backing off is the caller's job
    assert.equal(nextActions(await ledgerOf(w), t.closesAt).length, 2);
    assert.equal(settled(await ledgerOf(w)), false);

    await w.usdc.write.setBlocked([w.sponsor.account.address, false]);
    await runToEnd(w);
    assert.equal(await w.boomerang.read.totalOwed(), 0n);
  });
});
