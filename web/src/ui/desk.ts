// The desk's offer of a short campaign (two minutes, or ten), shared by the blank cheque and the
// landing page's closing buttons: one press asks the keeper, says what it answered, and goes to
// the new campaign.
import { useState } from "react";

import type { Ctx } from "../app/context.ts";
import type { DeskKind } from "../data/ask.ts";
import { hrefFor } from "../app/route.ts";

export type DeskState = { busy: boolean; line: string | null; ok: boolean; open(kind: DeskKind): void };

export function useDesk(ctx: Ctx): DeskState {
  const [state, setState] = useState<{ busy: boolean; line: string | null; ok: boolean }>({ busy: false, line: null, ok: false });
  const open = (kind: DeskKind) => {
    if (state.busy) return;
    setState({ busy: true, line: null, ok: false });
    void ctx.askForCampaign(kind).then((answer) => {
      setState({ busy: false, line: answer.line, ok: answer.ok });
      if (answer.ok && answer.id !== null) ctx.expect(answer.id);
      ctx.refresh();
      if (answer.ok && answer.id !== null) window.location.hash = hrefFor({ page: "campaign", id: answer.id });
    });
  };
  return { ...state, open };
}
