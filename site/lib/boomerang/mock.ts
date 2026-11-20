// A made-up chain for checking layouts without a network (NEXT_PUBLIC_MOCK=1 only). Every
// screen still runs the shared views on it; nothing here is used when the flag is off.
import type { World } from "../../../web/src/app/world.ts";
import type { CampaignView } from "../../../web/src/data/load.ts";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const U = 1_000_000n;

function campaign(id: bigint, now: bigint, o: { open: bigint; early: bigint; close: bigint; target: bigint; pledged: bigint; early$: bigint; backers: number; outcome: number }): CampaignView {
  return {
    id,
    outcomeNow: o.outcome,
    terms: {
      recipient: A(0xbeef + Number(id)),
      opensAt: now + o.open,
      earlyUntil: now + o.early,
      closesAt: now + o.close,
      target: o.target,
      minPledge: U / 2n,
      matchAmount: o.target / 4n,
      bonusPool: o.target / 10n,
      rateBps: 500,
      linearWeight: true,
      bonusFromRecipient: false,
    },
    state: {
      sponsor: A(0x5150),
      outcome: o.outcome,
      matchIn: true,
      bonusIn: true,
      recipientPaid: o.outcome === 1,
      matchReturned: o.outcome === 2,
      bonusReturned: o.outcome !== 0,
      backers: o.backers,
      pledged: o.pledged,
      pledgedEarly: o.early$,
      weighted: o.early$,
      bonusPaid: o.outcome === 2 ? o.early$ / 20n : 0n,
    },
  };
}

export const MOCK_ACCOUNT = "0x45b7000000000000000000000000000000ef8c" as `0x${string}`;

export function mockWorld(now: bigint, account: `0x${string}` | null = null): World {
  const campaigns = [
    campaign(14n, now, { open: -300n, early: 900n, close: 3600n, target: 40_000n * U, pledged: 15_600n * U, early$: 15_600n * U, backers: 78, outcome: 0 }),
    campaign(13n, now, { open: -3000n, early: -1200n, close: 1800n, target: 12_000n * U, pledged: 9_400n * U, early$: 6_100n * U, backers: 41, outcome: 0 }),
    campaign(12n, now, { open: -90_000n, early: -80_000n, close: -3600n, target: 8_000n * U, pledged: 8_000n * U, early$: 5_200n * U, backers: 52, outcome: 1 }),
    campaign(11n, now, { open: -190_000n, early: -180_000n, close: -86_000n, target: 20_000n * U, pledged: 11_800n * U, early$: 9_000n * U, backers: 63, outcome: 2 }),
  ];
  return {
    block: 72_900_000n,
    now,
    count: 14n,
    campaigns,
    extra: null,
    custody: { block: 72_900_000n, time: now, held: 0n, owed: 0n, events: 0n, ok: true },
    account,
    mine: account
      ? [
          { campaign: campaigns[0], backer: { principal: 2n * U, weighted: U, payTo: account, paid: false }, owed: { principal: 0n, bonus: 0n }, ifMissed: { principal: 2n * U, bonus: U / 10n } },
          { campaign: campaigns[2], backer: { principal: 1n * U, weighted: U / 2n, payTo: account, paid: false }, owed: { principal: 0n, bonus: 0n }, ifMissed: { principal: 0n, bonus: 0n } },
          { campaign: campaigns[3], backer: { principal: 3n * U / 2n, weighted: U, payTo: account, paid: false }, owed: { principal: 3n * U / 2n, bonus: U / 20n }, ifMissed: { principal: 0n, bonus: 0n } },
        ]
      : [],
    balance: account ? 1_800_000n : null,
    allowance: account ? 0n : null,
    keeper: { up: false, why: "none" },
    backerChecks: null,
    backerTotal: 0,
    lookup: null,
    shownBackers: null,
  };
}
