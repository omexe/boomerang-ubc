// Every address and answer in these tests is invented. No request leaves the machine: fetch is a stand-in.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { askForCampaign, askForUsdc, askKeeper, type Fetch } from "../src/data/ask.ts";
import { givenStore } from "../src/flows/given.ts";

const ME = "0x00000000000000000000000000000000000000a1";
const URL_ = "https://keeper.example";
const HEALTH = {
  lastSeq: "0", missing: null, pending: 0, repeats: 0, lastBlock: 0, lastTime: "0",
  sent: 0, failedSends: 0, rejected: 0, gaveUp: [], lastErrors: [], settled: true, desk: null,
};
const LEDGER = { lastSeq: "0", totalOwed: "0", missing: null, campaigns: [], feed: [] };

type Seen = { url: string; init: Parameters<Fetch>[1] };
const fake = (answers: Record<string, { status?: number; body?: unknown; fail?: boolean }>): { fetch: Fetch; seen: Seen[] } => {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (url, init) => {
      seen.push({ url, init });
      const a = answers[url.replace(URL_, "")] ?? { status: 404, body: {} };
      if (a.fail) throw new Error("network down");
      return {
        status: a.status ?? 200,
        json: async () => {
          if (a.body === "not json") throw new SyntaxError("Unexpected token");
          return a.body;
        },
      };
    },
  };
};

describe("asking the keeper", function () {
  it("ask.up: a keeper that answers both questions well is read; the requests carry no credentials and follow no redirect", async function () {
    const f = fake({ "/ledger": { body: LEDGER }, "/health": { body: HEALTH } });
    const a = await askKeeper({ url: URL_, fetch: f.fetch });
    assert.equal(a.up, true);
    assert.equal(a.up && a.ledger.lastSeq, 0n);
    assert.equal(a.up && a.health.settled, true);
    assert.deepEqual(f.seen.map((s) => s.url).sort(), [`${URL_}/health`, `${URL_}/ledger`]);
    for (const s of f.seen) {
      assert.deepEqual([s.init.method, s.init.redirect, s.init.credentials, s.init.cache], ["GET", "error", "omit", "no-store"]);
      assert.ok(s.init.signal instanceof AbortSignal);
    }
  });

  it("ask.down: no keeper, a silent one, an error answer and nonsense each come back as a reason, never thrown", async function () {
    assert.deepEqual(await askKeeper({ url: null, fetch: fake({}).fetch }), { up: false, why: "none" });
    assert.deepEqual(await askKeeper({ url: URL_, fetch: fake({ "/ledger": { fail: true }, "/health": { body: HEALTH } }).fetch }), { up: false, why: "unreachable" });
    assert.deepEqual(await askKeeper({ url: URL_, fetch: fake({ "/ledger": { status: 502, body: {} }, "/health": { body: HEALTH } }).fetch }), { up: false, why: "unreachable" });
    assert.deepEqual(await askKeeper({ url: URL_, fetch: fake({ "/ledger": { body: "not json" }, "/health": { body: HEALTH } }).fetch }), { up: false, why: "unreachable" });
    assert.deepEqual(await askKeeper({ url: URL_, fetch: fake({ "/ledger": { body: { ...LEDGER, totalOwed: 5 } }, "/health": { body: HEALTH } }).fetch }), { up: false, why: "unreadable" });
    assert.deepEqual(await askKeeper({ url: URL_, fetch: fake({ "/ledger": { body: LEDGER }, "/health": { body: { ...HEALTH, settled: "yes" } } }).fetch }), { up: false, why: "unreadable" });
  });

  it("ask.desk: each answer from the desk is said in a sentence, and an answer the page does not know is not passed on", async function () {
    const usdc = async (body: unknown, status = 200) => askForUsdc({ url: URL_, fetch: fake({ "/demo/usdc": { status, body } }).fetch, address: ME });
    assert.deepEqual(await usdc({ ok: true, hash: "0xfeed" }), { ok: true, line: "The desk sent 2.00 USDC to your address.", had: true });
    assert.deepEqual(await usdc({ ok: false, reason: "already-given" }, 409), { ok: false, line: "This address has already had its USDC from the desk.", had: true });
    // `had`: the desk will not send to this address again. True when it sent, had sent before, or
    // sent something it could not confirm; false for every answer after which asking again may work.
    assert.equal((await usdc({ ok: false, reason: "unconfirmed" }, 409)).had, true);
    for (const reason of ["desk-low", "busy", "no-desk", "failed", "bad-address", "something-new"]) assert.equal((await usdc({ ok: false, reason }, 409)).had, false, reason);
    assert.match((await usdc({ ok: false, reason: "desk-low" }, 409)).line, /out of USDC/);
    assert.match((await usdc({ ok: false, reason: "unconfirmed" }, 409)).line, /will not send to this address again/);
    assert.match((await usdc({ ok: false, reason: "busy" }, 409)).line, /busy/);
    assert.match((await usdc({ ok: false, reason: "no-desk" }, 503)).line, /not running a desk/);
    // The keeper's own words (a reason this page has no sentence for, a detail field) never reach the page.
    assert.deepEqual(await usdc({ ok: false, reason: "<b>pwned</b>", detail: "<script>" }, 409), { ok: false, line: "The desk could not do that just now.", had: false });
    // A reason that names an inherited Object property is not a known refusal: it falls back, never returns a function or object.
    for (const reason of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      assert.deepEqual(await usdc({ ok: false, reason }, 409), { ok: false, line: "The desk could not do that just now.", had: false }, reason);
    }
    for (const odd of [null, "ok", 5, { ok: "true" }, [], "not json"]) assert.deepEqual(await usdc(odd), { ok: false, line: "The desk could not be reached.", had: false }, String(odd));
    assert.deepEqual(await askForUsdc({ url: null, fetch: fake({}).fetch, address: ME }), { ok: false, line: "The desk could not be reached.", had: false });
    assert.deepEqual(await askForUsdc({ url: URL_, fetch: fake({ "/demo/usdc": { fail: true } }).fetch, address: ME }), { ok: false, line: "The desk could not be reached.", had: false });

    // The request itself: a POST of the address as JSON, nothing else.
    const f = fake({ "/demo/usdc": { body: { ok: true } } });
    await askForUsdc({ url: URL_, fetch: f.fetch, address: ME });
    assert.equal(f.seen[0].url, `${URL_}/demo/usdc`);
    assert.deepEqual([f.seen[0].init.method, f.seen[0].init.body, f.seen[0].init.credentials, f.seen[0].init.redirect], ["POST", JSON.stringify({ address: ME }), "omit", "error"]);

    const PATHS = { ten: "/demo/campaign", two: "/demo/campaign/two" } as const;
    const campaign = async (body: unknown, kind: "ten" | "two" = "ten") => askForCampaign({ url: URL_, fetch: fake({ [PATHS[kind]]: { body } }).fetch, kind });
    assert.deepEqual(await campaign({ ok: true, id: "7" }), { ok: true, line: "A ten-minute campaign is open. It takes pledges in about a minute and settles in about eleven.", id: 7n });
    assert.deepEqual(await campaign({ ok: true, id: "8" }, "two"), { ok: true, line: "A two-minute campaign is open. It takes pledges in under a minute and settles in about three and a half minutes.", id: 8n });
    assert.equal((await campaign({ ok: true, id: "7; drop" })).id, null);
    assert.equal((await campaign({ ok: true })).id, null);
    // One desk campaign runs at a time, whatever its kind, so the refusal names neither.
    for (const kind of ["ten", "two"] as const) {
      const open = await campaign({ ok: false, reason: "campaign-open" }, kind);
      assert.deepEqual(open, { ok: false, line: "A campaign from the desk is already running. It is on the list; a new one can open when it ends.", id: null }, kind);
    }
    // Each kind is asked for at its own path, with an empty body.
    for (const kind of ["ten", "two"] as const) {
      const g = fake({ [PATHS[kind]]: { body: { ok: true, id: "1" } } });
      await askForCampaign({ url: URL_, fetch: g.fetch, kind });
      assert.deepEqual([g.seen.length, g.seen[0].url, g.seen[0].init.method, g.seen[0].init.body], [1, `${URL_}${PATHS[kind]}`, "POST", "{}"], kind);
    }
    // A keeper that does not know the two-minute path (an older one) is a desk that could not be reached: nothing is opened.
    assert.deepEqual(await askForCampaign({ url: URL_, fetch: fake({ "/demo/campaign": { body: { ok: true, id: "7" } } }).fetch, kind: "two" }), { ok: false, line: "The desk could not be reached.", id: null });
  });

  it("flows.given: an address the desk will not send to again is remembered per chain, across page loads, and without storage", function () {
    const backing = new Map<string, string>();
    const storage = { getItem: (k: string) => backing.get(k) ?? null, setItem: (k: string, v: string) => void backing.set(k, v) };
    const a = givenStore(storage, 5042002);
    assert.equal(a.has(ME), false);
    a.add(ME);
    assert.equal(a.has(ME), true);
    assert.equal(a.has(ME.toUpperCase().replace("0X", "0x") as `0x${string}`), true, "an address is the same in any case");
    // A second page (a reload, another tab) knows; another chain does not.
    assert.equal(givenStore(storage, 5042002).has(ME), true);
    assert.equal(givenStore(storage, 31337).has(ME), false);
    // The page that was told keeps it whatever happens to storage.
    backing.clear();
    assert.equal(a.has(ME), true);
    // Junk in storage is ignored, not trusted.
    backing.set("boomerang:desk-given:5042002", '["nope", 7, {"a":1}, "0x12"]');
    assert.equal(givenStore(storage, 5042002).has(ME), false);
    backing.set("boomerang:desk-given:5042002", "not json");
    assert.equal(givenStore(storage, 5042002).has(ME), false);
    // Storage that throws, or none at all: this page's memory stands in.
    const broken = givenStore({ getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } }, 5042002);
    broken.add(ME);
    assert.equal(broken.has(ME), true);
    const none = givenStore(null, 5042002);
    none.add(ME);
    assert.equal(none.has(ME), true);
    // It keeps the newest fifty and no more.
    const many = givenStore(storage, 1);
    const nth = (i: number) => `0x${i.toString(16).padStart(40, "0")}` as `0x${string}`;
    for (let i = 0; i < 60; i++) many.add(nth(i));
    assert.equal((JSON.parse(backing.get("boomerang:desk-given:1")!) as unknown[]).length, 50);
    assert.equal(givenStore(storage, 1).has(nth(59)), true);
    assert.equal(givenStore(storage, 1).has(nth(0)), false);
  });
});
