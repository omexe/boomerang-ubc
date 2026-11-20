// The campaigns table: every campaign on the contract, read from the chain, open ones first. The
// rows, the stamp for each and the running totals under the table all come from ledgerView.
import type { Ctx } from "../app/context.ts";
import { ledgerView, type Mark } from "../views/ledger.ts";

/** The Outcome cell: the mockup's stamp for a cleared or returned campaign, plain text otherwise. */
function Outcome({ mark }: { mark: Mark }) {
  if (mark.kind === "cleared" || mark.kind === "returned") {
    return (
      <span role="cell" className={`mark-out ${mark.kind}`}>
        {mark.word}
        <small>{mark.small}</small>
      </span>
    );
  }
  return (
    <span role="cell" className="lout">
      {mark.word}
      {mark.small ? <small>{mark.small}</small> : null}
    </span>
  );
}

export function Ledger({ ctx }: { ctx: Ctx }) {
  const table = ledgerView({ campaigns: ctx.world.campaigns, count: ctx.world.count, labels: ctx.labels, desk: ctx.config.desk, now: ctx.world.now, block: ctx.world.block });
  const totals = table.totals;

  return (
    <>
      {table.empty ? (
        <p className="led-empty">{table.empty}</p>
      ) : (
        <div className="ledger" role="table" aria-label="Campaigns">
          <div className="lrow headrow" role="row">
            <span role="columnheader">Campaign</span>
            <span role="columnheader">Raised</span>
            <span role="columnheader">Backers</span>
            <span role="columnheader">Deadline (UTC)</span>
            <span role="columnheader">Outcome</span>
          </div>
          {table.rows.map((row) => (
            <div className="lrow" role="row" key={row.href}>
              <span className="lname" role="cell">
                <a href={row.href}>{row.name}</a>
                <small>{row.note}</small>
              </span>
              <span className="tab" role="cell">
                {row.raised}
              </span>
              <span className="tab" role="cell">
                {row.backers}
              </span>
              <span role="cell">{row.deadline}</span>
              <Outcome mark={row.mark} />
            </div>
          ))}
        </div>
      )}

      <dl className="ltotals">
        {totals.map((t) => (
          <div key={t.label}>
            <dt>{t.label}</dt>
            <dd className="tab">{t.value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
