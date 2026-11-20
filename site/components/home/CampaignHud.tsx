"use client";

import { useEffect, useRef } from "react";
import { campaignAt, demoCampaign, story } from "@/lib/story";

const usd = (n: number) => Math.round(n).toLocaleString("en-US");

const STATUS = {
  waiting: { label: "Waiting for a first backer", color: "var(--color-mist)" },
  live: { label: "Live", color: "var(--color-glow)" },
  met: { label: "Goal met", color: "var(--color-met)" },
  missed: { label: "Goal missed · refunds sent", color: "var(--color-missed)" },
} as const;

/** Small live card that narrates the island's numbers as you scroll. */
export default function CampaignHud() {
  const pledged = useRef<HTMLSpanElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const backers = useRef<HTMLSpanElement>(null);
  const early = useRef<HTMLSpanElement>(null);
  const status = useRef<HTMLSpanElement>(null);
  const dot = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    let last = "";
    const tick = () => {
      const c = campaignAt(story.p);
      const shown = c.status === "met" ? demoCampaign.goal : c.status === "missed" ? 0 : c.pledged;
      const key = `${Math.round(shown)}|${c.backers}|${c.early}|${c.status}`;
      if (key !== last) {
        last = key;
        if (pledged.current) pledged.current.textContent = usd(shown);
        if (bar.current) bar.current.style.transform = `scaleX(${Math.min(shown / demoCampaign.goal, 1)})`;
        if (backers.current) backers.current.textContent = String(c.backers);
        if (early.current) early.current.textContent = String(c.early);
        const st = STATUS[c.status];
        if (status.current) status.current.textContent = st.label;
        if (dot.current) dot.current.style.background = st.color;
        if (bar.current) bar.current.style.background = c.status === "met" ? "var(--color-met)" : "var(--color-paper)";
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <aside className="fixed bottom-8 right-8 z-20 hidden w-[272px] rounded-[6px] border border-line bg-charcoal/80 p-4 backdrop-blur-md md:block">
      <div className="flex items-center gap-2 text-[13px] text-paper">
        <span ref={dot} className="inline-block h-1.5 w-1.5 rounded-full" />
        <span ref={status}>Live</span>
      </div>
      <p className="mt-2 font-serif text-xl leading-tight text-paper">{demoCampaign.name}</p>
      <p className="mt-1 text-[13px] text-mist">Sponsored by {demoCampaign.sponsor}</p>
      <div className="mt-5 flex items-baseline justify-between font-mono text-[13px] text-paper">
        <span>
          $<span ref={pledged}>0</span>
        </span>
        <span className="text-mist">of ${usd(demoCampaign.goal)}</span>
      </div>
      <div className="mt-2 h-[3px] w-full bg-line">
        <div ref={bar} className="h-full origin-left bg-paper transition-transform duration-500" style={{ transform: "scaleX(0)" }} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 font-mono text-[12px]">
        <div>
          <p className="text-mist">Backers</p>
          <p className="mt-0.5 text-paper"><span ref={backers}>0</span></p>
        </div>
        <div>
          <p className="text-mist">Early</p>
          <p className="mt-0.5 text-paper"><span ref={early}>0</span></p>
        </div>
      </div>
      <p className="mt-4 border-t border-line pt-3 text-[12px] text-mist">Each figure is 0.5% of the goal.</p>
    </aside>
  );
}
