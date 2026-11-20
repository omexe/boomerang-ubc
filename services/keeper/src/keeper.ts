// The keeper itself: it takes deliveries (from its own reading of Arc's node: follow.ts), keeps the event-sourced ledger in step, and makes the settlement
// calls the ledger says are due. It holds no rights in the contract; every
// call it makes is open to anyone and harmless to repeat, so the whole thing is driven from the
// ledger alone. A delivery seen before adds nothing to the ledger and sends nothing new.
//
// Deliveries are believed: whoever can feed this ledger can feed it false events
// (docs/ARCHITECTURE.md says what that can and cannot do).
// What the keeper guards against is being stopped or emptied by a delivery that is wrong:
//   - an event that does not fit the ledger is set aside and reported, never fatal;
//   - the keeper's clock is the latest block time a delivery has carried, and is used only to
//     decide what is due. How long to wait before sending a call again is measured on `timer`,
//     a clock of this machine that only runs forward, so a false time in a delivery can make a
//     call early (the contract refuses it) but cannot stop the calls that follow;
//   - gas is spent only on a call the contract itself, asked first by the sender, says will
//     change something. What the contract says is finished (an outcome already set, a side
//     with nothing to pay, a backer owed nothing) is remembered and never asked again. A
//     false event costs questions to the contract and no gas: a few for most, at doubling
//     intervals for the ones below. The costliest is a false time, which leaves the keeper's
//     clock ahead for good: one question for each open campaign every 320 seconds until each
//     is really due;
//   - the outcome the contract shows, whenever the sender has asked, is set above the ledger's.
//     A false "settled" for an open campaign is dropped after the contract has said "open" for
//     `believeOpenAfter` (a node a block behind the chain's head says the same for a moment), and the
//     campaign is then settled when it is really due. In case the node was only behind for
//     longer, the ledger's outcome is tried again each time the time since the first "open" has
//     doubled. An outcome the contract has set is taken
//     at once, also when the ledger has heard a different one or none: the true Finalized event
//     may never arrive, because a false event can hold its number;
//   - whether a side (the recipient, the match, the bonus pool) still has money to pay is the
//     contract's to say, not the ledger's: each side of a settled campaign is put to the contract
//     until the contract calls it finished, whatever amounts and "paid" marks the ledger holds;
//   - a campaign the contract does not have is asked about at doubling intervals, up to once a day;
//   - before its closing second a campaign is put to the contract as void when the ledger shows
//     a pot missing; told "not due" four times, the keeper drops that guess until the closing second;
//   - as a second line, a call that goes through and is still planned is sent again at doubling
//     intervals and dropped after `maxTries`. A backer's payout that keeps failing is offered at
//     doubling intervals; a side the contract refuses to pay (the token will not pay its payee)
//     is asked again every `retryFailedAfter` and reported each time.
//   Which backers exist, and which of them are paid, the keeper knows only from the ledger.
import {
  applyEvents,
  decodeLogs,
  emptyLedger,
  missing,
  type Address,
  type BoomerangEvent,
  type Ledger,
  type RawLog,
} from "../../../packages/kit/src/index.ts";
import { type Action, nextActions, settled } from "./plan.ts";

const OPEN = 0; // Outcome.Open, as the contract and the ledger number it
const SIDES = [0, 1, 2]; // Side.Recipient, Side.MatchReturn, Side.BonusReturn
const VOID_ASKS = 4; // how many times "not due" is heard before a guess that a campaign is void is dropped
import type { Store } from "./store.ts";

// One delivery: the raw event logs of a run of blocks, and the time to tell the keeper. Every
// delivery comes from the keeper's own reading of the node (follow.ts).
export type Delivery = {
  fromBlock: number;
  toBlock: number;
  time: number;
  logs: RawLog[];
};

// What the sender learned when it asked the contract and was told the call would change nothing.
// Nothing was sent. `final`: this finalize or paySide will never be needed again. `hold`: the
// contract does not show the campaign as missed, so none of its backers can be paid for now.
// `owedNothing`: backers the contract owes nothing, for good. `blocked`: backers who are owed
// but whose payout would fail. `outcome`: the campaign's outcome as the contract showed it.
// `absent`: the contract has no campaign with this number (or the node asked does not have it yet).
export type Nothing = { final: boolean; hold: boolean; owedNothing: Address[]; blocked: Address[]; outcome?: number; absent?: boolean };

// `reverted` marks a call the contract itself refused (a blocked payee, say). It will be refused
// again, so the keeper waits a long time before offering it. `nothing` marks a call that was not
// sent because the contract says it would change nothing. Any other failure (the RPC, a nonce)
// is passing, and the call is offered again soon. `owedNothing` on a call that went through
// names the backers left out of it because the contract owes them nothing.
export type SendResult =
  | { ok: true; hash: `0x${string}`; owedNothing?: Address[] }
  | { ok: false; error: string; reverted?: boolean; nothing?: Nothing };

export type Sender = (action: Action) => Promise<SendResult>;

export type Health = {
  lastSeq: string;
  missing: { from: string; to: string } | null;
  pending: number;
  repeats: number;
  lastBlock: number;
  lastTime: string;
  sent: number;
  failedSends: number;
  rejected: number; // events that did not fit the ledger and were set aside
  gaveUp: string[]; // calls dropped after maxTries sends that went through and changed nothing
  absent: string[]; // up to twenty campaign numbers in the ledger that the contract says it does not have
  lastErrors: string[];
  settled: boolean;
};

export type Keeper = {
  readonly ledger: Ledger;
  /** Take one delivery. */
  deliver(d: Delivery): { applied: number; repeats: number; done: Promise<{ action: Action; result: SendResult }[]> };
  health(): Health;
  feed(limit?: number): BoomerangEvent[]; // the most recent applied events, newest last
};

function shortMessage(e: unknown): string {
  const a = e as { shortMessage?: unknown; message?: unknown } | undefined;
  const m = (a && (a.shortMessage ?? a.message)) ?? e;
  return String(m).slice(0, 200);
}

export function createKeeper(o: {
  boomerang: Address;
  store: Store;
  send: Sender;
  resendAfter?: bigint;
  retryFailedAfter?: bigint;
  // How many times a call that went through, and is still planned, is sent before it is dropped.
  maxTries?: number;
  // Seconds on a clock of this machine that only runs forward; waits between sends are measured
  // on it. Left out, the keeper's own clock (the latest delivery time) is used, which is what
  // tests that move the chain's time want. main.ts passes the process's monotonic clock.
  timer?: () => bigint;
  // How long the contract must have been saying "open" before a ledger that says "settled" is overruled.
  believeOpenAfter?: bigint;
}): Keeper {
  const { boomerang, store, send } = o;
  const resendAfter = o.resendAfter ?? 20n;
  const retryFailedAfter = o.retryFailedAfter ?? 600n;
  const maxTries = o.maxTries ?? 8;
  const believeOpenAfter = o.believeOpenAfter ?? 60n;

  const ledger = emptyLedger();
  const seen = new Map<bigint, BoomerangEvent>(); // events the ledger is holding but has not applied yet, by seq
  const feedList: BoomerangEvent[] = []; // applied events in seq order, newest last
  // `${id}:${backer}` -> when a backer's payout last failed (on the waiting clock) and how many times it has
  const failed = new Map<string, { at: bigint; count: number }>();
  // action key -> the last send: when (on the waiting clock), how it went, how many sends have
  // gone through, and how many times in a row the contract said there was nothing to do
  type Sent = { id: bigint; at: bigint; how: "ok" | "refused" | "fault" | "nothing"; went: number; none: number };
  const sends = new Map<string, Sent>();
  const gaveUp = new Set<string>();
  // What the contract has said is finished for good: calls (`finalize:1`, `paySide:1:0`) and
  // backers it owes nothing (`<id>:<backer>`). Both grow only with the ledger itself.
  const over = new Set<string>();
  const owedNothing = new Set<string>();
  // campaign id -> when the contract last said the campaign is not missed (on the waiting clock)
  const holds = new Map<bigint, bigint>();
  // campaign id -> the outcome the contract itself showed the sender. A set outcome never changes
  // and is kept for good. "Open" is kept with when it was first said (on the waiting clock) since
  // the ledger last heard an outcome for the campaign, and whether the disagreement was reported.
  // `again`: when the ledger's outcome is next tried in place of a believed "open".
  const told = new Map<bigint, { outcome: number; since: bigint; reported: boolean; again: bigint }>();
  const heardOutcome = new Set<bigint>(); // campaigns whose outcome the ledger has heard at least once
  // campaign id -> when the contract last said it has no such campaign (on the waiting clock), and how many times running
  const absent = new Map<bigint, { at: bigint; count: number }>();

  let lastTime = 0n; // the keeper's clock: the latest delivery time it has accepted
  let lastBlock = 0;
  let sent = 0;
  let failedSends = 0;
  let rejected = 0;
  const lastErrors: string[] = [];
  let chain: Promise<unknown> = Promise.resolve();

  // The clock waits are measured on.
  const waitClock = (): bigint => (o.timer ? o.timer() : lastTime);
  const doubled = (base: bigint, times: number, cap: number): bigint => base * 2n ** BigInt(Math.min(Math.max(times - 1, 0), cap));

  function recordError(msg: string): void {
    lastErrors.push(msg);
    while (lastErrors.length > 20) lastErrors.shift();
  }

  let replayTime = 0n; // the newest block time and block number among applied events
  let replayBlock = 0;

  // The one way events enter the ledger, used for a live delivery and for the replay at start.
  // `fallbackTime` stands in for an event that came without its block's time.
  function take(events: readonly BoomerangEvent[], persist: boolean, fallbackTime: bigint): { applied: number; repeats: number } {
    // The events the ledger has not seen and is not already holding: these are the ones it will
    // keep. They go to the store before the ledger, so the delivery is not answered until they
    // are on disk.
    const fresh: BoomerangEvent[] = [];
    const freshSeen = new Set<bigint>();
    for (const e of events) {
      if (e.seq > ledger.lastSeq && !ledger.pending.has(e.seq) && !freshSeen.has(e.seq)) {
        freshSeen.add(e.seq);
        fresh.push(e);
      }
    }
    if (persist && fresh.length > 0) store.append(fresh);
    for (const e of fresh) seen.set(e.seq, e);

    const prevSeq = ledger.lastSeq;
    const prevRepeats = ledger.repeats;
    try {
      applyEvents(ledger, events);
    } catch (e) {
      // The event next in line names a campaign or a backer the ledger has never seen. The
      // ledger has dropped it and still waits at that number, so the real event can take its
      // place. Nothing stops: the fault is counted and shown.
      rejected += 1;
      recordError(`an event did not fit the ledger and was set aside: ${shortMessage(e)}`);
    }

    // Each event applied just now extends the feed and moves the failed-payout set.
    for (let q = prevSeq + 1n; q <= ledger.lastSeq; q += 1n) {
      const e = seen.get(q);
      seen.delete(q);
      if (!e) continue;
      feedList.push(e);
      if (e.time !== undefined && e.time > replayTime) replayTime = e.time;
      if (e.blockNumber !== undefined && Number(e.blockNumber) > replayBlock) replayBlock = Number(e.blockNumber);
      // An "open" heard before the ledger's first outcome for a campaign says nothing about that
      // outcome, so the minute starts again; once only, or repeating a false outcome would restart it for ever.
      if (e.name === "Finalized" && !heardOutcome.has(e.id)) {
        heardOutcome.add(e.id);
        if (told.get(e.id)?.outcome === OPEN) told.delete(e.id);
      }
      if (e.name === "PayFailed") {
        const key = `${e.id}:${e.backer.toLowerCase()}`;
        failed.set(key, { at: o.timer ? o.timer() : (e.time ?? fallbackTime), count: (failed.get(key)?.count ?? 0) + 1 });
      } else if (e.name === "Paid" || e.name === "Redirected") {
        failed.delete(`${e.id}:${e.backer.toLowerCase()}`);
      }
      // The campaign moved, so a call that went through for it is no longer "changing nothing":
      // its count starts again and it is no longer dropped. Its last send time stays, and so does
      // a refusal's wait.
      for (const [key, sentFor] of sends) {
        if (sentFor.id !== e.id) continue;
        if (sentFor.went > 1) sentFor.went = 1;
        gaveUp.delete(key);
      }
    }
    return { applied: Number(ledger.lastSeq - prevSeq), repeats: ledger.repeats - prevRepeats };
  }

  // Replay what the store already holds, one event at a time, through the same path. An event
  // that was set aside when it first arrived is set aside again, and the one that later took its
  // place applies again, so the ledger, the feed and the failed-payout set come back as they were.
  // The clock and the block shown by /health start from the newest event replayed, not from zero.
  for (const e of store.load()) take([e], false, e.time ?? 0n);
  lastTime = replayTime;
  lastBlock = replayBlock;

  function actionKey(a: Action): string {
    if (a.kind === "finalize") return `finalize:${a.id}`;
    if (a.kind === "paySide") return `paySide:${a.id}:${a.side}`;
    return `payMany:${a.id}:${a.backers.join(",")}`;
  }

  // What the contract showed for a campaign's outcome. True when it changes what should be planned now.
  function hear(id: bigint, outcome: number): boolean {
    const was = told.get(id);
    if (outcome === OPEN) {
      // "Open" changes the plan only once it has been said for believeOpenAfter. A set outcome is never unsaid.
      if (was === undefined) told.set(id, { outcome, since: waitClock(), reported: false, again: waitClock() + 2n * believeOpenAfter });
      return false;
    }
    if (was !== undefined && was.outcome === outcome) return false;
    const led = ledger.campaigns.get(id)?.outcome;
    const differs = led !== undefined && led !== OPEN && led !== outcome;
    if (differs) recordError(`campaign ${id}: the contract shows outcome ${outcome}, the ledger heard ${led}; the contract's is used`);
    told.set(id, { outcome, since: waitClock(), reported: differs, again: 0n });
    return true;
  }

  // The outcomes to plan from in place of the ledger's.
  function toldNow(): Map<bigint, number> {
    const outcomes = new Map<bigint, number>();
    for (const [id, said] of told) {
      if (said.outcome !== OPEN) outcomes.set(id, said.outcome);
      else {
        const led = ledger.campaigns.get(id)?.outcome;
        if (led === undefined || led === OPEN || waitClock() - said.since < believeOpenAfter) continue;
        if (!said.reported) {
          said.reported = true;
          recordError(`campaign ${id}: the ledger heard outcome ${led}, the contract says it is still open; the contract's is used`);
        }
        // The node may only have been behind. The ledger's outcome is tried again each time the
        // time since the first "open" has doubled: after two minutes, four, eight, and so on.
        if (waitClock() >= said.again) {
          said.again = said.since + 2n * (waitClock() - said.since);
          continue;
        }
        outcomes.set(id, OPEN);
      }
    }
    return outcomes;
  }

  // Plan from the ledger at the keeper's clock and send what is due.
  function runActions(): Promise<{ action: Action; result: SendResult }[]> {
    const work = async (): Promise<{ action: Action; result: SendResult }[]> => {
      const out: { action: Action; result: SendResult }[] = [];
      // When the contract shows an outcome the plan did not have, the plan is made again at once
      // (a delivery may not come again for some time). Once is enough: everything due is asked in
      // the first pass, and an outcome the contract has set does not change.
      for (let pass = 0; pass < 2; pass += 1) {
        let learned = false;
        try {
          // Left out of payMany: backers the contract owes nothing, and a backer whose payout
          // failed, for retryFailedAfter, then twice that, and so on up to 64 times it. A payee the
          // token will not pay is offered again a few times a day, not every ten minutes for ever.
          // A redirect or a payment clears that wait.
          const skip = new Set<string>(owedNothing);
          for (const [key, f] of failed) if (waitClock() - f.at < doubled(retryFailedAfter, f.count, 6)) skip.add(key);
          const outcomes = toldNow();
          const plan = nextActions(ledger, lastTime, skip, outcomes);
          // The ledger's amounts and "paid" marks come from deliveries and can be false. So each
          // side of a campaign whose outcome is set is also put to the contract, until the contract
          // calls that side finished. The questions cost no gas.
          const planned = new Set(plan.map(actionKey));
          for (const [id, c] of ledger.campaigns) {
            if ((outcomes.get(id) ?? c.outcome) === OPEN) continue;
            for (const side of SIDES) {
              const probe: Action = { kind: "paySide", id, side };
              if (!planned.has(actionKey(probe))) plan.push(probe);
            }
          }
          for (const action of plan) {
            const key = actionKey(action);
            if (over.has(key)) continue;
            // A campaign the contract said it does not have: asked again after resendAfter, then
            // twice that, and so on up to about a day. A node behind the chain's head has it a moment later.
            const gone = absent.get(action.id);
            if (gone !== undefined && waitClock() - gone.at < doubled(resendAfter, gone.count, 12)) continue;
            if (action.kind === "payMany") {
              const held = holds.get(action.id);
              if (held !== undefined && waitClock() - held < retryFailedAfter) continue;
            }
            const last = sends.get(key);
            if (action.kind === "finalize" && last !== undefined && last.none >= VOID_ASKS) {
              // Before the closing second a finalize is only a guess that a pot is missing. Told
              // "not due" four times, over more than two minutes (longer than a node stays behind
              // the chain's head), the guess is wrong: the pots are in. It is dropped until the closing second.
              const closes = ledger.campaigns.get(action.id)?.terms.closesAt;
              if (closes !== undefined && lastTime < closes) continue;
            }
            if (last !== undefined) {
              if (last.how === "ok" && last.went >= maxTries) {
                // It went through maxTries times and the ledger never moved. It is dropped until
                // the campaign moves or the keeper restarts, and /health says so.
                if (!gaveUp.has(key)) {
                  gaveUp.add(key);
                  recordError(`gave up on ${key.slice(0, 80)}: ${last.went} sends went through and changed nothing`);
                }
                continue;
              }
              // A call the contract refused waits retryFailedAfter, so one that reverts every time
              // (a blocked payee) is not sent on every block. One the node or the network dropped
              // waits resendAfter. One that went through and is still planned waits resendAfter,
              // then twice that, and so on. One the contract said would change nothing, without
              // saying it never will (a campaign not due yet: the keeper's clock is ahead), is
              // asked again after resendAfter, doubling to sixteen times it.
              const wait =
                last.how === "refused" ? retryFailedAfter : last.how === "ok" ? doubled(resendAfter, last.went, 30) : last.how === "nothing" ? doubled(resendAfter, last.none, 4) : resendAfter;
              if (waitClock() - last.at < wait) continue;
            }
            let result: SendResult;
            try {
              result = await send(action);
            } catch (e) {
              result = { ok: false, error: shortMessage(e) };
            }
            const none = result.ok ? undefined : result.nothing;
            if (none?.absent === true) absent.set(action.id, { at: waitClock(), count: (absent.get(action.id)?.count ?? 0) + 1 });
            else absent.delete(action.id);
            // A call that went through shows the outcome is set: an "open" remembered from a node that was behind is dropped.
            if (result.ok && told.get(action.id)?.outcome === OPEN) told.delete(action.id);
            for (const b of (result.ok ? result.owedNothing : none?.owedNothing) ?? []) owedNothing.add(`${action.id}:${b.toLowerCase()}`);
            if (none !== undefined) {
              // Nothing was sent. What the contract said is finished is never asked again; a payout
              // that would fail waits like one that did fail.
              if (none.outcome !== undefined && hear(action.id, none.outcome)) learned = true;
              if (none.final) over.add(key);
              if (none.hold) holds.set(action.id, waitClock());
              for (const b of none.blocked) {
                const who = `${action.id}:${b.toLowerCase()}`;
                failed.set(who, { at: waitClock(), count: (failed.get(who)?.count ?? 0) + 1 });
              }
            }
            const went = last?.went ?? 0;
            sends.set(key, {
              id: action.id,
              at: waitClock(),
              how: result.ok ? "ok" : none !== undefined ? "nothing" : result.reverted === true ? "refused" : "fault",
              went: result.ok ? went + 1 : went,
              none: none !== undefined ? (last?.none ?? 0) + 1 : 0,
            });
            if (result.ok) sent += 1;
            else if (none === undefined) {
              failedSends += 1;
              recordError(result.error);
            }
            out.push({ action, result });
          }
        } catch {
          // The action pass never rejects the delivery chain; a fault is reported through health.
        }
        if (!learned) break;
      }
      return out;
    };
    const done = chain.then(work, work) as Promise<{ action: Action; result: SendResult }[]>;
    chain = done;
    return done;
  }

  function deliver(d: Delivery): {
    applied: number;
    repeats: number;
    done: Promise<{ action: Action; result: SendResult }[]>;
  } {
    const t = BigInt(d.time);

    // If the store cannot be written this throws, nothing is applied, and the delivery goes
    // unanswered. The node reader (follow.ts) counts a fault and reads again on its next tick.
    const { applied, repeats } = take(decodeLogs(d.logs, boomerang), true, t);

    if (t > lastTime) lastTime = t;
    // What /health shows as the newest block never turns back for a delivery of older blocks.
    if (d.toBlock >= lastBlock) lastBlock = d.toBlock;

    return { applied, repeats, done: runActions() };
  }

  function health(): Health {
    const m = missing(ledger);
    return {
      lastSeq: ledger.lastSeq.toString(),
      missing: m === null ? null : { from: m.from.toString(), to: m.to.toString() },
      pending: ledger.pending.size,
      repeats: ledger.repeats,
      lastBlock,
      lastTime: lastTime.toString(),
      sent,
      failedSends,
      rejected,
      gaveUp: [...gaveUp],
      absent: [...absent.keys()].slice(0, 20).map(String),
      lastErrors: [...lastErrors],
      settled: settled(ledger),
    };
  }

  function feed(limit = 200): BoomerangEvent[] {
    return feedList.slice(Math.max(0, feedList.length - limit));
  }

  return { ledger, deliver, health, feed };
}
