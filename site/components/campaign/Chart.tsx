"use client";

// The climb toward the goal, in the garden palette. Geometry and words come from the shared
// chart view (web/src/views/chart.ts); this file only draws it.
import { useLayoutEffect, useRef, useState } from "react";

import type { LedgerView } from "../../../web/src/data/keeper.ts";
import type { CampaignView } from "../../../web/src/data/load.ts";
import { formatUsd } from "../../../web/src/data/money.ts";
import { axisEnds, chartPaths, chartView, TARGET_LABEL_Y, valueLabelY } from "../../../web/src/views/chart.ts";

const TOP = 22;
const BOTTOM = 22;
const INK = "#2b2719";
const INK2 = "#5a523d";
const LINE = "#cdc1a0";
const GREEN = "#4f6b2c";
const BAND = "rgba(192,138,39,0.14)";

export function Chart({ campaign, ledger, now }: { campaign: CampaignView; ledger: LedgerView | null; now: bigint }) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [tall, setTall] = useState(0);
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const read = () => {
      setWidth(el.clientWidth);
      setTall(el.clientHeight);
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const v = chartView({ campaign, ledger, now });
  const height = Math.max(tall, 120);
  const box = { w: Math.max(width, 1), h: height - TOP - BOTTOM };
  const p = chartPaths(v, box);
  const taking = now < v.closes && now >= v.opens;
  const dotRight = p.nowX < box.w - 90;
  const paceLabelY = Math.min(box.h - 6, (box.h * 88) / box.w + 16);
  const valueY = valueLabelY({ dotRight, open: now < v.closes, nowY: p.nowY, paceLabelY });
  const ends = axisEnds(v.opens, v.closes);
  const label = { fill: INK2, fontSize: 12, fontFamily: "var(--font-sans)" };

  return (
    <figure className="m-0 flex h-full flex-col">
      <div ref={frame} className="min-h-0 w-full flex-1 overflow-hidden">
        {width > 0 ? (
          <svg className="block" width={box.w} height={height} viewBox={`0 ${-TOP} ${box.w} ${height}`} aria-hidden="true" focusable="false">
            {p.band ? (
              <>
                <rect x={p.band.x} y={0} width={p.band.w} height={box.h} fill={BAND} />
                {p.band.w > 70 ? (
                  <text x={p.band.x + 6} y={16} {...label} fill="#8a6418">
                    Early bonus
                  </text>
                ) : null}
              </>
            ) : null}
            <line x1={0} x2={box.w} y1={box.h} y2={box.h} stroke={LINE} />
            {taking ? <path d={p.pace} fill="none" stroke={LINE} strokeWidth={1.5} /> : null}
            {taking ? (
              <text x={box.w - 4} y={paceLabelY} textAnchor="end" {...label}>
                Pace needed
              </text>
            ) : null}
            <line x1={0} x2={box.w} y1={p.targetY} y2={p.targetY} stroke={INK2} strokeWidth={1} />
            <text x={box.w} y={TARGET_LABEL_Y} textAnchor="end" {...label}>
              Goal {formatUsd(v.target)}
            </text>
            {taking ? <line x1={p.nowX} x2={p.nowX} y1={p.band && p.band.w > 70 ? 24 : 0} y2={box.h} stroke={LINE} /> : null}
            {p.climb ? <path d={p.climb} fill="none" stroke={GREEN} strokeWidth={3} strokeLinejoin="round" /> : null}
            <circle cx={p.nowX} cy={p.nowY} r={5} fill={GREEN} stroke="#f4eedd" strokeWidth={2} />
            <text x={dotRight ? p.nowX + 10 : p.nowX - 10} y={valueY} textAnchor={dotRight ? "start" : "end"} {...label} fill={INK}>
              {formatUsd(v.total)}
            </text>
            <text x={0} y={box.h + 18} {...label}>
              {ends.opens}
            </text>
            <text x={box.w} y={box.h + 18} textAnchor="end" {...label}>
              {ends.closes}
            </text>
          </svg>
        ) : null}
      </div>
      <figcaption className="sr-only">{v.summary}</figcaption>
      {v.why ? <p className="mt-1 text-[12px] text-g-ink2">{v.why}</p> : null}
    </figure>
  );
}
