"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { phaseOf, type Phase } from "../../../../web/src/data/campaign.ts";
import type { CampaignView } from "../../../../web/src/data/load.ts";
import { formatUsd } from "../../../../web/src/data/money.ts";
import { campaignPage } from "../../../../web/src/views/campaign.ts";
import { AppHeader } from "@/components/app/AppHeader";
import { useEngine } from "@/lib/boomerang/engine";

const TAG: Record<Phase, string> = {
  early: "border-glow text-glow",
  open: "border-paper text-paper",
  waiting: "border-line text-mist",
  ended: "border-glow text-glow",
  funded: "border-met text-met",
  missed: "border-missed text-missed",
  void: "border-line text-mist",
};

export default function ExplorePage() {
  const { ctx, readFailed, problem } = useEngine();
  const router = useRouter();
  const [desk, setDesk] = useState<{ busy: boolean; line: string | null; ok: boolean }>({ busy: false, line: null, ok: false });

  const startDemo = (kind: "two" | "ten") => {
    if (!ctx || desk.busy) return;
    setDesk({ busy: true, line: null, ok: false });
    void ctx.askForCampaign(kind).then((a) => {
      setDesk({ busy: false, line: a.line, ok: a.ok });
      if (a.ok && a.id !== null) {
        ctx.expect(a.id);
        ctx.refresh();
        router.push(`/campaign/${a.id}`);
      }
    });
  };

  if (!ctx) {
    return (
      <div className="min-h-screen bg-charcoal">
        <AppHeader tone="dark" />
        <main className="mx-auto max-w-[1240px] px-6 pt-16 text-[16px] text-paper">{problem ?? (readFailed ? "The chain could not be read. Trying again…" : "Reading the chain…")}</main>
      </div>
    );
  }

  const { world, config } = ctx;
  const now = world.now;
  const rank = (c: CampaignView) => {
    const p = phaseOf(c.terms, c.state, now);
    return p === "early" ? 0 : p === "open" ? 1 : p === "ended" ? 2 : p === "waiting" ? 3 : 4;
  };
  const sorted = [...world.campaigns].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? 1 : -1));
  const live = sorted.filter((c) => rank(c) <= 2);
  const soon = sorted.filter((c) => rank(c) === 3);
  const settled = sorted.filter((c) => rank(c) === 4);
  const canDemo = ctx.desk !== null && config.desk !== null;

  return (
    <div className="min-h-screen bg-charcoal">
      <AppHeader tone="dark" />
      <main className="mx-auto max-w-[1240px] px-6 pb-24 pt-12">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-[48px] leading-[1.05] text-paper">Explore campaigns</h1>
            <p className="mt-3 text-[16px] text-paper">
              {world.count.toString()} campaigns on Arc Testnet. Every figure is read from the contract.
            </p>
          </div>
          {canDemo ? (
            <div className="flex flex-col items-end gap-2">
              <button
                type="button"
                onClick={() => startDemo("two")}
                disabled={desk.busy}
                className="inline-flex h-11 items-center gap-2 rounded-[5px] bg-paper px-5 text-[15px] font-medium text-ink hover:bg-glow disabled:bg-line disabled:text-mist"
              >
                {desk.busy ? "Opening…" : "Start a 2-minute demo campaign"} <span aria-hidden>→</span>
              </button>
              <button type="button" onClick={() => startDemo("ten")} disabled={desk.busy} className="text-[13px] text-mist hover:text-paper">
                or a 10-minute one
              </button>
            </div>
          ) : null}
        </div>
        {desk.line && !desk.ok ? <p className="mt-4 rounded-[6px] border border-missed px-4 py-3 text-[14px] text-missed">{desk.line}</p> : null}

        <Section title="Live now" empty={canDemo ? "Nothing is taking pledges right now. Start a demo campaign to watch one run." : "Nothing is taking pledges right now."} items={live} ctx={ctx} />
        {soon.length > 0 ? <Section title="Opening soon" items={soon} ctx={ctx} /> : null}
        <Section title="Settled" empty="No campaign has settled yet." items={settled} ctx={ctx} />
      </main>
    </div>
  );
}

function Section({ title, items, ctx, empty }: { title: string; items: CampaignView[]; ctx: NonNullable<ReturnType<typeof useEngine>["ctx"]>; empty?: string }) {
  return (
    <section className="mt-14">
      <h2 className="border-b border-line pb-3 font-serif text-[26px] text-paper">{title}</h2>
      {items.length === 0 ? (
        <p className="mt-5 text-[15px] text-mist">{empty}</p>
      ) : (
        <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {items.map((c) => (
            <Card key={c.id.toString()} c={c} ctx={ctx} />
          ))}
        </div>
      )}
    </section>
  );
}

function Card({ c, ctx }: { c: CampaignView; ctx: NonNullable<ReturnType<typeof useEngine>["ctx"]> }) {
  const { world, config, labels } = ctx;
  const page = campaignPage({ campaign: c, labels, desk: config.desk, now: world.now, block: world.block });
  const pct = Math.min(page.percent, 100);
  const bar = page.phase === "funded" ? "bg-met" : page.phase === "missed" ? "bg-missed" : "bg-paper";
  return (
    <Link href={`/campaign/${c.id}`} className="group flex flex-col rounded-[6px] border border-line bg-smoke/50 p-5 transition-colors hover:border-paper">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate font-serif text-[22px] leading-tight text-paper">{page.name.title}</p>
          <p className="mt-1 truncate text-[13px] text-mist">{page.name.by}</p>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/island.png" alt="" className="pixelated h-12 w-14 shrink-0 object-contain" />
      </div>
      <span className={`mt-4 self-start rounded-[4px] border px-2 py-0.5 text-[12px] ${TAG[page.phase]}`}>{page.status}</span>
      <div className="mt-5 flex items-baseline justify-between font-mono text-[13px]">
        <span className="text-paper">{page.raised}</span>
        <span className="text-mist">{page.percent}%</span>
      </div>
      <div className="mt-2 h-[3px] w-full rounded-full bg-line">
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-4 text-[13px] text-paper">{page.clock}</p>
      <p className="mt-1 text-[13px] text-mist">
        {formatUsd(c.terms.matchAmount)} USDC match · {formatUsd(c.terms.bonusPool)} USDC bonus
      </p>
    </Link>
  );
}
