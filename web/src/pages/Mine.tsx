import { useState, type FormEvent } from "react";

import type { Address } from "../../../packages/kit/src/index.ts";
import type { Ctx } from "../app/context.ts";
import { hrefFor } from "../app/route.ts";
import { ownIn } from "../app/world.ts";
import { paceOf } from "../data/pace.ts";
import { payCall } from "../flows/calls.ts";
import { Practice } from "../ui/Practice.tsx";
import { Rows, Section, SendStatus } from "../ui/parts.tsx";
import { explorerLink } from "../views/links.ts";
import { LOOKUP, lookupForm, minePage, type MinePage } from "../views/mine.ts";
import { WORDS } from "../views/shell.ts";

/** The field at the top of My money: type any address, go to that account's money, or be told it is not an address. */
function LookupField() {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const result = lookupForm(text);
    if (result.href !== null) {
      window.location.hash = result.href;
      return;
    }
    setProblem(result.problem);
  };
  return (
    <form className="lookup" onSubmit={onSubmit}>
      <label className="lookup-label" htmlFor="lookup-address">
        {LOOKUP.label}
      </label>
      <div className="lookup-row">
        <input
          id="lookup-address"
          className="lookup-input mono"
          type="text"
          value={text}
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
          onChange={(e) => {
            setText(e.target.value);
            if (problem !== null) setProblem(null); // the problem stands until the text changes
          }}
        />
        <button type="submit" className="btn btn-line">
          {LOOKUP.button}
        </button>
      </div>
      {problem !== null ? (
        <p className="problem" role="alert">
          {problem}
        </p>
      ) : null}
    </form>
  );
}

/** `who` is the address in the route (#/mine/0x…): another account's money to show; null for the visitor's own. */
export function Mine({ ctx, who }: { ctx: Ctx; who: Address | null }) {
  const { world, config } = ctx;
  // The pledges read belong to `world.account`; until a read for the connected account arrives, show nothing of another's.
  const own = ownIn(world, ctx.account);
  const connected = own.known ? ctx.account : null;
  const eq = (a: Address, b: Address | null) => b !== null && a.toLowerCase() === b.toLowerCase();

  // Which of the five cases the page is in (see the brief's order).
  type Mode = { k: "own"; back: boolean } | { k: "other" } | { k: "loading" } | { k: "example" } | { k: "empty" };
  let mode: Mode;
  if (who !== null) {
    if (eq(who, ctx.account)) mode = { k: "own", back: true };
    else if (world.lookup !== null && !world.lookup.example && eq(world.lookup.address, who)) mode = { k: "other" };
    else mode = { k: "loading" };
  } else if (ctx.account !== null) mode = { k: "own", back: false };
  else if (world.lookup?.example) mode = { k: "example" };
  else mode = { k: "empty" };

  const base = { labels: ctx.labels, desk: config.desk, block: world.block, pace: paceOf(world.keeper, world.block).state, hasWallet: ctx.hasWallet, count: world.count, read: world.campaigns.length };
  const third = mode.k === "other" || mode.k === "example";
  // The address whose pledges are shown, and so the one any refund here would pay.
  const shown: Address | null = mode.k === "own" ? connected : third ? world.lookup!.address : null;
  // Reading the connected account's pledges for the first time: today's quiet "reading" state.
  const reading = mode.k === "own" && ctx.account !== null && connected === null;

  let page: MinePage | null = null;
  if (mode.k === "other" || mode.k === "example") page = minePage({ account: world.lookup!.address, mine: world.lookup!.mine, whose: mode.k, ...base });
  else if (mode.k === "own") page = minePage({ account: connected, mine: own.mine, ...base });
  else if (mode.k === "empty") page = minePage({ account: null, mine: [], ...base });

  const backLink = (mode.k === "own" && mode.back) || mode.k === "other";
  const subjectLink = page && page.subject.address !== null ? explorerLink(config.chain.explorer, "address", page.subject.address) : null;
  const connectButton = (
    <button type="button" className="btn btn-ink" onClick={ctx.connect}>
      {WORDS.connect}
    </button>
  );

  return (
    <article className="mine">
      <h1>{WORDS.mine.title}</h1>

      <LookupField />

      {page && page.subject.tag !== null && page.subject.address !== null ? (
        <div className="subject">
          <p className="subject-tag">{page.subject.tag}</p>
          {subjectLink ? (
            <a className="subject-address mono" href={subjectLink} target="_blank" rel="noreferrer noopener" title={WORDS.explorer}>
              {page.subject.address}
            </a>
          ) : (
            <p className="subject-address mono">{page.subject.address}</p>
          )}
          {page.subject.note ? <p className="quiet">{page.subject.note}</p> : null}
        </div>
      ) : page && page.account ? (
        <p className="mine-account mono">{page.account}</p>
      ) : null}

      {backLink ? (
        <a className="mine-back" href={hrefFor({ page: "mine" })}>
          {LOOKUP.back}
        </a>
      ) : null}

      {reading || mode.k === "loading" ? <p className="quiet">{WORDS.loading}</p> : null}

      {page && page.empty && !reading ? (
        <p className="mine-empty">
          {page.empty} {ctx.account === null && ctx.hasWallet && mode.k !== "example" ? connectButton : null}
        </p>
      ) : null}

      {page && page.figures.length > 0 ? (
        <dl className="figures">
          {page.figures.map((f) => (
            <div className="figure" key={f.label}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {page && page.rows.length > 0 ? (
        <ul className="pledges">
          {page.rows.map((r) => {
            const key = r.send ? (third ? `pay:${r.send.campaign}:${shown!.toLowerCase()}` : `pay:${r.send.campaign}`) : "";
            const canSend = r.send !== null && shown !== null && ctx.account !== null;
            return (
              <li key={r.href} className={`pledge-row kind-${r.kind}`}>
                <a href={r.href}>{r.title}</a>
                <p className="pledge-line">{r.line}</p>
                {r.refundTo ? <p className="quiet">{r.refundTo}</p> : null}
                {r.send && canSend ? (
                  <div className="pledge-pay">
                    <button type="button" className="btn btn-line" disabled={!ctx.maySend} onClick={() => void ctx.send(key, [payCall({ boomerang: config.boomerang, id: r.send!.campaign, backer: shown! })])}>
                      {r.send.button}
                    </button>
                    <p className="quiet">{r.send.note}</p>
                    <SendStatus state={ctx.sendState(key)} />
                  </div>
                ) : r.send ? (
                  <p className="quiet">{r.send.note}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {page && page.connectNote && ctx.account === null ? <p className="quiet">{page.connectNote}</p> : null}

      {page && page.totals.length > 0 ? (
        <Section title={WORDS.mine.totals}>
          <Rows rows={page.totals} explorer={null} />
        </Section>
      ) : null}

      {/* A way to get an account: under the example, and under another account's page when a refund there waits to be sent. */}
      {(mode.k === "example" || (mode.k === "other" && page?.connectNote)) && ctx.account === null && ctx.hasWallet ? connectButton : null}
      {mode.k === "example" || mode.k === "empty" || (mode.k === "other" && page?.connectNote) ? <Practice ctx={ctx} /> : null}
    </article>
  );
}
