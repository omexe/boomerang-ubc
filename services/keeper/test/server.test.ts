// Every secret, address and payload in these tests is invented. None is a reading of any campaign.
import assert from "node:assert/strict";
import { connect, type AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";

import { createServer } from "../src/server.ts";
import type { Delivery, Health, Keeper } from "../src/keeper.ts";
import type { FollowState } from "../src/follow.ts";
import type { Desk, DeskResult } from "../src/demo.ts";
import type { Relay, RelayResult } from "../src/relay.ts";
import { applyEvents, emptyLedger, type Address, type BoomerangEvent, type Terms } from "../../../packages/kit/src/index.ts";

const DESK_ADDR = "0xDe5c0000000000000000000000000000000000De" as Address;

const health: Health = {
  lastSeq: "0",
  missing: null,
  pending: 0,
  repeats: 0,
  lastBlock: 0,
  lastTime: "0",
  sent: 0,
  failedSends: 0,
  rejected: 0,
  gaveUp: [],
  absent: [],
  lastErrors: [],
  settled: true,
};

function fakeKeeper(over: Partial<Keeper> = {}): { keeper: Keeper; calls: Delivery[] } {
  const calls: Delivery[] = [];
  const base: Keeper = {
    ledger: emptyLedger(),
    deliver(d) {
      calls.push(d);
      return { applied: 2, repeats: 1, done: Promise.resolve([]) };
    },
    health: () => health,
    feed: () => [],
  };
  return { keeper: { ...base, ...over }, calls };
}

const fakeDesk: Desk = {
  address: DESK_ADDR,
  giveUsdc: async (to: string): Promise<DeskResult> => {
    if (to === "0xbad") return { ok: false, reason: "bad-address" };
    if (to === "0xdup") return { ok: false, reason: "already-given" };
    return { ok: true, hash: "0xfeed" };
  },
  openCampaign: async (kind = "ten"): Promise<DeskResult> => ({ ok: true, id: kind === "two" ? "8" : "7" }),
};

const fakeRelay: Relay = {
  address: "0x00000000000000000000000000000000000000aa",
  relay: async (body: unknown): Promise<RelayResult> => {
    const id = (body as { id?: unknown } | null)?.id;
    if (id === "1") return { ok: true, hash: "0xbeef" };
    if (id === "2") return { ok: false, reason: "cap" };
    if (id === "3") return { ok: false, reason: "keeper-low" };
    if (id === "4") return { ok: false, reason: "bad-signature" };
    return { ok: false, reason: "bad-request" };
  },
};

type ServerOpts = { keeper: Keeper; desk?: Desk; relay?: Relay; follower?: { state: () => FollowState }; maxHeld?: number; bodyDeadlineMs?: number };

async function withServer<T>(opts: ServerOpts, fn: (url: string) => Promise<T>): Promise<T> {
  const server = createServer({ keeper: opts.keeper, desk: opts.desk, relay: opts.relay, follower: opts.follower, maxHeld: opts.maxHeld, bodyDeadlineMs: opts.bodyDeadlineMs });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("keeper server", function () {
  it("server.gzip: a gzip-compressed JSON body, even correctly labelled, is not unpacked: /relay and /demo/usdc answer 400 and never reach the relay or the desk", async function () {
    const { keeper } = fakeKeeper();
    const deskCalls: string[] = [];
    const relayCalls: unknown[] = [];
    const desk: Desk = { ...fakeDesk, giveUsdc: async (to) => (deskCalls.push(to), { ok: true, hash: "0xfeed" }) };
    const relay: Relay = { ...fakeRelay, relay: async (body) => (relayCalls.push(body), { ok: true, hash: "0xbeef" }) };
    await withServer({ keeper, desk, relay }, async (url) => {
      // Valid JSON before packing; the bytes on the wire are gzip, which the server reads as UTF-8 and cannot parse.
      const packed = gzipSync(Buffer.from(JSON.stringify({ address: "0xok", id: "1" })));
      const headers = { "content-type": "application/json", "content-encoding": "gzip" };
      const usdc = await fetch(url + "/demo/usdc", { method: "POST", headers, body: packed });
      assert.equal(usdc.status, 400);
      const r = await fetch(url + "/relay", { method: "POST", headers, body: packed });
      assert.equal(r.status, 400);
      assert.deepEqual([deskCalls, relayCalls], [[], []]);
    });
  });

  it("server.demoBodyLimit: a demo body larger than the route's limit is refused before the keeper or desk is reached", async function () {
    // /demo/usdc caps a body at 1 KiB and answers 400 before the keeper or desk is reached.
    const { keeper } = fakeKeeper();
    await withServer({ keeper, desk: fakeDesk }, async (url) => {
      const big = "x".repeat(2000);
      const res = await fetch(url + "/demo/usdc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: "0xok", pad: big }) });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { ok: false, reason: "bad-address" });
    });
  });

  it("GET /ledger returns every bigint as a string", async function () {
    const A = "0xaa00000000000000000000000000000000000001" as Address;
    const B = "0xbb00000000000000000000000000000000000002" as Address;
    const terms: Terms = {
      recipient: A,
      opensAt: 1000n,
      earlyUntil: 2000n,
      closesAt: 3000n,
      target: 50_000_000n,
      minPledge: 1_000_000n,
      matchAmount: 10_000_000n,
      bonusPool: 5_000_000n,
      rateBps: 1000,
      linearWeight: false,
      bonusFromRecipient: false,
    };
    const events: BoomerangEvent[] = [
      { name: "CampaignCreated", seq: 1n, id: 1n, sponsor: A, terms },
      { name: "PotFunded", seq: 2n, id: 1n, bonus: false, from: A, amount: 10_000_000n },
      { name: "Pledged", seq: 3n, id: 1n, backer: B, payer: B, amount: 7_000_000n, weight: 1_000_000n },
    ];
    const ledger = emptyLedger();
    applyEvents(ledger, events);
    const { keeper } = fakeKeeper({ ledger, feed: () => events });

    await withServer({ keeper }, async (url) => {
      const res = await fetch(url + "/ledger");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
      const body = (await res.json()) as {
        lastSeq: unknown;
        totalOwed: unknown;
        campaigns: { terms: { target: unknown }; pledged: unknown; backers: { principal: unknown }[] }[];
        feed: { seq: unknown }[];
      };
      assert.equal(typeof body.lastSeq, "string");
      assert.equal(body.lastSeq, "3");
      assert.equal(typeof body.totalOwed, "string");
      assert.equal(body.totalOwed, "17000000");
      assert.equal(typeof body.campaigns[0].terms.target, "string");
      assert.equal(body.campaigns[0].terms.target, "50000000");
      assert.equal(typeof body.campaigns[0].pledged, "string");
      assert.equal(typeof body.campaigns[0].backers[0].principal, "string");
      assert.equal(typeof body.feed[0].seq, "string");
    });
  });

  it("the demo routes answer 503 without a desk", async function () {
    const { keeper } = fakeKeeper();
    await withServer({ keeper }, async (url) => {
      const r1 = await fetch(url + "/demo/usdc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: "0xok" }) });
      assert.equal(r1.status, 503);
      assert.deepEqual(await r1.json(), { ok: false, reason: "no-desk" });
      const r2 = await fetch(url + "/demo/campaign", { method: "POST" });
      assert.equal(r2.status, 503);
      const r3 = await fetch(url + "/demo/campaign/two", { method: "POST" });
      assert.equal(r3.status, 503);
      assert.deepEqual(await r3.json(), { ok: false, reason: "no-desk" });
    });
  });

  it("the demo routes map a fake desk: ok 200, refusal 409, bad address 400", async function () {
    const { keeper } = fakeKeeper();
    await withServer({ keeper, desk: fakeDesk }, async (url) => {
      const post = (addr: string) => fetch(url + "/demo/usdc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: addr }) });
      const ok = await post("0xok");
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { ok: true, hash: "0xfeed" });
      const dup = await post("0xdup");
      assert.equal(dup.status, 409);
      const bad = await post("0xbad");
      assert.equal(bad.status, 400);
      const camp = await fetch(url + "/demo/campaign", { method: "POST" });
      assert.equal(camp.status, 200);
      assert.deepEqual(await camp.json(), { ok: true, id: "7" });
    });
  });

  it("server.deskTwo: POST /demo/campaign/two asks the desk for the two-minute kind; the old path still asks for the ten-minute one", async function () {
    const { keeper } = fakeKeeper();
    const asked: unknown[] = [];
    const desk: Desk = {
      ...fakeDesk,
      openCampaign: async (kind) => {
        asked.push(kind);
        return kind === "two" ? { ok: true, id: "8" } : { ok: false, reason: "campaign-open" };
      },
    };
    await withServer({ keeper, desk }, async (url) => {
      const two = await fetch(url + "/demo/campaign/two", { method: "POST" });
      assert.equal(two.status, 200);
      assert.equal(two.headers.get("access-control-allow-origin"), "*");
      assert.deepEqual(await two.json(), { ok: true, id: "8" });
      const ten = await fetch(url + "/demo/campaign", { method: "POST" });
      assert.equal(ten.status, 409);
      assert.deepEqual(await ten.json(), { ok: false, reason: "campaign-open" });
      assert.deepEqual(asked, ["two", "ten"]);
      // The browser's question before the POST is answered, and nothing else under the path exists.
      const opt = await fetch(url + "/demo/campaign/two", { method: "OPTIONS" });
      assert.equal(opt.status, 204);
      assert.equal(opt.headers.get("access-control-allow-origin"), "*");
      assert.equal((await fetch(url + "/demo/campaign/two", { method: "GET" })).status, 404);
      assert.equal((await fetch(url + "/demo/campaign/three", { method: "POST" })).status, 404);
      assert.equal((await fetch(url + "/demo/campaign/two/", { method: "POST" })).status, 404);
      // Nothing the asker sends chooses the kind or its times: a query and a body are not read.
      const loud = await fetch(url + "/demo/campaign/two?kind=ten&openFor=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "ten", openFor: 1 }) });
      assert.deepEqual([loud.status, await loud.json()], [200, { ok: true, id: "8" }]);
      assert.deepEqual(asked, ["two", "ten", "two"]);
    });
  });

  it("server.health.node: /health carries the follower's state, or null when the keeper does not read the node", async function () {
    const { keeper } = fakeKeeper();
    await withServer({ keeper }, async (url) => {
      const h = (await (await fetch(url + "/health")).json()) as { node: unknown };
      assert.equal(h.node, null);
    });
    const state = { reads: 4, lastReadAt: 1_700_000_000_000, readTo: 812, faults: 1 };
    await withServer({ keeper, follower: { state: () => state } }, async (url) => {
      assert.deepEqual(((await (await fetch(url + "/health")).json()) as { node: unknown }).node, state);
    });
  });

  it("POST /relay answers 503 without a relay, and /health names the relay or null", async function () {
    const { keeper } = fakeKeeper();
    await withServer({ keeper }, async (url) => {
      const r = await fetch(url + "/relay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "1" }) });
      assert.equal(r.status, 503);
      assert.deepEqual(await r.json(), { ok: false, reason: "no-relay" });
      assert.equal(((await (await fetch(url + "/health")).json()) as { relay: unknown }).relay, null);
    });
    await withServer({ keeper, relay: fakeRelay }, async (url) => {
      assert.equal(((await (await fetch(url + "/health")).json()) as { relay: unknown }).relay, fakeRelay.address);
    });
  });

  it("POST /relay maps a fake relay: ok 200, refusals 409, keeper low 503, bad input 400; a body over 2 KiB is never read", async function () {
    const { keeper } = fakeKeeper();
    await withServer({ keeper, relay: fakeRelay }, async (url) => {
      const post = (body: string) => fetch(url + "/relay", { method: "POST", headers: { "content-type": "application/json" }, body });
      const ok = await post(JSON.stringify({ id: "1" }));
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get("access-control-allow-origin"), "*");
      assert.deepEqual(await ok.json(), { ok: true, hash: "0xbeef" });
      assert.equal((await post(JSON.stringify({ id: "2" }))).status, 409);
      assert.equal((await post(JSON.stringify({ id: "3" }))).status, 503);
      assert.equal((await post(JSON.stringify({ id: "4" }))).status, 400);
      const junk = await post("not json");
      assert.equal(junk.status, 400);
      assert.deepEqual(await junk.json(), { ok: false, reason: "bad-request" });
      const big = await post(JSON.stringify({ id: "1", pad: "x".repeat(2_100) }));
      assert.equal(big.status, 400);
      const opt = await fetch(url + "/relay", { method: "OPTIONS" });
      assert.equal(opt.status, 204);
    });
  });

  it("answers OPTIONS on a CORS path with 204 and the CORS header, and an unknown path with 404", async function () {
    const { keeper } = fakeKeeper();
    await withServer({ keeper }, async (url) => {
      const opt = await fetch(url + "/ledger", { method: "OPTIONS" });
      assert.equal(opt.status, 204);
      assert.equal(opt.headers.get("access-control-allow-origin"), "*");
      const miss = await fetch(url + "/nope");
      assert.equal(miss.status, 404);
    });
  });

  it("a request target that is not a URL gets an answer and the server keeps serving", async function () {
    const { keeper } = fakeKeeper({
      health: () => {
        throw new Error("a fault inside a route");
      },
    });
    await withServer({ keeper }, async (url) => {
      const port = Number(new URL(url).port);
      // Sent as raw text, the way a stranger's script would: fetch would tidy these up first.
      const raw = (target: string, method = "GET") =>
        new Promise<number>((resolve, reject) => {
          const socket = connect(port, "127.0.0.1", () => socket.write(`${method} ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
          let text = "";
          socket.on("data", (c) => (text += c.toString()));
          socket.on("end", () => resolve(Number(text.split(" ")[1])));
          socket.on("error", reject);
        });
      for (const target of ["//", "/\\\\", "//[", "http://[::1", "/%", "///ledger"]) {
        assert.equal(await raw(target), 404, `target ${target}`);
      }
      assert.equal(await raw("//", "POST"), 404);
      // A fault thrown inside a route is answered with 500, not left to stop the process.
      assert.equal(await raw("/health"), 500);
      // A query string does not hide a route, and the server is still up after all of the above.
      const ledger = await fetch(url + "/ledger?x=//");
      assert.equal(ledger.status, 200);
    });
  });
  // What a stranger can cost the process. Each request below is written to a raw socket, so the
  // test decides exactly which bytes are sent and when.
  // `status` settles when the connection ends; `answered` as soon as an answer's first bytes arrive.
  type Raw = { status: Promise<number>; answered: Promise<number>; write: (text: string) => void; end: () => void };
  const open = (port: number, head: string): Raw => {
    const socket = connect(port, "127.0.0.1");
    socket.write(head); // queued until the connection is up, ahead of anything written after it
    let text = "";
    let heard: (n: number) => void = () => {};
    const answered = new Promise<number>((resolve) => (heard = resolve));
    socket.on("data", (c) => {
      text += c.toString();
      heard(Number(text.split(" ")[1] ?? 0));
    });
    const status = new Promise<number>((resolve) => {
      const settle = () => resolve(Number(text.split(" ")[1] ?? 0));
      socket.on("end", settle);
      socket.on("close", settle);
      socket.on("error", settle);
    });
    return { status, answered, write: (t) => socket.write(t), end: () => socket.destroy() };
  };
  // A POST to /relay, which reads a body (so the shared body machinery runs). /relay caps a body
  // at 2 KiB and needs a relay set before it reads one.
  const relayHead = (length: number) =>
    `POST /relay HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\n\r\n`;

  it("server.refusedEarly: a body route that refuses before reading answers at once, its body never taken", async function () {
    // Ported from the old server.unsigned: /relay with no relay answers 503 before any body is read.
    const { keeper, calls } = fakeKeeper();
    await withServer({ keeper, bodyDeadlineMs: 60_000 }, async (url) => {
      const port = Number(new URL(url).port);
      // A megabyte is promised and none of it is ever sent. The answer must not wait for it.
      const started = Date.now();
      const r = open(port, `POST /relay HTTP/1.1\r\nHost: x\r\nContent-Length: 1000000\r\n\r\n`);
      assert.equal(await r.status, 503);
      assert.ok(Date.now() - started < 5_000, "answered at once");
      assert.equal(calls.length, 0);
    });
  });

  it("server.declared: a body declared larger than the route's limit is refused before it is sent", async function () {
    const { keeper } = fakeKeeper();
    await withServer({ keeper, relay: fakeRelay, bodyDeadlineMs: 60_000 }, async (url) => {
      const r = open(Number(new URL(url).port), relayHead(2049)); // over /relay's 2 KiB
      assert.equal(await r.status, 400);
    });
  });

  it("server.slow: a body that does not arrive in time is given up on, and the connection closed", async function () {
    const { keeper } = fakeKeeper();
    await withServer({ keeper, relay: fakeRelay, bodyDeadlineMs: 150 }, async (url) => {
      const started = Date.now();
      const r = open(Number(new URL(url).port), relayHead(40));
      r.write("only part");
      assert.equal(await r.status, 400);
      assert.ok(Date.now() - started < 5_000, "given up on at the body's own deadline, not the server's longer one");
    });
  });

  it("server.held: all bodies being read together are held to one budget, and it is given back", async function () {
    const { keeper } = fakeKeeper();
    await withServer({ keeper, relay: fakeRelay, maxHeld: 1500, bodyDeadlineMs: 60_000 }, async (url) => {
      const port = Number(new URL(url).port);
      const pause = () => new Promise((r) => setTimeout(r, 100));
      // Two senders each hold 900 bytes of an unfinished body: under /relay's own limit apiece,
      // over the budget together. The one that crosses it is turned away.
      const first = open(port, relayHead(1000));
      first.write("x".repeat(900));
      await pause();
      const second = open(port, relayHead(1000));
      second.write("x".repeat(900));
      assert.equal(await second.status, 503);
      // The first is still within its own limits and is still being read.
      first.end();
      await pause();
      // Both are gone; what they held is given back, and a real relay request goes through.
      const ok = await fetch(url + "/relay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "1" }) });
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { ok: true, hash: "0xbeef" });
      // And again, twice over: had the budget leaked, these padded bodies would not fit.
      for (let i = 0; i < 2; i++) {
        const again = await fetch(url + "/relay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "1", pad: "y".repeat(700) }) });
        assert.equal(again.status, 200);
      }
    });
  });

  it("server.exact: bodies turned away for their size leave the budget exactly where it was", async function () {
    const { keeper } = fakeKeeper();
    await withServer({ keeper, relay: fakeRelay, maxHeld: 2500, bodyDeadlineMs: 60_000 }, async (url) => {
      const port = Number(new URL(url).port);
      const pause = (ms = 100) => new Promise((r) => setTimeout(r, ms));
      const chunkedHead = `POST /relay HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`;
      // Thirty bodies that declare no length and run past /relay's 2 KiB limit: each is cut off.
      for (let i = 0; i < 30; i++) {
        const r = open(port, chunkedHead);
        r.write(`c00\r\n${"x".repeat(3072)}\r\n`);
        assert.equal(await r.status, 400);
      }
      // Had each of those given back more than it took, the budget would now be far below zero
      // and three senders holding 900 bytes apiece (2700, over the 2500 budget) would all fit.
      const holders = [open(port, relayHead(1000)), open(port, relayHead(1000))];
      for (const h of holders) h.write("x".repeat(900));
      await pause();
      const third = open(port, relayHead(1000));
      third.write("x".repeat(900));
      const status = await Promise.race([third.status, pause(3_000).then(() => -1)]);
      assert.equal(status, 503);
      for (const h of holders) h.end();
    });
  });

  it("server.dropped: a connection that goes away part-way through its body gives back what it held", async function () {
    const { keeper } = fakeKeeper();
    await withServer({ keeper, relay: fakeRelay, maxHeld: 2500, bodyDeadlineMs: 60_000 }, async (url) => {
      const port = Number(new URL(url).port);
      const pause = (ms = 150) => new Promise((r) => setTimeout(r, ms));
      const gone = open(port, relayHead(2000));
      gone.write("x".repeat(1500));
      await pause();
      gone.end(); // the socket is destroyed with 500 bytes still owed
      await pause();
      // 1500 bytes fit again. Had the first 1500 still been counted, this sender would be turned away.
      const next = open(port, relayHead(2000));
      next.write("x".repeat(1500));
      await pause();
      next.write("x".repeat(500));
      assert.equal(await Promise.race([next.answered, pause(3_000).then(() => -1)]), 400); // read in full; its body is not JSON
      next.end();
    });
  });

  it("server.strayBody: a body sent where none is read does not keep the connection open", async function () {
    const { keeper } = fakeKeeper();
    await withServer({ keeper, desk: fakeDesk, bodyDeadlineMs: 60_000 }, async (url) => {
      const port = Number(new URL(url).port);
      const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
      // Each promises a body and never sends it. The answer comes at once and the connection is closed with it.
      for (const [head, want] of [
        [`GET /health HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\n\r\n`, 200],
        [`GET /nothing HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n`, 404],
        [`POST /demo/campaign HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\n\r\n`, 200],
        [`POST /demo/campaign/two HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\n\r\n`, 200],
        [`OPTIONS /ledger HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\n\r\n`, 204],
      ] as const) {
        const started = Date.now();
        const r = open(port, head);
        assert.equal(await Promise.race([r.status, pause(5_000).then(() => -1)]), want, head.split(" HTTP")[0]);
        assert.ok(Date.now() - started < 5_000);
      }
      // A request with no body keeps its connection, as before: two requests on one socket both get answers.
      const two = open(port, `GET /health HTTP/1.1\r\nHost: x\r\n\r\n`);
      await pause(150);
      two.write(`GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      assert.equal(await two.status, 200);
    });
  });

  it("server.notTheSender: a desk that could not answer is this server's fault (503)", async function () {
    // The store-fault half once tested keeper.deliver over a route that no longer exists, so only
    // the desk-fault half remains.
    const { keeper } = fakeKeeper();
    const downDesk: Desk = {
      address: DESK_ADDR,
      giveUsdc: async () => {
        throw new Error("the node is down");
      },
      openCampaign: async () => {
        throw new Error("the node is down");
      },
    };
    await withServer({ keeper, desk: downDesk }, async (url) => {
      const usdc = await fetch(url + "/demo/usdc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: "0xok" }) });
      assert.equal(usdc.status, 503);
      assert.deepEqual(await usdc.json(), { ok: false, reason: "busy" });
      const camp = await fetch(url + "/demo/campaign", { method: "POST" });
      assert.equal(camp.status, 503);
      assert.deepEqual(await camp.json(), { ok: false, reason: "busy" });
    });
  });

  it("server.timeouts: no request may stay open for minutes, and connections are counted", async function () {
    const server = createServer({ keeper: fakeKeeper().keeper });
    assert.equal(server.headersTimeout, 15_000);
    assert.equal(server.requestTimeout, 30_000);
    assert.equal(server.maxConnections, 256);
  });
});
