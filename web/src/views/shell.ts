// The frame around every page: the name, the links, the wallet button, the notice when the chain
// cannot be read, and the words on the buttons that send something. As with the other views, the
// components only lay this out.
import type { Address } from "../../../packages/kit/src/index.ts";
import { hrefFor, type Route } from "../app/route.ts";
import { short } from "../data/keeper.ts";
import { PRACTICE, practiceAccount } from "./practice.ts";

export type Shell = {
  brand: string;
  /** The one place the page says which network this is and that the money is test money: the foot of every page. */
  disclaimer: string;
  /** The links in the bar. One with a `section` goes to that part of the landing page instead of a page of its own. */
  nav: { href: string; label: string; current: boolean; section: "how" | "ledger" | null }[];
  /** The links in the foot: the code, the contract on the explorer when there is one, and Proof. */
  foot: { href: string; label: string; external: boolean }[];
  wallet: {
    /** "practice": nobody connected, no wallet in the browser, a practice wallet on offer. "own": the practice wallet is in use and the browser has a wallet of the visitor's own to go back to. */
    state: "none" | "connect" | "practice" | "wrong-network" | "ready" | "own";
    /** The account, shortened; null until one is connected. */
    account: string | null;
    button: string | null;
    note: string | null;
  };
  /** Set when the chain cannot be read; the page below it is then old, or empty. */
  banner: string | null;
  asOf: string | null;
};

const NAV: { route: Route; label: string; pages: Route["page"][]; section: "how" | "ledger" | null }[] = [
  { route: { page: "home" }, label: "How it works", pages: [], section: "how" },
  { route: { page: "home" }, label: "Campaigns", pages: ["campaign", "pledge"], section: "ledger" },
  { route: { page: "mine" }, label: "My money", pages: ["mine"], section: null },
  { route: { page: "proof" }, label: "Proof", pages: ["proof"], section: null },
];

/** Where the code is published. */
export const SOURCE = "https://github.com/omexe/boomerang-ubc";

export function shell(o: {
  route: Route;
  chain: { id: number; name: string; local: boolean };
  /** The contract's page on the block explorer, when the chain has one. */
  contractLink?: string | null;
  /** How many wallets this browser has; the account connected, if any; the chain that wallet is on, if known. */
  wallets: number;
  account: Address | null;
  walletChainId: number | null;
  /** Whether a practice wallet is on offer, and whether the connected account is one. */
  practice?: boolean;
  practising?: boolean;
  /** The block of the last good read, or null if there has been none; whether the latest attempt failed. */
  block: bigint | null;
  readFailed: boolean;
}): Shell {
  const wallet: Shell["wallet"] =
    o.account === null
      ? o.wallets === 0
        ? o.practice
          ? { state: "practice", account: null, button: "Try a practice wallet", note: null }
          : { state: "none", account: null, button: null, note: "No wallet found in this browser. You can read everything here without one; to pledge you need a wallet with USDC on Arc Testnet." }
        : { state: "connect", account: null, button: "Connect a wallet", note: null }
      : o.practising
        ? o.wallets > 0
          ? { state: "own", account: practiceAccount(o.account), button: PRACTICE.own, note: null }
          : { state: "ready", account: practiceAccount(o.account), button: null, note: null }
      : o.walletChainId !== null && o.walletChainId !== o.chain.id
        ? { state: "wrong-network", account: short(o.account), button: `Switch to ${o.chain.name}`, note: `Your wallet is on another network. Nothing is sent until it is on ${o.chain.name}.` }
        : { state: "ready", account: short(o.account), button: null, note: null };

  const banner = !o.readFailed
    ? null
    : o.block === null
      ? "The chain cannot be read right now, so there is nothing to show yet. This page keeps trying."
      : `The chain could not be read just now. What you see is from block ${o.block} and may be out of date; nothing can be sent until it reads again.`;

  return {
    brand: "Boomerang",
    disclaimer: o.chain.local
      ? `${o.chain.name}, a test chain on this machine.`
      : `Boomerang runs on ${o.chain.name} with test USDC. No real money is involved, nothing here is an offer or financial advice, and the contract has not been audited.`,
    nav: NAV.map((n) => ({ href: hrefFor(n.route), label: n.label, current: n.pages.includes(o.route.page), section: n.section })),
    foot: [
      { href: SOURCE, label: "GitHub", external: true },
      ...(o.contractLink ? [{ href: o.contractLink, label: "Explorer", external: true }] : []),
      { href: hrefFor({ page: "proof" }), label: "Proof", external: false },
    ],
    wallet,
    banner,
    asOf: o.block === null ? null : `As of block ${o.block}`,
  };
}

/** The pledge button when the pledge is one signature: "Pledge 2.00 USDC" becomes "Sign and pledge 2.00 USDC". Any other wording is left as it is. */
export function signedButton(button: string): string {
  return button.startsWith("Pledge") ? WORDS.cheque.sign + button.slice("Pledge".length) : button;
}

/** The desk's offer of USDC, shown where a visitor is short of it. Null when there is no desk or no account, and for an address the desk will not send to again (`had`). */
export function deskOffer(o: { desk: Address | null; account: Address | null; had: boolean }): { button: string; note: string } | null {
  if (o.desk === null || o.account === null || o.had) return null;
  return { button: "Get 2.00 USDC", note: "From this site's desk, once per address. Circle's faucet for Arc Testnet gives more." };
}

/** The desk's answer under the cheque, shown only to the account that asked: after a change of wallet it would be about someone else's address. */
export function deskAnswerFor(o: { line: string | null; askedBy: Address | null; account: Address | null }): string | null {
  return o.line !== null && o.askedBy !== null && o.account !== null && o.askedBy.toLowerCase() === o.account.toLowerCase() ? o.line : null;
}

/** One step of a send, as the visitor reads it while their wallet is asking or the chain is working. With the practice wallet there is nothing to confirm: it sends at once. */
export function stepLine(step: { index: number; label: string; state: "asking" | "sent" | "done" }, total: number, practising: boolean = false): string {
  const n = total > 1 ? `Step ${step.index + 1} of ${total}: ` : "";
  const what = step.label;
  return step.state === "asking" ? `${n}${what}. ${practising ? "The practice wallet is sending it." : "Confirm it in your wallet."}` : step.state === "sent" ? `${n}${what}. Sent; waiting for the chain.` : `${n}${what}. Done.`;
}

/** The fixed words on the pages: headings, labels and short notes that depend on nothing. */
export const WORDS = {
  loading: "Reading the chain…",
  connect: "Connect a wallet",
  home: { running: "Open and upcoming", settled: "Settled", totals: "So far, on this contract", example: "Example" },
  campaign: {
    back: "All campaigns",
    terms: "The terms, as the contract holds them",
    feed: "What has happened",
    siteWords: "The name and description above are this site's words. Every amount, date and address on this page is read from the contract.",
    chainWords: "This campaign has no name on this site. Everything shown is read from the contract.",
    example: "An example campaign: the people named are invented.",
    deskWords: "This site's desk opened this campaign, and the name above is this site's. Every amount, date and address on this page is read from the contract.",
    pledge: "Pledge to this campaign",
  },
  pledge: {
    title: "Your pledge",
    amount: "Amount in USDC",
    back: "Back to the campaign",
    fromContract: "This is the contract's own answer for this amount, read just now.",
    estimate: "This is worked out by this page from the contract's rules. The contract is being asked.",
    sent: "Your pledge is in. It shows on the campaign page and under My money.",
    sentHere: "Your pledge is in. It shows on this page and under My money.",
    oneSignature: "One signature in your wallet, no gas: the keeper sends it for you.",
    signing: "Sign the pledge in your wallet. It is a signature, not a transaction, and costs no gas.",
    relaying: "Signed. The keeper is sending your pledge.",
    waiting: "Sent; waiting for the chain.",
    landed: "Your signed pledge went through after all. Nothing more was sent.",
    unconfirmed: "The keeper sent your pledge, but the chain has not confirmed it yet. Check My money in a moment before pledging again.",
    cannotSign: "Your wallet could not make this kind of signature.",
    cannotCheck: "The chain could not be read just now, so nothing was sent. Try again in a moment.",
  },
  cheque: {
    brand: "Boomerang",
    pays: "pays in USDC on Arc",
    payTo: "Pay to the order of",
    sumOf: "the sum of",
    sign: "Sign and pledge",
    closesIn: "closes in",
    opensIn: "opens in",
    startWith: "2.00",
    seeIt: "See the campaign.",
    noneOpen: "No campaign is taking pledges",
    deskNote: "Start a two-minute campaign and pledge to it: watch the deadline pass and the money come back.",
    noneNote: "When a campaign opens, this cheque is made out to it.",
    start: "Start a two-minute campaign",
    startTen: "Or start a ten-minute one",
  },
  mine: { title: "My money", totals: "In total" },
  proof: {
    title: "Proof",
    custody: "What the contract holds and owes",
    second: "A second ledger, built from the events alone",
    keeper: "The keeper and what feeds it",
    errors: "What the keeper reported going wrong",
    facts: "The contracts",
    yourself: "Check it yourself",
    limits: "What this app does not claim",
  },
  wallets: { choose: "Choose a wallet", cancel: "Cancel" },
  explorer: "View on the explorer",
} as const;

/** The line under the cheque once a pledge is in. On the campaign's own page it says "this page". */
export function pledgeSentLine(onCampaignPage: boolean): string {
  return onCampaignPage ? WORDS.pledge.sentHere : WORDS.pledge.sent;
}
