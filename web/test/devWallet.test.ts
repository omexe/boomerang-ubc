// The stand-in wallet for a local chain, and the start-up words. Every address here is invented.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { configFrom, ConfigError } from "../src/app/config.ts";
import { startProblem } from "../src/views/start.ts";
import { devWallet, devWalletFrom, type RpcFetch } from "../src/wallet/devWallet.ts";

const B = "0x00000000000000000000000000000000000000b0";
const U = "0x3600000000000000000000000000000000000000";
const R = "0x00000000000000000000000000000000000000c0";
const ME = "0x00000000000000000000000000000000000000a1";
const OTHER = "0x00000000000000000000000000000000000000a2";
const localEnv = { VITE_CHAIN_ID: "31337", VITE_RPC_URL: "http://127.0.0.1:8545", VITE_BOOMERANG: B, VITE_USDC: U, VITE_ROUTER: R };
const local = configFrom(localEnv);
const arc = configFrom({}, () => ({ boomerang: B, usdc: U, router: R }));

function node(answer: unknown) {
  const asked: { url: string; body: { method: string; params: unknown[] } }[] = [];
  const fetch: RpcFetch = async (url, init) => {
    asked.push({ url, body: JSON.parse(init.body) });
    return { json: async () => answer };
  };
  return { asked, fetch };
}
const wallet = (fetch: RpcFetch) => devWallet({ name: "Local test wallet", address: ME, chainId: 31337, rpcUrl: "http://127.0.0.1:8545", fetch });
const code = async (p: Promise<unknown>) => p.then(() => null, (e) => (e as { code?: number }).code ?? "no code");

describe("the local test wallet", function () {
  it("devwallet.local: it exists only for a local chain; on Arc Testnet setting it stops the app", function () {
    assert.equal(devWalletFrom({}, local), null);
    assert.equal(devWalletFrom({ VITE_DEV_WALLET: "" }, arc), null);
    assert.equal(devWalletFrom({ VITE_DEV_WALLET: ME }, local), ME);
    assert.throws(() => devWalletFrom({ VITE_DEV_WALLET: ME }, arc), (e) => e instanceof ConfigError && /local chain only/.test(e.message));
    assert.throws(() => devWalletFrom({ VITE_DEV_WALLET: "0x12" }, local), (e) => e instanceof ConfigError && /must be an address/.test(e.message));
  });

  it("devwallet.answers: it gives its one account and its one chain without asking the node", async function () {
    const n = node({ result: "0x" });
    const w = wallet(n.fetch);
    assert.deepEqual(await w.provider.request({ method: "eth_requestAccounts" }), [ME]);
    assert.deepEqual(await w.provider.request({ method: "eth_accounts" }), [ME]);
    assert.equal(await w.provider.request({ method: "eth_chainId" }), "0x7a69");
    assert.equal(await w.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x7A69" }] }), null);
    assert.equal(n.asked.length, 0);
    assert.equal(w.name, "Local test wallet");
  });

  it("devwallet.stays: it will not move to another chain, and it will not send from another account", async function () {
    const n = node({ result: "0xabc" });
    const w = wallet(n.fetch);
    assert.equal(await code(w.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x4cef52" }] })), 4902);
    assert.equal(await code(w.provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0x4cef52" }] })), 4200);
    assert.equal(await code(w.provider.request({ method: "eth_sendTransaction", params: [{ from: OTHER, to: B }] })), 4100);
    assert.equal(await code(w.provider.request({ method: "eth_sendTransaction", params: [{ to: B }] })), 4100);
    assert.equal(n.asked.length, 0);
    assert.equal(await w.provider.request({ method: "eth_sendTransaction", params: [{ from: ME.toUpperCase().replace("0X", "0x"), to: B }] }), "0xabc");
    assert.equal(n.asked.length, 1);
    assert.equal(n.asked[0].url, "http://127.0.0.1:8545");
    assert.equal(n.asked[0].body.method, "eth_sendTransaction");
  });

  it("devwallet.reads: it passes the node what a page asks of a chain, and nothing that signs or steers the node (typed data for its own account aside: test/signed.test.ts)", async function () {
    const n = node({ result: "0x1" });
    const w = wallet(n.fetch);
    for (const method of ["personal_sign", "eth_sign", "eth_signTypedData", "eth_signTypedData_v3", "eth_signTransaction", "hardhat_impersonateAccount", "hardhat_setBalance", "evm_mine", "anvil_setCode", "debug_traceCall", "wallet_sendCalls"]) {
      assert.equal(await code(w.provider.request({ method, params: [ME, "0x00"] })), 4200, method);
    }
    assert.equal(n.asked.length, 0);
    for (const method of ["eth_call", "eth_estimateGas", "eth_getTransactionCount", "eth_getTransactionReceipt", "eth_blockNumber", "eth_feeHistory"]) {
      assert.equal(await w.provider.request({ method, params: [] }), "0x1", method);
    }
    assert.equal(n.asked.length, 6);
  });

  it("devwallet.errors: the node's refusal is passed up with its code and data; no answer is an error", async function () {
    const refused = wallet(node({ error: { code: 3, message: "execution reverted", data: "0xdead" } }).fetch);
    const e = await refused.provider.request({ method: "eth_call", params: [] }).then(() => null, (x) => x as Error & { code: number; data: unknown });
    assert.ok(e);
    assert.deepEqual([e.message, e.code, e.data], ["execution reverted", 3, "0xdead"]);
    assert.equal(await code(wallet(node(null).fetch).provider.request({ method: "eth_blockNumber" })), -32603);
  });
});

describe("the start-up words", function () {
  it("a configuration problem is named in a sentence, and an unknown one says so", function () {
    assert.equal(startProblem("VITE_RPC_URL is needed for a local chain").line, "This copy of the app is set up wrongly: VITE_RPC_URL is needed for a local chain.");
    assert.equal(startProblem(null).line, "This copy of the app is set up wrongly: its settings could not be read.");
    assert.match(startProblem(null).note, /Nothing was read and nothing was sent/);
  });
});
