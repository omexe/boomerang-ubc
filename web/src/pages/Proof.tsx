import { useEffect, useRef, useState } from "react";

import { clientFor } from "../app/chain.ts";
import type { Config } from "../app/config.ts";
import type { Ctx } from "../app/context.ts";
import { paceOf } from "../data/pace.ts";
import { Rows, Section } from "../ui/parts.tsx";
import { checksView, type ChecksState } from "../views/checks.ts";
import { proofPage } from "../views/proof.ts";
import { WORDS } from "../views/shell.ts";

// A verdict holds, fails, or cannot be told yet. A drawn check reads for the first, a cross for the
// second, a dash for the third; the colour comes from the verdict line's own state class.
const HOLDS = new Set(["ok", "agrees"]);
const FAILS = new Set(["short", "differs", "ahead"]);

function Mark({ state }: { state: string }) {
  if (HOLDS.has(state)) {
    return (
      <svg className="vmark" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3 8.5 6.5 12 13 4.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (FAILS.has(state)) {
    return (
      <svg className="vmark" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4 4 12 12M12 4 4 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg className="vmark" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 8 12 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// The "Check it here" section: a button that runs the keyless checks in this browser, then one
// line per check. State lives here; a run's result is ignored once the component has unmounted or
// a newer run has started. The checks and the ledger code are loaded only when the button is
// pressed, so they stay out of the first load.
function Checks({ config }: { config: Config }) {
  const [state, setState] = useState<ChecksState>({ phase: "idle" });
  const run = useRef(0);
  const alive = useRef(true);
  // Set on every mount: React's development mode mounts, unmounts and mounts again, and a ref
  // that was only ever cleared would drop every result after that.
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  const view = checksView(state);

  async function go() {
    const mine = ++run.current;
    setState({ phase: "running", progress: null });
    try {
      const { runChecks } = await import("../flows/checks.ts");
      const results = await runChecks({
        client: clientFor(config),
        boomerang: config.boomerang,
        usdc: config.usdc,
        fromBlock: config.deployBlock,
        explorer: config.chain.explorer,
        // Arc's public node takes about three log requests a second from one visitor.
        gapMs: config.chain.local ? 0 : 350,
        fetch: (url) => fetch(url, { credentials: "omit", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) }),
        onProgress: (progress) => {
          if (alive.current && run.current === mine) setState({ phase: "running", progress });
        },
      });
      if (!alive.current || run.current !== mine) return;
      setState({ phase: "done", results });
    } catch {
      // The checks' own code did not load (a dropped connection, a page older than the site).
      if (alive.current && run.current === mine) setState({ phase: "failed" });
    }
  }

  return (
    <Section title={view.title}>
      <p className="proof-line">{view.intro}</p>
      {view.button ? (
        <button type="button" className="btn btn-line checks-run" onClick={() => void go()}>
          {view.button}
        </button>
      ) : null}
      {view.running ? (
        <p className="quiet" role="status">
          {view.running}
        </p>
      ) : null}
      {view.rows.length > 0 ? (
        <div className="checks-rows">
          {view.rows.map((r) => (
            <div className="check-row" key={r.id}>
              <p className={`verdict ${r.state === "ok" ? "verdict-ok" : "verdict-short"}`}>
                <Mark state={r.state === "ok" ? "ok" : "short"} />
                {r.claim}
              </p>
              <p className="check-detail">{r.detail}</p>
            </div>
          ))}
        </div>
      ) : null}
      {view.verdict ? <p className="checks-verdict">{view.verdict}</p> : null}
      <p className="proof-line">{view.outside}</p>
    </Section>
  );
}

export function Proof({ ctx }: { ctx: Ctx }) {
  const { world, config } = ctx;
  const page = proofPage({
    custody: world.custody,
    campaigns: world.campaigns,
    count: world.count,
    ledger: world.keeper.up ? world.keeper.ledger : null,
    health: world.keeper.up ? world.keeper.health : null,
    backerChecks: world.backerChecks,
    backerTotal: world.backerTotal,
    where: { boomerang: config.boomerang, usdc: config.usdc, router: config.router },
    labels: ctx.labels,
    desk: config.desk,
    now: world.now,
    pace: paceOf(world.keeper, world.block),
  });

  return (
    <article className="proof">
      <h1>{WORDS.proof.title}</h1>

      <Section title={WORDS.proof.custody}>
        <p className={`verdict verdict-${page.custody.state}`}>
          <Mark state={page.custody.state} />
          {page.custody.line}
        </p>
        {page.custody.detail ? <p className="quiet">{page.custody.detail}</p> : null}
      </Section>

      <Section title={WORDS.proof.second}>
        <p className={`verdict verdict-${page.second.state}`}>
          <Mark state={page.second.state} />
          {page.second.line}
        </p>
        {page.second.differences.length > 0 ? (
          <ul className="differences">
            {page.second.differences.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        ) : null}
      </Section>

      {page.keeper ? (
        <Section title={WORDS.proof.keeper}>
          <Rows rows={page.keeper} explorer={null} />
        </Section>
      ) : null}

      {page.keeperErrors.length > 0 ? (
        <Section title={WORDS.proof.errors}>
          <ul className="differences">
            {page.keeperErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title={WORDS.proof.facts}>
        <Rows rows={page.facts} explorer={config.chain.explorer} />
      </Section>

      <Section title={page.campaigns.title}>
        <table className="checks-campaigns">
          <thead>
            <tr>
              {page.campaigns.head.map((h) => (
                <th key={h} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.campaigns.rows.map((r) => (
              <tr key={r.href}>
                <td data-label={page.campaigns.head[0]}>
                  <a href={r.href}>{r.name}</a>
                </td>
                <td data-label={page.campaigns.head[1]}>{r.ended}</td>
                <td data-label={page.campaigns.head[2]}>{r.pledged}</td>
                <td data-label={page.campaigns.head[3]}>{r.paid}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {page.campaigns.note ? <p className="quiet">{page.campaigns.note}</p> : null}
      </Section>

      <Checks config={config} />

      <Section title={WORDS.proof.yourself}>
        <p className="proof-line">{page.yourself.line}</p>
        <pre>
          <code>{page.yourself.commands.join("\n")}</code>
        </pre>
      </Section>

      <Section title={WORDS.proof.limits}>
        <ul className="limits">
          {page.limits.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </Section>
    </article>
  );
}
