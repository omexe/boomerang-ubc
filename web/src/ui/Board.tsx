// The campaign's figures strip: the board's plates (to go, the clocks, backers), laid on the paper
// and parted by hairlines, each a caption above a large figure. A changed total is announced once
// to screen readers, never on load. The outcome is a separate rubber stamp, shown in the voucher
// once a campaign is settled.
import { useState } from "react";

import type { CampaignView } from "../data/load.ts";
import { formatUsd } from "../data/money.ts";
import { boardView, type BoardResult } from "../views/board.ts";
import { Plate } from "./Plate.tsx";

export function Band({ campaign, now }: { campaign: CampaignView; now: bigint }) {
  const b = boardView({ campaign, now });
  const total = campaign.state.pledged;
  const [seen, setSeen] = useState(total);
  const [said, setSaid] = useState("");
  if (seen !== total) {
    setSeen(total);
    setSaid(`${formatUsd(total)} of ${formatUsd(campaign.terms.target)} USDC pledged.`);
  }
  return (
    <>
      <div className="figs">
        {b.plates.map((p) => (
          <Plate plate={p} key={p.key} />
        ))}
      </div>
      <p className="sr-only" role="status" aria-atomic="true">
        {said}
      </p>
    </>
  );
}

/** The outcome as a rubber stamp: ink for cleared, vermilion for returned, ink-soft for never opened. */
export function OutcomeStamp({ result }: { result: BoardResult }) {
  return (
    <span className={`stamp stamp-${result.kind}`} role="img" aria-label={`Outcome: ${result.flag}`}>
      {result.flag}
    </span>
  );
}
