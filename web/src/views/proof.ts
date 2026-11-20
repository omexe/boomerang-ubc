// The Proof page: what a stranger can check, and what this app does not claim.
//
// Three things are set side by side. The contract's own figures, read at one block. A second
// ledger the keeper rebuilt from nothing but the contract's events as the keeper received them.
// And the keeper's own pulse. Only the first is the truth about the money; the other two are
// there to be compared with it, and the page says plainly when they are late, absent or wrong.
import type { Address } from "../../../packages/kit/src/index.ts";
import { Outcome } from "../../../packages/kit/src/index.ts";
import { hrefFor } from "../app/route.ts";
import type { BackerCheck } from "../app/world.ts";
import { phaseOf } from "../data/campaign.ts";
import type { HealthView } from "../data/health.ts";
import type { Pace } from "../data/pace.ts";
import { backerDifferences, differences, short, standing, type LedgerView } from "../data/keeper.ts";
import { nameOf, type Label } from "../data/labels.ts";
import type { CampaignView, Custody } from "../data/load.ts";
import { formatUsd } from "../data/money.ts";
import { utcStamp } from "../data/time.ts";
import { duesOf, type Row } from "./campaign.ts";
import { SOURCE } from "./shell.ts";

export type ProofPage = {
  custody: { state: "ok" | "short" | "unread"; line: string; detail: string };
  second: {
    state: "agrees" | "differs" | "behind" | "ahead" | "down";
    line: string;
    /** Each disagreement, in words; empty unless the state is "differs". */
    differences: string[];
  };
  /** The keeper's pulse as it reports it: what feeds it and what it has done; null when it cannot be reached. */
  keeper: Row[] | null;
  /** Things the keeper itself reported going wrong, newest last, as plain text. */
  keeperErrors: string[];
  facts: Row[];
  /** How to check all of this without trusting this page. */
  yourself: { line: string; commands: string[] };
  /** Every campaign the page read, newest first, and how each one ended. */
  campaigns: {
    title: string;
    head: readonly [string, string, string, string];
    rows: { href: string; name: string; ended: string; pledged: string; paid: string }[];
    /** Set when fewer campaigns were read than the contract has; else null. */
    note: string | null;
  };
  limits: string[];
};

// The outcome word, the one the landing page's ledger uses for a settled campaign, or "Open" /
// "Waiting to be settled" while the campaign has no outcome yet.
function endedWord(c: CampaignView, now: bigint): string {
  switch (c.state.outcome) {
    case Outcome.Funded:
      return "Cleared";
    case Outcome.Missed:
      return "Returned";
    case Outcome.Void:
      return "Never opened";
    default:
      return phaseOf(c.terms, c.state, now) === "ended" ? "Waiting to be settled" : "Open";
  }
}

// What has been paid out, in the table's words. `duesOf` covers the recipient and the two pots
// only; it does not know each backer's refund, so a missed campaign never reads "in full" here.
function paidWord(c: CampaignView): string {
  if (c.state.outcome === Outcome.Open) return "Not yet";
  if (duesOf(c).length > 0) return "Not all yet";
  return c.state.outcome === Outcome.Missed ? "Pots returned; refunds are on its page" : "In full";
}

export const LIMITS: readonly string[] = [
  "This runs on Arc Testnet with test USDC. No real money is involved and no real campaign has run on it.",
  "The names and descriptions of campaigns are this site's words. The contract holds only amounts, dates and addresses.",
  "The keeper makes payouts prompt; it is not needed for them. When it is off or behind the chain nothing is lost, only later: from this site anyone can settle a campaign, pay its recipient and return the pots that were not paid out, and a backer can send their own refund from the campaign's page or from My money. Anyone can send someone else's refund as well: look the backer's address up under My money.",
  "This site opens campaigns only through its desk, on fixed two-minute or ten-minute terms. A sponsor with other terms calls the contract directly. The router for pledges from other chains is deployed, but this site has no form for such a pledge yet.",
  "A pledge from another chain is refunded on Arc, to the backer's address there, not back across the bridge.",
  "A one-signature pledge is sent by the keeper, which pays its gas. The signature can move the backer's USDC only into the campaign and amount it names, once, within three minutes. When the keeper is down or refuses, the page offers the two-step pledge, which needs no keeper.",
  "A practice wallet is a key this page makes so that a visitor without a wallet can try a pledge. It is kept in this browser's storage, or only for the visit where the browser does not allow that. It is for test money only: anyone who can use this browser can use it, and clearing the browser's data loses it.",
  "The second ledger is only as good as the events delivered to the keeper. When it disagrees with the contract, the contract is right.",
  "Nothing here shows how people behave when a refund bonus is on offer. That has not been measured on this app.",
];

// "None", "Number 9", "Numbers 9 and 11", "Numbers 9, 11 and 12".
const numbers = (ids: readonly bigint[]): string =>
  ids.length === 0 ? "None" : ids.length === 1 ? `Number ${ids[0]}` : `Numbers ${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`;

const KEEPER_DOWN = "The keeper cannot be reached, so the second ledger is not shown. The contract's figures above do not depend on it.";

// What the keeper's table says it is fed by. The keeper hears the chain one way, by reading
// Arc's node itself. "down" cannot happen with a health present; it is covered so the row is never empty.
function fedBy(pace: Pace): string {
  if (pace.state === "down") return "The keeper did not answer at this read.";
  if (pace.state === "behind") {
    return pace.heard === 0
      ? "Nothing yet. The keeper has heard no block since it started."
      : `Nothing right now. The keeper last heard block ${pace.heard}, ${pace.blocks} blocks behind the chain.`;
  }
  return "Arc's node, read by the keeper itself.";
}

export function proofPage(o: {
  /** Held, owed and the event count, read at one block; null if that read failed. */
  custody: Custody | null;
  /** The campaigns read from the contract at that same block: the newest `campaigns.length` of `count`. */
  campaigns: readonly CampaignView[];
  /** How many campaigns the contract has in all. When it is more than were read, only those read are compared. */
  count: bigint;
  ledger: LedgerView | null;
  health: HealthView | null;
  /** For up to 100 of the ledger's backer records (newest campaigns first), the contract's own record at this block; null when the keeper is down. */
  backerChecks: BackerCheck[] | null;
  /** How many backer records the ledger lists in all. */
  backerTotal: number;
  where: { boomerang: Address; usdc: Address; router: Address };
  /** The site's labels, the desk address and the read block's time, as `ledgerView` takes them, for the campaigns table. */
  labels?: readonly Label[];
  desk?: Address | null;
  now?: bigint;
  /** How the keeper stands against the chain at this read; it decides how the keeper's table says it is fed. */
  pace: Pace;
}): ProofPage {
  const labels = o.labels ?? [];
  const desk = o.desk ?? null;
  const now = o.now ?? 0n;
  const c = o.custody;
  const custody: ProofPage["custody"] =
    c === null
      ? { state: "unread", line: "The contract's balance could not be read just now.", detail: "" }
      : c.held >= c.owed
        ? {
            state: "ok",
            line: `The contract holds ${formatUsd(c.held)} USDC and owes ${formatUsd(c.owed)} USDC.`,
            detail: `Both figures were read at block ${c.block} (${utcStamp(c.time)}). It can pay everyone it owes.`,
          }
        : {
            state: "short",
            line: `The contract holds ${formatUsd(c.held)} USDC and owes ${formatUsd(c.owed)} USDC: it is ${formatUsd(c.owed - c.held)} short.`,
            detail: `Both figures were read at block ${c.block} (${utcStamp(c.time)}). This should be impossible; do not pledge.`,
          };

  let second: ProofPage["second"];
  if (o.ledger === null) second = { state: "down", line: KEEPER_DOWN, differences: [] };
  else if (c === null) second = { state: "down", line: "The second ledger cannot be compared until the contract's figures are read.", differences: [] };
  else {
    const s = standing(o.ledger, { owed: c.owed, events: c.events });
    if (s.kind === "behind") {
      const hole = o.ledger.missing;
      const rejected = o.health?.rejected ?? 0;
      const by = `${s.by} ${s.by === 1n ? "event" : "events"}`;
      second = {
        state: "behind",
        line:
          hole === null
            ? rejected > 0
              ? `The keeper's ledger is ${by} behind the contract, and the keeper has set ${rejected} ${rejected === 1 ? "event" : "events"} aside as not fitting. It is not compared until it has caught up.`
              : `The keeper's ledger is ${by} behind the contract. It is late, not wrong; the figures are compared once it catches up.`
            : `The keeper's ledger is ${by} behind the contract, and ${hole.from === hole.to ? `event ${hole.from}` : `events ${hole.from} to ${hole.to}`} never reached it. It is not compared until the missing events reach it.`,
        differences: [],
      };
    } else if (s.kind === "ahead") {
      second = { state: "ahead", line: `The keeper's ledger holds ${s.by} more ${s.by === 1n ? "event" : "events"} than the contract had emitted at block ${c.block}, so it is not compared at this read. That is normal for a moment when a newer block reaches the keeper first; if it stays, the ledger is not this contract's.`, differences: [] };
    } else {
      const found = [...s.differences];
      const readIds = new Set(o.campaigns.map((x) => x.id));
      const capped = o.campaigns.length < Number(o.count);
      // The newest read id is the highest; the oldest read id bounds how far back the contract was read.
      const lowestRead = o.campaigns.reduce<bigint | null>((m, x) => (m === null || x.id < m ? x.id : m), null);
      for (const chain of o.campaigns) {
        const mine = o.ledger.campaigns.find((x) => x.id === chain.id);
        if (!mine) found.push(`campaign ${chain.id} is not in the ledger`);
        else for (const d of differences(mine, chain)) found.push(`campaign ${chain.id}: ${d}`);
      }
      // A campaign the page did not read is not "missing from the contract"; only flag those within the read window.
      for (const mine of o.ledger.campaigns) {
        if (!readIds.has(mine.id) && (lowestRead === null || mine.id >= lowestRead)) found.push(`campaign ${mine.id} is in the ledger but not in the contract`);
      }
      let comparedBackers = 0;
      for (const chk of o.backerChecks ?? []) {
        const lc = o.ledger.campaigns.find((x) => x.id === chk.id);
        const lb = lc?.backers.find((b) => b.address.toLowerCase() === chk.address.toLowerCase());
        if (lb === undefined) continue;
        comparedBackers += 1;
        for (const d of backerDifferences(lb, chk.chain)) found.push(`campaign ${chk.id}, backer ${short(chk.address)}: ${d}`);
      }
      const campaignsPhrase = capped
        ? `the newest ${o.campaigns.length} of ${o.count} campaigns`
        : o.campaigns.length === 1
          ? "its one campaign"
          : `all ${o.campaigns.length} campaigns`;
      const backerPhrase = comparedBackers < o.backerTotal ? `${comparedBackers} of ${o.backerTotal} backer records` : `${comparedBackers} backer record${comparedBackers === 1 ? "" : "s"}`;
      second =
        found.length === 0
          ? {
              state: "agrees",
              line: `A second ledger, rebuilt only from the contract's ${c.events} events as the keeper received them, agrees with the contract at block ${c.block} on every figure of ${campaignsPhrase} and on ${backerPhrase}.`,
              differences: [],
            }
          : { state: "differs", line: "The second ledger does not agree with the contract. The contract is right; the ledger has been fed something wrong or missed something.", differences: found };
    }
  }

  const h = o.health;
  const keeper: Row[] | null =
    h === null
      ? null
      : [
          { label: "Fed by", value: fedBy(o.pace) },
          { label: "Newest block heard", value: String(h.lastBlock) },
          ...(h.node !== null
            ? [{ label: "Node reads since the keeper started", value: h.node.faults === 0 ? String(h.node.reads) : `${h.node.reads}, and ${h.node.faults} that failed` }]
            : []),
          { label: "Events missing", value: h.missing === null ? "None" : `Numbers ${h.missing.from} to ${h.missing.to}` },
          { label: "Events set aside as not fitting", value: String(h.rejected) },
          { label: "Campaigns in the events that the contract does not have (or not yet)", value: numbers(h.absent) },
          { label: "Calls sent", value: `${h.sent} went through, ${h.failedSends} did not` },
          { label: "Calls given up on", value: h.gaveUp.length === 0 ? "None" : String(h.gaveUp.length) },
          { label: "Every settled campaign fully paid, by the keeper's ledger", value: h.settled ? "Yes" : "Not yet" },
        ];

  return {
    custody,
    second,
    keeper,
    keeperErrors: h === null ? [] : h.lastErrors,
    facts: [
      { label: "Contract", value: short(o.where.boomerang), address: o.where.boomerang },
      { label: "Token (USDC)", value: short(o.where.usdc), address: o.where.usdc },
      { label: "Router for pledges from other chains", value: short(o.where.router), address: o.where.router },
      { label: "Owner", value: "None. The contract has no owner, no upgrade, no pause and no way to move funds outside its rules." },
    ],
    yourself: {
      line: "You do not have to trust this page. With git and Node 26, these commands download the code, build the contracts and re-check the live contract without any key: its code, how it was created, that it has no owner, that it holds what it owes, and that a ledger rebuilt from its events matches the state the contract reports for every campaign and every backer.",
      commands: [`git clone ${SOURCE}`, "cd boomerang-arc", "npm ci", "npm run verify"],
    },
    campaigns: {
      title: "Every campaign, and how it ended",
      head: ["Campaign", "Ended", "Pledged", "Paid"],
      rows: o.campaigns.map((campaign) => ({
        href: hrefFor({ page: "campaign", id: campaign.id }),
        name: nameOf(labels, campaign, desk).title,
        ended: endedWord(campaign, now),
        pledged: `${formatUsd(campaign.state.pledged)} of ${formatUsd(campaign.terms.target)}`,
        paid: paidWord(campaign),
      })),
      note: BigInt(o.campaigns.length) < o.count ? `The newest ${o.campaigns.length} of ${o.count} campaigns.` : null,
    },
    limits: [...LIMITS],
  };
}
