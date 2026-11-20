// The chains a backer can pledge from besides Arc, with what a CCTP burn there needs.
// Token addresses and domains are Circle's, read on 2026-11-15 at
// developers.circle.com/stablecoins/usdc-contract-addresses and /cctp/evm-smart-contracts.
// Circle's token messenger has the same address on each of these testnets.
import type { Chain } from "viem";
import { baseSepolia, sepolia } from "viem/chains";

import type { Address } from "../../../packages/kit/src/index.ts";

export type SourceChain = {
  chain: Chain;
  /** What the page calls it. */
  label: string;
  /** Circle's number for the chain in CCTP. */
  domain: number;
  /** Circle's USDC on that chain: the token the backer burns. */
  usdc: Address;
  /** Circle's TokenMessengerV2 there: the contract the burn is sent to. */
  messenger: Address;
};

const MESSENGER: Address = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";

export const SOURCE_CHAINS: readonly SourceChain[] = [
  { chain: sepolia, label: "Ethereum Sepolia", domain: 0, usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", messenger: MESSENGER },
  { chain: baseSepolia, label: "Base Sepolia", domain: 6, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", messenger: MESSENGER },
];

/** The source chain with this chain id, if the page offers it. */
export function sourceChain(chainId: number): SourceChain | undefined {
  return SOURCE_CHAINS.find((s) => s.chain.id === chainId);
}
