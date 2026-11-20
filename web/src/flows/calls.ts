// The contract calls the page makes, as plain lists, and one way to send them.
//
// A list is built without touching the chain, so the same list can be sent one call at a time
// from an ordinary wallet (here) or as one batch from a passkey smart account.
import type { Abi, Account, PublicClient, WalletClient } from "viem";

import type { Address } from "../../../packages/kit/src/index.ts";
import { boomerangAbi } from "../../../packages/kit/src/index.ts";

export type Call = { label: string; to: Address; abi: Abi; functionName: string; args: readonly unknown[] };

const tokenAbi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
export { tokenAbi };

const boomerang = boomerangAbi as unknown as Abi;

/**
 * A pledge: an approval when the current allowance is short, then the pledge. The approval is for
 * `taken`, what the contract will take (never more than the campaign still needs), so typing more
 * than that leaves no allowance standing; without `taken` it is for the amount.
 */
export function pledgeCalls(o: { boomerang: Address; usdc: Address; id: bigint; amount: bigint; allowance: bigint; taken?: bigint }): Call[] {
  const calls: Call[] = [];
  const need = o.taken !== undefined && o.taken < o.amount ? o.taken : o.amount;
  if (o.allowance < need) {
    calls.push({ label: "Allow the campaign contract to take this pledge", to: o.usdc, abi: tokenAbi as unknown as Abi, functionName: "approve", args: [o.boomerang, need] });
  }
  calls.push({ label: "Pledge", to: o.boomerang, abi: boomerang, functionName: "pledge", args: [o.id, o.amount] });
  return calls;
}

/** Settle a campaign whose time has come. Anyone may send this. */
export function finalizeCall(o: { boomerang: Address; id: bigint }): Call {
  return { label: "Settle the campaign", to: o.boomerang, abi: boomerang, functionName: "finalize", args: [o.id] };
}

/** Send one backer what a missed campaign owes them. Anyone may send this; it pays only the backer. */
export function payCall(o: { boomerang: Address; id: bigint; backer: Address }): Call {
  return { label: "Send the refund", to: o.boomerang, abi: boomerang, functionName: "pay", args: [o.id, o.backer] };
}

/**
 * Pay one side of a settled campaign: 0 the recipient, 1 the match back to the sponsor, 2 the
 * unpaid bonus back to whoever locked it. Anyone may send this; it pays only the address the
 * contract names, and nothing when nothing is owed.
 */
export function paySideCall(o: { boomerang: Address; id: bigint; side: 0 | 1 | 2; label: string }): Call {
  return { label: o.label, to: o.boomerang, abi: boomerang, functionName: "paySide", args: [o.id, o.side] };
}

/** Point a backer's own refund at another address. Only the backer may send this. */
export function redirectCall(o: { boomerang: Address; id: bigint; to: Address }): Call {
  return { label: "Change where the refund goes", to: o.boomerang, abi: boomerang, functionName: "redirect", args: [o.id, o.to] };
}

/**
 * A one-at-a-time gate. `run(job)` starts the job unless one started through this gate is still
 * under way; then it starts nothing and answers null. The page sends through one, so a second
 * click, or a second submit whose check comes back late, cannot send the same calls twice.
 */
export function oneAtATime(): <T>(job: () => Promise<T>) => Promise<T | null> {
  let busy = false;
  return async <T>(job: () => Promise<T>): Promise<T | null> => {
    if (busy) return null;
    busy = true;
    try {
      return await job();
    } finally {
      busy = false;
    }
  };
}

export type Step = { index: number; label: string; state: "asking" | "sent" | "done"; hash?: `0x${string}` };

/**
 * Send calls one at a time from an ordinary wallet. Each is tried against the chain first, so a
 * call the contract would refuse stops here with the contract's own error and costs nothing;
 * each is waited for before the next is sent. Returns the transaction hashes in order.
 */
export async function sendEach(o: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account | Address;
  calls: readonly Call[];
  onStep?: (step: Step) => void;
}): Promise<`0x${string}`[]> {
  const hashes: `0x${string}`[] = [];
  for (const [index, call] of o.calls.entries()) {
    o.onStep?.({ index, label: call.label, state: "asking" });
    const { request } = await o.publicClient.simulateContract({
      account: o.account,
      address: call.to,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args as unknown[],
    });
    const hash = await o.walletClient.writeContract(request as Parameters<WalletClient["writeContract"]>[0]);
    o.onStep?.({ index, label: call.label, state: "sent", hash });
    const receipt = await o.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`"${call.label}" was mined but failed`);
    o.onStep?.({ index, label: call.label, state: "done", hash });
    hashes.push(hash);
  }
  return hashes;
}
