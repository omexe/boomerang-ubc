// Every amount and account in these tests is invented. None is a reading of any real campaign.
// The one-signature pledge: a backer signs Circle's EIP-3009 receive authorization once, and
// anyone (the keeper, in the app) submits it through SignedPledge. Run against TestUSDC, which
// signs on the same EIP-712 domain as Arc Testnet's USDC (name "USDC", version "2").
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { keccak256, encodeAbiParameters, parseSignature, toHex } from "viem";

import { USD, refused, setup } from "./helpers.ts";

type Address = `0x${string}`;
type Hex = `0x${string}`;

describe("signed: a pledge from one signature", async function () {
  const w = await setup();
  const { boomerang, usdc, sponsor, alice, bob, stranger, publicClient } = w;
  const helper = await w.viem.deployContract("SignedPledge", [usdc.address, boomerang.address]);
  const chainId = await publicClient.getChainId();
  let saltCounter = 0n;

  const nonceFor = (id: bigint, amount: bigint, salt: Hex) =>
    keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "bytes32" }], [id, amount, salt]));

  /** The backer's one signature: Circle's ReceiveWithAuthorization, payable only to the helper, bound to this campaign and amount. */
  async function sign(who: typeof alice, o: { id: bigint; amount: bigint; validAfter?: bigint; validBefore?: bigint; salt?: Hex }) {
    const now = BigInt(await w.time.latest());
    const salt = o.salt ?? toHex(++saltCounter, { size: 32 });
    const validAfter = o.validAfter ?? now - 1n;
    const validBefore = o.validBefore ?? now + 900n;
    const signature = await who.signTypedData({
      domain: { name: "USDC", version: "2", chainId, verifyingContract: usdc.address },
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
      message: { from: who.account.address, to: helper.address, value: o.amount, validAfter, validBefore, nonce: nonceFor(o.id, o.amount, salt) },
    });
    const { v, r, s } = parseSignature(signature);
    return { backer: who.account.address as Address, amount: o.amount, validAfter, validBefore, salt, v: Number(v), r, s };
  }
  type Signed = Awaited<ReturnType<typeof sign>>;
  const auth = (sg: Signed) => ({ validAfter: sg.validAfter, validBefore: sg.validBefore, salt: sg.salt, v: sg.v, r: sg.r, s: sg.s });
  const submit = (id: bigint, sg: Signed, over: Partial<{ id: bigint; amount: bigint }> = {}) =>
    helper.write.pledgeSigned([over.id ?? id, sg.backer, over.amount ?? sg.amount, auth(sg)], { account: stranger.account });

  it("signed.pledges: a stranger submits the backer's signature; the backer owns the pledge and paid only the pledge", async function () {
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt + 5n);
    await usdc.write.mint([alice.account.address, 30n * USD]);
    const strangerBefore = await w.balance(stranger);
    const sg = await sign(alice, { id, amount: 30n * USD });
    await submit(id, sg);
    assert.equal((await boomerang.read.backerOf([id, alice.account.address])).principal, 30n * USD);
    assert.equal(await w.balance(alice), 0n);
    assert.equal(await w.balance(stranger), strangerBefore);
    assert.equal(await usdc.read.balanceOf([helper.address]), 0n);
    assert.equal(await usdc.read.allowance([helper.address, boomerang.address]), 0n);
    assert.equal(await usdc.read.authorizationState([alice.account.address, nonceFor(id, 30n * USD, sg.salt)]), true);
    await w.assertCustody();
  });

  it("signed.noAllowance: the backer never approved anything; the signature alone is enough", async function () {
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt + 5n);
    await usdc.write.mint([bob.account.address, 5n * USD]);
    assert.equal(await usdc.read.allowance([bob.account.address, boomerang.address]), 0n);
    assert.equal(await usdc.read.allowance([bob.account.address, helper.address]), 0n);
    await submit(id, await sign(bob, { id, amount: 5n * USD }));
    assert.equal((await boomerang.read.backerOf([id, bob.account.address])).principal, 5n * USD);
  });

  it("signed.bound: the signature works for its own campaign and amount only", async function () {
    const a = await w.open();
    const b = await w.open();
    await w.time.increaseTo(b.t.opensAt + 5n);
    await usdc.write.mint([alice.account.address, 20n * USD]);
    const sg = await sign(alice, { id: a.id, amount: 10n * USD });
    await assert.rejects(submit(a.id, sg, { id: b.id }), /invalid signature/);
    await assert.rejects(submit(a.id, sg, { amount: 20n * USD }), /invalid signature/);
    // Another backer's address with this signature is no one's authorization either.
    await assert.rejects(helper.write.pledgeSigned([a.id, bob.account.address, sg.amount, auth(sg)], { account: stranger.account }), /invalid signature/);
    assert.equal(await w.balance(alice), 20n * USD);
    assert.equal((await boomerang.read.backerOf([b.id, alice.account.address])).principal, 0n);
    await submit(a.id, sg);
    assert.equal((await boomerang.read.backerOf([a.id, alice.account.address])).principal, 10n * USD);
  });

  it("signed.window: a used, expired or not-yet-valid signature moves nothing", async function () {
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt + 5n);
    await usdc.write.mint([alice.account.address, 30n * USD]);
    const start = await w.balance(alice);
    const used = await sign(alice, { id, amount: 10n * USD });
    await submit(id, used);
    await assert.rejects(submit(id, used), /authorization is used/);
    const now = BigInt(await w.time.latest());
    const expired = await sign(alice, { id, amount: 10n * USD, validAfter: now - 100n, validBefore: now + 2n });
    await w.time.increaseTo(now + 10n);
    await assert.rejects(submit(id, expired), /authorization is expired/);
    const later = await sign(alice, { id, amount: 10n * USD, validAfter: now + 1_000n, validBefore: now + 1_900n });
    await assert.rejects(submit(id, later), /authorization is not yet valid/);
    assert.equal(await w.balance(alice), start - 10n * USD);
  });

  it("signed.edges: valid strictly after validAfter and strictly before validBefore; a high-s twin of a good signature is refused as Circle's USDC refuses it", async function () {
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt + 5n);
    await usdc.write.mint([alice.account.address, 30n * USD]);
    const start = await w.balance(alice);
    const now = BigInt(await w.time.latest());
    const atStart = await sign(alice, { id, amount: 10n * USD, validAfter: now + 10n, validBefore: now + 500n });
    await w.time.setNextBlockTimestamp(now + 10n);
    await assert.rejects(submit(id, atStart), /authorization is not yet valid/);
    const atEnd = await sign(alice, { id, amount: 10n * USD, validAfter: now, validBefore: now + 20n });
    await w.time.setNextBlockTimestamp(now + 20n);
    await assert.rejects(submit(id, atEnd), /authorization is expired/);
    const good = await sign(alice, { id, amount: 10n * USD });
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const twin = { ...good, s: toHex(N - BigInt(good.s), { size: 32 }), v: good.v === 27 ? 28 : 27 };
    await assert.rejects(submit(id, twin), /invalid signature 's' value/);
    assert.equal(await w.balance(alice), start);
    await submit(id, good);
    assert.equal(await w.balance(alice), start - 10n * USD);
  });

  it("signed.refused: a pledge the campaign refuses reverts everything; the money stays and the signature is still unused", async function () {
    const { id, t } = await w.open({ minPledge: 10n * USD });
    await usdc.write.mint([alice.account.address, 10n * USD]);
    const start = await w.balance(alice);
    const early = await sign(alice, { id, amount: 10n * USD, validBefore: t.opensAt + 900n });
    await refused(submit(id, early), "NotOpenYet");
    assert.equal(await w.balance(alice), start);
    assert.equal(await usdc.read.authorizationState([alice.account.address, nonceFor(id, 10n * USD, early.salt)]), false);
    await w.time.increaseTo(t.opensAt + 5n);
    await refused(submit(id, await sign(alice, { id, amount: 5n * USD })), "BelowMinimum");
    await usdc.write.mint([sponsor.account.address, 10n * USD]);
    await refused(submit(id, await sign(sponsor, { id, amount: 10n * USD })), "SponsorCannotPledge");
    // Once the campaign takes pledges, the same unused signature goes through.
    assert.equal(await w.balance(alice), start);
    await submit(id, early);
    assert.equal((await boomerang.read.backerOf([id, alice.account.address])).principal, 10n * USD);
    assert.equal(await w.balance(alice), start - 10n * USD);
  });

  it("signed.rest: a pledge larger than what is left takes the gap and sends the rest back to the backer", async function () {
    const { id, t } = await w.open({ target: 50n * USD });
    await w.pledge(id, bob, 40n * USD, t.opensAt + 5n);
    await usdc.write.mint([alice.account.address, 25n * USD]);
    const start = await w.balance(alice);
    await submit(id, await sign(alice, { id, amount: 25n * USD }));
    assert.equal((await boomerang.read.backerOf([id, alice.account.address])).principal, 10n * USD);
    assert.equal(await w.balance(alice), start - 10n * USD);
    assert.equal(await usdc.read.balanceOf([helper.address]), 0n);
    assert.equal(await usdc.read.allowance([helper.address, boomerang.address]), 0n);
    await w.assertCustody();
  });
});
