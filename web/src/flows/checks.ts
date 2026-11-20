// The keyless checks, run in the visitor's own browser against the chain. Five of the six the
// command line runs can run here: the code and no-owner rows from the kit's fingerprint, custody
// and the event-rebuilt ledger from the contract's own reads, and the explorer's own word on the
// verified source. The ledger row asks the explorer, where there is one, which blocks hold the
// contract's logs, reads those logs from the node, and counts the read whole only when the
// contract's own count of its events says so; with no explorer, or one that cannot be read, it
// reads every block. The sixth (that this repository's code created the contract) needs the compiled
// creation code, which a browser does not hold; the commands on the page run it.
//
// This module imports the ledger and the check functions, so the page loads it on its own with a
// dynamic import only when the button is pressed, keeping all of that out of the first load. It
// never throws: each check that cannot be completed is its own row with ok:false and the reason.
import type { Abi, Address, PublicClient } from "viem";

import { BOOMERANG_FINGERPRINT, boomerangAbi } from "../../../packages/kit/src/index.ts";
import { custodyCheck, explorerBlocks, fingerprintCheck, ledgerCheck, noOwnerByFingerprint } from "../../../scripts/lib/check.ts";

export type CheckId = "code" | "no-owner" | "custody" | "ledger" | "explorer";
export type CheckResult = { id: CheckId; ok: boolean; detail: string };

const abi = boomerangAbi as unknown as Abi;

/** A reason cut to 200 characters, so one failing check's error never floods the page. Whatever was thrown, this gives a sentence and does not throw. */
function reason(e: unknown): string {
  let msg = "";
  try {
    const err = e as { shortMessage?: unknown; message?: unknown } | null | undefined;
    msg = typeof err?.shortMessage === "string" ? err.shortMessage : typeof err?.message === "string" ? err.message : String(e);
  } catch {
    // something that cannot even be written out
  }
  return msg.split("\n")[0].slice(0, 200) || "the check could not be completed";
}

// The explorer's own word: 200 and both verified flags true passes. Only a short, plain compiler
// version is ever echoed from the answer; nothing else of the body is shown.
async function explorerCheck(
  explorer: string,
  boomerang: Address,
  fetch: (url: string) => Promise<{ status: number; json(): Promise<unknown> }>,
): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(`${explorer}/api/v2/smart-contracts/${boomerang}`);
  if (res.status !== 200) return { ok: false, detail: `the explorer answered with status ${res.status}` };
  // What the explorer sent is never shown, not even inside an error about it.
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, detail: "the explorer's answer was not something this check could read" };
  }
  const b = body as Record<string, unknown>;
  if (b.is_verified !== true || b.is_fully_verified !== true) {
    return { ok: false, detail: "the explorer does not report fully verified source code for the contract" };
  }
  const cv = b.compiler_version;
  const compiler = typeof cv === "string" && /^[\w.+-]{1,40}$/.test(cv) ? ` Compiler ${cv}.` : "";
  return { ok: true, detail: `the explorer reports fully verified source code for the contract.${compiler}` };
}

export async function runChecks(o: {
  client: PublicClient;
  boomerang: Address;
  usdc: Address;
  fromBlock: bigint;
  /** The explorer's base URL; null where there is none (the explorer row is then left out). */
  explorer: string | null;
  fetch: (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;
  onProgress?: (p: { id: CheckId; done: number; of: number }) => void;
  chunk?: bigint; // default 10_000n blocks per log request
  /** How long the explorer is given to answer before its row fails; 15 seconds unless set. */
  explorerWaitMs?: number;
  /** The pause between two log requests, for a public node that takes only a few a second; none unless set. */
  gapMs?: number;
  /** Stands in for the clock in tests. */
  wait?: (ms: number) => Promise<void>;
}): Promise<CheckResult[]> {
  const chunk = o.chunk ?? 10_000n;
  const explorerWaitMs = o.explorerWaitMs ?? 15_000;
  const results: CheckResult[] = [];

  const guard = async (id: CheckId, run: () => Promise<{ ok: boolean; detail: string }>): Promise<CheckResult> => {
    try {
      const r = await run();
      // A check's own sentence is shown whole up to 400 characters (the longest, the code row with
      // its hash, is under 300); an error's reason is cut shorter, below.
      return { id, ok: r.ok, detail: r.detail.slice(0, 400) };
    } catch (e) {
      return { id, ok: false, detail: reason(e) };
    }
  };

  // The runtime code is read once and serves the code and no-owner rows.
  let onChain: `0x${string}` | undefined;
  let codeError: string | null = null;
  try {
    onChain = await o.client.getCode({ address: o.boomerang });
  } catch (e) {
    codeError = reason(e);
  }
  results.push(
    codeError !== null
      ? { id: "code", ok: false, detail: codeError }
      : await guard("code", async () => fingerprintCheck(onChain, o.usdc, BOOMERANG_FINGERPRINT)),
  );
  results.push(
    codeError !== null
      ? { id: "no-owner", ok: false, detail: codeError }
      : await guard("no-owner", async () => noOwnerByFingerprint(onChain, boomerangAbi, BOOMERANG_FINGERPRINT)),
  );

  // One block number for the custody snapshot and the ledger's upper bound, read once.
  let blockNumber: bigint | null = null;
  let blockError: string | null = null;
  try {
    blockNumber = await o.client.getBlockNumber();
  } catch (e) {
    blockError = reason(e);
  }
  if (blockNumber === null) {
    results.push({ id: "custody", ok: false, detail: blockError ?? "the block number could not be read" });
    results.push({ id: "ledger", ok: false, detail: blockError ?? "the block number could not be read" });
  } else {
    const at = blockNumber;
    results.push(
      await guard("custody", async () => {
        const r = await custodyCheck(o.client, o.boomerang, o.usdc, abi, at);
        // The check prints the token's own units, as the command line does; the page says which.
        return { ok: r.ok, detail: `${r.detail} (amounts in millionths of a USDC)` };
      }),
    );
    results.push(
      await guard("ledger", () => {
        // The explorer only says where to look, and is given the same limit as its own row; late,
        // unreadable or absent, the row reads every block.
        const explorer = o.explorer;
        const hints =
          explorer === null
            ? undefined
            : {
                from: "Arc's explorer",
                blocks: () => {
                  let timer: ReturnType<typeof setTimeout> | undefined;
                  const late = new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error("the explorer did not answer in time")), explorerWaitMs);
                  });
                  return Promise.race([explorerBlocks(explorer, o.boomerang, o.fetch), late]).finally(() => clearTimeout(timer));
                },
              };
        return ledgerCheck(o.client, o.boomerang, abi, o.fromBlock, at, chunk, (done, of) => o.onProgress?.({ id: "ledger", done, of }), {
          hints,
          gapMs: o.gapMs,
          wait: o.wait,
        });
      }),
    );
  }

  // The explorer row runs only where there is an explorer to ask.
  if (o.explorer !== null) {
    const explorer = o.explorer;
    // The chain's reads time out on their own; the explorer is given its own limit here, so one
    // answer that never comes cannot keep the others from being shown.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<{ ok: boolean; detail: string }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, detail: "the explorer did not answer in time" }), explorerWaitMs);
    });
    results.push(await guard("explorer", () => Promise.race([explorerCheck(explorer, o.boomerang, o.fetch), late])));
    clearTimeout(timer);
  }

  return results;
}
