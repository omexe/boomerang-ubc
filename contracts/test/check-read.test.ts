// Every amount, address and time in these tests is invented. None is a reading of any real campaign.
//
// How the ledger check reads the contract's logs: at the blocks someone names (never trusted, and
// proven complete by the contract's own count of its events), or every block when nobody names
// any, at a pace a public node accepts, waiting out a refusal. Real contracts on Hardhat's
// in-memory chain; the explorer and the clock are stand-ins.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { Abi, Address, PublicClient } from "viem";

import { explorerBlocks, hintRanges, ledgerCheck } from "../../scripts/lib/check.ts";
import { setup, USD } from "./helpers.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BoomerangArtifact: any = JSON.parse(readFileSync(new URL("../artifacts/contracts/Boomerang.sol/Boomerang.json", import.meta.url), "utf8"));
const abi = BoomerangArtifact.abi as Abi;

type Range = { from: bigint; to: bigint };

// A missed, finalized, partly paid campaign whose events sit in at least four blocks, with idle
// blocks before, between and after them.
async function world() {
  const w = await setup();
  const { id, t } = await w.open();
  await w.pledge(id, w.alice, 30n * USD, t.opensAt + 10n);
  await w.pledge(id, w.bob, 20n * USD, t.opensAt + 20n);
  await w.time.increaseTo(t.closesAt);
  await w.boomerang.write.finalize([id], { account: w.stranger.account });
  await w.boomerang.write.pay([id, w.alice.account.address], { account: w.stranger.account });
  await w.time.increase(60);
  const logs = await w.publicClient.getLogs({ address: w.boomerang.address, fromBlock: 0n });
  const blocks = [...new Set(logs.map((l) => l.blockNumber!))].sort((a, b) => (a < b ? -1 : 1));
  assert.ok(blocks.length >= 4, "the events sit in at least four blocks");
  const head = await w.publicClient.getBlockNumber();
  assert.ok(head > blocks[blocks.length - 1], "there are idle blocks after the newest event");
  return { w, blocks, head, boomerang: w.boomerang.address as Address };
}

// The real client, with every log request and block request written down, and a way to stand in
// for the node's answers.
function spy(
  real: PublicClient,
  over: { getLogs?: (a: { fromBlock: bigint; toBlock: bigint }) => Promise<unknown>; readContract?: (a: { functionName: string }) => Promise<unknown> } = {},
) {
  const asked: Range[] = [];
  let blockAsks = 0;
  const client = {
    ...real,
    getLogs: async (a: { fromBlock: bigint; toBlock: bigint }) => {
      asked.push({ from: a.fromBlock, to: a.toBlock });
      return over.getLogs ? over.getLogs(a) : real.getLogs(a as never);
    },
    getBlock: async (a: never) => {
      blockAsks++;
      return real.getBlock(a);
    },
    readContract: async (a: { functionName: string }) => (over.readContract ? over.readContract(a) : real.readContract(a as never)),
  } as unknown as PublicClient;
  return { client, asked, blockAsks: () => blockAsks };
}

const named = (blocks: readonly bigint[]) => ({ from: "the explorer", blocks: async () => blocks });
const rateLimit = () => Object.assign(new Error("Request exceeds defined limit."), { code: -32005, details: "rate limit exceeded" });

describe("hintRanges", function () {
  it("read.ranges: named blocks are sorted, de-duplicated, kept inside the bounds and joined when one request can cover them", function () {
    assert.deepEqual(hintRanges([5n, 3n, 5n, 100n, 104n, 9999n, 1n], 2n, 200n, 10n), [
      { from: 3n, to: 5n },
      { from: 100n, to: 104n },
    ]);
    // Ten blocks is the most one request covers: 10..19 is one request, 10..20 is two.
    assert.deepEqual(hintRanges([10n, 19n], 0n, 50n, 10n), [{ from: 10n, to: 19n }]);
    assert.deepEqual(hintRanges([10n, 20n], 0n, 50n, 10n), [
      { from: 10n, to: 10n },
      { from: 20n, to: 20n },
    ]);
    assert.deepEqual(hintRanges([7n, 8n], 0n, 50n, 1n), [
      { from: 7n, to: 7n },
      { from: 8n, to: 8n },
    ]);
    assert.deepEqual(hintRanges([], 0n, 50n, 10n), []);
    assert.deepEqual(hintRanges([60n], 0n, 50n, 10n), []);
  });
});

describe("ledgerCheck, reading where it is pointed", function () {
  it("read.hinted: with every event's block named, only those blocks are asked for and the row passes, saying how it read", async function () {
    const { w, blocks, head, boomerang } = await world();
    const s = spy(w.publicClient);
    const row = await ledgerCheck(s.client, boomerang, abi, 0n, head, 2n, undefined, { hints: named(blocks) });
    assert.ok(row.ok, row.detail);
    const want = hintRanges(blocks, 0n, head, 2n);
    assert.deepEqual(s.asked, want);
    assert.ok(want.length < Number(head / 2n) + 1, "fewer requests than reading every block");
    assert.match(row.detail, /match the contract at block \d+/);
    assert.match(row.detail, /named by the explorer/);
    assert.match(row.detail, /none is missing/);
  });

  it("read.hinted.tail: with the newest event's block not named, the blocks after the last named one are read too", async function () {
    const { w, blocks, head, boomerang } = await world();
    const s = spy(w.publicClient);
    const short = blocks.slice(0, -1);
    const row = await ledgerCheck(s.client, boomerang, abi, 0n, head, 3n, undefined, { hints: named(short) });
    assert.ok(row.ok, row.detail);
    const first = hintRanges(short, 0n, head, 3n);
    assert.deepEqual(s.asked.slice(0, first.length), first);
    const tail = s.asked.slice(first.length);
    assert.ok(tail.length > 0, "the tail was read");
    assert.equal(tail[0].from, short[short.length - 1] + 1n);
    assert.equal(tail[tail.length - 1].to, head);
    assert.ok(s.asked.every((r) => r.from >= short[0]), "nothing before the first named block was asked for");
    assert.match(row.detail, /every block after them/);
  });

  it("read.hinted.hole: with a middle event's block not named, every block is read and the row still passes", async function () {
    const { w, blocks, head, boomerang } = await world();
    const s = spy(w.publicClient);
    const holed = [blocks[0], ...blocks.slice(2)];
    const row = await ledgerCheck(s.client, boomerang, abi, 0n, head, 4n, undefined, { hints: named(holed) });
    assert.ok(row.ok, row.detail);
    const full = s.asked.slice(hintRanges(holed, 0n, head, 4n).length);
    assert.equal(full[0].from, 0n);
    assert.equal(full[full.length - 1].to, head);
    assert.match(row.detail, /every block from 0 was read/);
    assert.doesNotMatch(row.detail, /named by/);
  });

  it("read.hinted.none: a source that fails, names nothing, or names blocks outside the range leaves the full read, never past the newest block", async function () {
    const { w, head, boomerang } = await world();
    const sources = [
      { from: "the explorer", blocks: async () => Promise.reject(new Error("the explorer is down")) },
      named([]),
      named([head + 5n, head + 9000n]),
    ];
    for (const hints of sources) {
      const s = spy(w.publicClient);
      const row = await ledgerCheck(s.client, boomerang, abi, 0n, head, 5n, undefined, { hints });
      assert.ok(row.ok, row.detail);
      assert.equal(s.asked[0].from, 0n);
      assert.ok(s.asked.every((r) => r.to <= head));
      assert.match(row.detail, /every block from 0 was read/);
    }
  });

  it("read.hinted.liar: naming blocks cannot make the row pass when the contract counts one more event than the logs hold", async function () {
    const { w, blocks, head, boomerang } = await world();
    const s = spy(w.publicClient, {
      readContract: async (a) => {
        const real = await w.publicClient.readContract(a as never);
        return a.functionName === "eventCount" ? (real as bigint) + 1n : real;
      },
    });
    const row = await ledgerCheck(s.client, boomerang, abi, 0n, head, 5n, undefined, { hints: named(blocks) });
    assert.equal(row.ok, false);
    assert.match(row.detail, /eventCount/);
    // It did not stop at the named blocks: it went on to read everything before failing.
    assert.equal(s.asked[s.asked.length - 1].to, head);
    assert.ok(s.asked.some((r) => r.from === 0n));
  });

  it("read.unhinted: with nobody naming blocks the row reads every block, as before", async function () {
    const { w, head, boomerang } = await world();
    const s = spy(w.publicClient);
    const row = await ledgerCheck(s.client, boomerang, abi, 0n, head, 5n);
    assert.ok(row.ok, row.detail);
    assert.equal(s.asked.length, Number(head / 5n) + 1);
    assert.match(row.detail, /every block from 0 was read/);
  });
});

describe("ledgerCheck, at the node's pace", function () {
  it("read.paced: it waits the gap between two log requests and not before the first", async function () {
    const { w, head, boomerang } = await world();
    const s = spy(w.publicClient);
    const waits: number[] = [];
    const row = await ledgerCheck(s.client, boomerang, abi, 0n, head, 5n, undefined, { gapMs: 350, wait: async (ms) => void waits.push(ms) });
    assert.ok(row.ok, row.detail);
    assert.ok(s.asked.length >= 2);
    assert.deepEqual(waits, Array(s.asked.length - 1).fill(350));
  });

  it("read.refused: a request the node refuses for its rate limit is asked again after 1, 2, 4... seconds, and the row passes", async function () {
    const { w, head, boomerang } = await world();
    let refusals = 2;
    const s = spy(w.publicClient, {
      getLogs: async (a) => {
        if (refusals > 0) {
          refusals--;
          throw rateLimit();
        }
        return w.publicClient.getLogs(a as never);
      },
    });
    const waits: number[] = [];
    const row = await ledgerCheck(s.client, boomerang, abi, 0n, head, 1_000n, undefined, { wait: async (ms) => void waits.push(ms) });
    assert.ok(row.ok, row.detail);
    assert.deepEqual(waits, [1000, 2000]);
    assert.equal(s.asked.length, 3);
    assert.deepEqual(s.asked[0], s.asked[2]);
  });

  it("read.refused.http: a refusal that arrives as HTTP 429 inside another error is waited out the same way", async function () {
    const { w, head, boomerang } = await world();
    let refusals = 1;
    const s = spy(w.publicClient, {
      getLogs: async (a) => {
        if (refusals > 0) {
          refusals--;
          throw new Error("HTTP request failed.", { cause: Object.assign(new Error("Too Many Requests"), { status: 429 }) });
        }
        return w.publicClient.getLogs(a as never);
      },
    });
    const waits: number[] = [];
    const row = await ledgerCheck(s.client, boomerang, abi, 0n, head, 1_000n, undefined, { wait: async (ms) => void waits.push(ms) });
    assert.ok(row.ok, row.detail);
    assert.deepEqual(waits, [1000]);
  });

  it("read.refused.shapes: a bare code -32005, a bare JSON-RPC 429 and a bare HTTP 429 are each a refusal; -32005 about the size of the answer is not", async function () {
    const { w, head, boomerang } = await world();
    const refusals: unknown[] = [
      Object.assign(new Error("limit"), { code: -32005 }),
      Object.assign(new Error("limit"), { code: 429 }),
      new Error("HTTP request failed.", { cause: Object.assign(new Error("failed"), { status: 429 }) }),
    ];
    for (const refusal of refusals) {
      let left = 1;
      const s = spy(w.publicClient, {
        getLogs: async (a) => {
          if (left-- > 0) throw refusal;
          return w.publicClient.getLogs(a as never);
        },
      });
      const waits: number[] = [];
      const row = await ledgerCheck(s.client, boomerang, abi, 0n, head, 1_000n, undefined, { wait: async (ms) => void waits.push(ms) });
      assert.ok(row.ok, row.detail);
      assert.deepEqual(waits, [1000]);
    }
    for (const message of ["query returned more than 10000 results", "requested range too large", "block range exceeds the limit"]) {
      const s = spy(w.publicClient, {
        getLogs: async () => {
          throw Object.assign(new Error(message), { code: -32005 });
        },
      });
      const waits: number[] = [];
      await assert.rejects(ledgerCheck(s.client, boomerang, abi, 0n, head, 1_000n, undefined, { wait: async (ms) => void waits.push(ms) }));
      assert.deepEqual(waits, [], message);
      assert.equal(s.asked.length, 1, message);
    }
  });

  it("read.paced.stages: the pace carries from the named blocks into the blocks after them", async function () {
    const { w, blocks, head, boomerang } = await world();
    const s = spy(w.publicClient);
    const waits: number[] = [];
    const row = await ledgerCheck(s.client, boomerang, abi, 0n, head, 3n, undefined, { hints: named(blocks.slice(0, -1)), gapMs: 350, wait: async (ms) => void waits.push(ms) });
    assert.ok(row.ok, row.detail);
    assert.match(row.detail, /every block after them/);
    assert.deepEqual(waits, Array(s.asked.length - 1).fill(350));
  });

  it("read.refused.long: refused for over a minute, it stops and says the node's rate limit is why", async function () {
    const { w, head, boomerang } = await world();
    const s = spy(w.publicClient, {
      getLogs: async () => {
        throw rateLimit();
      },
    });
    const waits: number[] = [];
    await assert.rejects(
      ledgerCheck(s.client, boomerang, abi, 0n, head, 1_000n, undefined, { wait: async (ms) => void waits.push(ms) }),
      /refused the log requests for over a minute \(its rate limit\)/,
    );
    assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 32000]);
    assert.equal(s.asked.length, 7);
  });

  it("read.refused.other: any other error is not asked again", async function () {
    const { w, head, boomerang } = await world();
    const s = spy(w.publicClient, {
      getLogs: async () => {
        throw new Error("the node refused: requested range too large");
      },
    });
    const waits: number[] = [];
    await assert.rejects(ledgerCheck(s.client, boomerang, abi, 0n, head, 1_000n, undefined, { wait: async (ms) => void waits.push(ms) }), /range too large/);
    assert.deepEqual(waits, []);
    assert.equal(s.asked.length, 1);
  });

  it("read.ownTime: a log that carries its block's time is not asked about; one that does not costs one block request per block", async function () {
    const { w, blocks, head, boomerang } = await world();
    const times = new Map<bigint, bigint>();
    for (const b of blocks) times.set(b, (await w.publicClient.getBlock({ blockNumber: b })).timestamp);

    const carrying = spy(w.publicClient, {
      getLogs: async (a) => {
        const logs = (await w.publicClient.getLogs(a as never)) as { blockNumber: bigint }[];
        return logs.map((l) => ({ ...l, blockTimestamp: `0x${times.get(l.blockNumber)!.toString(16)}` }));
      },
    });
    const row = await ledgerCheck(carrying.client, boomerang, abi, 0n, head, 1_000n);
    assert.ok(row.ok, row.detail);
    assert.equal(carrying.blockAsks(), 0);

    const bare = spy(w.publicClient, {
      getLogs: async (a) => {
        const logs = (await w.publicClient.getLogs(a as never)) as Record<string, unknown>[];
        return logs.map((l) => {
          const { blockTimestamp: _dropped, ...rest } = l;
          return rest;
        });
      },
    });
    const row2 = await ledgerCheck(bare.client, boomerang, abi, 0n, head, 1_000n);
    assert.ok(row2.ok, row2.detail);
    assert.equal(bare.blockAsks(), blocks.length);
  });
});

describe("explorerBlocks", function () {
  const EXPLORER = "https://explorer.example";
  const CONTRACT = "0x00000000000000000000000000000000000000b0" as Address;
  const page = (items: unknown, next: unknown = null) => ({ status: 200, json: async () => ({ items, next_page_params: next }) });

  it("explorer.one: one page of logs gives its block numbers, whether written as digits or as numbers, and nothing else", async function () {
    const urls: string[] = [];
    const got = await explorerBlocks(EXPLORER, CONTRACT, async (url) => {
      urls.push(url);
      return page([{ block_number: "72649778", data: "0xdead" }, { block_number: 72642894 }, { block_number: "72649778" }]);
    });
    assert.deepEqual(urls, [`${EXPLORER}/api/v2/addresses/${CONTRACT}/logs`]);
    assert.deepEqual(got, [72649778n, 72642894n, 72649778n]);
  });

  it("explorer.pages: it follows the explorer's own next-page values until there are none", async function () {
    const urls: string[] = [];
    const answers = [page([{ block_number: "30" }], { block_number: 30, index: 2, items_count: 50 }), page([{ block_number: "20" }], { block_number: 20, index: 0, items_count: 100 }), page([{ block_number: "10" }])];
    const got = await explorerBlocks(EXPLORER, CONTRACT, async (url) => {
      urls.push(url);
      return answers[urls.length - 1];
    });
    assert.deepEqual(got, [30n, 20n, 10n]);
    assert.equal(urls[1], `${EXPLORER}/api/v2/addresses/${CONTRACT}/logs?block_number=30&index=2&items_count=50`);
    assert.equal(urls[2], `${EXPLORER}/api/v2/addresses/${CONTRACT}/logs?block_number=20&index=0&items_count=100`);
  });

  it("explorer.odd: an answer it cannot read, a refusal, or pages without end is a failure, and the answer's own words are never repeated", async function () {
    const bad: { status: number; json(): Promise<unknown> }[] = [
      { status: 500, json: async () => ({}) },
      { status: 200, json: async () => "<script>alert(1)</script>" },
      { status: 200, json: async () => ({ items: "nope" }) },
      page([{ block_number: "12abc" }]),
      page([{ block_number: -4 }]),
      page([{ block_number: "1".repeat(30) }]),
      page([{ block_number: "5" }], { evil: { nested: true } }),
      { status: 200, json: async () => Promise.reject(new Error("<b>not json</b>")) },
    ];
    for (const answer of bad) {
      await assert.rejects(
        explorerBlocks(EXPLORER, CONTRACT, async () => answer),
        (e: Error) => !/script|nope|12abc|not json|evil/.test(e.message),
      );
    }
    let calls = 0;
    await assert.rejects(
      explorerBlocks(
        EXPLORER,
        CONTRACT,
        async () => {
          calls++;
          return page([{ block_number: "5" }], { block_number: 5, index: calls });
        },
        3,
      ),
      /more pages/,
    );
    assert.equal(calls, 3);
  });
});
