// Every amount and account in these tests is invented. None is a reading of any real campaign.
//
// The kit's CCTP helpers against the router itself: what the kit says the router will take,
// the router takes, and what the kit says it will refuse, it refuses.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodePacked, pad, toHex } from "viem";

import { USD, refused, setup } from "./helpers.ts";
import { ARC_DOMAIN, asBytes32, burnArgs, checkForRouter, pledgeHook, readBurn } from "../../packages/kit/src/index.ts";

type Address = `0x${string}`;
type Hex = `0x${string}`;
const ZERO32 = pad("0x", { size: 32 });
const ATTESTATION = pad("0x01", { size: 65 });
let nonce = 0n;

/** A CCTP V2 burn message in Circle's layout, built field by field. */
function message(o: {
  recipient: Address;
  mintRecipient: Address;
  amount: bigint;
  hook: Hex;
  fee?: bigint;
  onlyCaller?: Address;
  destinationDomain?: number;
  expirationBlock?: bigint;
}): Hex {
  const body = encodePacked(
    ["uint32", "bytes32", "bytes32", "uint256", "bytes32", "uint256", "uint256", "uint256", "bytes"],
    [1, ZERO32, asBytes32(o.mintRecipient), o.amount, ZERO32, o.amount, o.fee ?? 0n, o.expirationBlock ?? 0n, o.hook],
  );
  return encodePacked(
    ["uint32", "uint32", "uint32", "bytes32", "bytes32", "bytes32", "bytes32", "uint32", "uint32", "bytes"],
    [1, 0, o.destinationDomain ?? ARC_DOMAIN, toHex(++nonce, { size: 32 }), ZERO32, asBytes32(o.recipient), o.onlyCaller ? asBytes32(o.onlyCaller) : ZERO32, 2000, 2000, body],
  );
}

describe("kit: the cross-chain helpers agree with the router", async function () {
  const w = await setup();
  const { boomerang, usdc, alice, bob, stranger } = w;
  const transmitter = await w.viem.deployContract("TestTransmitter");
  const messenger = await w.viem.deployContract("TestMessenger", [usdc.address, transmitter.address]);
  const router = await w.viem.deployContract("PledgeRouter", [usdc.address, boomerang.address, transmitter.address, messenger.address]);
  const here = { router: router.address, messenger: messenger.address };
  const relay = (m: Hex) => router.write.relay([m, ATTESTATION], { account: stranger.account });

  it("burnArgs names the router twice, Arc's domain, and the hook the router decodes", function () {
    const args = burnArgs({ amount: 25n * USD, sourceUsdc: usdc.address, router: router.address, campaignId: 7n, backer: alice.account.address, maxFee: 500n, minFinalityThreshold: 1000 });
    assert.deepEqual(args, [25n * USD, 26, asBytes32(router.address), usdc.address, asBytes32(router.address), 500n, 1000, pledgeHook(7n, alice.account.address)]);
    assert.equal((pledgeHook(7n, alice.account.address).length - 2) / 2, 64);
  });

  it("a message the kit accepts is relayed and pledged, and the kit read its fields right", async function () {
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt + 5n);
    const m = message({ recipient: messenger.address, mintRecipient: router.address, onlyCaller: router.address, amount: 30n * USD, fee: 2_000n, expirationBlock: 99n, hook: pledgeHook(id, alice.account.address) });
    const read = readBurn(m)!;
    assert.deepEqual(
      [read.sourceDomain, read.destinationDomain, read.amount, read.feeExecuted, read.expirationBlock, read.hookData],
      [0, 26, 30n * USD, 2_000n, 99n, pledgeHook(id, alice.account.address)],
    );
    const check = checkForRouter(m, here);
    assert.deepEqual(check, { ok: true, campaignId: id, backer: alice.account.address.toLowerCase(), arrives: 30n * USD - 2_000n });
    await relay(m);
    const b = await boomerang.read.backerOf([id, alice.account.address]);
    assert.equal(b.principal, 30n * USD - 2_000n, "what the kit said would arrive is what was pledged");
  });

  it("each message the kit refuses for a reason the router shares, the router refuses too", async function () {
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt + 5n);
    const good = { recipient: messenger.address, mintRecipient: router.address, onlyCaller: router.address, amount: 5n * USD, hook: pledgeHook(id, bob.account.address) };
    const cases: [string, Hex, string, string][] = [
      ["addressed to another contract", message({ ...good, recipient: stranger.account.address }), "not-for-messenger", "NotABurn"],
      ["minting to someone else", message({ ...good, mintRecipient: stranger.account.address }), "not-for-router", "NotForRouter"],
      ["hook of 32 bytes", message({ ...good, hook: toHex(id, { size: 32 }) }), "bad-hook", "BadHook"],
      ["hook of 96 bytes", message({ ...good, hook: `${pledgeHook(id, bob.account.address)}${"00".repeat(32)}` as Hex }), "bad-hook", "BadHook"],
      ["backer zero", message({ ...good, hook: pledgeHook(id, "0x0000000000000000000000000000000000000000") }), "bad-hook", "BadHook"],
      ["backer is the router", message({ ...good, hook: pledgeHook(id, router.address) }), "bad-hook", "BadHook"],
      ["backer wider than an address", message({ ...good, hook: `${toHex(id, { size: 32 })}${"01".padStart(24, "0")}${bob.account.address.slice(2)}` as Hex }), "bad-hook", "BadHook"],
    ];
    for (const [name, m, why, error] of cases) {
      assert.deepEqual(checkForRouter(m, here), { ok: false, why }, name);
      await refused(relay(m), error);
    }
    assert.deepEqual(checkForRouter("0x1234", here), { ok: false, why: "not-a-burn" });
    assert.deepEqual(checkForRouter("0xzz" as Hex, here), { ok: false, why: "not-a-burn" });
    await refused(relay("0x1234"), "BadHook");
  });

  it("the kit also refuses two things the router cannot see for the sender", function () {
    const base = { recipient: messenger.address, mintRecipient: router.address, amount: 5n * USD, hook: pledgeHook(1n, bob.account.address) };
    // bound for another chain: Circle's transmitter on Arc would refuse it
    assert.deepEqual(checkForRouter(message({ ...base, onlyCaller: router.address, destinationDomain: 6 }), here), { ok: false, why: "not-for-arc" });
    // no allowed caller: anyone could receive the mint around the router (ATTACKS.md, R4)
    assert.deepEqual(checkForRouter(message(base), here), { ok: false, why: "open-to-anyone" });
    assert.deepEqual(checkForRouter(message({ ...base, onlyCaller: stranger.account.address }), here), { ok: false, why: "open-to-anyone" });
  });
});
