// The practice wallet: a key the page makes and keeps in the browser so a visitor without a wallet
// can try a pledge with test money. These tests hold it to the little it may do: give its one
// account, sign a pledge authorization for that account on this chain, send that account's own
// transactions, and pass on the chain's plain questions. Every key here is made in the test.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createWalletClient, custom, defineChain, parseTransaction, recoverTransactionAddress, verifyTypedData, type TransactionSerialized } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { authorization } from "../src/flows/signed.ts";
import { pledgeForm } from "../src/views/pledge.ts";
import { PRACTICE, practiceAccount, practiceOffer, practiceResult } from "../src/views/practice.ts";
import { shell, stepLine } from "../src/views/shell.ts";
import { browserKeyStore, practiceWallet, type KeyStore, type Rpc } from "../src/wallet/practice.ts";

type Hex = `0x${string}`;
const chain = defineChain({ id: 5042002, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.example.org"] } } });
const USDC = "0x3600000000000000000000000000000000000000" as const;
const HELPER = "0x00000000000000000000000000000000000000e1" as const;
const BOOMERANG = "0x00000000000000000000000000000000000000b0" as const;
const OTHER = "0x00000000000000000000000000000000000000a2" as const;

const memory = (start: Hex | null = null): KeyStore & { sets: number } => {
  let key = start;
  const store = { sets: 0, get: () => key, set: (k: Hex) => void ((key = k), (store.sets += 1)) };
  return store;
};
const silent: Rpc = async (method) => {
  throw new Error(`the test did not expect ${method}`);
};
const wallet = (store: KeyStore, rpc: Rpc = silent) => practiceWallet({ name: PRACTICE.name, chain, usdc: USDC, store, rpc });
const code = async (p: Promise<unknown>) => p.then(() => null, (e) => (e as { code?: number }).code ?? "no code");
const ask = (w: ReturnType<typeof wallet>, method: string, params?: unknown[]) => w.provider.request({ method, params });

describe("the practice wallet's key", function () {
  it("practice.none: until someone asks for it there is no key and no account", async function () {
    const store = memory();
    const w = wallet(store);
    assert.deepEqual(await ask(w, "eth_accounts"), []);
    assert.equal(store.get(), null);
    assert.equal(store.sets, 0);
    assert.equal(w.name, "Practice wallet");
    assert.equal(w.id, "practice-wallet");
  });

  it("practice.make: asking for the account makes the key once, and it is the same account from then on", async function () {
    const store = memory();
    const w = wallet(store);
    const [first] = (await ask(w, "eth_requestAccounts")) as string[];
    assert.match(first, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(store.sets, 1);
    assert.equal(privateKeyToAccount(store.get()!).address, first);
    assert.deepEqual(await ask(w, "eth_requestAccounts"), [first]);
    assert.deepEqual(await ask(w, "eth_accounts"), [first]);
    assert.equal(store.sets, 1, "the key is never made twice");
    // Another visit, the same storage: the same account, without asking.
    assert.deepEqual(await ask(wallet(store), "eth_accounts"), [first]);
    // Two browsers never share a key.
    const [second] = (await ask(wallet(memory()), "eth_requestAccounts")) as string[];
    assert.notEqual(second, first);
  });

  it("practice.store: a key kept in the browser's storage under the chain's own name; a damaged one is replaced, and storage that fails is done without", async function () {
    const kept = new Map<string, string>();
    const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
    const store = browserKeyStore(storage, 5042002);
    assert.equal(store.get(), null);
    const key = generatePrivateKey();
    store.set(key);
    assert.deepEqual([...kept.keys()], ["boomerang.practice.5042002"]);
    assert.equal(browserKeyStore(storage, 5042002).get(), key);
    assert.equal(browserKeyStore(storage, 31337).get(), null, "another chain has its own key");

    for (const damaged of ["hello", "0x12", `0x${"g".repeat(64)}`, `0x${"0".repeat(64)}`, ""]) {
      kept.set("boomerang.practice.5042002", damaged);
      assert.equal(browserKeyStore(storage, 5042002).get(), null, damaged);
    }
    const w = wallet(browserKeyStore(storage, 5042002));
    const [account] = (await ask(w, "eth_requestAccounts")) as string[];
    assert.equal(privateKeyToAccount(kept.get("boomerang.practice.5042002") as Hex).address, account);

    // A key read once is kept for the visit: storage is not read, and the key not worked out again, at every question.
    kept.set("boomerang.practice.5042002", key);
    let reads = 0;
    const counted = { getItem: (k: string) => (reads++, kept.get(k) ?? null), setItem: (k: string, v: string) => void kept.set(k, v) };
    const c = wallet(browserKeyStore(counted, 5042002));
    for (let i = 0; i < 5; i++) await ask(c, "eth_accounts");
    assert.equal(reads, 1);

    // A key written with a space after it is still the key, and is not replaced.
    kept.set("boomerang.practice.5042002", ` ${key}\n`);
    assert.equal(browserKeyStore(storage, 5042002).get(), key);
    // Storage that could not be read once is never written to in this visit: a key that may be there is not overwritten.
    let fail = true;
    const flaky = { getItem: (k: string): string | null => { if (fail) throw new Error("not now"); return kept.get(k) ?? null; }, setItem: (k: string, v: string) => void kept.set(k, v) };
    const f = wallet(browserKeyStore(flaky, 5042002));
    await ask(f, "eth_requestAccounts");
    fail = false;
    assert.equal(kept.get("boomerang.practice.5042002"), ` ${key}\n`, "what was in storage is still there");

    // Storage that throws (blocked, full) and no storage at all: the wallet works for this visit.
    const broken = { getItem: (): string | null => { throw new Error("blocked"); }, setItem: (): void => { throw new Error("full"); } };
    for (const s of [browserKeyStore(broken, 5042002), browserKeyStore(null, 5042002)]) {
      const v = wallet(s);
      assert.deepEqual(await ask(v, "eth_accounts"), []);
      const [a] = (await ask(v, "eth_requestAccounts")) as string[];
      assert.deepEqual(await ask(v, "eth_accounts"), [a]);
    }
  });
});

describe("what the practice wallet will do", function () {
  it("practice.chain: it is on this chain and no other", async function () {
    const w = wallet(memory());
    assert.equal(await ask(w, "eth_chainId"), "0x4cef52");
    assert.equal(await ask(w, "wallet_switchEthereumChain", [{ chainId: "0x4CEF52" }]), null);
    assert.equal(await code(ask(w, "wallet_switchEthereumChain", [{ chainId: "0x1" }])), 4902);
    assert.equal(await code(ask(w, "wallet_addEthereumChain", [{ chainId: "0x1" }])), 4200);
  });

  it("practice.signs: the pledge authorization the page asks for, signed as the page's own wallet client asks, verifies for its account", async function () {
    const w = wallet(memory());
    const [account] = (await ask(w, "eth_requestAccounts")) as Hex[];
    const a = authorization({ chainId: chain.id, usdc: USDC, helper: HELPER, backer: account, id: 7n, amount: 2_000_000n, now: 1_795_000_000n, closesAt: 1_795_000_500n, salt: `0x${"11".repeat(32)}` });
    const client = createWalletClient({ account, chain, transport: custom(w.provider) });
    const signature = await client.signTypedData({ account, ...a.typed });
    assert.equal(await verifyTypedData({ address: account, ...a.typed, signature }), true);
  });

  it("practice.refuses: it signs nothing but a pledge authorization for its own account on this chain, and sends only from its own account", async function () {
    const store = memory();
    const w = wallet(store);
    const typedFor = (from: Hex, over: Record<string, unknown> = {}) => {
      const a = authorization({ chainId: chain.id, usdc: USDC, helper: HELPER, backer: from, id: 7n, amount: 2_000_000n, now: 1_795_000_000n, closesAt: 1_795_000_500n, salt: `0x${"11".repeat(32)}` });
      const plain = JSON.parse(JSON.stringify({ ...a.typed, types: { EIP712Domain: [], ...a.typed.types } }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
      return JSON.stringify({ ...plain, ...over });
    };
    // Before a key exists it has no account to sign or send for.
    assert.equal(await code(ask(w, "eth_signTypedData_v4", [OTHER, typedFor(OTHER)])), 4100);
    assert.equal(await code(ask(w, "eth_sendTransaction", [{ from: OTHER, to: BOOMERANG, data: "0x" }])), 4100);
    assert.equal(store.get(), null, "a refusal never makes a key");

    const [me] = (await ask(w, "eth_requestAccounts")) as Hex[];
    assert.equal(typeof (await ask(w, "eth_signTypedData_v4", [me, typedFor(me)])), "string", "the real thing is signed");
    assert.equal(await code(ask(w, "eth_signTypedData_v4", [OTHER, typedFor(me)])), 4100, "for another account");
    assert.equal(await code(ask(w, "eth_signTypedData_v4", [me, typedFor(me, { primaryType: "Permit", types: { Permit: [{ name: "owner", type: "address" }] }, message: { owner: me } })])), 4200, "another kind of message");
    assert.equal(await code(ask(w, "eth_signTypedData_v4", [me, typedFor(me, { domain: { name: "USDC", version: "2", chainId: 1, verifyingContract: USDC } })])), 4200, "for another chain");
    assert.equal(await code(ask(w, "eth_signTypedData_v4", [me, typedFor(OTHER)])), 4200, "an authorization that moves another account's money");
    assert.equal(await code(ask(w, "eth_signTypedData_v4", [me, typedFor(me, { domain: { name: "USDC", version: "2", chainId: 5042002, verifyingContract: OTHER } })])), 4200, "on another token");
    assert.equal(await code(ask(w, "eth_signTypedData_v4", [me, typedFor(me, { domain: { name: "Other", version: "2", chainId: 5042002, verifyingContract: USDC } })])), 4200, "under another name");
    assert.equal(await code(ask(w, "eth_signTypedData_v4", [me, "not json"])), 4200);
    assert.equal(await code(ask(w, "eth_signTypedData_v4", [me])), 4200);
    for (const method of ["eth_sign", "personal_sign", "eth_signTransaction", "eth_signTypedData", "eth_signTypedData_v3", "wallet_getPermissions", "debug_traceCall", "hardhat_setBalance", "eth_sendRawTransaction"]) {
      assert.equal(await code(ask(w, method, [me, "0x00"])), 4200, method);
    }
    assert.equal(await code(ask(w, "eth_sendTransaction", [{ from: OTHER, to: BOOMERANG, data: "0x" }])), 4100, "from another account");
    assert.equal(await code(ask(w, "eth_sendTransaction", [])), 4100);
  });

  it("practice.sends: its own transaction is signed here with its key and goes to the node already signed", async function () {
    const raws: Hex[] = [];
    const rpc: Rpc = async (method, params) => {
      switch (method) {
        case "eth_chainId":
          return "0x4cef52";
        case "eth_getTransactionCount":
          return "0x3";
        case "eth_estimateGas":
          return "0x186a0";
        case "eth_getBlockByNumber":
          return { number: "0x10", baseFeePerGas: "0x4a817c800", timestamp: "0x6b000000", gasLimit: "0x1c9c380", gasUsed: "0x0", hash: `0x${"ab".repeat(32)}`, parentHash: `0x${"cd".repeat(32)}`, transactions: [] };
        case "eth_maxPriorityFeePerGas":
          return "0x12a05f200";
        case "eth_gasPrice":
          return "0x5d21dba00";
        case "eth_sendRawTransaction":
          raws.push(params[0] as Hex);
          return `0x${"77".repeat(32)}`;
        default: {
          const e = new Error(`the method ${method} does not exist`) as Error & { code: number };
          e.code = -32601;
          throw e;
        }
      }
    };
    const w = wallet(memory(), rpc);
    const [me] = (await ask(w, "eth_requestAccounts")) as Hex[];
    const hash = await ask(w, "eth_sendTransaction", [{ from: me, to: BOOMERANG, data: "0xabcdef01", gas: "0x30d40" }]);
    assert.equal(hash, `0x${"77".repeat(32)}`);
    assert.equal(raws.length, 1);
    const tx = parseTransaction(raws[0]);
    assert.equal(tx.to?.toLowerCase(), BOOMERANG);
    assert.equal(tx.data, "0xabcdef01");
    assert.equal(tx.chainId, 5042002);
    assert.equal(tx.nonce, 3);
    assert.equal(tx.gas, 200_000n, "the gas the page worked out is kept");
    assert.equal(tx.value ?? 0n, 0n);
    assert.equal((await recoverTransactionAddress({ serializedTransaction: raws[0] as TransactionSerialized })).toLowerCase(), me.toLowerCase());
  });

  it("practice.reads: the chain's plain questions go to the node as they came", async function () {
    const asked: { method: string; params: unknown[] }[] = [];
    const w = wallet(memory(), async (method, params) => {
      asked.push({ method, params });
      return "0x2a";
    });
    assert.equal(await ask(w, "eth_call", [{ to: USDC, data: "0x" }, "latest"]), "0x2a");
    assert.equal(await ask(w, "eth_getBalance", [OTHER, "latest"]), "0x2a");
    assert.equal(await ask(w, "eth_blockNumber"), "0x2a");
    assert.deepEqual(asked, [
      { method: "eth_call", params: [{ to: USDC, data: "0x" }, "latest"] },
      { method: "eth_getBalance", params: [OTHER, "latest"] },
      { method: "eth_blockNumber", params: [] },
    ]);
  });
});

describe("the practice wallet's words", function () {
  const ME = "0x00000000000000000000000000000000000000c3" as const;

  it("practice.offer: offered only where nobody is connected and it can be", function () {
    assert.deepEqual(practiceOffer({ account: null, offered: true, busy: false }), {
      button: "Try it with a practice wallet",
      note: "No wallet needed. This page keeps a key in this browser, and the site's desk gives a new one 2.00 test USDC. It is for test money only.",
      busy: false,
    });
    assert.equal(practiceOffer({ account: null, offered: true, busy: true })?.busy, true);
    assert.equal(practiceOffer({ account: null, offered: false, busy: false }), null);
    assert.equal(practiceOffer({ account: ME, offered: true, busy: false }), null);
    assert.equal(practiceAccount(ME), "Practice wallet 0x0000…00c3");
  });

  it("practice.result: what the notices say once it is set up", function () {
    assert.equal(practiceResult({ asked: false, desk: null }), null, "a wallet from an earlier visit is simply in use again");
    assert.deepEqual(practiceResult({ asked: true, desk: { ok: true, line: "The desk sent 2.00 USDC to your address." } }), { ok: true, line: "The practice wallet is ready, and the desk sent it 2.00 USDC. Type an amount and pledge." });
    assert.deepEqual(practiceResult({ asked: true, desk: { ok: false, line: "The desk is out of USDC for now. Circle's faucet gives USDC for Arc Testnet." } }), {
      ok: false,
      line: "The practice wallet is ready, but it has no USDC yet. The desk is out of USDC for now. Circle's faucet gives USDC for Arc Testnet.",
    });
    assert.deepEqual(practiceResult({ asked: true, desk: null }), { ok: false, line: "The practice wallet is ready, but the desk could not be asked for USDC. Its balance is empty until it is given some." });
  });

  it("practice.bar: the bar offers it where there is no wallet, names it while it is in use, and offers the visitor's own wallet back", function () {
    const base = { route: { page: "home" } as const, chain: { id: 5042002, name: "Arc Testnet", local: false }, walletChainId: null, block: 9n, readFailed: false };
    // No wallet in the browser: the note that nothing can be done gives way to the offer.
    assert.deepEqual(shell({ ...base, wallets: 0, account: null, practice: true }).wallet, { state: "practice", account: null, button: "Try a practice wallet", note: null });
    // No wallet and no offer: as before.
    assert.equal(shell({ ...base, wallets: 0, account: null }).wallet.state, "none");
    // A wallet in the browser: the bar still says connect; the offer is made on the page.
    assert.deepEqual(shell({ ...base, wallets: 1, account: null, practice: true }).wallet, { state: "connect", account: null, button: "Connect a wallet", note: null });
    // In use: named, never "wrong network"; with a wallet of their own in the browser, a way back to it.
    assert.deepEqual(shell({ ...base, wallets: 0, account: ME, walletChainId: 5042002, practising: true }).wallet, { state: "ready", account: "Practice wallet 0x0000…00c3", button: null, note: null });
    assert.deepEqual(shell({ ...base, wallets: 2, account: ME, walletChainId: 5042002, practising: true }).wallet, { state: "own", account: "Practice wallet 0x0000…00c3", button: "Use my own wallet", note: null });
  });

  it("practice.cheque: with no wallet in the browser the cheque's own button starts the practice wallet", function () {
    const terms = { recipient: OTHER, opensAt: 100n, earlyUntil: 200n, closesAt: 1000n, target: 3_000_000n, minPledge: 100_000n, matchAmount: 1_000_000n, bonusPool: 300_000n, rateBps: 2000, linearWeight: false, bonusFromRecipient: false };
    const state = { sponsor: OTHER, outcome: 0, matchIn: true, bonusIn: true, recipientPaid: false, matchReturned: false, bonusReturned: false, backers: 0, pledged: 0n, pledgedEarly: 0n, weighted: 0n, bonusPaid: 0n };
    const form = (over: { hasWallet: boolean; practice?: boolean }) =>
      pledgeForm({ campaign: { id: 1n, terms, state, outcomeNow: 0 }, where: { boomerang: BOOMERANG, usdc: USDC }, amountText: "2.00", now: 150n, account: null, balance: null, allowance: null, onRightChain: false, answer: null, ...over });
    const offered = form({ hasWallet: false, practice: true });
    assert.equal(offered.button, "Try it with a practice wallet");
    assert.ok(offered.blocks.includes(PRACTICE.note), offered.blocks.join(" | "));
    assert.ok(!offered.blocks.some((b) => /this browser has none/.test(b)));
    // Not offered: as before.
    assert.equal(form({ hasWallet: false }).button, "No wallet in this browser");
    // A wallet in the browser: the cheque's button connects it; the practice offer sits under it.
    assert.equal(form({ hasWallet: true, practice: true }).button, "Connect a wallet");
  });

  it("practice.steps: nothing tells a practice visitor to look at a wallet they do not have", function () {
    const asking = { index: 0, label: "Pledge", state: "asking" } as const;
    assert.equal(stepLine(asking, 1), "Pledge. Confirm it in your wallet.");
    assert.equal(stepLine(asking, 1, true), "Pledge. The practice wallet is sending it.");
    assert.equal(stepLine({ ...asking, index: 1 }, 2, true), "Step 2 of 2: Pledge. The practice wallet is sending it.");
    assert.equal(stepLine({ ...asking, state: "sent" }, 1, true), stepLine({ ...asking, state: "sent" }, 1));
    assert.equal(PRACTICE.signing, "The practice wallet is signing the pledge. A signature costs no gas.");
    assert.equal(PRACTICE.oneSignature, "The practice wallet signs it and the keeper sends it, so it costs no gas.");
  });
});
