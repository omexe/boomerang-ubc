// The shapes the contract hands back, mirrored field for field from Boomerang.sol.
//
// uint64/uint128 are bigint; uint16 (rateBps), uint32 (backers) and the uint8 enums
// (outcome, side) are number, because that is what viem returns for those widths.

export type Address = `0x${string}`;

// Mirrors Boomerang.Terms, in declaration order.
export type Terms = {
  recipient: Address;
  opensAt: bigint;
  earlyUntil: bigint;
  closesAt: bigint;
  target: bigint;
  minPledge: bigint;
  matchAmount: bigint;
  bonusPool: bigint;
  rateBps: number;
  linearWeight: boolean;
  bonusFromRecipient: boolean;
};

// Mirrors Boomerang.State, in declaration order.
export type State = {
  sponsor: Address;
  outcome: number;
  matchIn: boolean;
  bonusIn: boolean;
  recipientPaid: boolean;
  matchReturned: boolean;
  bonusReturned: boolean;
  backers: number;
  pledged: bigint;
  pledgedEarly: bigint;
  weighted: bigint;
  bonusPaid: bigint;
};

// Mirrors Boomerang.Backer, in declaration order.
export type Backer = {
  principal: bigint;
  weighted: bigint;
  payTo: Address;
  paid: boolean;
};

// The Outcome enum: its four values in the contract's order.
export const Outcome = { Open: 0, Funded: 1, Missed: 2, Void: 3 } as const;

// The Side enum: its three values in the contract's order.
export const Side = { Recipient: 0, MatchReturn: 1, BonusReturn: 2 } as const;

// The name of an outcome value, for readable output. Out-of-range values are not expected.
export function outcomeName(n: number): "Open" | "Funded" | "Missed" | "Void" {
  switch (n) {
    case Outcome.Open:
      return "Open";
    case Outcome.Funded:
      return "Funded";
    case Outcome.Missed:
      return "Missed";
    case Outcome.Void:
      return "Void";
    default:
      throw new Error(`unknown outcome ${n}`);
  }
}
