// Every amount and account in these tests is invented. None is a reading of any real campaign.
//
// The practice wallet (web/src/wallet/practice.ts) against the real contracts in memory: a key the
// page made pledges through the same two roads as any wallet. The page's own call list, sent by
// the page's own sender; and the page's own authorization, signed by the key and submitted by a
// stranger through SignedPledge, as the keeper does.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createWalletClient, custom, parseEther, parseSignature } from "viem";

import { USD, setup } from "./helpers.ts";
import { pledgeCalls, sendEach } from "../../web/src/flows/calls.ts";
import { authorization } from "../../web/src/flows/signed.ts";
import { practiceWallet, type KeyStore, type Rpc } from "../../web/src/wallet/practice.ts";

type Hex = `0x${string}`;

describe("web practice: a key the page made, pledging for real", async function () {
  const w = await setup();
  const { boomerang, usdc, stranger, publicClient } = w;
  const helper = await w.viem.deployContract("SignedPledge", [usdc.address, boomerang.address]);
  const chain = publicClient.chain;
  const rpc: Rpc = (method, params) => publicClient.request({ method, params } as never) as Promise<unknown>;

  async function fresh() {
    let key: Hex | null = null;
    const store: KeyStore = { get: () => key, set: (k) => void (key = k) };
    const wallet = practiceWallet({ name: "Practice wallet", chain, usdc: usdc.address, store, rpc });
    const [address] = (await wallet.provider.request({ method: "eth_requestAccounts" })) as Hex[];
    const client = createWalletClient({ account: address, chain, transport: custom(wallet.provider) });
    return { wallet, address, client };
  }

  it("practice.twoStep: the page's approve-and-pledge, signed by the practice key, is the practice account's pledge", async function () {
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt + 5n);
    const p = await fresh();
    await usdc.write.mint([p.address, 10n * USD]);
    await stranger.sendTransaction({ to: p.address, value: parseEther("1") }); // gas, which on Arc is the USDC itself

    const calls = pledgeCalls({ boomerang: boomerang.address, usdc: usdc.address, id, amount: 4n * USD, allowance: 0n });
    const hashes = await sendEach({ publicClient, walletClient: p.client, account: p.address, calls });
    assert.equal(hashes.length, 2);
    assert.equal((await boomerang.read.backerOf([id, p.address])).principal, 4n * USD);
    assert.equal(await usdc.read.balanceOf([p.address]), 6n * USD);
    assert.equal(await usdc.read.allowance([p.address, boomerang.address]), 0n);
    // Each transaction was sent by the practice account itself.
    for (const hash of hashes) assert.equal((await publicClient.getTransaction({ hash })).from.toLowerCase(), p.address.toLowerCase());
    await w.assertCustody();
  });

  it("practice.signed: the page's authorization, signed by the practice key, pledges when a stranger submits it; the key holder paid no gas", async function () {
    const { id, t } = await w.open();
    await w.time.increaseTo(t.opensAt + 5n);
    const p = await fresh();
    await usdc.write.mint([p.address, 3n * USD]);
    assert.equal(await publicClient.getBalance({ address: p.address }), 0n, "the practice account holds nothing to pay gas with");

    const now = BigInt(await w.time.latest());
    const salt: Hex = `0x${"5a".repeat(32)}`;
    const a = authorization({ chainId: await publicClient.getChainId(), usdc: usdc.address, helper: helper.address, backer: p.address, id, amount: 3n * USD, now, closesAt: t.closesAt, salt });
    const signature = await p.client.signTypedData({ account: p.address, ...a.typed });
    const { v, r, s } = parseSignature(signature);
    await helper.write.pledgeSigned([id, p.address, 3n * USD, { validAfter: a.validAfter, validBefore: a.validBefore, salt, v: Number(v), r, s }], { account: stranger.account });

    assert.equal((await boomerang.read.backerOf([id, p.address])).principal, 3n * USD);
    assert.equal(await usdc.read.balanceOf([p.address]), 0n);
    assert.equal(await usdc.read.authorizationState([p.address, a.nonce]), true);
    await w.assertCustody();
  });
});
