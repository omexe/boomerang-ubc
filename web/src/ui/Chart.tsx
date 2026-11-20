// The climb, drawn by the page as inline SVG at the size it is shown, so its lettering stays the
// board's size on a phone. Lines differ by dash and weight as well as colour, and each is labelled.
// A screen reader gets the one-sentence summary and a table of the points instead of the drawing.
import { useLayoutEffect, useRef, useState } from "react";

import type { LedgerView } from "../data/keeper.ts";
import type { CampaignView } from "../data/load.ts";
import { formatUsd } from "../data/money.ts";
import { axisEnds, chartPaths, chartView, TARGET_LABEL_Y, valueLabelY } from "../views/chart.ts";

const TOP = 26;
const BOTTOM = 26;
const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

export function Chart({ campaign, ledger, now, raised, backers, live }: { campaign: CampaignView; ledger: LedgerView | null; now: bigint; raised: string; backers: string; live: boolean }) {
  const frame = useRef<HTMLDivElement>(null);
  const last = useRef<SVGPathElement>(null);
  // The frame stretches to the board's row, so the drawing takes the height the receipt beside it sets.
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const read = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const v = chartView({ campaign, ledger, now });
  // Counted only while the climb is drawn: the keeper often lags the contract for a moment after a
  // pledge (no line), and that gap must not reset the count and lose the extension.
  const n = v.points?.length ?? null;
  const [seenN, setSeenN] = useState(n ?? 0);
  const [grew, setGrew] = useState(0);
  if (n !== null && seenN !== n) {
    setSeenN(n);
    if (n > seenN && seenN > 0) setGrew((g) => g + 1);
  }
  useLayoutEffect(() => {
    if (grew === 0 || reduced() || !last.current) return;
    // The newest step starts at its riser, its leftmost point, so growing it from the left extends the
    // line to the new point with a transform alone; the stroke keeps its width while it scales.
    const a = last.current.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 400, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    return () => a.cancel();
  }, [grew]);

  const width = size.width;
  const height = Math.max(size.height, width < 520 ? 190 : 230);
  const box = { w: Math.max(width, 1), h: height - TOP - BOTTOM };
  const p = chartPaths(v, box);
  // The newest step is drawn on its own, so a new pledge can fade in without redrawing the rest.
  let before: string | null = null;
  let newest: string | null = p.climb;
  if (v.points !== null && v.points.length > 0) {
    const lastPoint = v.points[v.points.length - 1];
    const earlier = chartPaths({ ...v, points: v.points.slice(0, -1), now: lastPoint.t }, box);
    const prevV = v.points.length > 1 ? v.points[v.points.length - 2].v : 0n;
    const yOf = (x: bigint) => Math.round((1 - Number(x) / Number(v.target)) * box.h * 10) / 10;
    before = earlier.climb;
    newest = `M${earlier.nowX},${yOf(prevV)} V${yOf(lastPoint.v)} H${p.nowX}`;
  }
  const taking = now < v.closes && now >= v.opens;
  const dotRight = p.nowX < box.w - 90;
  const paceLabelY = Math.min(box.h - 6, (box.h * 88) / box.w + 16);
  const valueY = valueLabelY({ dotRight, open: now < v.closes, nowY: p.nowY, paceLabelY });
  const ends = axisEnds(v.opens, v.closes);

  return (
    <figure className={`chart${live ? " live-total" : ""}`} style={{ margin: 0 }}>
      <div className="chart-head">
        <p className="chart-raised">{raised}</p>
        <p className="chart-backers">{backers}</p>
      </div>
      <div className="chart-frame" ref={frame}>
        {width > 0 ? (
          <svg className="chart-svg" width={box.w} height={height} viewBox={`0 ${-TOP} ${box.w} ${height}`} aria-hidden="true" focusable="false">
            {p.band ? (
              <>
                <rect className="c-band" x={p.band.x} y={0} width={p.band.w} height={box.h} />
                {p.band.w > 70 ? (
                  <text className="c-band-label" x={p.band.x + 6} y={16}>
                    Early bonus
                  </text>
                ) : null}
              </>
            ) : null}
            <line className="c-axis" x1={0} x2={box.w} y1={box.h} y2={box.h} />
            {/* The pace needed means something only while pledges can come in; drawn and labelled then only. */}
            {taking ? <path className="c-pace" d={p.pace} /> : null}
            {/* Under the pace line's end: the line's height at the label's left edge (about 88 px in), plus a line of type. */}
            {taking ? (
              <text className="c-label" x={box.w - 4} y={paceLabelY} textAnchor="end">
                Pace needed
              </text>
            ) : null}
            <line className="c-target" x1={0} x2={box.w} y1={p.targetY} y2={p.targetY} />
            <text className="c-label" x={box.w} y={TARGET_LABEL_Y} textAnchor="end">
              Target {formatUsd(v.target)}
            </text>
            {taking ? <line className="c-now" x1={p.nowX} x2={p.nowX} y1={p.band && p.band.w > 70 ? 24 : 0} y2={box.h} /> : null}
            {before ? <path className="c-climb" d={before} /> : null}
            {newest ? <path className="c-climb c-newest" d={newest} ref={last} /> : null}
            <circle className="c-dot" cx={p.nowX} cy={p.nowY} r={5} />
            <text className="c-label" x={dotRight ? p.nowX + 10 : p.nowX - 10} y={valueY} textAnchor={dotRight ? "start" : "end"}>
              {formatUsd(v.total)}
            </text>
            <text className="c-tick" x={0} y={box.h + 18}>
              {ends.opens}
            </text>
            <text className="c-tick" x={box.w} y={box.h + 18} textAnchor="end">
              {ends.closes}
            </text>
          </svg>
        ) : null}
      </div>
      <figcaption className="sr-only">{v.summary}</figcaption>
      {v.why ? <p className="chart-why">{v.why}</p> : null}
      {v.table.length > 0 ? (
        <table className="sr-only">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Total pledged</th>
            </tr>
          </thead>
          <tbody>
            {v.table.map((r, i) => (
              <tr key={i}>
                <td>{r.when}</td>
                <td>{r.total} USDC</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </figure>
  );
}
