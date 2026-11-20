// The landing page: a hero that reads the headline, the pledge cheque and the flight scene; the
// pinned "how it works" block; the live campaigns table; the guarantee; and the closing call. All
// the copy is the mockup's. The page writes no figure of its own: the table and the cheque read
// the chain, and the motion lives in motion.ts, started once over this page's root.
import { useEffect, useRef } from "react";

import type { Ctx } from "../app/context.ts";
import { paceOf } from "../data/pace.ts";
import { useDesk } from "../ui/desk.ts";
import { Flight } from "../ui/Flight.tsx";
import { HeroCheque } from "../ui/Cheque.tsx";
import { HowBoard } from "../ui/HowBoard.tsx";
import { Ledger } from "../ui/Ledger.tsx";
import { mountLanding, scrollToSection } from "../ui/motion.ts";
import { explorerLink } from "../views/links.ts";
import { homePage } from "../views/home.ts";
import { ledgerSub } from "../views/ledger.ts";
import { settlementLine } from "../views/settlement.ts";
import { pledgeRoute } from "../views/pledge.ts";

export function Home({ ctx }: { ctx: Ctx }) {
  const { world, config } = ctx;
  const page = homePage({ campaigns: world.campaigns, count: world.count, labels: ctx.labels, desk: config.desk, now: world.now, block: world.block });
  const desk = useDesk(ctx);
  const source = explorerLink(config.chain.explorer, "address", config.boomerang);
  // Said only while it is true: the keeper is relaying signed pledges right now.
  const oneSignature = pledgeRoute({ signedPledge: config.signedPledge, relay: ctx.relay, fellBack: false }) === "signed";

  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (el === null) return;
    return mountLanding(el);
  }, []);

  return (
    <div className="landing" ref={root}>
      <div className="wrap">
        <header className="hero">
          <div className="copy">
            <h1>
              <span className="line">
                <span>Money that</span>
              </span>
              <span className="line">
                <span>comes back</span>
              </span>
              <span className="line">
                <span>
                  <em>if the goal doesn't.</em>
                </span>
              </span>
            </h1>
            <p className="lede">
              Back a goal in USDC. If it hits its target, the recipient is paid. If it falls short, every pledge comes back in full, and early backers earn a bonus.
            </p>
            <div className="hero-cheque">
              <HeroCheque ctx={ctx} />
            </div>
            <div className="trust">
              <span>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 1.5 13.5 4v4c0 3.2-2.3 5.6-5.5 6.5C4.8 13.6 2.5 11.2 2.5 8V4Z" fill="none" stroke="currentColor" strokeWidth="1.4" />
                  <path d="m5.6 8 1.7 1.7L10.6 6.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Verified contract, no owner
              </span>
              <span>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
                  <path d="M8 4.6V8l2.3 1.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
                Paid back after the deadline, even if this site is gone
              </span>
              {oneSignature ? (
                <span>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3 9.5 6.5 13 13 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  One signature, no gas
                </span>
              ) : null}
            </div>
          </div>
          <Flight />
        </header>
      </div>

      <section id="how" className="wrap" aria-label="How it works">
        <HowBoard />
      </section>

      <section id="ledger" className="wrap" aria-labelledby="ledger-h">
        <h2 id="ledger-h">
          Cleared, <em>or returned.</em>
        </h2>
        <p className="sub">{ledgerSub({ count: world.count, read: world.campaigns.length })}</p>
        <Ledger ctx={ctx} />
      </section>

      <section id="guarantee" className="wrap" aria-labelledby="guarantee-h">
        <div className="guar">
          <div>
            <h2 id="guarantee-h">
              The promise is in the code, <em>not the page.</em>
            </h2>
            <p className="sub">{settlementLine(paceOf(world.keeper, world.block))}</p>
            <div className="contract">
              <span>Contract</span>
              <span className="mono">{config.boomerang}</span>
              {source ? (
                <a href={source} target="_blank" rel="noreferrer noopener">
                  View source
                </a>
              ) : null}
            </div>
          </div>
          <div className="facts">
            <p>
              <b>No owner</b>Nobody can change a campaign's rules once it exists.
            </p>
            <p>
              <b>No early exit</b>The sponsor's pots are locked before it opens.
            </p>
            <p>
              <b>No pause, no upgrade</b>The contract you check is the one that pays.
            </p>
            <p>
              <b>Never short</b>It is built never to hold less than it owes, and Proof re-checks that at every read.
            </p>
          </div>
        </div>
      </section>

      <section className="closing wrap">
        <h2>
          Back it early. <em>It comes back if it misses.</em>
        </h2>
        <p className="sub">{page.closing}</p>
        {page.demo ? (
          <>
            <button type="button" className="btn btn-ink" onClick={() => desk.open("two")} disabled={desk.busy}>
              {page.demo.button}{" "}
              <span className="arrow" aria-hidden="true">
                →
              </span>
            </button>
            <p className="other">
              <button type="button" className="btn btn-plain" onClick={() => desk.open("ten")} disabled={desk.busy}>
                {page.demo.other}
              </button>
            </p>
            {desk.line ? (
              <p className={desk.ok ? "" : "problem"} role="status">
                {desk.line}
              </p>
            ) : null}
          </>
        ) : (
          <button type="button" className="btn btn-plain" onClick={() => scrollToSection("ledger")}>
            See the campaigns
          </button>
        )}
      </section>
    </div>
  );
}
