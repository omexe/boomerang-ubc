// The chain as viem wants it, from the app's configuration.
import { createPublicClient, defineChain, http, type Chain, type PublicClient } from "viem";

import { arcTestnet } from "../../../packages/kit/src/index.ts";
import type { Config } from "./config.ts";

export function chainOf(config: Config): Chain {
  if (!config.chain.local && config.chain.id === arcTestnet.id) return arcTestnet;
  return defineChain({
    id: config.chain.id,
    name: config.chain.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.chain.rpcUrl] } },
    testnet: true,
  });
}

/**
 * The client every read of the page goes through. Reads made in the same moment at the same block
 * go to the node as one call, through Multicall3 where the chain names one (Arc does; a local chain
 * does not, and there each read goes on its own). Arc's public node counts every `eth_call` against
 * a visitor's allowance (about twenty a second, counted inside a JSON-RPC batch too; measured
 * 2026-11-18), and one refresh of the page is some thirty reads. A read with an account, a
 * simulation and a send are never folded in. `fetchFn` stands in for the network in tests.
 */
export function clientFor(config: Config, fetchFn?: typeof fetch): PublicClient {
  return createPublicClient({
    chain: chainOf(config),
    transport: http(config.chain.rpcUrl, fetchFn ? { fetchFn } : {}),
    batch: { multicall: true },
  }) as PublicClient;
}
