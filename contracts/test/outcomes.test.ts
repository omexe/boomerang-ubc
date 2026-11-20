// Every amount and account in these tests is invented.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Outcome, Side, USD, refused, setup } from "./helpers.ts";

describe("outcomes: funded, missed, void, rescue", async function () {
  const w = await setup();
  const { boomerang, usdc, sponsor, recipient, alice, bob, carol, stranger } = w;
  const finalize = (id: bigint) => boomerang.write.finalize([id], { account: stranger.account });
  const bonusPaid = async (id: bigint) => (await boomerang.read.stateOf([id])).bonusPaid;

  it("missed, flat 5%: early pledges of 1 then 98 make the bonus 4.9005", async function () {
    const { id, t } = await w.open();
    await w.pledge(id, alice, 1n * USD, t.opensAt + 1n);
    await w.pledge(id, bob, 98n * USD);
    await w.time.increaseTo(t.closesAt);
    await finalize(id);
    assert.equal((await boomerang.read.stateOf([id])).outcome, Outcome.Missed);
    assert.equal(await bonusPaid(id), 4_900_500n);
    // split by weight x amount, rounded down: 1/99 and 98/99 of 4.9005
    assert.deepEqual(await boomerang.read.owedTo([id, alice.account.address]), [1n * USD, 49_500n]);
    assert.deepEqual(await boomerang.read.owedTo([id, bob.account.address]), [98n * USD, 4_851_000n]);
  });

  it("missed: pledges after the early deadline cannot raise the bonus (ten early, eighty late: 0.05)", async function () {
    const { id, t } = await w.open();
    await w.pledge(id, alice, 10n * USD, t.opensAt + 1n);
    await w.pledge(id, bob, 80n * USD, t.earlyUntil + 1n);
    await w.time.increaseTo(t.closesAt);
    await finalize(id);
    assert.equal(await bonusPaid(id), 50_000n);
    assert.deepEqual(await boomerang.read.owedTo([id, alice.account.address]), [10n * USD, 50_000n]);
    assert.deepEqual(await boomerang.read.owedTo([id, bob.account.address]), [80n * USD, 0n]);
  });

  it("missed, linear 5%: ten at full weight and eighty at one thousandth make the bonus 0.4536", async function () {
    const { id, t } = await w.open({ linearWeight: true });
    await w.fund(alice, 10n * USD);
    await w.fund(bob, 80n * USD);
    await w.time.setNextBlockTimestamp(t.opensAt);
    await boomerang.write.pledge([id, 10n * USD], { account: alice.account });
    await w.time.setNextBlockTimestamp(t.earlyUntil - 100n);
    await boomerang.write.pledge([id, 80n * USD], { account: bob.account });
    await w.time.increaseTo(t.closesAt);
    await finalize(id);
    assert.equal(await bonusPaid(id), 453_600n);
    // weighted: 10 x 1_000_000 and 80 x 1_000, so alice holds 10/10.08 of it
    assert.deepEqual(await boomerang.read.owedTo([id, alice.account.address]), [10n * USD, 450_000n]);
    assert.deepEqual(await boomerang.read.owedTo([id, bob.account.address]), [80n * USD, 3_600n]);
  });

  it("missed with nobody early: no bonus, nothing divides by zero, the whole pool returns", async function () {
    const { id, t } = await w.open();
    await w.pledge(id, alice, 40n * USD, t.earlyUntil + 5n);
    await w.time.increaseTo(t.closesAt);
    await finalize(id);
    assert.equal(await bonusPaid(id), 0n);
    assert.deepEqual(await boomerang.read.owedTo([id, alice.account.address]), [40n * USD, 0n]);
    const before = await w.balance(sponsor);
    await boomerang.write.paySide([id, Side.BonusReturn], { account: stranger.account });
    assert.equal((await w.balance(sponsor)) - before, t.bonusPool);
  });

  it("missed with no pledges at all: both pots return and nothing else moves", async function () {
    const { id, t } = await w.open();
    await w.time.increaseTo(t.closesAt);
    await finalize(id);
    const before = await w.balance(sponsor);
    await boomerang.write.paySide([id, Side.MatchReturn], { account: stranger.account });
    await boomerang.write.paySide([id, Side.BonusReturn], { account: stranger.account });
    await boomerang.write.paySide([id, Side.Recipient], { account: stranger.account });
    assert.equal((await w.balance(sponsor)) - before, t.matchAmount + t.bonusPool);
    assert.equal(await w.balance(recipient), 0n);
  });

  it("the bonus is capped by the pool", async function () {
    // rate 100% of weighted pledges would be 60; the pool is 10; 60 of 100 pledged early
    const { id, t } = await w.open({ rateBps: 10_000 });
    await w.pledge(id, alice, 60n * USD, t.opensAt + 1n);
    await w.time.increaseTo(t.closesAt);
    await finalize(id);
    assert.equal(await bonusPaid(id), 6n * USD);
  });

  it("funded: the recipient is owed pledges plus match; the bonus returns whole; backers are owed nothing", async function () {
    const { id, t } = await w.open();
    await w.pledge(id, alice, 60n * USD, t.opensAt + 1n);
    await w.pledge(id, bob, 40n * USD);
    assert.equal((await boomerang.read.stateOf([id])).outcome, Outcome.Funded);
    assert.deepEqual(await boomerang.read.owedTo([id, alice.account.address]), [0n, 0n]);
    const r0 = await w.balance(recipient);
    const s0 = await w.balance(sponsor);
    await boomerang.write.paySide([id, Side.Recipient], { account: stranger.account });
    await boomerang.write.paySide([id, Side.BonusReturn], { account: stranger.account });
    await boomerang.write.paySide([id, Side.MatchReturn], { account: stranger.account });
    assert.equal((await w.balance(recipient)) - r0, 120n * USD);
    assert.equal((await w.balance(sponsor)) - s0, t.bonusPool);
    const a0 = await w.balance(alice);
    await boomerang.write.pay([id, alice.account.address], { account: stranger.account });
    assert.equal(await w.balance(alice), a0);
    await finalize(id); // calling again does nothing
    assert.equal((await boomerang.read.stateOf([id])).outcome, Outcome.Funded);
  });

  it("finalize is refused before it is due and harmless when repeated", async function () {
    const { id, t } = await w.open();
    await w.pledge(id, alice, 10n * USD, t.opensAt + 1n);
    await refused(finalize(id), "NotDue");
    await refused(boomerang.write.paySide([id, Side.MatchReturn], { account: stranger.account }), "NotFinal");
    await w.time.increaseTo(t.closesAt);
    assert.equal(await boomerang.read.outcomeNow([id]), Outcome.Missed);
    await finalize(id);
    const events = await boomerang.read.eventCount();
    await finalize(id);
    assert.equal(await boomerang.read.eventCount(), events);
  });

  it("void: a pot missing at the opening second; pledges are refused; the pot received returns", async function () {
    const { id, t } = await w.open({}, { skipBonus: true });
    await w.fund(alice, 10n * USD);
    await refused(finalize(id), "NotDue");
    await w.time.increaseTo(t.opensAt);
    assert.equal(await boomerang.read.outcomeNow([id]), Outcome.Void);
    await refused(boomerang.write.pledge([id, 10n * USD], { account: alice.account }), "CampaignVoid");
    await finalize(id);
    assert.equal((await boomerang.read.stateOf([id])).outcome, Outcome.Void);
    await refused(boomerang.write.pledge([id, 10n * USD], { account: alice.account }), "OutcomeSet");
    const before = await w.balance(sponsor);
    await boomerang.write.paySide([id, Side.MatchReturn], { account: stranger.account });
    assert.equal((await w.balance(sponsor)) - before, t.matchAmount);
    const again = await w.balance(sponsor);
    await boomerang.write.paySide([id, Side.MatchReturn], { account: stranger.account });
    await boomerang.write.paySide([id, Side.BonusReturn], { account: stranger.account });
    assert.equal(await w.balance(sponsor), again);
    await w.assertCustody();
  });

  it("rescue: the sponsor closes the whole gap with new money and the campaign is funded at once", async function () {
    const { id, t } = await w.open();
    await w.pledge(id, alice, 70n * USD, t.opensAt + 1n);
    await refused(boomerang.write.rescue([id], { account: alice.account }), "NotSponsor");
    await w.fund(sponsor, 30n * USD);
    await boomerang.write.rescue([id], { account: sponsor.account });
    const s = await boomerang.read.stateOf([id]);
    assert.equal(s.outcome, Outcome.Funded);
    assert.equal(s.pledged, 100n * USD);
    assert.equal(s.pledgedEarly, 70n * USD);
    const r0 = await w.balance(recipient);
    await boomerang.write.paySide([id, Side.Recipient], { account: stranger.account });
    assert.equal((await w.balance(recipient)) - r0, 120n * USD);
    await refused(boomerang.write.rescue([id], { account: sponsor.account }), "OutcomeSet");
  });

  it("rescue is refused before opening and from the closing second", async function () {
    const { id, t } = await w.open();
    await w.fund(sponsor, 100n * USD);
    await refused(boomerang.write.rescue([id], { account: sponsor.account }), "NotOpenYet");
    await w.time.increaseTo(t.closesAt);
    await refused(boomerang.write.rescue([id], { account: sponsor.account }), "Closed");
    assert.equal(await usdc.read.balanceOf([sponsor.account.address]) >= 100n * USD, true);
  });
});
