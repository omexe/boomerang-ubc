// Addresses the desk will not send USDC to again: it sent, it had sent before, or it sent
// something it could not confirm. The desk gives once per address, so offering it to these would
// only earn a refusal. Kept in the browser's storage per chain, so a reload knows too; where
// storage is blocked, or the caller hands none (the app does on a local chain, which starts again
// from nothing at each run), this page's memory stands in. Forgetting one costs a refused request
// and nothing else: the desk keeps its own record and has the last word.
import type { Address } from "../../../packages/kit/src/index.ts";

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

const keyOf = (chainId: number) => `boomerang:desk-given:${chainId}`;
const KEEP = 50;

function read(text: string | null): string[] {
  if (text === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is string => typeof r === "string" && /^0x[0-9a-f]{40}$/.test(r));
}

export function givenStore(storage: Storage | null, chainId: number) {
  const key = keyOf(chainId);
  const memory = new Set<string>(); // what this page was told, whatever happens to storage
  const stored = (): string[] => {
    if (storage === null) return [];
    try {
      return read(storage.getItem(key));
    } catch {
      return []; // blocked: this page's memory alone
    }
  };
  return {
    has(address: Address): boolean {
      const a = address.toLowerCase();
      return memory.has(a) || stored().includes(a);
    },
    add(address: Address): void {
      const a = address.toLowerCase();
      memory.add(a);
      if (storage === null) return;
      try {
        storage.setItem(key, JSON.stringify([...stored().filter((s) => s !== a), a].slice(-KEEP)));
      } catch {
        // blocked: kept in memory only
      }
    },
  };
}
