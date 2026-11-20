// The landing page's one paragraph about how settlement runs, in each of the three cases.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { settlementLine } from "../src/views/settlement.ts";

describe("the landing page's settlement line", function () {
  it("settlement.line: the three sentences, exact", function () {
    assert.equal(
      settlementLine({ state: "prompt" }),
      "Boomerang is a non-custodial USDC contract. Its source is verified on Arc's explorer, and settlement runs on its own: a keeper with no special rights reads Arc's node and makes the calls anyone could make.",
    );
    assert.equal(
      settlementLine({ state: "behind", heard: 400, blocks: 901 }),
      "Boomerang is a non-custodial USDC contract. Its source is verified on Arc's explorer, and settlement needs no one in particular: anyone can make the calls, from this site or without it. The keeper that usually makes them within seconds is behind the chain right now.",
    );
    assert.equal(
      settlementLine({ state: "down" }),
      "Boomerang is a non-custodial USDC contract. Its source is verified on Arc's explorer, and settlement needs no one in particular: anyone can make the calls, from this site or without it. The keeper that usually makes them within seconds is not answering right now.",
    );
  });
});
