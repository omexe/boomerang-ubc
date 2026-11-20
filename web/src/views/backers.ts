// Who backed a campaign, shown on the campaign's page. The contract keeps no list of its backers,
// so the addresses come from the keeper's ledger; every figure beside them is the contract's own,
// read at one block. The table ends in the contract's own total, which the rows above are checked
// against: when they do not add up, the note says so and the contract's figures are the true ones.
import { hrefFor } from "../app/route.ts";
import type { World } from "../app/world.ts";
import { standingOf } from "../data/campaign.ts";
import { short } from "../data/keeper.ts";
import type { CampaignView } from "../data/load.ts";
import { about, formatUsd } from "../data/money.ts";

export type BackersRow = { key: string; href: string | null; account: string; pledged: string; when: string; back: string; kind: "counted" | "given" | "owed" | "returned" | "sponsor" };
export type BackersTable = {
  title: string; // "Backers"
  head: readonly [string, string, string, string]; // "Account", "Pledged", "When", "Comes back"
  state: "none" | "down" | "waiting" | "listed";
  rows: BackersRow[];
  /** The contract's own total; null unless state is "listed". */
  total: { label: string; pledged: string } | null;
  note: string | null;
};

const HEAD = ["Account", "Pledged", "When", "Comes back"] as const;

export function backersTable(o: { campaign: CampaignView; shown: World["shownBackers"]; keeperUp: boolean; block: bigint }): BackersTable {
  const { campaign, shown, keeperUp, block } = o;
  const n = Number(campaign.state.backers);
  const pledged = campaign.state.pledged;
  const count = n === 1 ? "1 backer" : `${n} backers`;
  const base = { title: "Backers", head: HEAD } as const;

  if (n === 0 && pledged === 0n) {
    return { ...base, state: "none", rows: [], total: null, note: "Nobody has pledged yet." };
  }
  if (!keeperUp) {
    return {
      ...base,
      state: "down",
      rows: [],
      total: null,
      note: `The contract keeps no list of its backers, so the list comes from the keeper, which is not answering. The contract counts ${count} and ${formatUsd(pledged)} USDC pledged.`,
    };
  }
  const waiting: BackersTable = {
    ...base,
    state: "waiting",
    rows: [],
    total: null,
    note: `The keeper has not listed this campaign's backers yet. The contract counts ${count} and ${formatUsd(pledged)} USDC pledged.`,
  };
  // The list this page asked for has not come back yet (a first look, or one for the campaign shown before).
  if (shown === null || shown.id !== campaign.id) {
    return { ...waiting, note: `Reading this campaign's backers. The contract counts ${count} and ${formatUsd(pledged)} USDC pledged.` };
  }

  // One row per address the keeper lists that the contract has a pledge for, in the order given.
  const rows: BackersRow[] = [];
  const seen = new Set<string>();
  let sum = 0n;
  for (const r of shown.rows) {
    if (r.backer.principal <= 0n) continue; // an address the contract has no pledge for is left out
    // The contract has one record per address, so an address the keeper lists twice (in any case) is one row.
    if (seen.has(r.address.toLowerCase())) continue;
    seen.add(r.address.toLowerCase());
    const standing = standingOf(campaign.terms, campaign.state, r.backer, null, true);
    if (standing.kind === "none") continue; // principal > 0 means this never happens; keeps the type honest
    let back: string;
    switch (standing.kind) {
      case "counted":
        back = r.ifMissed.bonus > 0n ? `${formatUsd(r.ifMissed.principal)} plus ${about(r.ifMissed.bonus)} if it misses` : `${formatUsd(r.ifMissed.principal)} if it misses`;
        break;
      case "given":
        back = "Nothing. The campaign cleared.";
        break;
      case "owed":
        back = `${formatUsd(r.owed.principal + r.owed.bonus)} owed`; // the row's own owed, the contract's answer
        break;
      case "returned":
        back = `${formatUsd(standing.principal + standing.bonus)} came back`;
        break;
    }
    rows.push({
      key: r.address.toLowerCase(),
      href: hrefFor({ page: "mine", who: r.address }),
      account: short(r.address),
      pledged: formatUsd(r.backer.principal),
      when: r.backer.weighted > 0n ? "Early" : "Late",
      back,
      kind: standing.kind,
    });
    sum += r.backer.principal;
  }

  // The keeper listed nobody the contract has a pledge from: there is no table, so nothing speaks of rows.
  if (rows.length === 0) return waiting;

  const listed = rows.length; // backer rows only; a sponsor row is not one of the contract's backers
  const complete = listed === n && shown.listed <= shown.rows.length;
  if (complete && sum < pledged) {
    // Every backer is listed, so the rest of the pledged total is what the sponsor paid to close the gap.
    rows.push({ key: "sponsor", href: null, account: "The sponsor, closing the gap", pledged: formatUsd(pledged - sum), when: "", back: "Nothing. The campaign cleared.", kind: "sponsor" });
  }

  const total = { label: `${count}, by the contract at block ${block}`, pledged: `${formatUsd(pledged)} USDC` };
  let note: string | null;
  if (shown.listed > shown.rows.length) {
    note = `The keeper lists ${shown.listed} backers; the first ${shown.rows.length} were read.`;
  } else if (!complete || sum > pledged) {
    note = `The keeper lists ${listed} of the contract's ${count}, and the rows above add up to ${formatUsd(sum)} of the ${formatUsd(pledged)} USDC pledged. The contract's figures are the true ones.`;
  } else {
    note = null;
  }

  return { ...base, state: "listed", rows, total, note };
}
