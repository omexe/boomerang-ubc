// Everything the pages show, read in one go at one block. The newest block is fetched once, and
// every figure from the contract and the token is then read at that block's number, so "as of
// block N" on a page is true of every number beside it. The keeper is asked at the same time,
// but it is a second opinion, not part of the picture: it has no block and changes no figure.
import type { PublicClient } from "viem";

import { reader, type Address, type Backer } from "../../../packages/kit/src/index.ts";
import type { KeeperAnswer } from "../data/ask.ts";
import { exampleBacker } from "../data/keeper.ts";
import { custodyAt, inBatches, loadCampaigns, loadMine, type CampaignView, type Custody, type MyPledge } from "../data/load.ts";

/** One of the keeper's ledger backer records, paired with the contract's own record read at the same block. */
export type BackerCheck = { id: bigint; address: Address; chain: Backer };

/** Another account's pledges, read as the connected account's own are. `example` marks a backer the page chose itself, to show what the page looks like with nobody connected. */
export type Lookup = { address: Address; mine: MyPledge[]; example: boolean };

/** One backer of the campaign shown: the contract's own record, what it owes them now, and what would come back if the campaign missed from here. */
export type BackerRow = { address: Address; backer: Backer; owed: { principal: bigint; bonus: bigint }; ifMissed: { principal: bigint; bonus: bigint } };

/** How many of a campaign's backers one read takes in. */
export const BACKERS_SHOWN = 50;

export type World = {
  /** The block every figure below was read at, and that block's time. */
  block: bigint;
  now: bigint;
  /** How many campaigns the contract has; `campaigns` holds the newest fifty of them, newest first. */
  count: bigint;
  campaigns: CampaignView[];
  /** The campaign the page asked for, when the contract has it and it is older than those fifty; read at the same block. */
  extra: CampaignView | null;
  custody: Custody;
  /** The connected account, its pledges, its USDC and what it has allowed the contract to take. */
  account: Address | null;
  mine: MyPledge[];
  balance: bigint | null;
  allowance: bigint | null;
  keeper: KeeperAnswer;
  /** For up to 100 of the keeper's ledger backer records (newest campaigns first), the contract's own record at this block; null when the keeper is down. */
  backerChecks: BackerCheck[] | null;
  /** How many backer records the keeper's ledger lists in all (so the Proof page can say when it compared only some). */
  backerTotal: number;
  /** The account My money was asked to show that is not the connected one, or the example backer; null when neither was asked for. */
  lookup: Lookup | null;
  /**
   * For the campaign the page shows: the contract's own record of each address the keeper's ledger
   * lists as its backer (the first `BACKERS_SHOWN`; `listed` is how many it lists). The contract keeps
   * no list of backers, so the addresses are the keeper's and every figure is the contract's. Null
   * when no campaign is shown or the keeper is down; an empty list when its ledger has no such campaign.
   */
  shownBackers: { id: bigint; rows: BackerRow[]; listed: number } | null;
};

/** How many of the newest campaigns one read takes in. */
export const NEWEST = 50;

const tokenAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export async function readWorld(o: {
  client: PublicClient;
  where: { boomerang: Address; usdc: Address };
  account: Address | null;
  /** Asks the keeper; must not throw (see `askKeeper`). */
  keeper: () => Promise<KeeperAnswer>;
  /** A campaign the page is showing. When the contract has it and it is older than the newest fifty, it is read too, at the same block. */
  also?: bigint | null;
  /** How many of the newest campaigns to read; the page reads `NEWEST`. */
  newest?: number;
  /** Another account whose pledges to read (My money's look-up). */
  lookup?: Address | null;
  /** With no look-up and nobody connected, read an example backer's pledges, chosen from the keeper's ledger. */
  example?: boolean;
  /** The campaign whose backers to read (the campaign page). */
  backersOf?: bigint | null;
}): Promise<World> {
  const keeper = o.keeper(); // started now, awaited last: a slow keeper never delays the contract's figures being read
  const block = await o.client.getBlock();
  const at = { blockNumber: block.number };
  const reads = reader(o.client, o.where.boomerang, block.number);
  const account = o.account;

  const wallet =
    account === null
      ? Promise.resolve<[bigint | null, bigint | null]>([null, null])
      : (Promise.all([
          o.client.readContract({ address: o.where.usdc, abi: tokenAbi, functionName: "balanceOf", args: [account], ...at }),
          o.client.readContract({ address: o.where.usdc, abi: tokenAbi, functionName: "allowance", args: [account, o.where.boomerang], ...at }),
        ]) as Promise<[bigint, bigint]>);

  const [count, newest, custody, [balance, allowance]] = await Promise.all([
    reads.campaignCount(),
    loadCampaigns(reads, o.newest ?? NEWEST),
    custodyAt(o.client, o.where, block),
    wallet,
  ]);
  const also = o.also ?? null;
  const campaigns = newest;
  const extra = also !== null && also >= 1n && also <= count && !newest.some((c) => c.id === also) ? await reads.campaign(also) : null;
  // The account's pledges are looked for in the campaigns read, the asked-for older one among them.
  const within = extra === null ? campaigns : [...campaigns, extra];
  const mine = account === null ? [] : await loadMine(reads, within, account);
  // An address someone typed, or one the keeper wrote, may be in any mix of cases, and a read
  // refuses a mixed case that is not the address's own checksum. In lower case it is the same
  // account and every read accepts it.
  const plain = (a: Address) => a.toLowerCase() as Address;
  // Whose money My money shows when it is not the connected account's. An address asked for is
  // read now, before the keeper has answered: it needs nothing of the keeper's.
  // The connected account looked up by its own address is not read twice: its pledges are `mine`.
  const asked = o.lookup && plain(o.lookup) !== (account === null ? null : plain(account)) ? plain(o.lookup) : null;
  let lookup: Lookup | null = asked === null ? null : { address: asked, mine: await loadMine(reads, within, asked), example: false };
  const answer = await keeper;

  // With nobody connected and no address asked for, an example backer. The keeper's ledger only
  // names it; its pledges are the contract's. It is chosen among the campaigns read here, so the
  // one shown always has a pledge on the page.
  if (asked === null && o.example === true && account === null && answer.up) {
    const readHere = new Set(within.map((c) => c.id));
    const named = exampleBacker({ ...answer.ledger, campaigns: answer.ledger.campaigns.filter((c) => readHere.has(c.id)) });
    if (named !== null) lookup = { address: plain(named), mine: await loadMine(reads, within, plain(named)), example: true };
  }

  // Who backed the campaign shown. The addresses are the keeper's; the records are the contract's.
  let shownBackers: World["shownBackers"] = null;
  const shown = o.backersOf ?? null;
  const listedFor = shown !== null && answer.up ? answer.ledger.campaigns.find((c) => c.id === shown) : undefined;
  if (shown !== null && answer.up) {
    // One read per address, whatever case the keeper wrote it in. A campaign the ledger does not
    // have yet is an empty list: asked about and answered, which is not the same as not read.
    const addresses = [...new Set((listedFor?.backers ?? []).map((b) => plain(b.address)))];
    const rows = await inBatches(addresses.slice(0, BACKERS_SHOWN), 8, async (address): Promise<BackerRow> => {
      const [backer, owed, ifMissed] = await Promise.all([reads.backerOf(shown, address), reads.owedTo(shown, address), reads.positionIfMissed(shown, address)]);
      return { address, backer, owed, ifMissed };
    });
    shownBackers = { id: shown, rows, listed: addresses.length };
  }

  // For up to 100 of the keeper's ledger backer records (newest campaigns first), read the
  // contract's own record at this same block (through the block-pinned reader), so the Proof page
  // can set the keeper's claims against the contract backer by backer.
  let backerChecks: BackerCheck[] | null = null;
  let backerTotal = 0;
  if (answer.up) {
    const pairs: { id: bigint; address: Address }[] = [];
    const newestFirst = [...answer.ledger.campaigns].sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0));
    for (const lc of newestFirst) for (const b of lc.backers) pairs.push({ id: lc.id, address: b.address });
    backerTotal = pairs.length;
    backerChecks = await inBatches(pairs.slice(0, 100), 8, async (p) => ({ id: p.id, address: p.address, chain: await reads.backerOf(p.id, plain(p.address)) }));
  }

  return { block: block.number, now: block.timestamp, count, campaigns, extra, custody, account, mine, balance, allowance, keeper: answer, backerChecks, backerTotal, lookup, shownBackers };
}

/**
 * What the page may show as the connected account's own. The world was read for `world.account`;
 * until a read for `account` lands, nothing of another account's is shown.
 */
export function ownIn(world: World, account: Address | null): { known: boolean; mine: MyPledge[]; balance: bigint | null; allowance: bigint | null } {
  if (account === null || world.account !== account) return { known: false, mine: [], balance: null, allowance: null };
  return { known: true, mine: world.mine, balance: world.balance, allowance: world.allowance };
}

/** The campaign with this number, if it is among those read. */
export function campaignIn(world: World, id: bigint): CampaignView | undefined {
  return world.campaigns.find((c) => c.id === id) ?? (world.extra?.id === id ? world.extra : undefined);
}
