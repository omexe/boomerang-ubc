// Small pieces the pages share. They lay out what the view functions return; the one word they add
// is the EARLY tag, which stands for the feed line's own ", early".
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import type { Row } from "../views/campaign.ts";
import type { FeedView } from "../views/feed.ts";
import { explorerLink } from "../views/links.ts";
import { WORDS } from "../views/shell.ts";

/** A label and value list. A row with an address links to the explorer when there is one. */
export function Rows({ rows, explorer }: { rows: readonly Row[]; explorer: string | null }) {
  return (
    <dl className="rows">
      {rows.map((r) => {
        const link = explorerLink(explorer, "address", r.address);
        return (
          // A value that is a sentence reads from the left under its label; a short one sits flush right beside it.
          <div className={r.value.length > 60 ? "row row-long" : "row"} key={r.label}>
            <dt>{r.label}</dt>
            <dd>
              {link ? (
                <a href={link} target="_blank" rel="noreferrer noopener" title={WORDS.explorer}>
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
  );
}

const EARLY = ", early";

/**
 * The newest events. A new row arriving at the top pushes the rows below down (200 ms) and fades in
 * from above (250 ms, 50 ms later); nothing moves on first render, or with reduced motion.
 */
export function Feed({ feed, explorer, ago }: { feed: FeedView; explorer: string | null; ago?: ReadonlyMap<string, string> }) {
  const list = useRef<HTMLOListElement>(null);
  const first = feed.available && !feed.empty ? (feed.lines[0]?.key ?? null) : null;
  const [seen, setSeen] = useState(first);
  const [arrived, setArrived] = useState(0);
  if (seen !== first) {
    if (seen !== null && first !== null && BigInt(first) > BigInt(seen)) setArrived((n) => n + 1);
    setSeen(first);
  }
  useLayoutEffect(() => {
    const ol = list.current;
    if (arrived === 0 || !ol || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const rows = [...ol.children] as HTMLElement[];
    const top = rows[0];
    if (!top) return;
    const h = top.getBoundingClientRect().height;
    const ease = "cubic-bezier(0.16, 1, 0.3, 1)";
    const moves = [
      top.animate([{ opacity: 0, transform: "translateY(-8px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 250, delay: 50, easing: ease, fill: "backwards" }),
      ...rows.slice(1).map((r) => r.animate([{ transform: `translateY(${-h}px)` }, { transform: "translateY(0)" }], { duration: 200, easing: ease })),
    ];
    return () => moves.forEach((m) => m.cancel());
  }, [arrived]);

  if (!feed.available) return <p className="quiet">{feed.line}</p>;
  if (feed.empty) return <p className="quiet">{feed.empty}</p>;
  return (
    <ol className="feed" ref={list}>
      {feed.lines.map((l) => {
        const link = explorerLink(explorer, "tx", l.txHash);
        // An early pledge's line ends ", early"; the board shows that as a tag instead.
        const early = l.text.endsWith(EARLY);
        return (
          <li key={l.key}>
            <span className="feed-text">{early ? l.text.slice(0, -EARLY.length) : l.text}</span>
            {early ? <span className="feed-early">early</span> : null}
            {l.when ? (
              <time className="feed-when" title={l.when}>
                {ago?.get(l.key) ?? l.when}
              </time>
            ) : null}
            {link ? (
              <a className="feed-link" href={link} target="_blank" rel="noreferrer noopener">
                {WORDS.explorer}
              </a>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** What a send is doing, step by step, and how it ended. */
export function SendStatus({ state }: { state: { lines: string[]; error: string | null; busy: boolean } | null }) {
  if (!state) return null;
  return (
    <div className="send-status" role="status" aria-live="polite">
      {state.lines.map((line, i) => (
        <p key={i}>{line}</p>
      ))}
      {state.error ? <p className="problem">{state.error}</p> : null}
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
