// The deployment entry the owner runs by hand, holding the key in Hardhat's keystore:
//
//   cd contracts && npx hardhat run ../scripts/deploy.ts --network arcTestnet
//
// It refuses to do anything unless it is talking to Arc Testnet (chain 5042002), prints the
// deployer and the three addresses it will use, then hands off to deployAll, which deploys the
// three contracts (Boomerang, PledgeRouter, SignedPledge), reads them back, and records the result in the kit's addresses.json.
// Paths resolve from this file, not the working directory.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { network } from "hardhat";
import { formatUnits } from "viem";
import type { Address } from "viem";

import { deployAll } from "./lib/deploy.ts";

const ARC_CHAIN_ID = 5042002;
const here = new URL(".", import.meta.url);
const addressesPath = fileURLToPath(new URL("../packages/kit/addresses.json", here));

async function main(): Promise<void> {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  if (chainId !== ARC_CHAIN_ID) {
    console.error(`Refusing to deploy: connected to chain ${chainId}, but this script only deploys to Arc Testnet (${ARC_CHAIN_ID}).`);
    console.error("Run it with: cd contracts && npx hardhat run ../scripts/deploy.ts --network arcTestnet");
    process.exit(1);
  }

  const entry = JSON.parse(await readFile(addressesPath, "utf8"))[String(ARC_CHAIN_ID)];
  if (!entry || !entry.usdc || !entry.transmitter || !entry.messenger) {
    console.error(`addresses.json has no usdc/transmitter/messenger for chain ${ARC_CHAIN_ID}`);
    process.exit(1);
  }
  // A second deployment would point the app and the keeper at a new, empty contract
  // and leave the first one's campaigns behind. It has to be asked for by name.
  if (entry.boomerang && process.env.BOOMERANG_REDEPLOY !== "1") {
    console.error(`Boomerang is already recorded at ${entry.boomerang} for chain ${ARC_CHAIN_ID}.`);
    console.error("To deploy a new one anyway, run the same command with BOOMERANG_REDEPLOY=1 in front.");
    process.exit(1);
  }
  const usdc = entry.usdc as Address;
  const transmitter = entry.transmitter as Address;
  const messenger = entry.messenger as Address;

  const deployer = (await viem.getWalletClients())[0].account.address;
  const balance = await publicClient.getBalance({ address: deployer });
  console.log(`deployer       ${deployer}`);
  console.log(`balance        ${formatUnits(balance, 18)} (native)`);
  console.log(`usdc           ${usdc}`);
  console.log(`transmitter    ${transmitter}`);
  console.log(`messenger      ${messenger}`);
  console.log("deploying...");

  await deployAll({
    viem,
    chainId,
    usdc,
    transmitter,
    messenger,
    addressesPath,
    log: (line) => console.log(line),
  });
  console.log("done.");
}

await main();
