// Signed pledges that may still land. Once a signature has been handed to the keeper and no
// final answer came back (no answer, "failed", a send not yet confirmed, or "pending": another of
// the backer's signatures on its way), it could still be submitted until its window ends. Until
// then no other pledge to that campaign is sent from this browser, signed or two-step, so a backer
// cannot pledge twice by mistake. Kept in the browser's storage, so a reload or a second tab
// knows too; where storage is blocked, this page's memory stands in. The chain has the last word:
// once the window has passed, USDC says whether the signature was used.
import type { Address } from "../../../packages/kit/src/index.ts";

type Hex = `0x${string}`;
export type Outstanding = { id: bigint; nonce: Hex; until: bigint };
type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

const keyOf = (chainId: number, backer: Address) => `boomerang:signed:${chainId}:${backer.toLowerCase()}`;
const KEEP = 20;

function read(text: string | null): Outstanding[] {
  if (text === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: Outstanding[] = [];
  for (const r of raw) {
    if (r === null || typeof r !== "object") continue;
    const { id, nonce, until } = r as Record<string, unknown>;
    if (typeof id !== "string" || !/^[0-9]{1,78}$/.test(id)) continue;
    if (typeof nonce !== "string" || !/^0x[0-9a-f]{64}$/.test(nonce)) continue;
    if (typeof until !== "string" || !/^[0-9]{1,20}$/.test(until)) continue;
    out.push({ id: BigInt(id), nonce: nonce as Hex, until: BigInt(until) });
  }
  return out;
}

const write = (list: Outstanding[]) => JSON.stringify(list.slice(-KEEP).map((o) => ({ id: o.id.toString(), nonce: o.nonce, until: o.until.toString() })));

export function outstandingStore(storage: Storage | null) {
  // This page's own record, kept beside storage and merged with it, so nothing that happens to
  // storage (a write it refuses, another tab writing an older list back, storage cleared) hides a
  // signature this page sent: the page keeps it until it drops it itself. And the nonces this page
  // dropped, so a drop that storage refused still counts here.
  const memory = new Map<string, Outstanding[]>();
  const dropped = new Set<string>();
  const list = (chainId: number, backer: Address): Outstanding[] => {
    const key = keyOf(chainId, backer);
    let stored: Outstanding[] = [];
    if (storage !== null) {
      try {
        stored = read(storage.getItem(key));
      } catch {
        // blocked: this page's memory alone
      }
    }
    const merged = new Map<string, Outstanding>();
    for (const o of [...stored, ...(memory.get(key) ?? [])]) if (!dropped.has(o.nonce)) merged.set(o.nonce, o);
    return [...merged.values()];
  };
  const put = (chainId: number, backer: Address, next: Outstanding[]) => {
    const key = keyOf(chainId, backer);
    memory.set(key, next.slice(-KEEP));
    if (storage === null) return;
    try {
      storage.setItem(key, write(next));
    } catch {
      // blocked: kept in memory only
    }
  };
  return {
    list,
    add(chainId: number, backer: Address, o: Outstanding) {
      const nonce = o.nonce.toLowerCase() as Hex;
      dropped.delete(nonce);
      put(chainId, backer, [...list(chainId, backer).filter((x) => x.nonce !== nonce), { ...o, nonce }]);
    },
    drop(chainId: number, backer: Address, nonce: Hex) {
      const n = nonce.toLowerCase() as Hex;
      dropped.add(n);
      put(chainId, backer, list(chainId, backer).filter((x) => x.nonce !== n));
    },
  };
}

/**
 * For a pledge to campaign `id` at chain time `now`: `left`, the seconds until the last remembered
 * signature for it leaves its window (null when none is in it), and those already past their
 * window, which are to be checked against USDC and dropped.
 */
export function signedWait(list: readonly Outstanding[], id: bigint, now: bigint): { left: bigint | null; expired: Outstanding[] } {
  const mine = list.filter((o) => o.id === id);
  const open = mine.filter((o) => now <= o.until);
  const left = open.length === 0 ? null : open.reduce((m, o) => (o.until - now + 1n > m ? o.until - now + 1n : m), 0n);
  return { left, expired: mine.filter((o) => now > o.until) };
}
