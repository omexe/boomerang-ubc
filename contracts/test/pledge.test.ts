// Every amount and account in these tests is invented.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ONE, Outcome, USD, refused, setup } from "./helpers.ts";

describe("pledges, weight and boundary seconds", async function () {
  const w = await setup();
  const { boomerang, usdc, sponsor, alice, bob, carol, dave } = w;

  it("a pledge takes exactly what counts and records it for the backer", async function () {
    const { id, t } = await w.open();
    const before = await usdc.read.balanceOf([boomerang.address]);
    await w.pledge(id, alice, 30n * USD, t.opensAt + 10n);
    assert.equal((await usdc.read.balanceOf([boomerang.address])) - before, 30n * USD);
    const b = await boomerang.read.backerOf([id, alice.account.address]);
    assert.equal(b.principal, 30n * USD);
    assert.equal(b.weighted, 30n * USD * ONE);
    const s = await boomerang.read.stateOf([id]);
    assert.equal(s.pledged, 30n * USD);
    assert.equal(s.pledgedEarly, 30n * USD);
    assert.equal(s.backers, 1);
    await w.assertCustody();
  });

  it("pledgeFor: the payer pays, the named backer owns the record", async function () {
    const { id, t } = await w.open();
    await w.fund(bob, 12n * USD);
    await w.time.setNextBlockTimestamp(t.opensAt + 5n);
    await boomerang.write.pledgeFor([id, carol.account.address, 12n * USD], { account: bob.account });
    assert.equal((await boomerang.read.backerOf([id, carol.account.address])).principal, 12n * USD);
    assert.equal((await boomerang.read.backerOf([id, bob.account.address])).principal, 0n);
    assert.equal(await w.balance(bob), 0n);
  });

  it("refusals: before opening, below the minimum, zero, the sponsor, a zero backer", async function () {
    const { id, t } = await w.open({ minPledge: 10n * USD });
    await w.fund(alice, 50n * USD);
    await refused(boomerang.write.pledge([id, 10n * USD], { account: alice.account }), "NotOpenYet");
    await w.time.increaseTo(t.opensAt);
    await refused(boomerang.write.pledge([id, 5n * USD], { account: alice.account }), "BelowMinimum");
    await refused(boomerang.write.pledge([id, 0n], { account: alice.account }), "ZeroAmount");
    await refused(
      boomerang.write.pledgeFor([id, "0x0000000000000000000000000000000000000000", 10n * USD], { account: alice.account }),
      "ZeroAddress",
    );
    await w.fund(sponsor, 10n * USD);
    await refused(boomerang.write.pledge([id, 10n * USD], { account: sponsor.account }), "SponsorCannotPledge");
    await refused(
      boomerang.write.pledgeFor([id, sponsor.account.address, 10n * USD], { account: alice.account }),
      "SponsorCannotPledge",
    );
    assert.equal((await boomerang.read.stateOf([id])).pledged, 0n);
  });

  it("flat weight is full through the early window and zero from the early deadline", async function () {
    const { id, t } = await w.open();
    assert.equal(await boomerang.read.weightAt([id, t.opensAt - 1n]), 0n);
    assert.equal(await boomerang.read.weightAt([id, t.opensAt]), ONE);
    assert.equal(await boomerang.read.weightAt([id, t.earlyUntil - 1n]), ONE);
    assert.equal(await boomerang.read.weightAt([id, t.earlyUntil]), 0n);
  });

  it("linear weight falls from full at opening to zero at the early deadline, rounded down", async function () {
    const { id, t } = await w.open({ linearWeight: true });
    assert.equal(await boomerang.read.weightAt([id, t.opensAt]), ONE);
    assert.equal(await boomerang.read.weightAt([id, t.opensAt + 50_000n]), ONE / 2n);
    assert.equal(await boomerang.read.weightAt([id, t.earlyUntil - 100n]), 1_000n);
    assert.equal(await boomerang.read.weightAt([id, t.earlyUntil - 1n]), 10n);
    assert.equal(await boomerang.read.weightAt([id, t.earlyUntil]), 0n);
    // a window of 3 seconds: 2 of 3 seconds left rounds down
    const now = BigInt(await w.time.latest());
    const { id: tiny } = await w.open({ linearWeight: true, opensAt: now + 100n, earlyUntil: now + 103n, closesAt: now + 200n });
    assert.equal(await boomerang.read.weightAt([tiny, now + 101n]), 666_666n);
  });

  it("boundaries: the early-deadline second earns no weight; the closing second is refused", async function () {
    const { id, t } = await w.open();
    for (const who of [alice, bob, carol, dave]) await w.fund(who, 10n * USD);
    await w.time.setNextBlockTimestamp(t.earlyUntil - 1n);
    await boomerang.write.pledge([id, 10n * USD], { account: alice.account });
    await w.time.setNextBlockTimestamp(t.earlyUntil);
    await boomerang.write.pledge([id, 10n * USD], { account: bob.account });
    assert.equal((await boomerang.read.backerOf([id, alice.account.address])).weighted, 10n * USD * ONE);
    assert.equal((await boomerang.read.backerOf([id, bob.account.address])).weighted, 0n);
    const s = await boomerang.read.stateOf([id]);
    assert.equal(s.pledged, 20n * USD);
    assert.equal(s.pledgedEarly, 10n * USD);

    await w.time.setNextBlockTimestamp(t.closesAt - 1n);
    await boomerang.write.pledge([id, 10n * USD], { account: carol.account });
    await w.time.setNextBlockTimestamp(t.closesAt);
    await refused(boomerang.write.pledge([id, 10n * USD], { account: dave.account }), "Closed");
    assert.equal((await boomerang.read.stateOf([id])).pledged, 30n * USD);
  });

  it("the pledge that reaches the target takes only the gap and funds the campaign at once", async function () {
    const { id, t } = await w.open();
    await w.pledge(id, alice, 90n * USD, t.opensAt + 1n);
    await w.fund(bob, 25n * USD);
    await boomerang.write.pledge([id, 25n * USD], { account: bob.account });
    assert.equal(await w.balance(bob), 15n * USD);
    const s = await boomerang.read.stateOf([id]);
    assert.equal(s.pledged, 100n * USD);
    assert.equal(s.outcome, Outcome.Funded);
    await w.fund(carol, 5n * USD);
    await refused(boomerang.write.pledge([id, 5n * USD], { account: carol.account }), "OutcomeSet");
    await w.assertCustody();
  });

  it("a gap smaller than the minimum can still be closed (target 105, minimum 10)", async function () {
    const { id, t } = await w.open({ target: 105n * USD, minPledge: 10n * USD });
    await w.fund(carol, 5n * USD);
    await w.time.increaseTo(t.opensAt);
    await refused(boomerang.write.pledge([id, 5n * USD], { account: carol.account }), "BelowMinimum");
    for (let i = 0; i < 10; i++) await w.pledge(id, i % 2 ? alice : bob, 10n * USD);
    assert.equal((await boomerang.read.stateOf([id])).pledged, 100n * USD);
    await boomerang.write.pledge([id, 5n * USD], { account: carol.account });
    assert.equal((await boomerang.read.stateOf([id])).outcome, Outcome.Funded);
  });

  it("positionIfMissed before the deadline equals what the backer is owed after a miss", async function () {
    const { id, t } = await w.open({ linearWeight: true });
    await w.pledge(id, alice, 20n * USD, t.opensAt + 10_000n);
    await w.fund(bob, 30n * USD);
    await w.time.setNextBlockTimestamp(t.opensAt + 40_001n);
    await boomerang.write.pledge([id, 30n * USD], { account: bob.account });
    const position = await boomerang.read.positionIfMissed([id, bob.account.address]);
    // 59_999 of 100_000 seconds left at +40_001s is weight 599_990
    assert.equal((await boomerang.read.backerOf([id, bob.account.address])).weighted, 30n * USD * 599_990n);
    // 50 of 100 early; weighted 20 x 900_000 + 30 x 599_990 = 35.9997; cap 5% of that = 1.799985;
    // bonus 0.5 x 1.799985 = 0.899992; bob holds 17.9997 / 35.9997 of it, rounded down = 0.449992
    assert.equal(position[1], 449_992n);
    await w.time.increaseTo(t.closesAt);
    await boomerang.write.finalize([id], { account: carol.account });
    const [principal, bonus] = await boomerang.read.owedTo([id, bob.account.address]);
    assert.equal(principal, 30n * USD);
    assert.equal(bonus, position[1]);
    assert.ok(bonus > 0n);
  });

  it("quoteIfMissed: would fund, refused, and a live quote that matches the pledge made in the same second", async function () {
    const { id, t } = await w.open();
    assert.deepEqual(await boomerang.read.quoteIfMissed([id, 10n * USD]), [false, 0n, 0n]); // not open yet
    await w.time.increaseTo(t.opensAt + 100n);
    assert.deepEqual(await boomerang.read.quoteIfMissed([id, 100n * USD]), [true, 100n * USD, 0n]);
    assert.deepEqual(await boomerang.read.quoteIfMissed([id, USD / 2n]), [false, 0n, 0n]); // below the minimum
    const [wouldFund, counted, bonus] = await boomerang.read.quoteIfMissed([id, 40n * USD]);
    assert.equal(wouldFund, false);
    assert.equal(counted, 40n * USD);
    // flat weight, rate 5%, pool 10: 40 early of 100, cap min(10, 5% of 40 = 2) = 2, so 0.4 x 2 = 0.8
    assert.equal(bonus, 800_000n);
  });
});
