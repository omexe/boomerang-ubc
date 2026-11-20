// "My money": each pledge the connected account has made, and where it stands.
import type { Address } from "../../../packages/kit/src/index.ts";
import { hrefFor } from "../app/route.ts";
import type { PaceState } from "../data/pace.ts";
import { standingOf } from "../data/campaign.ts";
import { short } from "../data/keeper.ts";
import { nameOf, type Label } from "../data/labels.ts";
import type { MyPledge } from "../data/load.ts";
import { formatUsd } from "../data/money.ts";

const ZERO = "0x0000000000000000000000000000000000000000";

export type MineRow = {
  href: string;
  title: string;
  kind: "counted" | "given" | "owed" | "returned";
  line: string;
  /** Where a refund would go, when the backer has pointed it somewhere other than their own address. */
  refundTo: string | null;
  /** Set when a refund is owed and unpaid: anyone may send it, and it pays only the backer. */
  send: { button: string; note: string; campaign: bigint } | null;
};

export type MinePage = {
  /** The account shown, shortened; null when no wallet is connected. */
  account: string | null;
  rows: MineRow[];
  /** What to say when there are no rows. */
  empty: string | null;
  totals: { label: string; value: string }[];
  asOf: string;
  /** Whose money this is: the visitor's own (no tag), another account, or the example backer. */
  subject: { tag: string | null; address: Address | null; note: string | null };
  /** Four figures above the rows (how many backed, how many early, paid back, went to cleared campaigns); empty when there is no account to show. */
  figures: { label: string; value: string }[];
  /** Shown only when the visitor has no account: a row can be sent, but no wallet is connected to send it (or the browser has none). */
  connectNote: string | null;
};

/** The look-up field's fixed words. */
export const LOOKUP = { label: "Look up any address", button: "Look up", back: "Back to my own money" } as const;

const ADDRESS = /^0[xX]([0-9a-fA-F]{40})$/;

/**
 * What the look-up field does with what was typed. Empty is no problem and no href. A well-formed
 * address (0x or 0X, then exactly 40 hex digits) gives the hash for that account's money, with a
 * lowercase 0x and the digits as typed. Anything else is not an address, and says so.
 */
export function lookupForm(text: string): { href: string | null; problem: string | null } {
  const t = text.trim();
  if (t === "") return { href: null, problem: null };
  const m = ADDRESS.exec(t);
  if (m === null) return { href: null, problem: "That is not an address. An address is 0x followed by 40 letters and digits." };
  const who = `0x${m[1]}` as Address;
  return { href: hrefFor({ page: "mine", who }), problem: null };
}

/**
 * `mine` is what `loadMine` read from the contract. My money takes nothing from the keeper or its
 * ledger: every figure is the contract's own.
 */
export function minePage(o: {
  account: Address | null;
  mine: readonly MyPledge[];
  labels: readonly Label[];
  desk: Address | null;
  block: bigint;
  /** How the keeper stands against the chain at this read. Only when it is prompt does a sentence say it is about to act. */
  pace?: PaceState;
  /** Whether this browser has any wallet at all. */
  hasWallet?: boolean;
  /** How many campaigns the contract has and how many of the newest this page read; pledges are looked for only in those. */
  count?: bigint;
  read?: number;
  /** Whose money this is. "own" (default) is the visitor's; "other" is any account looked up; "example" is a backer shown when nobody is connected. */
  whose?: "own" | "other" | "example";
}): MinePage {
  const asOf = `As of block ${o.block}`;
  if (o.account === null) {
    const empty = (o.hasWallet ?? true) ? "Connect a wallet to see your pledges." : "No wallet found in this browser, so there are no pledges to show. Every campaign can be read without one.";
    return { account: null, rows: [], empty, totals: [], asOf, subject: { tag: null, address: null, note: null }, figures: [], connectNote: null };
  }
  // "own" speaks to the visitor ("you"); "other" and "example" speak about someone else ("this backer").
  const third = (o.whose ?? "own") !== "own";
  const subject: MinePage["subject"] =
    o.whose === "other"
      ? { tag: "Another account", address: o.account, note: "Read from the contract, as anyone can. Nothing here needs that account's permission." }
      : o.whose === "example"
        ? { tag: "An example", address: o.account, note: "A real backer on this contract, shown so the page is not empty. Connect a wallet to see your own money, or look any address up." }
        : { tag: null, address: o.account, note: null };
  const MINE_SOON: Record<PaceState, string> = {
    prompt: "The keeper usually does it within seconds.",
    behind: "The keeper is behind the chain right now, so it waits for someone to press it.",
    down: "The keeper is not answering right now, so it waits for someone to press it.",
  };
  const soon = MINE_SOON[o.pace ?? "prompt"];
  const sendNote = third
    ? `Anyone can send this, and it can only pay this backer's refund address. ${soon}`
    : `Anyone can send this, and it can only pay the backer's own refund address. ${soon}`;
  const capped = o.count !== undefined && o.read !== undefined && BigInt(o.read) < o.count;
  const me = o.account.toLowerCase();
  let counted = 0n;
  let owed = 0n;
  let returned = 0n;
  let given = 0n;
  let chosen = 0n; // refunds paid to an address this account chose, not back to it
  let paidBack = 0n; // every refund that has come back, wherever it was paid
  let early = 0; // how many of the rows earned bonus weight
  const rows: MineRow[] = [];
  for (const m of o.mine) {
    const { campaign: c, backer: b } = m;
    const redirectTo = b.payTo.toLowerCase() !== ZERO && b.payTo.toLowerCase() !== me ? b.payTo : null;
    const standing = standingOf(c.terms, c.state, b, redirectTo, third);
    if (standing.kind === "none") continue;
    if (standing.kind === "counted") counted += standing.principal;
    if (standing.kind === "given") given += standing.principal;
    if (standing.kind === "owed") owed += standing.principal + standing.bonus;
    if (standing.kind === "returned") {
      paidBack += standing.principal + standing.bonus;
      redirectTo ? (chosen += standing.principal + standing.bonus) : (returned += standing.principal + standing.bonus);
    }
    if (b.weighted > 0n) early += 1;
    rows.push({
      href: hrefFor({ page: "campaign", id: c.id }),
      title: nameOf(o.labels, c, o.desk).title,
      kind: standing.kind,
      line: standing.line,
      refundTo: redirectTo !== null && (standing.kind === "counted" || standing.kind === "owed") ? `A refund would go to ${short(b.payTo)}, as ${third ? "this backer" : "this account"} asked.` : null,
      send: standing.kind === "owed" ? { button: third ? "Send this refund" : "Send my refund", note: sendNote, campaign: c.id } : null,
    });
  }
  const totals = [
    { label: "In campaigns not yet settled", value: `${formatUsd(counted)} USDC` },
    { label: third ? "Owed to this account now" : "Owed to you now", value: `${formatUsd(owed)} USDC` },
    { label: third ? "Came back to this account" : "Came back to you", value: `${formatUsd(returned)} USDC` },
    { label: "Went to funded campaigns", value: `${formatUsd(given)} USDC` },
  ];
  if (chosen > 0n) totals.push({ label: third ? "Paid to addresses it chose" : "Paid to addresses you chose", value: `${formatUsd(chosen)} USDC` });
  if (capped) totals.push({ label: "Looked for in", value: `the newest ${o.read} of ${o.count} campaigns` });
  const figures = [
    { label: "Campaigns backed", value: String(rows.length) },
    { label: "Backed early", value: String(early) },
    { label: "Paid back", value: `${formatUsd(paidBack)} USDC` },
    { label: "Went to cleared campaigns", value: `${formatUsd(given)} USDC` },
  ];
  const connectNote = !rows.some((r) => r.send !== null) ? null : (o.hasWallet ?? true) ? "Connect a wallet to send it." : "Sending it takes a wallet, and this browser has none.";
  return {
    account: short(o.account),
    rows,
    empty: rows.length > 0 ? null : capped ? `This account has not pledged to any of the newest ${o.read} campaigns. Older ones are not read by this page.` : "This account has not pledged to any campaign here.",
    totals,
    asOf,
    subject,
    figures,
    connectNote,
  };
}
