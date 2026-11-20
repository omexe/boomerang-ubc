// Every amount and account in these tests is invented. None is a reading of any real campaign.
//
// The app's one-block read (web/src/app/world.ts) over the real contract.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { setup, USD } from "./helpers.ts";
import { campaignIn, readWorld } from "../../web/src/app/world.ts";
import type { KeeperAnswer } from "../../web/src/data/ask.ts";
import { readHealth } from "../../web/src/data/health.ts";
import type { LedgerView } from "../../web/src/data/keeper.ts";
import { proofPage } from "../../web/src/views/proof.ts";

const noKeeper = async (): Promise<KeeperAnswer> => ({ up: false, why: "none" });
const ZERO = "0x0000000000000000000000000000000000000000";

describe("the app's one-block read", function () {
  it("world.oneBlock: every figure is read at the one block the page names", async function () {
    const w = await setup();
    const a = await w.open();
    await w.time.increaseTo(a.t.opensAt);
    await w.pledge(a.id, w.alice, 60n * USD, a.t.opensAt + 10n);
    const b = await w.open();
    await w.time.increaseTo(b.t.opensAt);
    await w.pledge(b.id, w.bob, 30n * USD, b.t.opensAt + 10n);

    // Record the block each read asks for.
    const asked: (bigint | undefined)[] = [];
    const watching = new Proxy(w.publicClient, {
      get(target, prop, receiver) {
        if (prop !== "readContract") return Reflect.get(target, prop, receiver);
        return (args: { blockNumber?: bigint }) => {
          asked.push(args.blockNumber);
          return (target.readContract as (a: unknown) => Promise<unknown>)(args);
        };
      },
    });
    const where = { boomerang: w.boomerang.address, usdc: w.usdc.address };
    const bob = w.bob.account.address;
    const world = await readWorld({ client: watching as typeof w.publicClient, where, account: bob, keeper: noKeeper });

    assert.ok(asked.length >= 12, `${asked.length} reads`);
    assert.ok(asked.every((n) => n === world.block), "every read names the same block");
    const block = await w.publicClient.getBlock({ blockNumber: world.block });
    assert.equal(world.now, block.timestamp);

    // The figures are the contract's.
    assert.equal(world.count, 2n);
    assert.deepEqual(world.campaigns.map((c) => c.id), [b.id, a.id]);
    for (const c of world.campaigns) assert.deepEqual(c.state, await w.boomerang.read.stateOf([c.id]));
    assert.equal(world.custody.block, world.block);
    assert.equal(world.custody.held, await w.balance({ address: w.boomerang.address }));
    assert.equal(world.custody.owed, await w.boomerang.read.totalOwed());
    assert.equal(world.custody.ok, true);
    assert.deepEqual(world.mine.map((m) => m.campaign.id), [b.id]);
    assert.equal(world.balance, await w.balance({ address: bob }));
    assert.equal(world.allowance, 0n);
    assert.deepEqual(world.keeper, { up: false, why: "none" });
  });

  it("world.then: a read made before a pledge stays what it was; the next read is of a later block and has the pledge", async function () {
    const w = await setup();
    const a = await w.open();
    await w.time.increaseTo(a.t.opensAt);
    const where = { boomerang: w.boomerang.address, usdc: w.usdc.address };
    const before = await readWorld({ client: w.publicClient, where, account: null, keeper: noKeeper });
    assert.equal(before.campaigns[0].state.pledged, 0n);
    assert.deepEqual([before.account, before.mine, before.balance, before.allowance], [null, [], null, null]);

    await w.pledge(a.id, w.alice, 60n * USD, a.t.opensAt + 10n);
    const after = await readWorld({ client: w.publicClient, where, account: null, keeper: noKeeper });
    assert.ok(after.block > before.block);
    assert.equal(after.campaigns[0].state.pledged, 60n * USD);
    assert.equal(before.campaigns[0].state.pledged, 0n);
    assert.equal(after.custody.owed - before.custody.owed, 60n * USD);
  });

  it("world.also: a campaign older than those read is read on its own at the same block, with the account's pledge to it", async function () {
    const w = await setup();
    const a = await w.open();
    const b = await w.open();
    await w.time.increaseTo(a.t.opensAt);
    await w.pledge(a.id, w.alice, 60n * USD, a.t.opensAt + 10n);
    const where = { boomerang: w.boomerang.address, usdc: w.usdc.address };
    const alice = w.alice.account.address;
    // Reading only the newest one leaves campaign `a` out, unless the page asks for it.
    const without = await readWorld({ client: w.publicClient, where, account: alice, keeper: noKeeper, newest: 1 });
    assert.deepEqual([without.count, without.campaigns.map((c) => c.id), without.extra, without.mine.length], [2n, [b.id], null, 0]);
    assert.equal(campaignIn(without, a.id), undefined);
    const withIt = await readWorld({ client: w.publicClient, where, account: alice, keeper: noKeeper, newest: 1, also: a.id });
    assert.deepEqual(withIt.campaigns.map((c) => c.id), [b.id]); // the newest are still only the newest
    assert.equal(withIt.extra?.id, a.id);
    assert.equal(campaignIn(withIt, a.id)?.state.pledged, 60n * USD);
    assert.deepEqual(withIt.mine.map((m) => [m.campaign.id, m.backer.principal]), [[a.id, 60n * USD]]);
    // A number already among those read, or one the contract does not have, adds nothing.
    assert.equal((await readWorld({ client: w.publicClient, where, account: null, keeper: noKeeper, newest: 1, also: b.id })).extra, null);
    assert.equal((await readWorld({ client: w.publicClient, where, account: null, keeper: noKeeper, newest: 1, also: 99n })).extra, null);
  });

  it("world.backers: the contract's own backer records are read at the one block, and a ledger with one wrong record reads differs", async function () {
    const w = await setup();
    const a = await w.open();
    await w.time.increaseTo(a.t.opensAt);
    await w.pledge(a.id, w.alice, 60n * USD, a.t.opensAt + 10n);
    const where = { boomerang: w.boomerang.address, usdc: w.usdc.address };
    const alice = w.alice.account.address;

    // A ledger that matches the contract, then one backer field (the pledged amount) made wrong.
    const terms = await w.boomerang.read.termsOf([a.id]);
    const state = await w.boomerang.read.stateOf([a.id]);
    const chainBacker = await w.boomerang.read.backerOf([a.id, alice]);
    const ledger: LedgerView = {
      lastSeq: await w.boomerang.read.eventCount(),
      totalOwed: await w.boomerang.read.totalOwed(),
      missing: null,
      feed: [],
      campaigns: [
        {
          id: a.id, sponsor: state.sponsor, terms, matchIn: state.matchIn, bonusIn: state.bonusIn, outcome: state.outcome,
          pledged: state.pledged, pledgedEarly: state.pledgedEarly, earlyUnknown: 0n, weighted: state.weighted,
          bonusPaid: state.bonusPaid, expectedBonusPaid: null, recipientPaid: state.recipientPaid, matchReturned: state.matchReturned,
          bonusReturned: state.bonusReturned, payFailures: 0,
          backers: [{ address: alice, principal: chainBacker.principal + 1n, weighted: chainBacker.weighted, payTo: chainBacker.payTo.toLowerCase() === ZERO ? null : chainBacker.payTo, paid: chainBacker.paid, paidPrincipal: 0n, paidBonus: 0n }],
        },
      ],
    };
    const health = readHealth({
      lastSeq: ledger.lastSeq.toString(), missing: null, pending: 0, repeats: 0, lastBlock: 0, lastTime: "0",
      sent: 0, failedSends: 0, rejected: 0, gaveUp: [], lastErrors: [], settled: true, desk: null,
    });

    const world = await readWorld({ client: w.publicClient, where, account: alice, keeper: async (): Promise<KeeperAnswer> => ({ up: true, ledger, health }) });
    // The contract's own record was read for the one ledger backer, at the page's block.
    assert.equal(world.backerTotal, 1);
    assert.equal(world.backerChecks?.length, 1);
    assert.equal(world.backerChecks![0].chain.principal, chainBacker.principal);

    const page = proofPage({
      custody: world.custody, campaigns: world.campaigns, count: world.count,
      ledger, health, backerChecks: world.backerChecks, backerTotal: world.backerTotal,
      where: { ...where, router: w.boomerang.address },
      pace: { state: "prompt" },
    });
    assert.equal(page.second.state, "differs");
    assert.ok(
      page.second.differences.some((d) => d.includes("backer") && d.includes("pledged:")),
      page.second.differences.join(" | "),
    );
  });

  it("world.keeper: the keeper is asked once, its answer is passed through, and it changes no figure", async function () {
    const w = await setup();
    await w.open();
    const where = { boomerang: w.boomerang.address, usdc: w.usdc.address };
    let asks = 0;
    const down = await readWorld({
      client: w.publicClient,
      where,
      account: null,
      keeper: async () => {
        asks += 1;
        return { up: false, why: "unreachable" };
      },
    });
    assert.equal(asks, 1);
    assert.deepEqual(down.keeper, { up: false, why: "unreachable" });
    const none = await readWorld({ client: w.publicClient, where, account: null, keeper: noKeeper });
    assert.deepEqual(down.campaigns, none.campaigns);
    assert.deepEqual({ ...down.custody, block: 0n, time: 0n }, { ...none.custody, block: 0n, time: 0n });
  });

  // A ledger as the keeper would hold it for these campaigns, listing the given addresses as backers.
  async function keeperFor(w: Awaited<ReturnType<typeof setup>>, listed: { id: bigint; backers: `0x${string}`[] }[]): Promise<() => Promise<KeeperAnswer>> {
    const campaigns: LedgerView["campaigns"] = [];
    for (const { id, backers } of listed) {
      const terms = await w.boomerang.read.termsOf([id]);
      const state = await w.boomerang.read.stateOf([id]);
      campaigns.push({
        id, sponsor: state.sponsor, terms, matchIn: state.matchIn, bonusIn: state.bonusIn, outcome: state.outcome,
        pledged: state.pledged, pledgedEarly: state.pledgedEarly, earlyUnknown: 0n, weighted: state.weighted,
        bonusPaid: state.bonusPaid, expectedBonusPaid: null, recipientPaid: state.recipientPaid, matchReturned: state.matchReturned,
        bonusReturned: state.bonusReturned, payFailures: 0,
        backers: backers.map((address) => ({ address, principal: 0n, weighted: 0n, payTo: null, paid: false, paidPrincipal: 0n, paidBonus: 0n })),
      });
    }
    const ledger: LedgerView = { lastSeq: await w.boomerang.read.eventCount(), totalOwed: await w.boomerang.read.totalOwed(), missing: null, feed: [], campaigns };
    const health = readHealth({
      lastSeq: ledger.lastSeq.toString(), missing: null, pending: 0, repeats: 0, lastBlock: 0, lastTime: "0",
      sent: 0, failedSends: 0, rejected: 0, gaveUp: [], lastErrors: [], settled: true, desk: null,
    });
    return async () => ({ up: true, ledger, health });
  }

  it("world.lookup: any address's pledges are read at the page's block, beside the connected account's own", async function () {
    const w = await setup();
    const a = await w.open();
    await w.pledge(a.id, w.alice, 60n * USD, a.t.opensAt + 10n);
    await w.pledge(a.id, w.bob, 25n * USD, a.t.opensAt + 20n);
    const where = { boomerang: w.boomerang.address, usdc: w.usdc.address };
    const alice = w.alice.account.address;
    const bob = w.bob.account.address;

    const world = await readWorld({ client: w.publicClient, where, account: alice, keeper: noKeeper, lookup: bob });
    assert.equal(world.lookup?.address, bob.toLowerCase(), "kept in lower case, which every read accepts");
    assert.equal(world.lookup?.example, false);
    assert.deepEqual(world.lookup?.mine.map((m) => [m.campaign.id, m.backer.principal]), [[a.id, 25n * USD]]);
    // An address typed in capitals, or with a wrong mix of cases, is the same account and must not stop the read.
    for (const typed of [`0x${bob.slice(2).toUpperCase()}`, `0x${bob.slice(2, 22).toUpperCase()}${bob.slice(22).toLowerCase()}`] as `0x${string}`[]) {
      const odd = await readWorld({ client: w.publicClient, where, account: null, keeper: noKeeper, lookup: typed });
      assert.deepEqual([odd.lookup?.address, odd.lookup?.mine.map((m) => m.backer.principal)], [bob.toLowerCase(), [25n * USD]], typed);
    }
    assert.deepEqual(world.mine.map((m) => m.backer.principal), [60n * USD], "the connected account's own pledges are still its own");
    // An address that never pledged is looked up and has nothing; no look-up asked for, none made.
    assert.deepEqual((await readWorld({ client: w.publicClient, where, account: null, keeper: noKeeper, lookup: w.stranger.account.address })).lookup, { address: w.stranger.account.address.toLowerCase(), mine: [], example: false });
    assert.equal((await readWorld({ client: w.publicClient, where, account: alice, keeper: noKeeper })).lookup, null);
  });

  it("world.example: with nobody connected and the keeper up, the backer in the most campaigns stands as the example; never otherwise", async function () {
    const w = await setup();
    const a = await w.open();
    await w.pledge(a.id, w.alice, 60n * USD, a.t.opensAt + 10n);
    await w.pledge(a.id, w.bob, 25n * USD, a.t.opensAt + 20n);
    const b = await w.open();
    await w.pledge(b.id, w.bob, 10n * USD, b.t.opensAt + 10n);
    const where = { boomerang: w.boomerang.address, usdc: w.usdc.address };
    const alice = w.alice.account.address;
    const bob = w.bob.account.address;
    const keeper = await keeperFor(w, [{ id: a.id, backers: [alice, bob] }, { id: b.id, backers: [bob] }]);

    const world = await readWorld({ client: w.publicClient, where, account: null, keeper, example: true });
    assert.equal(world.lookup?.address, bob.toLowerCase());
    assert.equal(world.lookup?.example, true);
    // The figures are the contract's, not the ledger's (which here holds zeros).
    assert.deepEqual(world.lookup?.mine.map((m) => [m.campaign.id, m.backer.principal]).sort(), [[a.id, 25n * USD], [b.id, 10n * USD]].sort());

    assert.equal((await readWorld({ client: w.publicClient, where, account: null, keeper })).lookup, null, "not asked for");
    assert.equal((await readWorld({ client: w.publicClient, where, account: alice, keeper, example: true })).lookup, null, "someone is connected");
    assert.equal((await readWorld({ client: w.publicClient, where, account: null, keeper: noKeeper, example: true })).lookup, null, "the keeper is down");
    // Looking up the connected account itself reads nothing twice: its pledges are already `mine`.
    const self = await readWorld({ client: w.publicClient, where, account: alice, keeper, lookup: `0x${alice.slice(2).toUpperCase()}` as `0x${string}` });
    assert.equal(self.lookup, null);
    assert.equal(self.mine.length, 1);
    // A look-up asked for wins over the example.
    const looked = await readWorld({ client: w.publicClient, where, account: null, keeper, example: true, lookup: alice });
    assert.deepEqual([looked.lookup?.address, looked.lookup?.example], [alice.toLowerCase(), false]);
    // An explicit look-up does not wait for the keeper: it is read even when the keeper never answers in time for it.
    let keeperAsked = false;
    const order: string[] = [];
    const watched = new Proxy(w.publicClient, {
      get(target, prop, receiver) {
        if (prop !== "readContract") return Reflect.get(target, prop, receiver);
        return (args: { functionName?: string; args?: readonly unknown[] }) => {
          if (args.functionName === "backerOf" && String(args.args?.[1]).toLowerCase() === alice.toLowerCase()) order.push(keeperAsked ? "after" : "before");
          return (target.readContract as (a: unknown) => Promise<unknown>)(args);
        };
      },
    });
    await readWorld({
      client: watched as typeof w.publicClient, where, account: null, lookup: alice,
      keeper: async () => {
        await new Promise((r) => setTimeout(r, 150));
        keeperAsked = true;
        return { up: false, why: "unreachable" };
      },
    });
    assert.ok(order.length > 0 && order.every((o) => o === "before"), order.join(","));
  });

  it("world.example.within: the example is chosen among the campaigns this read takes in, so its page is never empty", async function () {
    const w = await setup();
    const a = await w.open();
    await w.pledge(a.id, w.alice, 60n * USD, a.t.opensAt + 10n);
    const b = await w.open();
    await w.pledge(b.id, w.alice, 20n * USD, b.t.opensAt + 10n);
    const c = await w.open();
    await w.pledge(c.id, w.bob, 10n * USD, c.t.opensAt + 10n);
    const where = { boomerang: w.boomerang.address, usdc: w.usdc.address };
    const alice = w.alice.account.address;
    const bob = w.bob.account.address;
    const keeper = await keeperFor(w, [{ id: a.id, backers: [alice] }, { id: b.id, backers: [alice] }, { id: c.id, backers: [bob] }]);

    // Reading only the newest campaign: alice backs more campaigns, but none of those read.
    const world = await readWorld({ client: w.publicClient, where, account: null, keeper, example: true, newest: 1 });
    assert.deepEqual(world.campaigns.map((x) => x.id), [c.id]);
    assert.equal(world.lookup?.address, bob.toLowerCase());
    assert.deepEqual(world.lookup?.mine.map((m) => m.campaign.id), [c.id]);
    // With every campaign read, alice is the example again.
    assert.equal((await readWorld({ client: w.publicClient, where, account: null, keeper, example: true })).lookup?.address, alice.toLowerCase());
    // A ledger that lists nobody in the campaigns read gives no example.
    const elsewhere = await keeperFor(w, [{ id: a.id, backers: [alice] }]);
    assert.equal((await readWorld({ client: w.publicClient, where, account: null, keeper: elsewhere, example: true, newest: 1 })).lookup, null);
  });

  it("world.shownBackers: for the campaign shown, the contract's own record of each address the keeper lists", async function () {
    const w = await setup();
    const a = await w.open();
    await w.pledge(a.id, w.alice, 60n * USD, a.t.opensAt + 10n);
    await w.pledge(a.id, w.bob, 25n * USD, a.t.opensAt + 20n);
    const where = { boomerang: w.boomerang.address, usdc: w.usdc.address };
    const alice = w.alice.account.address;
    const bob = w.bob.account.address;
    const stranger = w.stranger.account.address;
    // The keeper lists one address that never pledged (the contract's record of it is empty, and it is passed on as read),
    // and one backer a second time in capitals, which is the same account and is read once.
    const keeper = await keeperFor(w, [{ id: a.id, backers: [alice, bob, stranger, `0x${bob.slice(2).toUpperCase()}` as `0x${string}`] }]);

    const world = await readWorld({ client: w.publicClient, where, account: null, keeper, backersOf: a.id });
    assert.equal(world.shownBackers?.id, a.id);
    assert.equal(world.shownBackers?.listed, 3);
    assert.deepEqual(world.shownBackers?.rows.map((r) => [r.address, r.backer.principal]), [[alice.toLowerCase(), 60n * USD], [bob.toLowerCase(), 25n * USD], [stranger.toLowerCase(), 0n]]);
    // The Proof page's backer-by-backer comparison reads the same odd-case address without failing.
    assert.equal(world.backerChecks?.length, 4);
    const mine = (await readWorld({ client: w.publicClient, where, account: alice, keeper: noKeeper })).mine[0];
    assert.deepEqual(world.shownBackers?.rows[0].ifMissed, mine.ifMissed, "what would come back is the contract's own answer");
    assert.deepEqual(world.shownBackers?.rows[0].owed, mine.owed);

    assert.equal((await readWorld({ client: w.publicClient, where, account: null, keeper })).shownBackers, null, "no campaign is shown");
    assert.equal((await readWorld({ client: w.publicClient, where, account: null, keeper: noKeeper, backersOf: a.id })).shownBackers, null, "the keeper is down");
    // A campaign the keeper's ledger does not have was still asked about: the answer is an empty list, not "not read".
    assert.deepEqual((await readWorld({ client: w.publicClient, where, account: null, keeper, backersOf: 99n })).shownBackers, { id: 99n, rows: [], listed: 0 });
  });
});
