// Every amount and account in these tests is invented. None is a reading of any real campaign.
// How the contract behaves when the token misbehaves, and that no guarded function can be re-entered.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { network } from "hardhat";
import { encodeErrorResult, encodeFunctionData, parseEventLogs } from "viem";

import { Outcome, Side, USD, refused, setup } from "./helpers.ts";

const Mode = { Normal: 0, SaysNo: 1, Silent: 2, Fee: 3, Garbled: 4 } as const;

describe("a token that misbehaves", async function () {
  const w = await setup("OddToken");
  const { boomerang, sponsor, alice, bob, stranger, viem, publicClient } = w;
  const odd = await viem.getContractAt("OddToken", w.usdc.address);

  // The tests share one chain. Each starts from a well-behaved token, whatever the last one left.
  beforeEach(async function () {
    await odd.write.setMode([Mode.Normal]);
  });

  /**
   * Nothing about a refused pledge may stay behind. Also: the payer had the money and the
   * allowance for `amount`, so the refusal came from the token's behaviour, not from the setup.
   */
  async function nothingRecorded(id: bigint, owedBefore: bigint, amount: bigint, who = alice) {
    assert.ok((await w.usdc.read.balanceOf([who.account.address])) >= amount, "the payer lacked the money");
    assert.ok(
      (await w.usdc.read.allowance([who.account.address, boomerang.address])) >= amount,
      "the payer lacked the allowance",
    );
    assert.equal(await boomerang.read.totalOwed(), owedBefore);
    assert.equal((await boomerang.read.backerOf([id, who.account.address])).principal, 0n);
    assert.equal((await boomerang.read.stateOf([id])).pledged, 0n);
    await w.assertCustody();
  }

  it("a token that answers no on the way in: the pledge and the pot are refused", async function () {
    const { id, t } = await w.open();
    const t2 = await w.terms();
    await boomerang.write.createCampaign([t2], { account: sponsor.account });
    const unfunded = await boomerang.read.campaignCount();
    await w.fund(sponsor, 30n * USD);
    await w.fund(alice, 10n * USD);
    const owed = await boomerang.read.totalOwed();
    await odd.write.setMode([Mode.SaysNo]);
    await refused(boomerang.write.fundMatch([unfunded], { account: sponsor.account }), "TransferFailed");
    await refused(boomerang.write.fundBonus([unfunded], { account: sponsor.account }), "TransferFailed");
    assert.equal((await boomerang.read.stateOf([unfunded])).matchIn, false);
    assert.equal((await boomerang.read.stateOf([unfunded])).bonusIn, false);
    await w.time.increaseTo(t.opensAt);
    await refused(boomerang.write.pledge([id, 10n * USD], { account: alice.account }), "TransferFailed");
    await nothingRecorded(id, owed, 10n * USD);
    await odd.write.setMode([Mode.Normal]);
  });

  it("a token that keeps a fee: the short arrival is refused, in a pledge, a pot and a rescue", async function () {
    const { id, t } = await w.open();
    const t2 = await w.terms();
    await boomerang.write.createCampaign([t2], { account: sponsor.account });
    const unfunded = await boomerang.read.campaignCount();
    await w.fund(sponsor, 130n * USD);
    await w.fund(alice, 10n * USD);
    const owed = await boomerang.read.totalOwed();
    await odd.write.setMode([Mode.Fee]);
    await refused(boomerang.write.fundMatch([unfunded], { account: sponsor.account }), "TransferFailed");
    await refused(boomerang.write.fundBonus([unfunded], { account: sponsor.account }), "TransferFailed");
    await w.time.increaseTo(t.opensAt);
    await refused(boomerang.write.pledge([id, 10n * USD], { account: alice.account }), "TransferFailed");
    await refused(boomerang.write.rescue([id], { account: sponsor.account }), "TransferFailed");
    assert.equal((await boomerang.read.stateOf([id])).outcome, Outcome.Open);
    await nothingRecorded(id, owed, 10n * USD);
    await odd.write.setMode([Mode.Normal]);
  });

  it("a token that answers with a malformed reply is refused on the way in", async function () {
    const { id, t } = await w.open();
    await w.fund(alice, 10n * USD);
    const owed = await boomerang.read.totalOwed();
    await w.time.increaseTo(t.opensAt);
    await odd.write.setMode([Mode.Garbled]);
    await refused(boomerang.write.pledge([id, 10n * USD], { account: alice.account }), "TransferFailed");
    await nothingRecorded(id, owed, 10n * USD);
    await odd.write.setMode([Mode.Normal]);
  });

  it("a token that answers nothing at all, as USDT does, works end to end", async function () {
    await odd.write.setMode([Mode.Silent]);
    const { id, t } = await w.open();
    await w.pledge(id, alice, 40n * USD, t.opensAt + 1n);
    await w.time.increaseTo(t.closesAt);
    await boomerang.write.finalize([id], { account: stranger.account });
    const before = await w.balance(alice);
    await boomerang.write.pay([id, alice.account.address], { account: stranger.account });
    // 40 back plus the bonus: 40 early of a 100 target, so 40/100 of min(pool 10, 5% of 40 = 2) = 0.8
    assert.equal((await w.balance(alice)) - before, 40_800_000n);
    await boomerang.write.paySide([id, Side.MatchReturn], { account: stranger.account });
    await boomerang.write.paySide([id, Side.BonusReturn], { account: stranger.account });
    await w.assertCustody();
    await odd.write.setMode([Mode.Normal]);
  });

  it("a token that answers no on the way out: nothing is marked paid, and it pays once the token behaves", async function () {
    const { id, t } = await w.open();
    await w.pledge(id, alice, 40n * USD, t.opensAt + 1n);
    await w.pledge(id, bob, 10n * USD);
    await w.time.increaseTo(t.closesAt);
    await boomerang.write.finalize([id], { account: stranger.account });
    const owed = await boomerang.read.totalOwed();
    await odd.write.setMode([Mode.SaysNo]);

    await refused(boomerang.write.pay([id, alice.account.address], { account: stranger.account }), "TransferFailed");
    await refused(boomerang.write.paySide([id, Side.MatchReturn], { account: stranger.account }), "TransferFailed");
    const hash = await boomerang.write.payMany(
      [id, [alice.account.address, bob.account.address]],
      { account: stranger.account },
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const logs = parseEventLogs({ abi: boomerang.abi, logs: receipt.logs });
    assert.deepEqual(logs.map((l) => l.eventName), ["PayFailed", "PayFailed"]);
    assert.equal(await boomerang.read.totalOwed(), owed);
    assert.equal((await boomerang.read.backerOf([id, alice.account.address])).paid, false);
    assert.equal((await boomerang.read.backerOf([id, bob.account.address])).paid, false);
    assert.equal((await boomerang.read.stateOf([id])).matchReturned, false);

    await odd.write.setMode([Mode.Normal]);
    const before = await w.balance(alice);
    await boomerang.write.payMany([id, [alice.account.address, bob.account.address]], { account: stranger.account });
    // 50 early of 100: 50/100 of min(pool 10, 5% of 50 = 2.5) = 1.25, and alice holds 40/50 of it = 1
    assert.equal((await w.balance(alice)) - before, 41n * USD);
    assert.equal((await boomerang.read.backerOf([id, bob.account.address])).paid, true);
    await boomerang.write.paySide([id, Side.MatchReturn], { account: stranger.account });
    await boomerang.write.paySide([id, Side.BonusReturn], { account: stranger.account });
    await w.assertCustody();
  });
});

describe("re-entry: every function that changes state", async function () {
  it("a token calling back into any of the eleven is refused with Reentered", async function () {
    const { viem, networkHelpers } = await network.create();
    const time = networkHelpers.time;
    const [sp, rp, al, bo] = await viem.getWalletClients();
    const token = await viem.deployContract("HostileToken");
    const boom = await viem.deployContract("Boomerang", [token.address]);
    const reentered = encodeErrorResult({ abi: boom.abi, errorName: "Reentered" });

    const now = BigInt(await time.latest());
    const terms = {
      recipient: rp.account.address,
      opensAt: now + 1_000n,
      earlyUntil: now + 101_000n,
      closesAt: now + 201_000n,
      target: 100n * USD,
      minPledge: 1n * USD,
      matchAmount: 20n * USD,
      bonusPool: 10n * USD,
      rateBps: 500,
      linearWeight: false,
      bonusFromRecipient: false,
    };
    await token.write.mint([sp.account.address, 30n * USD]);
    await token.write.approve([boom.address, 30n * USD], { account: sp.account });
    await boom.write.createCampaign([terms], { account: sp.account });
    const id = await boom.read.campaignCount();
    await boom.write.fundMatch([id], { account: sp.account });
    await boom.write.fundBonus([id], { account: sp.account });
    await token.write.mint([al.account.address, 100n * USD]);
    await token.write.approve([boom.address, 100n * USD], { account: al.account });
    await time.increaseTo(terms.opensAt);

    const abi = boom.abi;
    const calls: Record<string, `0x${string}`> = {
      createCampaign: encodeFunctionData({ abi, functionName: "createCampaign", args: [terms] }),
      fundMatch: encodeFunctionData({ abi, functionName: "fundMatch", args: [id] }),
      fundBonus: encodeFunctionData({ abi, functionName: "fundBonus", args: [id] }),
      rescue: encodeFunctionData({ abi, functionName: "rescue", args: [id] }),
      pledge: encodeFunctionData({ abi, functionName: "pledge", args: [id, USD] }),
      pledgeFor: encodeFunctionData({ abi, functionName: "pledgeFor", args: [id, bo.account.address, USD] }),
      redirect: encodeFunctionData({ abi, functionName: "redirect", args: [id, bo.account.address] }),
      finalize: encodeFunctionData({ abi, functionName: "finalize", args: [id] }),
      pay: encodeFunctionData({ abi, functionName: "pay", args: [id, al.account.address] }),
      payMany: encodeFunctionData({ abi, functionName: "payMany", args: [id, [al.account.address]] }),
      paySide: encodeFunctionData({ abi, functionName: "paySide", args: [id, Side.Recipient] }),
    };
    // the list above must be every function that changes state, no fewer
    const changing = abi
      .filter((x) => x.type === "function" && !["view", "pure"].includes(x.stateMutability))
      .map((x) => (x as { name: string }).name)
      .sort();
    assert.deepEqual(Object.keys(calls).sort(), changing);

    let pledged = 0n;
    for (const [name, data] of Object.entries(calls)) {
      await token.write.arm([boom.address, data, false, true]);
      await boom.write.pledge([id, USD], { account: al.account });
      pledged += USD;
      assert.equal(await token.read.fired(), true, `${name}: the callback did not run`);
      assert.equal(await token.read.lastInnerOk(), false, `${name}: the inner call went through`);
      assert.equal(await token.read.lastInnerReturn(), reentered, `${name}: refused for another reason`);
    }
    // each outer pledge stood, and nothing the inner calls asked for happened
    assert.equal((await boom.read.stateOf([id])).pledged, pledged);
    assert.equal(await boom.read.campaignCount(), id);
    assert.equal((await boom.read.backerOf([id, bo.account.address])).principal, 0n);
    assert.equal(await boom.read.totalOwed(), 30n * USD + pledged);
  });
});
