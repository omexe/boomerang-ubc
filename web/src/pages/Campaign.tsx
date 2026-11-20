import type { Ctx } from "../app/context.ts";
import { hrefFor } from "../app/route.ts";
import { campaignIn, ownIn } from "../app/world.ts";
import { paceOf } from "../data/pace.ts";
import { finalizeCall, payCall, paySideCall } from "../flows/calls.ts";
import { Band, OutcomeStamp } from "../ui/Board.tsx";
import { Chart } from "../ui/Chart.tsx";
import { Cheque } from "../ui/Cheque.tsx";
import { Feed, Rows, Section, SendStatus } from "../ui/parts.tsx";
import { Practice } from "../ui/Practice.tsx";
import { backersTable } from "../views/backers.ts";
import { agoOf, boardView, settledLine } from "../views/board.ts";
import { campaignPage, missingPage, voucherMine } from "../views/campaign.ts";
import { feedView } from "../views/feed.ts";
import { minePage } from "../views/mine.ts";
import { WORDS } from "../views/shell.ts";

export function Missing({ ctx, id }: { ctx: Ctx; id: bigint }) {
  const page = missingPage({ id, count: ctx.world.count, expected: ctx.expected(id) });
  if (page.loading) {
    return (
      <section className="lost" aria-busy="true">
        <p className="quiet">{page.title}…</p>
      </section>
    );
  }
  return (
    <section className="lost">
      <h1>{page.title}</h1>
      <p>{page.line}</p>
      <p>
        <a href={page.homeHref}>{WORDS.campaign.back}</a>
      </p>
    </section>
  );
}

/** The campaign page. `focus` puts the cursor in the amount field (the old Pledge page's address). */
export function Campaign({ ctx, id, focus = false }: { ctx: Ctx; id: bigint; focus?: boolean }) {
  const { world, config } = ctx;
  const campaign = campaignIn(world, id);
  if (!campaign) return <Missing ctx={ctx} id={id} />;
  const pace = paceOf(world.keeper, world.block).state;
  const page = campaignPage({ campaign, labels: ctx.labels, desk: config.desk, now: world.now, block: world.block, pace });
  // Without an account the buttons that send something become ways to get one: connect a wallet, or try a practice one.
  const connectButton =
    ctx.account === null ? (
      <>
        {ctx.hasWallet ? (
          <button type="button" className="btn btn-line" onClick={ctx.connect}>
            {WORDS.connect}
          </button>
        ) : null}
        <Practice ctx={ctx} />
      </>
    ) : null;
  // The connected account's own pledge to this campaign, in My money's own words; it offers the refund when one is owed.
  const own = ownIn(world, ctx.account);
  const myRow = own.known
    ? (minePage({ account: ctx.account, mine: own.mine.filter((m) => m.campaign.id === id), labels: ctx.labels, desk: config.desk, block: world.block, pace }).rows[0] ?? null)
    : null;
  const mine = voucherMine(myRow);
  const payKey = `pay:${id}`;
  const board = boardView({ campaign, now: world.now });
  const ledger = world.keeper.up ? world.keeper.ledger : null;
  const feed = feedView({ ledger, campaign: id, limit: 4 });
  const backers = backersTable({ campaign, shown: world.shownBackers, keeperUp: world.keeper.up, block: world.block });
  const key = `settle:${id}`;
  const sending = ctx.sendState(key);
  const taking = page.phase === "early" || page.phase === "open" || page.phase === "waiting";
  const live = page.phase === "early" || page.phase === "open";
  const settled = settledLine(campaign);
  // The stamp lands only once the outcome is final; a campaign still waiting to be settled shows none.
  const showStamp = board.result !== null && !page.settle;

  return (
    <article className={`campaign phase-${page.phase}`}>
      <p>
        <a className="back" href={hrefFor({ page: "home" })}>
          {WORDS.campaign.back}
        </a>
      </p>
      <header className="camp-head">
        <h1>{page.name.title}</h1>
        <p className="by">{page.name.by}</p>
        {page.name.about ? <p className="about">{page.name.about}</p> : null}
        {/* A desk campaign already says whose it is, in the two lines above; the tag is for an example with a name and a story of the site's. */}
        {page.name.example && page.name.labelled ? <p className="tag">{WORDS.campaign.example}</p> : null}
      </header>

      <div className="camp-body">
        <div className="camp-main">
          <Band campaign={campaign} now={world.now} />
          <div className="camp-chart">
            <Chart campaign={campaign} ledger={ledger} now={world.now} raised={page.raised} backers={page.backers} live={live} />
          </div>
        </div>
        <div className="camp-side">
          {taking ? (
            <Cheque ctx={ctx} campaign={campaign} focus={focus} />
          ) : (
            <section className="voucher">
              {showStamp && board.result ? <OutcomeStamp result={board.result} /> : null}
              {mine ? (
                <p className={`voucher-mine${mine.cameBack ? " came-back" : ""}`}>
                  <span className="caption">{mine.label}</span>
                  {mine.line}
                </p>
              ) : null}
              <p className="voucher-status">{page.status}</p>
              {settled ? <p className="voucher-figure">{settled}</p> : null}
              <p className="voucher-promise">{page.promise}</p>
              {page.settle ? (
                <div className="settle">
                  {ctx.account ? (
                    <button type="button" className="btn btn-ink" disabled={!ctx.maySend} onClick={() => void ctx.send(key, [finalizeCall({ boomerang: config.boomerang, id })])}>
                      {page.settle.button}
                    </button>
                  ) : (
                    connectButton
                  )}
                  <p className="quiet">{page.settle.note}</p>
                  <SendStatus state={sending} />
                </div>
              ) : page.pledgeWhy ? (
                <p className="quiet">{page.pledgeWhy}</p>
              ) : null}
              {myRow && myRow.send && ctx.account ? (
                <div className="dues">
                  <ul>
                    <li>
                      <p>{myRow.line}</p>
                      <button type="button" className="btn btn-line" disabled={!ctx.maySend} onClick={() => void ctx.send(payKey, [payCall({ boomerang: config.boomerang, id, backer: ctx.account! })])}>
                        {myRow.send.button}
                      </button>
                      <SendStatus state={ctx.sendState(payKey)} />
                    </li>
                  </ul>
                  <p className="quiet">{myRow.send.note}</p>
                </div>
              ) : null}
              {page.dues.length > 0 ? (
                <div className="dues">
                  <ul>
                    {page.dues.map((d) => {
                      const dueKey = `side:${id}:${d.side}`;
                      return (
                        <li key={d.side}>
                          <p>{d.line}</p>
                          {ctx.account ? (
                            <button
                              type="button"
                              className="btn btn-line"
                              disabled={!ctx.maySend}
                              onClick={() => void ctx.send(dueKey, [paySideCall({ boomerang: config.boomerang, id, side: d.side, label: d.button })])}
                            >
                              {d.button}
                            </button>
                          ) : null}
                          <SendStatus state={ctx.sendState(dueKey)} />
                        </li>
                      );
                    })}
                  </ul>
                  {connectButton}
                  <p className="quiet">{page.duesNote}</p>
                </div>
              ) : null}
              {/* The note on sending a refund is for someone who may still have one to send, not for a backer already paid. */}
              {page.refunds && !(myRow && myRow.send && ctx.account) && !(mine && mine.cameBack) ? <p className="quiet">{page.refunds}</p> : null}
            </section>
          )}
        </div>
      </div>

      {taking ? <p className="promise">{page.promise}</p> : null}

      <div className="under">
        <Section title={WORDS.campaign.feed}>
          <Feed feed={feed} explorer={config.chain.explorer} ago={agoOf(ledger, world.now)} />
        </Section>
        <Section title={WORDS.campaign.terms}>
          <Rows rows={page.rows} explorer={config.chain.explorer} />
          <p className="control">{page.control}</p>
          <p className="quiet">{page.name.labelled ? WORDS.campaign.siteWords : page.name.example ? WORDS.campaign.deskWords : WORDS.campaign.chainWords}</p>
        </Section>
      </div>

      <Section title={backers.title}>
        {backers.rows.length > 0 ? (
          <table className="backers">
            <thead>
              <tr>
                {backers.head.map((h) => (
                  <th scope="col" key={h}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {backers.rows.map((r) => (
                <tr key={r.key} className={`kind-${r.kind}`}>
                  <td className="b-account">{r.href ? <a href={r.href}>{r.account}</a> : r.account}</td>
                  <td className="b-pledged">{r.pledged}</td>
                  <td className="b-when">{r.when}</td>
                  <td className="b-back">{r.back}</td>
                </tr>
              ))}
            </tbody>
            {backers.total ? (
              <tfoot>
                <tr>
                  <td className="b-total-label">{backers.total.label}</td>
                  <td className="b-total-pledged">{backers.total.pledged}</td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        ) : null}
        {backers.note ? <p className="quiet">{backers.note}</p> : null}
      </Section>
    </article>
  );
}
