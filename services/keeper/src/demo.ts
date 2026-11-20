// The demo desk: the keeper's own account does two small, capped things so a judge with an empty
// wallet can try the app. It hands out a fixed slug of test USDC once per address, and it opens
// one fully-funded demo campaign at a time. Both refuse unless the desk is above a floor, so it
// cannot be emptied, and both leave the campaign's real settlement to the keeper.
//
// What the desk can lose is test money, and it is bounded. Each new address takes one slug, until
// the desk holds less than the floor plus a slug (5 USDC). A demo campaign costs the desk at most
// its two pots, as the rules say: a visitor who pledges early into one that misses collects bonus
// from its pool (at most 0.30), and one that is funded pays its match (1.00) to the demo
// recipient. One campaign runs at a time, and the shortest kind is over in under three minutes,
// so that is how fast the pots can go; it stops when the desk holds less than the floor plus the
// two pots (4.30). So everything above about 3 USDC can be given away, and no more. The keeper's
// own settlement calls are paid from the same account and are not held to the floor: the floor
// is what is kept for them.
//
// The floor is checked against the balance the chain has confirmed, so the desk does nothing
// while any transaction from its account is still unconfirmed: money already on its way out is
// not yet missing from that balance. That count of unconfirmed transactions is the node's own
// ("pending"); a node that cannot see its waiting transactions would let the desk go below the
// floor by what is in flight, and no further.
import { encodeFunctionData, isAddress, type Abi, type Address as ViemAddress, type PublicClient, type WalletClient } from "viem";

import { boomerangAbi, decodeLogs, Outcome, type Address, type Ledger, type RawLog } from "../../../packages/kit/src/index.ts";
import { makeQueue } from "./chain.ts";
import type { Store } from "./store.ts";

// Sized to Circle's faucet, which gives an address 20 test USDC every two hours. One slug cannot
// meet the target alone, so a lone visitor sees the refund and the bonus; two can fund it.
// On Arc the same balance pays for gas, which is what the floor is kept for.
export const DEMO = {
  usdc: 2_000_000n,
  floor: 3_000_000n,
  target: 3_000_000n,
  minPledge: 100_000n,
  match: 1_000_000n,
  pool: 300_000n,
  // The design's defaults: pool 10% of the target, rate 20%, early window 60% of the time open.
  rateBps: 2000,
  // The ten-minute campaign's times, in seconds: how long after the request it opens, how long
  // the early window is, and how long it takes pledges.
  opensIn: 60n,
  earlyFor: 360n,
  openFor: 600n,
} as const;

// The two campaigns the desk opens. The pots, the target and the rate are the same. The
// two-minute one is for watching the whole thing in one sitting. It opens 45 seconds after the
// request, because both pots must be locked before a campaign opens or the contract voids it; on
// Arc that takes about a quarter of a minute.
//
// The ten-minute one pays an early pledge more the earlier it comes (the design's default). The
// two-minute one pays every pledge in its early window the same. Over 72 seconds a bonus that
// shrinks falls a cent every few seconds on the desk's 2.00, and the page, which asks the contract
// again at each press and stops when the figure it showed has fallen, stopped two presses out of
// three (seen on Arc, campaign 7).
export const DESK_KINDS = {
  ten: { opensIn: DEMO.opensIn, earlyFor: DEMO.earlyFor, openFor: DEMO.openFor, linearWeight: true },
  two: { opensIn: 45n, earlyFor: 72n, openFor: 120n, linearWeight: false },
} as const;
export type DeskKind = keyof typeof DESK_KINDS;
// The furthest closing time the desk can write: the bound on what it believes of its own note.
const LONGEST = Object.values(DESK_KINDS).reduce((m, k) => (k.opensIn + k.openFor > m ? k.opensIn + k.openFor : m), 0n);

// How many desk requests may wait in line before new ones are turned away.
const MAX_WAITING = 10;

export type DeskResult =
  | { ok: true; hash?: `0x${string}`; id?: string }
  | { ok: false; reason: "bad-address" | "already-given" | "desk-low" | "campaign-open" | "busy" | "failed" | "unconfirmed"; detail?: string; hash?: `0x${string}` };

export type Desk = {
  address: Address;
  giveUsdc(to: string): Promise<DeskResult>;
  openCampaign(kind?: DeskKind): Promise<DeskResult>;
};

const ZERO = "0x0000000000000000000000000000000000000000";

const tokenAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const satisfies Abi;

function short(e: unknown): string {
  const a = e as { shortMessage?: unknown; message?: unknown } | undefined;
  const m = (a && (a.shortMessage ?? a.message)) ?? e;
  return String(m).slice(0, 200);
}

export function createDesk(o: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  boomerang: Address;
  usdc: Address;
  recipient: Address;
  store: Store;
  ledger: () => Ledger;
  // The line every transaction from this account waits in. Pass the keeper's own, so the desk
  // and the keeper never send at the same moment with the same nonce.
  queue?: <T>(job: () => Promise<T>) => Promise<T>;
}): Desk {
  const abi = boomerangAbi as unknown as Abi;
  const { publicClient, walletClient, boomerang, usdc, recipient, store, ledger } = o;
  const desk = walletClient.account!.address as Address;
  const account = walletClient.account;
  const chain = walletClient.chain;
  // The wallet's own methods, reached through loose locals: their overloads do not narrow well
  // here, and each call's shape is checked against the ABI when its data is encoded.
  const prepare = walletClient.prepareTransactionRequest as unknown as (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  const sendPrepared = walletClient.sendTransaction as unknown as (args: Record<string, unknown>) => Promise<`0x${string}`>;

  // A transaction made ready without sending it. Everything the node must be asked before it
  // can leave is asked here: the nonce, the gas and the fee. What is left, `send`, signs it (on
  // this machine, when the process holds the key) and hands it to the node: the one step after
  // which the transaction may be out, whatever the answer.
  type Ready = { send: () => Promise<`0x${string}`> };
  async function ready(call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }): Promise<Ready> {
    const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args as unknown[] });
    const request = await prepare({ account, chain, to: call.address, data });
    return { send: () => sendPrepared(request) };
  }

  const queue = o.queue ?? makeQueue();
  let waiting = 0;
  // One request at a time, in order. Reading the list of funded addresses, checking it and
  // writing it happen inside one turn, so two requests for one address cannot both pass.
  async function inTurn(job: () => Promise<DeskResult>): Promise<DeskResult> {
    if (waiting >= MAX_WAITING) return { ok: false, reason: "busy" };
    waiting += 1;
    try {
      return await queue(job);
    } finally {
      waiting -= 1;
    }
  }

  function balance(): Promise<bigint> {
    return publicClient.readContract({ address: usdc, abi: tokenAbi as unknown as Abi, functionName: "balanceOf", args: [desk] }) as Promise<bigint>;
  }

  // Has this account sent anything the chain has not confirmed yet? The count of its transactions
  // that are in a block is compared with the count including those still waiting.
  async function unconfirmed(): Promise<boolean> {
    const [mined, sent] = await Promise.all([
      publicClient.getTransactionCount({ address: desk as ViemAddress, blockTag: "latest" }),
      publicClient.getTransactionCount({ address: desk as ViemAddress, blockTag: "pending" }),
    ]);
    return sent > mined;
  }
  const WAITING: DeskResult = { ok: false, reason: "busy", detail: "an earlier transaction from the desk is not confirmed yet" };

  function giveUsdc(to: string): Promise<DeskResult> {
    if (!isAddress(to, { strict: false })) return Promise.resolve({ ok: false, reason: "bad-address" });
    const lower = to.toLowerCase();
    if (lower === ZERO || lower === desk.toLowerCase() || lower === boomerang.toLowerCase() || lower === usdc.toLowerCase()) {
      return Promise.resolve({ ok: false, reason: "bad-address" });
    }
    return inTurn(() => give(to, lower));
  }

  async function give(to: string, lower: string): Promise<DeskResult> {
    const given = store.readNote<string[]>("demo-given") ?? [];
    if (given.some((a) => a.toLowerCase() === lower)) return { ok: false, reason: "already-given" };
    if (await unconfirmed()) return WAITING;
    if ((await balance()) < DEMO.floor + DEMO.usdc) return { ok: false, reason: "desk-low" };

    const call = { address: usdc, abi: tokenAbi as unknown as Abi, functionName: "transfer", args: [to as ViemAddress, DEMO.usdc] } as const;
    // Tried first without sending, then made ready without sending. A transfer the token would
    // refuse, or a node that cannot be reached, stops here with nothing sent and nothing recorded:
    // the address may simply ask again.
    let tx: Ready;
    try {
      await publicClient.simulateContract({ ...call, account: desk as ViemAddress });
      tx = await ready(call);
    } catch (e) {
      return { ok: false, reason: "failed", detail: short(e) };
    }

    // The address is recorded before the transfer leaves, and the record is undone only when it
    // is certain no money moved: the transfer was mined and reverted. A send that failed may
    // still have reached the node (a reply lost on the way back looks the same from here), and a
    // receipt may simply not have come; in both cases the record stays, so the address cannot be
    // paid twice.
    store.writeNote("demo-given", [...given, lower]);
    let hash: `0x${string}`;
    try {
      hash = await tx.send();
    } catch (e) {
      return { ok: false, reason: "unconfirmed", detail: short(e) };
    }
    let status: string;
    try {
      status = (await publicClient.waitForTransactionReceipt({ hash })).status;
    } catch (e) {
      return { ok: false, reason: "unconfirmed", detail: short(e), hash };
    }
    if (status !== "success") {
      store.writeNote("demo-given", given);
      return { ok: false, reason: "failed", detail: "transfer reverted", hash };
    }
    return { ok: true, hash };
  }

  let opening = false;
  // The last campaign this desk opened, or began to open (`id` null: its creation was sent and
  // the id is not known yet). The ledger learns of a campaign only when a delivery carries it;
  // this covers the moments before that. It is written to the store before the creation is sent,
  // so a restart at any moment does not open a second campaign beside it.
  type Last = { id: bigint | null; closesAt: bigint };
  let last: Last | null = null;
  const digits = (v: unknown): v is string => typeof v === "string" && /^[0-9]{1,30}$/.test(v);
  const kept = store.readNote<{ id?: unknown; closesAt?: unknown }>("demo-last");
  if (kept && (kept.id === null || digits(kept.id)) && digits(kept.closesAt)) {
    last = { id: kept.id === null ? null : BigInt(kept.id), closesAt: BigInt(kept.closesAt) };
  }
  function remember(next: Last | null): void {
    last = next;
    store.writeNote("demo-last", next === null ? null : { id: next.id === null ? null : next.id.toString(), closesAt: next.closesAt.toString() });
  }

  async function openCampaign(kind: DeskKind = "ten"): Promise<DeskResult> {
    // Only the kinds written above: the times never come from the asker.
    if (!Object.hasOwn(DESK_KINDS, kind)) return { ok: false, reason: "failed", detail: "no such kind of campaign" };
    if (opening) return { ok: false, reason: "busy" };
    opening = true;
    try {
      return await inTurn(() => open(DESK_KINDS[kind]));
    } finally {
      opening = false;
    }
  }

  async function open(times: { opensIn: bigint; earlyFor: bigint; openFor: bigint; linearWeight: boolean }): Promise<DeskResult> {
    const now = (await publicClient.getBlock()).timestamp;
    // A closing time further off than any campaign this desk opens is not one it wrote: ignored.
    if (last !== null && now < last.closesAt && last.closesAt <= now + LONGEST) {
      const known = last.id === null ? undefined : ledger().campaigns.get(last.id);
      if (known === undefined || known.outcome === Outcome.Open) return { ok: false, reason: "campaign-open" };
    }
    for (const c of ledger().campaigns.values()) {
      if (c.sponsor.toLowerCase() === desk.toLowerCase() && c.outcome === Outcome.Open && c.terms.closesAt > now) {
        return { ok: false, reason: "campaign-open" };
      }
    }
    if (await unconfirmed()) return WAITING;
    if ((await balance()) < DEMO.floor + DEMO.match + DEMO.pool) return { ok: false, reason: "desk-low" };

    // Send one transaction that is ready and wait for it; a receipt that came back reverted is a failure.
    const sendAndWait = async (label: string, tx: Ready) => {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: await tx.send() });
      if (receipt.status !== "success") throw new Error(`${label} reverted`);
      return receipt;
    };

    const opensAt = now + times.opensIn;
    const terms = {
      recipient,
      opensAt,
      earlyUntil: opensAt + times.earlyFor,
      closesAt: opensAt + times.openFor,
      target: DEMO.target,
      minPledge: DEMO.minPledge,
      matchAmount: DEMO.match,
      bonusPool: DEMO.pool,
      rateBps: DEMO.rateBps,
      linearWeight: times.linearWeight,
      bonusFromRecipient: false,
    };
    // Made ready first: if that fails, nothing was sent and nothing is remembered.
    let create: Ready;
    try {
      create = await ready({ address: boomerang, abi, functionName: "createCampaign", args: [terms] });
    } catch (e) {
      return { ok: false, reason: "failed", detail: short(e) };
    }
    remember({ id: null, closesAt: terms.closesAt });
    try {
      const createReceipt = await sendAndWait("createCampaign", create);
      // The id comes from the CampaignCreated event, never from campaignCount, so a campaign
      // created in a parallel block cannot be mistaken for this one.
      const created = decodeLogs(createReceipt.logs as RawLog[], boomerang).find((e) => e.name === "CampaignCreated");
      if (!created) throw new Error("no CampaignCreated event in receipt");
      const id = created.id;
      remember({ id, closesAt: terms.closesAt });

      await sendAndWait("approve", await ready({ address: usdc, abi: tokenAbi as unknown as Abi, functionName: "approve", args: [boomerang as ViemAddress, DEMO.match + DEMO.pool] }));
      await sendAndWait("fundMatch", await ready({ address: boomerang, abi, functionName: "fundMatch", args: [id] }));
      await sendAndWait("fundBonus", await ready({ address: boomerang, abi, functionName: "fundBonus", args: [id] }));

      return { ok: true, id: id.toString() };
    } catch (e) {
      // A campaign created but left half-funded simply goes void and the keeper returns the pot.
      return { ok: false, reason: "failed", detail: short(e) };
    }
  }

  return { address: desk, giveUsdc, openCampaign };
}
