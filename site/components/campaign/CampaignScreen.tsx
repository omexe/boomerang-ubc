"use client";

// A campaign's page, in the garden palette. Every figure and sentence comes from the shared
// views (campaignPage, boardView, backersTable, minePage); this file lays them out.
import Link from "next/link";
import { useRouter } from "next/navigation";

import type { Ctx } from "../../../web/src/app/context.ts";
import { campaignIn, ownIn } from "../../../web/src/app/world.ts";
import { formatUsd } from "../../../web/src/data/money.ts";
import { paceOf } from "../../../web/src/data/pace.ts";
import { finalizeCall, payCall, paySideCall } from "../../../web/src/flows/calls.ts";
import { backersTable } from "../../../web/src/views/backers.ts";
import { boardView, settledLine } from "../../../web/src/views/board.ts";
import { campaignPage, missingPage, voucherMine } from "../../../web/src/views/campaign.ts";
import { minePage } from "../../../web/src/views/mine.ts";
import { AppHeader } from "@/components/app/AppHeader";
import { Breadcrumbs } from "@/components/app/Breadcrumbs";
import { isShowcase } from "@/lib/boomerang/showcase";
import { nameOf } from "../../../web/src/data/labels.ts";
import { Rows, SendStatus } from "@/components/app/ui";
import { GardenMini } from "@/components/garden/GardenMini";
import { useEngine, useShownCampaign } from "@/lib/boomerang/engine";
import { Chart } from "./Chart";
import { PledgePanel } from "./PledgePanel";

export function CampaignScreen({ id, focus }: { id: bigint; focus: boolean }) {
  useShownCampaign(id);
  const { ctx, problem, readFailed } = useEngine();
  const c = ctx ? campaignIn(ctx.world, id) : undefined;
  const crumb = ctx && c ? nameOf(ctx.labels, c, ctx.config.desk).title : `Campaign ${id}`;
  return (
    <div className="min-h-screen bg-g-bg text-g-ink">
      <AppHeader tone="garden" />
      <main className="mx-auto max-w-[1240px] px-6 pb-24 pt-8">
        <Breadcrumbs items={[{ label: "Explore", href: "/explore" }, { label: crumb }]} tone="garden" />
        {ctx ? <Body ctx={ctx} id={id} focus={focus} /> : <p className="mt-10 text-[16px]">{problem ?? (readFailed ? "The chain could not be read. Trying again…" : "Reading the chain…")}</p>}
      </main>
    </div>
  );
}

function Body({ ctx, id, focus }: { ctx: Ctx; id: bigint; focus: boolean }) {
  const router = useRouter();
  const { world, config } = ctx;
  const campaign = campaignIn(world, id);
  if (!campaign) {
    const m = missingPage({ id, count: world.count, expected: ctx.expected(id) });
    return (
      <section className="mt-10">
        <h1 className="font-serif text-[40px]">{m.loading ? `${m.title}…` : m.title}</h1>
        {!m.loading ? <p className="mt-3 text-[16px]">{m.line}</p> : null}
      </section>
    );
  }

  const pace = paceOf(world.keeper, world.block).state;
  const page = campaignPage({ campaign, labels: ctx.labels, desk: config.desk, now: world.now, block: world.block, pace });
  const board = boardView({ campaign, now: world.now });
  const ledger = world.keeper.up ? world.keeper.ledger : null;
  const backers = backersTable({ campaign, shown: world.shownBackers, keeperUp: world.keeper.up, block: world.block });
  const taking = page.phase === "early" || page.phase === "open" || page.phase === "waiting";
  const { terms: t, state: s } = campaign;

  const own = ownIn(world, ctx.account);
  const myRow = own.known ? (minePage({ account: ctx.account, mine: own.mine.filter((m) => m.campaign.id === id), labels: ctx.labels, desk: config.desk, block: world.block, pace }).rows[0] ?? null) : null;
  const mine = voucherMine(myRow);

  const outcome = page.phase === "funded" ? "met" : page.phase === "missed" ? "missed" : page.phase === "void" ? "void" : "live";
  const garden = {
    progress: t.target > 0n ? Number((s.pledged * 1000n) / t.target) / 1000 : 0,
    earlyShare: s.pledged > 0n ? Number((s.pledgedEarly * 1000n) / s.pledged) / 1000 : 0.6,
    outcome,
  } as const;

  const tag =
    page.phase === "funded"
      ? "bg-g-green text-g-sheet"
      : page.phase === "missed"
        ? "bg-g-red text-g-sheet"
        : page.phase === "early"
          ? "bg-g-gold text-g-sheet"
          : "bg-g-line text-g-ink";

  const pct = Math.min(page.percent, 100);
  const bar = page.phase === "funded" ? "bg-g-green" : page.phase === "missed" ? "bg-g-red" : "bg-g-ink";

  return (
    <>
      {/* first screen: the garden in the middle, the numbers beside it */}
      <section className="mt-4 grid min-h-[600px] items-center gap-8 lg:h-[calc(100vh-150px)] lg:grid-cols-[260px_minmax(0,1fr)_330px]">
        <div className="min-w-0 self-center">
          <div className="flex flex-wrap gap-2">
            <span className={`inline-block rounded-[4px] px-2 py-0.5 text-[12px] ${tag}`}>{page.status}</span>
            {isShowcase(id) ? <span className="inline-block rounded-[4px] border border-g-line px-2 py-0.5 text-[12px] text-g-ink2">Example</span> : null}
          </div>
          <h1 className="mt-3 font-serif text-[40px] leading-[1.04]">{page.name.title}</h1>
          <p className="mt-2 text-[14px] text-g-ink2">{page.name.sponsorName}</p>

          <p className="mt-8 font-serif text-[34px] leading-none">{formatUsd(s.pledged)}</p>
          <p className="mt-1 text-[13px] text-g-ink2">of {formatUsd(t.target)} USDC</p>
          <div className="mt-3 h-[3px] w-full bg-g-line">
            <div className={`h-full ${bar}`} style={{ width: `${pct}%` }} />
          </div>

          <dl className="mt-6 space-y-4">
            {board.plates.map((p) => (
              <div key={p.key}>
                <dt className="text-[12px] text-g-ink2">{p.caption}</dt>
                <dd className={`font-serif text-[24px] leading-tight ${p.key === "bonus" ? "text-g-gold" : ""}`}>
                  {p.figure} <span className="font-sans text-[12px] text-g-ink2">{p.unit}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="flex h-full min-w-0 items-center justify-center">
          <div className="w-full max-w-[640px]">
            <GardenMini state={garden} />
          </div>
        </div>

        <div className="self-center">
          {taking && isShowcase(id) ? (
            <ExamplePanel />
          ) : taking ? (
            <PledgePanel ctx={ctx} campaign={campaign} focus={focus} onLogin={() => router.push("/login")} />
          ) : (
            <Outcome ctx={ctx} id={id} page={page} board={board} mine={mine} myRow={myRow} settled={settledLine(campaign)} />
          )}
        </div>
      </section>

      {/* under the fold */}
      <section className="mt-10 border-t border-g-line pt-10">
        <div className="flex items-baseline justify-between">
          <h2 className="font-serif text-[26px]">Progress</h2>
          <p className="text-[14px] text-g-ink2">{page.backers}</p>
        </div>
        <div className="mt-4">
          <Chart campaign={campaign} ledger={ledger} now={world.now} />
        </div>
      </section>

      <div className="mt-14 grid gap-14 lg:grid-cols-2">
        <section>
          <h2 className="font-serif text-[26px]">Terms</h2>
          <div className="mt-4">
            <Rows rows={page.rows} explorer={config.chain.explorer} tone="garden" />
          </div>
        </section>

        <section>
          <h2 className="font-serif text-[26px]">{backers.title}</h2>
          {backers.rows.length > 0 ? (
            <table className="mt-4 w-full text-[14px]">
              <thead>
                <tr className="border-b border-g-ink text-left text-g-ink2">
                  {backers.head.map((h) => (
                    <th key={h} scope="col" className="py-2 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {backers.rows.map((r) => (
                  <tr key={r.key} className="border-b border-g-line">
                    <td className="py-2.5 font-mono text-[13px]">{r.account}</td>
                    <td className="py-2.5">{r.pledged}</td>
                    <td className={`py-2.5 ${r.when.toLowerCase().startsWith("early") ? "text-g-gold" : ""}`}>{r.when}</td>
                    <td className={`py-2.5 ${r.kind === "returned" || r.kind === "owed" ? "text-g-red" : ""}`}>{r.back}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-4 text-[14px] text-g-ink2">{s.backers === 0 ? "No backers yet." : `${s.backers} backers.`}</p>
          )}
        </section>
      </div>
    </>
  );
}

function Outcome({
  ctx,
  id,
  page,
  board,
  mine,
  myRow,
  settled,
}: {
  ctx: Ctx;
  id: bigint;
  page: ReturnType<typeof campaignPage>;
  board: ReturnType<typeof boardView>;
  mine: ReturnType<typeof voucherMine>;
  myRow: ReturnType<typeof minePage>["rows"][number] | null;
  settled: string | null;
}) {
  const { config } = ctx;
  const settleKey = `settle:${id}`;
  const payKey = `pay:${id}`;
  const result = board.result;
  const color = result?.kind === "reached" ? "text-g-green border-g-green" : result?.kind === "short" ? "text-g-red border-g-red" : "text-g-ink2 border-g-line";
  return (
    <section>
      {result && !page.settle ? (
        <p className={`inline-block -rotate-2 rounded-[4px] border-2 px-3 py-1 text-[15px] font-semibold uppercase tracking-[0.12em] ${color}`}>{result.kind === "reached" ? "Goal met" : result.kind === "short" ? "Goal missed" : result.flag}</p>
      ) : null}
      {mine ? (
        <div className="mt-4">
          <p className="text-[12px] text-g-ink2">{mine.label}</p>
          <p className={`mt-1 text-[16px] ${mine.cameBack ? "text-g-red" : "text-g-green"}`}>{mine.line}</p>
        </div>
      ) : null}
      <p className="mt-4 font-serif text-[22px] leading-tight">{page.status}</p>
      {settled ? <p className="mt-2 text-[14px]">{settled}</p> : null}

      {page.settle ? (
        <div className="mt-5">
          {ctx.account ? (
            <button type="button" disabled={!ctx.maySend} onClick={() => void ctx.send(settleKey, [finalizeCall({ boomerang: config.boomerang, id })])} className="h-11 w-full rounded-[6px] bg-g-green text-[15px] font-medium text-g-sheet hover:bg-g-ink disabled:bg-g-line disabled:text-g-ink2">
              {page.settle.button}
            </button>
          ) : null}
          <SendStatus state={ctx.sendState(settleKey)} tone="garden" />
        </div>
      ) : null}

      {myRow && myRow.send && ctx.account ? (
        <div className="mt-5 border-t border-g-line pt-4">
          <p className="text-[14px]">{myRow.line}</p>
          <button type="button" disabled={!ctx.maySend} onClick={() => void ctx.send(payKey, [payCall({ boomerang: config.boomerang, id, backer: ctx.account! })])} className="mt-3 h-10 rounded-[6px] border border-g-ink px-4 text-[14px] hover:bg-g-bg disabled:border-g-line disabled:text-g-ink2">
            {myRow.send.button}
          </button>
          <SendStatus state={ctx.sendState(payKey)} tone="garden" />
        </div>
      ) : null}

      {page.dues.length > 0 ? (
        <div className="mt-5 space-y-3 border-t border-g-line pt-4">
          {page.dues.map((d) => {
            const k = `side:${id}:${d.side}`;
            return (
              <div key={d.side}>
                <p className="text-[14px]">{d.line}</p>
                {ctx.account ? (
                  <button type="button" disabled={!ctx.maySend} onClick={() => void ctx.send(k, [paySideCall({ boomerang: config.boomerang, id, side: d.side, label: d.button })])} className="mt-2 h-9 rounded-[6px] border border-g-ink px-3 text-[13px] hover:bg-g-bg disabled:border-g-line disabled:text-g-ink2">
                    {d.button}
                  </button>
                ) : null}
                <SendStatus state={ctx.sendState(k)} tone="garden" />
              </div>
            );
          })}
        </div>
      ) : null}
      {!ctx.account ? (
        <Link href="/login" className="mt-5 inline-block text-[14px] text-g-green underline underline-offset-2">
          Log in
        </Link>
      ) : null}
    </section>
  );
}

function ExamplePanel() {
  return (
    <section>
      <p className="font-serif text-[26px] leading-tight">Example campaign</p>
      <p className="mt-2 text-[14px] text-g-ink2">Pledging is open on live demo campaigns.</p>
      <Link href="/explore" className="mt-5 inline-flex h-11 w-full items-center justify-center rounded-[6px] bg-g-green text-[15px] font-medium text-g-sheet hover:bg-g-ink">
        Find a live campaign →
      </Link>
    </section>
  );
}
