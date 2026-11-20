// The one-signature pledge: what the wallet is asked to sign, and the body the keeper is sent.
// The backer signs Circle's ReceiveWithAuthorization on USDC: from the backer, payable only to
// SignedPledge, for the amount the campaign will take, with a nonce that binds this campaign and
// this amount. The keeper submits it and pays the gas; nobody who sees the signature can move the
// money anywhere else.
import { AUTHORIZATION_TYPES, nonceFor, USDC_DOMAIN, type Address } from "../../../packages/kit/src/index.ts";

export const SIGNED = {
  /**
   * How long a signature stays valid: three minutes, or until the campaign closes if that is
   * sooner. Short, because when the keeper gives no answer the page waits for it to run out before
   * offering the two-step pledge: a keeper that was only slow could otherwise still send it.
   */
  window: 180n,
  /** How far back its window starts, so a chain clock a little behind the page's read still counts it begun. */
  slack: 60n,
} as const;

type Hex = `0x${string}`;

/** The typed data for the wallet, and the window and nonce it carries. `now` is the chain's time as last read. */
export function authorization(o: { chainId: number; usdc: Address; helper: Address; backer: Address; id: bigint; amount: bigint; now: bigint; closesAt: bigint; salt: Hex }) {
  const validAfter = o.now - SIGNED.slack;
  const validBefore = o.closesAt < o.now + SIGNED.window ? o.closesAt : o.now + SIGNED.window;
  const nonce = nonceFor(o.id, o.amount, o.salt);
  const typed = {
    domain: { ...USDC_DOMAIN, chainId: o.chainId, verifyingContract: o.usdc },
    types: AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization" as const,
    message: { from: o.backer, to: o.helper, value: o.amount, validAfter, validBefore, nonce },
  };
  return { typed, validAfter, validBefore, nonce };
}

/** The body POST /relay takes: every number as a decimal string. */
export function relayBody(o: { id: bigint; backer: Address; amount: bigint; validAfter: bigint; validBefore: bigint; salt: Hex; signature: Hex }): Record<string, string> {
  return {
    id: o.id.toString(),
    backer: o.backer,
    amount: o.amount.toString(),
    validAfter: o.validAfter.toString(),
    validBefore: o.validBefore.toString(),
    salt: o.salt,
    signature: o.signature,
  };
}

/** A fresh 32-byte salt, so two signatures for the same campaign and amount have different nonces. */
export function newSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}
