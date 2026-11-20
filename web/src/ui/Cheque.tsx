// The pledge form, as a cheque: "Pay to the order of" the campaign, "the sum of" what is typed,
// and beside the button what comes back if the target is missed, in the contract's own figure.
//
// The logic is the old pledge box's, unchanged: the contract is asked about what is typed a moment
// after typing stops and at each new block; one submit runs at a time; and just before sending the
// contract is asked again, and a worse answer is shown instead of sent.
//
// When the keeper relays signed pledges, the pledge is one signature in the wallet and no gas.
// If that does not go through, the cheque says why and the next press sends the two-step pledge.
// Before any pledge, signed or two-step, a signature to this campaign that may still land (the app
// remembers it across reloads and tabs) is waited out, so nobody pledges twice by mistake.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Address } from "../../../packages/kit/src/index.ts";

import type { Ctx } from "../app/context.ts";
import { hrefFor } from "../app/route.ts";
import { ownIn } from "../app/world.ts";
import { phaseOf, quotePledge } from "../data/campaign.ts";
import { nameOf } from "../data/labels.ts";
import type { CampaignView } from "../data/load.ts";
import { parseUsd } from "../data/money.ts";
import { oneAtATime } from "../flows/calls.ts";
import { boardTime } from "../views/board.ts";
import { pledgeForm, pledgeRoute, requote, stillValidLine, type Answer } from "../views/pledge.ts";
import { receiptView, shownWhileSending } from "../views/receipt.ts";
import { PRACTICE } from "../views/practice.ts";
import { deskAnswerFor, deskOffer, pledgeSentLine, signedButton, WORDS } from "../views/shell.ts";
import { useDesk } from "./desk.ts";
import { Waves } from "./Guilloche.tsx";
import { SendStatus } from "./parts.tsx";
import { Practice } from "./Practice.tsx";

/** "9:12", "5 hrs", "3 days": the board's own clock, as the cheque's head writes it. */
function span(seconds: bigint): string {
  const t = boardTime(seconds);
  return t.unit === "min" ? t.figure : `${t.figure} ${t.unit}`;
}

/** A cheque number is the campaign's, four digits wide. */
const numberOf = (id: bigint) => `No. ${id.toString().padStart(4, "0")}`;

/** A figure that rises into place when it changes while the typed amount stays the same (a new block, the contract's answer). Typing never animates. */
function Figure({ figure, typed }: { figure: string; typed: string }) {
  const [seen, setSeen] = useState({ figure, typed });
  const [bump, setBump] = useState(0);
  if (seen.figure !== figure || seen.typed !== typed) {
    if (seen.figure !== figure && seen.typed === typed) setBump((b) => b + 1);
    setSeen({ figure, typed });
  }
  return (
    <b className={bump > 0 ? "fresh" : undefined} key={bump}>
      {figure}
    </b>
  );
}

/** The sheet itself: the engraved waves behind, the head line, then whatever the cheque holds. */
function Sheet({ head, children, onSubmit, labelledBy }: { head: ReactNode; children: ReactNode; onSubmit?: () => void; labelledBy?: string }) {
  return (
    <form
      className="cheque"
      aria-labelledby={labelledBy}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.();
      }}
    >
      <Waves />
      <div className="cq-head">
        <span>
          <b>{WORDS.cheque.brand}</b> · {WORDS.cheque.pays}
        </span>
        {head}
      </div>
      {children}
    </form>
  );
}

/** What a visitor keeps back for gas on Arc when sending a pledge themself: an approval and a pledge have cost about 0.006 USDC there. */
const GAS_RESERVE = 20_000n;

/**
 * The pledge form for one campaign. `choices` turns the payee line into a list to pick from (the
 * landing page); without it the payee is the campaign's name. `initial` is the amount the cheque
 * starts with.
 */
export function Cheque({
  ctx,
  campaign,
  focus,
  initial = "",
  choices,
  onChoose,
}: {
  ctx: Ctx;
  campaign: CampaignView;
  focus: boolean;
  initial?: string;
  choices?: readonly { id: bigint; title: string }[];
  onChoose?: (id: bigint) => void;
}) {
  const { world, config } = ctx;
  const id = campaign.id;
  const [text, setText] = useState(initial);
  // The contract's answer, kept with the amount it was asked about and never used for another.
  const [answered, setAnswered] = useState<{ amount: bigint; answer: Answer } | null>(null);
  const [changed, setChanged] = useState<string | null>(null);
  const [desk, setDesk] = useState<{ busy: boolean; line: string | null; ok: boolean; askedBy: Address | null }>({ busy: false, line: null, ok: false, askedBy: null });
  const asked = useRef(0);
  const field = useRef<HTMLInputElement>(null);
  const once = useRef(oneAtATime()).current; // one submit at a time, its last check included
  // Set once the one-signature pledge has not gone through: this visit then pledges in two steps,
  // and the line says why.
  const [twoStep, setTwoStep] = useState(false);
  const [fellBack, setFellBack] = useState<string | null>(null);

  const typed = text.trim() === "" ? null : parseUsd(text.trim());
  const block = world.block;

  useEffect(() => {
    if (focus) field.current?.focus();
  }, [focus]);

  // Ask the contract about what is typed, a moment after typing stops, and again at each new block.
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
    hasWallet: ctx.hasWallet,
    practice: ctx.practice !== null,
    // On Arc gas is paid in USDC. A pledge the visitor sends themself (the two-step route) needs some left over; one the keeper relays does not.
    gasReserve: !config.chain.local && pledgeRoute({ signedPledge: config.signedPledge, relay: ctx.relay, fellBack: twoStep }) !== "signed" ? GAS_RESERVE : 0n,
  });
  const key = `pledge:${id}`;
  const sending = ctx.sendState(key);
  const busy = sending !== null && sending.busy;
  // While a pledge is on its way the cheque keeps what it showed at the press: the receipt, the
  // button, what stands in the way and the desk's offer. The form above is still worked out from
  // the chain as it is now, and is what the cheque goes back to the moment the send ends.
  const kept = useRef<{ id: bigint; shown: { form: typeof live; receipt: ReturnType<typeof receiptView>; offer: ReturnType<typeof deskOffer> } } | null>(null);
  const current = {
    form: live,
    receipt: receiptView({ form: live, campaign }),
    // The desk's USDC is offered to an account that is short of it (under the 2.00 the desk gives), not to one that already holds enough.
    offer: own.balance !== null && own.balance < 2_000_000n ? deskOffer({ desk: ctx.desk, account: ctx.account, had: ctx.hadUsdc }) : null,
  };
  const { shown, held } = shownWhileSending({ busy, id, kept: kept.current, now: current });
  if (!busy) kept.current = { id, shown: current };
  const { form, receipt, offer } = shown;
  const route = pledgeRoute({ signedPledge: config.signedPledge, relay: ctx.relay, fellBack: twoStep });

  const submit = () => {
    const account = ctx.account;
    // Nobody connected: the button connects the browser's wallet, or, where there is none, starts a practice one.
    if (account === null) return ctx.hasWallet ? ctx.connect() : ctx.practice?.();
    const { amount, quote, calls } = live;
    if (!live.canSend || amount === null || quote === null) return;
    void once(async () => {
      setChanged(null);
      setDesk((d) => (d.line === null ? d : { ...d, line: null })); // the desk's last answer has been read by now
      // Ask the contract once more. If its answer is no longer what is on the screen, show the
      // new one and stop: the visitor decides again.
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
      // A signature to this campaign that may still land holds every pledge back until it cannot.
      const guard = await ctx.signedGuard(id);
      if (guard.kind === "unknown") {
        setChanged(WORDS.pledge.cannotCheck); // the chain cannot be asked: send nothing rather than risk pledging twice
        return;
      }
      if (guard.kind === "wait") {
        setChanged(stillValidLine(guard.left));
        return;
      }
      if (guard.kind === "landed") {
        setFellBack(null);
        setChanged(WORDS.pledge.landed);
        setText("");
        ctx.refresh();
        return;
      }
      if (route === "signed" && latest.kind !== "refused") {
        // The signature is for what the contract will take, so the wallet shows exactly that.
        const r = await ctx.relayPledge(key, { id, amount: latest.counted, closesAt: campaign.terms.closesAt });
        if (r.kind === "done") setText("");
        else if (r.kind === "fallback") {
          setTwoStep(true);
          setFellBack(r.line);
        }
        return;
      }
      const ok = await ctx.send(key, calls);
      if (ok) {
        setText("");
        setFellBack(null);
      }
    });
  };

  const getUsdc = async () => {
    const askedBy = ctx.account;
    setDesk({ busy: true, line: null, ok: false, askedBy });
    const answer = await ctx.askForUsdc();
    setDesk({ busy: false, line: answer.line, ok: answer.ok, askedBy });
    ctx.refresh();
  };

  const { terms: t } = campaign;
  const opens = world.now < t.opensAt;
  const clock = opens ? `${WORDS.cheque.opensIn} ${span(t.opensAt - world.now)}` : `${WORDS.cheque.closesIn} ${span(t.closesAt - world.now)}`;
  const name = nameOf(ctx.labels, campaign, config.desk).title;
  // A cheque opened while its pledge is already on its way, or come back to from another
  // campaign's page, has nothing kept from before the press. It lists nothing as standing in the
  // way: the balance fell when the pledge landed, and "holds 0.00, less than this pledge" would
  // read as a failure.
  const others = busy && !held ? [] : form.blocks.filter((b) => b !== form.line);
  // With one signature the button says so; the amount it names is the form's own.
  const button = ctx.account !== null && route === "signed" ? signedButton(form.button) : form.button;
  const showSent = sending !== null && sending.done && text === "";
  const deskLine = deskAnswerFor({ line: desk.line, askedBy: desk.askedBy, account: ctx.account });

  return (
    <Sheet
      labelledBy="pledge-title"
      onSubmit={submit}
      head={
        <span className="tab">
          {choices ? <a href={hrefFor({ page: "campaign", id })}>{numberOf(id)}</a> : numberOf(id)} · {clock}
        </span>
      }
    >
      <h2 className="sr-only" id="pledge-title">
        {WORDS.pledge.title}
      </h2>
      {choices && choices.length > 1 ? (
        <label className="cq-row">
          {WORDS.cheque.payTo}{" "}
          <select className="fill" value={id.toString()} disabled={busy} onChange={(e) => onChoose?.(BigInt(e.target.value))}>
            {choices.map((c) => (
              <option key={c.id.toString()} value={c.id.toString()}>
                {c.title}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="cq-row">
          {WORDS.cheque.payTo} <span className="fill payee">{name}</span>
        </p>
      )}
      <label className="cq-row" htmlFor="pledge-amount">
        {WORDS.cheque.sumOf}{" "}
        <input
          id="pledge-amount"
          className="fill amt"
          ref={field}
          name="amount"
          inputMode="decimal"
          autoComplete="off"
          value={text}
          readOnly={busy}
          onChange={(e) => setText(e.target.value)}
          aria-describedby="pledge-line"
        />{" "}
        USDC
      </label>

      <div className="cq-sign">
        <div className="ifmiss" id="pledge-line" aria-live="polite">
          {receipt.kind === "two" ? (
            <>
              {receipt.missed.heading}
              <Figure figure={receipt.missed.figure.replace(/ USDC$/, "")} typed={text} />
              <span className="cq-back">{receipt.missed.line}</span>
              <span className="cq-met">
                {receipt.met.heading}, {receipt.met.figure} {receipt.met.line}
              </span>
            </>
          ) : (
            <span className="cq-line">{receipt.line}</span>
          )}
        </div>
        <button className="btn btn-ink" type="submit" disabled={ctx.account !== null ? !form.canSend || !ctx.maySend : ctx.hasWallet ? false : ctx.practice === null || ctx.practiceBusy}>
          {button}
          <span className="arrow" aria-hidden="true">
            →
          </span>
        </button>
      </div>

      <div className="cq-notes">
        {changed ? (
          <p className="problem" role="alert">
            {changed}
          </p>
        ) : null}
        {others.length > 0 ? (
          <ul className="cq-blocks">
            {others.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        ) : null}
        {form.source === "contract" ? <p className="quiet">{WORDS.pledge.fromContract}</p> : form.source === "estimate" ? <p className="quiet">{WORDS.pledge.estimate}</p> : null}
        {route === "signed" && ctx.account !== null ? <p className="quiet">{ctx.practising ? PRACTICE.oneSignature : WORDS.pledge.oneSignature}</p> : null}
        {/* With a wallet in the browser the cheque's button connects it, and the practice wallet is offered under it. */}
        {ctx.account === null && ctx.hasWallet ? <Practice ctx={ctx} /> : null}
        {fellBack ? (
          <p className="problem" role="status">
            {fellBack}
          </p>
        ) : null}
        {/* A send's steps show while it runs and when it fails; once it is in, one line says so. */}
        <SendStatus state={sending && (sending.busy || sending.error !== null) ? sending : null} />
        {showSent ? (
          <p role="status" className="cq-sent">
            {pledgeSentLine(!choices)} {choices ? <a href={hrefFor({ page: "campaign", id })}>{WORDS.cheque.seeIt}</a> : null}
          </p>
        ) : null}
        {/* The desk's answer outlives its offer: once the desk has given, the offer goes and the answer still has to be read. */}
        {offer || deskLine ? (
          <div className="cq-desk">
            {offer ? (
              <>
                <button type="button" className="btn btn-line" onClick={getUsdc} disabled={desk.busy || busy}>
                  {offer.button}
                </button>
                <p className="quiet">{offer.note}</p>
              </>
            ) : null}
            {deskLine ? (
              <p className={desk.ok ? undefined : "problem"} role="status">
                {deskLine}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

/**
 * The landing page's cheque. It is made out to a campaign that is taking pledges, or about to:
 * the newest by default, any of them by choice. When none is, the cheque is blank and offers a
 * two-minute campaign from the site's desk (or a ten-minute one), where there is one.
 */
export function HeroCheque({ ctx }: { ctx: Ctx }) {
  const { world, config } = ctx;
  const [picked, setPicked] = useState<bigint | null>(null);
  const desk = useDesk(ctx);

  // Taking pledges first, then those about to open; the newest first within each.
  const rank = (c: CampaignView) => (phaseOf(c.terms, c.state, world.now) === "waiting" ? 1 : 0);
  const live = world.campaigns
    .filter((c) => {
      const phase = phaseOf(c.terms, c.state, world.now);
      return phase === "early" || phase === "open" || phase === "waiting";
    })
    .sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? 1 : -1));

  // Once a campaign is on the cheque it stays there until it stops taking pledges: a newer one
  // opening must never change who a half-written cheque is made out to.
  // And while a pledge to it is in the wallet or on its way, it stays even past its deadline, so the
  // cheque on screen is always the one being signed and its outcome is shown where it was sent.
  const held = picked !== null && ctx.sendState(`pledge:${picked}`)?.busy ? world.campaigns.find((c) => c.id === picked) : undefined;
  const campaign = held ?? live.find((c) => c.id === picked) ?? live[0];
  if (campaign && picked !== campaign.id) setPicked(campaign.id);
  if (campaign) {
    const listed = live.some((c) => c.id === campaign.id) ? live : [campaign, ...live];
    const choices = listed.map((c) => ({ id: c.id, title: nameOf(ctx.labels, c, config.desk).title }));
    return <Cheque key={campaign.id.toString()} ctx={ctx} campaign={campaign} focus={false} initial={WORDS.cheque.startWith} choices={choices} onChoose={setPicked} />;
  }

  return (
    <Sheet head={<span>{WORDS.cheque.noneOpen}</span>} onSubmit={config.desk === null ? undefined : () => desk.open("two")}>
      <p className="cq-row">
        {WORDS.cheque.payTo} <span className="fill payee blank" />
      </p>
      <div className="cq-sign">
        <div className="ifmiss">
          <span className="cq-line">{config.desk === null ? WORDS.cheque.noneNote : WORDS.cheque.deskNote}</span>
        </div>
        {config.desk === null ? null : (
          <div className="cq-starts">
            <button className="btn btn-ink" type="submit" disabled={desk.busy}>
              {WORDS.cheque.start}
              <span className="arrow" aria-hidden="true">
                →
              </span>
            </button>
            <button className="btn btn-plain" type="button" onClick={() => desk.open("ten")} disabled={desk.busy}>
              {WORDS.cheque.startTen}
            </button>
          </div>
        )}
      </div>
      {desk.line ? (
        <div className="cq-notes">
          <p className={desk.ok ? undefined : "problem"} role="status">
            {desk.line}
          </p>
        </div>
      ) : null}
    </Sheet>
  );
}
