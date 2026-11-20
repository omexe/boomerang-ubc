// The campaign's climb from opening to now, against the target and the steady pace needed to reach
// it. The figures come from the contract; the climb line comes from the keeper's ledger and is drawn
// only when the ledger's sum is exactly the contract's total, so a partial or wrong record is never
// drawn as if it were the campaign.
import { phaseOf } from "../data/campaign.ts";
import type { LedgerView } from "../data/keeper.ts";
import type { CampaignView } from "../data/load.ts";
import { formatUsd } from "../data/money.ts";
import { utcStamp } from "../data/time.ts";

export type Point = { t: bigint; v: bigint };
export type ChartView = {
  opens: bigint;
  closes: bigint;
  early: { from: bigint; to: bigint } | null;
  target: bigint;
  now: bigint;
  /** The contract's total; the now marker and every figure use this, never the ledger's. */
  total: bigint;
  points: Point[] | null;
  /** Why no climb is drawn; empty when it is. */
  why: string;
  summary: string;
  table: { when: string; total: string }[];
};

const STEPS = new Set(["Pledged", "Rescued"]);
const amountOf = (v: unknown): bigint | null => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null);

/** The running total of a campaign's pledges and rescue, in ledger order, or null if it cannot be trusted. */
export function climbOf(ledger: LedgerView | null, id: bigint, pledged: bigint): Point[] | null {
  if (ledger === null) return null;
  const steps = ledger.feed.filter((e) => e.id === id && STEPS.has(e.name)).sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  const out: Point[] = [];
  let sum = 0n;
  for (const e of steps) {
    const amount = amountOf(e.args.amount);
    if (e.time === null || amount === null) return null;
    sum += amount;
    out.push({ t: e.time, v: sum });
  }
  return sum === pledged ? out : null;
}

export function chartView(o: { campaign: CampaignView; ledger: LedgerView | null; now: bigint }): ChartView {
  const { id, terms: t, state: s } = o.campaign;
  const points = climbOf(o.ledger, id, s.pledged);
  const why = points !== null ? "" : o.ledger === null ? "The keeper is not answering, so the climb is not drawn." : "The keeper's record does not match the contract yet, so the climb is not drawn.";
  const early = t.bonusPool > 0n && t.earlyUntil > t.opensAt ? { from: t.opensAt, to: t.earlyUntil < t.closesAt ? t.earlyUntil : t.closesAt } : null;

  const phase = phaseOf(t, s, o.now);
  let summary = `${formatUsd(s.pledged)} of ${formatUsd(t.target)} USDC pledged`;
  if (phase === "early" || phase === "open") {
    // The steady pace: the share of the target that a straight line from opening to deadline has reached by now.
    const pace = (t.target * (o.now - t.opensAt)) / (t.closesAt - t.opensAt);
    summary += s.pledged >= pace ? ", ahead of the steady pace to the target" : ", behind the steady pace to the target";
  }
  summary += ".";

  const table = (points ?? []).map((p) => ({ when: utcStamp(p.t), total: formatUsd(p.v) }));
  return { opens: t.opensAt, closes: t.closesAt, early, target: t.target, now: o.now, total: s.pledged, points, why, summary, table };
}

const r = (n: number) => Math.round(n * 10) / 10;

/** SVG geometry in a box `w` wide and `h` tall: y is 0 at the target and `h` at nothing. */
export function chartPaths(v: ChartView, box: { w: number; h: number }) {
  const span = Number(v.closes - v.opens);
  const clamp = (t: bigint) => (t < v.opens ? v.opens : t > v.closes ? v.closes : t);
  const x = (t: bigint) => r((Number(clamp(t) - v.opens) / span) * box.w);
  const y = (amount: bigint) => {
    const share = Number(amount > v.target ? v.target : amount) / Number(v.target);
    return r((1 - share) * box.h);
  };
  const nowX = x(v.now);
  let climb: string | null = null;
  if (v.points !== null) {
    const parts = [`M0,${r(box.h)}`];
    for (const p of v.points) parts.push(`H${x(p.t)}`, `V${y(p.v)}`);
    parts.push(`H${nowX}`);
    climb = parts.join(" ");
  }
  const band = v.early === null ? null : { x: x(v.early.from), w: r(x(v.early.to) - x(v.early.from)) };
  return { climb, pace: `M0,${r(box.h)} L${r(box.w)},0`, targetY: 0, band, nowX, nowY: y(v.total) };
}

/** The baseline of TARGET's label, which is set flush right above the target line. */
export const TARGET_LABEL_Y = -8;

/**
 * The baseline of the total's label. Beside its point it sits just above it. At the right end it
 * is set to the left of the point, where it would land on TARGET when the total is near the
 * target, and on PACE NEEDED while pledges can still come in; there it goes under the point.
 */
export function valueLabelY(o: { dotRight: boolean; open: boolean; nowY: number; paceLabelY: number }): number {
  const above = o.nowY - 8;
  if (o.dotRight) return above;
  const onTarget = above < TARGET_LABEL_Y + 16;
  const onPace = o.open && above < o.paceLabelY + 16;
  return onTarget || onPace ? o.nowY + 20 : above;
}

/**
 * The words at the two ends of the time axis. A campaign whose two ends fall on one UTC day (the
 * desk's short ones, nearly always) is marked by the time of day, since the same date twice says
 * nothing. Any other is marked by the day, and by the year as well when its ends are in
 * different years.
 */
export function axisEnds(opens: bigint, closes: bigint): { opens: string; closes: string } {
  const [a, b] = [utcStamp(opens), utcStamp(closes)]; // "19 Nov 2026, 01:25 UTC"
  const [dayA, timeA] = a.split(", ");
  const [dayB, timeB] = b.split(", ");
  // A date the page cannot read has no time of day: each end is said as it stands.
  if (timeA === undefined || timeB === undefined) return { opens: `Opens ${dayA}`, closes: `Closes ${dayB}` };
  if (dayA === dayB) return { opens: `Opens ${timeA}`, closes: `Closes ${timeB}` };
  const sameYear = dayA.split(" ")[2] === dayB.split(" ")[2];
  const day = (d: string) => (sameYear ? d.split(" ").slice(0, 2).join(" ") : d);
  return { opens: `Opens ${day(dayA)}`, closes: `Closes ${day(dayB)}` };
}
