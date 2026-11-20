// Every event, address and amount in these tests is invented. None is a reading of any campaign.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { decode, encode, memoryStore, openStore, type Store } from "../src/store.ts";
import type { Address, BoomerangEvent, Terms } from "../../../packages/kit/src/index.ts";

const A = "0x1111111111111111111111111111111111111111" as Address;
const B = "0x2222222222222222222222222222222222222222" as Address;
const C = "0x3333333333333333333333333333333333333333" as Address;
const D = "0x4444444444444444444444444444444444444444" as Address;

const terms: Terms = {
  recipient: A,
  opensAt: 1000n,
  earlyUntil: 2000n,
  closesAt: 3000n,
  target: 100_000_000n,
  minPledge: 1_000_000n,
  matchAmount: 20_000_000n,
  bonusPool: 10_000_000n,
  rateBps: 500,
  linearWeight: false,
  bonusFromRecipient: false,
};

// One of each of the nine event types, seqs 1..9, built by hand.
const nine: BoomerangEvent[] = [
  { name: "CampaignCreated", seq: 1n, id: 1n, time: 1000n, sponsor: A, terms },
  { name: "PotFunded", seq: 2n, id: 1n, bonus: false, from: A, amount: 20_000_000n },
  { name: "Pledged", seq: 3n, id: 1n, time: 1500n, backer: B, payer: B, amount: 5_000_000n, weight: 1_000_000n },
  { name: "Rescued", seq: 4n, id: 1n, amount: 3_000_000n },
  { name: "Finalized", seq: 5n, id: 1n, outcome: 2, bonusPaid: 1_000_000n },
  { name: "Paid", seq: 6n, id: 1n, backer: B, to: B, principal: 5_000_000n, bonus: 250_000n },
  { name: "PayFailed", seq: 7n, id: 1n, backer: C, to: C, amount: 4_000_000n },
  { name: "SidePaid", seq: 8n, id: 1n, side: 1, to: A, amount: 20_000_000n },
  { name: "Redirected", seq: 9n, id: 1n, backer: C, to: D },
];

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "keeper-"));
}

describe("keeper store", function () {
  it("round-trips nested bigints through encode/decode", function () {
    const value = { a: 1n, b: { c: [2n, 3n, { d: 4_000_000_000_000n }] }, e: "x", f: 7, g: true, h: null };
    assert.deepEqual(decode(encode(value)), value);
  });

  it("stores and loads one of each of the nine event types, deep-equal", function () {
    const store = openStore(freshDir());
    store.append(nine);
    assert.deepEqual(store.load(), nine);
  });

  it("keeps order across two appends", function () {
    const store = openStore(freshDir());
    store.append(nine.slice(0, 5));
    store.append(nine.slice(5));
    assert.deepEqual(store.load(), nine);
  });

  it("drops a last line cut off mid-JSON and keeps the good lines", function () {
    const dir = freshDir();
    const store = openStore(dir);
    store.append(nine.slice(0, 3));
    appendFileSync(join(dir, "events.jsonl"), encode(nine[3]).slice(0, 10)); // a partial line, no newline
    assert.deepEqual(store.load(), nine.slice(0, 3));
  });

  it("after a write cut off mid-line, a reopened store keeps the next event on a line of its own", function () {
    const dir = freshDir();
    openStore(dir).append(nine.slice(0, 3));
    appendFileSync(join(dir, "events.jsonl"), encode(nine[3]).slice(0, 10)); // the crash
    const again = openStore(dir);
    again.append(nine.slice(3, 5)); // the node reader delivers the cut-off event again, and the next
    assert.deepEqual(again.load(), nine.slice(0, 5));
    assert.deepEqual(openStore(dir).load(), nine.slice(0, 5));
  });

  it("round-trips notes and rejects bad note names", function () {
    const store = openStore(freshDir());
    assert.equal(store.readNote("demo-given"), undefined);
    store.writeNote("demo-given", [A, B]);
    assert.deepEqual(store.readNote("demo-given"), [A, B]);
    assert.throws(() => store.readNote("Bad_Name"));
    assert.throws(() => store.writeNote("has/slash", {}));
    assert.throws(() => store.writeNote("UPPER", {}));
  });

  it("the in-memory store behaves the same", function () {
    const run = (store: Store) => {
      store.append(nine.slice(0, 4));
      store.append(nine.slice(4));
      assert.deepEqual(store.load(), nine);
      store.writeNote("demo-given", [C]);
      assert.deepEqual(store.readNote("demo-given"), [C]);
      assert.throws(() => store.writeNote("no_good", {}));
    };
    run(memoryStore());
    run(openStore(freshDir()));
  });
});
