// How the page's reads reach the chain. Every address, block and figure here is invented; the node is a stand-in.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeFunctionResult, multicall3Abi, type Abi, type Hex } from "viem";

import { arcTestnet, boomerangAbi, reader } from "../../packages/kit/src/index.ts";
import { clientFor } from "../src/app/chain.ts";
import { configFrom } from "../src/app/config.ts";
import { explain } from "../src/data/errors.ts";

const B = "0x00000000000000000000000000000000000000b0";
const U = "0x3600000000000000000000000000000000000000";
const R = "0x00000000000000000000000000000000000000c0";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const seven = encodeAbiParameters([{ type: "uint256" }], [7n]);

/** A node that answers every view with 7, and Multicall3's aggregate3 with a 7 for each call inside it. With `revert`, every view reverts with that data instead. */
function node(revert?: Hex) {
  const calls: { to: string; block: unknown; inside: number }[] = [];
  const fetchFn = (async (_input: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: [{ to: string; data: Hex }, unknown] };
    assert.equal(body.method, "eth_call");
    const [{ to, data }, block] = body.params;
    let result: Hex = seven;
    let inside = 1;
    if (to.toLowerCase() === MULTICALL3.toLowerCase()) {
      const inner = decodeFunctionData({ abi: multicall3Abi, data }).args![0] as readonly unknown[];
      inside = inner.length;
      result = encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: inner.map(() => (revert ? { success: false, returnData: revert } : { success: true, returnData: seven })) });
    } else if (revert) {
      calls.push({ to: to.toLowerCase(), block, inside });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: 3, message: "execution reverted", data: revert } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    calls.push({ to: to.toLowerCase(), block, inside });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("the page's chain client", function () {
  it("client.multicall: on Arc, reads made together at one block reach the node as one call", async function () {
    const n = node();
    const config = configFrom({}, () => ({ boomerang: B, usdc: U, router: R }) as const);
    const reads = reader(clientFor(config, n.fetchFn), B, 1234n);
    const answers = await Promise.all([reads.campaignCount(), reads.totalOwed(), reads.eventCount()]);
    assert.deepEqual(answers, [7n, 7n, 7n]);
    // Arc's public node counts every eth_call against a visitor's allowance, so three reads must cost one.
    assert.deepEqual(n.calls, [{ to: MULTICALL3.toLowerCase(), block: "0x4d2", inside: 3 }]);
    assert.equal(arcTestnet.contracts?.multicall3?.address, MULTICALL3);
  });

  it("client.revert: a view the contract refuses reads the same through Multicall3 as it does directly", async function () {
    const refused = encodeErrorResult({ abi: boomerangAbi as unknown as Abi, errorName: "NoSuchCampaign" });
    const said = async (config: ReturnType<typeof configFrom>) => {
      try {
        await reader(clientFor(config, node(refused).fetchFn), B, 1234n).termsOf(99n);
      } catch (e) {
        return explain(e);
      }
      return "no error";
    };
    const onArc = await said(configFrom({}, () => ({ boomerang: B, usdc: U, router: R }) as const));
    const direct = await said(configFrom({ VITE_CHAIN_ID: "31337", VITE_RPC_URL: "http://127.0.0.1:8545", VITE_BOOMERANG: B, VITE_USDC: U, VITE_ROUTER: R }));
    assert.equal(onArc, direct);
    assert.doesNotMatch(onArc, /did not go through|no error/);
  });

  it("client.local: on a local chain, which has no Multicall3, each read goes on its own", async function () {
    const n = node();
    const config = configFrom({ VITE_CHAIN_ID: "31337", VITE_RPC_URL: "http://127.0.0.1:8545", VITE_BOOMERANG: B, VITE_USDC: U, VITE_ROUTER: R });
    const reads = reader(clientFor(config, n.fetchFn), B, 1234n);
    assert.deepEqual(await Promise.all([reads.campaignCount(), reads.totalOwed()]), [7n, 7n]);
    assert.deepEqual(
      n.calls.map((c) => [c.to, c.inside]),
      [
        [B, 1],
        [B, 1],
      ],
    );
  });
});
