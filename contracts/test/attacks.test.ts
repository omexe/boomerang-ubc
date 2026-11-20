// Every amount and account in these tests is invented. None is a reading of any real campaign.
// One test per row of docs/ATTACKS.md whose Test column names a test in this file.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeErrorResult, encodeFunctionData } from "viem";

import { ONE, Outcome, Side, USD, refused, setup } from "./helpers.ts";

const ZERO = "0x0000000000000000000000000000000000000000" as const;

describe("attacks: one per row of docs/ATTACKS.md", async function () {
  const w = await setup();
  const { boomerang, usdc, sponsor, recipient, alice, bob, carol, dave, erin, stranger } = w;
  const finalize = (id: bigint) => boomerang.write.finalize([id], { account: stranger.account });

  /** A missed campaign: alice 30 early, bob 20 early, carol 10 late. Flat 5%, pool 10. */
  async function missed() {
    const { id, t } = await w.open();
    await w.pledge(id, alice, 30n * USD, t.opensAt + 1n);
    await w.pledge(id, bob, 20n * USD);
    await w.pledge(id, carol, 10n * USD, t.earlyUntil + 1n);
    await w.time.increaseTo(t.closesAt);
    await finalize(id);
    return { id, t };
  }

  // A1 ----------------------------------------------------------------------
  it("A1 the bonus never exceeds the pool or the rate", async function () {
    // The payout a set of early pledges can farm, on a campaign nobody completes in time.
    // bonusPaid = pledgedEarly x min(pool, rateBps x weighted / 10^10) / target, every division
    // floored. It is bounded by the pool, and by rate x (sum of early pledges).
    async function bonusFor(over: Parameters<typeof w.open>[0], earlies: bigint[]) {
      const { id, t } = await w.open(over);
      let at = t.opensAt + 1n;
      const payers = [alice, bob, carol, dave, erin];
      for (let i = 0; i < earlies.length; i++) {
        await w.pledge(id, payers[i], earlies[i], at);
        at += 10n;
      }
      await w.time.increaseTo(t.closesAt);
      await finalize(id);
      const bonusPaid = (await boomerang.read.stateOf([id])).bonusPaid;
      const sumEarly = earlies.reduce((a, b) => a + b, 0n);
      const rateCap = (BigInt(t.rateBps) * sumEarly) / 10_000n; // rate x sum of early pledges
      assert.ok(bonusPaid <= t.bonusPool, `bonus ${bonusPaid} over pool ${t.bonusPool}`);
      assert.ok(bonusPaid <= rateCap, `bonus ${bonusPaid} over rate cap ${rateCap}`);
      return bonusPaid;
    }

    // the named pattern: 1 then 98 early, flat 5%, pool 10 -> 4.9005
    assert.equal(await bonusFor({}, [1n * USD, 98n * USD]), 4_900_500n);
    // a thin early turnout: the rate caps it far below the pool
    assert.equal(await bonusFor({}, [5n * USD]), 12_500n);
    // a high rate where the pool and the target share bind instead: 60 early at 100%, pool 10 -> 6
    assert.equal(await bonusFor({ rateBps: 10_000 }, [60n * USD]), 6n * USD);
  });

  // A2 ----------------------------------------------------------------------
  it("A2 pledges after the early deadline leave the bonus unchanged", async function () {
    const { id, t } = await w.open();
    await w.pledge(id, alice, 20n * USD, t.opensAt + 1n);
    // what alice is owed if the campaign missed right now, read at the early deadline
    const [, bonusAtDeadline] = await boomerang.read.positionIfMissed([id, alice.account.address]);
    assert.ok(bonusAtDeadline > 0n);
    // two accounts pile in after the early deadline
    await w.pledge(id, bob, 30n * USD, t.earlyUntil + 1n);
    await w.pledge(id, carol, 40n * USD, t.earlyUntil + 100n);
    await w.time.increaseTo(t.closesAt);
    await finalize(id);
    const [, bonusAfter] = await boomerang.read.owedTo([id, alice.account.address]);
    assert.equal(bonusAfter, bonusAtDeadline); // the same number, to the unit
    assert.deepEqual(await boomerang.read.owedTo([id, bob.account.address]), [30n * USD, 0n]);
    assert.deepEqual(await boomerang.read.owedTo([id, carol.account.address]), [40n * USD, 0n]);
  });

  // A5 ----------------------------------------------------------------------
  it("A5 campaigns are isolated", async function () {
    // one campaign that will miss, one that stays open far into the future
    const missedC = await w.open();
    await w.pledge(missedC.id, alice, 30n * USD, missedC.t.opensAt + 1n);
    // open the second campaign well after the first's early pledge, closing far in the future
    const now = BigInt(await w.time.latest());
    const openC = await w.open({
      opensAt: now + 100_000n,
      earlyUntil: now + 5_000_000n,
      closesAt: now + 10_000_000n,
    });
    await w.pledge(openC.id, bob, 40n * USD, openC.t.opensAt + 1n);

    const openState0 = await boomerang.read.stateOf([openC.id]);
    const owedForOpen = openState0.pledged + openC.t.matchAmount + openC.t.bonusPool; // money in for it

    // miss and fully pay the first campaign
    await w.time.increaseTo(missedC.t.closesAt);
    await finalize(missedC.id);
    await boomerang.write.pay([missedC.id, alice.account.address], { account: stranger.account });
    for (const side of [Side.MatchReturn, Side.BonusReturn]) {
      await boomerang.write.paySide([missedC.id, side], { account: stranger.account });
    }

    // the open campaign is untouched
    assert.deepEqual(await boomerang.read.stateOf([openC.id]), openState0);
    const openState1 = await boomerang.read.stateOf([openC.id]);
    assert.equal(openState1.pledged + openC.t.matchAmount + openC.t.bonusPool, owedForOpen);

    // a cross-id payout moves nothing in either direction
    const a0 = await w.balance(alice);
    const b0 = await w.balance(bob);
    await boomerang.write.pay([openC.id, alice.account.address], { account: stranger.account }); // alice has no record here
    await boomerang.write.pay([missedC.id, bob.account.address], { account: stranger.account }); // bob has no record there
    assert.equal(await w.balance(alice), a0);
    assert.equal(await w.balance(bob), b0);
    await w.assertCustody();
  });

  // A6 ----------------------------------------------------------------------
  it("A6 a later early pledge earns less under linear weight", async function () {
    // equal pledges at 10% and 90% of the early window (length 100_000).
    const { id, t } = await w.open({ linearWeight: true });
    // weight at +10_000s = (100_000-10_000)/100_000 x 1e6 = 900_000; at +90_000s = 100_000.
    await w.pledge(id, alice, 10n * USD, t.opensAt + 10_000n);
    await w.pledge(id, bob, 10n * USD, t.opensAt + 90_000n);
    assert.equal((await boomerang.read.backerOf([id, alice.account.address])).weighted, 10n * USD * 900_000n);
    assert.equal((await boomerang.read.backerOf([id, bob.account.address])).weighted, 10n * USD * 100_000n);
    await w.time.increaseTo(t.closesAt);
    await finalize(id);
    // weighted total = 10e6 x 900_000 + 10e6 x 100_000 = 1e13; cap = 500 x 1e13 / 1e10 = 500_000;
    // pool = min(500_000, 10e6) = 500_000; bonusPaid = 20e6 x 500_000 / 1e8 = 100_000.
    // alice holds 9/10 of the weight -> 90_000; bob holds 1/10 -> 10_000.
    const [, aBonus] = await boomerang.read.owedTo([id, alice.account.address]);
    const [, bBonus] = await boomerang.read.owedTo([id, bob.account.address]);
    assert.equal(aBonus, 90_000n);
    assert.equal(bBonus, 10_000n);
    assert.ok(aBonus > bBonus);
  });

  // A8 ----------------------------------------------------------------------
  it("A8 the sponsor cannot top up in part", async function () {
    const { id, t } = await w.open();
    await w.pledge(id, alice, 70n * USD, t.opensAt + 1n); // gap is now 30
    // the sponsor's own account cannot pledge at all
    await w.fund(sponsor, 10n * USD);
    await refused(boomerang.write.pledge([id, 10n * USD], { account: sponsor.account }), "SponsorCannotPledge");

    // rescue pulls the whole gap: an approval short of it fails and moves nothing
    await usdc.write.mint([sponsor.account.address, 40n * USD]); // balance now 50, plenty
    await usdc.write.approve([boomerang.address, 20n * USD], { account: sponsor.account }); // < 30 gap
    const sBal0 = await w.balance(sponsor);
    const cBal0 = await usdc.read.balanceOf([boomerang.address]);
    const state0 = await boomerang.read.stateOf([id]);
    await refused(boomerang.write.rescue([id], { account: sponsor.account }), "TransferFailed");
    assert.equal(await w.balance(sponsor), sBal0);
    assert.equal(await usdc.read.balanceOf([boomerang.address]), cBal0);
    assert.deepEqual(await boomerang.read.stateOf([id]), state0);

    // with enough approval it takes exactly the gap, no more
    await usdc.write.approve([boomerang.address, 30n * USD], { account: sponsor.account });
    await boomerang.write.rescue([id], { account: sponsor.account });
    assert.equal(sBal0 - (await w.balance(sponsor)), 30n * USD);
    assert.equal((await usdc.read.balanceOf([boomerang.address])) - cBal0, 30n * USD);
    const s = await boomerang.read.stateOf([id]);
    assert.equal(s.outcome, Outcome.Funded);
    assert.equal(s.pledged, t.target);
  });

  // A9 ----------------------------------------------------------------------
  it("A9 no way out before the outcome", async function () {
    // no function offers an exit: nothing named withdraw/cancel/refund/sweep exists
    const names = boomerang.abi
      .filter((x) => x.type === "function")
      .map((x) => (x as { name: string }).name.toLowerCase());
    for (const bad of ["withdraw", "cancel", "refund", "sweep"]) {
      assert.ok(!names.some((n) => n.includes(bad)), `found a function named like "${bad}"`);
    }
    // and pay cannot be used to escape an open campaign
    const { id, t } = await w.open();
    await w.pledge(id, alice, 30n * USD, t.opensAt + 1n);
    const a0 = await w.balance(alice);
    await boomerang.write.pay([id, alice.account.address], { account: stranger.account });
    await boomerang.write.payMany([id, [alice.account.address]], { account: stranger.account });
    assert.equal(await w.balance(alice), a0);
    assert.equal((await boomerang.read.stateOf([id])).outcome, Outcome.Open);
  });

  // A10 ---------------------------------------------------------------------
  it("A10 sponsor as payer or backer is refused", async function () {
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt);
    await w.fund(sponsor, 10n * USD);
    await refused(boomerang.write.pledge([id, 10n * USD], { account: sponsor.account }), "SponsorCannotPledge");
    await refused(
      boomerang.write.pledgeFor([id, sponsor.account.address, 10n * USD], { account: alice.account }),
      "SponsorCannotPledge",
    );
    assert.equal((await boomerang.read.stateOf([id])).pledged, 0n);
  });

  // A11 ---------------------------------------------------------------------
  it("A11 a direct transfer creates nothing owed", async function () {
    // a fresh chain so the gift can be read off the contract's absolute balance
    const f = await setup();
    const { boomerang, usdc, alice, stranger } = f;
    const { id, t } = await f.open();
    await f.pledge(id, alice, 30n * USD, t.opensAt + 1n);
    const owed0 = await boomerang.read.totalOwed();
    // a bare mint straight to the contract: a gift, owed to no one
    await usdc.write.mint([boomerang.address, 7n * USD]);
    assert.equal(await boomerang.read.totalOwed(), owed0);
    assert.equal((await boomerang.read.backerOf([id, stranger.account.address])).principal, 0n);
    // authority is by sender, not by claim: a stranger cannot fund the match
    await refused(boomerang.write.fundMatch([id], { account: stranger.account }), "NotSponsor");

    // miss, pay the backer and every side; the gift is still there, owed to no one
    await f.time.increaseTo(t.closesAt);
    await boomerang.write.finalize([id], { account: stranger.account });
    await boomerang.write.pay([id, alice.account.address], { account: stranger.account });
    for (const side of [Side.Recipient, Side.MatchReturn, Side.BonusReturn]) {
      await boomerang.write.paySide([id, side], { account: stranger.account });
    }
    assert.equal(await boomerang.read.totalOwed(), 0n);
    assert.equal(await usdc.read.balanceOf([boomerang.address]), 7n * USD);
  });

  // A13 ---------------------------------------------------------------------
  it("A13 finalize costs the same with 2 backers or 40", async function () {
    const gen = (i: number) => ("0x" + (i + 1).toString(16).padStart(40, "0")) as `0x${string}`;

    // a campaign with two backers
    const two = await w.open();
    await w.fund(alice, 2n * USD);
    await w.time.increaseTo(two.t.opensAt);
    await boomerang.write.pledgeFor([two.id, gen(1), 1n * USD], { account: alice.account });
    await boomerang.write.pledgeFor([two.id, gen(2), 1n * USD], { account: alice.account });

    // a campaign with forty, all paid for by one payer to generated addresses
    const many = await w.open();
    await w.fund(bob, 40n * USD);
    await w.time.increaseTo(many.t.opensAt);
    for (let i = 0; i < 40; i++) {
      await boomerang.write.pledgeFor([many.id, gen(1000 + i), 1n * USD], { account: bob.account });
    }
    assert.equal((await boomerang.read.stateOf([many.id])).backers, 40);

    const close = two.t.closesAt > many.t.closesAt ? two.t.closesAt : many.t.closesAt;
    await w.time.increaseTo(close);
    const hTwo = await finalize(two.id);
    const gTwo = (await w.publicClient.waitForTransactionReceipt({ hash: hTwo })).gasUsed;
    const hMany = await finalize(many.id);
    const gMany = (await w.publicClient.waitForTransactionReceipt({ hash: hMany })).gasUsed;
    const diff = gTwo > gMany ? gTwo - gMany : gMany - gTwo;
    assert.ok(diff * 100n < gTwo, `finalize gas differs by >=1%: ${gTwo} vs ${gMany}`);
  });

  // A16 ---------------------------------------------------------------------
  it("A16 no function can change a campaign's terms", async function () {
    // the full set of state-changing functions is exactly these eleven
    const nonView = boomerang.abi
      .filter((x) => x.type === "function" && !["view", "pure"].includes(x.stateMutability))
      .map((x) => (x as { name: string }).name)
      .sort();
    assert.deepEqual(nonView, [
      "createCampaign", "finalize", "fundBonus", "fundMatch", "pay", "payMany",
      "paySide", "pledge", "pledgeFor", "redirect", "rescue",
    ]);

    // and the terms a campaign was created with never change, through pledges or finalize
    const { id, t } = await w.open();
    const terms0 = await boomerang.read.termsOf([id]);
    await w.pledge(id, alice, 30n * USD, t.opensAt + 1n);
    await w.pledge(id, bob, 10n * USD);
    assert.deepEqual(await boomerang.read.termsOf([id]), terms0);
    await w.time.increaseTo(t.closesAt);
    await finalize(id);
    assert.deepEqual(await boomerang.read.termsOf([id]), terms0);
  });

  // A17 ---------------------------------------------------------------------
  it("A17 everything settles without the sponsor", async function () {
    // a fresh chain so the leftover balance is attributable to this campaign alone
    const f = await setup();
    const { boomerang, usdc, alice, bob, carol, stranger } = f;
    // the sponsor's only act is funding the pots at creation; a stranger does the rest
    const { id, t } = await f.open();
    await f.pledge(id, alice, 30n * USD, t.opensAt + 1n);
    await f.pledge(id, bob, 20n * USD);
    await f.pledge(id, carol, 10n * USD, t.earlyUntil + 1n);
    await f.time.increaseTo(t.closesAt);
    const holds0 = await usdc.read.balanceOf([boomerang.address]); // all money in for this campaign
    await boomerang.write.finalize([id], { account: stranger.account });
    await boomerang.write.payMany(
      [id, [alice.account.address, bob.account.address, carol.account.address]],
      { account: stranger.account },
    );
    for (const side of [Side.Recipient, Side.MatchReturn, Side.BonusReturn]) {
      await boomerang.write.paySide([id, side], { account: stranger.account });
    }
    // two early backers could leave at most one base unit of dust each
    const left = await usdc.read.balanceOf([boomerang.address]);
    assert.ok(left <= 2n, `settled balance left ${left}`);
    assert.ok(holds0 >= 90n * USD); // pledges 60 + match 20 + bonus 10
    await f.assertCustody();
  });

  // A18 ---------------------------------------------------------------------
  it("A18 a re-entering token is refused", async function () {
    const { viem, networkHelpers } = await network.create();
    const time = networkHelpers.time;
    const [sp, rp, al, st] = await viem.getWalletClients();
    const token = await viem.deployContract("HostileToken");
    const boom = await viem.deployContract("Boomerang", [token.address]);
    const reentered = encodeErrorResult({ abi: boom.abi, errorName: "Reentered" });

    // a campaign with both pots in
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

    // (1) re-enter during a pledge's transferFrom: the inner call is refused, the pledge stands
    await token.write.mint([al.account.address, 30n * USD]);
    await token.write.approve([boom.address, 30n * USD], { account: al.account });
    await token.write.arm([
      boom.address,
      encodeFunctionData({ abi: boom.abi, functionName: "pledge", args: [id, 30n * USD] }),
      false,
      true,
    ]);
    await time.setNextBlockTimestamp(terms.opensAt + 1n);
    await boom.write.pledge([id, 30n * USD], { account: al.account });
    assert.equal(await token.read.lastInnerOk(), false);
    assert.equal((await token.read.lastInnerReturn()).toLowerCase(), reentered.toLowerCase());
    assert.equal((await boom.read.backerOf([id, al.account.address])).principal, 30n * USD);
    assert.equal((await boom.read.stateOf([id])).pledged, 30n * USD); // recorded once, not twice

    // (2) re-enter during a payout's transfer: again refused, and the backer is paid once
    await time.increaseTo(terms.closesAt);
    await boom.write.finalize([id], { account: st.account });
    await token.write.arm([
      boom.address,
      encodeFunctionData({ abi: boom.abi, functionName: "pay", args: [id, al.account.address] }),
      true,
      false,
    ]);
    const a0 = await token.read.balanceOf([al.account.address]);
    await boom.write.pay([id, al.account.address], { account: st.account });
    assert.equal(await token.read.lastInnerOk(), false);
    assert.equal((await token.read.lastInnerReturn()).toLowerCase(), reentered.toLowerCase());
    // 30 early, pledgedEarly 30e6, weighted 3e13, cap 1.5e6, bonusPaid 450_000; one backer gets it all
    assert.equal((await token.read.balanceOf([al.account.address])) - a0, 30n * USD + 450_000n);
    assert.deepEqual(await boom.read.owedTo([id, al.account.address]), [0n, 0n]);
    // accounting intact: the contract still holds at least what it owes
    const holds = await token.read.balanceOf([boom.address]);
    const owes = await boom.read.totalOwed();
    assert.ok(holds >= owes, `holds ${holds} owes ${owes}`);
  });

  // A19 ---------------------------------------------------------------------
  it("A19 a backer is paid once", async function () {
    const { id } = await missed(); // alice 30 early, bob 20 early, carol 10 late
    // paying twice pays only the first time
    const a0 = await w.balance(alice);
    await boomerang.write.pay([id, alice.account.address], { account: stranger.account });
    const firstPaid = (await w.balance(alice)) - a0;
    assert.equal(firstPaid, 30n * USD + 750_000n); // 50 early, bonus 1.25, alice 3/5 -> 0.75
    await boomerang.write.pay([id, alice.account.address], { account: stranger.account });
    assert.equal((await w.balance(alice)) - a0, firstPaid); // no second payment

    // the same name three times in one batch pays once
    const b0 = await w.balance(bob);
    await boomerang.write.payMany(
      [id, [bob.account.address, bob.account.address, bob.account.address]],
      { account: stranger.account },
    );
    assert.equal((await w.balance(bob)) - b0, 20n * USD + 500_000n); // paid exactly once
    assert.deepEqual(await boomerang.read.owedTo([id, bob.account.address]), [0n, 0n]);
    await w.assertCustody();
  });

  // A20 ---------------------------------------------------------------------
  it("A20 the caller of pay gains nothing", async function () {
    const { id } = await missed();
    const a0 = await w.balance(alice);
    const s0 = await w.balance(stranger);
    await boomerang.write.pay([id, alice.account.address], { account: stranger.account });
    assert.equal((await w.balance(alice)) - a0, 30n * USD + 750_000n); // the full amount goes to the backer
    assert.equal(await w.balance(stranger), s0); // the caller gains nothing
    // and the caller cannot redirect a payout they have no claim to
    await refused(boomerang.write.redirect([id, stranger.account.address], { account: stranger.account }), "NoRecord");
  });

  // A21 ---------------------------------------------------------------------
  it("A21 the largest allowed campaign settles exactly", async function () {
    const M = 10n ** 15n; // MAX_AMOUNT
    const early = M - 1n;
    const { id, t } = await w.open({ target: M, matchAmount: M, bonusPool: M, rateBps: 10_000 });
    await w.pledge(id, alice, early, t.opensAt + 1n); // one early pledge, short of the target
    await w.time.increaseTo(t.closesAt);
    await finalize(id);

    // weighted = (M-1) x WEIGHT_ONE; cap = 10_000 x weighted / 1e10 = M-1; pool = min(M, M-1) = M-1;
    // bonusPaid = (M-1) x (M-1) / M = (M-1)^2 / M, floored = M - 2.
    const weighted = early * ONE;
    const cap = (10_000n * weighted) / 10_000_000_000n;
    const pool = cap < M ? cap : M;
    const expectedBonus = (early * pool) / M;
    assert.equal(expectedBonus, M - 2n);
    assert.equal((await boomerang.read.stateOf([id])).bonusPaid, expectedBonus);
    assert.deepEqual(await boomerang.read.owedTo([id, alice.account.address]), [early, expectedBonus]);

    // everything pays out with no revert
    await boomerang.write.pay([id, alice.account.address], { account: stranger.account });
    for (const side of [Side.Recipient, Side.MatchReturn, Side.BonusReturn]) {
      await boomerang.write.paySide([id, side], { account: stranger.account });
    }
    assert.deepEqual(await boomerang.read.owedTo([id, alice.account.address]), [0n, 0n]);
    await w.assertCustody();
  });
});
