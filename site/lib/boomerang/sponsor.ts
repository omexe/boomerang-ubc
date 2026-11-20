// The sponsor's contract calls, as plain lists for the engine's `send`, and the names sponsors
// give their campaigns in this browser (the contract holds no names).
import type { Abi } from "viem";

import { boomerangAbi, type Address, type Terms } from "../../../packages/kit/src/index.ts";
import type { Call } from "../../../web/src/flows/calls.ts";
import { tokenAbi } from "../../../web/src/flows/calls.ts";
import type { Label } from "../../../web/src/data/labels.ts";

const boomerang = boomerangAbi as unknown as Abi;
const token = tokenAbi as unknown as Abi;

export function createCall(o: { boomerang: Address; terms: Terms }): Call {
  return { label: "Create the campaign", to: o.boomerang, abi: boomerang, functionName: "createCampaign", args: [o.terms] };
}

/** Lock the match and the bonus: one approval for both, then each pot. Only pots still owed are sent. */
export function lockCalls(o: { boomerang: Address; usdc: Address; id: bigint; match: bigint | null; bonus: bigint | null; allowance: bigint }): Call[] {
  const total = (o.match ?? 0n) + (o.bonus ?? 0n);
  const calls: Call[] = [];
  if (total === 0n) return calls;
  if (o.allowance < total) calls.push({ label: "Allow the contract to take the match and bonus", to: o.usdc, abi: token, functionName: "approve", args: [o.boomerang, total] });
  if (o.match) calls.push({ label: "Lock the match", to: o.boomerang, abi: boomerang, functionName: "fundMatch", args: [o.id] });
  if (o.bonus) calls.push({ label: "Lock the bonus", to: o.boomerang, abi: boomerang, functionName: "fundBonus", args: [o.id] });
  return calls;
}

/** Close the whole remaining gap with the sponsor's own money: the campaign is funded at once. */
export function rescueCalls(o: { boomerang: Address; usdc: Address; id: bigint; gap: bigint; allowance: bigint }): Call[] {
  const calls: Call[] = [];
  if (o.allowance < o.gap) calls.push({ label: "Allow the contract to take the gap", to: o.usdc, abi: token, functionName: "approve", args: [o.boomerang, o.gap] });
  calls.push({ label: "Close the gap", to: o.boomerang, abi: boomerang, functionName: "rescue", args: [o.id] });
  return calls;
}

// ---- names kept in this browser

const KEY = "boomerang:mylabels";
type Stored = { id: string; sponsor: string; recipient: string; title: string };

export function loadMyLabels(): Label[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "[]") as Stored[];
    return raw.map((r) => ({ id: BigInt(r.id), sponsor: r.sponsor as Address, recipient: r.recipient as Address, title: r.title, by: "", sponsorName: "", about: "", example: false }));
  } catch {
    return [];
  }
}

export function saveMyLabel(l: { id: bigint; sponsor: Address; recipient: Address; title: string }) {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "[]") as Stored[];
    const next = [...raw.filter((r) => r.id !== l.id.toString()), { id: l.id.toString(), sponsor: l.sponsor, recipient: l.recipient, title: l.title.slice(0, 80) }];
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage blocked: the campaign goes by its number */
  }
}
