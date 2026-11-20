// Example campaigns with names, shown beside the real ones so the demo has a full garden of
// live, funded and missed campaigns. They are tagged "Example" everywhere and cannot take a
// pledge; every real campaign on the contract is shown as well. Turn off with NEXT_PUBLIC_SHOWCASE=0.
import type { World } from "../../../web/src/app/world.ts";
import type { Label } from "../../../web/src/data/labels.ts";
import type { CampaignView } from "../../../web/src/data/load.ts";

export const SHOWCASE_ON = process.env.NEXT_PUBLIC_SHOWCASE !== "0";
const FIRST = 9001n;
export const isShowcase = (id: bigint) => id >= FIRST && id < FIRST + 100n;

const U = 1_000_000n;
const DAY = 86_400n;
const HOUR = 3_600n;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;

type Spec = {
  title: string;
  by: string;
  sponsorName: string;
  about: string;
  goal: number;
  raised: number; // share of goal, 0..1+
  early: number; // share of what was raised that came early
  backers: number;
  opened: bigint; // seconds before now it opened
  earlyFor: bigint; // length of the early window
  openFor: bigint; // length it takes pledges
  outcome: 0 | 1 | 2; // open, funded, missed
};

const SPECS: Spec[] = [
  // live
  { title: "Builder House, Denver", by: "Front Range builders", sponsorName: "Front Range DAO", about: "Six nights of venue for a 300-person builder meetup.", goal: 40_000, raised: 0.39, early: 1, backers: 78, opened: 2n * DAY, earlyFor: 5n * DAY, openFor: 14n * DAY, outcome: 0 },
  { title: "Audit for the Tidepool vaults", by: "Tidepool core team", sponsorName: "Tidepool Collective", about: "An independent smart-contract audit before mainnet.", goal: 25_000, raised: 0.72, early: 0.64, backers: 133, opened: 9n * DAY, earlyFor: 6n * DAY, openFor: 21n * DAY, outcome: 0 },
  { title: "Lisbon hackathon prize pool", by: "Atlantic Builders Guild", sponsorName: "Atlantic Builders Guild", about: "Prizes for a weekend hackathon on payments.", goal: 15_000, raised: 0.55, early: 1, backers: 64, opened: 1n * DAY, earlyFor: 4n * DAY, openFor: 10n * DAY, outcome: 0 },
  { title: "A community RPC node for a year", by: "Open Relay operators", sponsorName: "Open Relay DAO", about: "One public node, run and monitored for twelve months.", goal: 6_000, raised: 0.84, early: 0.7, backers: 41, opened: 12n * DAY, earlyFor: 5n * DAY, openFor: 20n * DAY, outcome: 0 },
  { title: "Docs in Spanish and Portuguese", by: "Lumen Docs Guild", sponsorName: "Lumen DAO", about: "Translating the developer docs for two more languages.", goal: 4_500, raised: 0.2, early: 1, backers: 17, opened: 6n * HOUR, earlyFor: 3n * DAY, openFor: 9n * DAY, outcome: 0 },
  { title: "Campus demo day", by: "Westside Student Builders", sponsorName: "Westside Builders Fund", about: "Venue, food and travel for a student demo day.", goal: 2_500, raised: 0.48, early: 0.8, backers: 29, opened: 3n * DAY, earlyFor: 4n * DAY, openFor: 12n * DAY, outcome: 0 },
  // settled
  { title: "Zero-knowledge workshop series, Berlin", by: "Proof Club Berlin", sponsorName: "Northern Lights DAO", about: "Four evening workshops on writing ZK circuits.", goal: 8_000, raised: 1, early: 0.65, backers: 52, opened: 30n * DAY, earlyFor: 6n * DAY, openFor: 14n * DAY, outcome: 1 },
  { title: "Bug bounty top-up", by: "Harbor security council", sponsorName: "Harbor DAO", about: "Raising the critical bounty for a quarter.", goal: 20_000, raised: 1, early: 0.58, backers: 96, opened: 45n * DAY, earlyFor: 7n * DAY, openFor: 21n * DAY, outcome: 1 },
  { title: "Public-goods grants match", by: "Commons round stewards", sponsorName: "Commons Fund", about: "A matching pool for twenty small open-source grants.", goal: 12_000, raised: 1, early: 0.71, backers: 140, opened: 60n * DAY, earlyFor: 8n * DAY, openFor: 20n * DAY, outcome: 1 },
  { title: "Solar kit for the co-working space", by: "Ubud makers", sponsorName: "Island Makers DAO", about: "Panels and a battery so the space runs on sun.", goal: 9_500, raised: 1, early: 0.5, backers: 61, opened: 80n * DAY, earlyFor: 10n * DAY, openFor: 25n * DAY, outcome: 1 },
  { title: "A documentary on early DAOs", by: "Long Now Films", sponsorName: "Archive DAO", about: "A short film on the first on-chain organisations.", goal: 30_000, raised: 0.59, early: 0.76, backers: 63, opened: 70n * DAY, earlyFor: 8n * DAY, openFor: 21n * DAY, outcome: 2 },
];

function build(now: bigint): { campaigns: CampaignView[]; labels: Label[] } {
  const campaigns: CampaignView[] = [];
  const labels: Label[] = [];
  SPECS.forEach((s, i) => {
    const id = FIRST + BigInt(i);
    const target = BigInt(s.goal) * U;
    const pledged = s.outcome === 1 ? target : (target * BigInt(Math.round(s.raised * 1000))) / 1000n;
    const early$ = (pledged * BigInt(Math.round(s.early * 1000))) / 1000n;
    const opensAt = now - s.opened;
    const sponsor = addr(0x5000 + i);
    const recipient = addr(0xa000 + i);
    const bonusPool = target / 10n;
    campaigns.push({
      id,
      outcomeNow: s.outcome,
      terms: {
        recipient,
        opensAt,
        earlyUntil: opensAt + s.earlyFor,
        closesAt: opensAt + s.openFor,
        target,
        minPledge: U / 2n,
        matchAmount: target / 4n,
        bonusPool,
        rateBps: 2000,
        linearWeight: true,
        bonusFromRecipient: false,
      },
      state: {
        sponsor,
        outcome: s.outcome,
        matchIn: true,
        bonusIn: true,
        recipientPaid: s.outcome === 1,
        matchReturned: s.outcome === 2,
        bonusReturned: s.outcome !== 0,
        backers: s.backers,
        pledged,
        pledgedEarly: early$,
        weighted: early$ / 2n,
        bonusPaid: s.outcome === 2 ? (bonusPool * 6n) / 10n : 0n,
      },
    });
    labels.push({ id, sponsor, recipient, title: s.title, by: s.by, sponsorName: s.sponsorName, about: s.about, example: true });
  });
  return { campaigns, labels };
}

/** The world as pages see it: the real campaigns plus the examples. */
export function withShowcase(world: World): { world: World; labels: Label[] } {
  if (!SHOWCASE_ON) return { world, labels: [] };
  const { campaigns, labels } = build(world.now);
  return { world: { ...world, campaigns: [...world.campaigns, ...campaigns] }, labels };
}
