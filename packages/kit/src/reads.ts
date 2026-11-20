// A thin, typed reader over Boomerang's views. One method per view, each returning the kit's
// own types; `campaign` fetches terms, state and the live outcome in one round of parallel reads.
// Given a block number, every read is made at that block, so figures read together describe one
// moment; without one, each read is at whatever block is newest when it arrives.
import type { Abi, PublicClient } from "viem";

import { boomerangAbi } from "./abi.ts";
import type { Address, Backer, State, Terms } from "./types.ts";

export function reader(client: PublicClient, boomerang: Address, at?: bigint) {
  const abi = boomerangAbi as unknown as Abi;
  const when = at === undefined ? {} : { blockNumber: at };

  function read<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return client.readContract({ address: boomerang, abi, functionName, args, ...when }) as Promise<T>;
  }

  return {
    campaignCount: () => read<bigint>("campaignCount"),
    totalOwed: () => read<bigint>("totalOwed"),
    eventCount: () => read<bigint>("eventCount"),
    termsOf: (id: bigint) => read<Terms>("termsOf", [id]),
    stateOf: (id: bigint) => read<State>("stateOf", [id]),
    backerOf: (id: bigint, backer: Address) => read<Backer>("backerOf", [id, backer]),
    outcomeNow: (id: bigint) => read<number>("outcomeNow", [id]),
    weightAt: (id: bigint, time: bigint) => read<bigint>("weightAt", [id, time]),
    quoteIfMissed: async (id: bigint, amount: bigint): Promise<{ wouldFund: boolean; counted: bigint; bonus: bigint }> => {
      const [wouldFund, counted, bonus] = await read<[boolean, bigint, bigint]>("quoteIfMissed", [id, amount]);
      return { wouldFund, counted, bonus };
    },
    owedTo: async (id: bigint, backer: Address): Promise<{ principal: bigint; bonus: bigint }> => {
      const [principal, bonus] = await read<[bigint, bigint]>("owedTo", [id, backer]);
      return { principal, bonus };
    },
    positionIfMissed: async (id: bigint, backer: Address): Promise<{ principal: bigint; bonus: bigint }> => {
      const [principal, bonus] = await read<[bigint, bigint]>("positionIfMissed", [id, backer]);
      return { principal, bonus };
    },
    campaign: async (
      id: bigint,
    ): Promise<{ id: bigint; terms: Terms; state: State; outcomeNow: number }> => {
      const [terms, state, outcomeNow] = await Promise.all([
        read<Terms>("termsOf", [id]),
        read<State>("stateOf", [id]),
        read<number>("outcomeNow", [id]),
      ]);
      return { id, terms, state, outcomeNow };
    },
  };
}
