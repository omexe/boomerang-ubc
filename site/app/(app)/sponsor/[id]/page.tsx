"use client";

// One sponsored campaign, from the sponsor's side: where it stands on its timeline, its numbers,
// and the one or two things the sponsor can do next (lock the pots, close the gap, settle, pay out).
import Link from "next/link";
import { useParams } from "next/navigation";

import { campaignIn, ownIn } from "../../../../../web/src/app/world.ts";
import { phaseOf } from "../../../../../web/src/data/campaign.ts";
import { formatUsd } from "../../../../../web/src/data/money.ts";
import { utcStamp } from "../../../../../web/src/data/time.ts";
import { finalizeCall, paySideCall } from "../../../../../web/src/flows/calls.ts";
import { boardTime } from "../../../../../web/src/views/board.ts";
import { campaignPage } from "../../../../../web/src/views/campaign.ts";
import { AppHeader } from "@/components/app/AppHeader";
import { Breadcrumbs } from "@/components/app/Breadcrumbs";
import { SendStatus } from "@/components/app/ui";
import { useEngine, useShownCampaign } from "@/lib/boomerang/engine";
import { lockCalls, rescueCalls } from "@/lib/boomerang/sponsor";

const btn = "inline-flex h-11 items-center gap-2 rounded-[5px] bg-paper px-5 text-[15px] font-medium text-ink hover:bg-glow disabled:bg-line disabled:text-mist";
const btnLine = "inline-flex h-10 items-center rounded-[5px] border border-paper px-4 text-[14px] text-paper hover:border-glow hover:text-glow disabled:border-line disabled:text-mist";

function left(seconds: bigint) {
  const t = boardTime(seconds);
  return t.unit === "min" ? `${t.figure}` : `${t.figure} ${t.unit}`;
}

export default function ManagePage() {
  const { id: raw } = useParams<{ id: string }>();
  const id = /^[1-9][0-9]{0,17}$/.test(raw) ? BigInt(raw) : 0n;
  useShownCampaign(id);
  const { ctx, wallet } = useEngine();
  const campaign = ctx ? campaignIn(ctx.world, id) : undefined;
  const page = ctx && campaign ? campaignPage({ campaign, labels: ctx.labels, desk: ctx.config.desk, now: ctx.world.now, block: ctx.world.block }) : null;

  const body = () => {
    if (!ctx) return <p className="mt-10 text-[16px] text-paper">Reading the chain…</p>;
    if (!campaign || !page) return <p className="mt-10 text-[16px] text-paper">Looking for campaign {id.toString()}…</p>;
    const { world, config } = ctx;
    const { terms: t, state: s } = campaign;
    const now = world.now;
    const phase = phaseOf(t, s, now);
    const isMine = wallet.account !== null && s.sponsor.toLowerCase() === wallet.account.toLowerCase();
    const own = ownIn(world, wallet.account);
    const allowance = own.allowance ?? 0n;

    const needMatch = t.matchAmount > 0n && !s.matchIn ? t.matchAmount : null;
    const needBonus = t.bonusPool > 0n && !s.bonusIn && !t.bonusFromRecipient ? t.bonusPool : null;
    const gap = t.target > s.pledged ? t.target - s.pledged : 0n;
    const taking = phase === "early" || phase === "open";

    const steps = [
      { label: "Created", at: null as bigint | null, done: true },
      { label: "Pots locked", at: null, done: s.matchIn || t.matchAmount === 0n ? s.bonusIn || t.bonusPool === 0n : false },
      { label: "Opens", at: t.opensAt, done: now >= t.opensAt },
      { label: "Early window ends", at: t.earlyUntil, done: now >= t.earlyUntil },
      { label: "Closes", at: t.closesAt, done: now >= t.closesAt || phase === "funded" },
      { label: phase === "missed" ? "Missed" : phase === "void" ? "Void" : "Funded", at: null, done: phase === "funded" || phase === "missed" || phase === "void" },
    ];

    return (
      <>
        <div className="mt-10 flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="text-[14px] text-mist">{page.status}</p>
            <h1 className="mt-1 font-serif text-[44px] leading-[1.05] text-paper">{page.name.title}</h1>
          </div>
          <Link href={`/campaign/${id}`} className="text-[14px] text-paper underline underline-offset-4 hover:text-glow">
            Public page →
          </Link>
        </div>

        {/* timeline */}
        <ol className="mt-10 grid grid-cols-3 gap-y-6 border-y border-line py-6 md:grid-cols-6">
          {steps.map((st) => (
            <li key={st.label} className="pr-4">
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${st.done ? "bg-met" : "border border-mist"}`} />
              <p className={`mt-2 text-[14px] ${st.done ? "text-paper" : "text-mist"}`}>{st.label}</p>
              {st.at !== null ? <p className="text-[12px] text-mist">{now < st.at ? `in ${left(st.at - now)}` : utcStamp(st.at)}</p> : null}
            </li>
          ))}
        </ol>

        {/* numbers */}
        <dl className="mt-8 grid grid-cols-2 gap-6 md:grid-cols-5">
          {[
            { label: "Raised", value: formatUsd(s.pledged) },
            { label: "Goal", value: formatUsd(t.target) },
            { label: "Backers", value: String(s.backers) },
            { label: "Match", value: formatUsd(t.matchAmount), note: s.matchIn ? null : "not locked" },
            { label: "Bonus", value: formatUsd(t.bonusPool), note: s.bonusIn ? null : "not locked" },
          ].map((f) => (
            <div key={f.label}>
              <dt className="text-[12px] text-mist">{f.label}</dt>
              <dd className="mt-1 font-serif text-[26px] leading-none text-paper">{f.value}</dd>
              {"note" in f && f.note ? <dd className="mt-1.5 text-[12px] text-glow">{f.note}</dd> : null}
            </div>
          ))}
        </dl>

        {/* next actions */}
        {isMine ? (
          <section className="mt-12 space-y-8">
            {phase === "waiting" && (needMatch || needBonus) ? (
              <Action
                title="Lock the match and bonus"
                note={`${formatUsd((needMatch ?? 0n) + (needBonus ?? 0n))} USDC · opens in ${left(t.opensAt - now)}`}
                button="Lock"
                k={`lock:${id}`}
                onClick={() => void ctx.send(`lock:${id}`, lockCalls({ boomerang: config.boomerang, usdc: config.usdc, id, match: needMatch, bonus: needBonus, allowance }))}
              />
            ) : null}
            {taking && gap > 0n ? (
              <Action
                title="Close the gap"
                note={`${formatUsd(gap)} USDC funds it now`}
                button="Close the gap"
                line
                k={`rescue:${id}`}
                onClick={() => void ctx.send(`rescue:${id}`, rescueCalls({ boomerang: config.boomerang, usdc: config.usdc, id, gap, allowance }))}
              />
            ) : null}
            {page.settle ? <Action title="Settle" note="The deadline has passed." button="Settle" k={`settle:${id}`} onClick={() => void ctx.send(`settle:${id}`, [finalizeCall({ boomerang: config.boomerang, id })])} /> : null}
            {page.dues.map((d) => (
              <Action
                key={d.side}
                title={d.button}
                note={d.line}
                button={d.button}
                line
                k={`side:${id}:${d.side}`}
                onClick={() => void ctx.send(`side:${id}:${d.side}`, [paySideCall({ boomerang: config.boomerang, id, side: d.side, label: d.button })])}
              />
            ))}
          </section>
        ) : (
          <p className="mt-12 text-[14px] text-mist">Only the sponsor can manage this campaign.</p>
        )}
      </>
    );
  };

  function Action({ title, note, button, k, onClick, line = false }: { title: string; note: string; button: string; k: string; onClick: () => void; line?: boolean }) {
    const st = ctx?.sendState(k) ?? null;
    return (
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-6">
        <div>
          <p className="font-serif text-[22px] text-paper">{title}</p>
          <p className="text-[14px] text-mist">{note}</p>
          <SendStatus state={st} tone="dark" />
        </div>
        <button type="button" onClick={onClick} disabled={!ctx?.maySend || st?.busy} className={line ? btnLine : btn}>
          {button}
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-charcoal">
      <AppHeader tone="dark" />
      <main className="mx-auto max-w-[1040px] px-6 pb-24 pt-8">
        <Breadcrumbs items={[{ label: "Sponsor", href: "/sponsor" }, { label: page?.name.title ?? `Campaign ${id}` }]} tone="dark" />
        {body()}
      </main>
    </div>
  );
}
