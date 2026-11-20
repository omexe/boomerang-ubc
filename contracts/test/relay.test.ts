// Every amount and account in these tests is invented. None is a reading of any real campaign.
// The keeper's relay against the contracts: it submits a backer's one signature through
// SignedPledge and pays the gas, and refuses before spending anything when it should.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeAbiParameters, keccak256, toHex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { createRelay, RELAY } from "../../services/keeper/src/relay.ts";
import { USD, setup } from "./helpers.ts";

type Hex = `0x${string}`;

async function world() {
  const w = await setup();
  const helper = await w.viem.deployContract("SignedPledge", [w.usdc.address, w.boomerang.address]);
  const chainId = await w.publicClient.getChainId();
  // The keeper's account is erin's; it holds test USDC above its floor.
  await w.usdc.write.mint([w.erin.account.address, 100n * USD]);
  let clock = 0n;
  const make = (over: { walletClient?: typeof w.erin; queue?: <T>(job: () => Promise<T>) => Promise<T>; publicClient?: PublicClient; perMinute?: number } = {}) =>
    createRelay({ publicClient: over.publicClient ?? (w.publicClient as unknown as PublicClient), walletClient: over.walletClient ?? w.erin, signedPledge: helper.address, usdc: w.usdc.address, timer: () => clock, floor: 3n * USD, queue: over.queue, perMinute: over.perMinute });
  let salt = 0n;
  type Signer = { account: { address: Hex }; signTypedData: typeof w.alice.signTypedData };
  async function body(who: Signer, o: { id: bigint; amount: bigint; validAfter?: bigint; validBefore?: bigint; backer?: Hex; sendId?: bigint }) {
    const now = BigInt(await w.time.latest());
    const s = toHex(++salt, { size: 32 });
    const validAfter = o.validAfter ?? now - 1n;
    const validBefore = o.validBefore ?? now + 600n;
    const nonce = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "bytes32" }], [o.id, o.amount, s]));
    const signature = await (who.signTypedData as (a: unknown) => Promise<Hex>)({
      domain: { name: "USDC", version: "2", chainId, verifyingContract: w.usdc.address },
      types: {
        ReceiveWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "ReceiveWithAuthorization",
      message: { from: who.account.address, to: helper.address, value: o.amount, validAfter, validBefore, nonce },
    });
    return {
      id: String(o.sendId ?? o.id),
      backer: o.backer ?? who.account.address,
      amount: String(o.amount),
      validAfter: String(validAfter),
      validBefore: String(validBefore),
      salt: s,
      signature,
    };
  }
  const sent = () => w.publicClient.getTransactionCount({ address: w.erin.account.address });
  // A key made on the spot, holding nothing: what a griefer can make by the thousand.
  const stranger = (): Signer => {
    const a = privateKeyToAccount(generatePrivateKey());
    return { account: { address: a.address }, signTypedData: ((x: Parameters<typeof a.signTypedData>[0]) => a.signTypedData(x)) as unknown as Signer["signTypedData"] };
  };
  return { w, helper, make, body, sent, stranger, tick: (s: bigint) => (clock += s) };
}

describe("relay: the keeper submits a backer's one signature", async function () {
  it("relay.sends: a good request is simulated, sent once, and pledges in the backer's name; the same body again is refused", async function () {
    const { w, make, body, sent } = await world();
    const relay = make();
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt + 5n);
    await w.usdc.write.mint([w.alice.account.address, 10n * USD]);
    const b = await body(w.alice, { id, amount: 10n * USD });
    const before = await sent();
    const r = await relay.relay(b);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal((await w.boomerang.read.backerOf([id, w.alice.account.address])).principal, 10n * USD);
    assert.equal(await sent(), before + 1);
    const again = await relay.relay(b);
    assert.equal(again.ok === false && again.reason, "refused");
    assert.equal(await sent(), before + 1);
  });

  it("relay.refuses: malformed, wrong signer, altered campaign, long or closed window, a refused pledge: nothing is sent", async function () {
    const { w, make, body, sent } = await world();
    const relay = make();
    const { id, t } = await w.open();
    const later = await w.open();
    await w.usdc.write.mint([w.alice.account.address, 10n * USD]);
    // Before opening: the pledge would be refused, so it is never sent.
    const early = await body(w.alice, { id, amount: 10n * USD });
    const before = await sent();
    const reason = async (x: unknown) => {
      const r = await relay.relay(x);
      return r.ok ? "ok" : r.reason;
    };
    assert.equal(await reason(early), "refused");
    await w.time.increaseTo(t.opensAt + 5n);
    for (const bad of [null, "x", {}, { ...early, id: "-1" }, { ...early, amount: "0" }, { ...early, backer: "0x12" }, { ...early, salt: "0x01" }, { ...early, signature: "0xzz" }, { ...early, validBefore: "1e9" }]) {
      assert.equal(await reason(bad), "bad-request", JSON.stringify(bad));
    }
    // Alice's signature offered as Bob's, or moved to another campaign or amount.
    assert.equal(await reason({ ...early, backer: w.bob.account.address }), "bad-signature");
    assert.equal(await reason({ ...early, id: String(later.id) }), "bad-signature");
    assert.equal(await reason({ ...early, amount: String(5n * USD) }), "bad-signature");
    // A window longer than the relay takes, one already over, one not begun.
    const now = BigInt(await w.time.latest());
    assert.equal(await reason(await body(w.alice, { id, amount: 10n * USD, validBefore: now + RELAY.maxWindow + 60n })), "window");
    assert.equal(await reason(await body(w.alice, { id, amount: 10n * USD, validAfter: now - 100n, validBefore: now - 1n })), "window");
    assert.equal(await reason(await body(w.alice, { id, amount: 10n * USD, validAfter: now + 100n, validBefore: now + 500n })), "window");
    assert.equal(await sent(), before);
    assert.equal((await w.boomerang.read.backerOf([id, w.alice.account.address])).principal, 0n);
  });

  it("relay.cap: one request per backer at a time, and at most five sends per backer per hour", async function () {
    const { w, make, body, sent, tick } = await world();
    const relay = make();
    const { id, t } = await w.open({ target: 1_000n * USD });
    await w.time.increaseTo(t.opensAt + 5n);
    await w.usdc.write.mint([w.alice.account.address, 100n * USD]);
    const first = await body(w.alice, { id, amount: 1n * USD });
    const second = await body(w.alice, { id, amount: 1n * USD });
    const [a, b] = await Promise.all([relay.relay(first), relay.relay(second)]);
    assert.deepEqual([a.ok, b.ok === false && b.reason].sort(), [true, "pending"].sort() as unknown[]);
    for (let i = 0; i < RELAY.perHour - 1; i++) assert.equal((await relay.relay(await body(w.alice, { id, amount: 1n * USD }))).ok, true);
    const before = await sent();
    const over = await relay.relay(await body(w.alice, { id, amount: 1n * USD }));
    assert.equal(over.ok === false && over.reason, "cap");
    assert.equal(await sent(), before);
    // Another backer is not held back by Alice's cap.
    await w.usdc.write.mint([w.bob.account.address, 1n * USD]);
    assert.equal((await relay.relay(await body(w.bob, { id, amount: 1n * USD }))).ok, true);
    // An hour later, on the keeper's own clock, Alice may ask again.
    tick(3_601n);
    assert.equal((await relay.relay(await body(w.alice, { id, amount: 1n * USD }))).ok, true);
  });

  it("relay.floor: a keeper below its floor sends nothing", async function () {
    const { w, make, body, sent } = await world();
    await w.usdc.write.mint([w.dave.account.address, 3n * USD - 1n]);
    const poor = make({ walletClient: w.dave });
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt + 5n);
    await w.usdc.write.mint([w.alice.account.address, 10n * USD]);
    const before = await w.publicClient.getTransactionCount({ address: w.dave.account.address });
    const r = await poor.relay(await body(w.alice, { id, amount: 10n * USD }));
    assert.equal(r.ok === false && r.reason, "keeper-low");
    assert.equal(await w.publicClient.getTransactionCount({ address: w.dave.account.address }), before);
    void sent;
  });

  it("relay.line: signatures from empty accounts are refused without ever taking a place in the keeper's send line", async function () {
    const { w, make, body, sent, stranger } = await world();
    let jobs = 0;
    const relay = make({ queue: async (job) => { jobs += 1; return job(); } });
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt + 5n);
    const before = await sent();
    const answers = await Promise.all(Array.from({ length: 12 }, async () => relay.relay(await body(stranger(), { id, amount: 10n * USD }))));
    for (const r of answers) assert.equal(r.ok === false && r.reason, "refused");
    assert.equal(jobs, 0);
    assert.equal(await sent(), before);
  });

  it("relay.rate: across all backers, only so many requests a minute reach the chain; the rest are turned away unsent", async function () {
    const { w, make, body, stranger, tick } = await world();
    let reads = 0;
    const counting = new Proxy(w.publicClient as unknown as PublicClient, { get: (o, k) => (k === "getBlock" ? (...a: unknown[]) => { reads += 1; return (o.getBlock as (...x: unknown[]) => unknown)(...a); } : (o as unknown as Record<string | symbol, unknown>)[k]) });
    const relay = make({ publicClient: counting, perMinute: 3 });
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt + 5n);
    const reasons: unknown[] = [];
    for (let i = 0; i < 4; i++) reasons.push((await relay.relay(await body(stranger(), { id, amount: 1n * USD }))) as unknown);
    assert.deepEqual(reasons.map((r) => (r as { reason?: string }).reason), ["refused", "refused", "refused", "busy"]);
    assert.equal(reads, 3);
    tick(61n);
    assert.equal(((await relay.relay(await body(stranger(), { id, amount: 1n * USD }))) as { reason?: string }).reason, "refused");
  });

  it("relay.unavailable: a chain that cannot be read before anything is sent answers unavailable, never failed", async function () {
    const { w, make, body, sent } = await world();
    const broken = new Proxy(w.publicClient as unknown as PublicClient, { get: (o, k) => (k === "getBlock" ? () => Promise.reject(new Error("node down")) : (o as unknown as Record<string | symbol, unknown>)[k]) });
    const relay = make({ publicClient: broken });
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt + 5n);
    await w.usdc.write.mint([w.alice.account.address, 10n * USD]);
    const before = await sent();
    const r = await relay.relay(await body(w.alice, { id, amount: 10n * USD }));
    assert.equal(r.ok === false && r.reason, "unavailable");
    assert.equal(await sent(), before);
  });

  it("relay.late: a request that waited in line too long is turned away unsent", async function () {
    const { w, make, body, sent, tick } = await world();
    const slow = make({ queue: async (job) => { tick(11n); return job(); } });
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt + 5n);
    await w.usdc.write.mint([w.alice.account.address, 10n * USD]);
    const before = await sent();
    const r = await slow.relay(await body(w.alice, { id, amount: 10n * USD }));
    assert.equal(r.ok === false && r.reason, "busy");
    assert.equal(await sent(), before);
  });
});
