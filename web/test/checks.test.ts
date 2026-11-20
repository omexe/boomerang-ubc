// Every amount, address and time in these tests is invented. None is a reading of any real campaign.
//
// The "Check it here" section: the words it shows for each state, the runner's handling of a node
// that refuses and of the explorer's answer, and the Proof page's table of every campaign.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { PublicClient } from "viem";

import { BOOMERANG_FINGERPRINT } from "../../packages/kit/src/index.ts";
import type { State, Terms } from "../../packages/kit/src/index.ts";
import { Outcome } from "../../packages/kit/src/index.ts";
import type { CampaignView } from "../src/data/load.ts";
import { runChecks, type CheckId, type CheckResult } from "../src/flows/checks.ts";
import { checksView } from "../src/views/checks.ts";
import { proofPage } from "../src/views/proof.ts";

const BOOMERANG = "0x00000000000000000000000000000000000000b0" as const;
const USDC = "0x3600000000000000000000000000000000000000" as const;
const ROUTER = "0x00000000000000000000000000000000000000f0" as const;
const RECIPIENT = "0x00000000000000000000000000000000000000aa" as const;
const SPONSOR = "0x00000000000000000000000000000000000000b1" as const;
const EXPLORER = "https://explorer.testnet.arc.io";

const ALL_IDS: CheckId[] = ["code", "no-owner", "custody", "ledger", "explorer"];
const result = (id: CheckId, ok: boolean): CheckResult => ({ id, ok, detail: `detail for ${id}` });

describe("checks.view", function () {
  it("idle offers the button and shows nothing else", function () {
    const v = checksView({ phase: "idle" });
    assert.equal(v.title, "Check it here");
    assert.equal(
      v.intro,
      "These checks run in this browser when you press the button. They ask the chain directly, which takes a few seconds, or longer if every block has to be read; nothing is sent and no wallet is needed.",
    );
    assert.equal(v.button, "Run the checks");
    assert.equal(v.running, null);
    assert.deepEqual(v.rows, []);
    assert.equal(v.verdict, null);
    assert.equal(
      v.outside,
      "One check cannot run in a browser: that the contract was created by exactly this repository's code and nothing else. The commands below run it, with the other checks, from your own copy of the code.",
    );
  });

  it("running shows the general line, or the ledger's progress, and hides the button", function () {
    const general = checksView({ phase: "running", progress: null });
    assert.equal(general.button, null);
    assert.equal(general.running, "Running the checks…");
    const ledger = checksView({ phase: "running", progress: { id: "ledger", done: 2, of: 5 } });
    assert.equal(ledger.running, "Reading the contract's events: 2 of 5 requests.");
  });

  it("failed: a run that could not start says nothing was checked and offers the button again", function () {
    const v = checksView({ phase: "failed" });
    assert.equal(v.button, "Run the checks");
    assert.equal(v.running, null);
    assert.deepEqual(v.rows, []);
    assert.equal(v.verdict, "The checks could not be started, so nothing was checked. Try again.");
  });

  it("done, all passed: the right claim and ok state for every check, and the all-passed verdict", function () {
    const v = checksView({ phase: "done", results: ALL_IDS.map((id) => result(id, true)) });
    assert.equal(v.button, "Run them again");
    assert.equal(v.running, null);
    assert.equal(v.verdict, "All 5 checks passed.");
    assert.deepEqual(
      v.rows.map((r) => r.claim),
      [
        "The code at the contract's address is the code this repository builds.",
        "Nothing in that code lets anyone take control of it or remove it.",
        "The contract holds at least what it owes.",
        "A ledger rebuilt in this browser from the contract's own events matches the contract, campaign by campaign and backer by backer.",
        "Arc's block explorer holds verified source code for the contract.",
      ],
    );
    assert.ok(v.rows.every((r) => r.state === "ok"));
    assert.deepEqual(
      v.rows.map((r) => r.detail),
      ALL_IDS.map((id) => `detail for ${id}`),
    );
  });

  it("done, some failed: the fail claims, the fail state, and the not-all-passed verdict", function () {
    const results: CheckResult[] = [result("code", true), result("no-owner", false), result("custody", true), result("ledger", false), result("explorer", true)];
    const v = checksView({ phase: "done", results });
    assert.equal(
      v.verdict,
      "2 of 5 checks did not pass. A check that could not be completed counts as not passed; run them again before reading anything into it.",
    );
    const fails = v.rows.filter((r) => r.state === "fail");
    assert.deepEqual(
      fails.map((r) => r.claim),
      ["That code could not be shown to be free of an owner.", "A ledger rebuilt in this browser could not be matched to the contract."],
    );
  });

  it("every check's fail claim is distinct and present", function () {
    const v = checksView({ phase: "done", results: ALL_IDS.map((id) => result(id, false)) });
    assert.deepEqual(
      v.rows.map((r) => r.claim),
      [
        "The code at the contract's address could not be matched to the code this repository builds.",
        "That code could not be shown to be free of an owner.",
        "The contract could not be shown to hold what it owes.",
        "A ledger rebuilt in this browser could not be matched to the contract.",
        "Arc's block explorer could not confirm verified source code for the contract.",
      ],
    );
    assert.ok(v.rows.every((r) => r.state === "fail"));
    assert.equal(v.verdict, "5 of 5 checks did not pass. A check that could not be completed counts as not passed; run them again before reading anything into it.");
  });
});

// The compiled Boomerang runtime code, with the USDC address written into its immutable slots, so
// the fingerprint rows read exactly as they would against the deployed contract.
const ARTIFACT_URL = new URL("../../contracts/artifacts/contracts/Boomerang.sol/Boomerang.json", import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const artifact: any = JSON.parse(readFileSync(ARTIFACT_URL, "utf8"));
function liveCode(usdc: string): `0x${string}` {
  const body = (artifact.deployedBytecode as string).replace(/^0x/, "").toLowerCase().split("");
  const want = usdc.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  for (const r of BOOMERANG_FINGERPRINT.immutables) {
    for (let i = 0; i < r.length * 2; i++) body[r.start * 2 + i] = want[i];
  }
  return ("0x" + body.join("")) as `0x${string}`;
}

// A fake client that answers the reads the checks make. `getLogs` throws, so the ledger row fails
// while the others stand.
function noLogsClient(): PublicClient {
  return {
    getCode: async () => liveCode(USDC),
    getBlockNumber: async () => 1000n,
    getLogs: async () => {
      throw new Error("the node refused: requested range too large");
    },
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "balanceOf" ? 100n : functionName === "totalOwed" ? 50n : 0n,
  } as unknown as PublicClient;
}

const okFetch = async () => ({ status: 200, json: async () => ({}) });

describe("checks.partial", function () {
  it("a node that refuses the logs fails only the ledger row; code, no-owner and custody still pass", async function () {
    const results = await runChecks({ client: noLogsClient(), boomerang: BOOMERANG, usdc: USDC, fromBlock: 0n, explorer: null, fetch: okFetch });
    const by = new Map(results.map((r) => [r.id, r]));
    assert.deepEqual(
      results.map((r) => r.id),
      ["code", "no-owner", "custody", "ledger"],
    );
    assert.ok(by.get("code")!.ok, by.get("code")!.detail);
    assert.ok(by.get("no-owner")!.ok, by.get("no-owner")!.detail);
    assert.ok(by.get("custody")!.ok, by.get("custody")!.detail);
    // The code row's hash is whole (64 digits), not cut by the limit on a row's length.
    assert.match(by.get("code")!.detail, /; code hash 0x[0-9a-f]{64}$/);
    // The custody row's figures are the contract's raw units, and the row says which.
    assert.equal(by.get("custody")!.detail, "holds 100, owes 50, at block 1000 (amounts in millionths of a USDC)");
    const ledger = by.get("ledger")!;
    assert.equal(ledger.ok, false);
    assert.match(ledger.detail, /range too large/);
    assert.ok(ledger.detail.length <= 200);
  });
});

describe("checks.explorer", function () {
  const explorerRow = async (fetch: (url: string) => Promise<{ status: number; json(): Promise<unknown> }>) => {
    const client = {
      getCode: async () => {
        throw new Error("not under test");
      },
      getBlockNumber: async () => {
        throw new Error("not under test");
      },
    } as unknown as PublicClient;
    const results = await runChecks({ client, boomerang: BOOMERANG, usdc: USDC, fromBlock: 0n, explorer: EXPLORER, fetch });
    return results.find((r) => r.id === "explorer")!;
  };

  it("200 with both flags true passes and names a plain compiler version", async function () {
    let asked = "";
    const row = await explorerRow(async (url) => {
      asked = url;
      return { status: 200, json: async () => ({ is_verified: true, is_fully_verified: true, compiler_version: "v0.8.28+commit.7893614a" }) };
    });
    assert.equal(asked, `${EXPLORER}/api/v2/smart-contracts/${BOOMERANG}`);
    assert.ok(row.ok, row.detail);
    assert.match(row.detail, /v0\.8\.28\+commit\.7893614a/);
  });

  it("a false verified flag fails", async function () {
    const row = await explorerRow(async () => ({ status: 200, json: async () => ({ is_verified: true, is_fully_verified: false }) }));
    assert.equal(row.ok, false);
  });

  it("a 404 fails and names the status", async function () {
    const row = await explorerRow(async () => ({ status: 404, json: async () => ({}) }));
    assert.equal(row.ok, false);
    assert.match(row.detail, /404/);
  });

  it("a thrown fetch fails, cut to the reason", async function () {
    const row = await explorerRow(async () => {
      throw new Error("network down");
    });
    assert.equal(row.ok, false);
    assert.match(row.detail, /network down/);
  });

  it("a non-object body fails", async function () {
    const row = await explorerRow(async () => ({ status: 200, json: async () => "not an object" }));
    assert.equal(row.ok, false);
  });

  it("an answer that is not JSON fails without showing any of the answer", async function () {
    const row = await explorerRow(async () => ({
      status: 200,
      json: async () => {
        throw new SyntaxError(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`);
      },
    }));
    assert.deepEqual(row, { id: "explorer", ok: false, detail: "the explorer's answer was not something this check could read" });
  });

  it("an explorer that never answers fails its own row after the wait; the run still ends", async function () {
    const started = Date.now();
    const results = await runChecks({
      client: noLogsClient(), boomerang: BOOMERANG, usdc: USDC, fromBlock: 0n, explorer: EXPLORER, explorerWaitMs: 30,
      fetch: () => new Promise(() => {}),
    });
    assert.ok(Date.now() - started < 2000);
    assert.deepEqual(results.map((r) => r.id), ["code", "no-owner", "custody", "ledger", "explorer"]);
    assert.deepEqual(results.at(-1), { id: "explorer", ok: false, detail: "the explorer did not answer in time" });
    assert.ok(results[0].ok && results[1].ok && results[2].ok);
  });

  it("a compiler version with odd characters is not echoed", async function () {
    const row = await explorerRow(async () => ({
      status: 200,
      json: async () => ({ is_verified: true, is_fully_verified: true, compiler_version: "v0.8.28 <script>alert(1)</script>" }),
    }));
    assert.ok(row.ok, row.detail);
    assert.doesNotMatch(row.detail, /script/);
  });
});

describe("checks.odd", function () {
  it("whatever a read throws, the run ends with a failed row and never throws itself", async function () {
    const odd: unknown[] = [Object.create(null), Object.assign(new Error("x"), { shortMessage: 5 }), undefined, null, 7, { message: 9 }];
    for (const thrown of odd) {
      const client = {
        getCode: async () => {
          throw thrown;
        },
        getBlockNumber: async () => {
          throw thrown;
        },
      } as unknown as PublicClient;
      const results = await runChecks({ client, boomerang: BOOMERANG, usdc: USDC, fromBlock: 0n, explorer: null, fetch: okFetch });
      assert.deepEqual(results.map((r) => [r.id, r.ok]), [["code", false], ["no-owner", false], ["custody", false], ["ledger", false]]);
      for (const r of results) assert.ok(typeof r.detail === "string" && r.detail.length > 0 && r.detail.length <= 200, String(r.detail));
    }
  });
});

describe("checks.none", function () {
  it("with no explorer there is no explorer row", async function () {
    const results = await runChecks({ client: noLogsClient(), boomerang: BOOMERANG, usdc: USDC, fromBlock: 0n, explorer: null, fetch: okFetch });
    assert.equal(
      results.find((r) => r.id === "explorer"),
      undefined,
    );
    assert.equal(results.length, 4);
  });
});

// A campaign builder for the Proof table, like views.test.ts's.
const OPENS = 1_794_000_000n;
const usd = (n: number) => BigInt(Math.round(n * 1_000_000));
const terms = (over: Partial<Terms> = {}): Terms => ({
  recipient: RECIPIENT,
  opensAt: OPENS,
  earlyUntil: OPENS + 86_400n,
  closesAt: OPENS + 7n * 86_400n,
  target: usd(2000),
  minPledge: usd(5),
  matchAmount: usd(500),
  bonusPool: usd(100),
  rateBps: 1000,
  linearWeight: false,
  bonusFromRecipient: false,
  ...over,
});
const state = (over: Partial<State> = {}): State => ({
  sponsor: SPONSOR,
  outcome: Outcome.Open,
  matchIn: true,
  bonusIn: true,
  recipientPaid: false,
  matchReturned: false,
  bonusReturned: false,
  backers: 3,
  pledged: usd(1240),
  pledgedEarly: usd(1240),
  weighted: usd(1240) * 1_000_000n,
  bonusPaid: 0n,
  ...over,
});
const campaign = (id: bigint, t: Partial<Terms>, s: Partial<State>): CampaignView => ({ id, terms: terms(t), state: state(s), outcomeNow: 0 });

describe("proof.campaigns", function () {
  const page = (campaigns: CampaignView[], count: bigint, now: bigint) =>
    proofPage({
      custody: null,
      campaigns,
      count,
      ledger: null,
      health: null,
      backerChecks: null,
      backerTotal: 0,
      where: { boomerang: BOOMERANG, usdc: USDC, router: ROUTER },
      labels: [],
      desk: null,
      now,
      pace: { state: "down" },
    }).campaigns;

  it("the table heads, the ended word and the paid word for each kind of campaign", function () {
    const now = OPENS + 100n; // open: past opensAt, before close, target not met
    const open = campaign(5n, {}, { outcome: Outcome.Open, pledged: usd(100) });
    const clearedPaid = campaign(4n, { bonusPool: 0n }, { outcome: Outcome.Funded, pledged: usd(2000), recipientPaid: true, bonusIn: false });
    const clearedUnpaid = campaign(3n, { bonusPool: 0n }, { outcome: Outcome.Funded, pledged: usd(2000), recipientPaid: false, bonusIn: false });
    const returned = campaign(2n, {}, { outcome: Outcome.Missed, pledged: usd(1240), matchIn: false, bonusIn: false, bonusPaid: usd(40) });
    const neverOpened = campaign(1n, {}, { outcome: Outcome.Void, pledged: 0n, backers: 0, matchIn: false, bonusIn: false });

    const t = page([open, clearedPaid, clearedUnpaid, returned, neverOpened], 5n, now);
    assert.equal(t.title, "Every campaign, and how it ended");
    assert.deepEqual(t.head, ["Campaign", "Ended", "Pledged", "Paid"]);
    assert.equal(t.note, null);

    assert.deepEqual(
      t.rows.map((r) => r.ended),
      ["Open", "Cleared", "Cleared", "Returned", "Never opened"],
    );
    assert.deepEqual(
      t.rows.map((r) => r.paid),
      ["Not yet", "In full", "Not all yet", "Pots returned; refunds are on its page", "In full"],
    );
    // Order is as given (newest first), the name and figures are the site's own.
    assert.equal(t.rows[0].name, "Campaign 5");
    assert.equal(t.rows[0].href, "#/campaign/5");
    assert.equal(t.rows[1].pledged, "2,000.00 of 2,000.00");
    assert.equal(t.rows[0].pledged, "100.00 of 2,000.00");
  });

  it("a campaign past its deadline but not settled reads waiting", function () {
    const ended = campaign(1n, {}, { outcome: Outcome.Open, pledged: usd(100) });
    const t = page([ended], 1n, OPENS + 30n * 86_400n); // long past the close
    assert.equal(t.rows[0].ended, "Waiting to be settled");
    assert.equal(t.rows[0].paid, "Not yet");
  });

  it("the note names the cap when fewer campaigns were read than the contract has", function () {
    const t = page([campaign(9n, {}, { outcome: Outcome.Open, pledged: usd(100) })], 12n, OPENS + 100n);
    assert.equal(t.note, "The newest 1 of 12 campaigns.");
  });
});

// A contract with no campaign and no event yet, at block 1000, whose node writes down each log
// request. The explorer's two answers (the list of logs, the verified source) are stand-ins.
describe("checks.hints", function () {
  const quiet = () => {
    const asked: { from: bigint; to: bigint }[] = [];
    const client = {
      getCode: async () => liveCode(USDC),
      getBlockNumber: async () => 1000n,
      getLogs: async (a: { fromBlock: bigint; toBlock: bigint }) => {
        asked.push({ from: a.fromBlock, to: a.toBlock });
        return [];
      },
      readContract: async ({ functionName }: { functionName: string }) => (functionName === "balanceOf" ? 100n : functionName === "totalOwed" ? 0n : 0n),
    } as unknown as PublicClient;
    return { client, asked };
  };
  const verified = { status: 200, json: async () => ({ is_verified: true, is_fully_verified: true }) };

  it("with an explorer, the ledger row asks it where the logs are and reads only there, at the pace it is given", async function () {
    const { client, asked } = quiet();
    const urls: string[] = [];
    const waits: number[] = [];
    const results = await runChecks({
      client, boomerang: BOOMERANG, usdc: USDC, fromBlock: 0n, explorer: EXPLORER, chunk: 100n, gapMs: 350,
      wait: async (ms) => void waits.push(ms),
      fetch: async (url) => {
        urls.push(url);
        return url.endsWith("/logs") ? { status: 200, json: async () => ({ items: [{ block_number: "10" }, { block_number: "420" }], next_page_params: null }) } : verified;
      },
    });
    assert.deepEqual(urls, [`${EXPLORER}/api/v2/addresses/${BOOMERANG}/logs`, `${EXPLORER}/api/v2/smart-contracts/${BOOMERANG}`]);
    assert.deepEqual(asked, [{ from: 10n, to: 10n }, { from: 420n, to: 420n }]);
    assert.deepEqual(waits, [350]);
    const ledger = results.find((r) => r.id === "ledger")!;
    assert.ok(ledger.ok, ledger.detail);
    assert.equal(
      ledger.detail,
      "0 campaign(s), 0 backer(s), seq 1..0 match the contract at block 1000; the logs were read from the node at 2 range(s) of blocks named by Arc's explorer, and the contract's own count of 0 event(s) shows none is missing",
    );
    assert.deepEqual(results.map((r) => [r.id, r.ok]), [["code", true], ["no-owner", true], ["custody", true], ["ledger", true], ["explorer", true]]);
  });

  it("an explorer that cannot list the logs, or never answers, leaves the row reading every block; its own row is judged apart", async function () {
    const fetches: ((url: string) => Promise<{ status: number; json(): Promise<unknown> }>)[] = [
      async (url) => (url.endsWith("/logs") ? { status: 500, json: async () => ({}) } : verified),
      async (url) => (url.endsWith("/logs") ? { status: 200, json: async () => ({ items: [{ block_number: "<b>" }] }) } : verified),
      (url) => (url.endsWith("/logs") ? new Promise(() => {}) : Promise.resolve(verified)),
    ];
    for (const fetch of fetches) {
      const { client, asked } = quiet();
      const results = await runChecks({ client, boomerang: BOOMERANG, usdc: USDC, fromBlock: 0n, explorer: EXPLORER, chunk: 100n, explorerWaitMs: 30, fetch });
      assert.equal(asked.length, 11);
      assert.deepEqual(asked[0], { from: 0n, to: 99n });
      assert.deepEqual(asked[10], { from: 1000n, to: 1000n });
      const ledger = results.find((r) => r.id === "ledger")!;
      assert.ok(ledger.ok, ledger.detail);
      assert.match(ledger.detail, /; every block from 0 was read$/);
      assert.doesNotMatch(ledger.detail, /<b>/);
      assert.ok(results.find((r) => r.id === "explorer")!.ok);
    }
  });

  it("with no explorer nobody is asked and every block is read", async function () {
    const { client, asked } = quiet();
    let fetched = 0;
    const results = await runChecks({ client, boomerang: BOOMERANG, usdc: USDC, fromBlock: 0n, explorer: null, chunk: 100n, fetch: async () => (fetched++, verified) });
    assert.equal(fetched, 0);
    assert.equal(asked.length, 11);
    assert.ok(results.find((r) => r.id === "ledger")!.ok);
  });
});

