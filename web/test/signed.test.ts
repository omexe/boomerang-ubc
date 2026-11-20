// The one-signature pledge on the page. Every address, amount and time here is invented.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { nonceFor } from "../../packages/kit/src/index.ts";
import { configFrom, ConfigError } from "../src/app/config.ts";
import { askRelay, type Fetch } from "../src/data/ask.ts";
import { readHealth } from "../src/data/health.ts";
import { authorization, newSalt, relayBody, SIGNED } from "../src/flows/signed.ts";
import { outstandingStore, signedWait } from "../src/flows/outstanding.ts";
import { pledgeRoute, relayLine, relayRefusedBeforeSending, stillValidLine } from "../src/views/pledge.ts";
import { devWallet, type RpcFetch } from "../src/wallet/devWallet.ts";

const B = "0x00000000000000000000000000000000000000b0";
const U = "0x3600000000000000000000000000000000000000";
const R = "0x00000000000000000000000000000000000000c0";
const H = "0x00000000000000000000000000000000000000e1";
const local = { VITE_CHAIN_ID: "31337", VITE_RPC_URL: "http://127.0.0.1:8545", VITE_BOOMERANG: B, VITE_USDC: U, VITE_ROUTER: R };
const SALT = `0x${"ab".repeat(32)}` as const;
// A throwaway key, made fresh on each run; it holds nothing anywhere.
const signer = privateKeyToAccount(generatePrivateKey());

const wire = {
  lastSeq: "0",
  missing: null,
  pending: 0,
  repeats: 0,
  lastBlock: 0,
  lastTime: "0",
  sent: 0,
  failedSends: 0,
  rejected: 0,
  gaveUp: [],
  lastErrors: [],
  settled: true,
  desk: null,
};

describe("signed: the one-signature pledge on the page", function () {
  it("config.signedPledge: from the deployment on Arc (VITE_SIGNED_PLEDGE refused there), from VITE_SIGNED_PLEDGE on a local chain, else none", function () {
    assert.equal(configFrom({}, () => ({ boomerang: B, usdc: U, router: R })).signedPledge, null);
    assert.equal(configFrom({}, () => ({ boomerang: B, usdc: U, router: R, signedPledge: H })).signedPledge, H);
    assert.throws(() => configFrom({ VITE_SIGNED_PLEDGE: H }, () => ({ boomerang: B, usdc: U, router: R })), (e) => e instanceof ConfigError && /^VITE_SIGNED_PLEDGE is for a local chain only/.test(e.message));
    assert.equal(configFrom(local).signedPledge, null);
    assert.equal(configFrom({ ...local, VITE_SIGNED_PLEDGE: H }).signedPledge, H);
    assert.throws(() => configFrom({ ...local, VITE_SIGNED_PLEDGE: "0x12" }), ConfigError);
  });

  it("health.relay: the keeper names its relay's helper, or null; a keeper that says nothing has none", function () {
    assert.equal(readHealth(wire).relay, null);
    assert.equal(readHealth({ ...wire, relay: null }).relay, null);
    assert.equal(readHealth({ ...wire, relay: H }).relay, H);
    assert.throws(() => readHealth({ ...wire, relay: "nope" }));
  });

  it("flows.authorization: the typed data pays only the helper, binds the campaign and amount, and its window has begun and ends within ten minutes or at the close", async function () {
    const now = 1_800_000_000n;
    const a = authorization({ chainId: 31337, usdc: U, helper: H, backer: signer.address, id: 7n, amount: 2_500_000n, now, closesAt: now + 3_600n, salt: SALT });
    assert.deepEqual(a.typed.domain, { name: "USDC", version: "2", chainId: 31337, verifyingContract: U });
    assert.equal(a.typed.message.to, H);
    assert.equal(a.typed.message.from, signer.address);
    assert.equal(a.typed.message.value, 2_500_000n);
    assert.equal(a.nonce, nonceFor(7n, 2_500_000n, SALT));
    assert.equal(a.typed.message.nonce, a.nonce);
    assert.ok(a.validAfter < now);
    assert.equal(a.validBefore, now + SIGNED.window);
    // A campaign closing sooner ends the window at its close.
    assert.equal(authorization({ chainId: 31337, usdc: U, helper: H, backer: signer.address, id: 7n, amount: 1n, now, closesAt: now + 120n, salt: SALT }).validBefore, now + 120n);
    // What the wallet signs is what the keeper recovers from the body.
    const signature = await signer.signTypedData(a.typed);
    const body = relayBody({ id: 7n, backer: signer.address, amount: 2_500_000n, validAfter: a.validAfter, validBefore: a.validBefore, salt: SALT, signature });
    assert.deepEqual(Object.keys(body).sort(), ["amount", "backer", "id", "salt", "signature", "validAfter", "validBefore"]);
    for (const v of Object.values(body)) assert.equal(typeof v, "string");
    assert.match(newSalt(), /^0x[0-9a-f]{64}$/);
    assert.notEqual(newSalt(), newSalt());
    const back = await recoverTypedDataAddress({ ...a.typed, signature: body.signature as `0x${string}` });
    assert.equal(back, signer.address);
  });

  it("page.relayFallback: one signature only when the helper is deployed and the keeper relays through that same helper, and not after a fallback; each refusal reads as a sentence that offers the two-step pledge", function () {
    assert.equal(pledgeRoute({ signedPledge: H, relay: H, fellBack: false }), "signed");
    assert.equal(pledgeRoute({ signedPledge: H, relay: H.toUpperCase().replace("0X", "0x") as `0x${string}`, fellBack: false }), "signed");
    assert.equal(pledgeRoute({ signedPledge: H, relay: H, fellBack: true }), "two-step");
    assert.equal(pledgeRoute({ signedPledge: null, relay: H, fellBack: false }), "two-step");
    assert.equal(pledgeRoute({ signedPledge: H, relay: null, fellBack: false }), "two-step");
    assert.equal(pledgeRoute({ signedPledge: H, relay: B, fellBack: false }), "two-step");
    // Refused before anything was sent: the two-step pledge is offered at once.
    const before = ["bad-request", "bad-signature", "window", "cap", "refused", "keeper-low", "busy", "unavailable", "no-relay"];
    for (const r of before) {
      assert.equal(relayRefusedBeforeSending(r), true, r);
      assert.match(relayLine(r), /Nothing was taken\. Press Pledge again to pledge in two steps\.$/, r);
    }
    assert.equal(new Set(before.map(relayLine)).size, before.length);
    // No answer, "failed" or a reason this page does not know: a transaction may be on its way, so the signature is waited out.
    // "pending": another signature of this backer's is on its way, so it is waited out too.
    for (const r of [null, "failed", "pending", "something-new"]) {
      assert.equal(relayRefusedBeforeSending(r), false, String(r));
      assert.match(relayLine(r), /may still go through for up to three minutes/, String(r));
      assert.doesNotMatch(relayLine(r), /Nothing was taken/, String(r));
    }
    assert.match(relayLine(null), /did not answer/);
    assert.equal(relayLine("something-new"), relayLine("failed"));
    assert.match(relayLine("pending"), /already sending/);
    assert.match(stillValidLine(45n), /about a minute/);
    assert.match(stillValidLine(150n), /about 3 minutes/);
    assert.equal(SIGNED.window, 180n);
  });

  it("flows.outstanding: a signature that may still land is remembered per chain and backer, across page loads, until it is dropped", function () {
    const backing = new Map<string, string>();
    const storage = { getItem: (k: string) => backing.get(k) ?? null, setItem: (k: string, v: string) => void backing.set(k, v) };
    const a = outstandingStore(storage);
    const N1 = `0x${"11".repeat(32)}` as const;
    const N2 = `0x${"22".repeat(32)}` as const;
    a.add(31337, signer.address, { id: 3n, nonce: N1, until: 1_000n });
    a.add(31337, signer.address, { id: 4n, nonce: N2, until: 2_000n });
    // A second page (a reload, another tab) sees both.
    const b = outstandingStore(storage);
    assert.deepEqual(b.list(31337, signer.address.toLowerCase() as `0x${string}`), [{ id: 3n, nonce: N1, until: 1_000n }, { id: 4n, nonce: N2, until: 2_000n }]);
    assert.deepEqual(b.list(1, signer.address), []);
    b.drop(31337, signer.address, N1);
    assert.deepEqual(b.list(31337, signer.address).map((o) => o.id), [4n]);
    // The page that sent a signature keeps it until it drops it itself, whatever happens to storage
    // (another tab writing an older list back, or storage cleared): at worst, one more chain read.
    assert.deepEqual(a.list(31337, signer.address).map((o) => o.id).sort(), [3n, 4n]);
    backing.clear();
    assert.deepEqual(a.list(31337, signer.address).map((o) => o.id).sort(), [3n, 4n]);
    a.drop(31337, signer.address, N1);
    a.drop(31337, signer.address, N2);
    // Junk in storage is ignored, not trusted; storage that throws falls back to this page's memory.
    backing.set(`boomerang:signed:31337:${signer.address.toLowerCase()}`, '[{"id":"x"},{"id":"5","nonce":"0x12","until":"9"}, 7]');
    assert.deepEqual(a.list(31337, signer.address), []);
    const broken = outstandingStore({ getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    broken.add(31337, signer.address, { id: 3n, nonce: N1, until: 5n });
    assert.deepEqual(broken.list(31337, signer.address), [{ id: 3n, nonce: N1, until: 5n }]);
    // Storage that reads but will not write (full, or a private window): this page still remembers,
    // and a drop that storage refuses still counts on this page.
    const frozen = new Map<string, string>();
    const readOnly = outstandingStore({ getItem: (k: string) => frozen.get(k) ?? null, setItem: () => { throw new Error("quota"); } });
    readOnly.add(31337, signer.address, { id: 3n, nonce: N1, until: 5n });
    assert.deepEqual(readOnly.list(31337, signer.address), [{ id: 3n, nonce: N1, until: 5n }]);
    frozen.set(`boomerang:signed:31337:${signer.address.toLowerCase()}`, JSON.stringify([{ id: "4", nonce: N2, until: "9" }]));
    assert.deepEqual(readOnly.list(31337, signer.address).map((o) => o.id).sort(), [3n, 4n]);
    readOnly.drop(31337, signer.address, N2);
    assert.deepEqual(readOnly.list(31337, signer.address).map((o) => o.id), [3n]);
    const none = outstandingStore(null);
    none.add(31337, signer.address, { id: 3n, nonce: N1, until: 5n });
    assert.equal(none.list(31337, signer.address).length, 1);
  });

  it("flows.signedWait: before any pledge to a campaign, a remembered signature for it still in its window is waited out; one past its window is to be checked", function () {
    const N1 = `0x${"11".repeat(32)}` as const;
    const N2 = `0x${"22".repeat(32)}` as const;
    const list = [{ id: 3n, nonce: N1, until: 1_000n }, { id: 3n, nonce: N2, until: 1_100n }, { id: 4n, nonce: N2, until: 5_000n }];
    assert.deepEqual(signedWait(list, 3n, 900n), { left: 201n, expired: [] });
    assert.deepEqual(signedWait(list, 3n, 1_050n), { left: 51n, expired: [list[0]] });
    assert.deepEqual(signedWait(list, 3n, 1_100n), { left: 1n, expired: [list[0]] });
    assert.deepEqual(signedWait(list, 3n, 1_101n), { left: null, expired: [list[0], list[1]] });
    assert.deepEqual(signedWait(list, 9n, 0n), { left: null, expired: [] });
  });

  it("ask.relay: posts the body, reads a hash, a refusal's reason, or no answer", async function () {
    const seen: { url: string; body?: string; method: string }[] = [];
    const answering = (status: number, json: unknown): Fetch => async (url, init) => {
      seen.push({ url, body: init.body, method: init.method });
      return { status, json: async () => json };
    };
    const hash = `0x${"12".repeat(32)}`;
    assert.deepEqual(await askRelay({ url: "http://127.0.0.1:8787", fetch: answering(200, { ok: true, hash }), body: { id: "1" } }), { ok: true, hash });
    assert.equal(seen[0].url, "http://127.0.0.1:8787/relay");
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].body, JSON.stringify({ id: "1" }));
    assert.deepEqual(await askRelay({ url: "http://k", fetch: answering(409, { ok: false, reason: "cap" }), body: {} }), { ok: false, reason: "cap" });
    assert.deepEqual(await askRelay({ url: "http://k", fetch: answering(200, { ok: true, hash: "0x12" }), body: {} }), { ok: false, reason: null });
    assert.deepEqual(await askRelay({ url: "http://k", fetch: async () => { throw new Error("down"); }, body: {} }), { ok: false, reason: null });
    assert.deepEqual(await askRelay({ url: null, fetch: answering(200, {}), body: {} }), { ok: false, reason: "no-relay" });
  });

  it("devWallet.typedData: the local test wallet signs typed data for its own account only", async function () {
    const calls: string[] = [];
    const fetch: RpcFetch = async (_url, init) => {
      calls.push(JSON.parse(init.body).method);
      return { json: async () => ({ result: "0xsig" }) };
    };
    const w = devWallet({ name: "Local", address: signer.address, chainId: 31337, rpcUrl: "http://127.0.0.1:8545", fetch });
    assert.equal(await w.provider.request({ method: "eth_signTypedData_v4", params: [signer.address.toLowerCase(), "{}"] }), "0xsig");
    await assert.rejects(w.provider.request({ method: "eth_signTypedData_v4", params: [B, "{}"] }), /own account/);
    for (const method of ["eth_sign", "personal_sign", "eth_signTransaction", "eth_signTypedData", "eth_signTypedData_v3"]) {
      await assert.rejects(w.provider.request({ method, params: [signer.address, "0x00"] }), /does not do that/, method);
    }
    assert.deepEqual(calls, ["eth_signTypedData_v4"]);
  });
});
