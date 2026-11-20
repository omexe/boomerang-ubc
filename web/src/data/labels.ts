// What a campaign is called. The contract holds amounts, dates and addresses and nothing else, so
// a campaign's name and its few lines of description live in a labels file that ships with this
// site. A label is the site's word, not the chain's: it is shown only when its campaign id, its
// sponsor and its recipient all match what the contract says, so a label can never be shown over
// a different campaign, and the page says which parts are the site's and which the contract's.
import type { Address, State, Terms } from "../../../packages/kit/src/index.ts";
import { short } from "./keeper.ts";

export type Label = {
  id: bigint;
  sponsor: Address;
  recipient: Address;
  /** One sentence: what the money is for. */
  title: string;
  /** Who is raising it. */
  by: string;
  /** Who locked the match and the bonus. */
  sponsorName: string;
  /** A few more lines, optional. */
  about: string;
  /** True for a campaign made to show the app working, with invented people. */
  example: boolean;
};

export type Named = { title: string; by: string; sponsorName: string; about: string; example: boolean; labelled: boolean };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// Bidi controls and zero-width characters, removed; C0/C1 control characters and DEL, turned to a space.
const STRIP = /[\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{200b}-\u{200d}\u{feff}]/gu;
const CONTROL = /[\u{0}-\u{1f}\u{7f}-\u{9f}]/gu;
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(STRIP, "").replace(CONTROL, " ").trim().slice(0, max) : "");

/** Read a labels file. Entries that are not well formed are left out, never guessed at. */
export function readLabels(json: unknown): Label[] {
  if (!Array.isArray(json)) return [];
  const out: Label[] = [];
  for (const raw of json) {
    if (raw === null || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || !/^[1-9][0-9]{0,17}$/.test(r.id)) continue;
    if (typeof r.sponsor !== "string" || !ADDRESS.test(r.sponsor)) continue;
    if (typeof r.recipient !== "string" || !ADDRESS.test(r.recipient)) continue;
    const title = text(r.title, 120);
    if (title === "") continue;
    out.push({
      id: BigInt(r.id),
      sponsor: r.sponsor as Address,
      recipient: r.recipient as Address,
      title,
      by: text(r.by, 80),
      sponsorName: text(r.sponsorName, 80),
      about: text(r.about, 600),
      example: r.example === true,
    });
  }
  return out;
}

/**
 * What to call a campaign. A label is used only if the contract agrees with it on the sponsor
 * and the recipient. A campaign the desk opened is named as such. Anything else is named by
 * its number and its addresses.
 */
export function nameOf(labels: readonly Label[], c: { id: bigint; terms: Terms; state: State }, desk?: Address | null): Named {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const label = labels.find((l) => l.id === c.id && same(l.sponsor, c.state.sponsor) && same(l.recipient, c.terms.recipient));
  if (label) {
    return {
      title: label.title,
      by: label.by || `Paid to ${short(c.terms.recipient)}`,
      sponsorName: label.sponsorName || short(c.state.sponsor),
      about: label.about,
      example: label.example,
      labelled: true,
    };
  }
  if (desk && same(desk, c.state.sponsor)) {
    // The desk opens two kinds, told apart by how long the contract holds the campaign open.
    const quick = c.terms.closesAt - c.terms.opensAt < 300n;
    return {
      title: `${quick ? "Two-minute" : "Ten-minute"} campaign ${c.id}`,
      by: "Opened by this site's desk",
      sponsorName: "The desk",
      about: `A small campaign that takes pledges for at most ${quick ? "two" : "ten"} minutes and settles within a minute after, so you can watch every step.`,
      example: true,
      labelled: false,
    };
  }
  return { title: `Campaign ${c.id}`, by: `Paid to ${short(c.terms.recipient)}`, sponsorName: short(c.state.sponsor), about: "", example: false, labelled: false };
}
