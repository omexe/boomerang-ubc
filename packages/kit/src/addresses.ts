// The deployed addresses per chain, read from the sibling addresses.json. A chain whose
// boomerang/router are still null is "not deployed yet" and asking for it throws.
import type { Address } from "./types.ts";

import addresses from "../addresses.json" with { type: "json" };

/**
 * `desk` is the demo desk's own address, when one runs for this deployment; the page names the desk's campaigns by it.
 * `signedPledge` is the one-signature pledge helper, when deployed; without it the page offers only the two-step pledge.
 * `deployBlock` is the block the Boomerang contract was created in, when the deploy script recorded it: its events start there.
 */
export type Addresses = { boomerang: Address; router: Address; usdc: Address; transmitter: Address; messenger: Address; desk: Address | null; signedPledge: Address | null; deployBlock: bigint | null };

type Entry = { boomerang: string | null; router: string | null; usdc: string; transmitter: string; messenger: string; desk?: string | null; signedPledge?: string | null; deployBlock?: string | number | null };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function addressesFor(chainId: number): Addresses {
  const entry = (addresses as Record<string, Entry>)[String(chainId)];
  if (!entry || entry.boomerang === null || entry.router === null) {
    throw new Error(`Boomerang is not deployed on chain ${chainId} yet`);
  }
  return {
    boomerang: entry.boomerang as Address,
    router: entry.router as Address,
    usdc: entry.usdc as Address,
    transmitter: entry.transmitter as Address,
    messenger: entry.messenger as Address,
    desk: typeof entry.desk === "string" && ADDRESS.test(entry.desk) ? (entry.desk as Address) : null,
    signedPledge: typeof entry.signedPledge === "string" && ADDRESS.test(entry.signedPledge) ? (entry.signedPledge as Address) : null,
    deployBlock:
      typeof entry.deployBlock === "string" && /^[0-9]{1,15}$/.test(entry.deployBlock)
        ? BigInt(entry.deployBlock)
        : typeof entry.deployBlock === "number" && Number.isSafeInteger(entry.deployBlock) && entry.deployBlock >= 0
          ? BigInt(entry.deployBlock)
          : null,
  };
}
