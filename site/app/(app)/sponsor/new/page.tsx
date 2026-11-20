"use client";

// Create a campaign: name, who is paid, the goal, the two pots and how long it runs. The terms
// go to the contract in one transaction; the pots are locked on the next screen, before it opens.
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import type { Address, Terms } from "../../../../../packages/kit/src/index.ts";
import { formatUsd, parseUsd } from "../../../../../web/src/data/money.ts";
import { AppHeader } from "@/components/app/AppHeader";
import { Breadcrumbs } from "@/components/app/Breadcrumbs";
import { SendStatus } from "@/components/app/ui";
import { useEngine } from "@/lib/boomerang/engine";
import { createCall } from "@/lib/boomerang/sponsor";

const LENGTHS = [
  { key: "10m", label: "10 min", secs: 600n },
  { key: "1d", label: "1 day", secs: 86_400n },
  { key: "7d", label: "7 days", secs: 604_800n },
  { key: "30d", label: "30 days", secs: 2_592_000n },
] as const;
const LEAD = 180n; // seconds before opening, to lock the pots
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export default function NewCampaignPage() {
  const { ctx, wallet, nameCampaign } = useEngine();
  const router = useRouter();
  const [name, setName] = useState("");
  const [recipient, setRecipient] = useState("");
  const [goal, setGoal] = useState("3");
  const [match, setMatch] = useState("0.50");
  const [bonus, setBonus] = useState("0.30");
  const [min, setMin] = useState("0.10");
  const [rate, setRate] = useState("20");
  const [length, setLength] = useState<(typeof LENGTHS)[number]["key"]>("10m");
  const [sentFor, setSentFor] = useState<{ opensAt: bigint; target: bigint; recipient: Address; title: string } | null>(null);

  const key = "create";
  const sending = ctx?.sendState(key) ?? null;

  // once the new campaign shows up in a read, name it and go to its page
  useEffect(() => {
    if (!ctx || !sentFor || !wallet.account) return;
    const me = wallet.account.toLowerCase();
    const made = ctx.world.campaigns.find((c) => c.state.sponsor.toLowerCase() === me && c.terms.opensAt === sentFor.opensAt && c.terms.target === sentFor.target);
    if (!made) return;
    if (sentFor.title.trim()) nameCampaign({ id: made.id, sponsor: wallet.account, recipient: sentFor.recipient, title: sentFor.title.trim() });
    router.push(`/sponsor/${made.id}`);
  }, [ctx, sentFor, wallet.account, nameCampaign, router]);

  const g = parseUsd(goal);
  const m = parseUsd(match);
  const b = parseUsd(bonus);
  const mn = parseUsd(min);
  const r = Number(rate);
  const problems: string[] = [];
  if (!ADDRESS.test(recipient)) problems.push("Recipient address");
  if (g === null || g <= 0n) problems.push("Goal");
  if (m === null) problems.push("Match");
  if (b === null) problems.push("Bonus");
  if (mn === null || mn <= 0n || (g !== null && mn > g)) problems.push("Minimum pledge");
  if (!Number.isFinite(r) || r < 0 || r > 100) problems.push("Bonus rate");
  const lock = (m ?? 0n) + (b ?? 0n);
  const short = wallet.balance !== null && wallet.balance < lock;

  const submit = async () => {
    if (!ctx || problems.length > 0 || g === null || m === null || b === null || mn === null) return;
    const span = LENGTHS.find((l) => l.key === length)!.secs;
    const opensAt = ctx.world.now + LEAD;
    const terms: Terms = {
      recipient: recipient as Address,
      opensAt,
      earlyUntil: opensAt + (span * 4n) / 10n,
      closesAt: opensAt + span,
      target: g,
      minPledge: mn,
      matchAmount: m,
      bonusPool: b,
      rateBps: Math.round(r * 100),
      linearWeight: true,
      bonusFromRecipient: false,
    };
    const ok = await ctx.send(key, [createCall({ boomerang: ctx.config.boomerang, terms })]);
    if (ok) setSentFor({ opensAt, target: g, recipient: recipient as Address, title: name });
  };

  return (
    <div className="min-h-screen bg-charcoal">
      <AppHeader tone="dark" />
      <main className="mx-auto max-w-[1040px] px-6 pb-24 pt-8">
        <Breadcrumbs items={[{ label: "Sponsor", href: "/sponsor" }, { label: "New campaign" }]} tone="dark" />
        <h1 className="mt-10 font-serif text-[48px] leading-[1.05] text-paper">New campaign</h1>

        {!wallet.account ? (
          <a href="/login" className="mt-10 inline-flex h-12 items-center gap-3 rounded-[5px] bg-paper px-6 text-[15px] font-medium text-ink hover:bg-glow">
            Log in <span aria-hidden>→</span>
          </a>
        ) : (
          <form
            className="mt-10 grid gap-12 lg:grid-cols-[minmax(0,1fr)_300px]"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="space-y-6">
              <Field label="Name">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Builder House, Denver" className={input} />
              </Field>
              <Field label="Recipient">
                <div className="flex gap-2">
                  <input value={recipient} onChange={(e) => setRecipient(e.target.value.trim())} placeholder="0x…" className={`${input} font-mono text-[14px]`} />
                  <button type="button" onClick={() => setRecipient(wallet.account!)} className="shrink-0 rounded-[5px] border border-line px-3 text-[13px] text-paper hover:border-paper">
                    Me
                  </button>
                </div>
              </Field>
              <div className="grid grid-cols-2 gap-6">
                <Field label="Goal (USDC)">
                  <input value={goal} onChange={(e) => setGoal(e.target.value)} inputMode="decimal" className={input} />
                </Field>
                <Field label="Minimum pledge">
                  <input value={min} onChange={(e) => setMin(e.target.value)} inputMode="decimal" className={input} />
                </Field>
                <Field label="Match">
                  <input value={match} onChange={(e) => setMatch(e.target.value)} inputMode="decimal" className={input} />
                </Field>
                <Field label="Bonus pool">
                  <input value={bonus} onChange={(e) => setBonus(e.target.value)} inputMode="decimal" className={input} />
                </Field>
                <Field label="Bonus rate (% of an early pledge)">
                  <input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" className={input} />
                </Field>
              </div>
              <Field label="Runs for">
                <div className="flex flex-wrap gap-2">
                  {LENGTHS.map((l) => (
                    <button
                      key={l.key}
                      type="button"
                      onClick={() => setLength(l.key)}
                      className={`h-10 rounded-[5px] border px-4 text-[14px] ${length === l.key ? "border-paper bg-paper text-ink" : "border-line text-paper hover:border-paper"}`}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              </Field>
            </div>

            <aside className="lg:sticky lg:top-24 lg:self-start">
              <dl className="space-y-4 border-y border-line py-5">
                <Stat label="Goal" value={g === null ? "—" : `${formatUsd(g)} USDC`} />
                <Stat label="You lock" value={`${formatUsd(lock)} USDC`} />
                <Stat label="Opens" value="In 3 min" />
                <Stat label="Early window" value="First 40%" />
              </dl>
              {short ? <p className="mt-4 text-[13px] text-missed">Your balance is below what you lock.</p> : null}
              <button
                type="submit"
                disabled={problems.length > 0 || !ctx?.maySend || sending?.busy || sentFor !== null}
                className="mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-[5px] bg-paper text-[15px] font-medium text-ink hover:bg-glow disabled:bg-line disabled:text-mist"
              >
                {sentFor ? "Created. Opening…" : "Create campaign"} <span aria-hidden>→</span>
              </button>
              {problems.length > 0 ? <p className="mt-3 text-[13px] text-mist">Check: {problems.join(", ")}</p> : null}
              <SendStatus state={sending} tone="dark" />
            </aside>
          </form>
        )}
      </main>
    </div>
  );
}

const input = "h-11 w-full rounded-[5px] border border-line bg-transparent px-3 text-[16px] text-paper outline-none focus:border-paper";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[13px] text-mist">{label}</span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-[13px] text-mist">{label}</dt>
      <dd className="text-[15px] text-paper">{value}</dd>
    </div>
  );
}
