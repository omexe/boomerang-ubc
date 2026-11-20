// The live feed, from the keeper's ledger. The keeper is a convenience: when it cannot be
// reached the feed says so, and no figure anywhere else on the page depends on it.
import { feedLine, type LedgerView } from "../data/keeper.ts";
import { utcStamp } from "../data/time.ts";

export type FeedView =
  | { available: true; lines: { key: string; campaign: bigint; text: string; when: string | null; txHash: `0x${string}` | null }[]; empty: string | null }
  | { available: false; line: string };

export const FEED_DOWN = "The live feed is unavailable right now. Every figure on this page is read from the contract and is not affected.";

/** Newest first. `campaign` keeps one campaign's events; `limit` keeps the newest that many. */
export function feedView(o: { ledger: LedgerView | null; campaign?: bigint; limit?: number }): FeedView {
  if (o.ledger === null) return { available: false, line: FEED_DOWN };
  const wanted = o.ledger.feed.filter((e) => o.campaign === undefined || e.id === o.campaign);
  const lines = wanted
    .slice()
    .sort((a, b) => (a.seq < b.seq ? 1 : a.seq > b.seq ? -1 : 0))
    .slice(0, o.limit ?? 20)
    .map((e) => ({ key: e.seq.toString(), campaign: e.id, text: feedLine(e), when: e.time === null ? null : utcStamp(e.time), txHash: e.txHash }));
  return { available: true, lines, empty: lines.length === 0 ? "Nothing has happened yet." : null };
}
