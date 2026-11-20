// The offer of a practice wallet, wherever a page would otherwise only say "connect a wallet".
// It draws nothing when a wallet is connected or the offer cannot be made.
import type { Ctx } from "../app/context.ts";
import { practiceOffer } from "../views/practice.ts";

export function Practice({ ctx }: { ctx: Ctx }) {
  const offer = practiceOffer({ account: ctx.account, offered: ctx.practice !== null, busy: ctx.practiceBusy });
  if (offer === null || ctx.practice === null) return null;
  return (
    <div className="practice">
      <button type="button" className="btn btn-line" disabled={offer.busy} onClick={ctx.practice}>
        {offer.button}
      </button>
      <p className="quiet">{offer.note}</p>
    </div>
  );
}
