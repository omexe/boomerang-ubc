// The pinned "how it works" block: four steps on the left and one board on the right that plays
// through them. Its figures are the mockup's (the real figures from campaigns 2 and 3). It takes
// no props and is memoised, so the page's per-block re-render never touches the nodes GSAP drives.
//
// The markup is the board's finished missed story (the figures narrow screens and reduced motion
// show through CSS). On wide screens, motion.ts resets the board and scrubs it through the sequence.
import { memo } from "react";

export const HowBoard = memo(function HowBoard() {
  return (
    <div className="how">
      <div>
        <h2>
          Two pots, locked first. <em>Only one is ever paid.</em>
        </h2>
        <ol className="steps">
          <li className="on">
            <h3>Two pots are locked</h3>
            <p>Before anyone pledges, a match for the recipient and a bonus for early backers go into the contract.</p>
          </li>
          <li>
            <h3>Backers pledge</h3>
            <p>The contract holds every pledge. Early ones earn a share of the bonus if the goal is missed.</p>
          </li>
          <li>
            <h3>Met: cleared</h3>
            <p>The recipient gets every pledge plus the match. The bonus goes back to whoever locked it.</p>
          </li>
          <li className="miss">
            <h3>Missed: returned</h3>
            <p>Every pledge comes back in full, early ones with the bonus. The match goes back to the sponsor.</p>
          </li>
        </ol>
      </div>
      <div className="board" aria-hidden="true">
        <div className="board-head">
          <h4>Ten-minute campaign</h4>
          <span>
            Target <b className="tab">3.00</b> USDC
          </span>
        </div>
        <div className="pots">
          <div className="pot match">
            <div className="seal tab">1.00</div>
            <div>
              <b>Match</b>
              <span>to the recipient, if met</span>
            </div>
          </div>
          <div className="pot bonus">
            <div className="seal tab">0.30</div>
            <div>
              <b>Bonus</b>
              <span>to early backers, if missed</span>
            </div>
          </div>
        </div>
        <div className="meter">
          <div className="meter-row">
            <span>
              <b className="tab raised">1.50</b> raised
            </span>
            <span>of 3.00</span>
          </div>
          <div className="bar">
            <i />
          </div>
        </div>
        <ul className="pledges">
          <li className="p1">
            <span className="mono">0x7d6baC4F…</span>
            <span className="tab">
              2.00<span className="tagx">early</span>
            </span>
          </li>
          <li className="p2">
            <span className="mono">0x7c6af56F…</span>
            <span className="tab">
              1.00<span className="tagx">early</span>
            </span>
          </li>
          <li className="p3">
            <span className="mono">0xe4399c4F…</span>
            <span className="tab">
              1.50<span className="tagx">early</span>
            </span>
          </li>
        </ul>
        <div className="stamp cleared">
          Cleared<small>3.00 + 1.00 match to the recipient</small>
        </div>
        <div className="stamp returned">
          Returned<small>1.64 back: 1.50 + 0.14 bonus</small>
        </div>
      </div>
    </div>
  );
});
