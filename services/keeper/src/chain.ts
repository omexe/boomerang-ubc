// The sender: it turns a planned Action into a real contract call and waits for the receipt.
//
// It asks the contract first. The plan comes from the keeper's ledger, and the ledger is built
// from deliveries that someone feeding the keeper could forge. So before any gas
// is spent the sender reads the contract (free) and sends only a call the contract says will
// change something: a campaign that is still open and due, a side with money to pay, backers who
// are owed. Anything else comes back as `nothing`, with what the keeper needs to stop asking and
// with the outcome the contract shows, which the keeper sets above its ledger's.
// A revert or a thrown error comes back as { ok: false } with a short message and no secrets.
import type { Abi, PublicClient, WalletClient } from "viem";

import { boomerangAbi, type Address } from "../../../packages/kit/src/index.ts";
import type { Action } from "./plan.ts";
import type { Nothing, Sender, SendResult } from "./keeper.ts";

function short(e: unknown): string {
  const a = e as { shortMessage?: unknown; message?: unknown } | undefined;
  const m = (a && (a.shortMessage ?? a.message)) ?? e;
  return String(m).slice(0, 200);
}

// Did the contract itself refuse the call? viem files that as a ContractFunctionRevertedError
// somewhere in the error's chain of causes. It files a node's bare "internal error" (a nonce
// that is too low, say) under the same heading, so the heading is not enough: a refusal also
// carries the contract's own answer (revert data, a decoded error).
export function isRevert(e: unknown): boolean {
  const walk = (e as { walk?: unknown } | undefined)?.walk;
  if (typeof walk !== "function") return false;
  // Some nodes answer a refusal with no data at all, only the words "execution reverted"; viem
  // names that an ExecutionRevertedError. It gives the same name to "gas required exceeds
  // allowance", which is the sender's account being short of gas money, not the contract saying no.
  const said = (walk as (this: unknown, fn: (x: unknown) => boolean) => unknown).call(e, (x) => (x as { name?: unknown } | undefined)?.name === "ExecutionRevertedError") as
    | { message?: unknown; details?: unknown }
    | null
    | undefined;
  if (said !== null && said !== undefined) return !/gas required exceeds allowance/i.test(`${String(said.message ?? "")} ${String(said.details ?? "")}`);
  const hit = (walk as (this: unknown, fn: (x: unknown) => boolean) => unknown).call(
    e,
    (x) => (x as { name?: unknown } | undefined)?.name === "ContractFunctionRevertedError",
  ) as { raw?: unknown; data?: unknown; signature?: unknown } | null | undefined;
  if (hit === null || hit === undefined) return false;
  return (typeof hit.raw === "string" && hit.raw.length > 2) || hit.data !== undefined || typeof hit.signature === "string";
}

/**
 * A one-at-a-time runner. Everything the keeper's account sends (settlement calls, the demo
 * desk's transfers) goes through one of these, so two transactions never race for a nonce.
 */
export function makeQueue(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job);
    tail = run.catch(() => {});
    return run;
  };
}

const OPEN = 0;
const MISSED = 2;

// Did the contract answer a read with NoSuchCampaign?
function noSuchCampaign(e: unknown): boolean {
  const walk = (e as { walk?: unknown } | undefined)?.walk;
  if (typeof walk !== "function") return false;
  const hit = (walk as (this: unknown, fn: (x: unknown) => boolean) => unknown).call(
    e,
    (x) => (x as { name?: unknown } | undefined)?.name === "ContractFunctionRevertedError",
  ) as { data?: { errorName?: unknown } } | null | undefined;
  return hit?.data?.errorName === "NoSuchCampaign";
}
const NOT_SETTLED = "the contract does not show this campaign as settled yet";

export function makeSender(o: { publicClient: PublicClient; walletClient: WalletClient; boomerang: Address }): Sender {
  const abi = boomerangAbi as unknown as Abi;
  const { publicClient, walletClient, boomerang } = o;
  // The clients' overloads do not narrow well across several functions; each call's shape is
  // checked against the ABI at run time, so the methods are reached through loose locals.
  const write = walletClient.writeContract as unknown as (args: Record<string, unknown>) => Promise<`0x${string}`>;
  const read = publicClient.readContract as unknown as (args: Record<string, unknown>) => Promise<unknown>;
  const simulate = publicClient.simulateContract as unknown as (args: Record<string, unknown>) => Promise<{ result: unknown }>;

  const nothing = (why: string, n: Partial<Nothing> = {}): SendResult => ({
    ok: false,
    error: why,
    nothing: { final: false, hold: false, owedNothing: [], blocked: [], ...n },
  });

  return async (action: Action): Promise<SendResult> => {
    try {
      const base = { address: boomerang, abi, account: walletClient.account, chain: walletClient.chain };
      // Everything asked of the contract for one call is asked at one block: the node's newest,
      // asked for now. A viem client otherwise remembers the block number for some seconds, and
      // a remembered one can be from before the keeper's own last transaction.
      const at = { address: boomerang, abi, blockNumber: await publicClient.getBlockNumber({ cacheTime: 0 }) };
      let hash: `0x${string}`;
      let owedNothing: Address[] = [];

      // The ledger may name a campaign the contract does not have: a false event, or a node that
      // has not caught up with the chain's head. That is nothing to send, and not a refusal.
      let state: { outcome: number };
      try {
        state = (await read({ ...at, functionName: "stateOf", args: [action.id] })) as { outcome: number };
      } catch (e) {
        if (noSuchCampaign(e)) return nothing("the contract has no campaign with this number", { absent: true });
        throw e;
      }

      if (action.kind === "finalize") {
        if (state.outcome !== OPEN) return nothing("the contract has already set this campaign's outcome", { final: true, outcome: state.outcome });
        const now = (await read({ ...at, functionName: "outcomeNow", args: [action.id] })) as number;
        if (now === OPEN) return nothing("the contract says this campaign is not due yet", { outcome: OPEN });
        hash = await write({ ...base, functionName: "finalize", args: [action.id] });
      } else if (action.kind === "paySide") {
        // The plan names a side only after the ledger has heard the outcome. If the contract
        // does not show one, this node is behind the chain's head (or the event was false): ask later.
        if (state.outcome === OPEN) return nothing(NOT_SETTLED, { outcome: OPEN });
        // Reverts (refused) while the payee cannot be paid.
        const { result } = await simulate({ ...base, blockNumber: at.blockNumber, functionName: "paySide", args: [action.id, action.side] });
        if (result === 0n) return nothing("the contract has nothing to pay on that side", { final: true, outcome: state.outcome });
        hash = await write({ ...base, functionName: "paySide", args: [action.id, action.side] });
      } else {
        if (state.outcome === OPEN) return nothing(NOT_SETTLED, { outcome: OPEN });
        if (state.outcome !== MISSED) return nothing("the contract does not show this campaign as missed", { hold: true, outcome: state.outcome });
        const owed = (await Promise.all(action.backers.map((b) => read({ ...at, functionName: "owedTo", args: [action.id, b] })))) as (readonly [bigint, bigint])[];
        const owing = action.backers.filter((_, i) => owed[i][0] + owed[i][1] > 0n);
        owedNothing = action.backers.filter((_, i) => owed[i][0] + owed[i][1] === 0n);
        if (owing.length === 0) return nothing("the contract owes none of these backers anything", { owedNothing, outcome: MISSED });
        // A payee the token refuses is skipped by the contract, not reverted. If every payout
        // in the call would be skipped, sending it would only burn gas.
        const { result } = await simulate({ ...base, blockNumber: at.blockNumber, functionName: "payMany", args: [action.id, owing] });
        if (result === 0n) return nothing("none of these payouts would go through", { owedNothing, blocked: owing, outcome: MISSED });
        hash = await write({ ...base, functionName: "payMany", args: [action.id, owing] });
      }
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") return { ok: false, error: "transaction reverted", reverted: true };
      return owedNothing.length > 0 ? { ok: true, hash, owedNothing } : { ok: true, hash };
    } catch (e) {
      return isRevert(e) ? { ok: false, error: short(e), reverted: true } : { ok: false, error: short(e) };
    }
  };
}
