// Every token, key and address in these tests is invented.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { settingsFrom, SettingsError } from "../src/settings.ts";
import type { Address } from "../../../packages/kit/src/index.ts";

const B = "0x00000000000000000000000000000000000000b0" as Address;
const U = "0x3600000000000000000000000000000000000000" as Address;
const R = "0x00000000000000000000000000000000000000c0";
const deployed = () => ({ boomerang: B, usdc: U, deployBlock: 72n });
const none = () => {
  throw new Error("not deployed");
};
const base = {};

describe("the keeper's settings", function () {
  it("settings.noToken: the keeper needs no security token, and its settings carry no secret", function () {
    const s = settingsFrom({}, deployed);
    assert.equal("secret" in s, false);
    // An env var the keeper does not read changes nothing.
    assert.deepEqual(settingsFrom({ UNRELATED_VAR: "ignored" }, deployed), s);
  });

  it("settings.arc: with nothing set, the keeper watches Arc Testnet at the deployed addresses", function () {
    const s = settingsFrom(base, deployed);
    assert.equal(s.chain.id, 5042002);
    assert.equal(s.local, false);
    assert.equal(s.rpcUrl, "https://rpc.testnet.arc.io");
    assert.deepEqual([s.boomerang, s.usdc, s.port, s.dataDir, s.key, s.demoRecipient], [B, U, 8787, "./data", null, null]);
    // It listens on this machine only until HOST names another address.
    assert.equal(s.host, "127.0.0.1");
    assert.equal(settingsFrom({ ...base, HOST: "0.0.0.0" }, deployed).host, "0.0.0.0");
    assert.equal(settingsFrom({ ...base, HOST: "::1" }, deployed).host, "::1");
    // Each can be set; an empty value is the same as none.
    const set = settingsFrom({ ...base, RPC_URL: "https://example.quiknode.pro/abc/", PORT: "9000", KEEPER_DATA: "/var/keeper", KEEPER_PRIVATE_KEY: "0xkey", DEMO_RECIPIENT: R, CHAIN_ID: "5042002", USDC_ADDRESS: "" }, deployed);
    assert.deepEqual([set.rpcUrl, set.port, set.dataDir, set.key, set.demoRecipient, set.local, set.usdc], ["https://example.quiknode.pro/abc/", 9000, "/var/keeper", "0xkey", R, false, U]);
  });

  it("settings.follow: the keeper reads the node unless told not to, from the block the kit's contract was created in", function () {
    const withBlock = () => ({ boomerang: B, usdc: U, deployBlock: 72n });
    const s = settingsFrom(base, withBlock);
    assert.deepEqual([s.followNode, s.deployBlock], [true, 72n]);
    assert.equal(settingsFrom({ ...base, FOLLOW_NODE: "on" }, withBlock).followNode, true);
    assert.equal(settingsFrom({ ...base, FOLLOW_NODE: "off" }, withBlock).followNode, false);
    assert.equal(settingsFrom({ ...base, FOLLOW_NODE: "" }, withBlock).followNode, true);
    assert.throws(() => settingsFrom({ ...base, FOLLOW_NODE: "maybe" }, withBlock), (e) => e instanceof SettingsError && /^FOLLOW_NODE must be on or off$/.test(e.message));
    // The kit's own address written another way is still the kit's contract.
    assert.equal(settingsFrom({ ...base, BOOMERANG_ADDRESS: B.toUpperCase().replace("0X", "0x") }, withBlock).deployBlock, 72n);
    // A block given by hand is used, on any chain.
    assert.equal(settingsFrom({ ...base, DEPLOY_BLOCK: "500" }, withBlock).deployBlock, 500n);
    assert.throws(() => settingsFrom({ ...base, DEPLOY_BLOCK: "0x1f4" }, withBlock), (e) => e instanceof SettingsError && /^DEPLOY_BLOCK is not a block number$/.test(e.message));
    // On Arc a read from block 0 would never end. Another contract, or a kit with no block recorded,
    // must say where its events start, or leave the node alone.
    const noBlock = () => ({ boomerang: B, usdc: U });
    const needs = (e: unknown) => e instanceof SettingsError && /^DEPLOY_BLOCK is required to read the node for this contract$/.test(e.message);
    assert.throws(() => settingsFrom({ ...base, BOOMERANG_ADDRESS: R }, withBlock), needs);
    assert.throws(() => settingsFrom(base, noBlock), needs);
    assert.equal(settingsFrom({ ...base, BOOMERANG_ADDRESS: R, DEPLOY_BLOCK: "90" }, withBlock).deployBlock, 90n);
    assert.deepEqual([settingsFrom({ ...base, FOLLOW_NODE: "off" }, noBlock).followNode, settingsFrom({ ...base, FOLLOW_NODE: "off" }, noBlock).deployBlock], [false, 0n]);
    // A local chain is short: it starts from block 0.
    assert.equal(settingsFrom({ ...base, CHAIN_ID: "31337", RPC_URL: "http://127.0.0.1:8545", BOOMERANG_ADDRESS: B, USDC_ADDRESS: U }, withBlock).deployBlock, 0n);
  });

  it("settings.refuses: each wrong value stops the keeper with that value's name, and no value's text", function () {
    const cases: [Record<string, string>, RegExp][] = [
      [{ BOOMERANG_ADDRESS: "0x12" }, /^BOOMERANG_ADDRESS is not an address$/],
      [{ USDC_ADDRESS: "usdc" }, /^USDC_ADDRESS is not an address$/],
      [{ DEMO_RECIPIENT: "me" }, /^DEMO_RECIPIENT is not an address$/],
      [{ PORT: "0" }, /^PORT is not a port number$/],
      [{ PORT: "70000" }, /^PORT is not a port number$/],
      [{ PORT: "80a" }, /^PORT is not a port number$/],
      [{ HOST: "keeper.example secret-part" }, /^HOST is not an IP address$/],
      [{ CHAIN_ID: "arc" }, /^CHAIN_ID is not a chain id$/],
      [{ CHAIN_ID: "-1" }, /^CHAIN_ID is not a chain id$/],
      [{ RPC_URL: "not a url secret-part" }, /^RPC_URL is not a URL$/],
      [{ RPC_URL: "http://rpc.example/secret-part" }, /^RPC_URL must be https/],
      [{ RPC_URL: "ftp://127.0.0.1/secret-part" }, /^RPC_URL must be https/],
    ];
    for (const [over, want] of cases) {
      assert.throws(
        () => settingsFrom({ ...base, ...over }, deployed),
        (e: unknown) => e instanceof SettingsError && want.test(e.message) && !e.message.includes("secret-part"),
        JSON.stringify(over),
      );
    }
    // Before a deployment there is no address to fall back on.
    assert.throws(() => settingsFrom(base, none), /Boomerang is not deployed yet/);
    assert.throws(() => settingsFrom({ ...base, BOOMERANG_ADDRESS: B }, none), /USDC_ADDRESS is not known/);
    assert.equal(settingsFrom({ ...base, BOOMERANG_ADDRESS: B, USDC_ADDRESS: U, DEPLOY_BLOCK: "5" }, none).boomerang, B);
  });

  it("settings.signedPledge: the relay's helper comes from SIGNED_PLEDGE_ADDRESS, else from the deployment on Arc, else none", function () {
    const H = "0x00000000000000000000000000000000000000d0";
    assert.equal(settingsFrom(base, deployed).signedPledge, null);
    assert.equal(settingsFrom(base, () => ({ boomerang: B, usdc: U, signedPledge: H as Address, deployBlock: 72n })).signedPledge, H);
    assert.equal(settingsFrom({ ...base, SIGNED_PLEDGE_ADDRESS: R }, () => ({ boomerang: B, usdc: U, signedPledge: H as Address, deployBlock: 72n })).signedPledge, R);
    const local = { ...base, CHAIN_ID: "31337", RPC_URL: "http://127.0.0.1:8545", BOOMERANG_ADDRESS: B, USDC_ADDRESS: U };
    assert.equal(settingsFrom(local, () => ({ boomerang: B, usdc: U, signedPledge: H as Address })).signedPledge, null);
    assert.equal(settingsFrom({ ...local, SIGNED_PLEDGE_ADDRESS: H }, deployed).signedPledge, H);
    assert.throws(() => settingsFrom({ ...base, SIGNED_PLEDGE_ADDRESS: "0x12" }, deployed), SettingsError);
  });

  it("settings.local: another chain id is taken only for a node on this machine, with both addresses given", function () {
    const local = { ...base, CHAIN_ID: "31337", RPC_URL: "http://127.0.0.1:8545", BOOMERANG_ADDRESS: B, USDC_ADDRESS: U };
    const s = settingsFrom(local, deployed);
    assert.deepEqual([s.chain.id, s.local, s.rpcUrl, s.boomerang, s.usdc], [31337, true, "http://127.0.0.1:8545", B, U]);
    assert.equal(settingsFrom({ ...local, RPC_URL: "http://localhost:8545" }, deployed).local, true);
    assert.equal(settingsFrom({ ...local, RPC_URL: "http://[::1]:8545" }, deployed).local, true);
    // A local chain id never takes the deployed addresses, and never an RPC somewhere else.
    for (const [over, want] of [
      [{ RPC_URL: "https://rpc.testnet.arc.io" }, /RPC_URL must be on this machine/],
      [{ RPC_URL: "http://127.0.0.1.example.com:8545" }, /RPC_URL must be on this machine/],
      [{ RPC_URL: "http://localhost@rpc.example:8545" }, /RPC_URL must be on this machine/],
      [{ RPC_URL: "http://0.0.0.0:8545" }, /RPC_URL must be on this machine/],
      [{ RPC_URL: "http://192.168.1.10:8545" }, /RPC_URL must be on this machine/],
      [{ RPC_URL: "" }, /RPC_URL is required/],
      [{ BOOMERANG_ADDRESS: "" }, /BOOMERANG_ADDRESS is required/],
      [{ USDC_ADDRESS: "" }, /USDC_ADDRESS is required/],
    ] as const) {
      assert.throws(() => settingsFrom({ ...local, ...over }, deployed), want, JSON.stringify(over));
    }
    // And Arc's own id never takes plain http from another host.
    assert.throws(() => settingsFrom({ ...base, RPC_URL: "http://rpc.example" }, deployed), /must be https/);
    assert.equal(settingsFrom({ ...base, RPC_URL: "http://127.0.0.1:8545" }, deployed).local, false);
  });
});
