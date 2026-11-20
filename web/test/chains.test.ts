// The table of source chains: well-formed, and not confused with Arc.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { getAddress } from "viem";

import { ARC_DOMAIN, arcTestnet } from "../../packages/kit/src/index.ts";
import { SOURCE_CHAINS, sourceChain } from "../src/flows/chains.ts";

describe("source chains", function () {
  it("each has a checksummed token and messenger, its own chain id and its own domain, none of them Arc's", function () {
    assert.ok(SOURCE_CHAINS.length >= 2);
    const ids = new Set<number>();
    const domains = new Set<number>();
    for (const s of SOURCE_CHAINS) {
      assert.equal(getAddress(s.usdc), s.usdc, `${s.label} token is not a checksummed address`);
      assert.equal(getAddress(s.messenger), s.messenger, `${s.label} messenger is not a checksummed address`);
      assert.notEqual(s.chain.id, arcTestnet.id);
      assert.notEqual(s.domain, ARC_DOMAIN);
      assert.equal(s.chain.testnet, true, `${s.label} is not marked as a testnet`);
      ids.add(s.chain.id);
      domains.add(s.domain);
    }
    assert.equal(ids.size, SOURCE_CHAINS.length);
    assert.equal(domains.size, SOURCE_CHAINS.length);
  });

  it("is looked up by chain id; Arc itself is not a source", function () {
    assert.equal(sourceChain(11155111)?.label, "Ethereum Sepolia");
    assert.equal(sourceChain(84532)?.domain, 6);
    assert.equal(sourceChain(arcTestnet.id), undefined);
  });

  it("names the same token messenger the kit records for Arc", function () {
    const file = JSON.parse(readFileSync(new URL("../../packages/kit/addresses.json", import.meta.url), "utf8")) as Record<string, { messenger: string }>;
    const arc = file[String(arcTestnet.id)];
    for (const s of SOURCE_CHAINS) assert.equal(s.messenger.toLowerCase(), arc.messenger.toLowerCase());
  });
});
