// Every amount, address and hash in these tests is invented. None is a reading of any real transfer.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodePacked, pad, toHex } from "viem";

import { asBytes32, pledgeHook } from "../../packages/kit/src/index.ts";
import { FAST, STANDARD, burnCalls, fetchAttestation, fetchFeeRates, maxFeeFor, relayCall, waitForAttestation } from "../src/flows/crossChain.ts";

type Hex = `0x${string}`;
const ROUTER = "0x00000000000000000000000000000000000000f1" as const;
const MESSENGER = "0x00000000000000000000000000000000000000f2" as const;
const BACKER = "0x00000000000000000000000000000000000000c1" as const;
const SRC_USDC = "0x00000000000000000000000000000000000000d1" as const;
const TX = `0x${"ab".repeat(32)}` as Hex;
const ATT = `0x${"cd".repeat(65)}` as Hex;
const ZERO32 = pad("0x", { size: 32 });

function message(o: { mintRecipient?: Hex; onlyCaller?: Hex | null; amount?: bigint; fee?: bigint } = {}): Hex {
  const amount = o.amount ?? 25_000_000n;
  const body = encodePacked(
    ["uint32", "bytes32", "bytes32", "uint256", "bytes32", "uint256", "uint256", "uint256", "bytes"],
    [1, ZERO32, asBytes32(o.mintRecipient ?? ROUTER), amount, ZERO32, amount, o.fee ?? 0n, 0n, pledgeHook(7n, BACKER)],
  );
  const caller = o.onlyCaller === null ? ZERO32 : asBytes32(o.onlyCaller ?? ROUTER);
  return encodePacked(
    ["uint32", "uint32", "uint32", "bytes32", "bytes32", "bytes32", "bytes32", "uint32", "uint32", "bytes"],
    [1, 0, 26, toHex(1n, { size: 32 }), ZERO32, asBytes32(MESSENGER), caller, 1000, 1000, body],
  );
}

/** A stand-in for fetch that answers from a list, one answer per call (the last one repeats). */
function answers(...list: ({ status: number; body?: unknown } | Error)[]) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    const a = list[Math.min(urls.length - 1, list.length - 1)];
    if (a instanceof Error) throw a;
    return { status: a.status, json: async () => a.body };
  };
  return { fetch, urls };
}
const ask = { sourceDomain: 0, txHash: TX, router: ROUTER, messenger: MESSENGER } as const;
const complete = (m: Hex) => ({ message: m, attestation: ATT, status: "complete" });
const pendingRow = { message: "0x", attestation: "PENDING", status: "pending_confirmations" };

describe("cross-chain pledge: fees", function () {
  it("reads the two speeds' rates from Circle's answer", async function () {
    const { fetch, urls } = answers({ status: 200, body: [{ finalityThreshold: 1000, minimumFee: 1 }, { finalityThreshold: 2000, minimumFee: 0 }] });
    assert.deepEqual(await fetchFeeRates({ fetch, sourceDomain: 6 }), { fast: 1, standard: 0 });
    assert.deepEqual(urls, ["https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/6/26"]);
  });

  it("a speed Circle does not list is null; a broken answer is an error, never a zero fee", async function () {
    assert.deepEqual(await fetchFeeRates({ ...answers({ status: 200, body: [{ finalityThreshold: 2000, minimumFee: 0 }] }), sourceDomain: 0 }), { fast: null, standard: 0 });
    assert.deepEqual(await fetchFeeRates({ ...answers({ status: 200, body: [{ finalityThreshold: 1000, minimumFee: "1" }, null, 5] }), sourceDomain: 0 }), { fast: null, standard: null });
    await assert.rejects(fetchFeeRates({ ...answers({ status: 500 }), sourceDomain: 0 }), /answered 500/);
    await assert.rejects(fetchFeeRates({ ...answers({ status: 200, body: { error: true } }), sourceDomain: 0 }), /shape/);
  });

  it("the most a burn agrees to pay: the fee rounded up, a fifth more, and never the whole amount", function () {
    assert.equal(maxFeeFor(25_000_000n, 1), 3_000n); // 0.01% of 25.00 is 0.0025; a fifth more
    assert.equal(maxFeeFor(25_000_000n, 0), 0n);
    assert.equal(maxFeeFor(25_000_000n, 1.3), 3_900n); // a fraction of a basis point is kept
    assert.equal(maxFeeFor(1n, 1), 0n); // the fee rounds up to 1, which may not reach the amount
    assert.equal(maxFeeFor(3n, 5_000), 2n);
    assert.equal(maxFeeFor(0n, 1), 0n);
    assert.equal(maxFeeFor(25_000_000n, Number.NaN), 0n);
    for (const amount of [1n, 2n, 10n, 999n, 1_000_000n]) {
      for (const bps of [0.5, 1, 14, 9_999]) assert.ok(maxFeeFor(amount, bps) < amount, `${amount} at ${bps}`);
    }
  });
});

describe("cross-chain pledge: the burn", function () {
  it("approves Circle's messenger for exactly the amount when needed, then burns naming the router twice", function () {
    const base = { sourceUsdc: SRC_USDC, sourceMessenger: MESSENGER, router: ROUTER, campaignId: 7n, backer: BACKER, amount: 25_000_000n, maxFee: 3_000n, speed: FAST } as const;
    const two = burnCalls({ ...base, allowance: 0n });
    assert.deepEqual(two.map((c) => [c.to, c.functionName]), [[SRC_USDC, "approve"], [MESSENGER, "depositForBurnWithHook"]]);
    assert.deepEqual(two[0].args, [MESSENGER, 25_000_000n]);
    assert.deepEqual(two[1].args, [25_000_000n, 26, asBytes32(ROUTER), SRC_USDC, asBytes32(ROUTER), 3_000n, 1000, pledgeHook(7n, BACKER)]);
    const one = burnCalls({ ...base, allowance: 25_000_000n, speed: STANDARD });
    assert.deepEqual(one.map((c) => c.functionName), ["depositForBurnWithHook"]);
    assert.equal(one[0].args[6], 2000);
  });
});

describe("cross-chain pledge: the attestation", function () {
  it("not seen yet, confirming, delayed and ready each read as what they are", async function () {
    assert.deepEqual(await fetchAttestation({ ...ask, ...answers({ status: 404, body: { code: 404, message: "Not found." } }) }), { state: "waiting", why: "not-seen-yet" });
    assert.deepEqual(await fetchAttestation({ ...ask, ...answers({ status: 200, body: { messages: [] } }) }), { state: "waiting", why: "not-seen-yet" });
    assert.deepEqual(await fetchAttestation({ ...ask, ...answers({ status: 200, body: { messages: [pendingRow] } }) }), { state: "waiting", why: "confirming" });
    assert.deepEqual(
      await fetchAttestation({ ...ask, ...answers({ status: 200, body: { messages: [{ ...pendingRow, delayReason: "insufficient_fee" }] } }) }),
      { state: "waiting", why: "insufficient_fee" },
    );
    const m = message({ fee: 2_500n });
    const { fetch, urls } = answers({ status: 200, body: { messages: [complete(m)] } });
    assert.deepEqual(await fetchAttestation({ ...ask, fetch }), { state: "ready", message: m, attestation: ATT, campaignId: 7n, backer: BACKER, arrives: 25_000_000n - 2_500n });
    assert.deepEqual(urls, [`https://iris-api-sandbox.circle.com/v2/messages/0?transactionHash=${TX}`]);
  });

  it("a row marked complete without a real attestation is still waiting", async function () {
    for (const row of [{ message: message(), attestation: "PENDING", status: "complete" }, { message: "0x", attestation: ATT, status: "complete" }, { message: message(), attestation: null, status: "complete" }]) {
      assert.equal((await fetchAttestation({ ...ask, ...answers({ status: 200, body: { messages: [row] } }) })).state, "waiting");
    }
  });

  it("a transaction with several messages: the one for the router is taken; with none for it, the answer is wrong, not waiting", async function () {
    const other = message({ mintRecipient: asBytes32(BACKER) });
    const good = message();
    const found = await fetchAttestation({ ...ask, ...answers({ status: 200, body: { messages: [complete(other), complete(good)] } }) });
    assert.equal(found.state === "ready" && found.message, good);
    assert.deepEqual(await fetchAttestation({ ...ask, ...answers({ status: 200, body: { messages: [complete(other)] } }) }), { state: "wrong", why: "not-for-router" });
    assert.deepEqual(await fetchAttestation({ ...ask, ...answers({ status: 200, body: { messages: [complete(message({ onlyCaller: null }))] } }) }), { state: "wrong", why: "open-to-anyone" });
    // one still confirming next to a wrong one: keep waiting, the pending one may be ours
    assert.equal((await fetchAttestation({ ...ask, ...answers({ status: 200, body: { messages: [complete(other), pendingRow] } }) })).state, "waiting");
  });

  it("an answer in an unknown shape, or a server error, is an error", async function () {
    await assert.rejects(fetchAttestation({ ...ask, ...answers({ status: 200, body: { nothing: 1 } }) }), /shape/);
    await assert.rejects(fetchAttestation({ ...ask, ...answers({ status: 503 }) }), /answered 503/);
  });

  it("waiting asks again until ready, rides out a failed ask, and reports each tick", async function () {
    const good = message();
    const { fetch, urls } = answers({ status: 404 }, new Error("network down"), { status: 200, body: { messages: [pendingRow] } }, { status: 200, body: { messages: [complete(good)] } });
    const ticks: string[] = [];
    const slept: number[] = [];
    const got = await waitForAttestation({ ...ask, fetch, everyMs: 1_000, sleep: async (ms) => void slept.push(ms), onTick: (a, waited) => ticks.push(`${waited}:${a.state}:${a.state === "waiting" ? a.why : ""}`) });
    assert.equal(got.message, good);
    assert.equal(urls.length, 4);
    assert.deepEqual(slept, [1_000, 1_000, 1_000]);
    assert.deepEqual(ticks, ["0:waiting:not-seen-yet", "1000:waiting:network down", "2000:waiting:confirming", "3000:ready:"]);
  });

  it("waiting stops at once on a wrong message, and at the time limit says nothing is lost", async function () {
    const wrong = answers({ status: 200, body: { messages: [complete(message({ mintRecipient: asBytes32(BACKER) }))] } });
    await assert.rejects(waitForAttestation({ ...ask, fetch: wrong.fetch, sleep: async () => {} }), /not a pledge the router takes \(not-for-router\)/);
    assert.equal(wrong.urls.length, 1);
    const never = answers({ status: 404 });
    await assert.rejects(waitForAttestation({ ...ask, fetch: never.fetch, everyMs: 1_000, timeoutMs: 3_000, sleep: async () => {} }), /nothing is lost/);
    assert.equal(never.urls.length, 4); // at 0, 1, 2 and 3 seconds
  });
});

describe("cross-chain pledge: the relay", function () {
  it("is one call to the router with the message and its attestation", function () {
    const m = message();
    const call = relayCall({ router: ROUTER, message: m, attestation: ATT });
    assert.deepEqual([call.to, call.functionName, call.args], [ROUTER, "relay", [m, ATT]]);
  });
});
