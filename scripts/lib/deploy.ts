// Deploy Boomerang, its PledgeRouter and SignedPledge (the one-signature pledge helper), read them back to prove they went up as
// meant, then record the result: the kit's addresses.json gets the new addresses, the deploy
// block and the hash of the transaction that created Boomerang.
//
// No key and no network choice live here. The caller hands in the Hardhat viem helpers already
// bound to a network (the in-memory chain in tests, Arc through scripts/deploy.ts in anger).
import { rename, readFile, writeFile } from "node:fs/promises";

import { keccak256 } from "viem";
import type { Address } from "viem";

import type { HardhatViemHelpers } from "@nomicfoundation/hardhat-viem/types";

export type DeployOutput = {
  chainId: number;
  boomerang: Address;
  router: Address;
  signedPledge: Address;
  usdc: Address;
  transmitter: Address;
  messenger: Address;
  deployBlock: bigint;
  /** The transaction that created Boomerang; `check-live` reads it to prove how the contract began. */
  boomerangTx: `0x${string}`;
  deployer: Address;
  boomerangCodeHash: `0x${string}`;
  routerCodeHash: `0x${string}`;
  signedPledgeCodeHash: `0x${string}`;
};

// Case-insensitive address comparison; the read-back asserts never care about checksum casing.
function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export async function deployAll(o: {
  viem: HardhatViemHelpers;
  chainId: number;
  usdc: Address;
  transmitter: Address;
  messenger: Address;
  addressesPath: string;
  log?: (line: string) => void;
}): Promise<DeployOutput> {
  const { viem, chainId, usdc, transmitter, messenger } = o;
  const log = o.log ?? (() => {});
  const publicClient = await viem.getPublicClient();
  const deployer = (await viem.getWalletClients())[0].account.address;

  // Boomerang first: its deployment block is the one recorded, so events can be read from it.
  const { contract: boomerang, deploymentTransaction } = await viem.sendDeploymentTransaction("Boomerang", [usdc]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deploymentTransaction.hash });
  const deployBlock = receipt.blockNumber;

  const router = await viem.deployContract("PledgeRouter", [usdc, boomerang.address, transmitter, messenger]);
  const helper = await viem.deployContract("SignedPledge", [usdc, boomerang.address]);

  // Code hashes from the live runtime code, not the artifact; a failed deployment has none.
  const boomerangCode = await publicClient.getCode({ address: boomerang.address });
  const routerCode = await publicClient.getCode({ address: router.address });
  const helperCode = await publicClient.getCode({ address: helper.address });
  if (!boomerangCode || !routerCode || !helperCode) throw new Error("a deployed contract has no runtime code");
  const signedPledgeCodeHash = keccak256(helperCode);
  const boomerangCodeHash = keccak256(boomerangCode);
  const routerCodeHash = keccak256(routerCode);

  // Read both contracts back and refuse anything that does not match what was asked for.
  const token = await boomerang.read.usdc();
  if (!sameAddress(token, usdc)) throw new Error(`Boomerang.usdc is ${token}, expected ${usdc}`);
  const count = await boomerang.read.campaignCount();
  if (count !== 0n) throw new Error(`a fresh Boomerang has campaignCount ${count}, expected 0`);
  const rUsdc = await router.read.usdc();
  if (!sameAddress(rUsdc, usdc)) throw new Error(`PledgeRouter.usdc is ${rUsdc}, expected ${usdc}`);
  const rBoomerang = await router.read.boomerang();
  if (!sameAddress(rBoomerang, boomerang.address)) {
    throw new Error(`PledgeRouter.boomerang is ${rBoomerang}, expected ${boomerang.address}`);
  }
  const rTransmitter = await router.read.transmitter();
  if (!sameAddress(rTransmitter, transmitter)) throw new Error(`PledgeRouter.transmitter is ${rTransmitter}, expected ${transmitter}`);
  const rMessenger = await router.read.messenger();
  if (!sameAddress(rMessenger, messenger)) throw new Error(`PledgeRouter.messenger is ${rMessenger}, expected ${messenger}`);
  const hUsdc = await helper.read.usdc();
  if (!sameAddress(hUsdc, usdc)) throw new Error(`SignedPledge.usdc is ${hUsdc}, expected ${usdc}`);
  const hBoomerang = await helper.read.boomerang();
  if (!sameAddress(hBoomerang, boomerang.address)) throw new Error(`SignedPledge.boomerang is ${hBoomerang}, expected ${boomerang.address}`);

  // Update addresses.json: overwrite this chain's six addresses and deployBlock, keep every
  // other key and chain, two-space indent and a trailing newline, written atomically.
  const parsed = JSON.parse(await readFile(o.addressesPath, "utf8")) as Record<string, Record<string, unknown>>;
  const key = String(chainId);
  parsed[key] = {
    ...(parsed[key] ?? {}),
    boomerang: boomerang.address,
    router: router.address,
    signedPledge: helper.address,
    usdc,
    transmitter,
    messenger,
    deployBlock: deployBlock.toString(),
    boomerangTx: deploymentTransaction.hash,
  };
  await writeFileAtomic(o.addressesPath, JSON.stringify(parsed, null, 2) + "\n");

  log(`chainId        ${chainId}`);
  log(`deployer       ${deployer}`);
  log(`boomerang      ${boomerang.address}`);
  log(`router         ${router.address}`);
  log(`signedPledge   ${helper.address}`);
  log(`usdc           ${usdc}`);
  log(`transmitter    ${transmitter}`);
  log(`messenger      ${messenger}`);
  log(`deployBlock    ${deployBlock}`);
  log(`created by     ${deploymentTransaction.hash}`);
  log(`boomerang code ${boomerangCodeHash}`);
  log(`router code    ${routerCodeHash}`);
  log(`helper code    ${signedPledgeCodeHash}`);
  log(`addresses      ${o.addressesPath}`);

  return {
    chainId,
    boomerang: boomerang.address,
    router: router.address,
    signedPledge: helper.address,
    usdc,
    transmitter,
    messenger,
    deployBlock,
    boomerangTx: deploymentTransaction.hash,
    deployer,
    boomerangCodeHash,
    routerCodeHash,
    signedPledgeCodeHash,
  };
}

// Write through a sibling temp file and rename over the target, so a reader never sees a
// half-written file and a crash cannot truncate the real one.
async function writeFileAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}
