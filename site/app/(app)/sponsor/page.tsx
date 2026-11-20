"use client";

// The sponsor's dashboard: every campaign this account sponsors, with what each needs next.
import Link from "next/link";

import { phaseOf } from "../../../../web/src/data/campaign.ts";
import type { CampaignView } from "../../../../web/src/data/load.ts";
import { formatUsd } from "../../../../web/src/data/money.ts";
import { campaignPage } from "../../../../web/src/views/campaign.ts";
import { AppHeader } from "@/components/app/AppHeader";
import { Breadcrumbs } from "@/components/app/Breadcrumbs";
import { useEngine } from "@/lib/boomerang/engine";
import { isShowcase } from "@/lib/boomerang/showcase";

export default function SponsorPage() {
  const { ctx, wallet } = useEngine();

  const body = () => {
    if (!wallet.account) {
      return (
        <Link href="/login" className="mt-10 inline-flex h-12 items-center gap-3 rounded-[5px] bg-paper px-6 text-[15px] font-medium text-ink hover:bg-glow">
          Log in <span aria-hidden>→</span>
        </Link>
      );
    }
    if (!ctx) return <p className="mt-10 text-[16px] text-paper">Reading the chain…</p>;
    const me = wallet.account.toLowerCase();
    const mine = ctx.world.campaigns.filter((c) => c.state.sponsor.toLowerCase() === me).sort((a, b) => (a.id < b.id ? 1 : -1));
    const examples = ctx.world.campaigns.filter((c) => isShowcase(c.id)).slice(0, 3);
    const locked = mine.reduce((sum, c) => sum + (c.state.matchIn ? c.terms.matchAmount : 0n) + (c.state.bonusIn ? c.terms.bonusPool : 0n), 0n);
    const raised = mine.reduce((sum, c) => sum + c.state.pledged, 0n);
    const live = mine.filter((c) => ["early", "open", "waiting"].includes(phaseOf(c.terms, c.state, ctx.world.now))).length;

    return (
      <>
        <section className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            { label: "Campaigns", value: String(mine.length) },
            { label: "Live", value: String(live) },
            { label: "Raised", value: `${formatUsd(raised)} USDC` },
            { label: "Locked by you", value: `${formatUsd(locked)} USDC` },
          ].map((f) => (
            <div key={f.label} className="rounded-[6px] border border-line p-4">
              <p className="text-[12px] text-mist">{f.label}</p>
              <p className="mt-1 font-serif text-[24px] leading-none text-paper">{f.value}</p>
            </div>
          ))}
        </section>

        <section className="mt-12">
          <h2 className="border-b border-line pb-3 font-serif text-[26px] text-paper">Your campaigns</h2>
          {mine.length === 0 ? <p className="mt-5 text-[15px] text-mist">None yet.</p> : <List items={mine} ctx={ctx} manage />}
        </section>

        {mine.length === 0 && examples.length > 0 ? (
          <section className="mt-12">
            <h2 className="border-b border-line pb-3 font-serif text-[26px] text-paper">Examples</h2>
            <List items={examples} ctx={ctx} manage={false} />
          </section>
        ) : null}
      </>
    );
  };

  return (
    <div className="min-h-screen bg-charcoal">
      <AppHeader tone="dark" />
      <main className="mx-auto max-w-[1040px] px-6 pb-24 pt-8">
        <Breadcrumbs items={[{ label: "Sponsor" }]} tone="dark" />
        <div className="mt-10 flex flex-wrap items-end justify-between gap-6">
          <h1 className="font-serif text-[48px] leading-[1.05] text-paper">Sponsor</h1>
          {wallet.account ? (
            <Link href="/sponsor/new" className="inline-flex h-11 items-center gap-2 rounded-[5px] bg-paper px-5 text-[15px] font-medium text-ink hover:bg-glow">
              New campaign <span aria-hidden>→</span>
            </Link>
          ) : null}
        </div>
        {body()}
      </main>
    </div>
  );
}

function nextStep(c: CampaignView, now: bigint): string | null {
  const phase = phaseOf(c.terms, c.state, now);
  const s = c.state;
  const t = c.terms;
  if (phase === "waiting" && ((t.matchAmount > 0n && !s.matchIn) || (t.bonusPool > 0n && !s.bonusIn && !t.bonusFromRecipient))) return "Lock the pots";
  if (phase === "ended") return "Settle";
  return null;
}

function List({ items, ctx, manage }: { items: CampaignView[]; ctx: NonNullable<ReturnType<typeof useEngine>["ctx"]>; manage: boolean }) {
  return (
    <ul className="divide-y divide-line">
      {items.map((c) => {
        const page = campaignPage({ campaign: c, labels: ctx.labels, desk: ctx.config.desk, now: ctx.world.now, block: ctx.world.block });
        const step = manage ? nextStep(c, ctx.world.now) : null;
        return (
          <li key={c.id.toString()}>
            <Link href={manage ? `/sponsor/${c.id}` : `/campaign/${c.id}`} className="flex flex-wrap items-center justify-between gap-4 py-4 hover:bg-smoke/40">
              <div className="min-w-0">
                <p className="font-serif text-[21px] text-paper">{page.name.title}</p>
                <p className="text-[13px] text-mist">
                  {page.status} · {page.raised}
                </p>
              </div>
              {step ? <span className="rounded-[4px] border border-glow px-2 py-0.5 text-[12px] text-glow">{step}</span> : <span className="text-[14px] text-mist">{manage ? "Manage →" : "View →"}</span>}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
