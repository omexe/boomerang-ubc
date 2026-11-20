"use client";

// The backer's account: wallet, totals, and every pledge with what happened to it. A refund that
// is owed can be sent from here. Figures and sentences come from the shared My money view.
import Link from "next/link";
import { useState } from "react";

import { ownIn } from "../../../../web/src/app/world.ts";
import { short } from "../../../../web/src/data/keeper.ts";
import { formatUsd } from "../../../../web/src/data/money.ts";
import { paceOf } from "../../../../web/src/data/pace.ts";
import { payCall } from "../../../../web/src/flows/calls.ts";
import { minePage, type MineRow } from "../../../../web/src/views/mine.ts";
import { deskOffer } from "../../../../web/src/views/shell.ts";
import { AppHeader } from "@/components/app/AppHeader";
import { Breadcrumbs } from "@/components/app/Breadcrumbs";
import { SendStatus } from "@/components/app/ui";
import { useEngine } from "@/lib/boomerang/engine";

const KIND: Record<MineRow["kind"], { label: string; cls: string }> = {
  counted: { label: "Live", cls: "border-glow text-glow" },
  given: { label: "Funded", cls: "border-met text-met" },
  owed: { label: "Refund owed", cls: "border-missed text-missed" },
  returned: { label: "Refunded", cls: "border-missed text-missed" },
};

export default function PledgesPage() {
  const { ctx, wallet } = useEngine();
  const [desk, setDesk] = useState<{ busy: boolean; line: string | null; ok: boolean }>({ busy: false, line: null, ok: false });

  const body = () => {
    if (!wallet.account) {
      return (
        <div className="mt-10">
          <Link href="/login" className="inline-flex h-12 items-center gap-3 rounded-[5px] bg-paper px-6 text-[15px] font-medium text-ink hover:bg-glow">
            Log in <span aria-hidden>→</span>
          </Link>
        </div>
      );
    }
    if (!ctx) return <p className="mt-10 text-[16px] text-paper">Reading the chain…</p>;
    const { world, config } = ctx;
    const own = ownIn(world, wallet.account);
    const pace = paceOf(world.keeper, world.block).state;
    const page = minePage({ account: wallet.account, mine: own.mine, labels: ctx.labels, desk: config.desk, block: world.block, pace });
    const offer = wallet.balance !== null && wallet.balance < 2_000_000n ? deskOffer({ desk: ctx.desk, account: wallet.account, had: ctx.hadUsdc }) : null;
    const getUsdc = async () => {
      setDesk({ busy: true, line: null, ok: false });
      const a = await ctx.askForUsdc();
      setDesk({ busy: false, line: a.line, ok: a.ok });
      ctx.refresh();
    };

    return (
      <>
        {/* wallet */}
        <section className="mt-8 flex flex-wrap items-center justify-between gap-6 rounded-[6px] border border-line bg-smoke/50 p-5">
          <div>
            <p className="text-[13px] text-mist">{wallet.practising ? "Practice wallet" : "Wallet"}</p>
            <p className="mt-1 font-mono text-[15px] text-paper">{short(wallet.account)}</p>
          </div>
          <div>
            <p className="text-[13px] text-mist">Balance</p>
            <p className="mt-1 font-serif text-[26px] leading-none text-paper">{wallet.balance === null ? "…" : `${formatUsd(wallet.balance)} USDC`}</p>
          </div>
          {offer ? (
            <button type="button" onClick={getUsdc} disabled={desk.busy} className="h-10 rounded-[5px] border border-paper px-4 text-[14px] text-paper hover:border-glow hover:text-glow disabled:border-line disabled:text-mist">
              {offer.button}
            </button>
          ) : null}
        </section>
        {desk.line ? <p className={`mt-3 text-[14px] ${desk.ok ? "text-paper" : "text-missed"}`}>{desk.line}</p> : null}

        {/* totals */}
        <section className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          {page.figures.map((f) => (
            <div key={f.label} className="rounded-[6px] border border-line p-4">
              <p className="text-[12px] text-mist">{f.label}</p>
              <p className="mt-1 font-serif text-[24px] leading-none text-paper">{f.value}</p>
            </div>
          ))}
        </section>

        {/* pledges */}
        <section className="mt-12">
          <h2 className="border-b border-line pb-3 font-serif text-[26px] text-paper">Pledges</h2>
          {page.rows.length === 0 ? (
            <div className="mt-6">
              <p className="text-[15px] text-mist">No pledges yet.</p>
              <Link href="/explore" className="mt-5 inline-flex h-11 items-center gap-2 rounded-[5px] bg-paper px-5 text-[15px] font-medium text-ink hover:bg-glow">
                Explore campaigns <span aria-hidden>→</span>
              </Link>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {page.rows.map((r) => {
                const id = r.href.match(/(\d+)$/)?.[1] ?? "";
                const key = `pay:${id}`;
                return (
                  <li key={r.href} className="flex flex-wrap items-center justify-between gap-4 py-5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-3">
                        <Link href={`/campaign/${id}`} className="font-serif text-[21px] text-paper hover:underline">
                          {r.title}
                        </Link>
                        <span className={`rounded-[4px] border px-2 py-0.5 text-[12px] ${KIND[r.kind].cls}`}>{KIND[r.kind].label}</span>
                      </div>
                      <p className="mt-1 text-[14px] text-paper">{r.line}</p>
                      <SendStatus state={ctx.sendState(key)} tone="dark" />
                    </div>
                    {r.send ? (
                      <button
                        type="button"
                        disabled={!ctx.maySend}
                        onClick={() => void ctx.send(key, [payCall({ boomerang: config.boomerang, id: r.send!.campaign, backer: wallet.account! })])}
                        className="h-10 rounded-[5px] bg-paper px-4 text-[14px] font-medium text-ink hover:bg-glow disabled:bg-line disabled:text-mist"
                      >
                        {r.send.button}
                      </button>
                    ) : (
                      <Link href={`/campaign/${id}`} className="text-[14px] text-mist hover:text-paper">
                        View →
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </>
    );
  };

  return (
    <div className="min-h-screen bg-charcoal">
      <AppHeader tone="dark" />
      <main className="mx-auto max-w-[1040px] px-6 pb-24 pt-8">
        <Breadcrumbs items={[{ label: "My pledges" }]} tone="dark" />
        <h1 className="mt-10 font-serif text-[48px] leading-[1.05] text-paper">My pledges</h1>
        {body()}
      </main>
    </div>
  );
}
