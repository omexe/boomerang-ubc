// The Campaign page: every word and number it shows, worked out from what was read from the
// contract. The page component only lays this out. Nothing here reads the chain or the clock;
// `now` is the time of the block the figures were read at.
import type { Address } from "../../../packages/kit/src/index.ts";
import { Outcome } from "../../../packages/kit/src/index.ts";
import { hrefFor } from "../app/route.ts";
import type { PaceState } from "../data/pace.ts";
import { clockLine, endsAs, phaseOf, progressOf, type Phase } from "../data/campaign.ts";
import { short } from "../data/keeper.ts";
import { nameOf, type Label, type Named } from "../data/labels.ts";
import type { CampaignView } from "../data/load.ts";
import { formatUsd } from "../data/money.ts";
import { utcStamp } from "../data/time.ts";
import type { MineRow } from "./mine.ts";

/** One line of the terms. `address` is set when the value is an account the page can link to the explorer. */
export type Row = { label: string; value: string; address?: Address };

export type CampaignPage = {
  /** What the campaign is called. `name.labelled` says whether these are the site's words or only the chain's. */
  name: Named;
  phase: Phase;
  /** A word or two for the badge. */
  status: string;
  clock: string;
  /** "1,240.00 of 2,000.00 USDC" */
  raised: string;
  percent: number;
  gap: string;
  backers: string;
  /** What happens to the money either way, in one or two sentences. */
  promise: string;
  rows: Row[];
  /** Where the pledge button goes; null when the campaign is not taking pledges, with the reason in `pledgeWhy`. */
  pledgeHref: string | null;
  pledgeWhy: string | null;
  /** Set when the deadline has passed and nobody has settled it yet: anyone may. */
  settle: { button: string; note: string } | null;
  /** What a settled campaign still owes its recipient or the funders of its pots, by the contract's own flags. Anyone may send each. */
  dues: Due[];
  /** Under the dues: who may send them, and whether the keeper is about to. Null when nothing is due. */
  duesNote: string | null;
  /** On a missed campaign: who sends a backer's refund, and from where. */
  refunds: string | null;
  control: string;
  asOf: string;
};

/** One payout the contract still owes on a settled campaign. `side` is the contract's own number: 0 the recipient, 1 the match back, 2 the bonus back. */
export type Due = { side: 0 | 1 | 2; button: string; line: string };

/**
 * What a settled campaign still owes besides its backers, worked out exactly as the contract's
 * `paySide` does: the recipient when it was funded; the match back when it was not; whatever of
 * the bonus the backers did not earn, back to whoever locked it.
 */
export function duesOf(c: CampaignView): Due[] {
  const { terms: t, state: s } = c;
  if (s.outcome === Outcome.Open) return [];
  const dues: Due[] = [];
  if (s.outcome === Outcome.Funded && !s.recipientPaid) {
    const amount = s.pledged + t.matchAmount;
    if (amount > 0n) dues.push({ side: 0, button: "Pay the recipient", line: `${formatUsd(amount)} USDC is owed to the recipient.` });
  }
  if (s.outcome !== Outcome.Funded && s.matchIn && !s.matchReturned && t.matchAmount > 0n) {
    dues.push({ side: 1, button: "Return the match", line: `The sponsor's ${formatUsd(t.matchAmount)} USDC match is owed back to the sponsor.` });
  }
  if (s.bonusIn && !s.bonusReturned) {
    const amount = s.outcome === Outcome.Missed ? t.bonusPool - s.bonusPaid : t.bonusPool;
    if (amount > 0n) dues.push({ side: 2, button: "Return the bonus", line: `${formatUsd(amount)} USDC of bonus that was not paid out is owed back to ${t.bonusFromRecipient ? "the recipient" : "the sponsor"}.` });
  }
  return dues;
}

const SETTLE_NOTE: Record<PaceState, string> = {
  prompt: "The keeper usually does it within seconds.",
  behind: "The keeper is behind the chain right now, so it waits for someone to press this.",
  down: "The keeper is not answering right now, so it waits for someone to press this.",
};
const DUES_NOTE: Record<PaceState, string> = {
  prompt: "The keeper usually does it within seconds.",
  behind: "The keeper is behind the chain right now, so they wait for someone to press them.",
  down: "The keeper is not answering right now, so they wait for someone to press them.",
};
const REFUNDS_NOTE: Record<PaceState, string> = {
  prompt: "The keeper usually sends it first, within seconds.",
  behind: "The keeper is behind the chain right now, so it may not send it first.",
  down: "The keeper is not answering right now.",
};

export const CONTROL = "Nobody controls this contract. It has no owner, no upgrade and no pause; the rules on this page are all it can do.";

const STATUS: Record<Phase, string> = {
  waiting: "Opens soon",
  early: "Early bonus open",
  open: "Open",
  ended: "Waiting to be settled",
  // funded and missed are decided in campaignPage from the contract's own paid flags, not here.
  funded: "Funded",
  missed: "Missed",
  void: "Void",
};

/** "10" for 1000 basis points, "2.5" for 250. */
export function percentOf(bps: number): string {
  return bps % 100 === 0 ? String(bps / 100) : (bps / 100).toFixed(2).replace(/0$/, "");
}

function promiseOf(c: CampaignView, phase: Phase, now: bigint): string {
  const { terms: t, state: s } = c;
  switch (phase) {
    case "funded":
      // "went" only where the contract's own flag says the recipient has been paid.
      return `The target was met. ${formatUsd(s.pledged + t.matchAmount)} USDC ${s.recipientPaid ? "went" : "goes"} to the recipient${t.matchAmount > 0n ? `, the sponsor's ${formatUsd(t.matchAmount)} match included` : ""}.`;
    case "missed":
      // The bonus is promised only where the contract recorded one for the early backers.
      return s.bonusPaid > 0n
        ? "The goal was missed. Every pledge goes back to its backer, and early backers share the bonus."
        : "The goal was missed. Every pledge goes back to its backer.";
    case "void":
      return "A pot was not locked before the campaign opened, so no pledge was taken.";
    case "ended":
      return endsAs(t, s, now) === "void"
        ? "A pot was not locked before the campaign opened, so it takes no pledges. Once it is closed, whatever the sponsor did lock goes back."
        : `The deadline passed short of the target. Once it is settled, every pledge goes back to its backer${t.bonusPool > 0n ? ", and early backers share the bonus" : ""}.`;
    default: {
      const met = t.matchAmount > 0n ? `the sponsor's ${formatUsd(t.matchAmount)} USDC match is added and everything goes to the recipient` : "everything goes to the recipient";
      const missed = t.bonusPool > 0n ? `every pledge comes back in full, and early backers split a bonus of up to ${formatUsd(t.bonusPool)} USDC` : "every pledge comes back in full";
      return `If the target is met, ${met}. If it is missed, ${missed}.`;
    }
  }
}

function rowsOf(c: CampaignView): Row[] {
  const { terms: t, state: s } = c;
  const locked = (yes: boolean) => (yes ? "locked in the contract" : "not locked yet");
  const rows: Row[] = [
    { label: "Target", value: `${formatUsd(t.target)} USDC` },
    { label: "Smallest pledge", value: `${formatUsd(t.minPledge)} USDC` },
    { label: "Sponsor's match", value: t.matchAmount > 0n ? `${formatUsd(t.matchAmount)} USDC, ${locked(s.matchIn)}` : "None" },
    {
      label: "Bonus pool",
      value: t.bonusPool > 0n ? `${formatUsd(t.bonusPool)} USDC from ${t.bonusFromRecipient ? "the recipient" : "the sponsor"}, ${locked(s.bonusIn)}` : "None",
    },
  ];
  if (t.bonusPool > 0n) {
    rows.push({
      label: "Early bonus",
      value: `Up to ${percentOf(t.rateBps)}% of an early pledge, more the more of the target is pledged early. ${
        t.linearWeight ? "Worth most at opening, falling to nothing by the end of the early window." : "The same for every pledge in the early window."
      }`,
    });
  }
  rows.push(
    { label: "Opens", value: utcStamp(t.opensAt) },
    { label: "Early window ends", value: utcStamp(t.earlyUntil) },
    { label: "Closes", value: utcStamp(t.closesAt) },
    { label: "Paid to", value: short(t.recipient), address: t.recipient },
    { label: "Sponsor", value: short(s.sponsor), address: s.sponsor },
  );
  return rows;
}

export function campaignPage(o: {
  campaign: CampaignView;
  labels: readonly Label[];
  desk: Address | null;
  now: bigint;
  block: bigint;
  /** How the keeper stands against the chain at this read. Only when it is prompt does a sentence say it is about to act. */
  pace?: PaceState;
}): CampaignPage {
  const c = o.campaign;
  const pace = o.pace ?? "prompt";
  const dues = duesOf(c);
  const { terms: t, state: s } = c;
  const phase = phaseOf(t, s, o.now);
  const p = progressOf(t, s);
  const taking = phase === "early" || phase === "open";
  // "paid" appears only where a contract flag says so; nothing claims a backer was paid before it.
  const status =
    phase === "waiting" && !p.potsIn
      ? "Waiting for the sponsor"
      : phase === "early" && t.bonusPool === 0n
        ? "Open"
        : phase === "funded"
          ? s.recipientPaid
            ? "Funded and paid to the recipient"
            : "Funded: owed to the recipient"
          : phase === "missed"
            ? "Missed: pledges go back"
            : STATUS[phase];
  return {
    name: nameOf(o.labels, c, o.desk),
    phase,
    status,
    clock: clockLine(t, s, o.now),
    raised: `${formatUsd(p.pledged)} of ${formatUsd(p.target)} USDC`,
    percent: p.percent,
    // "to go" only while the campaign can still take a pledge (or has yet to open).
    gap:
      p.gap === 0n
        ? "Target met"
        : phase === "void" || (phase === "ended" && endsAs(t, s, o.now) === "void")
          ? "Never opened"
          : phase === "missed" || phase === "ended"
            ? `Ended ${formatUsd(p.gap)} USDC short of the target`
            : `${formatUsd(p.gap)} USDC to go`,
    backers: s.backers === 0 ? "No backers yet" : s.backers === 1 ? "1 backer" : `${s.backers} backers`,
    promise: promiseOf(c, phase, o.now),
    rows: rowsOf(c),
    pledgeHref: taking ? hrefFor({ page: "pledge", id: c.id }) : null,
    pledgeWhy: taking ? null : phase === "waiting" ? "It takes pledges once it opens." : "This campaign is no longer taking pledges.",
    settle:
      phase === "ended"
        ? {
            button: "Settle this campaign",
            note: `Anyone can do this, and it can only do what the rules say. ${SETTLE_NOTE[pace]}`,
          }
        : null,
    dues,
    duesNote: dues.length === 0 ? null : `Anyone can send these, and each can only pay the address the contract names. ${DUES_NOTE[pace]}`,
    refunds: phase === "missed" ? `A backer can send their own refund from this page with their wallet connected. ${REFUNDS_NOTE[pace]}` : null,
    control: CONTROL,
    asOf: `As of block ${o.block}`,
  };
}

/**
 * The voucher's lines for the backer looking at it, once their pledge has ended and nothing is
 * left for them to send: the sentence is My money's own. A pledge that came back is marked, so the
 * page can set it in the one colour that means that. A refund still owed has its own line and
 * button, and a pledge still counted has the cheque, so both say nothing here.
 */
export function voucherMine(row: MineRow | null): { label: string; line: string; cameBack: boolean } | null {
  if (row === null || row.send !== null) return null;
  if (row.kind !== "returned" && row.kind !== "given") return null;
  return { label: "Your pledge", line: row.line, cameBack: row.kind === "returned" };
}

/** A campaign number the contract does not have. */
export function noSuchCampaign(id: bigint, count: bigint): { title: string; line: string; homeHref: string } {
  const line = count === 0n ? "This contract has no campaigns yet." : count === 1n ? "This contract has one campaign, number 1." : `This contract has campaigns 1 to ${count}.`;
  return { title: `There is no campaign ${id}`, line, homeHref: hrefFor({ page: "home" }) };
}

/**
 * A campaign number that is not among those read. A number the contract has (an old campaign, read
 * on its own at the next read) or one the desk has just opened is on its way, not missing.
 */
export function missingPage(o: { id: bigint; count: bigint; expected: boolean }): { loading: boolean; title: string; line: string; homeHref: string } {
  if (o.expected || (o.id >= 1n && o.id <= o.count)) return { loading: true, title: `Reading campaign ${o.id}`, line: "", homeHref: hrefFor({ page: "home" }) };
  return { loading: false, ...noSuchCampaign(o.id, o.count) };
}

/** An address the app does not understand. What was asked for is shown as plain text, cut short. */
export function lostPage(hash: string): { title: string; line: string; homeHref: string } {
  const asked = hash.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80);
  return { title: "Nothing is at this address", line: asked === "" ? "" : `You asked for ${asked}`, homeHref: hrefFor({ page: "home" }) };
}
