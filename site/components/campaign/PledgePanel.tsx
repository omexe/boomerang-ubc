"use client";

// Pledging, in the garden palette. The logic is the existing cheque's (web/src/ui/Cheque.tsx),
// unchanged: the contract is asked about what is typed, one submit runs at a time, the contract is
// asked again just before sending, and a signature that may still land is waited out. When the
// keeper relays signed pledges it is one signature and no gas; otherwise two steps.
import { useEffect, useRef, useState } from "react";

import type { Ctx } from "../../../web/src/app/context.ts";
import { ownIn } from "../../../web/src/app/world.ts";
import { quotePledge } from "../../../web/src/data/campaign.ts";
import type { CampaignView } from "../../../web/src/data/load.ts";
import { formatUsd, parseUsd } from "../../../web/src/data/money.ts";
import { oneAtATime } from "../../../web/src/flows/calls.ts";
import { pledgeForm, pledgeRoute, requote, stillValidLine, type Answer } from "../../../web/src/views/pledge.ts";
import { receiptView, shownWhileSending } from "../../../web/src/views/receipt.ts";
import { deskAnswerFor, deskOffer, signedButton, WORDS } from "../../../web/src/views/shell.ts";
import { SendStatus } from "@/components/app/ui";

const GAS_RESERVE = 20_000n; // about what an approval and a pledge cost in USDC gas on Arc
const PICKS = ["0.50", "1", "2"];

export function PledgePanel({ ctx, campaign, focus, onLogin }: { ctx: Ctx; campaign: CampaignView; focus: boolean; onLogin: () => void }) {
  const { world, config } = ctx;
  const id = campaign.id;
  const [text, setText] = useState("1");
  const [answered, setAnswered] = useState<{ amount: bigint; answer: Answer } | null>(null);
  const [changed, setChanged] = useState<string | null>(null);
  const [desk, setDesk] = useState<{ busy: boolean; line: string | null; ok: boolean; askedBy: string | null }>({ busy: false, line: null, ok: false, askedBy: null });
  const [twoStep, setTwoStep] = useState(false);
  const [fellBack, setFellBack] = useState<string | null>(null);
  const [sent, setSent] = useState<{ amount: bigint; early: boolean; back: bigint | null } | null>(null);
  const asked = useRef(0);
  const field = useRef<HTMLInputElement>(null);
  const once = useRef(oneAtATime()).current;

  const typed = text.trim() === "" ? null : parseUsd(text.trim());
  const block = world.block;

  useEffect(() => {
    if (focus) field.current?.focus();
  }, [focus]);

  // ask the contract about what is typed, a moment after typing stops, and at each new block
  useEffect(() => {
    if (typed === null || typed <= 0n) return;
    const mine = ++asked.current;
    const timer = setTimeout(() => {
      ctx
        .quote(id, typed)
        .then((answer) => {
          if (asked.current === mine) setAnswered({ amount: typed, answer });
        })
        .catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, typed, block]);

  const own = ownIn(world, ctx.account);
  const route = pledgeRoute({ signedPledge: config.signedPledge, relay: ctx.relay, fellBack: twoStep });
  const live = pledgeForm({
    campaign,
    where: { boomerang: config.boomerang, usdc: config.usdc },
    amountText: text,
    now: world.now,
    account: ctx.account,
    balance: own.balance,
    allowance: own.allowance,
    onRightChain: ctx.onRightChain,
    answer: answered !== null && typed !== null && answered.amount === typed ? answered.answer : null,
    hasWallet: true, // the login page owns the wallet choice; here nobody connected means "log in"
    practice: false,
    gasReserve: !config.chain.local && route !== "signed" ? GAS_RESERVE : 0n,
  });
  const key = `pledge:${id}`;
  const sending = ctx.sendState(key);
  const busy = sending !== null && sending.busy;
  const kept = useRef<{ id: bigint; shown: { form: typeof live; receipt: ReturnType<typeof receiptView> } } | null>(null);
  const current = { form: live, receipt: receiptView({ form: live, campaign }) };
  const { shown, held } = shownWhileSending({ busy, id, kept: kept.current, now: current });
  if (!busy) kept.current = { id, shown: current };
  const { form, receipt } = shown;
  const offer = own.balance !== null && own.balance < 2_000_000n ? deskOffer({ desk: ctx.desk, account: ctx.account, had: ctx.hadUsdc }) : null;

  const submit = () => {
    const account = ctx.account;
    if (account === null) return onLogin();
    const { amount, quote, calls } = live;
    if (!live.canSend || amount === null || quote === null) return;
    void once(async () => {
      setChanged(null);
      setSent(null);
      let fresh: Answer;
      try {
        fresh = await ctx.quote(id, amount);
      } catch {
        return;
      }
      const isSponsor = account.toLowerCase() === campaign.state.sponsor.toLowerCase();
      const latest = quotePledge(campaign.terms, campaign.state, amount, world.now, { isSponsor, answer: fresh });
      const now = requote(quote, latest);
      if (!now.same) {
        setAnswered({ amount, answer: fresh });
        setChanged(now.line);
        return;
      }
      const guard = await ctx.signedGuard(id);
      if (guard.kind === "unknown") return setChanged(WORDS.pledge.cannotCheck);
      if (guard.kind === "wait") return setChanged(stillValidLine(guard.left));
      if (guard.kind === "landed") {
        setFellBack(null);
        setChanged(WORDS.pledge.landed);
        ctx.refresh();
        return;
      }
      const receiptOf = () => (latest.kind === "counts" ? { amount: latest.counted, early: latest.early, back: latest.back } : latest.kind === "completes" ? { amount: latest.counted, early: false, back: null } : null);
      if (route === "signed" && latest.kind !== "refused") {
        const r = await ctx.relayPledge(key, { id, amount: latest.counted, closesAt: campaign.terms.closesAt });
        if (r.kind === "done") setSent(receiptOf());
        else if (r.kind === "fallback") {
          setTwoStep(true);
          setFellBack(r.line);
        }
        return;
      }
      if (await ctx.send(key, calls)) {
        setSent(receiptOf());
        setFellBack(null);
      }
    });
  };

  const getUsdc = async () => {
    const askedBy = ctx.account;
    setDesk({ busy: true, line: null, ok: false, askedBy });
    const a = await ctx.askForUsdc();
    setDesk({ busy: false, line: a.line, ok: a.ok, askedBy });
    ctx.refresh();
  };

  const t = campaign.terms;
  const others = busy && !held ? [] : form.blocks.filter((b) => b !== form.line);
  const button = ctx.account === null ? "Log in to pledge" : route === "signed" ? signedButton(form.button) : form.button;
  const deskLine = deskAnswerFor({ line: desk.line, askedBy: desk.askedBy as never, account: ctx.account });
  const disabled = ctx.account !== null && (!form.canSend || !ctx.maySend);

  return (
    <form
      className="rounded-[8px] border border-g-line bg-g-sheet p-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      aria-labelledby="pledge-title"
    >
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="pledge-title" className="font-serif text-[26px] leading-tight text-g-ink">
          Pledge
        </h2>
      </div>

      {/* amount */}
      <label htmlFor="pledge-amount" className="mt-5 block text-[13px] text-g-ink2">
        Amount
      </label>
      <div className="mt-1.5 flex items-center rounded-[6px] border border-g-line bg-g-bg focus-within:border-g-ink">
        <input
          id="pledge-amount"
          ref={field}
          inputMode="decimal"
          autoComplete="off"
          value={text}
          readOnly={busy}
          onChange={(e) => setText(e.target.value)}
          className="h-14 w-full bg-transparent px-4 font-serif text-[30px] text-g-ink outline-none"
        />
        <span className="pr-4 text-[14px] text-g-ink2">USDC</span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        {PICKS.map((p) => (
          <button key={p} type="button" disabled={busy} onClick={() => setText(p)} className={`rounded-[4px] border px-2.5 py-1 text-[13px] ${text === p ? "border-g-ink bg-g-ink text-g-sheet" : "border-g-line text-g-ink hover:border-g-ink"}`}>
            {p}
          </button>
        ))}
        <span className="ml-auto text-[12px] text-g-ink2">Minimum {formatUsd(t.minPledge)}</span>
      </div>

      {/* the contract's answer: both endings */}
      <div className="mt-5" aria-live="polite">
        {receipt.kind === "two" ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-[6px] border border-g-line p-3">
              <p className="text-[12px] text-g-ink2">If the goal is met</p>
              <p className="mt-1 font-serif text-[22px] text-g-green">{receipt.met.figure.replace(/ USDC$/, "")}</p>
            </div>
            <div className={`rounded-[6px] border p-3 ${receipt.missed.live ? "border-g-gold" : "border-g-line"}`}>
              <p className="text-[12px] text-g-ink2">If it misses</p>
              <p className="mt-1 font-serif text-[22px] text-g-red">{receipt.missed.figure.replace(/ USDC$/, "")}</p>
            </div>
          </div>
        ) : (
          <p className="text-[14px] text-g-ink">{receipt.line}</p>
        )}
      </div>

      {/* where the money comes from */}
      <div className="mt-5">
        <p className="text-[13px] text-g-ink2">Pay from</p>
        <div className="mt-1.5 flex flex-wrap gap-2">
          <span className="rounded-[4px] border border-g-ink bg-g-ink px-2.5 py-1 text-[13px] text-g-sheet">Arc Testnet</span>
          {["Base", "Ethereum"].map((c) => (
            <span key={c} className="rounded-[4px] border border-g-line px-2.5 py-1 text-[13px] text-g-ink2" title="Pledging from another chain comes later">
              {c} · soon
            </span>
          ))}
        </div>
      </div>

      <button
        type="submit"
        disabled={disabled}
        className="mt-6 inline-flex h-12 w-full items-center justify-center gap-2 rounded-[6px] bg-g-green text-[15px] font-medium text-g-sheet transition-colors hover:bg-g-ink disabled:bg-g-line disabled:text-g-ink2"
      >
        {button} <span aria-hidden>→</span>
      </button>

      <div className="mt-3 space-y-2 text-[13px] leading-[1.5]">
        {changed ? <p className="text-g-red" role="alert">{changed}</p> : null}
        {others.length > 0 && ctx.account !== null ? (
          <ul className="space-y-1 text-g-ink">
            {others.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        ) : null}
        {fellBack ? <p className="text-g-red">{fellBack}</p> : null}
        <SendStatus state={sending && (sending.busy || sending.error !== null) ? sending : null} tone="garden" />
        {offer || deskLine ? (
          <div className="rounded-[6px] border border-dashed border-g-line p-3">
            {offer ? (
              <>
                <button type="button" onClick={getUsdc} disabled={desk.busy || busy} className="text-[13px] font-medium text-g-green underline underline-offset-2">
                  {offer.button}
                </button>
              </>
            ) : null}
            {deskLine ? <p className={desk.ok ? "text-g-ink" : "text-g-red"}>{deskLine}</p> : null}
          </div>
        ) : null}
      </div>

      {/* confirmation */}
      {sent && sending?.done ? (
        <div className="mt-5 rounded-[6px] border border-g-green bg-g-bg p-4" role="status">
          <p className="font-serif text-[20px] text-g-green">Your pledge is in.</p>
          <dl className="mt-2 space-y-1 text-[13px] text-g-ink">
            <div className="flex justify-between">
              <dt className="text-g-ink2">Pledged</dt>
              <dd>{formatUsd(sent.amount)} USDC</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-g-ink2">Window</dt>
              <dd>{sent.early ? "Early: earns a bonus share" : "Late: no bonus"}</dd>
            </div>
            {sent.back !== null ? (
              <div className="flex justify-between">
                <dt className="text-g-ink2">If it misses</dt>
                <dd>{formatUsd(sent.back)} USDC back</dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}
    </form>
  );
}
