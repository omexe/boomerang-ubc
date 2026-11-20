// The pledge address (#/campaign/N/pledge) is kept so links to it still work: it is the campaign
// page with the cursor in the amount field. The pledge logic lives in ui/Cheque.tsx.
import type { Ctx } from "../app/context.ts";
import { Campaign } from "./Campaign.tsx";

export function Pledge({ ctx, id }: { ctx: Ctx; id: bigint }) {
  return <Campaign ctx={ctx} id={id} focus />;
}
