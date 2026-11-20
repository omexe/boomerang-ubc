// The Pledge page: what the form says and whether it may send, worked out from what was typed
// and what was read from the contract. The page component only lays this out and sends the calls.
import type { Address } from "../../../packages/kit/src/index.ts";
import { quotePledge, type PledgeQuote } from "../data/campaign.ts";
import type { CampaignView } from "../data/load.ts";
import { CENT, formatUsd, parseUsd } from "../data/money.ts";
import { pledgeCalls, type Call } from "../flows/calls.ts";
import { PRACTICE } from "./practice.ts";

/** The contract's own reply to `quoteIfMissed(id, amount)`. */
export type Answer = { wouldFund: boolean; counted: bigint; bonus: bigint };

export type PledgeForm = {
  /** What was typed, as millionths of a dollar; null when it is not an amount. */
  amount: bigint | null;
  quote: PledgeQuote | null;
  /** The sentence under the amount. */
  line: string;
  /** Whether that sentence is the contract's own answer or this page's arithmetic while the answer is on its way. */
  source: "contract" | "estimate" | "none";
  /** What stands in the way, most important first; empty when the pledge can be sent. */
  blocks: string[];
  canSend: boolean;
  button: string;
  /** The wallet requests the pledge will make, in order; empty until it can be sent. */
  calls: Call[];
};

const NO_WALLET = "To pledge you need a wallet with USDC on Arc Testnet, and this browser has none. Everything else here can be read without one.";

export function pledgeForm(o: {
  campaign: CampaignView;
  where: { boomerang: Address; usdc: Address };
  amountText: string;
  now: bigint;
  /** The connected account, its USDC balance and what it has already allowed the contract to take; null while unknown. */
  account: Address | null;
  balance: bigint | null;
  allowance: bigint | null;
  onRightChain: boolean;
  /** The contract's answer for exactly this amount, if it has arrived. */
  answer: Answer | null;
  /** Whether this browser has any wallet at all. Without one, the form does not offer to connect. */
  hasWallet?: boolean;
  /** Whether a practice wallet is on offer. With no wallet in the browser it is then what the form's button starts. */
  practice?: boolean;
  /** USDC the account must keep for gas when it sends the pledge itself on a chain where gas is paid in USDC (Arc). Zero when the keeper sends it, or elsewhere. */
  gasReserve?: bigint;
}): PledgeForm {
  const hasWallet = o.hasWallet ?? true;
  const reserve = o.gasReserve ?? 0n;
  const { terms: t, state: s } = o.campaign;
  const typed = o.amountText.trim();
  const amount = typed === "" ? null : parseUsd(typed);
  if (amount === null) {
    const line = typed === "" ? "Enter an amount." : "That is not an amount. Use digits, like 25 or 25.50.";
    return { amount: null, quote: null, line, source: "none", blocks: [line], canSend: false, button: "Pledge", calls: [] };
  }
  const isSponsor = o.account !== null && o.account.toLowerCase() === s.sponsor.toLowerCase();
  const quote = quotePledge(t, s, amount, o.now, { isSponsor, answer: o.answer ?? undefined });
  const taken = quote.kind === "refused" ? 0n : quote.counted;

  const blocks: string[] = [];
  if (quote.kind === "refused") blocks.push(quote.line);
  const practice = o.account === null && !hasWallet && o.practice === true;
  if (o.account === null) blocks.push(hasWallet ? "Connect a wallet to pledge." : practice ? PRACTICE.note : NO_WALLET);
  else if (!o.onRightChain) blocks.push("Your wallet is on another network. Switch it to Arc Testnet.");
  else if (o.balance === null || o.allowance === null) blocks.push("Reading your balance.");
  else if (quote.kind !== "refused" && o.balance < taken) blocks.push(`This account holds ${formatUsd(o.balance)} USDC, which is less than this pledge.`);
  else if (quote.kind !== "refused" && reserve > 0n && o.balance < taken + reserve)
    blocks.push(`Gas on this network is paid in USDC, so this account must keep about ${formatUsd(reserve)} for it. It holds ${formatUsd(o.balance)} USDC and can pledge up to ${formatUsd(o.balance > reserve ? o.balance - reserve : 0n)}.`);
  if (quote.kind !== "refused" && o.answer === null) blocks.push("Checking the figure with the contract.");

  const canSend = blocks.length === 0;
  // The pledge is for what was typed and the contract takes no more than the gap; the approval is for what it takes.
  const calls = canSend ? pledgeCalls({ boomerang: o.where.boomerang, usdc: o.where.usdc, id: o.campaign.id, amount, allowance: o.allowance ?? 0n, taken }) : [];
  const button = o.account === null ? (hasWallet ? "Connect a wallet" : practice ? PRACTICE.button : "No wallet in this browser") : quote.kind === "refused" ? "Pledge" : `Pledge ${formatUsd(taken)} USDC`;
  return { amount, quote, line: quote.line, source: quote.kind === "refused" ? "none" : o.answer === null ? "estimate" : "contract", blocks, canSend, button, calls };
}

/**
 * Which way a pledge goes: one signature that the keeper relays, when the helper is deployed and
 * the keeper relays through that same helper; otherwise, or once the relay has failed on this
 * page, the two-step pledge (allow, then pledge).
 */
export function pledgeRoute(o: { signedPledge: Address | null; relay: Address | null; fellBack: boolean }): "signed" | "two-step" {
  if (o.fellBack || o.signedPledge === null || o.relay === null) return "two-step";
  return o.signedPledge.toLowerCase() === o.relay.toLowerCase() ? "signed" : "two-step";
}

// Why the keeper did not send a signed pledge, each in a sentence. A reason this page does not know gets "failed".
const RELAY_REFUSALS: Record<string, string> = {
  "bad-request": "The keeper could not read the signed pledge.",
  "bad-signature": "The keeper could not match the signature to your address.",
  window: "The signature's time window did not suit the keeper.",
  pending: "The keeper is already sending a signed pledge of yours.",
  cap: "The keeper has sent five signed pledges for this address in the last hour.",
  refused: "The contract would refuse this pledge as it stands.",
  "keeper-low": "The keeper is short of gas money for now.",
  busy: "The keeper is busy.",
  unavailable: "The keeper could not reach the chain just now.",
  "no-relay": "This site's keeper does not send signed pledges.",
  failed: "The keeper could not send it.",
};

/** A reason the one-signature pledge did not go through, with the offer of the two-step pledge. */
export function fallbackLine(why: string): string {
  return `${why} Nothing was taken. Press Pledge again to pledge in two steps.`;
}

/**
 * Did the keeper turn the request away with nothing of this backer's on its way? Every named
 * refusal but two comes before a send. "failed", an unknown reason and no answer at all may hide
 * this signature's transaction, and "pending" says another of the backer's signatures is being
 * sent: in those cases the signature must run out before any other pledge is sent.
 */
export function relayRefusedBeforeSending(reason: string | null): boolean {
  return reason !== null && reason !== "failed" && reason !== "pending" && Object.hasOwn(RELAY_REFUSALS, reason);
}

/** The sentence shown when the keeper did not send a signed pledge; `null` is no answer in time. */
export function relayLine(reason: string | null): string {
  const why = reason === null ? "The keeper did not answer in time." : Object.hasOwn(RELAY_REFUSALS, reason) ? RELAY_REFUSALS[reason] : RELAY_REFUSALS.failed;
  if (relayRefusedBeforeSending(reason)) return fallbackLine(why);
  return `${why} Your signature may still go through for up to three minutes. If your pledge has not appeared by then, press Pledge again to pledge in two steps.`;
}

/** Said when Pledge is pressed before an unanswered signature has run out. */
export function stillValidLine(secondsLeft: bigint): string {
  const minutes = secondsLeft <= 60n ? "a minute" : `${(secondsLeft + 59n) / 60n} minutes`;
  return `Your signed pledge could still go through for about ${minutes}. Wait until then before pledging in two steps, so you do not pledge twice.`;
}

/**
 * Just before sending, the contract is asked again. If what it says now is worse than, or a
 * different thing from, what the visitor read (another kind of outcome, another amount taken, the
 * early window gone, or a bonus that now reads lower on the page) the page shows the new sentence
 * and asks again instead of sending. The comparison is of the figure as shown, cut to the cent,
 * not of a distance: 1.50 falling to 1.4999 reads 1.49 and is asked again. A bonus that only rose
 * is sent as it is.
 */
export function requote(shown: PledgeQuote, fresh: PledgeQuote): { same: true } | { same: false; line: string } {
  const changed = (line: string) => ({ same: false as const, line: `This changed while you were reading. ${line}` });
  if (fresh.kind !== shown.kind) return changed(fresh.line);
  if (fresh.kind === "refused") return shown.kind === "refused" && shown.why === fresh.why ? { same: true } : changed(fresh.line);
  if (shown.kind === "refused") return changed(fresh.line);
  if (fresh.counted !== shown.counted) return changed(fresh.line);
  if (fresh.kind === "counts" && shown.kind === "counts") {
    if (fresh.early !== shown.early) return changed(fresh.line);
    if (fresh.bonus / CENT < shown.bonus / CENT) return changed(fresh.line); // the cents on the page fell
    if (shown.bonus > 0n && fresh.bonus === 0n) return changed(fresh.line); // "less than 0.01" became nothing
  }
  return { same: true };
}
