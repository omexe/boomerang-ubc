// The landing page's campaigns table, as plain values. It reads the chain the same way the Home
// page does: it reuses homePage's running-then-settled order and takes each row's name and status
// from the campaign page's own view (through the Home cards), so the landing table and the campaign
// page can never say different things. Nothing here reads the chain or the clock; `now` is the time
// of the block the figures were read at.
import type { Address } from "../../../packages/kit/src/index.ts";
import { hrefFor } from "../app/route.ts";
import { phaseOf } from "../data/campaign.ts";
import type { Label } from "../data/labels.ts";
import type { CampaignView } from "../data/load.ts";
import { formatUsd } from "../data/money.ts";
import { timeLeft } from "../data/time.ts";
import { homePage, type HomePage } from "./home.ts";

/** The stamp in the Outcome column. Only "cleared" and "returned" are drawn as the mockup's stamp;
 *  the rest are plain text, and vermilion is reserved for "returned". */
export type Mark = {
  kind: "cleared" | "returned" | "void" | "open" | "waiting";
  word: string;
  small: string;
};

export type LedgerRow = {
  href: string;
  /** The site's word for the campaign, the same string the campaign page shows. */
  name: string;
  /** The small line under the name: the campaign page's own status. */
  note: string;
  /** "1.50 of 3.00" */
  raised: string;
  /** "1" */
  backers: string;
  /** "17 Nov, 06:29", from terms.closesAt, in UTC. */
  deadline: string;
  mark: Mark;
};

/** Open campaigns first, then settled ones, newest first within each; `empty` is set when there is none. */
/** `totals` are the Home page's own, so the table and that page can never report different sums. */
export type LedgerTable = { rows: LedgerRow[]; empty: string | null; totals: HomePage["totals"] };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A deadline as the table shows it: "17 Nov, 06:29" (UTC), no year. */
function deadlineStamp(seconds: bigint): string {
  if (seconds < 0n || seconds > 253_402_300_799n) return "an unreadable date"; // outside years 1970 to 9999
  const d = new Date(Number(seconds) * 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/** The Outcome stamp for a campaign, from its phase. */
function markOf(c: CampaignView, now: bigint): Mark {
  const { terms: t, state: s } = c;
  switch (phaseOf(t, s, now)) {
    case "funded":
      // A pot of nothing is not shown as "+ 0.00".
      return { kind: "cleared", word: "Cleared", small: t.matchAmount > 0n ? `${formatUsd(s.pledged)} + ${formatUsd(t.matchAmount)} match` : formatUsd(s.pledged) };
    case "missed":
      return { kind: "returned", word: "Returned", small: s.bonusPaid > 0n ? `${formatUsd(s.pledged)} + ${formatUsd(s.bonusPaid)} bonus` : formatUsd(s.pledged) };
    case "void":
      return { kind: "void", word: "Never opened", small: "no pledge was taken" };
    case "ended":
      // Past the deadline (or a pot was missing at opening) and nobody has settled it yet.
      return { kind: "waiting", word: "Awaiting settlement", small: "" };
    case "waiting":
      // Created, and its opening time has not come.
      return { kind: "open", word: "Opens soon", small: `opens in ${timeLeft(t.opensAt - now)}` };
    default:
      // early, open: taking pledges, before the deadline.
      return { kind: "open", word: "Open", small: `closes in ${timeLeft(t.closesAt - now)}` };
  }
}

/** The line over the table: which campaigns it lists, and the one rule every closed one kept. */
export function ledgerSub(o: { count: bigint; read: number }): string {
  const which = BigInt(o.read) < o.count ? `The newest ${o.read} of the contract's ${o.count} campaigns` : "Every campaign on the contract";
  return `${which}, read from the chain. Each one that has closed paid out at most one of its two pots.`;
}

export function ledgerView(o: { campaigns: readonly CampaignView[]; count?: bigint; labels: readonly Label[]; desk: Address | null; now: bigint; block: bigint }): LedgerTable {
  // homePage already splits the campaigns into running-then-settled (newest first) and derives each
  // card's name and status from the campaign page, so the table borrows both rather than redo them.
  const home = homePage(o); // `count` goes with it, so the totals name the contract's own number of campaigns
  const byHref = new Map(o.campaigns.map((c) => [hrefFor({ page: "campaign", id: c.id }), c]));
  const rows: LedgerRow[] = [];
  for (const card of [...home.running, ...home.settled]) {
    const c = byHref.get(card.href);
    if (c === undefined) continue; // every home card is one of these campaigns
    const { terms: t, state: s } = c;
    rows.push({
      href: card.href,
      name: card.title,
      note: card.status,
      raised: `${formatUsd(s.pledged)} of ${formatUsd(t.target)}`,
      backers: String(s.backers),
      deadline: deadlineStamp(t.closesAt),
      mark: markOf(c, o.now),
    });
  }
  return { rows, empty: home.empty, totals: home.totals };
}
