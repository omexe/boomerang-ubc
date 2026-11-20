// The Home page: totals, the campaigns that are still running, the ones that are settled.
// Every card is the Campaign page's own view cut down, so the two can never say different things.
import type { Address } from "../../../packages/kit/src/index.ts";
import { Outcome } from "../../../packages/kit/src/index.ts";
import { hrefFor } from "../app/route.ts";
import type { Label } from "../data/labels.ts";
import type { CampaignView } from "../data/load.ts";
import { formatUsd } from "../data/money.ts";
import { campaignPage, type Row } from "./campaign.ts";

export type Card = { href: string; title: string; by: string; example: boolean; status: string; raised: string; percent: number; clock: string };

export type HomePage = {
  totals: Row[];
  /** Not settled yet: waiting to open, open, or past the deadline and waiting to be settled. Newest first. */
  running: Card[];
  /** Funded, missed or void. Newest first. */
  settled: Card[];
  empty: string | null;
  /** The demo desk's offer, when this site's keeper runs one. */
  demo: { button: string; other: string } | null;
  /** The sentence over the closing button: what pressing it shows. */
  closing: string;
  asOf: string;
};

export function homePage(o: {
  campaigns: readonly CampaignView[];
  /** How many campaigns the contract has in all; `campaigns` may be only the newest of them. Left out, it is taken to be all of them. */
  count?: bigint;
  labels: readonly Label[];
  desk: Address | null;
  now: bigint;
  block: bigint;
}): HomePage {
  const count = o.count ?? BigInt(o.campaigns.length);
  const capped = BigInt(o.campaigns.length) < count;
  let backers = 0;
  let pledged = 0n;
  let toRecipients = 0n;
  let backToBackers = 0n;
  let bonus = 0n;
  const running: Card[] = [];
  const settled: Card[] = [];
  for (const c of o.campaigns) {
    const { terms: t, state: s } = c;
    backers += s.backers;
    pledged += s.pledged;
    bonus += s.bonusPaid;
    if (s.outcome === Outcome.Funded) toRecipients += s.pledged + t.matchAmount;
    if (s.outcome === Outcome.Missed) backToBackers += s.pledged;
    const page = campaignPage({ campaign: c, labels: o.labels, desk: o.desk, now: o.now, block: o.block });
    const card: Card = {
      href: hrefFor({ page: "campaign", id: c.id }),
      title: page.name.title,
      by: page.name.by,
      example: page.name.example,
      status: page.status,
      raised: page.raised,
      percent: page.percent,
      clock: page.clock,
    };
    (s.outcome === Outcome.Open ? running : settled).push(card);
  }
  return {
    totals: [
      { label: "Campaigns", value: String(count) },
      { label: "Backers, campaign by campaign", value: String(backers) },
      { label: "Pledged", value: `${formatUsd(pledged)} USDC` },
      { label: "Raised for recipients", value: `${formatUsd(toRecipients)} USDC` },
      { label: "Refunds and bonus for backers of missed campaigns", value: `${formatUsd(backToBackers + bonus)} USDC` },
      ...(capped ? [{ label: "The sums of backers and money cover", value: `the newest ${o.campaigns.length} of ${count} campaigns` }] : []),
    ],
    running,
    settled,
    empty: o.campaigns.length === 0 ? "No campaign has been created yet." : null,
    demo: o.desk === null ? null : { button: "Start a two-minute campaign", other: "Or start a ten-minute one" },
    closing:
      o.desk === null
        ? "See how the campaigns here played out: pledge, deadline, and the money back."
        : "Start a two-minute campaign and watch the whole thing play out: pledge, deadline, and the money back.",
    asOf: `As of block ${o.block}`,
  };
}
