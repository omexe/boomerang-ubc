"use client";

// A campaign's page, in the garden palette. Every figure and sentence comes from the shared
// views (campaignPage, boardView, backersTable, minePage); this file lays them out.
import Link from "next/link";
import { useRouter } from "next/navigation";

import type { CampaignView } from "../../../web/src/data/load.ts";

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
import { SendStatus } from "@/components/app/ui";
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
    <div className="min-h-screen bg-g-bg text-g-ink lg:flex lg:h-svh lg:flex-col lg:overflow-hidden">
      <AppHeader tone="garden" />
      <main className="mx-auto flex w-full max-w-[1320px] flex-col px-6 pb-10 pt-4 lg:min-h-0 lg:flex-1 lg:pb-5">
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

  const terms = termsOf(campaign);
  const shownBackers = backers.rows.slice(0, 5);

  return (
    <div className="mt-3 grid gap-x-10 gap-y-8 lg:min-h-0 lg:flex-1 lg:grid-cols-[250px_minmax(0,1fr)_320px] lg:grid-rows-[minmax(0,1fr)_200px] lg:gap-y-5">
      {/* the numbers */}
      <div className="min-w-0 self-center">
        <div className="flex flex-wrap gap-2">
          <span className={`inline-block rounded-[4px] px-2 py-0.5 text-[12px] ${tag}`}>{page.status}</span>
          {isShowcase(id) ? <span className="inline-block rounded-[4px] border border-g-line px-2 py-0.5 text-[12px] text-g-ink2">Example</span> : null}
        </div>
        <h1 className="mt-3 font-serif text-[34px] leading-[1.05]">{page.name.title}</h1>
        <p className="mt-1.5 text-[13px] text-g-ink2">{page.name.sponsorName}</p>

        <p className="mt-6 font-serif text-[30px] leading-none">{formatUsd(s.pledged)}</p>
        <p className="mt-1 text-[12px] text-g-ink2">of {formatUsd(t.target)} USDC · {page.backers}</p>
        <div className="mt-3 h-[3px] w-full bg-g-line">
          <div className={`h-full ${bar}`} style={{ width: `${pct}%` }} />
        </div>

        <dl className="mt-5 space-y-3">
          {board.plates.map((p) => (
            <div key={p.key}>
              <dt className="text-[12px] text-g-ink2">{p.caption}</dt>
              <dd className={`font-serif text-[21px] leading-tight ${p.key === "bonus" ? "text-g-gold" : ""}`}>
                {p.figure} <span className="font-sans text-[12px] text-g-ink2">{p.unit}</span>
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {/* the garden, as large as the space allows */}
      <div className="min-h-[300px] min-w-0 lg:min-h-0" style={{ containerType: "size" }}>
        <div className="flex h-full w-full items-center justify-center">
          <div style={{ width: "min(100cqw, calc(100cqh * 986 / 853))" }}>
            <GardenMini state={garden} />
          </div>
        </div>
      </div>

      {/* pledge, or how it ended */}
      <div className="self-center">
        {taking && isShowcase(id) ? (
          <ExamplePanel />
        ) : taking ? (
          <PledgePanel ctx={ctx} campaign={campaign} focus={focus} onLogin={() => router.push("/login")} />
        ) : (
          <Outcome ctx={ctx} id={id} page={page} board={board} mine={mine} myRow={myRow} settled={settledLine(campaign)} />
        )}
      </div>

      {/* bottom row: terms, chart, backers */}
      <section className="min-w-0 border-t border-g-line pt-3">
        <h2 className="text-[12px] text-g-ink2">Terms</h2>
        <dl className="mt-2 space-y-[3px] text-[12px] leading-[1.45]">
          {terms.map((r) => {
            const link = r.address && config.chain.explorer ? `${config.chain.explorer}/address/${r.address}` : null;
            return (
              <div key={r.label} className="flex justify-between gap-3">
                <dt className="text-g-ink2">{r.label}</dt>
                <dd className="truncate text-right">
                  {link ? (
                    <a href={link} target="_blank" rel="noreferrer noopener" className="underline decoration-1 underline-offset-2">
                      {r.value}
                    </a>
                  ) : (
                    r.value
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </section>

      <section className="flex min-h-[200px] min-w-0 flex-col border-t border-g-line pt-3 lg:min-h-0">
        <h2 className="text-[12px] text-g-ink2">Progress</h2>
        <div className="mt-1 min-h-0 flex-1">
          <Chart campaign={campaign} ledger={ledger} now={world.now} />
        </div>
      </section>

      <section className="min-w-0 border-t border-g-line pt-3">
        <h2 className="text-[12px] text-g-ink2">{backers.title}</h2>
        {shownBackers.length > 0 ? (
          <table className="mt-1.5 w-full text-[12px]">
            <tbody>
              {shownBackers.map((r) => (
                <tr key={r.key} className="border-b border-g-line last:border-0">
                  <td className="py-[5px] font-mono text-[11px]">{r.account}</td>
                  <td className="py-[5px] text-right">{r.pledged}</td>
                  <td className={`py-[5px] pl-3 text-right ${r.when.toLowerCase().startsWith("early") ? "text-g-gold" : "text-g-ink2"}`}>{r.when.split(" ")[0]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-2 text-[12px] text-g-ink2">{s.backers === 0 ? "No backers yet." : `${s.backers} backers.`}</p>
        )}
        {backers.rows.length > shownBackers.length ? <p className="mt-1.5 text-[12px] text-g-ink2">+{backers.rows.length - shownBackers.length} more</p> : null}
      </section>
    </div>
  );
}

// The terms, shortened to fit one line each.
function termsOf(c: CampaignView): { label: string; value: string; address?: `0x${string}` }[] {
  const { terms: t, state: s } = c;
  const when = (sec: bigint) => {
    const d = new Date(Number(sec) * 1000);
    return `${d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" })} UTC`;
  };
  const pot = (amount: bigint, locked: boolean) => (amount > 0n ? `${formatUsd(amount)}${locked ? "" : " · not locked"}` : "None");
  const rows: { label: string; value: string; address?: `0x${string}` }[] = [
    { label: "Minimum pledge", value: formatUsd(t.minPledge) },
    { label: "Match", value: pot(t.matchAmount, s.matchIn) },
    { label: "Bonus pool", value: pot(t.bonusPool, s.bonusIn) },
  ];
  if (t.bonusPool > 0n) rows.push({ label: "Early bonus", value: `up to ${Number(t.rateBps) / 100}%` });
  rows.push(
    { label: "Opens", value: when(t.opensAt) },
    { label: "Early window ends", value: when(t.earlyUntil) },
    { label: "Closes", value: when(t.closesAt) },
    { label: "Paid to", value: shortAddr(t.recipient), address: t.recipient },
  );
  return rows;
}

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

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
