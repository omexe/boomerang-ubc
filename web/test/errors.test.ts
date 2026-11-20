// The sentences for refusals, held to the two contracts' ABIs. Every address here is invented.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { boomerangAbi, routerAbi } from "../../packages/kit/src/index.ts";
import { explain, SENTENCES, sentenceFor } from "../src/data/errors.ts";

const errorNames = (abi: readonly { type: string; name?: string }[]) => abi.filter((x) => x.type === "error").map((x) => x.name as string);

describe("what went wrong, in words", function () {
  it("web.errors: every error in either ABI has a sentence, and no sentence is for an error neither has", function () {
    const inAbi = new Set([...errorNames(boomerangAbi), ...errorNames(routerAbi)]);
    assert.ok(inAbi.size >= 28, `found ${inAbi.size} error names`);
    for (const name of inAbi) assert.ok(Object.hasOwn(SENTENCES, name), `no sentence for ${name}`);
    for (const name of Object.keys(SENTENCES)) assert.ok(inAbi.has(name), `${name} is in neither ABI`);
  });

  it("each sentence is plain words: it ends a sentence and does not repeat the error's code name", function () {
    for (const [name, sentence] of Object.entries(SENTENCES)) {
      assert.match(sentence, /^[A-Z].*\.$/, name);
      assert.ok(!sentence.includes(name), `${name}'s sentence repeats its code name`);
      assert.ok(sentence.length <= 170, name);
    }
  });

  it("a refused campaign names the term only when it is one the contract uses", function () {
    assert.equal(sentenceFor("BadTerms", ["target"]), "The contract refused these campaign terms: the target.");
    assert.equal(sentenceFor("BadTerms", ["times"]), "The contract refused these campaign terms: the opening, early and closing times.");
    for (const odd of [["<b>x</b>"], ["constructor"], [7], [], undefined]) {
      assert.equal(sentenceFor("BadTerms", odd as readonly unknown[] | undefined), "The contract refused these campaign terms.");
    }
    assert.equal(sentenceFor("Closed"), "This campaign has closed.");
    assert.equal(sentenceFor("toString"), "The contract refused this, without a reason this page knows.");
    assert.equal(sentenceFor("SomethingNew"), "The contract refused this, without a reason this page knows.");
  });

  // An error shaped the way viem shapes one: the decoded refusal sits on a cause, found by walk().
  const viemLike = (data: unknown, shortMessage = "The contract function \"pledge\" reverted.") => {
    const cause = { name: "ContractFunctionRevertedError", data };
    const top = {
      name: "ContractFunctionExecutionError",
      shortMessage,
      cause,
      walk(fn: (x: unknown) => boolean) {
        for (const x of [top, cause]) if (fn(x)) return x;
        return null;
      },
    };
    return top;
  };

  it("a failed send is explained from the contract's refusal, the wallet's no, or the first line of what was said", function () {
    assert.equal(explain(viemLike({ errorName: "BelowMinimum", args: [] })), "That is less than this campaign's smallest pledge.");
    assert.equal(explain(viemLike({ errorName: "BadTerms", args: ["minPledge"] })), "The contract refused these campaign terms: the smallest pledge.");
    assert.equal(explain(viemLike({ errorName: "NeverHeardOfIt" })), "The contract refused this, without a reason this page knows.");
    assert.equal(explain(Object.assign(new Error("User rejected the request."), { code: 4001 })), "You said no in your wallet. Nothing was sent.");
    assert.equal(explain(viemLike(undefined, "insufficient funds for gas * price + value")), "This account has too little USDC to pay the network fee.");
    assert.equal(explain(new Error("fetch failed\n    at node:internal")), "That did not go through. The wallet or the network said: fetch failed");
    assert.equal(explain("x".repeat(500)).length, "That did not go through. The wallet or the network said: ".length + 160);
    assert.equal(explain(null), "That did not go through. The wallet or the network said: null");
  });
});
