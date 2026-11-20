// Every amount and account in these tests is invented.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseEventLogs } from "viem";

import { Outcome, Side, USD, refused, setup } from "./helpers.ts";

describe("edges: refusals not covered elsewhere, and the event numbering", async function () {
  const w = await setup();
  const { viem, boomerang, usdc, sponsor, recipient, alice, bob, stranger } = w;
  const ZERO = "0x0000000000000000000000000000000000000000" as const;

  it("the contract cannot be deployed without a token", async function () {
    await refused(viem.deployContract("Boomerang", [ZERO]), "ZeroAddress");
  });

  it("the contract itself is never a recipient, a backer or a payout destination", async function () {
    const t = await w.terms({ recipient: boomerang.address });
    await refused(boomerang.write.createCampaign([t], { account: sponsor.account }), "BadTerms");
    const { id, t: ok } = await w.open();
    await w.fund(alice, 20n * USD);
    await w.time.increaseTo(ok.opensAt);
    await refused(boomerang.write.pledgeFor([id, boomerang.address, 10n * USD], { account: alice.account }), "ZeroAddress");
    await boomerang.write.pledge([id, 10n * USD], { account: alice.account });
    await refused(boomerang.write.redirect([id, boomerang.address], { account: alice.account }), "ZeroAddress");
  });

  it("the bonus pot cannot be funded from the opening second", async function () {
    const t = await w.terms();
    await boomerang.write.createCampaign([t], { account: sponsor.account });
    const id = await boomerang.read.campaignCount();
    await w.fund(sponsor, t.bonusPool);
    await w.time.increaseTo(t.opensAt - 1n);
    await refused(boomerang.write.fundBonus([id], { account: sponsor.account }), "TooLate");
  });

  it("a void campaign cannot be rescued", async function () {
    const { id, t } = await w.open({}, { skipMatch: true });
    await w.fund(sponsor, 100n * USD);
    await w.time.increaseTo(t.opensAt);
    await refused(boomerang.write.rescue([id], { account: sponsor.account }), "CampaignVoid");
  });

  it("the sponsor cannot pay for someone else's pledge", async function () {
    const { id, t } = await w.open();
    await w.fund(sponsor, 10n * USD);
    await w.time.increaseTo(t.opensAt);
    await refused(
      boomerang.write.pledgeFor([id, alice.account.address, 10n * USD], { account: sponsor.account }),
      "SponsorCannotPledge",
    );
  });

  it("a pledge without allowance, or without the money, takes nothing and records nothing", async function () {
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt);
    const owed = await boomerang.read.totalOwed();
    await refused(boomerang.write.pledge([id, 10n * USD], { account: bob.account }), "TransferFailed");
    await usdc.write.approve([boomerang.address, 10n * USD], { account: bob.account });
    await refused(boomerang.write.pledge([id, 10n * USD], { account: bob.account }), "TransferFailed");
    assert.equal(await boomerang.read.totalOwed(), owed);
    assert.equal((await boomerang.read.backerOf([id, bob.account.address])).principal, 0n);
    assert.equal((await boomerang.read.stateOf([id])).pledged, 0n);
  });

  it("a recipient that cannot receive keeps its side owed, and it pays once unblocked", async function () {
    const { id, t } = await w.open();
    await w.pledge(id, alice, 100n * USD, t.opensAt + 1n);
    assert.equal((await boomerang.read.stateOf([id])).outcome, Outcome.Funded);
    await usdc.write.setBlocked([recipient.account.address, true]);
    const owed = await boomerang.read.totalOwed();
    await refused(boomerang.write.paySide([id, Side.Recipient], { account: stranger.account }), "TransferFailed");
    assert.equal(await boomerang.read.totalOwed(), owed);
    assert.equal((await boomerang.read.stateOf([id])).recipientPaid, false);
    await usdc.write.setBlocked([recipient.account.address, false]);
    const before = await w.balance(recipient);
    await boomerang.write.paySide([id, Side.Recipient], { account: stranger.account });
    assert.equal((await w.balance(recipient)) - before, 120n * USD);
  });

  it("asking for a side that is owed nothing changes no state and emits nothing", async function () {
    const { id, t } = await w.open();
    await w.pledge(id, alice, 10n * USD, t.opensAt + 1n);
    await w.time.increaseTo(t.closesAt);
    await boomerang.write.finalize([id], { account: stranger.account });
    const events = await boomerang.read.eventCount();
    await boomerang.write.paySide([id, Side.Recipient], { account: stranger.account });
    assert.equal(await boomerang.read.eventCount(), events);
    assert.equal((await boomerang.read.stateOf([id])).recipientPaid, false);
  });

  it("positionIfMissed is zero once paid and for a funded campaign", async function () {
    const { id, t } = await w.open();
    await w.pledge(id, alice, 10n * USD, t.opensAt + 1n);
    assert.deepEqual(await boomerang.read.positionIfMissed([id, alice.account.address]), [10n * USD, 50_000n]);
    await w.time.increaseTo(t.closesAt);
    await boomerang.write.finalize([id], { account: stranger.account });
    await boomerang.write.pay([id, alice.account.address], { account: stranger.account });
    assert.deepEqual(await boomerang.read.positionIfMissed([id, alice.account.address]), [0n, 0n]);
    const { id: funded, t: t2 } = await w.open();
    await w.pledge(funded, alice, 100n * USD, t2.opensAt + 1n);
    assert.deepEqual(await boomerang.read.positionIfMissed([funded, alice.account.address]), [0n, 0n]);
  });

  it("every event carries the next number, from 1, with no gap and no repeat", async function () {
    const fresh = await setup();
    const b = fresh.boomerang;
    const { id, t } = await fresh.open();
    await fresh.pledge(id, fresh.alice, 30n * USD, t.opensAt + 1n);
    await fresh.pledge(id, fresh.bob, 20n * USD);
    await b.write.redirect([id, fresh.carol.account.address], { account: fresh.bob.account });
    await fresh.time.increaseTo(t.closesAt);
    await b.write.finalize([id], { account: fresh.stranger.account });
    await fresh.usdc.write.setBlocked([fresh.carol.account.address, true]);
    await b.write.payMany([id, [fresh.alice.account.address, fresh.bob.account.address]], { account: fresh.stranger.account });
    await fresh.usdc.write.setBlocked([fresh.carol.account.address, false]);
    await b.write.pay([id, fresh.bob.account.address], { account: fresh.stranger.account });
    for (const side of [Side.MatchReturn, Side.BonusReturn]) await b.write.paySide([id, side], { account: fresh.stranger.account });
    const { id: two, t: t2 } = await fresh.open();
    await fresh.pledge(two, fresh.alice, 60n * USD, t2.opensAt + 1n);
    await fresh.fund(fresh.sponsor, 40n * USD);
    await b.write.rescue([two], { account: fresh.sponsor.account });

    const logs = await fresh.publicClient.getLogs({ address: b.address, fromBlock: 0n, toBlock: "latest" });
    const events = parseEventLogs({ abi: b.abi, logs });
    const seqs = events.map((e) => (e.args as { seq: bigint }).seq);
    assert.equal(BigInt(seqs.length), await b.read.eventCount());
    seqs.forEach((seq, i) => assert.equal(seq, BigInt(i + 1)));
    const names = events.map((e) => e.eventName);
    assert.deepEqual(names, [
      "CampaignCreated", "PotFunded", "PotFunded", "Pledged", "Pledged", "Redirected", "Finalized",
      "Paid", "PayFailed", "Paid", "SidePaid", "SidePaid",
      "CampaignCreated", "PotFunded", "PotFunded", "Pledged", "Rescued", "Finalized",
    ]);
  });
});
