// Every amount and account in these tests is invented. None is a reading of any real campaign.
//
// The app's loaders (web/src/data/load.ts) over the real contract, through the kit's reader.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Outcome, setup, USD } from "./helpers.ts";
import { reader } from "../../packages/kit/src/index.ts";
import { custodyNow, loadCampaigns, loadMine, totalsOf } from "../../web/src/data/load.ts";

describe("the app's loaders", function () {
  it("web.load: campaigns come newest first with the contract's own figures, and one address's pledges are found across them", async function () {
    const w = await setup();
    const reads = reader(w.publicClient, w.boomerang.address);
    assert.deepEqual(await loadCampaigns(reads), []);

    // 1: funded. 2: missed, finalized, unpaid. 3: open, with Bob in it. 4: open, without him.
    const funded = await w.open();
    await w.time.increaseTo(funded.t.opensAt);
    await w.pledge(funded.id, w.alice, 60n * USD, funded.t.opensAt + 10n);
    await w.pledge(funded.id, w.bob, 40n * USD, funded.t.opensAt + 20n);

    const missed = await w.open();
    await w.time.increaseTo(missed.t.opensAt);
    await w.pledge(missed.id, w.bob, 30n * USD, missed.t.opensAt + 10n);
    await w.pledge(missed.id, w.carol, 20n * USD, missed.t.opensAt + 20n);
    await w.time.increaseTo(missed.t.closesAt);
    await w.boomerang.write.finalize([missed.id], { account: w.stranger.account });

    const open = await w.open();
    await w.time.increaseTo(open.t.opensAt);
    await w.pledge(open.id, w.bob, 25n * USD, open.t.opensAt + 10n);
    const other = await w.open();

    const all = await loadCampaigns(reads);
    assert.deepEqual(all.map((c) => c.id), [other.id, open.id, missed.id, funded.id]);
    assert.deepEqual(all.map((c) => c.state.outcome), [Outcome.Open, Outcome.Open, Outcome.Missed, Outcome.Funded]);
    for (const c of all) {
      assert.deepEqual(c.terms, await w.boomerang.read.termsOf([c.id]));
      assert.deepEqual(c.state, await w.boomerang.read.stateOf([c.id]));
    }
    assert.deepEqual((await loadCampaigns(reads, 2)).map((c) => c.id), [other.id, open.id]);

    const totals = totalsOf(all);
    assert.equal(totals.campaigns, 4);
    assert.equal(totals.backers, 5);
    assert.equal(totals.pledged, (100n + 50n + 25n) * USD);
    assert.equal(totals.bonusPaid, (await w.boomerang.read.stateOf([missed.id])).bonusPaid);
    assert.ok(totals.bonusPaid > 0n);

    // Bob is in three of the four; the list keeps the campaigns' order.
    const bob = w.bob.account.address;
    const mine = await loadMine(reads, all, bob);
    assert.deepEqual(mine.map((m) => m.campaign.id), [open.id, missed.id, funded.id]);
    const [inOpen, inMissed, inFunded] = mine;

    // Open: nothing is owed yet; if it missed from here he would get his pledge and some bonus.
    assert.deepEqual(inOpen.owed, { principal: 0n, bonus: 0n });
    assert.equal(inOpen.ifMissed.principal, 25n * USD);
    assert.ok(inOpen.ifMissed.bonus > 0n);
    // Missed and unpaid: the refund and his share of the bonus are owed now.
    assert.equal(inMissed.owed.principal, 30n * USD);
    assert.ok(inMissed.owed.bonus > 0n);
    assert.equal(inMissed.backer.paid, false);
    // Funded: his pledge went to the recipient; nothing comes back.
    assert.deepEqual(inFunded.owed, { principal: 0n, bonus: 0n });
    assert.deepEqual(inFunded.ifMissed, { principal: 0n, bonus: 0n });
    assert.equal(inFunded.backer.principal, 40n * USD);

    // Once paid, the same view shows nothing owed.
    await w.boomerang.write.pay([missed.id, bob], { account: w.stranger.account });
    const after = (await loadMine(reads, all, bob)).find((m) => m.campaign.id === missed.id)!;
    assert.deepEqual(after.owed, { principal: 0n, bonus: 0n });
    assert.equal(after.backer.paid, true);

    // An address with no pledge anywhere has an empty list.
    assert.deepEqual(await loadMine(reads, all, w.erin.account.address), []);
  });

  it("web.custody: held, owed and the event count are read at one block, and a shortfall is reported, not hidden", async function () {
    const w = await setup();
    const where = { boomerang: w.boomerang.address, usdc: w.usdc.address };
    const m = await w.open();
    await w.time.increaseTo(m.t.opensAt);
    await w.pledge(m.id, w.bob, 30n * USD, m.t.opensAt + 10n);

    // Every read the function makes names the same block.
    const blocks: (bigint | undefined)[] = [];
    const spy = new Proxy(w.publicClient, {
      get(target, prop, receiver) {
        if (prop !== "readContract") return Reflect.get(target, prop, receiver);
        return (args: { blockNumber?: bigint }) => {
          blocks.push(args.blockNumber);
          return target.readContract(args as never);
        };
      },
    });
    const c = await custodyNow(spy as typeof w.publicClient, where);
    assert.equal(blocks.length, 3);
    assert.ok(blocks.every((b) => b === c.block));
    assert.equal(c.block, await w.publicClient.getBlockNumber());
    assert.equal(c.held, await w.usdc.read.balanceOf([w.boomerang.address]));
    assert.equal(c.owed, await w.boomerang.read.totalOwed());
    assert.equal(c.events, await w.boomerang.read.eventCount());
    assert.equal(c.ok, true);
    assert.ok(c.owed > 0n);

    // Pointed at a token the contract holds none of, the same check says so.
    const other = await w.viem.deployContract("TestUSDC");
    const short = await custodyNow(w.publicClient, { boomerang: w.boomerang.address, usdc: other.address });
    assert.equal(short.held, 0n);
    assert.equal(short.ok, false);
  });
});
