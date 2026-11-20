// Where the app points. Every address and URL here is invented.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { configFrom, ConfigError } from "../src/app/config.ts";

const B = "0x00000000000000000000000000000000000000b0";
const U = "0x3600000000000000000000000000000000000000";
const R = "0x00000000000000000000000000000000000000c0";
const D = "0x00000000000000000000000000000000000000d5";
const deployed = () => ({ boomerang: B, usdc: U, router: R }) as const;
const deployedWithDesk = () => ({ boomerang: B, usdc: U, router: R, desk: D }) as const;
const notYet = () => {
  throw new Error("Boomerang is not deployed on chain 5042002 yet");
};
const local = { VITE_CHAIN_ID: "31337", VITE_RPC_URL: "http://127.0.0.1:8545", VITE_BOOMERANG: B, VITE_USDC: U, VITE_ROUTER: R };
const refuses = (env: Record<string, string | undefined>, pattern: RegExp, dep = deployed) =>
  assert.throws(() => configFrom(env, dep), (e) => e instanceof ConfigError && pattern.test(e.message), JSON.stringify(env));

describe("the app's configuration", function () {
  it("with nothing set it is Arc Testnet, with the addresses from the deployed file and no keeper", function () {
    assert.deepEqual(configFrom({}, deployed), {
      chain: { id: 5042002, name: "Arc Testnet", rpcUrl: "https://rpc.testnet.arc.io", explorer: "https://explorer.testnet.arc.io", local: false },
      boomerang: B,
      usdc: U,
      router: R,
      desk: null,
      signedPledge: null,
      keeperUrl: null,
      deployBlock: 0n,
    });
    assert.equal(configFrom({ VITE_KEEPER_URL: "https://keeper.example.org/" }, deployed).keeperUrl, "https://keeper.example.org");
    assert.equal(configFrom({ VITE_CHAIN_ID: "5042002", VITE_KEEPER_URL: "https://keeper.example.org/base//" }, deployed).keeperUrl, "https://keeper.example.org/base");
  });

  it("config.refuses: on Arc a build variable cannot replace an address or the RPC, and no deployment stops the app", function () {
    for (const name of ["VITE_BOOMERANG", "VITE_USDC", "VITE_ROUTER"]) refuses({ [name]: B }, new RegExp(`^${name} is for a local chain only`));
    refuses({ VITE_RPC_URL: "https://rpc.example.org" }, /^VITE_RPC_URL is for a local chain only/);
    refuses({}, /not deployed on chain 5042002 yet/, notYet);
  });

  it("config.refuses: a keeper URL must be https, with no credentials, query or fragment", function () {
    refuses({ VITE_KEEPER_URL: "http://keeper.example.org" }, /^VITE_KEEPER_URL must be https/);
    refuses({ VITE_KEEPER_URL: "javascript:alert(1)" }, /^VITE_KEEPER_URL must be https/);
    refuses({ VITE_KEEPER_URL: "https://user:pw@keeper.example.org" }, /^VITE_KEEPER_URL must not carry a user name/);
    refuses({ VITE_KEEPER_URL: "https://keeper.example.org/?token=1" }, /^VITE_KEEPER_URL must not carry a query/);
    refuses({ VITE_KEEPER_URL: "not a url" }, /^VITE_KEEPER_URL is not a URL/);
  });

  it("a local chain takes everything from the variables and only from this machine", function () {
    assert.deepEqual(configFrom({ ...local, VITE_KEEPER_URL: "http://localhost:8787" }, notYet), {
      chain: { id: 31337, name: "Local chain 31337", rpcUrl: "http://127.0.0.1:8545", explorer: null, local: true },
      boomerang: B,
      usdc: U,
      router: R,
      desk: null,
      signedPledge: null,
      keeperUrl: "http://localhost:8787",
      deployBlock: 0n,
    });
    refuses({ ...local, VITE_RPC_URL: undefined }, /^VITE_RPC_URL is needed/);
    refuses({ ...local, VITE_RPC_URL: "https://rpc.example.org" }, /^VITE_RPC_URL must be on this machine/);
    refuses({ ...local, VITE_RPC_URL: "http://127.0.0.1.example.org:8545" }, /^VITE_RPC_URL must be on this machine/);
    refuses({ ...local, VITE_RPC_URL: "http://localhost@example.org:8545" }, /^VITE_RPC_URL must/);
    refuses({ ...local, VITE_KEEPER_URL: "https://keeper.example.org" }, /^VITE_KEEPER_URL must be on this machine/);
    refuses({ ...local, VITE_BOOMERANG: undefined }, /^VITE_BOOMERANG must be an address/);
    refuses({ ...local, VITE_ROUTER: "0x123" }, /^VITE_ROUTER must be an address/);
    refuses({ ...local, VITE_USDC: `${U}00` }, /^VITE_USDC must be an address/);
  });

  it("config.refuses: a chain id that is not a whole number", function () {
    for (const bad of ["0", "-1", "1e3", "0x7a69", "31337 ", "abc"]) refuses({ ...local, VITE_CHAIN_ID: bad }, /^VITE_CHAIN_ID must be a whole number/);
  });

  it("config.desk: the demo desk comes from the deployment on Arc and from a variable on a local chain, never from the keeper", function () {
    // On Arc the desk is the deployment's; a deployment with none leaves it null.
    assert.equal(configFrom({}, deployedWithDesk).desk, D);
    assert.equal(configFrom({}, deployed).desk, null);
    // The keeper's URL does not set the desk; only the deployment does.
    assert.equal(configFrom({ VITE_KEEPER_URL: "https://keeper.example.org" }, deployedWithDesk).desk, D);
    // A build variable cannot set the desk on Arc, like the other local-only variables.
    refuses({ VITE_DESK_ADDRESS: D }, /^VITE_DESK_ADDRESS is for a local chain only/);
    // On a local chain the desk is the optional variable, validated as an address, null when absent.
    assert.equal(configFrom({ ...local }, notYet).desk, null);
    assert.equal(configFrom({ ...local, VITE_DESK_ADDRESS: D }, notYet).desk, D);
    refuses({ ...local, VITE_DESK_ADDRESS: "0x123" }, /^VITE_DESK_ADDRESS must be an address/, notYet);
  });

  it("config.refuses: a keeper URL with a bare query or fragment at the end", function () {
    for (const bad of ["https://keeper.example.org/?", "https://keeper.example.org/#", "https://keeper.example.org?", "https://keeper.example.org#frag"]) {
      refuses({ VITE_KEEPER_URL: bad }, /^VITE_KEEPER_URL must not carry a query or a fragment/);
    }
  });
});
