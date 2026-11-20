// The one-at-a-time line every transaction from the keeper's account waits in.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeQueue } from "../src/chain.ts";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the send queue", function () {
  it("runs jobs one at a time, in the order they were given", async function () {
    const queue = makeQueue();
    const log: string[] = [];
    const job = (name: string, ms: number) => async () => {
      log.push(`${name} starts`);
      await pause(ms);
      log.push(`${name} ends`);
      return name;
    };
    const results = await Promise.all([queue(job("a", 20)), queue(job("b", 1)), queue(job("c", 5))]);
    assert.deepEqual(results, ["a", "b", "c"]);
    assert.deepEqual(log, ["a starts", "a ends", "b starts", "b ends", "c starts", "c ends"]);
  });

  it("a job that throws rejects its own caller and the line moves on", async function () {
    const queue = makeQueue();
    const bad = queue(async () => {
      throw new Error("no");
    });
    const good = queue(async () => "yes");
    await assert.rejects(bad, /no/);
    assert.equal(await good, "yes");
  });
});
