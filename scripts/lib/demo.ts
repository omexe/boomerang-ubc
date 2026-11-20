// Make labelled demo campaigns on a deployed Boomerang, one of each outcome, so the app has
// every state to show: a funded campaign, a missed one, a funded-by-rescue one, a void one, and
// one left open. Amounts are small on purpose: Circle's faucet gives 20 test USDC per address
// every two hours, and all five campaigns together take under 10 from the sponsor.
//
// Backers are throwaway accounts made in memory; their keys are never printed and never written.
// So that their money is not lost with the keys, the missed campaign's backers are paid out by
// this script, the open campaign's backer points its payout at the sponsor, and at the end (also
// after a failure) each backer sends what it has left back to the sponsor.
//
// `wait` is real waiting on a live chain and time travel in tests, so the one function serves both.
import { createWalletClient, custom } from "viem";
import type { Abi, Account, Address, PublicClient, WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { boomerangAbi } from "../../packages/kit/src/abi.ts";
import { decodeLogs } from "../../packages/kit/src/events.ts";
import type { RawLog } from "../../packages/kit/src/events.ts";
import type { State } from "../../packages/kit/src/types.ts";

const CENT = 10_000n; // one cent of USDC, six decimals
const TARGET = 200n * CENT;
const MIN_PLEDGE = 5n * CENT;
const MATCH = 50n * CENT;
const BONUS = 20n * CENT;
// The terms are the defaults the design names: a bonus pool of 10% of the target, a rate of 20%,
// an early window of 60% of the time open, and linear weight (an early pledge is worth most at
// opening and nothing by the end of the early window).
const RATE_BPS = 2000; // 20%
// Each backer pledges 1.50 in all. On Arc the same balance pays for gas, so each gets 0.20 more.
const BACKER_FUNDING = 170n * CENT;
// What a backer keeps back for the gas of its own last transfer when it returns the rest.
const SWEEP_KEEP = 5n * CENT;
// The open campaign stays open this long unless told otherwise; its early window is the first six tenths.
const LIVE_OPEN_FOR = 7n * 24n * 3600n;

/**
 * DEMO_LIVE_DAYS as a number of days: 7 when unset, a whole number from 1 to 60 written in
 * plain digits otherwise, and null for anything else.
 */
export function liveDaysFrom(text: string | undefined): number | null {
  if (text === undefined) return 7;
  if (!/^[0-9]{1,2}$/.test(text)) return null;
  const days = Number(text);
  return days >= 1 && days <= 60 ? days : null;
}

const ERC20 = [
  { inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], name: "approve", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "t", type: "address" }, { name: "a", type: "uint256" }], name: "transfer", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "a", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

type Kind = "funded" | "missed" | "rescued" | "void" | "live";
const ORDER: readonly Kind[] = ["funded", "missed", "rescued", "void", "live"];

export async function makeDemoCampaigns(o: {
  publicClient: PublicClient;
  sponsor: WalletClient;
  boomerang: Address;
  usdc: Address;
  recipient: Address;
  which: readonly Kind[];
  wait: (untilTimestamp: bigint) => Promise<void>;
  liveOpenFor?: bigint;
  fundGas?: (address: Address) => Promise<void>;
  log?: (line: string) => void;
}): Promise<{ kind: string; id: bigint; outcome: number }[]> {
  const { publicClient, boomerang, usdc, recipient, wait } = o;
  const log = o.log ?? (() => {});
  const sponsorAccount = o.sponsor.account;
  if (!sponsorAccount) throw new Error("the sponsor wallet has no account");
  const chain = publicClient.chain;
  const transport = custom({ request: (args) => publicClient.request(args) });

  // Three throwaway backers, made once, each funded with 1.70 USDC the first time it is used.
  // The private keys exist only here and are never logged.
  const backers = [0, 1, 2].map(() => {
    const account = privateKeyToAccount(generatePrivateKey());
    const wallet: WalletClient = createWalletClient({ account, chain, transport });
    return { account, wallet };
  });
  const fundedBackers = new Set<number>();

  // Send one transaction and wait for it. A receipt can come back "reverted" without anything
  // throwing (the gas estimate passed, the chain moved on), so the status is checked here.
  async function write(wallet: WalletClient, account: Account, abi: Abi, address: Address, functionName: string, args: readonly unknown[]): Promise<void> {
    const hash = await wallet.writeContract({ account, address, abi, functionName, args, chain });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted on-chain (transaction ${hash})`);
  }

  const sponsorWrite = (abi: Abi, address: Address, fn: string, args: readonly unknown[]) =>
    write(o.sponsor, sponsorAccount, abi, address, fn, args);

  const liveOpenFor = o.liveOpenFor ?? LIVE_OPEN_FOR;
  if (liveOpenFor < 2n) throw new Error("liveOpenFor must be at least 2 seconds");
  const latestTime = async () => (await publicClient.getBlock()).timestamp;
  const stateOf = (id: bigint) => publicClient.readContract({ address: boomerang, abi: boomerangAbi as Abi, functionName: "stateOf", args: [id] }) as Promise<State>;

  async function ensureFunded(i: number): Promise<void> {
    if (fundedBackers.has(i)) return;
    fundedBackers.add(i);
    await sponsorWrite(ERC20 as unknown as Abi, usdc, "transfer", [backers[i].account.address, BACKER_FUNDING]);
    if (o.fundGas) await o.fundGas(backers[i].account.address);
  }

  const pledges: { i: number; id: bigint }[] = []; // every pledge made in this run

  async function pledgeBy(i: number, id: bigint, amount: bigint): Promise<void> {
    await ensureFunded(i);
    await write(backers[i].wallet, backers[i].account, ERC20 as unknown as Abi, usdc, "approve", [boomerang, amount]);
    // Noted before it is sent: a pledge whose receipt never came may still have landed, and the
    // clean-up at the end reads the contract to see whether it did.
    if (!pledges.some((p) => p.i === i && p.id === id)) pledges.push({ i, id });
    await write(backers[i].wallet, backers[i].account, boomerangAbi as Abi, boomerang, "pledge", [id, amount]);
  }

  // Create a campaign and put its pots in before it opens. `live` widens the windows; `skipBonus`
  // leaves the bonus pot out, which is what makes a campaign go void at its opening second.
  async function create(live: boolean, skipBonus: boolean): Promise<{ id: bigint; opensAt: bigint; earlyUntil: bigint; closesAt: bigint }> {
    const opensAt = (await latestTime()) + 90n;
    const earlyUntil = opensAt + (live ? (liveOpenFor * 6n) / 10n : 144n);
    const closesAt = opensAt + (live ? liveOpenFor : 240n);
    const terms = {
      recipient,
      opensAt,
      earlyUntil,
      closesAt,
      target: TARGET,
      minPledge: MIN_PLEDGE,
      matchAmount: MATCH,
      bonusPool: BONUS,
      rateBps: RATE_BPS,
      linearWeight: true,
      bonusFromRecipient: false,
    };
    // The id comes from this transaction's own CampaignCreated event, not from the running
    // count, which someone else's campaign could have moved in the meantime.
    const hash = await o.sponsor.writeContract({ account: sponsorAccount as Account, address: boomerang, abi: boomerangAbi as Abi, functionName: "createCampaign", args: [terms], chain });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`createCampaign reverted on-chain (transaction ${hash})`);
    const made = decodeLogs(receipt.logs as unknown as RawLog[], boomerang).find((e) => e.name === "CampaignCreated");
    if (!made) throw new Error("createCampaign emitted no CampaignCreated event");
    const id = made.id;
    await sponsorWrite(ERC20 as unknown as Abi, usdc, "approve", [boomerang, MATCH]);
    await sponsorWrite(boomerangAbi as Abi, boomerang, "fundMatch", [id]);
    if (!skipBonus) {
      await sponsorWrite(ERC20 as unknown as Abi, usdc, "approve", [boomerang, BONUS]);
      await sponsorWrite(boomerangAbi as Abi, boomerang, "fundBonus", [id]);
    }
    return { id, opensAt, earlyUntil, closesAt };
  }

  // The backer allocation keeps each of the three throwaway accounts to 1.50 of pledges: A spends
  // 1.00 + 0.50, B spends 1.00 + 0.25 + 0.25, C spends 0.75 + 0.75; every pledge is above the minimum.
  async function flow(kind: Kind): Promise<bigint> {
    if (kind === "funded") {
      const { id, opensAt } = await create(false, false);
      await wait(opensAt);
      await pledgeBy(0, id, 100n * CENT);
      await pledgeBy(1, id, 100n * CENT); // reaches the target: the campaign funds itself
      return id;
    }
    if (kind === "missed") {
      const { id, opensAt, earlyUntil, closesAt } = await create(false, false);
      await wait(opensAt);
      await pledgeBy(2, id, 75n * CENT); // early
      await pledgeBy(0, id, 50n * CENT); // early
      await wait(earlyUntil);
      await pledgeBy(1, id, 25n * CENT); // late
      await wait(closesAt);
      await sponsorWrite(boomerangAbi as Abi, boomerang, "finalize", [id]);
      // Pay the three refunds now, while the backers' keys still exist to send them back.
      await sponsorWrite(boomerangAbi as Abi, boomerang, "payMany", [id, backers.map((b) => b.account.address)]);
      return id;
    }
    if (kind === "rescued") {
      const { id, opensAt } = await create(false, false);
      await wait(opensAt);
      await pledgeBy(2, id, 75n * CENT);
      const pledged = (await stateOf(id)).pledged;
      const gap = TARGET - pledged;
      await sponsorWrite(ERC20 as unknown as Abi, usdc, "approve", [boomerang, gap]);
      await sponsorWrite(boomerangAbi as Abi, boomerang, "rescue", [id]); // funds it at once
      return id;
    }
    if (kind === "void") {
      const { id, opensAt } = await create(false, true); // only the match pot funded
      await wait(opensAt);
      await sponsorWrite(boomerangAbi as Abi, boomerang, "finalize", [id]); // void at the opening second
      return id;
    }
    // live: both pots in, one early pledge, left open with wide windows. The backer's key is
    // thrown away when this script ends, so its payout is pointed at the sponsor.
    const { id, opensAt } = await create(true, false);
    await wait(opensAt);
    await pledgeBy(1, id, 25n * CENT);
    await write(backers[1].wallet, backers[1].account, boomerangAbi as Abi, boomerang, "redirect", [id, sponsorAccount!.address]);
    return id;
  }

  // The backers' keys die with this run. A pledge that could still come back as a refund (its
  // campaign is not funded and it has not been paid) is pointed at the sponsor while its key
  // still exists, so a run that stops halfway leaves no refund owed to a key nobody holds.
  // A failure here is reported and never fails the run.
  async function pointRefundsAtSponsor(): Promise<void> {
    const zero = "0x0000000000000000000000000000000000000000";
    for (const { i, id } of pledges) {
      const { account, wallet } = backers[i];
      try {
        if ((await stateOf(id)).outcome === 1) continue; // funded: the pledge went to the recipient
        const b = (await publicClient.readContract({ address: boomerang, abi: boomerangAbi as Abi, functionName: "backerOf", args: [id, account.address] })) as {
          principal: bigint;
          payTo: Address;
          paid: boolean;
        };
        if (b.principal === 0n || b.paid || b.payTo.toLowerCase() !== zero) continue;
        await write(wallet, account, boomerangAbi as Abi, boomerang, "redirect", [id, sponsorAccount!.address]);
        log(`backer ${i + 1}'s refund from campaign ${id} now goes to the sponsor`);
      } catch (e) {
        log(`backer ${i + 1}'s refund from campaign ${id} could not be pointed at the sponsor: ${String((e as Error).message ?? e).split("\n")[0]}`);
      }
    }
  }

  // Each funded backer sends back what it holds, less a little for this transfer's own gas.
  // A failure here is reported and never fails the run: the campaigns are already made.
  async function sweep(): Promise<void> {
    for (const i of fundedBackers) {
      const { account, wallet } = backers[i];
      try {
        const held = (await publicClient.readContract({ address: usdc, abi: ERC20, functionName: "balanceOf", args: [account.address] })) as bigint;
        if (held <= SWEEP_KEEP) continue;
        await write(wallet, account, ERC20 as unknown as Abi, usdc, "transfer", [sponsorAccount!.address, held - SWEEP_KEEP]);
        log(`backer ${i + 1} returned ${(Number(held - SWEEP_KEEP) / 1e6).toFixed(2)} USDC to the sponsor`);
      } catch (e) {
        log(`backer ${i + 1} could not return its balance: ${String((e as Error).message ?? e).split("\n")[0]}`);
      }
    }
  }

  const out: { kind: string; id: bigint; outcome: number }[] = [];
  try {
    for (const kind of ORDER) {
      if (!o.which.includes(kind)) continue;
      const id = await flow(kind);
      const outcome = (await stateOf(id)).outcome;
      out.push({ kind, id, outcome });
      log(`${kind.padEnd(8)} id ${id}  outcome ${outcome}`);
    }
  } finally {
    await pointRefundsAtSponsor();
    await sweep();
  }
  return out;
}
