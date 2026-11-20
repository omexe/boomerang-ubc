// The practice wallet: a key this page makes and keeps in the browser, so a visitor with no
// wallet can try a pledge with test money. It is a wallet like any other to the rest of the app
// (the same `FoundWallet`, the same `send` and one-signature pledge), with these differences:
//
//   - the key is made here, the first time someone asks for the account, and kept in this
//     browser's storage under the chain's number. Anyone who can use this browser can use it, and
//     clearing the browser's data loses it. It is for test money only, and the page says so.
//   - it signs one kind of message: ReceiveWithAuthorization (the one-signature pledge) on the
//     app's own USDC, from its own account, on this chain. It rebuilds the message from the fields
//     of that one shape before signing, so nothing else can be slipped in.
//   - it sends only its own account's transactions, signed here and handed to the node already
//     signed; and it passes on the chain's plain `eth_` questions. Nothing else.
import { createWalletClient, custom, type Chain } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { AUTHORIZATION_TYPES, USDC_DOMAIN, type Address } from "../../../packages/kit/src/index.ts";
import type { FoundWallet, Provider } from "./injected.ts";

type Hex = `0x${string}`;

/** Where the key is kept. `get` is null until one has been made. */
export type KeyStore = { get(): Hex | null; set(key: Hex): void };

/** The node, asked one JSON-RPC question. */
export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export const PRACTICE_ID = "practice-wallet";

const KEY = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x[0-9a-fA-F]*$/;
const QUANTITY = /^0x[0-9a-fA-F]{1,64}$/;

// A key the curve accepts: 64 hex digits that make an account. Anything else is treated as no key.
function usable(stored: unknown): Hex | null {
  const text = typeof stored === "string" ? stored.trim() : "";
  if (!KEY.test(text)) return null;
  try {
    privateKeyToAccount(text as Hex);
    return text as Hex;
  } catch {
    return null;
  }
}

/**
 * The key's place in the browser's storage: `boomerang.practice.<chainId>`. A value there that is
 * not a usable key reads as none. Storage that is missing or throws (blocked, full) is done
 * without: the key then lives for this visit only. Storage that could not be read is not written
 * to either, so a key that may be there from an earlier visit is never overwritten unseen.
 */
export function browserKeyStore(storage: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null, chainId: number): KeyStore {
  const name = `boomerang.practice.${chainId}`;
  let held: Hex | null = null; // the key in use this visit: made here or read once, kept whether or not storage holds it
  let unreadable = false;
  return {
    get() {
      if (held !== null) return held;
      try {
        held = usable(storage?.getItem(name) ?? null);
        return held;
      } catch {
        unreadable = true;
        return null;
      }
    },
    set(key) {
      held = key;
      if (unreadable) return;
      try {
        storage?.setItem(name, key);
      } catch {
        // kept in memory for this visit
      }
    },
  };
}

class Refused extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}
const no = (message: string, code: number = 4200): never => {
  throw new Refused(message, code);
};

const same = (a: unknown, b: string): boolean => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

// A whole number written as a decimal string, a 0x quantity or a safe number: the three ways a
// page writes one into typed data.
function whole(v: unknown): bigint | null {
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v === "string" && (/^[0-9]{1,78}$/.test(v) || QUANTITY.test(v))) return BigInt(v);
  return null;
}

/**
 * The one message this wallet signs, rebuilt from the text it was handed: ReceiveWithAuthorization
 * on the app's USDC on this chain, moving this account's own money. Null for anything else.
 */
function pledgeAuthorization(text: unknown, me: Address, chainId: number, usdc: Address) {
  if (typeof text !== "string") return null;
  let data: { domain?: Record<string, unknown>; primaryType?: unknown; message?: Record<string, unknown> } | null;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || data.primaryType !== "ReceiveWithAuthorization") return null;
  const d = data.domain;
  const m = data.message;
  if (!d || typeof d !== "object" || !m || typeof m !== "object") return null;
  if (d.name !== USDC_DOMAIN.name || d.version !== USDC_DOMAIN.version || !same(d.verifyingContract, usdc)) return null;
  if (whole(d.chainId) !== BigInt(chainId)) return null;
  if (!same(m.from, me) || typeof m.to !== "string" || !ADDRESS.test(m.to)) return null;
  const value = whole(m.value);
  const validAfter = whole(m.validAfter);
  const validBefore = whole(m.validBefore);
  if (value === null || validAfter === null || validBefore === null || typeof m.nonce !== "string" || !KEY.test(m.nonce)) return null;
  return {
    domain: { ...USDC_DOMAIN, chainId, verifyingContract: usdc },
    types: AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization" as const,
    message: { from: me, to: m.to as Address, value, validAfter, validBefore, nonce: m.nonce as Hex },
  };
}

/** The practice wallet, as the app lists any wallet. `newKey` stands in for the key maker in tests. */
export function practiceWallet(o: { name: string; chain: Chain; usdc: Address; store: KeyStore; rpc: Rpc; newKey?: () => Hex }): FoundWallet {
  const here = `0x${o.chain.id.toString(16)}`;
  const account = () => {
    const key = o.store.get();
    return key === null ? null : privateKeyToAccount(key);
  };

  const provider: Provider = {
    async request({ method, params }) {
      const args = params ?? [];
      if (method === "eth_accounts") {
        const a = account();
        return a === null ? [] : [a.address];
      }
      if (method === "eth_requestAccounts") {
        if (o.store.get() === null) o.store.set((o.newKey ?? generatePrivateKey)());
        return [account()!.address];
      }
      if (method === "eth_chainId") return here;
      if (method === "wallet_switchEthereumChain") {
        const asked = (args[0] as { chainId?: unknown } | undefined)?.chainId;
        if (same(asked, here)) return null;
        return no("the practice wallet is only on this chain", 4902);
      }

      if (method === "eth_signTypedData_v4") {
        const a = account();
        if (a === null || !same(args[0], a.address)) return no("the practice wallet signs only for its own account", 4100);
        const typed = pledgeAuthorization(args[1], a.address, o.chain.id, o.usdc);
        if (typed === null) return no("the practice wallet signs only a pledge");
        return a.signTypedData(typed);
      }

      if (method === "eth_sendTransaction") {
        const a = account();
        const tx = args[0] as { from?: unknown; to?: unknown; data?: unknown; value?: unknown; gas?: unknown } | undefined;
        if (a === null || !tx || !same(tx.from, a.address)) return no("the practice wallet sends only from its own account", 4100);
        if (typeof tx.to !== "string" || !ADDRESS.test(tx.to)) return no("the practice wallet sends only to a contract's address");
        if (tx.data !== undefined && (typeof tx.data !== "string" || !HEX.test(tx.data))) return no("the practice wallet could not read that transaction");
        const value = tx.value === undefined ? 0n : whole(tx.value);
        const gas = tx.gas === undefined ? undefined : whole(tx.gas);
        if (value === null || gas === null) return no("the practice wallet could not read that transaction");
        // Signed here; the node is handed the signed transaction and never the key.
        const client = createWalletClient({ account: a, chain: o.chain, transport: custom({ request: ({ method: m, params: p }) => o.rpc(m, (p ?? []) as unknown[]) }) });
        return client.sendTransaction({ to: tx.to as Address, data: (tx.data ?? "0x") as Hex, value, ...(gas === undefined ? {} : { gas }) });
      }

      // The chain's own questions, and nothing that signs or sends by another road.
      if (!/^eth_[A-Za-z]+$/.test(method) || /^eth_(sign|send)/.test(method)) return no("the practice wallet does not do that");
      return o.rpc(method, args);
    },
  };
  return { name: o.name, icon: null, id: PRACTICE_ID, provider };
}
