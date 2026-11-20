// What went wrong, in a sentence a visitor can act on. Every error either contract can raise has
// one (a test holds the list to both ABIs), and a failed send is explained from the error the
// wallet or the node returned. Nothing here is shown as markup: these are plain strings.
import { declined } from "../wallet/injected.ts";

/** One sentence per error name in Boomerang's and the router's ABI. */
export const SENTENCES: Readonly<Record<string, string>> = {
  // Boomerang
  AlreadyFunded: "That pot is already locked.",
  AlreadyPaid: "This refund has already been paid, so its address can no longer be changed.",
  BadTerms: "The contract refused these campaign terms.",
  BelowMinimum: "That is less than this campaign's smallest pledge.",
  CampaignVoid: "This campaign is void: a pot was not locked before it opened, so it takes no pledges.",
  Closed: "This campaign has closed.",
  NoRecord: "This address has no pledge in this campaign.",
  NoSuchCampaign: "There is no campaign with that number.",
  NotDue: "This campaign is still open, so it cannot be settled yet.",
  NotFinal: "This campaign has not been settled yet.",
  NotFunder: "Only the account named to fund the bonus pool can lock it.",
  NotOpenYet: "This campaign has not opened yet.",
  NotSponsor: "Only the campaign's sponsor can do that.",
  NothingToFund: "This campaign has no such pot to lock.",
  OutcomeSet: "This campaign has already been settled.",
  Reentered: "The contract refused a call made in the middle of another one.",
  SponsorCannotPledge: "A sponsor cannot pledge to their own campaign.",
  TooLate: "The campaign has opened, so its pots can no longer be locked.",
  TransferFailed: "The USDC did not move. If you were paying in, check your balance and the amount you approved. If this was a payout, the receiving address refused it.",
  ZeroAddress: "That address cannot be used here.",
  ZeroAmount: "The amount is zero.",
  // The router, for a pledge from another chain
  BadHook: "This cross-chain transfer does not name a campaign and a backer in the form the router reads.",
  LowGas: "The relay was sent with too little gas to make the pledge. Send it again with more.",
  NotABurn: "This message is not a USDC transfer through Circle's token messenger.",
  NotForRouter: "This transfer was not addressed to the router.",
  NothingMinted: "Circle's contract accepted the message, but no USDC arrived.",
  ReceiveFailed: "Circle's contract refused the message.",
  TokenFailed: "The router could not pass on the USDC it received.",
};

// Which term the contract named when it refused a campaign. Anything else it says is not repeated.
const TERMS: Readonly<Record<string, string>> = {
  recipient: "the recipient",
  times: "the opening, early and closing times",
  target: "the target",
  minPledge: "the smallest pledge",
  matchAmount: "the match",
  bonusPool: "the bonus pool",
  rateBps: "the bonus rate",
};

/** The sentence for a contract error. `args` are the error's own arguments, if it has any. */
export function sentenceFor(errorName: string, args?: readonly unknown[]): string {
  if (errorName === "BadTerms") {
    const what = args && typeof args[0] === "string" && Object.hasOwn(TERMS, args[0]) ? TERMS[args[0]] : null;
    return what === null ? SENTENCES.BadTerms : `The contract refused these campaign terms: ${what}.`;
  }
  return Object.hasOwn(SENTENCES, errorName) ? SENTENCES[errorName] : "The contract refused this, without a reason this page knows.";
}

type Revert = { data?: { errorName?: unknown; args?: unknown } };

// The contract's own refusal inside a viem error, if there is one. viem keeps the decoded error
// on a ContractFunctionRevertedError somewhere in the chain of causes.
function revertIn(e: unknown): { errorName: string; args: readonly unknown[] } | null {
  const walk = (e as { walk?: unknown } | null | undefined)?.walk;
  if (typeof walk !== "function") return null;
  const hit = (walk as (this: unknown, fn: (x: unknown) => boolean) => unknown).call(e, (x) => typeof (x as Revert | null)?.data?.errorName === "string") as Revert | null | undefined;
  const name = hit?.data?.errorName;
  if (typeof name !== "string") return null;
  return { errorName: name, args: Array.isArray(hit?.data?.args) ? (hit.data.args as unknown[]) : [] };
}

const firstLine = (e: unknown): string => {
  const m = (e as { shortMessage?: unknown; message?: unknown } | null | undefined) ?? {};
  const text = typeof m.shortMessage === "string" ? m.shortMessage : typeof m.message === "string" ? m.message : String(e);
  return text.split("\n")[0].slice(0, 160);
};

/** A failed read, simulation or send, in one or two plain sentences. */
export function explain(e: unknown): string {
  if (declined(e)) return "You said no in your wallet. Nothing was sent.";
  const revert = revertIn(e);
  if (revert) return sentenceFor(revert.errorName, revert.args);
  const line = firstLine(e);
  if (/insufficient funds/i.test(line)) return "This account has too little USDC to pay the network fee.";
  return `That did not go through. The wallet or the network said: ${line}`;
}
