// Every amount and account in these tests is invented. None is a reading of any real campaign.
//
// The page's call lists, sent through the same function the page uses, against the live
// in-memory contract.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Outcome, USD, setup } from "./helpers.ts";
import { finalizeCall, payCall, pledgeCalls, redirectCall, sendEach, type Step } from "../../web/src/flows/calls.ts";

describe("web flows", async function () {
  it("a first pledge approves exactly the amount and then pledges; a second, already allowed, sends one call", async function () {
    const w = await setup();
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt + 5n);
    await w.usdc.write.mint([w.alice.account.address, 100n * USD]);
    const base = { boomerang: w.boomerang.address, usdc: w.usdc.address, id };
    const allowance = () => w.usdc.read.allowance([w.alice.account.address, w.boomerang.address]);

    const steps: Step[] = [];
    const first = pledgeCalls({ ...base, amount: 30n * USD, allowance: await allowance() });
    assert.deepEqual(first.map((c) => c.functionName), ["approve", "pledge"]);
    assert.deepEqual(first[0].args, [w.boomerang.address, 30n * USD]);
    const hashes = await sendEach({ publicClient: w.publicClient, walletClient: w.alice, account: w.alice.account, calls: first, onStep: (s) => steps.push(s) });
    assert.equal(hashes.length, 2);
    assert.deepEqual(steps.map((s) => `${s.index}:${s.state}`), ["0:asking", "0:sent", "0:done", "1:asking", "1:sent", "1:done"]);
    assert.equal((await w.boomerang.read.backerOf([id, w.alice.account.address])).principal, 30n * USD);
    assert.equal(await allowance(), 0n, "nothing is left approved after the pledge");

    await w.usdc.write.approve([w.boomerang.address, 10n * USD], { account: w.alice.account });
    const second = pledgeCalls({ ...base, amount: 10n * USD, allowance: await allowance() });
    assert.deepEqual(second.map((c) => c.functionName), ["pledge"]);
    await sendEach({ publicClient: w.publicClient, walletClient: w.alice, account: w.alice.account, calls: second });
    assert.equal((await w.boomerang.read.backerOf([id, w.alice.account.address])).principal, 40n * USD);
  });

  it("a call the contract would refuse stops before anything is sent, with the contract's error", async function () {
    const w = await setup();
    const { id } = await w.open(); // not open yet
    await w.usdc.write.mint([w.alice.account.address, 10n * USD]);
    await w.usdc.write.approve([w.boomerang.address, 10n * USD], { account: w.alice.account });
    const calls = pledgeCalls({ boomerang: w.boomerang.address, usdc: w.usdc.address, id, amount: 10n * USD, allowance: 10n * USD });
    const steps: Step[] = [];
    const blockBefore = await w.publicClient.getBlockNumber();
    await assert.rejects(
      sendEach({ publicClient: w.publicClient, walletClient: w.alice, account: w.alice.account, calls, onStep: (s) => steps.push(s) }),
      (e: Error) => /NotOpen|not open|reverted/i.test(e.message),
    );
    assert.deepEqual(steps.map((s) => s.state), ["asking"]);
    assert.equal(await w.publicClient.getBlockNumber(), blockBefore, "no transaction was sent");
    assert.equal(await w.usdc.read.balanceOf([w.alice.account.address]), 10n * USD);
  });

  it("anyone can settle a missed campaign and send a backer's refund; only the backer can point it elsewhere", async function () {
    const w = await setup();
    const { id, t } = await w.open();
    await w.pledge(id, w.alice, 30n * USD, t.opensAt + 10n);
    await w.time.increaseTo(t.closesAt);
    const base = { boomerang: w.boomerang.address, id };
    const send = (who: typeof w.alice, calls: Parameters<typeof sendEach>[0]["calls"]) =>
      sendEach({ publicClient: w.publicClient, walletClient: who, account: who.account, calls });

    await send(w.stranger, [finalizeCall(base)]);
    assert.equal((await w.boomerang.read.stateOf([id])).outcome, Outcome.Missed);
    await assert.rejects(send(w.stranger, [redirectCall({ ...base, to: w.erin.account.address })]));
    await send(w.alice, [redirectCall({ ...base, to: w.erin.account.address })]);
    await send(w.stranger, [payCall({ ...base, backer: w.alice.account.address })]);
    assert.equal(await w.balance(w.erin), 30n * USD + 450_000n);
    assert.equal(await w.balance(w.stranger), 0n, "the sender of a refund gets none of it");
  });
});
