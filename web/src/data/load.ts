// What the pages read from the contract, in as few round trips as the node allows.
//
// Everything here goes through a `Reads` object, which is the kit's `reader(client, boomerang)`;
// tests hand in the same reader over an in-memory chain. Nothing here is cached: the pages ask
// again on a timer, and the contract is the source of truth for every figure a visitor acts on.
import type { Abi, PublicClient } from "viem";

import type { Address, Backer, State, Terms } from "../../../packages/kit/src/index.ts";
import { boomerangAbi } from "../../../packages/kit/src/index.ts";

export type Reads = {
  campaignCount(): Promise<bigint>;
  totalOwed(): Promise<bigint>;
  eventCount(): Promise<bigint>;
  campaign(id: bigint): Promise<{ id: bigint; terms: Terms; state: State; outcomeNow: number }>;
  backerOf(id: bigint, backer: Address): Promise<Backer>;
  owedTo(id: bigint, backer: Address): Promise<{ principal: bigint; bonus: bigint }>;
  positionIfMissed(id: bigint, backer: Address): Promise<{ principal: bigint; bonus: bigint }>;
};

export type CampaignView = { id: bigint; terms: Terms; state: State; outcomeNow: number };

/** Run `job` over `items`, at most `width` at a time, keeping the order of the answers. */
export async function inBatches<T, R>(items: readonly T[], width: number, job: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += width) {
    out.push(...(await Promise.all(items.slice(i, i + width).map(job))));
  }
  return out;
}

/** Every campaign, newest first. `limit` keeps the newest that many. */
export async function loadCampaigns(reads: Reads, limit: number = 50): Promise<CampaignView[]> {
  const count = await reads.campaignCount();
  const ids: bigint[] = [];
  for (let id = count; id >= 1n && ids.length < limit; id -= 1n) ids.push(id);
  return inBatches(ids, 8, (id) => reads.campaign(id));
}

/** The home page's totals, summed over the campaigns given. */
export function totalsOf(campaigns: readonly CampaignView[]): { campaigns: number; backers: number; pledged: bigint; bonusPaid: bigint } {
  let backers = 0;
  let pledged = 0n;
  let bonusPaid = 0n;
  for (const c of campaigns) {
    backers += Number(c.state.backers);
    pledged += c.state.pledged;
    bonusPaid += c.state.bonusPaid;
  }
  return { campaigns: campaigns.length, backers, pledged, bonusPaid };
}

export type MyPledge = {
  campaign: CampaignView;
  backer: Backer;
  /** What the contract would pay this address now: zero unless the campaign has missed and the refund is unpaid. */
  owed: { principal: bigint; bonus: bigint };
  /** What this pledge would bring back if the campaign missed from here: meaningful while it is open. */
  ifMissed: { principal: bigint; bonus: bigint };
};

/** One address's pledges across the campaigns given: only those where it has a record. */
export async function loadMine(reads: Reads, campaigns: readonly CampaignView[], address: Address): Promise<MyPledge[]> {
  const records = await inBatches(campaigns, 8, async (campaign) => ({ campaign, backer: await reads.backerOf(campaign.id, address) }));
  const mine = records.filter((r) => r.backer.principal > 0n);
  return inBatches(mine, 8, async ({ campaign, backer }) => {
    const [owed, ifMissed] = await Promise.all([reads.owedTo(campaign.id, address), reads.positionIfMissed(campaign.id, address)]);
    return { campaign, backer, owed, ifMissed };
  });
}

const balanceOfAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export type Custody = { block: bigint; time: bigint; held: bigint; owed: bigint; events: bigint; ok: boolean };

/**
 * The Proof page's first line: what the contract holds against what it owes. Both figures, and
 * the count of events, are read at one and the same block, so they describe one moment.
 */
export async function custodyAt(client: PublicClient, o: { boomerang: Address; usdc: Address }, block: { number: bigint; timestamp: bigint }): Promise<Custody> {
  const at = { blockNumber: block.number };
  const abi = boomerangAbi as unknown as Abi;
  const [held, owed, events] = (await Promise.all([
    client.readContract({ address: o.usdc, abi: balanceOfAbi, functionName: "balanceOf", args: [o.boomerang], ...at }),
    client.readContract({ address: o.boomerang, abi, functionName: "totalOwed", ...at }),
    client.readContract({ address: o.boomerang, abi, functionName: "eventCount", ...at }),
  ])) as [bigint, bigint, bigint];
  return { block: block.number, time: block.timestamp, held, owed, events, ok: held >= owed };
}

/** `custodyAt` the newest block. */
export async function custodyNow(client: PublicClient, o: { boomerang: Address; usdc: Address }): Promise<Custody> {
  return custodyAt(client, o, await client.getBlock());
}
