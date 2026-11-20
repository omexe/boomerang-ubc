// Routes, the wallet handshake and the loaders' pure parts, with no browser and no chain.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { arcTestnet } from "../../packages/kit/src/index.ts";
import { hrefFor, routeOf, type Route } from "../src/app/route.ts";
import { nameOf, readLabels } from "../src/data/labels.ts";
import { inBatches, totalsOf, type CampaignView } from "../src/data/load.ts";
import { addChainParams, connect, connected, declined, discover, ensureChain, type Provider } from "../src/wallet/injected.ts";
import { ownIn, type World } from "../src/app/world.ts";
import { oneAtATime } from "../src/flows/calls.ts";

describe("routes", function () {
  it("every route survives the trip to a hash and back", function () {
    const routes: Route[] = [{ page: "home" }, { page: "campaign", id: 3n }, { page: "pledge", id: 12n }, { page: "mine" }, { page: "proof" }];
    for (const r of routes) assert.deepEqual(routeOf(hrefFor(r)), r);
    assert.equal(hrefFor({ page: "pledge", id: 12n }), "#/campaign/12/pledge");
  });

  it("an empty hash is home, and slashes at the ends do not matter", function () {
    for (const h of ["", "#", "#/", "#//"]) assert.deepEqual(routeOf(h), { page: "home" });
    assert.deepEqual(routeOf("#/campaign/7/"), { page: "campaign", id: 7n });
    assert.deepEqual(routeOf("#mine"), { page: "mine" });
  });

  it("anything else is lost, and says what was asked for", function () {
    for (const h of ["#/campaign", "#/campaign/0", "#/campaign/-1", "#/campaign/1e3", "#/campaign/abc", "#/campaign/3/pledge/now", "#/campaign/1234567890123456789", "#/admin", "#/mine/2"]) {
      assert.deepEqual(routeOf(h), { page: "lost", hash: h });
    }
  });
});

/** A wallet that answers from a script and records what it was asked. */
function fakeWallet(o: { chainId: string; knows?: boolean; accounts?: unknown; refuse?: string }) {
  const asked: string[] = [];
  let chainId = o.chainId;
  let knows = o.knows ?? true;
  const provider: Provider = {
    async request({ method, params }) {
      asked.push(method);
      if (o.refuse === method) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      if (method === "eth_chainId") return chainId;
      if (method === "wallet_switchEthereumChain") {
        if (!knows) throw Object.assign(new Error("Unrecognized chain"), { code: 4902 });
        chainId = (params as { chainId: string }[])[0].chainId;
        return null;
      }
      if (method === "wallet_addEthereumChain") {
        knows = true;
        return null;
      }
      if (method === "eth_requestAccounts" || method === "eth_accounts") return o.accounts ?? [];
      throw new Error(`unexpected ${method}`);
    },
  };
  return { provider, asked, chainId: () => chainId };
}

describe("the wallet handshake", function () {
  const ARC = "0x4cef52";

  it("the chain's details are Arc Testnet's: id 5042002 in hex, USDC with 18 decimals as the gas currency", function () {
    assert.equal(ARC, `0x${(5042002).toString(16)}`);
    assert.deepEqual(addChainParams(arcTestnet), {
      chainId: ARC,
      chainName: "Arc Testnet",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: ["https://rpc.testnet.arc.io"],
      blockExplorerUrls: ["https://explorer.testnet.arc.io"],
    });
  });

  it("a wallet already on Arc is asked nothing more", async function () {
    const w = fakeWallet({ chainId: ARC });
    await ensureChain(w.provider, arcTestnet);
    assert.deepEqual(w.asked, ["eth_chainId"]);
  });

  it("a wallet on another chain that knows Arc is switched", async function () {
    const w = fakeWallet({ chainId: "0x1" });
    await ensureChain(w.provider, arcTestnet);
    assert.deepEqual(w.asked, ["eth_chainId", "wallet_switchEthereumChain"]);
    assert.equal(w.chainId(), ARC);
  });

  it("a wallet that does not know Arc is given its details, then switched", async function () {
    const w = fakeWallet({ chainId: "0x1", knows: false });
    await ensureChain(w.provider, arcTestnet);
    assert.deepEqual(w.asked, ["eth_chainId", "wallet_switchEthereumChain", "wallet_addEthereumChain", "eth_chainId", "wallet_switchEthereumChain"]);
    assert.equal(w.chainId(), ARC);
  });

  it("a person who says no is not asked again, and the refusal is recognisable", async function () {
    const w = fakeWallet({ chainId: "0x1", refuse: "wallet_switchEthereumChain" });
    await assert.rejects(ensureChain(w.provider, arcTestnet), (e) => declined(e));
    assert.deepEqual(w.asked, ["eth_chainId", "wallet_switchEthereumChain"]);
    assert.equal(declined(new Error("network down")), false);
  });

  it("connect gives the first account and refuses anything that is not an address", async function () {
    const a = "0x00000000000000000000000000000000000000A1";
    assert.equal(await connect(fakeWallet({ chainId: ARC, accounts: [a, "0x00000000000000000000000000000000000000b2"] }).provider), a);
    await assert.rejects(connect(fakeWallet({ chainId: ARC, accounts: [] }).provider), /no account/);
    await assert.rejects(connect(fakeWallet({ chainId: ARC, accounts: ["<img src=x>"] }).provider), /no account/);
    assert.equal(await connected(fakeWallet({ chainId: ARC, accounts: [] }).provider), null);
    assert.equal(await connected(fakeWallet({ chainId: ARC, accounts: [a] }).provider), a);
  });

  it("wallets that announce themselves are listed once each; a page-script icon is dropped; window.ethereum is the fallback", async function () {
    const listeners = new Set<(e: unknown) => void>();
    const p1 = fakeWallet({ chainId: ARC }).provider;
    const p2 = fakeWallet({ chainId: ARC }).provider;
    const win = {
      addEventListener: (_t: string, l: (e: unknown) => void) => void listeners.add(l),
      removeEventListener: (_t: string, l: (e: unknown) => void) => void listeners.delete(l),
      dispatchEvent: () => {
        for (const l of listeners) {
          l({ detail: { info: { name: "One", rdns: "io.one", icon: "data:image/svg+xml;base64,AAAA" }, provider: p1 } });
          l({ detail: { info: { name: "One", rdns: "io.one", icon: "data:image/svg+xml;base64,AAAA" }, provider: p1 } });
          l({ detail: { info: { name: "Two".repeat(40), rdns: "io.two", icon: "javascript:alert(1)" }, provider: p2 } });
          l({ detail: { info: { name: "Broken" }, provider: {} } });
        }
        return true;
      },
      ethereum: p1,
    };
    const found = await discover(win, (type) => ({ type }), 1);
    assert.deepEqual(found.map((f) => f.id), ["io.one", "io.two"]);
    assert.equal(found[0].icon, "data:image/svg+xml;base64,AAAA");
    assert.equal(found[1].icon, null);
    assert.equal(found[1].name.length, 40);
    assert.equal(listeners.size, 0);

    const quiet = { ...win, dispatchEvent: () => true };
    const legacy = await discover(quiet, (type) => ({ type }), 1);
    assert.deepEqual(legacy.map((f) => f.name), ["Browser wallet"]);
    assert.deepEqual(await discover({ ...quiet, ethereum: undefined }, (type) => ({ type }), 1), []);
  });
});

describe("loading", function () {
  it("batches keep the order of their answers and never run more than the width at once", async function () {
    let running = 0;
    let most = 0;
    const out = await inBatches([5, 1, 4, 2, 3, 0, 6], 3, async (n) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, n));
      running -= 1;
      return n * 10;
    });
    assert.deepEqual(out, [50, 10, 40, 20, 30, 0, 60]);
    assert.equal(most, 3);
  });

  it("the totals are sums over the campaigns given", function () {
    const view = (backers: number, pledged: bigint, bonusPaid: bigint) => ({ id: 1n, terms: {}, state: { backers, pledged, bonusPaid }, outcomeNow: 0 }) as unknown as CampaignView;
    assert.deepEqual(totalsOf([view(2, 100n, 0n), view(3, 60n, 7n)]), { campaigns: 2, backers: 5, pledged: 160n, bonusPaid: 7n });
    assert.deepEqual(totalsOf([]), { campaigns: 0, backers: 0, pledged: 0n, bonusPaid: 0n });
  });
});

describe("campaign names", function () {
  const SPONSOR = "0x00000000000000000000000000000000000000b1";
  const RECIPIENT = "0x00000000000000000000000000000000000000aa";
  const DESK = "0x00000000000000000000000000000000000000d5";
  const campaign = (id: bigint, sponsor: string = SPONSOR, recipient: string = RECIPIENT) =>
    ({ id, terms: { recipient }, state: { sponsor } }) as unknown as CampaignView;
  const file = [
    { id: "3", sponsor: SPONSOR.toUpperCase().replace("0X", "0x"), recipient: RECIPIENT, title: "  Send twelve of us to the regional in Austin.  ", by: "Westbrook Robotics Club", sponsorName: "Class of 2012 alumni fund", about: "Twelve students, one van.", example: true },
    { id: "4", sponsor: SPONSOR, recipient: RECIPIENT, title: "" },
    { id: "0", sponsor: SPONSOR, recipient: RECIPIENT, title: "zero" },
    { id: 5, sponsor: SPONSOR, recipient: RECIPIENT, title: "a number, not a string" },
    { id: "6", sponsor: "not an address", recipient: RECIPIENT, title: "bad sponsor" },
    "junk",
    null,
  ];

  it("a labels file keeps only its well-formed entries, trimmed", function () {
    const labels = readLabels(file);
    assert.equal(labels.length, 1);
    assert.equal(labels[0].id, 3n);
    assert.equal(labels[0].title, "Send twelve of us to the regional in Austin.");
    assert.deepEqual(readLabels({ not: "a list" }), []);
    assert.equal(readLabels([{ id: "7", sponsor: SPONSOR, recipient: RECIPIENT, title: "x".repeat(500) }])[0].title.length, 120);
    // A label's text has bidi controls and zero-width characters stripped, and control characters turned to a space.
    const nasty = readLabels([{ id: "7", sponsor: SPONSOR, recipient: RECIPIENT, title: "Safe‮evil‬", by: "a\u0000b" }])[0];
    assert.equal(nasty.title, "Safeevil");
    assert.equal(nasty.by, "a b");
  });

  it("a label is used only when the contract agrees on the sponsor and the recipient", function () {
    const labels = readLabels(file);
    const named = nameOf(labels, campaign(3n));
    assert.equal(named.title, "Send twelve of us to the regional in Austin.");
    assert.equal(named.by, "Westbrook Robotics Club");
    assert.equal(named.labelled, true);
    assert.equal(named.example, true);
    // Same id, another sponsor or another recipient (a redeployed contract, say): the label is not shown.
    for (const c of [campaign(3n, DESK), campaign(3n, SPONSOR, DESK)]) {
      const plain = nameOf(labels, c);
      assert.equal(plain.labelled, false);
      assert.equal(plain.title, "Campaign 3");
    }
  });

  it("a campaign with no label is named by its number and addresses; the demo desk's are named as demos", function () {
    const plain = nameOf([], campaign(9n));
    assert.deepEqual(plain, { title: "Campaign 9", by: "Paid to 0x0000…00aa", sponsorName: "0x0000…00b1", about: "", example: false, labelled: false });
    const demo = nameOf([], campaign(10n, DESK), DESK.toUpperCase().replace("0X", "0x") as `0x${string}`);
    assert.equal(demo.title, "Ten-minute campaign 10");
    // The desk's two kinds are told apart by how long the contract holds the campaign open.
    const timed = (openFor: bigint) => ({ id: 11n, terms: { recipient: RECIPIENT, opensAt: 1_000n, closesAt: 1_000n + openFor }, state: { sponsor: DESK } }) as unknown as CampaignView;
    assert.deepEqual([120n, 299n, 300n, 600n].map((openFor) => nameOf([], timed(openFor), DESK).title), ["Two-minute campaign 11", "Two-minute campaign 11", "Ten-minute campaign 11", "Ten-minute campaign 11"]);
    assert.equal(demo.example, true);
    assert.equal(nameOf([], campaign(10n, DESK), null).title, "Campaign 10");
  });
});

describe("whose figures, and one send at a time", function () {
  const ME = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  const OTHER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
  const world = { account: ME, mine: [{ id: 1n }], balance: 5_000_000n, allowance: 1_000_000n } as unknown as World;

  it("own.figures: a balance, an allowance and pledges are shown only to the account they were read for", function () {
    assert.deepEqual(ownIn(world, ME), { known: true, mine: world.mine, balance: 5_000_000n, allowance: 1_000_000n });
    // The wallet moved to another account and the next read has not landed: nothing of the old account's is shown.
    assert.deepEqual(ownIn(world, OTHER), { known: false, mine: [], balance: null, allowance: null });
    assert.deepEqual(ownIn(world, null), { known: false, mine: [], balance: null, allowance: null });
    assert.deepEqual(ownIn({ ...world, account: null, mine: [], balance: null, allowance: null }, ME), { known: false, mine: [], balance: null, allowance: null });
  });

  it("one.atATime: a second job asked for while the first is under way does not start; after it ends, the next one does", async function () {
    const run = oneAtATime();
    let started = 0;
    let release: () => void = () => {};
    const first = run(async () => {
      started += 1;
      await new Promise<void>((r) => (release = r));
      return "first";
    });
    const second = await run(async () => {
      started += 1;
      return "second";
    });
    assert.equal(second, null);
    assert.equal(started, 1);
    release();
    assert.equal(await first, "first");
    assert.equal(await run(async () => "third"), "third");
    // A job that throws frees the gate too.
    await assert.rejects(run(async () => Promise.reject(new Error("no"))));
    assert.equal(await run(async () => "fourth"), "fourth");
  });
});
