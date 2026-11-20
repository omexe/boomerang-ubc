// Decoding Boomerang's nine events from raw logs into a typed, seq-ordered stream.
//
// Every event carries its sequence number `seq` and campaign `id`, plus its own arguments
// under the Solidity argument names. Block number and timestamp, when the log carries them,
// are normalised to bigint; they can arrive as hex strings, numbers or bigints.
import { decodeEventLog } from "viem";

import { boomerangAbi } from "./abi.ts";
import type { Address, Terms } from "./types.ts";

// A log as it may arrive from an RPC, a receipt or getLogs: block fields in any of the
// shapes those sources use (hex string, number, bigint or absent).
export type RawLog = {
  address: Address;
  topics: readonly `0x${string}`[];
  data: `0x${string}`;
  blockNumber?: bigint | `0x${string}` | number | null;
  blockTimestamp?: bigint | `0x${string}` | number | null;
  transactionHash?: `0x${string}` | null;
  logIndex?: number | `0x${string}` | null;
};

// Fields shared by every decoded event.
type Base = {
  seq: bigint;
  id: bigint;
  time?: bigint;
  blockNumber?: bigint;
  txHash?: `0x${string}`;
};

// The nine Boomerang events, discriminated on `name`, args under their Solidity names.
export type BoomerangEvent =
  | (Base & { name: "CampaignCreated"; sponsor: Address; terms: Terms })
  | (Base & { name: "PotFunded"; bonus: boolean; from: Address; amount: bigint })
  | (Base & { name: "Pledged"; backer: Address; payer: Address; amount: bigint; weight: bigint })
  | (Base & { name: "Rescued"; amount: bigint })
  | (Base & { name: "Finalized"; outcome: number; bonusPaid: bigint })
  | (Base & { name: "Paid"; backer: Address; to: Address; principal: bigint; bonus: bigint })
  | (Base & { name: "PayFailed"; backer: Address; to: Address; amount: bigint })
  | (Base & { name: "SidePaid"; side: number; to: Address; amount: bigint })
  | (Base & { name: "Redirected"; backer: Address; to: Address });

const EVENT_NAMES = new Set([
  "CampaignCreated",
  "PotFunded",
  "Pledged",
  "Rescued",
  "Finalized",
  "Paid",
  "PayFailed",
  "SidePaid",
  "Redirected",
]);

// Normalise a block field to bigint. Hex strings ("0x10") and decimal numbers both convert.
function toBigint(v: bigint | `0x${string}` | number | null | undefined): bigint | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "bigint") return v;
  return BigInt(v);
}

// Decode the Boomerang events from `logs`, newest-last. Logs that are not one of the nine
// events, or (when `boomerang` is given) not from that address, are silently skipped.
// The result is sorted by `seq` ascending.
export function decodeLogs(logs: readonly RawLog[], boomerang?: Address): BoomerangEvent[] {
  const target = boomerang?.toLowerCase();
  const out: BoomerangEvent[] = [];

  for (const log of logs) {
    if (target !== undefined && log.address.toLowerCase() !== target) continue;

    let decoded;
    try {
      decoded = decodeEventLog({
        abi: boomerangAbi,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        data: log.data,
        strict: true,
      });
    } catch {
      continue; // not a Boomerang event signature, or malformed
    }
    if (!EVENT_NAMES.has(decoded.eventName)) continue;

    const a = decoded.args as Record<string, unknown>;
    const time = toBigint(log.blockTimestamp);
    const blockNumber = toBigint(log.blockNumber);
    const extra: { time?: bigint; blockNumber?: bigint; txHash?: `0x${string}` } = {};
    if (time !== undefined) extra.time = time;
    if (blockNumber !== undefined) extra.blockNumber = blockNumber;
    if (log.transactionHash) extra.txHash = log.transactionHash;
    const base = { seq: a.seq as bigint, id: a.id as bigint, ...extra };

    let ev: BoomerangEvent;
    switch (decoded.eventName) {
      case "CampaignCreated":
        ev = { name: "CampaignCreated", ...base, sponsor: a.sponsor as Address, terms: a.terms as Terms };
        break;
      case "PotFunded":
        ev = { name: "PotFunded", ...base, bonus: a.bonus as boolean, from: a.from as Address, amount: a.amount as bigint };
        break;
      case "Pledged":
        ev = {
          name: "Pledged",
          ...base,
          backer: a.backer as Address,
          payer: a.payer as Address,
          amount: a.amount as bigint,
          weight: a.weight as bigint,
        };
        break;
      case "Rescued":
        ev = { name: "Rescued", ...base, amount: a.amount as bigint };
        break;
      case "Finalized":
        ev = { name: "Finalized", ...base, outcome: a.outcome as number, bonusPaid: a.bonusPaid as bigint };
        break;
      case "Paid":
        ev = {
          name: "Paid",
          ...base,
          backer: a.backer as Address,
          to: a.to as Address,
          principal: a.principal as bigint,
          bonus: a.bonus as bigint,
        };
        break;
      case "PayFailed":
        ev = { name: "PayFailed", ...base, backer: a.backer as Address, to: a.to as Address, amount: a.amount as bigint };
        break;
      case "SidePaid":
        ev = { name: "SidePaid", ...base, side: a.side as number, to: a.to as Address, amount: a.amount as bigint };
        break;
      case "Redirected":
        ev = { name: "Redirected", ...base, backer: a.backer as Address, to: a.to as Address };
        break;
      default:
        continue;
    }
    out.push(ev);
  }

  out.sort((x, y) => (x.seq < y.seq ? -1 : x.seq > y.seq ? 1 : 0));
  return out;
}
