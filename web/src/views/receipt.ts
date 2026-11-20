// The pledge box's receipt: the two outcomes of one pledge, side by side, before it is sent.
// Built from the form's quote (the contract's own answer once it arrives), never from new sums.
import type { CampaignView } from "../data/load.ts";
import { about, formatUsd } from "../data/money.ts";
import type { PledgeForm } from "./pledge.ts";

export type Half = { heading: string; figure: string; line: string };
export type ReceiptView = { kind: "two"; met: Half; missed: Half & { live: boolean } } | { kind: "completes"; line: string } | { kind: "none"; line: string };

export function receiptView(o: { form: PledgeForm; campaign: CampaignView }): ReceiptView {
  const q = o.form.quote;
  if (q === null || q.kind === "refused" || o.form.amount === null) return { kind: "none", line: o.form.line };
  if (q.kind === "completes") return { kind: "completes", line: q.line };

  const match = o.campaign.terms.matchAmount;
  const met: Half = {
    heading: "If the target is met",
    figure: `${formatUsd(q.counted)} USDC`,
    line: match > 0n ? `goes to the recipient, and the sponsor adds its ${formatUsd(match)} USDC match.` : "goes to the recipient.",
  };
  const line =
    q.bonus > 0n
      ? `comes back to you: your ${formatUsd(o.form.amount)} plus ${about(q.bonus)}${q.early ? " for backing early" : ""}.`
      : q.early
        ? "comes back to you in full."
        : "comes back to you in full. The early bonus window has closed.";
  return { kind: "two", met, missed: { heading: "If it falls short", figure: `${formatUsd(q.back)} USDC`, line, live: q.early && q.bonus > 0n } };
}

/**
 * What the cheque shows. While a pledge is on its way it keeps what it showed when the pledge was
 * pressed. The chain moves under a pledge being sent (the pledge itself is counted, the balance
 * falls), and working the amount still typed out again against that reads as a second pledge.
 *
 * `kept` is what this cheque last showed while nothing was being sent, with the campaign it was
 * for. One form serves every campaign's page, so what it kept for another campaign is not used;
 * and a cheque first opened while its pledge is already on its way has nothing kept. In both
 * cases it shows the form as it is now and `held` is false.
 */
export function shownWhileSending<T>(o: { busy: boolean; id: bigint; kept: { id: bigint; shown: T } | null; now: T }): { shown: T; held: boolean } {
  if (o.busy && o.kept !== null && o.kept.id === o.id) return { shown: o.kept.shown, held: true };
  return { shown: o.now, held: false };
}
