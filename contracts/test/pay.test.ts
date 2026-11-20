// Every amount and account in these tests is invented.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Side, USD, refused, setup } from "./helpers.ts";

describe("paying out", async function () {
  const w = await setup();
  const { boomerang, usdc, sponsor, alice, bob, carol, dave, stranger } = w;

  /** A missed campaign: alice 30 early, bob 20 early, carol 10 late. Flat 5%, pool 10. */
  async function missed() {
    const { id, t } = await w.open();
    await w.pledge(id, alice, 30n * USD, t.opensAt + 1n);
    await w.pledge(id, bob, 20n * USD);
    await w.pledge(id, carol, 10n * USD, t.earlyUntil + 1n);
    await w.time.increaseTo(t.closesAt);
    await boomerang.write.finalize([id], { account: stranger.account });
    return { id, t };
  }

  it("anyone can pay a backer; the money goes to the backer; a second call pays nothing", async function () {
    const { id } = await missed();
    // 50 of 100 early, cap min(10, 5% of 50 = 2.5), bonus 1.25: alice 0.75, bob 0.5
    assert.equal((await boomerang.read.stateOf([id])).bonusPaid, 1_250_000n);
    const a0 = await w.balance(alice);
    const s0 = await w.balance(stranger);
    await boomerang.write.pay([id, alice.account.address], { account: stranger.account });
    assert.equal((await w.balance(alice)) - a0, 30n * USD + 750_000n);
    assert.equal(await w.balance(stranger), s0);
    await boomerang.write.pay([id, alice.account.address], { account: stranger.account });
    assert.equal((await w.balance(alice)) - a0, 30n * USD + 750_000n);
    assert.deepEqual(await boomerang.read.owedTo([id, alice.account.address]), [0n, 0n]);
    await w.assertCustody();
  });

  it("paying before the outcome, or paying someone with no record, moves nothing", async function () {
    const { id, t } = await w.open();
    await w.pledge(id, alice, 30n * USD, t.opensAt + 1n);
    const a0 = await w.balance(alice);
    await boomerang.write.pay([id, alice.account.address], { account: stranger.account });
    await boomerang.write.payMany([id, [alice.account.address, dave.account.address]], { account: stranger.account });
    assert.equal(await w.balance(alice), a0);
    assert.equal(await w.balance(dave), 0n);
  });

  it("pay.blocked: a destination that cannot receive stays owed, the rest of the batch still pays, redirect repairs it", async function () {
    const { id } = await missed();
    await usdc.write.setBlocked([bob.account.address, true]);
    await refused(boomerang.write.pay([id, bob.account.address], { account: stranger.account }), "TransferFailed");
    const owedBefore = await boomerang.read.totalOwed();

    const a0 = await w.balance(alice);
    const c0 = await w.balance(carol);
    await boomerang.write.payMany(
      [id, [alice.account.address, bob.account.address, carol.account.address]],
      { account: stranger.account },
    );
    assert.equal((await w.balance(alice)) - a0, 30n * USD + 750_000n);
    assert.equal((await w.balance(carol)) - c0, 10n * USD);
    assert.deepEqual(await boomerang.read.owedTo([id, bob.account.address]), [20n * USD, 500_000n]);
    assert.equal(owedBefore - (await boomerang.read.totalOwed()), 40n * USD + 750_000n);
    await w.assertCustody();

    await refused(boomerang.write.redirect([id, dave.account.address], { account: stranger.account }), "NoRecord");
    await refused(
      boomerang.write.redirect([id, "0x0000000000000000000000000000000000000000"], { account: bob.account }),
      "ZeroAddress",
    );
    await boomerang.write.redirect([id, dave.account.address], { account: bob.account });
    await boomerang.write.pay([id, bob.account.address], { account: stranger.account });
    assert.equal(await w.balance(dave), 20n * USD + 500_000n);
    await refused(boomerang.write.redirect([id, alice.account.address], { account: bob.account }), "AlreadyPaid");
    await usdc.write.setBlocked([bob.account.address, false]);
  });

  it("after everything is paid, what is left is only rounding dust", async function () {
    // three early backers of 1/3 weight each split a bonus that does not divide evenly
    const { id, t } = await w.open({ target: 100n * USD, bonusPool: 10n * USD, rateBps: 500 });
    await w.pledge(id, alice, 11n * USD, t.opensAt + 1n);
    await w.pledge(id, bob, 11n * USD);
    await w.pledge(id, carol, 11n * USD);
    await w.time.increaseTo(t.closesAt);
    await boomerang.write.finalize([id], { account: stranger.account });
    const holdsBefore = await usdc.read.balanceOf([boomerang.address]);
    const owesBefore = await boomerang.read.totalOwed();
    await boomerang.write.payMany(
      [id, [alice.account.address, bob.account.address, carol.account.address]],
      { account: stranger.account },
    );
    for (const side of [Side.Recipient, Side.MatchReturn, Side.BonusReturn]) {
      await boomerang.write.paySide([id, side], { account: stranger.account });
    }
    const paidOut = holdsBefore - (await usdc.read.balanceOf([boomerang.address]));
    const stillOwed = await boomerang.read.totalOwed();
    // this campaign held 33 + 20 + 10 = 63; at most 3 base units of dust stay behind
    const dust = 63n * USD - paidOut;
    assert.ok(dust >= 0n && dust <= 3n, `dust ${dust}`);
    assert.equal(owesBefore - stillOwed, paidOut);
    await w.assertCustody();
    await boomerang.write.paySide([id, Side.MatchReturn], { account: stranger.account });
    assert.equal(await boomerang.read.totalOwed(), stillOwed);
    assert.equal(await w.balance(sponsor) > 0n, true);
  });
});
