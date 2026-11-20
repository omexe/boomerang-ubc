// The scoreboard at the top of a campaign page: three plates while it takes pledges or waits to
// open, a result and two plates once it is over. Worked out from the contract's terms and state
// only; the component lays it out. Yellow (`live`) marks a figure that is still moving.
import { Outcome } from "../../../packages/kit/src/index.ts";
import type { LedgerView } from "../data/keeper.ts";
import type { CampaignView } from "../data/load.ts";
import { endsAs, phaseOf, progressOf } from "../data/campaign.ts";
import { formatUsd } from "../data/money.ts";
import { utcStamp } from "../data/time.ts";

export type Plate = { key: "togo" | "time" | "bonus" | "opens" | "backers"; caption: string; figure: string; unit: string; live: boolean };
export type BoardResult = { kind: "reached" | "short" | "void"; flag: string; line: string };
export type BoardView = { plates: Plate[]; result: BoardResult | null };

/** A clock on a plate. Precision rises as time falls: days, then hours, then minutes and seconds. */
export function boardTime(seconds: bigint): { figure: string; unit: string } {
  if (seconds <= 0n) return { figure: "0:00", unit: "min" };
  if (seconds < 3_600n) {
    const m = seconds / 60n;
    const s = seconds % 60n;
    return { figure: `${m}:${s.toString().padStart(2, "0")}`, unit: "min" };
  }
  if (seconds < 48n * 3_600n) {
    const h = seconds / 3_600n;
    return { figure: h.toString(), unit: h === 1n ? "hr" : "hrs" };
  }
  const d = seconds / 86_400n;
  return { figure: d.toString(), unit: d === 1n ? "day" : "days" };
}

const backersPlate = (n: number): Plate => ({ key: "backers", caption: "Backers", figure: n.toString(), unit: "", live: false });

export function boardView(o: { campaign: CampaignView; now: bigint }): BoardView {
  const { terms: t, state: s } = o.campaign;
  const phase = phaseOf(t, s, o.now);
  const p = progressOf(t, s);

  if (phase === "waiting" || phase === "early" || phase === "open") {
    const taking = phase !== "waiting";
    const togo: Plate = { key: "togo", caption: "To go", figure: formatUsd(p.gap), unit: "USDC", live: taking };
    const clock: Plate = taking
      ? { key: "time", caption: "Time left", ...boardTime(t.closesAt - o.now), live: false }
      : { key: "opens", caption: "Opens in", ...boardTime(t.opensAt - o.now), live: false };
    const third: Plate =
      phase === "early" && t.bonusPool > 0n
        ? { key: "bonus", caption: "Early bonus ends in", ...boardTime(t.earlyUntil - o.now), live: true }
        : backersPlate(s.backers);
    return { plates: [togo, clock, third], result: null };
  }

  const kind = phase === "funded" ? "reached" : phase === "void" || (phase === "ended" && endsAs(t, s, o.now) === "void") ? "void" : "short";
  const result: BoardResult =
    kind === "void"
      ? { kind, flag: "Never opened", line: "A pot was not locked in time, so no pledge was taken." }
      : { kind, flag: kind === "reached" ? "Cleared" : "Returned", line: `${formatUsd(s.pledged)} of ${formatUsd(t.target)} USDC was pledged.${kind === "short" ? " Every pledge goes back." : ""}` };
  // "13 Nov 2026, 21:20 UTC" splits into the plate's figure and its unit.
  const [day, month, year] = utcStamp(t.closesAt).replace(",", "").split(" ");
  const deadline: Plate = { key: "time", caption: "Deadline", figure: `${day} ${month}`, unit: year ?? "", live: false };
  return { plates: [deadline, backersPlate(s.backers)], result };
}

/** How long before the block an event happened, in the largest whole unit: "2 min ago". */
export function agoLine(then: bigint | null, now: bigint): string | null {
  if (then === null) return null;
  const s = now > then ? now - then : 0n;
  if (s < 60n) return `${s} s ago`;
  if (s < 3_600n) return `${s / 60n} min ago`;
  if (s < 86_400n) {
    const h = s / 3_600n;
    return `${h} ${h === 1n ? "hr" : "hrs"} ago`;
  }
  const d = s / 86_400n;
  return `${d} ${d === 1n ? "day" : "days"} ago`;
}

/** "How long ago" for each ledger event that has a time, keyed by its sequence number as the feed keys its lines. */
export function agoOf(ledger: LedgerView | null, now: bigint): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of ledger?.feed ?? []) {
    const line = agoLine(e.time, now);
    if (line !== null) out.set(e.seq.toString(), line);
  }
  return out;
}

/** A missed campaign's receipt: what goes back, from the contract's recorded total and bonus. */
export function settledLine(c: CampaignView): string | null {
  const s = c.state;
  if (s.outcome !== Outcome.Missed) return null;
  const who = s.backers === 1 ? "1 backer" : `${s.backers} backers`;
  const bonus = s.bonusPaid > 0n ? `, plus ${formatUsd(s.bonusPaid)} USDC of bonus for early backers` : "";
  return `${formatUsd(s.pledged)} USDC goes back to ${who}${bonus}.`;
}
