// The follower: the keeper's reading of Arc's node, and its only source of events.
//
// The keeper acts only when it is handed a delivery: the event logs of a run of blocks, and a
// time. The follower asks the node two small things every few seconds: the newest block, and
// Boomerang's logs since the last block the keeper heard. It hands them to the keeper as one
// delivery. With no new block there are no logs to hand over, but the keeper is still told the
// time, so a call it put off is tried again.
//
// It reads in small steps and keeps its place. A public node refuses a caller that asks too
// much at once (Arc's did, in a test on 2026-11-18, after a few dozen log requests in a row).
// So one read of new blocks makes at most `perRead` log requests, each of at most `span` blocks,
// and hands over what it got; a long way behind, the next tick carries on from there. A part
// that does not reach the newest block carries only the time of its own newest log, so the
// keeper's clock never runs ahead of what it has been told.
//
// It also mends a hole. If an event number is missing from the ledger for `healAfterMs`
// (whichever read lost it), the follower reads again from the contract's first block, once
// for that hole, one log request a tick beside the reading of new blocks. Events the ledger
// already has are counted as repeats and change nothing. If a request for the hole fails, new
// blocks are still read, and the hole is taken up again from where it was after twice the wait,
// then four times, up to 64. A hole still there 64 waits after its read finished (the node may
// have been behind) is read for once more.
//
// It keeps no store of its own. It reads up to the node's newest block and trusts the node's
// logs; the sender asks the contract before it spends anything.
//
// A node's error text is never kept or printed: an RPC address can carry a key.
import type { Address, RawLog } from "../../../packages/kit/src/index.ts";
import type { Delivery, Keeper } from "./keeper.ts";

/** The two things the follower asks of a node. Logs come with their block's number and time, removed ones left out. */
export type Node = {
  head(): Promise<{ number: bigint; time: bigint }>;
  logs(from: bigint, to: bigint): Promise<RawLog[]>;
};

export type FollowState = {
  /** Deliveries handed to the keeper from the node since the keeper started. */
  reads: number;
  /** This machine's wall time at the last of them, in milliseconds. */
  lastReadAt: number | null;
  /** The newest block read to. */
  readTo: number | null;
  /** Reads that failed (the node did not answer, or the keeper could not keep the delivery). */
  faults: number;
};

export type Follower = { tick(): Promise<void>; state(): FollowState };

export function createFollower(o: {
  keeper: Pick<Keeper, "deliver" | "health">;
  node: Node;
  /** The block the contract was created in: no read starts below it. */
  startBlock: bigint;
  /** How many blocks one logs call covers. Default 10,000, the most Arc's node takes in one call. */
  span?: bigint;
  /** How many logs calls one read of new blocks may make. Default two. */
  perRead?: number;
  /** How long an event number may be missing before the node is read from the contract's first block. Default one minute. */
  healAfterMs?: number;
  clock?: () => number;
}): Follower {
  const { keeper, node, startBlock } = o;
  const span = o.span ?? 10_000n;
  const perRead = BigInt(o.perRead ?? 2);
  const healAfterMs = o.healAfterMs ?? 60_000;
  const clock = o.clock ?? Date.now;
  if (span < 1n) throw new Error("the span must be at least one block");
  if (perRead < 1n) throw new Error("a read must make at least one call");

  let busy = false;
  /** The next block to read; null until the first read, which starts after the last block the keeper's store has heard. */
  let next: bigint | null = null;
  let reads = 0;
  let lastReadAt: number | null = null;
  let readTo: number | null = null;
  let faults = 0;
  // The hole in the ledger's event numbers now seen: where it starts, since when, the next block
  // of the read for it, whether that read is done, and how many of its requests have failed.
  let gap: { from: string; since: number; at: bigint; read: boolean; tries: number; doneAt: number | null } | null = null;
  const newGap = (from: string, since: number): NonNullable<typeof gap> => ({ from, since, at: startBlock, read: false, tries: 0, doneAt: null });

  // The logs of a range, a span at a call. Nothing is handed over unless every call got through.
  async function gather(from: bigint, to: bigint): Promise<RawLog[]> {
    const logs: RawLog[] = [];
    for (let a = from; a <= to; a += span) {
      const b = a + span - 1n < to ? a + span - 1n : to;
      logs.push(...(await node.logs(a, b)));
    }
    return logs;
  }

  // The time of the newest log in a part, or 0 when it has none: a time the keeper's clock, which
  // only moves forward, takes no notice of.
  const newest = (logs: RawLog[]): bigint => logs.reduce((t, l) => (l.blockTimestamp != null && BigInt(l.blockTimestamp) > t ? BigInt(l.blockTimestamp) : t), 0n);

  // One delivery: the blocks `from` to `to`, their logs, and the time to tell the keeper. If the store cannot be written `deliver` throws and nothing was applied.
  function hand(from: bigint, to: bigint, time: bigint, logs: RawLog[]): void {
    const delivery: Delivery = { fromBlock: Number(from <= to ? from : to), toBlock: Number(to), time: Number(time), logs };
    keeper.deliver(delivery).done.catch(() => {}); // a sender fault is reported through /health, never thrown here
    reads += 1;
    lastReadAt = clock();
    if (readTo === null || delivery.toBlock > readTo) readTo = delivery.toBlock;
  }

  async function tick(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const h = keeper.health();
      const now = clock();

      if (h.missing === null) gap = null;
      else if (gap === null) gap = newGap(h.missing.from, now);
      else if (gap.from !== h.missing.from) {
        // A hole whose first number moves while its read is under way is being filled by that
        // read (or by deliveries settling into order): the read keeps its place. After a
        // finished read, a different number is a new hole.
        if (gap.read) gap = newGap(h.missing.from, now);
        else gap.from = h.missing.from;
      } else if (gap.read && gap.doneAt !== null && now - gap.doneAt >= healAfterMs * 64) {
        // Read for in full and still there long after (this node may have been behind): once more.
        gap = newGap(gap.from, now - healAfterMs);
      }
      // A request for a hole that failed is tried again after twice the wait, then four times, up to 64.
      const heal = gap !== null && !gap.read && now - gap.since >= healAfterMs * 2 ** Math.min(gap.tries, 6);

      const head = await node.head();

      // The new blocks: from the place kept, or the block after the last one the keeper heard,
      // as far as `perRead` calls reach.
      {
        const keptPlace = next ?? BigInt(h.lastBlock) + 1n;
        const from = keptPlace < startBlock ? startBlock : keptPlace;
        const reach = from + span * perRead - 1n;
        const to = reach < head.number ? reach : head.number;
        const logs = await gather(from, to);
        // With no new block there is nothing to ask for, but the keeper is still handed the time,
        // so a call it put off is tried again.
        const reached = to >= head.number;
        hand(from, to, reached ? head.time : newest(logs), logs);
        // The place never goes back: a node behind the keeper's last block is not asked again
        // for blocks the keeper has already heard.
        const after = to + 1n;
        next = after > from ? after : from;
      }

      // The hole: one call a tick from its own place, handed over as a delivery of its own, so
      // that a failure here never holds up the new blocks above.
      if (heal && gap !== null) {
        const mending = gap;
        try {
          const from = mending.at;
          const reach = from + span - 1n;
          const to = reach < head.number ? reach : head.number;
          const logs = from <= to ? await node.logs(from, to) : [];
          hand(from, to, newest(logs), logs);
          mending.at = to + 1n;
          if (to >= head.number) {
            mending.read = true;
            mending.doneAt = now;
          }
        } catch {
          faults += 1;
          mending.tries += 1;
          mending.since = now;
        }
      }
    } catch {
      faults += 1;
    } finally {
      busy = false;
    }
  }

  return {
    tick,
    state: () => ({ reads, lastReadAt, readTo, faults }),
  };
}

type Rpc = (args: { method: string; params?: unknown[] }) => Promise<unknown>;

const HEX = /^0x[0-9a-fA-F]+$/;
const quantity = (v: unknown): bigint => {
  if (typeof v !== "string" || !HEX.test(v)) throw new Error("the node's answer has no number where one belongs");
  return BigInt(v);
};
const toHex = (n: bigint): string => `0x${n.toString(16)}`;

/** A node reached by plain JSON-RPC, answering the follower's two questions. */
export function nodeFrom(rpc: Rpc, boomerang: Address): Node {
  async function timeOf(block: bigint): Promise<bigint> {
    const b = (await rpc({ method: "eth_getBlockByNumber", params: [toHex(block), false] })) as { timestamp?: unknown } | null;
    if (b === null || typeof b !== "object") throw new Error("the node does not have the block");
    return quantity(b.timestamp);
  }

  return {
    async head() {
      const b = (await rpc({ method: "eth_getBlockByNumber", params: ["latest", false] })) as { number?: unknown; timestamp?: unknown } | null;
      if (b === null || typeof b !== "object") throw new Error("the node has no newest block");
      return { number: quantity(b.number), time: quantity(b.timestamp) };
    },

    async logs(from, to) {
      const answer = await rpc({ method: "eth_getLogs", params: [{ address: boomerang, fromBlock: toHex(from), toBlock: toHex(to) }] });
      if (!Array.isArray(answer)) throw new Error("the node's logs are not a list");
      const times = new Map<bigint, bigint>();
      const out: RawLog[] = [];
      for (const item of answer) {
        if (item === null || typeof item !== "object") throw new Error("a log is not an object");
        const l = item as Record<string, unknown>;
        if (l.removed === true) continue;
        if (typeof l.address !== "string" || typeof l.data !== "string" || !Array.isArray(l.topics) || !l.topics.every((t) => typeof t === "string")) {
          throw new Error("a log is not in a log's shape");
        }
        const blockNumber = quantity(l.blockNumber);
        // Newer nodes put the block's time on the log; for the others the block is asked, once.
        let time = typeof l.blockTimestamp === "string" && HEX.test(l.blockTimestamp) ? BigInt(l.blockTimestamp) : times.get(blockNumber);
        if (time === undefined) {
          time = await timeOf(blockNumber);
          times.set(blockNumber, time);
        }
        const log: RawLog = {
          address: l.address as Address,
          topics: l.topics as `0x${string}`[],
          data: l.data as `0x${string}`,
          blockNumber,
          blockTimestamp: time,
        };
        if (typeof l.transactionHash === "string") log.transactionHash = l.transactionHash as `0x${string}`;
        if (typeof l.logIndex === "string" || typeof l.logIndex === "number") log.logIndex = l.logIndex as `0x${string}` | number;
        out.push(log);
      }
      return out;
    },
  };
}
