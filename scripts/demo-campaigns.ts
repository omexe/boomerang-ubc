// Make the demo campaigns on the live Boomerang. The owner runs this by hand, holding the key:
//
//   cd contracts && DEMO_RECIPIENT=0x... npx hardhat run ../scripts/demo-campaigns.ts --network arcTestnet
//
// It refuses to run anywhere but Arc Testnet (chain 5042002). DEMO_RECIPIENT is required: it is
// the address the funded and rescued campaigns pay. DEMO_WHICH is an optional comma-separated
// list (funded,missed,rescued,void,live); it defaults to all five. DEMO_LIVE_DAYS is how many days
// the open campaign stays open (default 7). `wait` polls the chain's clock.
import { network } from "hardhat";
import { isAddress } from "viem";
import type { Address } from "viem";

import { addressesFor } from "../packages/kit/src/index.ts";
import { liveDaysFrom, makeDemoCampaigns } from "./lib/demo.ts";

const ARC_CHAIN_ID = 5042002;
const ALL = ["funded", "missed", "rescued", "void", "live"] as const;
type Kind = (typeof ALL)[number];

async function main(): Promise<void> {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  if (chainId !== ARC_CHAIN_ID) {
    console.error(`Refusing to run: connected to chain ${chainId}, but this script only runs on Arc Testnet (${ARC_CHAIN_ID}).`);
    process.exit(1);
  }

  const recipient = process.env.DEMO_RECIPIENT;
  if (!recipient || !isAddress(recipient)) {
    console.error("DEMO_RECIPIENT must be set to the address the funded and rescued campaigns pay.");
    process.exit(1);
  }

  const which = (process.env.DEMO_WHICH ?? ALL.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const bad = which.filter((s) => !(ALL as readonly string[]).includes(s));
  if (bad.length > 0) {
    console.error(`DEMO_WHICH has unknown kinds: ${bad.join(", ")}. Valid: ${ALL.join(", ")}`);
    process.exit(1);
  }

  const liveDays = liveDaysFrom(process.env.DEMO_LIVE_DAYS);
  if (liveDays === null) {
    console.error("DEMO_LIVE_DAYS must be a whole number of days from 1 to 60.");
    process.exit(1);
  }

  const { boomerang, usdc } = addressesFor(ARC_CHAIN_ID);
  const [sponsor] = await viem.getWalletClients();

  // Poll the chain's own clock every two seconds until it passes the target time.
  async function wait(until: bigint): Promise<void> {
    for (;;) {
      const now = (await publicClient.getBlock()).timestamp;
      if (now >= until) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const made = await makeDemoCampaigns({
    publicClient,
    sponsor,
    boomerang,
    usdc,
    recipient: recipient as Address,
    which: which as Kind[],
    wait,
    liveOpenFor: BigInt(liveDays) * 86400n,
    log: (line) => console.log(line),
  });
  console.log(`made ${made.length} campaign(s).`);
}

await main();
