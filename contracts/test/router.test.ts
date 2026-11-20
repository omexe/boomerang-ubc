// Every amount and account in these tests is invented. None is a reading of any real campaign.
// The router against a stand-in for Circle's transmitter. Not yet run against the live one.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeAbiParameters, encodeErrorResult, encodeFunctionData, encodePacked, pad, parseEventLogs, toHex } from "viem";

import { Outcome, USD, refused, setup } from "./helpers.ts";

type Address = `0x${string}`;
const ZERO32 = pad("0x", { size: 32 });
const ATTESTATION = pad("0x01", { size: 65 });
const asBytes32 = (a: Address) => pad(a, { size: 32 });
let nonceCounter = 0n;

/** A CCTP V2 message carrying a V2 burn message, laid out as Circle's MessageV2 and BurnMessageV2 do. */
function message(o: {
  router: Address;
  messenger: Address;
  amount: bigint;
  hook: `0x${string}`;
  fee?: bigint;
  mintRecipient?: Address;
  onlyCaller?: Address;
  nonce?: `0x${string}`;
}) {
  const nonce = o.nonce ?? toHex(++nonceCounter, { size: 32 });
  const body = encodePacked(
    ["uint32", "bytes32", "bytes32", "uint256", "bytes32", "uint256", "uint256", "uint256", "bytes"],
    [1, ZERO32, asBytes32(o.mintRecipient ?? o.router), o.amount, ZERO32, o.amount, o.fee ?? 0n, 0n, o.hook],
  );
  return encodePacked(
    ["uint32", "uint32", "uint32", "bytes32", "bytes32", "bytes32", "bytes32", "uint32", "uint32", "bytes"],
    [1, 0, 26, nonce, ZERO32, asBytes32(o.messenger), o.onlyCaller ? asBytes32(o.onlyCaller) : ZERO32, 2000, 2000, body],
  );
}
const hook = (campaignId: bigint, backer: Address) =>
  encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [campaignId, backer]);

describe("router: a pledge arriving from another chain", async function () {
  const w = await setup();
  const { boomerang, usdc, alice, bob, stranger, publicClient } = w;
  const transmitter = await w.viem.deployContract("TestTransmitter");
  const messenger = await w.viem.deployContract("TestMessenger", [usdc.address, transmitter.address]);
  const router = await w.viem.deployContract("PledgeRouter", [
    usdc.address,
    boomerang.address,
    transmitter.address,
    messenger.address,
  ]);
  /** A burn message for this router through the real messenger, unless a field is overridden. */
  const burn = (o: Omit<Parameters<typeof message>[0], "router" | "messenger"> & { messenger?: Address }) =>
    message({ router: router.address, messenger: messenger.address, ...o });
  const relay = (m: `0x${string}`, gas?: bigint) =>
    router.write.relay([m, ATTESTATION], { account: stranger.account, ...(gas ? { gas } : {}) });
  const held = (who: Address) => usdc.read.balanceOf([who]);

  /** After every relay: the router holds nothing and has left the campaign contract no allowance. */
  async function routerIsEmpty() {
    assert.equal(await held(router.address), 0n);
    assert.equal(await usdc.read.allowance([router.address, boomerang.address]), 0n);
    await w.assertCustody();
  }

  it("the message layout in this file matches the offsets the router reads", function () {
    const m = burn({ amount: 5n, hook: hook(7n, alice.account.address) });
    assert.equal((m.length - 2) / 2, 440); // 148 header + 228 burn fields + 64 hook
    assert.equal(`0x${m.slice(2 + 184 * 2, 2 + 216 * 2)}`, asBytes32(router.address).toLowerCase());
    assert.equal(`0x${m.slice(2 + 376 * 2)}`, hook(7n, alice.account.address));
  });

  it("a relayed mint is pledged for the backer named in the hook data", async function () {
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt);
    const m = burn({ amount: 30n * USD, hook: hook(id, alice.account.address) });
    const { result } = await router.simulate.relay([m, ATTESTATION], { account: stranger.account.address });
    assert.deepEqual(result, [30n * USD, 0n]);
    const before = await held(alice.account.address);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: await relay(m) });
    const [log] = parseEventLogs({ abi: router.abi, logs: receipt.logs, eventName: "Relayed" });
    assert.equal(log.args.campaignId, id);
    assert.equal(log.args.backer.toLowerCase(), alice.account.address.toLowerCase());
    assert.deepEqual([log.args.minted, log.args.pledged, log.args.forwarded], [30n * USD, 30n * USD, 0n]);
    const record = await boomerang.read.backerOf([id, alice.account.address]);
    assert.equal(record.principal, 30n * USD);
    assert.equal(record.paid, false);
    assert.equal(await held(alice.account.address), before); // nothing came to her wallet: it is all pledged
    await routerIsEmpty();
  });

  it("a fee taken by the bridge is already out of what is pledged", async function () {
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt);
    const m = burn({ amount: 30n * USD, fee: 3_000n, hook: hook(id, alice.account.address) });
    await relay(m);
    assert.equal((await boomerang.read.backerOf([id, alice.account.address])).principal, 30n * USD - 3_000n);
    await routerIsEmpty();
  });

  it("router.refused: a pledge the campaign refuses goes whole to the backer's address here", async function () {
    const { id, t } = await w.open();
    const cases: Array<[string, () => Promise<bigint>, bigint]> = [
      ["before it opens", async () => id, 10n * USD],
      ["a campaign that does not exist", async () => 999_999n, 10n * USD],
      ["campaign number zero", async () => 0n, 10n * USD],
      ["below the minimum", async () => (await w.time.increaseTo(t.opensAt), id), USD / 2n],
      ["after it closed", async () => (await w.time.increaseTo(t.closesAt), id), 10n * USD],
    ];
    for (const [name, campaign, amount] of cases) {
      const campaignId = await campaign();
      const before = await held(bob.account.address);
      const pledgedBefore = (await boomerang.read.stateOf([id])).pledged;
      const m = burn({ amount, hook: hook(campaignId, bob.account.address) });
      const { result } = await router.simulate.relay([m, ATTESTATION], { account: stranger.account.address });
      assert.deepEqual(result, [0n, amount], name);
      await relay(m);
      assert.equal((await held(bob.account.address)) - before, amount, name);
      assert.equal((await boomerang.read.stateOf([id])).pledged, pledgedBefore, name);
      await routerIsEmpty();
    }
  });

  it("a pledge larger than the gap: the campaign takes the gap, the rest goes to the backer", async function () {
    const { id, t } = await w.open();
    await w.pledge(id, alice, 90n * USD, t.opensAt + 1n);
    const before = await held(bob.account.address);
    const m = burn({ amount: 30n * USD, hook: hook(id, bob.account.address) });
    const { result } = await router.simulate.relay([m, ATTESTATION], { account: stranger.account.address });
    assert.deepEqual(result, [10n * USD, 20n * USD]);
    await relay(m);
    assert.equal((await boomerang.read.backerOf([id, bob.account.address])).principal, 10n * USD);
    assert.equal((await held(bob.account.address)) - before, 20n * USD);
    assert.equal((await boomerang.read.stateOf([id])).outcome, Outcome.Funded);
    await routerIsEmpty();
  });

  it("the same message cannot be relayed twice", async function () {
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt);
    const m = burn({ amount: 10n * USD, hook: hook(id, alice.account.address) });
    await relay(m);
    await refused(relay(m), "Error", "Nonce already used");
    assert.equal((await boomerang.read.backerOf([id, alice.account.address])).principal, 10n * USD);
    await routerIsEmpty();
  });

  it("a message that mints to someone else, or whose hook data is not a campaign and a backer, is refused unreceived", async function () {
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt);
    const good = hook(id, alice.account.address);
    const nonce = toHex(7_000_001n, { size: 32 });
    const bad: Array<[string, `0x${string}`, string]> = [
      ["addressed to a contract that is not Circle's messenger", burn({ messenger: alice.account.address, amount: USD, hook: good, nonce }), "NotABurn"],
      ["mints to alice", burn({ mintRecipient: alice.account.address, amount: USD, hook: good, nonce }), "NotForRouter"],
      ["no hook data", burn({ amount: USD, hook: "0x", nonce }), "BadHook"],
      ["hook data too long", burn({ amount: USD, hook: `${good}00`, nonce }), "BadHook"],
      ["backer is zero", burn({ amount: USD, hook: hook(id, pad("0x", { size: 20 })), nonce }), "BadHook"],
      ["backer is the router", burn({ amount: USD, hook: hook(id, router.address), nonce }), "BadHook"],
      [
        "backer is not an address",
        burn({ amount: USD, hook: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [id, 1n << 200n]), nonce }),
        "BadHook",
      ],
    ];
    for (const [name, m, error] of bad) {
      await refused(relay(m), error);
      assert.equal(await transmitter.read.usedNonces([nonce]), false, name);
    }
    await routerIsEmpty();
  });

  it("a backer who cannot receive: the relay fails whole and works once they can", async function () {
    const { id, t } = await w.open();
    await w.time.increaseTo(t.closesAt); // the pledge will be refused, so everything must be forwarded
    const nonce = toHex(7_000_002n, { size: 32 });
    const m = burn({ amount: 10n * USD, hook: hook(id, bob.account.address), nonce });
    await usdc.write.setBlocked([bob.account.address, true]);
    await refused(relay(m), "TokenFailed");
    assert.equal(await transmitter.read.usedNonces([nonce]), false);
    await routerIsEmpty();
    await usdc.write.setBlocked([bob.account.address, false]);
    const before = await held(bob.account.address);
    await relay(m);
    assert.equal((await held(bob.account.address)) - before, 10n * USD);
    await routerIsEmpty();
  });

  it("a relayer cannot spoil a good pledge by sending too little gas", async function () {
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt);
    const nonce = toHex(7_000_003n, { size: 32 });
    const m = burn({ amount: 100n * USD, hook: hook(id, alice.account.address), nonce });
    await refused(relay(m, 450_000n), "LowGas");
    assert.equal(await transmitter.read.usedNonces([nonce]), false);
    // with enough gas the same message pledges; this one fills the target, the costliest kind of pledge
    const receipt = await publicClient.waitForTransactionReceipt({ hash: await relay(m) });
    assert.equal((await boomerang.read.stateOf([id])).outcome, Outcome.Funded);
    // the whole relay, pledge included, used less than the gas the router insists on having for the pledge alone
    assert.ok(receipt.gasUsed < (await router.read.PLEDGE_GAS()), `relay used ${receipt.gasUsed}`);
    await routerIsEmpty();
  });

  it("a burn that names the router as the only caller cannot be received around it", async function () {
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt);
    const m = burn({ onlyCaller: router.address, amount: 10n * USD, hook: hook(id, alice.account.address) });
    await refused(transmitter.write.receiveMessage([m, ATTESTATION], { account: stranger.account }), "Error", "Invalid caller for message");
    await relay(m);
    assert.equal((await boomerang.read.backerOf([id, alice.account.address])).principal, 10n * USD);
    await routerIsEmpty();
  });

  it("known limit: a mint received around the router stays in it, and is not handed to the next backer", async function () {
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt);
    const loose = burn({ amount: 5n * USD, hook: hook(id, alice.account.address) });
    await transmitter.write.receiveMessage([loose, ATTESTATION], { account: stranger.account });
    assert.equal(await held(router.address), 5n * USD);
    assert.equal((await boomerang.read.backerOf([id, alice.account.address])).principal, 0n);
    const before = await held(bob.account.address);
    await relay(burn({ amount: 30n * USD, hook: hook(id, bob.account.address) }));
    assert.equal((await boomerang.read.backerOf([id, bob.account.address])).principal, 30n * USD);
    assert.equal(await held(bob.account.address), before);
    assert.equal(await held(router.address), 5n * USD);
    assert.equal(await usdc.read.allowance([router.address, boomerang.address]), 0n);
  });

  it("a thief cannot use a message of their own to capture someone else's pledge", async function () {
    // Circle attests any message anyone sends, to any recipient. The thief sends one addressed
    // to their own contract, shaped like a burn for the router that names the thief as backer.
    // If the router relayed it, the thief's contract would run inside Circle's transmitter and
    // receive alice's waiting burn there, and the router would count her money as the thief's.
    const { id, t } = await w.open();
    await w.time.increaseTo(t.closesAt); // closed, so whatever arrives would be forwarded to the "backer"
    const thief = await w.viem.deployContract("ThiefHandler", [transmitter.address]);
    const alices = burn({ amount: 25n * USD, hook: hook(id, alice.account.address) });
    await thief.write.aim([alices, ATTESTATION]);
    const bait = burn({ messenger: thief.address, amount: 25n * USD, hook: hook(id, stranger.account.address) });
    const before = await held(stranger.account.address);
    const routerBefore = await held(router.address); // the known-limit test above left 5 here on purpose
    await refused(relay(bait), "NotABurn");
    assert.equal(await held(stranger.account.address), before);
    // alice's burn was not touched: relayed properly, the money reaches her
    const aliceBefore = await held(alice.account.address);
    await relay(alices);
    assert.equal((await held(alice.account.address)) - aliceBefore, 25n * USD);
    assert.equal(await held(router.address), routerBefore);
    assert.equal(await usdc.read.allowance([router.address, boomerang.address]), 0n);
  });

  it("the router cannot be built with a missing address", async function () {
    const zero = pad("0x", { size: 20 });
    for (const args of [
      [zero, boomerang.address, transmitter.address, messenger.address],
      [usdc.address, zero, transmitter.address, messenger.address],
      [usdc.address, boomerang.address, zero, messenger.address],
      [usdc.address, boomerang.address, transmitter.address, zero],
    ] as const) {
      await refused(w.viem.deployContract("PledgeRouter", [...args]), "ZeroAddress");
    }
  });
});

describe("router: re-entry", async function () {
  it("a token calling back into relay is refused, and the outer relay still completes", async function () {
    const { viem, networkHelpers } = await network.create();
    const [sp, rp, al, st] = await viem.getWalletClients();
    const token = await viem.deployContract("HostileToken");
    const boom = await viem.deployContract("Boomerang", [token.address]);
    const transmitter = await viem.deployContract("TestTransmitter");
    const messenger = await viem.deployContract("TestMessenger", [token.address, transmitter.address]);
    const router = await viem.deployContract("PledgeRouter", [
      token.address,
      boom.address,
      transmitter.address,
      messenger.address,
    ]);
    const burn = (o: { amount: bigint; hook: `0x${string}` }) =>
      message({ router: router.address, messenger: messenger.address, ...o });
    const now = BigInt(await networkHelpers.time.latest());
    const terms = {
      recipient: rp.account.address,
      opensAt: now + 1_000n,
      earlyUntil: now + 101_000n,
      closesAt: now + 201_000n,
      target: 100n * USD,
      minPledge: 1n * USD,
      matchAmount: 0n,
      bonusPool: 0n,
      rateBps: 0,
      linearWeight: false,
      bonusFromRecipient: false,
    };
    await boom.write.createCampaign([terms], { account: sp.account });
    const id = await boom.read.campaignCount();
    await networkHelpers.time.increaseTo(terms.opensAt);

    const inner = burn({ amount: 7n * USD, hook: hook(id, al.account.address) });
    const outer = burn({ amount: 10n * USD, hook: hook(id, al.account.address) });
    // fire during the pledge's transferFrom, while the outer relay is still running
    await token.write.arm([
      router.address,
      encodeFunctionData({ abi: router.abi, functionName: "relay", args: [inner, ATTESTATION] }),
      false,
      true,
    ]);
    await router.write.relay([outer, ATTESTATION], { account: st.account });
    assert.equal(await token.read.fired(), true);
    assert.equal(await token.read.lastInnerOk(), false);
    assert.equal(await token.read.lastInnerReturn(), encodeErrorResult({ abi: router.abi, errorName: "Reentered" }));
    assert.equal((await boom.read.backerOf([id, al.account.address])).principal, 10n * USD);
    assert.equal(await token.read.balanceOf([router.address]), 0n);
    assert.equal(await token.read.allowance([router.address, boom.address]), 0n);
  });
});
