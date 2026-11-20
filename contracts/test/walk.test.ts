// Every amount and account in these tests is invented. None is a reading of any real campaign.
//
// A seeded random walk over three campaigns. Each sequence fires a run of random actions and,
// after every one, checks the two custody invariants; at the end it settles everything and checks
// that only rounding dust is left and that no backer is still owed. The seed is printed so any
// failure can be replayed with WALK_SEED=<seed>.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";

import { USD } from "./helpers.ts";

/** mulberry32: a tiny deterministic PRNG, so a seed reproduces the whole walk. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEQUENCES = Number(process.env.WALK_SEQUENCES ?? 200);
const ACTIONS = Number(process.env.WALK_ACTIONS ?? 60);
const ZERO = "0x0000000000000000000000000000000000000000" as const;

const KINDS = [
  "pledge", "pledgeFor", "rescue", "finalize", "pay", "payMany",
  "paySide", "redirect", "blockToggle", "advanceTime", "directTransfer",
] as const;
type Kind = (typeof KINDS)[number];

describe("random walk: custody holds action by action, everything settles at the end", async function () {
  it(`survives ${SEQUENCES} sequences of ${ACTIONS} random actions`, async function () {
    const seed = Number(process.env.WALK_SEED ?? 0xb00_1e_1a);
    console.log(`[walk] seed=${seed} sequences=${SEQUENCES} actions=${ACTIONS}`);
    const rand = mulberry32(seed);
    const randInt = (n: number) => Math.floor(rand() * n);
    const randUsd = (maxUsd: number) => BigInt(1 + randInt(maxUsd)) * USD; // 1..maxUsd dollars

    const { viem, networkHelpers } = await network.create();
    const time = networkHelpers.time;
    const all = await viem.getWalletClients();
    const wallets = all.slice(0, 8); // mirror the fixture's eight accounts
    const addr = (i: number) => wallets[i].account.address;
    const usdc = await viem.deployContract("TestUSDC");
    const boomerang = await viem.deployContract("Boomerang", [usdc.address]);

    // give everyone a deep balance and an effectively unlimited allowance
    const APPROVAL = 1n << 255n;
    for (let i = 0; i < 8; i++) {
      await usdc.write.mint([addr(i), 1_000_000n * USD]);
      await usdc.write.approve([boomerang.address, APPROVAL], { account: wallets[i].account });
    }

    // three campaigns with varied terms, all on one timeline
    const base = BigInt(await time.latest());
    const opensAt = base + 100n;
    const earlyUntil = base + 3_100n;
    const closesAt = base + 6_100n;
    const mk = (over: Record<string, unknown>) => ({
      recipient: addr(1),
      opensAt, earlyUntil, closesAt,
      target: 100n * USD,
      minPledge: 1n * USD,
      matchAmount: 0n,
      bonusPool: 0n,
      rateBps: 500,
      linearWeight: false,
      bonusFromRecipient: false,
      ...over,
    });
    // c1: flat, both pots, sponsor-funded bonus
    await boomerang.write.createCampaign([mk({ matchAmount: 20n * USD, bonusPool: 10n * USD })], { account: wallets[0].account });
    // c2: linear, no pots
    await boomerang.write.createCampaign([mk({ linearWeight: true })], { account: wallets[0].account });
    // c3: linear, both pots, recipient-funded bonus
    await boomerang.write.createCampaign(
      [mk({ linearWeight: true, matchAmount: 15n * USD, bonusPool: 8n * USD, rateBps: 800, bonusFromRecipient: true })],
      { account: wallets[0].account },
    );
    await boomerang.write.fundMatch([1n], { account: wallets[0].account });
    await boomerang.write.fundBonus([1n], { account: wallets[0].account });
    await boomerang.write.fundMatch([3n], { account: wallets[0].account });
    await boomerang.write.fundBonus([3n], { account: wallets[1].account }); // the recipient funds c3's bonus
    const ids = [1n, 2n, 3n];

    const holds = () => usdc.read.balanceOf([boomerang.address]);
    const owes = () => boomerang.read.totalOwed();

    const ok: Record<Kind, number> = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number>;
    const reverted: Record<Kind, number> = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number>;

    let snap = await networkHelpers.takeSnapshot();
    const started = Date.now();

    for (let seq = 0; seq < SEQUENCES; seq++) {
      const blocked = new Array(8).fill(false);
      let directTotal = 0n; // gifts sent straight to the contract this sequence

      for (let step = 0; step < ACTIONS; step++) {
        const kind = KINDS[randInt(KINDS.length)];
        const id = ids[randInt(3)];
        const backer = 1 + randInt(7); // a non-sponsor account
        const h0 = await holds();
        const o0 = await owes();
        let isDirect = false;
        let directAmt = 0n;
        let didRevert = false;

        try {
          switch (kind) {
            case "pledge":
              await boomerang.write.pledge([id, randUsd(40)], { account: wallets[backer].account });
              break;
            case "pledgeFor": {
              const payer = 1 + randInt(7);
              await boomerang.write.pledgeFor([id, addr(backer), randUsd(40)], { account: wallets[payer].account });
              break;
            }
            case "rescue":
              await boomerang.write.rescue([id], { account: wallets[0].account });
              break;
            case "finalize":
              await boomerang.write.finalize([id], { account: wallets[backer].account });
              break;
            case "pay":
              await boomerang.write.pay([id, addr(backer)], { account: wallets[backer].account });
              break;
            case "payMany": {
              const list = [addr(1 + randInt(7)), addr(1 + randInt(7)), addr(1 + randInt(7))];
              await boomerang.write.payMany([id, list], { account: wallets[backer].account });
              break;
            }
            case "paySide":
              await boomerang.write.paySide([id, randInt(3)], { account: wallets[backer].account });
              break;
            case "redirect":
              await boomerang.write.redirect([id, addr(1 + randInt(7))], { account: wallets[backer].account });
              break;
            case "blockToggle": {
              const who = randInt(8);
              blocked[who] = !blocked[who];
              await usdc.write.setBlocked([addr(who), blocked[who]]);
              break;
            }
            case "advanceTime":
              await time.increase(BigInt(1 + randInt(2_000)));
              break;
            case "directTransfer": {
              isDirect = true;
              directAmt = randUsd(5);
              await usdc.write.transfer([boomerang.address, directAmt], { account: wallets[backer].account });
              break;
            }
          }
        } catch {
          didRevert = true;
        }

        const h1 = await holds();
        const o1 = await owes();
        // (a) the contract never holds less than it owes
        assert.ok(h1 >= o1, `seq ${seq} step ${step} ${kind}: holds ${h1} < owes ${o1}`);
        if (didRevert) {
          reverted[kind]++;
          // a reverted action moves nothing
          assert.equal(h1, h0, `seq ${seq} step ${step} ${kind}: balance moved on revert`);
          assert.equal(o1, o0, `seq ${seq} step ${step} ${kind}: owed moved on revert`);
        } else {
          ok[kind]++;
          if (isDirect) {
            // a direct transfer changes only the balance
            directTotal += directAmt;
            assert.equal(o1, o0, `seq ${seq} step ${step}: direct transfer changed owed`);
            assert.equal(h1 - h0, directAmt, `seq ${seq} step ${step}: direct transfer balance delta wrong`);
          } else {
            // (b) every other successful action moves balance and owed by the same amount
            assert.equal(h1 - h0, o1 - o0, `seq ${seq} step ${step} ${kind}: balance delta ${h1 - h0} != owed delta ${o1 - o0}`);
          }
        }
      }

      // --- settle everything ---
      const nowT = BigInt(await time.latest());
      if (nowT < closesAt + 1n) await time.increaseTo(closesAt + 1n); // past every closing time
      for (let i = 0; i < 8; i++) if (blocked[i]) await usdc.write.setBlocked([addr(i), false]); // unblock everyone
      const everyBacker = [1, 2, 3, 4, 5, 6, 7].map(addr);
      for (const id of ids) {
        try {
          await boomerang.write.finalize([id], { account: wallets[0].account });
        } catch {
          /* already final */
        }
        await boomerang.write.payMany([id, everyBacker], { account: wallets[0].account });
        for (const side of [0, 1, 2]) await boomerang.write.paySide([id, side], { account: wallets[0].account });
      }

      // the only balance left, beyond the direct gifts, is rounding dust: at most one unit per
      // backer that received a bonus (an early backer of a missed campaign)
      let bonusBackers = 0;
      for (const id of ids) {
        const s = await boomerang.read.stateOf([id]);
        if (s.outcome !== 2) continue; // 2 = Missed
        for (let i = 1; i <= 7; i++) {
          const b = await boomerang.read.backerOf([id, addr(i)]);
          if (b.weighted > 0n) bonusBackers++;
        }
      }
      const leftover = (await holds()) - directTotal;
      assert.ok(leftover >= 0n, `seq ${seq}: leftover ${leftover} below the direct gifts`);
      assert.ok(leftover <= BigInt(bonusBackers), `seq ${seq}: leftover ${leftover} over dust bound ${bonusBackers}`);
      // and nobody is still owed anything
      for (const id of ids) {
        for (let i = 1; i <= 7; i++) {
          assert.deepEqual(await boomerang.read.owedTo([id, addr(i)]), [0n, 0n], `seq ${seq} id ${id} backer ${i} still owed`);
        }
      }

      await snap.restore();
      snap = await networkHelpers.takeSnapshot();
    }

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const line = (r: Record<Kind, number>) => KINDS.map((k) => `${k}=${r[k]}`).join(" ");
    console.log(`[walk] ok:      ${line(ok)}`);
    console.log(`[walk] reverted:${line(reverted)}`);
    console.log(`[walk] ${SEQUENCES} sequences x ${ACTIONS} actions in ${secs}s`);
    assert.ok(true);
  });
});
