// The practice wallet's words. It is a key this page makes and keeps in this browser so that a
// visitor without a wallet can try a pledge with test money; every sentence about it says so.
import type { Address } from "../../../packages/kit/src/index.ts";
import { short } from "../data/keeper.ts";

export const PRACTICE = {
  /** The wallet's name, in the bar and wherever it signs. */
  name: "Practice wallet",
  button: "Try it with a practice wallet",
  note: "No wallet needed. This page keeps a key in this browser, and the site's desk gives a new one 2.00 test USDC. It is for test money only.",
  /** While the key is being made and the desk asked. */
  busy: "Setting up a practice wallet and asking the desk for 2.00 USDC…",
  /** The bar's button for a visitor who has a wallet of their own and is using the practice one. */
  own: "Use my own wallet",
  /** In place of "Sign the pledge in your wallet". */
  signing: "The practice wallet is signing the pledge. A signature costs no gas.",
  /** In place of "One signature in your wallet, no gas". */
  oneSignature: "The practice wallet signs it and the keeper sends it, so it costs no gas.",
} as const;

/** The offer of a practice wallet, shown where nobody is connected. Null when it is not on offer. */
export function practiceOffer(o: { account: Address | null; offered: boolean; busy: boolean }): { button: string; note: string; busy: boolean } | null {
  if (o.account !== null || !o.offered) return null;
  return { button: PRACTICE.button, note: PRACTICE.note, busy: o.busy };
}

/** The account as the bar shows it while the practice wallet is in use: "Practice wallet 0x12ab…cd34". */
export function practiceAccount(account: Address): string {
  return `${PRACTICE.name} ${short(account)}`;
}

/** What the notices say once the practice wallet is set up: the desk's own answer when it was asked, in the page's words. */
export function practiceResult(o: { asked: boolean; desk: { ok: boolean; line: string } | null }): { ok: boolean; line: string } | null {
  if (!o.asked) return null; // a wallet from an earlier visit: it is simply in use again
  if (o.desk === null) return { ok: false, line: "The practice wallet is ready, but the desk could not be asked for USDC. Its balance is empty until it is given some." };
  return o.desk.ok
    ? { ok: true, line: "The practice wallet is ready, and the desk sent it 2.00 USDC. Type an amount and pledge." }
    : { ok: false, line: `The practice wallet is ready, but it has no USDC yet. ${o.desk.line}` };
}
