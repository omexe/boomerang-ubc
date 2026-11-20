// Every amount and account in these tests is invented. None is a reading of any real campaign.
import assert from "node:assert/strict";

import { network } from "hardhat";
import { decodeErrorResult, type Abi } from "viem";

let boomerangAbi: Abi = [];

export const USD = 1_000_000n; // one test dollar in USDC's smallest unit
export const ONE = 1_000_000n; // full weight
export const Outcome = { Open: 0, Funded: 1, Missed: 2, Void: 3 } as const;
export const Side = { Recipient: 0, MatchReturn: 1, BonusReturn: 2 } as const;

export type Terms = {
  recipient: `0x${string}`;
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

/** A fresh chain with the token, the contract and named accounts. `token` picks the test token. */
export async function setup(token: "TestUSDC" | "OddToken" = "TestUSDC") {
  const { viem, networkHelpers } = await network.create();
  const time = networkHelpers.time;
  const [sponsor, recipient, alice, bob, carol, dave, erin, stranger] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  // OddToken has every function of TestUSDC that this file calls, so it is typed as one
  const usdc = await viem.deployContract(token as "TestUSDC");
  const boomerang = await viem.deployContract("Boomerang", [usdc.address]);
  boomerangAbi = boomerang.abi as Abi;
  type Wallet = typeof sponsor;

  /** Give an account test dollars and let the contract pull them. */
  async function fund(who: Wallet, amount: bigint) {
    await usdc.write.mint([who.account.address, amount]);
    await usdc.write.approve([boomerang.address, amount], { account: who.account });
  }

  /** Terms with defaults: target 100, minimum 1, match 20, bonus 10, rate 5%, flat weight. */
  async function terms(over: Partial<Terms> = {}): Promise<Terms> {
    const now = BigInt(await time.latest());
    const opensAt = over.opensAt ?? now + 1_000n;
    const earlyUntil = over.earlyUntil ?? opensAt + 100_000n;
    const closesAt = over.closesAt ?? earlyUntil + 100_000n;
    return {
      recipient: recipient.account.address,
      target: 100n * USD,
      minPledge: 1n * USD,
      matchAmount: 20n * USD,
      bonusPool: 10n * USD,
      rateBps: 500,
      linearWeight: false,
      bonusFromRecipient: false,
      ...over,
      opensAt,
      earlyUntil,
      closesAt,
    };
  }

  /** Create a campaign and put both pots in. Returns its id and terms. Time is left before opening. */
  async function open(over: Partial<Terms> = {}, opts: { skipMatch?: boolean; skipBonus?: boolean } = {}) {
    const t = await terms(over);
    await boomerang.write.createCampaign([t], { account: sponsor.account });
    const id = await boomerang.read.campaignCount();
    if (t.matchAmount > 0n && !opts.skipMatch) {
      await fund(sponsor, t.matchAmount);
      await boomerang.write.fundMatch([id], { account: sponsor.account });
    }
    if (t.bonusPool > 0n && !opts.skipBonus) {
      const funder = t.bonusFromRecipient ? recipient : sponsor;
      await fund(funder, t.bonusPool);
      await boomerang.write.fundBonus([id], { account: funder.account });
    }
    return { id, t };
  }

  /** Pledge so that the transaction lands at exactly `at` (a block timestamp), when given. */
  async function pledge(id: bigint, who: Wallet, amount: bigint, at?: bigint) {
    await fund(who, amount);
    if (at !== undefined) await time.setNextBlockTimestamp(at);
    return boomerang.write.pledge([id, amount], { account: who.account });
  }

  const balance = (who: Wallet | { address: `0x${string}` }) =>
    usdc.read.balanceOf(["account" in who ? who.account.address : who.address]);

  /** The custody rule: the contract never holds less than it owes. */
  async function assertCustody() {
    const holds = await usdc.read.balanceOf([boomerang.address]);
    const owes = await boomerang.read.totalOwed();
    assert.ok(holds >= owes, `holds ${holds} but owes ${owes}`);
    return { holds, owes };
  }

  return {
    viem, time, publicClient, usdc, boomerang,
    sponsor, recipient, alice, bob, carol, dave, erin, stranger,
    fund, terms, open, pledge, balance, assertCustody,
  };
}

/** The contract error a failed call carried: its name and arguments, or what else was found. */
function revertOf(e: unknown): { name?: string; args?: readonly unknown[]; other: string } {
  let cur = e as { cause?: unknown; data?: unknown; message?: string; shortMessage?: string } | undefined;
  let raw: `0x${string}` | undefined;
  let other = "";
  for (let depth = 0; cur && depth < 12; depth++) {
    const data = cur.data as { errorName?: string; args?: readonly unknown[] } | string | undefined;
    if (data && typeof data === "object" && typeof data.errorName === "string") {
      return { name: data.errorName, args: data.args, other };
    }
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) raw ??= data as `0x${string}`;
    other ||= cur.shortMessage ?? "";
    cur = cur.cause as typeof cur;
  }
  if (raw) {
    try {
      const decoded = decodeErrorResult({ abi: boomerangAbi, data: raw });
      return { name: decoded.errorName, args: decoded.args as readonly unknown[] | undefined, other };
    } catch {
      other ||= raw;
    }
  }
  return { other: other || String((e as Error)?.message ?? e).slice(0, 200) };
}

/**
 * A call must fail with exactly the named contract error (and, when given, that first argument).
 * The name is read from the decoded revert, never searched for in the error's text.
 */
export async function refused(call: Promise<unknown>, error: string, firstArg?: unknown) {
  let failure: unknown;
  try {
    await call;
  } catch (e) {
    failure = e;
  }
  assert.ok(failure !== undefined, `expected ${error}, but the call went through`);
  const got = revertOf(failure);
  assert.equal(got.name, error, `expected ${error}, got ${got.name ?? "no contract error"} (${got.other})`);
  if (firstArg !== undefined) assert.deepEqual(got.args?.[0], firstArg);
}
