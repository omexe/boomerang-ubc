// What a page needs to pledge from another chain through Circle's CCTP V2: the arguments of the
// burn on the source chain, and a reader for the attested message, so the page can show what a
// message says before anyone relays it.
//
// The layouts are Circle's MessageV2 and BurnMessageV2 (read from Circle's published source).
// The router on Arc accepts exactly one shape of burn, and `checkForRouter` says why a message
// would be refused before any gas is spent on it.
import { decodeAbiParameters, encodeAbiParameters, pad, size, slice } from "viem";

import type { Address } from "./types.ts";

type Hex = `0x${string}`;

/** Arc's CCTP domain. */
export const ARC_DOMAIN = 26;

/** The one function of Circle's TokenMessengerV2 a source-chain page calls. */
export const burnAbi = [
  {
    type: "function",
    name: "depositForBurnWithHook",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

/** An address as CCTP writes it: left-padded to 32 bytes. */
export function asBytes32(address: Address): Hex {
  return pad(address, { size: 32 });
}

/** The hook data the router expects: exactly `abi.encode(uint256 campaignId, address backer)`. */
export function pledgeHook(campaignId: bigint, backer: Address): Hex {
  return encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [campaignId, backer]);
}

/**
 * The arguments of `depositForBurnWithHook` for a pledge. The router is named as the mint's
 * recipient AND as the only allowed caller: without the second, anyone could receive the mint
 * around the router and the money would sit in it with no pledge made.
 */
export function burnArgs(o: {
  amount: bigint;
  sourceUsdc: Address;
  router: Address;
  campaignId: bigint;
  backer: Address;
  maxFee: bigint;
  minFinalityThreshold: number;
}): readonly [bigint, number, Hex, Address, Hex, bigint, number, Hex] {
  return [
    o.amount,
    ARC_DOMAIN,
    asBytes32(o.router),
    o.sourceUsdc,
    asBytes32(o.router),
    o.maxFee,
    o.minFinalityThreshold,
    pledgeHook(o.campaignId, o.backer),
  ];
}

/** The fields of an attested CCTP V2 burn message that matter to a pledge. */
export type Burn = {
  sourceDomain: number;
  destinationDomain: number;
  nonce: Hex;
  /** The contract on the destination chain the message is addressed to (Circle's token messenger). */
  recipient: Hex;
  destinationCaller: Hex;
  mintRecipient: Hex;
  amount: bigint;
  feeExecuted: bigint;
  expirationBlock: bigint;
  hookData: Hex;
};

const HEADER = 148;
const BURN_FIXED = 228;

/** Read a message's fields. Null if it is too short to be a V2 burn message. */
export function readBurn(message: Hex): Burn | null {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(message) || size(message) < HEADER + BURN_FIXED) return null;
  const at = (start: number, length: number) => slice(message, start, start + length);
  const u32 = (start: number) => Number(BigInt(at(start, 4)));
  const u256 = (start: number) => BigInt(at(start, 32));
  return {
    sourceDomain: u32(4),
    destinationDomain: u32(8),
    nonce: at(12, 32),
    recipient: at(76, 32),
    destinationCaller: at(108, 32),
    mintRecipient: at(HEADER + 36, 32),
    amount: u256(HEADER + 68),
    feeExecuted: u256(HEADER + 164),
    expirationBlock: u256(HEADER + 196),
    hookData: size(message) > HEADER + BURN_FIXED ? slice(message, HEADER + BURN_FIXED) : "0x",
  };
}

export type RouterCheck =
  | { ok: true; campaignId: bigint; backer: Address; arrives: bigint }
  | { ok: false; why: "not-a-burn" | "not-for-arc" | "not-for-messenger" | "not-for-router" | "bad-hook" | "open-to-anyone" };

/**
 * Would the router take this message? Mirrors the router's own checks, plus two it cannot make
 * for the sender: the message must be bound for Arc, and it should name the router as the only
 * caller (a message that does not can be received around the router by anyone).
 */
export function checkForRouter(message: Hex, o: { router: Address; messenger: Address }): RouterCheck {
  const b = readBurn(message);
  if (b === null) return { ok: false, why: "not-a-burn" };
  if (b.destinationDomain !== ARC_DOMAIN) return { ok: false, why: "not-for-arc" };
  const same = (x: Hex, a: Address) => x.toLowerCase() === asBytes32(a).toLowerCase();
  if (!same(b.recipient, o.messenger)) return { ok: false, why: "not-for-messenger" };
  if (!same(b.mintRecipient, o.router)) return { ok: false, why: "not-for-router" };
  if (size(b.hookData) !== 64) return { ok: false, why: "bad-hook" };
  const [campaignId, rawBacker] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], b.hookData);
  if (rawBacker === 0n || rawBacker >> 160n !== 0n || same(asBytes32(`0x${rawBacker.toString(16).padStart(40, "0")}`), o.router)) {
    return { ok: false, why: "bad-hook" };
  }
  if (!same(b.destinationCaller, o.router)) return { ok: false, why: "open-to-anyone" };
  const backer = `0x${rawBacker.toString(16).padStart(40, "0")}` as Address;
  return { ok: true, campaignId, backer, arrives: b.amount - b.feeExecuted };
}
