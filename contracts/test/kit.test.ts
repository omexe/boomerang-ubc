// Every amount and account in these tests is invented. None is a reading of any real campaign.
//
// Four properties of @boomerang/kit, checked against the live contract:
//   T1 the pure math reproduces the contract's views exactly;
//   T2 the event-sourced ledger, rebuilt from logs alone, equals the contract's own state;
//   T3 repeats and disorder change nothing and a missing event stops the ledger exactly there;
//   T4 other contracts' logs are skipped and hex block fields are read as bigint;
//   T5 a zero-weight early pledge is counted when the log has a time and never guessed without.
// The seed is printed in the describe title; replay a failure with KIT_SEED=<seed>.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { setup, USD } from "./helpers.ts";
import {
  Outcome,
  Side,
  applyEvents,
  decodeLogs,
  emptyLedger,
  missing,
  outcomeAt as kitOutcomeAt,
  owedTo as kitOwedTo,
  positionIfMissed as kitPosition,
  quoteIfMissed as kitQuote,
  reader,
  sideAmount as kitSideAmount,
  weightAt as kitWeightAt,
  type Address,
  type Backer,
  type BoomerangEvent,
  type RawLog,
  type State,
  type Terms,
} from "../../packages/kit/src/index.ts";

const SEED = Number(process.env.KIT_SEED ?? 20261115);
const ZERO = "0x0000000000000000000000000000000000000000";

/** mulberry32: a tiny deterministic PRNG, so a seed reproduces the whole run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;
type Wallet = Setup["alice"];

/** Give the named accounts a deep balance and an effectively unlimited allowance. */
async function fundAll(w: Setup) {
  const APPROVAL = 1n << 255n;
  const accts = [w.sponsor, w.recipient, w.alice, w.bob, w.carol, w.dave, w.erin, w.stranger];
  for (const a of accts) {
    await w.usdc.write.mint([a.account.address, 1_000_000n * USD]);
    await w.usdc.write.approve([w.boomerang.address, APPROVAL], { account: a.account });
  }
}

/** Pledge landing in a block at exactly `at`. The backer must already be funded and approved. */
async function pledgeAt(w: Setup, id: bigint, who: Wallet, amount: bigint, at: bigint) {
  await w.time.setNextBlockTimestamp(at);
  await w.boomerang.write.pledge([id, amount], { account: who.account });
}

/** Read every log of the Boomerang contract, attach each one's block timestamp, and decode. */
async function readEvents(w: Setup): Promise<BoomerangEvent[]> {
  const logs = await w.publicClient.getLogs({ address: w.boomerang.address, fromBlock: 0n });
  const ts = new Map<bigint, bigint>();
  for (const lg of logs) {
    if (lg.blockNumber !== null && !ts.has(lg.blockNumber)) {
      const blk = await w.publicClient.getBlock({ blockNumber: lg.blockNumber });
      ts.set(lg.blockNumber, blk.timestamp);
    }
  }
  const raw: RawLog[] = logs.map((lg) => ({
    address: lg.address,
    topics: lg.topics,
    data: lg.data,
    blockNumber: lg.blockNumber,
    transactionHash: lg.transactionHash,
    logIndex: lg.logIndex,
    blockTimestamp: lg.blockNumber === null ? undefined : ts.get(lg.blockNumber),
  }));
  return decodeLogs(raw, w.boomerang.address);
}

describe(`boomerang kit (seed=${SEED})`, async function () {
  // -------------------------------------------------------------------- T1
  it("math mirror: 200 random states agree with the contract", async function () {
    type Cfg = {
      state: "open" | "funded" | "missed" | "void" | "voidOpen";
      linearWeight: boolean;
      rateBps: number;
      match: bigint;
      pool: bigint;
      fromRecipient?: boolean;
      skipMatch?: boolean;
      skipBonus?: boolean;
    };

    // flat and linear weight; rateBps across {0,1,250,500,10000}; pool and match both 0 and
    // non-zero; both bonus funders; all four outcomes, incl. a pot left out for a void.
    const configs: Cfg[] = [
      { state: "open", linearWeight: false, rateBps: 500, match: 20n * USD, pool: 10n * USD },
      { state: "open", linearWeight: true, rateBps: 250, match: 0n, pool: 10n * USD },
      { state: "open", linearWeight: true, rateBps: 10_000, match: 20n * USD, pool: 10n * USD, fromRecipient: true },
      { state: "open", linearWeight: false, rateBps: 1, match: 0n, pool: 0n },
      { state: "open", linearWeight: true, rateBps: 500, match: 20n * USD, pool: 0n },
      { state: "missed", linearWeight: false, rateBps: 500, match: 20n * USD, pool: 10n * USD },
      { state: "missed", linearWeight: true, rateBps: 250, match: 0n, pool: 10n * USD },
      { state: "missed", linearWeight: true, rateBps: 10_000, match: 20n * USD, pool: 10n * USD, fromRecipient: true },
      { state: "missed", linearWeight: false, rateBps: 0, match: 20n * USD, pool: 10n * USD },
      { state: "missed", linearWeight: true, rateBps: 1, match: 0n, pool: 10n * USD },
      { state: "funded", linearWeight: false, rateBps: 500, match: 20n * USD, pool: 10n * USD },
      { state: "funded", linearWeight: true, rateBps: 250, match: 0n, pool: 0n },
      { state: "void", linearWeight: false, rateBps: 500, match: 20n * USD, pool: 10n * USD, skipMatch: true },
      { state: "void", linearWeight: true, rateBps: 250, match: 20n * USD, pool: 10n * USD, skipBonus: true },
      // a void campaign left unfinalized and probed past its closing second: outcomeNow must
      // still answer Void (the pot is missing), never Missed -- the ordering the Void/Missed
      // checks must keep.
      { state: "voidOpen", linearWeight: false, rateBps: 500, match: 20n * USD, pool: 10n * USD, skipMatch: true },
    ];

    async function buildScenario(cfg: Cfg) {
      const w = await setup();
      const over = {
        linearWeight: cfg.linearWeight,
        rateBps: cfg.rateBps,
        matchAmount: cfg.match,
        bonusPool: cfg.pool,
        bonusFromRecipient: cfg.fromRecipient ?? false,
      };
      const opts = cfg.skipMatch ? { skipMatch: true } : cfg.skipBonus ? { skipBonus: true } : {};
      const { id, t } = await w.open(over, opts);
      const r = reader(w.publicClient, w.boomerang.address);
      // deep balances + max allowance so pledge timestamps are exact, not shifted by funding txs
      for (const who of [w.alice, w.bob, w.carol]) {
        await w.usdc.write.mint([who.account.address, 1_000_000n * USD]);
        await w.usdc.write.approve([w.boomerang.address, 1n << 255n], { account: who.account });
      }

      if (cfg.state === "open") {
        await pledgeAt(w, id, w.alice, 12n * USD, t.opensAt + 10n);
        await pledgeAt(w, id, w.bob, 8n * USD, t.opensAt + 50n);
        await w.time.increaseTo(t.opensAt + 60n); // leave now inside the early window (weight > 0)
      } else if (cfg.state === "missed") {
        await pledgeAt(w, id, w.alice, 12n * USD, t.opensAt + 10n);
        await pledgeAt(w, id, w.bob, 8n * USD, t.earlyUntil - 1n); // exactly earlyUntil - 1 (early)
        await pledgeAt(w, id, w.carol, 5n * USD, t.earlyUntil); // exactly earlyUntil (late, weight 0)
        await w.time.increaseTo(t.closesAt);
        await w.boomerang.write.finalize([id], { account: w.stranger.account });
      } else if (cfg.state === "funded") {
        await pledgeAt(w, id, w.alice, 100n * USD, t.opensAt + 20n); // closes the target -> Funded
      } else if (cfg.state === "void") {
        await w.time.increaseTo(t.opensAt); // a pot is missing -> Void from the opening second
        await w.boomerang.write.finalize([id], { account: w.stranger.account });
      } else {
        // voidOpen: a pot missing, never finalized, time moved past the closing second. The
        // outcome stays Open in storage; outcomeNow must read it as Void, not Missed.
        await w.time.increaseTo(t.closesAt + 100n);
      }

      const now = BigInt(await w.time.latest());
      const terms = await r.termsOf(id);
      const state = await r.stateOf(id);
      const cands: Address[] = [
        w.alice.account.address,
        w.bob.account.address,
        w.carol.account.address,
        w.stranger.account.address, // a never-pledged address: both position and owed read zero
      ];
      const backers = new Map<Address, Backer>();
      for (const a of cands) backers.set(a, await r.backerOf(id, a));
      const { opensAt: op, earlyUntil: eu, closesAt: cl } = terms;
      const weightTimes = [op - 5n, op, op + 1n, (op + eu) / 2n, eu - 1n, eu, eu + 5n, cl, cl + 100n];
      const amounts = [0n, USD / 2n, 3n * USD, 40n * USD, 100n * USD, 150n * USD];
      return { w, id, r, terms, state, cands, backers, weightTimes, amounts, now };
    }

    const scns: Awaited<ReturnType<typeof buildScenario>>[] = [];
    for (const cfg of configs) scns.push(await buildScenario(cfg));

    // Two probes the brief fixes in place, so the random draw cannot miss them:
    // (a) an open campaign, an amount below minPledge and below the gap -> (false, 0, 0).
    const openScn = scns[configs.findIndex((c) => c.state === "open")];
    {
      const belowMin = USD / 2n; // below minPledge (1 USD) and below the remaining gap
      const got = await openScn.r.quoteIfMissed(openScn.id, belowMin);
      assert.deepStrictEqual(kitQuote(openScn.terms, openScn.state, belowMin, openScn.now), got, "quote below minPledge");
      assert.deepStrictEqual(got, { wouldFund: false, counted: 0n, bonus: 0n }, "contract quote below minPledge");
    }
    // (b) an unfinalized void campaign probed past its closing second -> Void, not Missed.
    const voidOpenScn = scns[configs.findIndex((c) => c.state === "voidOpen")];
    {
      assert.equal(
        kitOutcomeAt(voidOpenScn.terms, voidOpenScn.state, voidOpenScn.now),
        await voidOpenScn.r.outcomeNow(voidOpenScn.id),
        "unfinalized void outcomeNow",
      );
      assert.equal(await voidOpenScn.r.outcomeNow(voidOpenScn.id), Outcome.Void, "unfinalized past-close is Void, not Missed");
    }

    const counts = { weightAt: 0, outcomeAt: 0, quoteIfMissed: 0, owedTo: 0, positionIfMissed: 0 };
    const rand = mulberry32(SEED ^ 0x01);
    const randInt = (n: number) => Math.floor(rand() * n);
    const PROBES = 200;

    for (let p = 0; p < PROBES; p++) {
      const scn = scns[randInt(scns.length)];
      const { terms, state } = scn;

      // weightAt at an arbitrary probe time (the contract view takes the time as an argument)
      const wt = scn.weightTimes[randInt(scn.weightTimes.length)];
      assert.equal(kitWeightAt(terms, wt), await scn.r.weightAt(scn.id, wt), `weightAt id=${scn.id} t=${wt}`);
      counts.weightAt++;

      // outcomeAt at the chain's current second vs the contract's own outcomeNow
      assert.equal(kitOutcomeAt(terms, state, scn.now), await scn.r.outcomeNow(scn.id), `outcomeNow id=${scn.id}`);
      counts.outcomeAt++;

      // quoteIfMissed: the view never reverts for a valid id, so the comparison is unconditional
      const amount = scn.amounts[randInt(scn.amounts.length)];
      const got = await scn.r.quoteIfMissed(scn.id, amount);
      assert.deepStrictEqual(kitQuote(terms, state, amount, scn.now), got, `quote id=${scn.id} amt=${amount}`);
      counts.quoteIfMissed++;

      // owedTo and positionIfMissed for a random candidate (a real backer or the never-pledged one)
      const addr = scn.cands[randInt(scn.cands.length)];
      const b = scn.backers.get(addr) as Backer;
      assert.deepStrictEqual(kitOwedTo(terms, state, b), await scn.r.owedTo(scn.id, addr), `owedTo id=${scn.id} a=${addr}`);
      counts.owedTo++;
      assert.deepStrictEqual(
        kitPosition(terms, state, b),
        await scn.r.positionIfMissed(scn.id, addr),
        `position id=${scn.id} a=${addr}`,
      );
      counts.positionIfMissed++;
    }

    // every probe compares all five views, so each count must equal the number of probes
    for (const [k, v] of Object.entries(counts)) assert.equal(v, PROBES, `${k} compared ${v} of ${PROBES} probes`);
    console.log(`[kit:T1] ${scns.length} scenarios, ${PROBES} probes, comparisons=${JSON.stringify(counts)}`);
  });

  // -------------------------------------------------------------------- T2
  it("ledger: rebuilt from events alone, it equals the contract", async function () {
    const rand = mulberry32(SEED ^ 0x02);
    const randInt = (n: number) => Math.floor(rand() * n);
    const randUsd = (max: number) => BigInt(1 + randInt(max)) * USD;

    const w = await setup();
    await fundAll(w);
    const r = reader(w.publicClient, w.boomerang.address);
    const addrOf = (a: Wallet) => a.account.address;

    const base = BigInt(await w.time.latest());
    const opensAt = base + 100n;
    const earlyUntil = base + 5_100n;
    const closesAt = base + 10_100n;
    const earlyUntil2 = opensAt + 2_000_000n; // > 1e6 seconds: a linear window whose last second weighs 0
    const closesAt2 = earlyUntil2 + 1_000n;
    const MAX = 10n ** 15n; // the contract's MAX_AMOUNT: a target the walk, and even a rescue, can never fill
    const FRESH = "0x000000000000000000000000000000000000f00d" as Address; // a redirect target, otherwise untouched
    const mk = (over: Record<string, unknown>) => ({
      recipient: w.recipient.account.address,
      opensAt,
      earlyUntil,
      closesAt,
      target: 100n * USD,
      minPledge: 1n * USD,
      matchAmount: 0n,
      bonusPool: 0n,
      rateBps: 500,
      linearWeight: false,
      bonusFromRecipient: false,
      ...over,
    });

    // ids 1-3 are the random walk's campaigns; 4-6 are driven deterministically, so every
    // required outcome and event is guaranteed whatever the walk does.
    //   1 walk, flat, target MAX -> can never fund -> Missed
    //   2 walk, linear, early window > 1e6 s, target MAX -> Missed (hosts the zero-weight tail pledge)
    //   3 walk, its match pot left out -> Void
    //   4 cF: rescued -> Funded
    //   5 cM: five early backers, never filled -> Missed (the block/redirect/PayFailed happen here)
    //   6 cC: one pledge completes the target -> Funded (a Pledged then Finalized in one tx)
    await w.boomerang.write.createCampaign([mk({ matchAmount: 20n * USD, bonusPool: 10n * USD, target: MAX })], { account: w.sponsor.account });
    await w.boomerang.write.createCampaign([mk({ linearWeight: true, bonusPool: 8n * USD, rateBps: 800, bonusFromRecipient: true, target: MAX, earlyUntil: earlyUntil2, closesAt: closesAt2 })], { account: w.sponsor.account });
    await w.boomerang.write.createCampaign([mk({ matchAmount: 12n * USD, target: 100n * USD })], { account: w.sponsor.account });
    await w.boomerang.write.createCampaign([mk({ matchAmount: 15n * USD, bonusPool: 5n * USD, target: 100n * USD })], { account: w.sponsor.account });
    await w.boomerang.write.createCampaign([mk({ matchAmount: 10n * USD, bonusPool: 12n * USD, rateBps: 900, target: 100n * USD })], { account: w.sponsor.account });
    await w.boomerang.write.createCampaign([mk({ matchAmount: 0n, bonusPool: 0n, target: 10n * USD })], { account: w.sponsor.account });

    // pots in before the campaigns open (PotFunded events); campaign 3 keeps its match pot out, so it is void
    await w.boomerang.write.fundMatch([1n], { account: w.sponsor.account });
    await w.boomerang.write.fundBonus([1n], { account: w.sponsor.account });
    await w.boomerang.write.fundBonus([2n], { account: w.recipient.account });
    await w.boomerang.write.fundMatch([4n], { account: w.sponsor.account });
    await w.boomerang.write.fundBonus([4n], { account: w.sponsor.account });
    await w.boomerang.write.fundMatch([5n], { account: w.sponsor.account });
    await w.boomerang.write.fundBonus([5n], { account: w.sponsor.account });

    await w.time.increaseTo(opensAt);

    // scripted pre-walk actions, guaranteeing the required events whatever the walk does
    const cmBackers = [w.alice, w.bob, w.carol, w.dave, w.erin];
    for (const who of cmBackers) await w.boomerang.write.pledge([5n, 5n * USD], { account: who.account }); // cM early backers
    await w.boomerang.write.pledge([6n, 10n * USD], { account: w.alice.account }); // cC: completes the target -> Pledged + Finalized in one tx
    await w.boomerang.write.rescue([4n], { account: w.sponsor.account }); // cF -> Funded

    const walkIds = [1n, 2n, 3n];
    const movers = [w.alice, w.bob, w.carol, w.dave, w.erin];
    // the walk pledges, finalizes, returns pots and redirects, but never pays a backer: every
    // backer payout is left to the settlement below, so the balance snapshot there is clean.
    const KINDS = ["pledge", "pledgeFor", "finalize", "paySide", "redirect", "fundPots", "advanceTime"] as const;
    const SEQS = 20;
    const ACTS = 40;
    let attempted = 0;
    let succeeded = 0;
    let rescues = 0;

    for (let s = 0; s < SEQS; s++) {
      for (let act = 0; act < ACTS; act++) {
        const kind = rand() < 0.01 ? "rescue" : KINDS[randInt(KINDS.length)]; // rescue only ~1% of the time
        const id = walkIds[randInt(walkIds.length)];
        const who = movers[randInt(movers.length)];
        attempted++;
        try {
          switch (kind) {
            case "pledge":
              await w.boomerang.write.pledge([id, randUsd(40)], { account: who.account });
              break;
            case "pledgeFor": {
              const payer = movers[randInt(movers.length)];
              await w.boomerang.write.pledgeFor([id, addrOf(who), randUsd(40)], { account: payer.account });
              break;
            }
            case "rescue":
              rescues++;
              await w.boomerang.write.rescue([id], { account: w.sponsor.account }); // target MAX or void -> reverts, harmless
              break;
            case "finalize":
              await w.boomerang.write.finalize([id], { account: who.account });
              break;
            case "paySide":
              await w.boomerang.write.paySide([id, randInt(3)], { account: who.account });
              break;
            case "redirect":
              await w.boomerang.write.redirect([id, addrOf(movers[randInt(5)])], { account: who.account });
              break;
            case "fundPots":
              await w.boomerang.write.fundMatch([id], { account: w.sponsor.account }); // reverts once open: fine
              break;
            case "advanceTime":
              await w.time.increase(BigInt(1 + randInt(300)));
              break;
          }
          succeeded++;
        } catch {
          /* a reverted action is expected and harmless; the ledger sees only what was emitted */
        }
      }
    }

    // post-walk scripted: campaign 2's zero-weight early pledge, in the last second of its long
    // linear window (weight rounds to 0, but the block time is still before earlyUntil)
    const afterWalk = BigInt(await w.time.latest());
    if (afterWalk < earlyUntil2 - 1n) {
      await w.time.setNextBlockTimestamp(earlyUntil2 - 1n);
      await w.boomerang.write.pledge([2n, 7n * USD], { account: w.dave.account });
    }

    // --- settle: finalize everything, then pay through payMany (batches) and paySide only ---
    await w.time.increaseTo(closesAt2 + 10n);
    for (const id of [1n, 2n, 3n, 5n]) {
      try {
        await w.boomerang.write.finalize([id], { account: w.sponsor.account });
      } catch {
        /* already final from the walk */
      }
    }

    // snapshot every payee's balance before any backer is paid, to check what each receives
    const payeeAddrs = [...movers.map(addrOf), FRESH];
    const baseline = new Map<string, bigint>();
    for (const p of payeeAddrs) baseline.set(p.toLowerCase(), await w.usdc.read.balanceOf([p]));

    // cM: block two backers -> payMany emits PayFailed for them and Paid for the other three.
    // Unblock one, redirect it to a fresh address and pay it (Paid, to the new address). The
    // other stays blocked, so one PayFailed is permanent and that backer is never paid.
    await w.usdc.write.setBlocked([addrOf(w.alice), true]);
    await w.usdc.write.setBlocked([addrOf(w.bob), true]);
    await w.boomerang.write.payMany([5n, cmBackers.map(addrOf)], { account: w.sponsor.account });
    await w.usdc.write.setBlocked([addrOf(w.alice), false]);
    await w.boomerang.write.redirect([5n, FRESH], { account: w.alice.account }); // alice -> a fresh address
    await w.boomerang.write.payMany([5n, [addrOf(w.alice)]], { account: w.sponsor.account }); // Paid, to FRESH

    // pay the rest through batches, and return every side of every campaign
    const everyMover = movers.map(addrOf);
    for (const id of [1n, 2n, 3n, 4n, 5n, 6n]) {
      await w.boomerang.write.payMany([id, everyMover], { account: w.sponsor.account });
      for (const side of [0, 1, 2]) {
        try {
          await w.boomerang.write.paySide([id, side], { account: w.sponsor.account });
        } catch {
          /* nothing on this side */
        }
      }
    }

    // --- rebuild the ledger from the logs alone and compare to the contract ---
    const events = await readEvents(w);
    const ledger = emptyLedger();
    applyEvents(ledger, events);

    assert.equal(ledger.lastSeq, await r.eventCount());
    assert.strictEqual(missing(ledger), null);
    // after everything is paid, rounding dust may leave totalOwed above zero: compare, never assume 0
    assert.equal(ledger.totalOwed, await r.totalOwed());

    const count = await r.campaignCount();
    const byOutcome: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
    let paidSeen = 0;
    let payFailedSeen = 0;
    let sideSeen = 0;
    let redirSeen = 0;
    let zeroWeightEarly = 0;
    for (const ev of events) {
      if (ev.name === "Paid") paidSeen++;
      else if (ev.name === "PayFailed") payFailedSeen++;
      else if (ev.name === "SidePaid") sideSeen++;
      else if (ev.name === "Redirected") redirSeen++;
      else if (ev.name === "Pledged" && ev.weight === 0n && ev.time !== undefined) {
        const c = ledger.campaigns.get(ev.id);
        if (c && ev.time < c.terms.earlyUntil) zeroWeightEarly++;
      }
    }
    // a transaction that emitted Pledged then Finalized (a pledge that completed the target)
    const finalizeTx = new Set(events.filter((e) => e.name === "Finalized" && e.txHash).map((e) => e.txHash));
    const completing = events.filter((e) => e.name === "Pledged" && e.txHash !== undefined && finalizeTx.has(e.txHash)).length;

    // every Paid event, keyed by campaign+backer, for the paid-backer cross-checks
    const paidEvent = new Map<string, { principal: bigint; bonus: bigint }>();
    for (const ev of events) if (ev.name === "Paid") paidEvent.set(`${ev.id}:${ev.backer.toLowerCase()}`, { principal: ev.principal, bonus: ev.bonus });
    const received = new Map<string, bigint>(); // lowercase payee -> total the Paid events sent it

    for (let i = 1n; i <= count; i++) {
      const lc = ledger.campaigns.get(i);
      assert.ok(lc, `ledger is missing campaign ${i}`);
      const st: State = await r.stateOf(i);
      assert.equal(lc.sponsor.toLowerCase(), st.sponsor.toLowerCase(), `sponsor ${i}`);
      assert.equal(lc.outcome, st.outcome, `outcome ${i}`);
      assert.equal(lc.matchIn, st.matchIn, `matchIn ${i}`);
      assert.equal(lc.bonusIn, st.bonusIn, `bonusIn ${i}`);
      assert.equal(lc.recipientPaid, st.recipientPaid, `recipientPaid ${i}`);
      assert.equal(lc.matchReturned, st.matchReturned, `matchReturned ${i}`);
      assert.equal(lc.bonusReturned, st.bonusReturned, `bonusReturned ${i}`);
      assert.equal(lc.backers.size, st.backers, `backers ${i}`);
      assert.equal(lc.pledged, st.pledged, `pledged ${i}`);
      assert.equal(lc.pledgedEarly, st.pledgedEarly, `pledgedEarly ${i}`);
      assert.equal(lc.weighted, st.weighted, `weighted ${i}`);
      assert.equal(lc.bonusPaid, st.bonusPaid, `bonusPaid ${i}`);
      byOutcome[st.outcome]++;

      // the ledger's terms equal the contract's, field by field
      const tm: Terms = await r.termsOf(i);
      for (const k of ["recipient", "opensAt", "earlyUntil", "closesAt", "target", "minPledge", "matchAmount", "bonusPool", "rateBps", "linearWeight", "bonusFromRecipient"] as const) {
        assert.equal((lc.terms as unknown as Record<string, unknown>)[k], (tm as unknown as Record<string, unknown>)[k], `terms.${k} ${i}`);
      }

      if (st.outcome !== Outcome.Open) {
        // every non-open campaign emitted a Finalized, so the ledger has its expected bonus
        assert.notEqual(lc.expectedBonusPaid, null, `expectedBonusPaid set ${i}`);
        assert.equal(lc.expectedBonusPaid, st.bonusPaid, `expectedBonusPaid ${i}`);
      }
      for (const [addrKey, lb] of lc.backers) {
        const cb: Backer = await r.backerOf(i, addrKey as Address);
        assert.equal(lb.principal, cb.principal, `principal ${i} ${addrKey}`);
        assert.equal(lb.weighted, cb.weighted, `weighted ${i} ${addrKey}`);
        assert.equal(lb.paid, cb.paid, `paid ${i} ${addrKey}`);
        const cbIsZero = cb.payTo.toLowerCase() === ZERO;
        assert.equal(lb.payTo === null, cbIsZero, `payTo null<->zero ${i} ${addrKey}`);
        if (lb.payTo !== null) assert.equal(lb.payTo.toLowerCase(), cb.payTo.toLowerCase(), `payTo ${i} ${addrKey}`);
        if (lb.paid) {
          // a paid backer's recorded amounts equal its Paid event's amounts
          const pe = paidEvent.get(`${i}:${addrKey}`);
          assert.ok(pe, `a paid backer must have a Paid event: ${i} ${addrKey}`);
          assert.equal(lb.paidPrincipal, pe!.principal, `paidPrincipal ${i} ${addrKey}`);
          assert.equal(lb.paidBonus, pe!.bonus, `paidBonus ${i} ${addrKey}`);
          const payee = (lb.payTo ?? (addrKey as Address)).toLowerCase();
          received.set(payee, (received.get(payee) ?? 0n) + lb.paidPrincipal + lb.paidBonus);
        }
      }
    }

    // and each payee's token balance rose by exactly the sum the Paid events sent it
    for (const [payee, amount] of received) {
      const b0 = baseline.get(payee);
      assert.notEqual(b0, undefined, `payee ${payee} was not in the baseline snapshot`);
      const now = await w.usdc.read.balanceOf([payee as Address]);
      assert.equal(now - (b0 as bigint), amount, `payee ${payee} received`);
    }

    assert.ok(byOutcome[Outcome.Funded] >= 1, `Funded count ${byOutcome[Outcome.Funded]}`);
    assert.ok(byOutcome[Outcome.Missed] >= 2, `Missed count ${byOutcome[Outcome.Missed]}`);
    assert.ok(byOutcome[Outcome.Void] >= 1, `Void count ${byOutcome[Outcome.Void]}`);
    assert.ok(paidSeen >= 4, `Paid ${paidSeen}`);
    assert.ok(payFailedSeen >= 1, `PayFailed ${payFailedSeen}`);
    assert.ok(sideSeen >= 4, `SidePaid ${sideSeen}`);
    assert.ok(redirSeen >= 1, `Redirected ${redirSeen}`);
    assert.ok(zeroWeightEarly >= 1, `a zero-weight early pledge (weight 0, time < earlyUntil) ${zeroWeightEarly}`);
    assert.ok(completing >= 1, `a completing pledge (Pledged then Finalized in one tx) ${completing}`);
    const dust = ledger.totalOwed;
    console.log(
      `[kit:T2] seqs=${SEQS} actions attempted=${attempted} succeeded=${succeeded} rescues=${rescues} events=${events.length} ` +
        `byOutcome(Open/Funded/Missed/Void)=${byOutcome[0]}/${byOutcome[1]}/${byOutcome[2]}/${byOutcome[3]} ` +
        `Paid=${paidSeen} PayFailed=${payFailedSeen} SidePaid=${sideSeen} Redirected=${redirSeen} ` +
        `zeroWeightEarly=${zeroWeightEarly} completing=${completing} stillOwed(one blocked backer + rounding dust)=${dust}`,
    );
  });

  // -------------------------------------------------------------------- T3
  it("ledger.repeat: repeats and disorder change nothing; a missing event stops the ledger exactly there", async function () {
    const events = await buildCleanEvents(SEED ^ 0x03);
    const N = events.length;
    assert.ok(N >= 10, `need a non-trivial stream, got ${N}`);

    const inOrder = emptyLedger();
    applyEvents(inOrder, events);
    assert.equal(inOrder.lastSeq, BigInt(N)); // the stream is a gapless 1..N
    assert.strictEqual(missing(inOrder), null);

    // (a) shuffled, with every third event duplicated: same result, repeats = the duplicate count
    const rand = mulberry32(SEED ^ 0x33);
    const shuffled = events.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const withDups: BoomerangEvent[] = [];
    let dupCount = 0;
    for (let i = 0; i < shuffled.length; i++) {
      withDups.push(shuffled[i]);
      if (i % 3 === 0) {
        withDups.push(shuffled[i]);
        dupCount++;
      }
    }
    const shLedger = emptyLedger();
    applyEvents(shLedger, withDups);
    assert.equal(shLedger.repeats, dupCount);
    assert.deepStrictEqual({ ...shLedger, repeats: 0 }, { ...inOrder, repeats: 0 });

    // (b) withhold the middle event: missing() names exactly that gap and the ledger stops before it
    const mid = events[Math.floor(N / 2)];
    const M = mid.seq;
    const withheld = emptyLedger();
    applyEvents(withheld, events.filter((e) => e.seq !== M));
    assert.deepStrictEqual(missing(withheld), { from: M, to: M });
    assert.equal(withheld.lastSeq, M - 1n);
    const before = emptyLedger();
    applyEvents(before, events.filter((e) => e.seq < M));
    assert.deepStrictEqual(withheld.campaigns, before.campaigns);

    // (c) supply the withheld event: the ledger catches up and equals the in-order one
    applyEvents(withheld, [mid]);
    assert.deepStrictEqual(withheld, inOrder);
    console.log(`[kit:T3] stream length=${N}, duplicates=${dupCount}, gap at seq=${M}`);
  });

  // -------------------------------------------------------------------- T4
  it("events: other contracts' logs are skipped and hex block fields are read", async function () {
    const w = await setup();
    await fundAll(w);
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt + 100n);
    // a partial pledge: the receipt holds the token's Transfer log and Boomerang's Pledged log
    const hash = await w.boomerang.write.pledge([id, 10n * USD], { account: w.alice.account });
    const receipt = await w.publicClient.getTransactionReceipt({ hash });
    const receiptLogs = receipt.logs as unknown as RawLog[];

    const decoded = decodeLogs(receiptLogs);
    assert.equal(decoded.length, 1, "only the Boomerang event should survive");
    assert.equal(decoded[0].name, "Pledged");

    // an unrelated address filters everything out
    const other = "0x00000000000000000000000000000000deadbeef" as Address;
    assert.equal(decodeLogs(receiptLogs, other).length, 0);

    // hex block fields decode to bigint
    const pledgedLog = receiptLogs.find((l) => l.address.toLowerCase() === w.boomerang.address.toLowerCase()) as RawLog;
    const synthetic: RawLog = { ...pledgedLog, blockNumber: "0x10", blockTimestamp: "0x6541a000" };
    const [ev] = decodeLogs([synthetic]);
    assert.equal(ev.blockNumber, 16n);
    assert.equal(ev.time, 1_698_799_616n);
    console.log("[kit:T4] skipped foreign logs and read hex block fields as bigint");
  });

  it("ledger.early: a zero-weight early pledge is counted with the block's time and never guessed without it", async function () {
    const w = await setup();
    await fundAll(w);
    const base = BigInt(await w.time.latest());
    const opensAt = base + 100n;
    const earlyUntil = opensAt + 2_000_000n; // longer than 1e6 seconds: the last second's weight rounds to 0
    const { id, t } = await w.open({ opensAt, earlyUntil, closesAt: earlyUntil + 1_000n, linearWeight: true });
    await pledgeAt(w, id, w.alice, 10n * USD, opensAt + 1_000_000n); // weight 500000
    await pledgeAt(w, id, w.bob, 7n * USD, earlyUntil - 1n); // early by the clock, weight 0
    await pledgeAt(w, id, w.carol, 5n * USD, earlyUntil); // late
    await w.time.increaseTo(t.closesAt);
    await w.boomerang.write.finalize([id], { account: w.stranger.account });

    const st = (await reader(w.publicClient, w.boomerang.address).stateOf(id)) as State;
    assert.equal(st.pledgedEarly, 17n * USD, "the contract counts the zero-weight pledge as early");
    const events = await readEvents(w);
    const zero = events.find((e) => e.name === "Pledged" && e.amount === 7n * USD);
    assert.ok(zero && zero.name === "Pledged" && zero.weight === 0n, "the pledge must carry weight 0");

    const timed = emptyLedger();
    applyEvents(timed, events);
    const a = timed.campaigns.get(id)!;
    assert.equal(a.pledgedEarly, st.pledgedEarly);
    assert.equal(a.earlyUnknown, 0n);
    assert.equal(a.expectedBonusPaid, st.bonusPaid);
    assert.ok(st.bonusPaid > 0n, "the case must pay a bonus, or the cross-check proves nothing");

    const untimed = emptyLedger();
    applyEvents(untimed, events.map(({ time: _time, ...rest }) => rest as BoomerangEvent));
    const b = untimed.campaigns.get(id)!;
    assert.equal(b.earlyUnknown, 12n * USD, "both zero-weight pledges are unknown without a time");
    assert.equal(b.pledgedEarly, 10n * USD);
    assert.equal(b.expectedBonusPaid, null, "no cross-check is claimed on an unknown");
    assert.equal(b.bonusPaid, st.bonusPaid, "the event's own figure is still recorded");
  });

  // ---------------------------------------------------------------- math.sides
  it("math.sides: sideAmount equals what paySide moves", async function () {
    const w = await setup();
    await fundAll(w);
    const r = reader(w.publicClient, w.boomerang.address);

    const base = BigInt(await w.time.latest());
    const T = { opensAt: base + 1_000n, earlyUntil: base + 5_000n, closesAt: base + 9_000n };
    // a funded campaign, a missed one and a void one (its match pot left out), each with both pots' worth
    const { id: fId } = await w.open({ ...T, target: 30n * USD, matchAmount: 10n * USD, bonusPool: 10n * USD });
    const { id: mId } = await w.open({ ...T, target: 100n * USD, matchAmount: 10n * USD, bonusPool: 10n * USD, rateBps: 500 });
    const { id: vId } = await w.open({ ...T, target: 100n * USD, matchAmount: 10n * USD, bonusPool: 10n * USD }, { skipMatch: true });

    await w.time.increaseTo(T.opensAt);
    await w.pledge(fId, w.alice, 30n * USD); // completes fId -> Funded
    await w.pledge(mId, w.alice, 10n * USD); // early
    await w.pledge(mId, w.bob, 10n * USD); // early
    await w.time.increaseTo(T.closesAt);
    await w.boomerang.write.finalize([mId], { account: w.stranger.account }); // -> Missed
    await w.boomerang.write.finalize([vId], { account: w.stranger.account }); // -> Void

    const ms = (await r.stateOf(mId)) as State;
    assert.ok(ms.bonusPaid > 0n, "the missed campaign must pay a bonus, or the BonusReturn check proves nothing");

    /** The amount the SidePaid of a single paySide call carried, or null if it emitted none. */
    async function sidePaidAmount(hash: `0x${string}`): Promise<bigint | null> {
      const receipt = await w.publicClient.getTransactionReceipt({ hash });
      const sp = decodeLogs(receipt.logs as unknown as RawLog[], w.boomerang.address).filter((e) => e.name === "SidePaid");
      return sp.length ? (sp[0] as Extract<BoomerangEvent, { name: "SidePaid" }>).amount : null;
    }

    let compared = 0;
    for (const [id, label] of [[fId, "funded"], [mId, "missed"], [vId, "void"]] as const) {
      for (const side of [Side.Recipient, Side.MatchReturn, Side.BonusReturn]) {
        const terms = await r.termsOf(id);
        const state = await r.stateOf(id);
        const predicted = kitSideAmount(terms, state, side); // read before the call changes anything
        const hash = await w.boomerang.write.paySide([id, side], { account: w.stranger.account });
        const moved = await sidePaidAmount(hash);
        if (predicted > 0n) assert.equal(moved, predicted, `${label} side ${side}: amount`);
        else assert.equal(moved, null, `${label} side ${side}: pays nothing and emits no event`);
        compared++;
      }
    }
    assert.equal(compared, 9);
    console.log(`[kit:math.sides] compared ${compared} (campaign, side) pairs against SidePaid, missed bonusPaid=${ms.bonusPaid}`);
  });

  // --------------------------------------------------------------- events.order
  it("events.order: decodeLogs returns ascending seq whatever order the logs come in", async function () {
    const w = await setup();
    await fundAll(w);
    const { id, t } = await w.open({});
    await w.time.increaseTo(t.opensAt + 10n);
    await w.boomerang.write.pledge([id, 20n * USD], { account: w.alice.account }); // early
    await w.boomerang.write.pledge([id, 15n * USD], { account: w.bob.account }); // early
    await w.boomerang.write.redirect([id, w.erin.account.address], { account: w.alice.account });
    await w.time.increaseTo(t.closesAt);
    await w.boomerang.write.finalize([id], { account: w.sponsor.account }); // -> Missed
    await w.boomerang.write.payMany([id, [w.alice.account.address, w.bob.account.address]], { account: w.sponsor.account });
    for (const side of [1, 2]) {
      try {
        await w.boomerang.write.paySide([id, side], { account: w.sponsor.account }); // match + bonus return
      } catch {
        /* nothing on this side */
      }
    }

    const logs = await w.publicClient.getLogs({ address: w.boomerang.address, fromBlock: 0n });
    const raws: RawLog[] = logs.map((lg) => ({
      address: lg.address,
      topics: lg.topics,
      data: lg.data,
      blockNumber: lg.blockNumber,
      transactionHash: lg.transactionHash,
      logIndex: lg.logIndex,
    }));
    const original = decodeLogs(raws, w.boomerang.address);
    assert.ok(original.length >= 10, `need a non-trivial stream, got ${original.length}`);

    const rand = mulberry32(SEED ^ 0x05);
    const shuffled = raws.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    // the shuffle must actually reorder the logs, or the test proves nothing
    assert.ok(shuffled.some((lg, i) => lg !== raws[i]), "the shuffle left the logs in place");

    const got = decodeLogs(shuffled, w.boomerang.address);
    for (let i = 1; i < got.length; i++) {
      assert.ok(got[i - 1].seq < got[i].seq, `seq must be strictly ascending at ${i}: ${got[i - 1].seq} then ${got[i].seq}`);
    }
    assert.deepStrictEqual(got, original, "the decoded multiset is unchanged by shuffling");
    console.log(`[kit:events.order] shuffled ${raws.length} logs, decoded ${got.length} events in strictly ascending seq`);
  });
});

/** A short deterministic walk that yields a clean, gapless event stream with varied events. */
async function buildCleanEvents(seed: number): Promise<BoomerangEvent[]> {
  void seed; // the walk below is deterministic; the seed only keeps callers distinct
  const w = await setup();
  await fundAll(w);
  const addrOf = (a: Wallet) => a.account.address;
  const base = BigInt(await w.time.latest());
  const opensAt = base + 100n;
  const earlyUntil = base + 3_100n;
  const closesAt = base + 6_100n;
  const mk = (over: Record<string, unknown>) => ({
    recipient: w.recipient.account.address,
    opensAt,
    earlyUntil,
    closesAt,
    target: 100n * USD,
    minPledge: 1n * USD,
    matchAmount: 0n,
    bonusPool: 0n,
    rateBps: 500,
    linearWeight: false,
    bonusFromRecipient: false,
    ...over,
  });

  await w.boomerang.write.createCampaign([mk({ matchAmount: 20n * USD, bonusPool: 10n * USD })], { account: w.sponsor.account });
  await w.boomerang.write.createCampaign([mk({ linearWeight: true, bonusPool: 8n * USD, rateBps: 800, bonusFromRecipient: true })], { account: w.sponsor.account });
  await w.boomerang.write.fundMatch([1n], { account: w.sponsor.account });
  await w.boomerang.write.fundBonus([1n], { account: w.sponsor.account });
  await w.boomerang.write.fundBonus([2n], { account: w.recipient.account });

  await w.time.increaseTo(opensAt + 10n);
  await w.boomerang.write.pledge([1n, 20n * USD], { account: w.alice.account }); // early
  await w.boomerang.write.pledge([1n, 15n * USD], { account: w.bob.account }); // early
  await w.boomerang.write.pledge([2n, 30n * USD], { account: w.carol.account }); // early
  await w.boomerang.write.redirect([1n, addrOf(w.erin)], { account: w.alice.account });

  await w.time.increaseTo(closesAt + 1n);
  await w.boomerang.write.finalize([1n], { account: w.sponsor.account }); // -> Missed
  await w.boomerang.write.finalize([2n], { account: w.sponsor.account }); // -> Missed
  await w.boomerang.write.pay([1n, addrOf(w.alice)], { account: w.sponsor.account }); // Paid (to erin)
  await w.boomerang.write.payMany([1n, [addrOf(w.bob)]], { account: w.sponsor.account }); // Paid
  for (const side of [1, 2]) {
    try {
      await w.boomerang.write.paySide([1n, side], { account: w.sponsor.account }); // match + bonus return
    } catch {
      /* nothing on this side */
    }
  }
  try {
    await w.boomerang.write.paySide([2n, 2], { account: w.sponsor.account }); // bonus return
  } catch {
    /* nothing on this side */
  }

  return readEvents(w);
}
