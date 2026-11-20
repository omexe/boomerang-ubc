// A pledge from another chain, in three moves: burn USDC there with Circle's CCTP, wait for
// Circle's attestation, relay the attested message to the router on Arc. Anyone may make the
// third move, so a pledge is never stuck behind this page.
//
// Circle's attestation service ("Iris") is read through an injected `fetch`, so these
// functions are tested without the network. Endpoints and field names are from Circle's API
// reference as read on 2026-11-15: GET /v2/burn/USDC/fees/{source}/{destination} and
// GET /v2/messages/{source}?transactionHash=…
import type { Abi } from "viem";

import type { Address } from "../../../packages/kit/src/index.ts";
import { ARC_DOMAIN, burnAbi, burnArgs, checkForRouter, routerAbi } from "../../../packages/kit/src/index.ts";
import { tokenAbi, type Call } from "./calls.ts";

type Hex = `0x${string}`;
type Fetch = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;

/** Circle's attestation service for testnets. */
export const IRIS_SANDBOX = "https://iris-api-sandbox.circle.com";

/** CCTP's two speeds, as the `minFinalityThreshold` of a burn. */
export const FAST = 1000;
export const STANDARD = 2000;

/** The fee rate Circle asks for each speed on a route, in basis points (1 = 0.01%); null if not offered. */
export async function fetchFeeRates(o: { fetch: Fetch; base?: string; sourceDomain: number }): Promise<{ fast: number | null; standard: number | null }> {
  const res = await o.fetch(`${o.base ?? IRIS_SANDBOX}/v2/burn/USDC/fees/${o.sourceDomain}/${ARC_DOMAIN}`);
  if (res.status !== 200) throw new Error(`Circle's fee service answered ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error("Circle's fee service answered in a shape this page does not know");
  const rate = (threshold: number) => {
    const row = rows.find((r) => r && typeof r === "object" && (r as { finalityThreshold?: unknown }).finalityThreshold === threshold);
    const fee = row && (row as { minimumFee?: unknown }).minimumFee;
    return typeof fee === "number" && Number.isFinite(fee) && fee >= 0 ? fee : null;
  };
  return { fast: rate(FAST), standard: rate(STANDARD) };
}

/**
 * The most a burn of `amount` agrees to pay at `bps`, rounded up, with a fifth added in case
 * the rate moves before the burn lands. Never as much as the amount itself.
 */
export function maxFeeFor(amount: bigint, bps: number): bigint {
  if (amount <= 0n || !(bps > 0)) return 0n;
  const scaled = BigInt(Math.ceil(bps * 10_000)); // rates may carry a fraction of a basis point
  const fee = (amount * scaled + 99_999_999n) / 100_000_000n;
  const withRoom = fee + (fee + 4n) / 5n;
  return withRoom >= amount ? amount - 1n : withRoom;
}

/** The calls on the source chain: an exact approval when needed, then the burn that names the router. */
export function burnCalls(o: {
  sourceUsdc: Address;
  sourceMessenger: Address;
  router: Address;
  campaignId: bigint;
  backer: Address;
  amount: bigint;
  allowance: bigint;
  maxFee: bigint;
  speed: typeof FAST | typeof STANDARD;
}): Call[] {
  const calls: Call[] = [];
  if (o.allowance < o.amount) {
    calls.push({ label: "Allow Circle's bridge to take this pledge", to: o.sourceUsdc, abi: tokenAbi as unknown as Abi, functionName: "approve", args: [o.sourceMessenger, o.amount] });
  }
  calls.push({
    label: "Send the pledge to Arc",
    to: o.sourceMessenger,
    abi: burnAbi as unknown as Abi,
    functionName: "depositForBurnWithHook",
    args: burnArgs({ amount: o.amount, sourceUsdc: o.sourceUsdc, router: o.router, campaignId: o.campaignId, backer: o.backer, maxFee: o.maxFee, minFinalityThreshold: o.speed }),
  });
  return calls;
}

export type Attestation =
  | { state: "waiting"; why: "not-seen-yet" | "confirming" | string }
  | { state: "ready"; message: Hex; attestation: Hex; campaignId: bigint; backer: Address; arrives: bigint }
  | { state: "wrong"; why: string };

const isHex = (v: unknown): v is Hex => typeof v === "string" && /^0x([0-9a-fA-F]{2})+$/.test(v);

/**
 * Ask Circle for the attested message of a burn. Of the messages in that transaction, only one
 * the router would take counts; a transaction with attested messages and none for the router
 * is "wrong", not "waiting".
 */
export async function fetchAttestation(o: { fetch: Fetch; base?: string; sourceDomain: number; txHash: Hex; router: Address; messenger: Address }): Promise<Attestation> {
  const res = await o.fetch(`${o.base ?? IRIS_SANDBOX}/v2/messages/${o.sourceDomain}?transactionHash=${o.txHash}`);
  if (res.status === 404) return { state: "waiting", why: "not-seen-yet" };
  if (res.status !== 200) throw new Error(`Circle's attestation service answered ${res.status}`);
  const body = (await res.json()) as { messages?: unknown };
  if (!body || !Array.isArray(body.messages)) throw new Error("Circle's attestation service answered in a shape this page does not know");
  let pending: string | null = body.messages.length === 0 ? "not-seen-yet" : null;
  let refused: string | null = null;
  for (const m of body.messages as { message?: unknown; attestation?: unknown; status?: unknown; delayReason?: unknown }[]) {
    if (!m || typeof m !== "object") continue;
    if (m.status !== "complete" || !isHex(m.attestation) || !isHex(m.message)) {
      pending = typeof m.delayReason === "string" && m.delayReason ? m.delayReason : "confirming";
      continue;
    }
    const check = checkForRouter(m.message, { router: o.router, messenger: o.messenger });
    if (check.ok) return { state: "ready", message: m.message, attestation: m.attestation, campaignId: check.campaignId, backer: check.backer, arrives: check.arrives };
    refused = check.why;
  }
  if (pending !== null) return { state: "waiting", why: pending };
  return { state: "wrong", why: refused ?? "no message" };
}

/** Ask again every `everyMs` until the attestation is ready, the message proves wrong, or time runs out. */
export async function waitForAttestation(
  o: Parameters<typeof fetchAttestation>[0] & { everyMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; onTick?: (a: Attestation, waitedMs: number) => void },
): Promise<Extract<Attestation, { state: "ready" }>> {
  const every = o.everyMs ?? 5_000;
  const limit = o.timeoutMs ?? 30 * 60_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  for (let waited = 0; ; waited += every) {
    let a: Attestation;
    try {
      a = await fetchAttestation(o);
    } catch (e) {
      a = { state: "waiting", why: e instanceof Error ? e.message : String(e) }; // a failed ask is asked again
    }
    o.onTick?.(a, waited);
    if (a.state === "ready") return a;
    if (a.state === "wrong") throw new Error(`This transaction's message is not a pledge the router takes (${a.why}).`);
    if (waited >= limit) throw new Error("Circle has not attested this burn yet. It can be relayed later by anyone; nothing is lost.");
    await sleep(every);
  }
}

/** The call on Arc that turns the attested message into a pledge. Anyone may send it. */
export function relayCall(o: { router: Address; message: Hex; attestation: Hex }): Call {
  return { label: "Deliver the pledge on Arc", to: o.router, abi: routerAbi as unknown as Abi, functionName: "relay", args: [o.message, o.attestation] };
}
