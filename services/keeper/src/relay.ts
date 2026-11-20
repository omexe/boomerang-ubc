// The relay: a backer signs Circle's ReceiveWithAuthorization once in the page, and the keeper
// submits it through SignedPledge and pays the gas. What the signature allows is fixed by the
// signature itself (this campaign, this amount, payable only to the helper, inside its window),
// so the keeper adds no power over the backer's money; what it guards is its own gas.
//
// Before anything is sent: the body is read strictly; the signer is recovered off-chain and must
// be the backer; one request per backer at a time and at most five sends per backer per hour;
// at most ten waiting; a window that has begun, has at least half a minute left and ends at
// most fifteen minutes from now; the keeper above its floor; and the call tried with eth_call, first outside
// the keeper's send line (so a junk signature never holds settlement back) and again inside it,
// with at most sixty requests a minute from all backers reaching the chain at all, and twenty
// being checked at once. A request that waited in line longer than ten seconds is turned away
// unsent, so most answers come back inside the page's twenty seconds. The page does not rely on
// it: a signature with no answer is waited out to the end of its window before any other pledge.
//
// Stated limit: the per-minute budget is shared, and refused requests spend it too, so one
// sender with empty keys can keep it used up; real backers then get "busy" and pledge in two
// steps, which needs no keeper. A limit per sending address belongs to the proxy in front.
import { encodeFunctionData, isAddress, parseSignature, recoverTypedDataAddress, type Abi, type Address as ViemAddress, type PublicClient, type WalletClient } from "viem";

import { AUTHORIZATION_TYPES, boomerangAbi, nonceFor, USDC_DOMAIN, type Address } from "../../../packages/kit/src/index.ts";
import { isRevert, makeQueue } from "./chain.ts";

export const RELAY = {
  maxWindow: 900n, // seconds a signature may stay valid, counted from now
  minLeft: 30n, // seconds it must still have, so it cannot expire on its way to a block
  perHour: 5,
  hour: 3_600n,
  maxWaiting: 10,
  startWithin: 10n, // seconds a request may wait in line before it is turned away unsent
  perMinute: 60, // requests a minute, from all backers together, that may reach the chain at all
  maxChecking: 20, // requests being checked against the chain at one moment, outside the send line
  floor: 3_000_000n, // the keeper's own USDC (Arc's gas) below which it relays nothing
  maxBody: 2_048,
} as const;

// Every reason but "failed" is given before anything could have been sent. "unavailable": the
// chain could not be read, or the call not made ready, so nothing was sent. "failed": the call was
// handed to the node, so it may still land.
export type RelayReason = "bad-request" | "bad-signature" | "window" | "pending" | "cap" | "refused" | "keeper-low" | "busy" | "unavailable" | "failed";
export type RelayResult = { ok: true; hash: `0x${string}` } | { ok: false; reason: RelayReason; detail?: string; hash?: `0x${string}` };
export type Relay = { address: Address; relay(body: unknown): Promise<RelayResult> };

const signedPledgeAbi = [
  {
    type: "function",
    name: "pledgeSigned",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "backer", type: "address" },
      { name: "amount", type: "uint256" },
      {
        name: "a",
        type: "tuple",
        components: [
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "salt", type: "bytes32" },
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
      },
    ],
    outputs: [{ name: "taken", type: "uint256" }],
  },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "Reentered", inputs: [] },
  { type: "error", name: "TokenFailed", inputs: [] },
] as const satisfies Abi;

// The helper's own calls plus Boomerang's errors, so a refused pledge names its reason.
const abi = [...signedPledgeAbi, ...(boomerangAbi as unknown as Abi).filter((x) => (x as { type?: string }).type === "error")] as Abi;

const tokenAbi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] }] as const satisfies Abi;

type Request = { id: bigint; backer: Address; amount: bigint; validAfter: bigint; validBefore: bigint; salt: `0x${string}`; signature: `0x${string}` };

const MAX_UINT = (1n << 256n) - 1n;
const uint = (v: unknown, positive = false): bigint | null => {
  if (typeof v !== "string" || !/^[0-9]{1,78}$/.test(v)) return null;
  const n = BigInt(v);
  return n > MAX_UINT || (positive && n === 0n) ? null : n;
};

/** The body as the page sends it, or null when any field is missing or malformed. */
export function readRequest(body: unknown): Request | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const id = uint(b.id);
  const amount = uint(b.amount, true);
  const validAfter = uint(b.validAfter);
  const validBefore = uint(b.validBefore);
  if (id === null || amount === null || validAfter === null || validBefore === null) return null;
  if (typeof b.backer !== "string" || !isAddress(b.backer, { strict: false }) || /^0x0{40}$/i.test(b.backer)) return null;
  if (typeof b.salt !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(b.salt)) return null;
  if (typeof b.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(b.signature)) return null;
  return { id, amount, validAfter, validBefore, backer: b.backer as Address, salt: b.salt as `0x${string}`, signature: b.signature as `0x${string}` };
}

function short(e: unknown): string {
  const a = e as { shortMessage?: unknown; message?: unknown } | undefined;
  const m = (a && (a.shortMessage ?? a.message)) ?? e;
  return String(m).slice(0, 200);
}

export function createRelay(o: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  signedPledge: Address;
  usdc: Address;
  // The keeper's one send line, shared with settlement and the desk.
  queue?: <T>(job: () => Promise<T>) => Promise<T>;
  // Whole seconds on the keeper's own clock; used for the hourly cap and the wait in line.
  timer?: () => bigint;
  floor?: bigint;
  perMinute?: number;
}): Relay {
  const { publicClient, walletClient, signedPledge, usdc } = o;
  const keeper = walletClient.account!.address as Address;
  const account = walletClient.account;
  const chain = walletClient.chain;
  const prepare = walletClient.prepareTransactionRequest as unknown as (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  const sendPrepared = walletClient.sendTransaction as unknown as (args: Record<string, unknown>) => Promise<`0x${string}`>;
  const queue = o.queue ?? makeQueue();
  const timer = o.timer ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  const floor = o.floor ?? RELAY.floor;
  let chainId: Promise<number> | null = null;
  const chainIdOf = () => (chainId ??= publicClient.chain?.id !== undefined ? Promise.resolve(publicClient.chain.id) : publicClient.getChainId());

  const perMinute = o.perMinute ?? RELAY.perMinute;
  const pending = new Set<string>();
  const sends = new Map<string, bigint[]>();
  let lately: bigint[] = []; // when requests reached the chain, from all backers, over the last minute
  let checking = 0;
  let waiting = 0;

  function recent(who: string, now: bigint): bigint[] {
    const kept = (sends.get(who) ?? []).filter((t) => now - t < RELAY.hour);
    if (kept.length === 0) sends.delete(who);
    else sends.set(who, kept);
    return kept;
  }

  async function relay(body: unknown): Promise<RelayResult> {
    const q = readRequest(body);
    if (q === null) return { ok: false, reason: "bad-request" };
    const nonce = nonceFor(q.id, q.amount, q.salt);
    let signer: string;
    try {
      signer = await recoverTypedDataAddress({
        domain: { ...USDC_DOMAIN, chainId: await chainIdOf(), verifyingContract: usdc as ViemAddress },
        types: AUTHORIZATION_TYPES,
        primaryType: "ReceiveWithAuthorization",
        message: { from: q.backer as ViemAddress, to: signedPledge as ViemAddress, value: q.amount, validAfter: q.validAfter, validBefore: q.validBefore, nonce },
        signature: q.signature,
      });
    } catch {
      return { ok: false, reason: "bad-signature" };
    }
    const who = q.backer.toLowerCase();
    if (signer.toLowerCase() !== who) return { ok: false, reason: "bad-signature" };

    // From here to the marks there is no await, so two requests for one backer cannot both pass,
    // and the limits on all backers together are counted exactly.
    if (pending.has(who)) return { ok: false, reason: "pending" };
    const arrived = timer();
    if (recent(who, arrived).length >= RELAY.perHour) return { ok: false, reason: "cap" };
    lately = lately.filter((t) => arrived - t < 60n);
    if (lately.length >= perMinute || checking >= RELAY.maxChecking || waiting >= RELAY.maxWaiting) return { ok: false, reason: "busy" };
    lately.push(arrived);
    pending.add(who);
    checking += 1;
    try {
      // Checked against the chain before it takes a place in the send line, which settlement
      // shares: a signature from an empty account, or for a pledge the campaign would refuse,
      // never holds a real backer or a settlement call back.
      let first: RelayResult | null;
      try {
        first = await check(q);
      } finally {
        checking -= 1;
      }
      if (first !== null) return first;
      waiting += 1;
      try {
        return await queue(() => submit(q, who, arrived));
      } finally {
        waiting -= 1;
      }
    } catch (e) {
      return { ok: false, reason: "unavailable", detail: short(e) };
    } finally {
      pending.delete(who);
    }
  }

  const authOf = (q: Request) => {
    const { v, r, s, yParity } = parseSignature(q.signature);
    return { validAfter: q.validAfter, validBefore: q.validBefore, salt: q.salt, v: Number(v ?? BigInt(yParity + 27)), r, s };
  };
  const callOf = (q: Request) => ({ address: signedPledge, abi, functionName: "pledgeSigned", args: [q.id, q.backer, q.amount, authOf(q)] }) as const;

  // The window by the chain's latest block, then the call tried with eth_call. Null: go on.
  // Nothing here sends; a fault reading the chain answers "unavailable".
  async function check(q: Request): Promise<RelayResult | null> {
    let now: bigint;
    try {
      now = (await publicClient.getBlock()).timestamp;
    } catch (e) {
      return { ok: false, reason: "unavailable", detail: short(e) };
    }
    if (!(q.validAfter < now && now + RELAY.minLeft < q.validBefore && q.validBefore - now <= RELAY.maxWindow)) return { ok: false, reason: "window" };
    try {
      await publicClient.simulateContract({ ...callOf(q), account: keeper as ViemAddress });
    } catch (e) {
      return { ok: false, reason: isRevert(e) ? "refused" : "unavailable", detail: short(e) };
    }
    return null;
  }

  async function submit(q: Request, who: string, arrived: bigint): Promise<RelayResult> {
    if (timer() - arrived > RELAY.startWithin) return { ok: false, reason: "busy", detail: "waited too long in line; nothing was sent" };
    let request: Record<string, unknown>;
    try {
      const [mined, sent] = await Promise.all([
        publicClient.getTransactionCount({ address: keeper as ViemAddress, blockTag: "latest" }),
        publicClient.getTransactionCount({ address: keeper as ViemAddress, blockTag: "pending" }),
      ]);
      if (sent > mined) return { ok: false, reason: "busy", detail: "an earlier transaction from the keeper is not confirmed yet" };
      const held = (await publicClient.readContract({ address: usdc, abi: tokenAbi, functionName: "balanceOf", args: [keeper as ViemAddress] })) as bigint;
      if (held < floor) return { ok: false, reason: "keeper-low" };
      // Tried again in the line, against the chain as it is now: the window and the campaign may have moved.
      const again = await check(q);
      if (again !== null) return again;
      const call = callOf(q);
      request = await prepare({ account, chain, to: signedPledge, data: encodeFunctionData({ abi, functionName: "pledgeSigned", args: call.args as unknown as unknown[] }) });
    } catch (e) {
      return { ok: false, reason: "unavailable", detail: short(e) };
    }

    // Counted against the backer's hour once it may have left, whatever the answer.
    sends.set(who, [...recent(who, timer()), timer()]);
    let hash: `0x${string}`;
    try {
      hash = await sendPrepared(request);
    } catch (e) {
      return { ok: false, reason: "failed", detail: short(e) };
    }
    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") return { ok: false, reason: "failed", detail: "the pledge reverted", hash };
    } catch (e) {
      return { ok: false, reason: "failed", detail: short(e), hash };
    }
    return { ok: true, hash };
  }

  return { address: signedPledge, relay };
}
