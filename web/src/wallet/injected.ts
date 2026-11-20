// An ordinary browser wallet, reached the standard way (EIP-1193), with the two things a page on
// a new chain always has to do: find the wallet, and get it onto Arc Testnet.
import type { Chain } from "viem";

import type { Address } from "../../../packages/kit/src/index.ts";

export type Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
};

export type FoundWallet = { name: string; icon: string | null; id: string; provider: Provider };

/** What `wallet_addEthereumChain` is given for a chain. */
export function addChainParams(chain: Chain): {
  chainId: string;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls?: string[];
} {
  const explorer = chain.blockExplorers?.default.url;
  return {
    chainId: `0x${chain.id.toString(16)}`,
    chainName: chain.name,
    nativeCurrency: { name: chain.nativeCurrency.name, symbol: chain.nativeCurrency.symbol, decimals: chain.nativeCurrency.decimals },
    rpcUrls: [...chain.rpcUrls.default.http],
    ...(explorer ? { blockExplorerUrls: [explorer] } : {}),
  };
}

const code = (e: unknown): number | undefined => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "number" ? c : undefined;
};

/** The wallet's refusal, when the person said no (EIP-1193 code 4001). */
export function declined(e: unknown): boolean {
  return code(e) === 4001;
}

/**
 * Put the wallet on `chain`. If the wallet does not know the chain (code 4902), it is offered
 * the chain's details and asked again. Resolves once the wallet reports the chain; a refusal by
 * the person is passed up as it came.
 */
export async function ensureChain(provider: Provider, chain: Chain): Promise<void> {
  const want = `0x${chain.id.toString(16)}`;
  const current = await provider.request({ method: "eth_chainId" });
  if (typeof current === "string" && current.toLowerCase() === want) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  } catch (e) {
    // Some wallets wrap the code one level down.
    const unknown = code(e) === 4902 || code((e as { data?: { originalError?: unknown } } | null)?.data?.originalError) === 4902;
    if (!unknown) throw e;
    await provider.request({ method: "wallet_addEthereumChain", params: [addChainParams(chain)] });
    const after = await provider.request({ method: "eth_chainId" });
    if (typeof after !== "string" || after.toLowerCase() !== want) {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
    }
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Ask the wallet for its account. The first one is the one in use. */
export async function connect(provider: Provider): Promise<Address> {
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof first !== "string" || !ADDRESS.test(first)) throw new Error("the wallet gave no account");
  return first as Address;
}

/** The account the wallet already shares with this page, without asking; null if none. */
export async function connected(provider: Provider): Promise<Address | null> {
  const accounts = await provider.request({ method: "eth_accounts" });
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  return typeof first === "string" && ADDRESS.test(first) ? (first as Address) : null;
}

type Announcer = {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  dispatchEvent(event: unknown): boolean;
  ethereum?: unknown;
};

/**
 * The wallets installed in this browser. Wallets announce themselves (EIP-6963) when asked; one
 * that only sets `window.ethereum` is listed as "Browser wallet". `makeEvent` builds the request
 * event (`new Event("eip6963:requestProvider")` in a browser).
 */
export async function discover(win: Announcer, makeEvent: (type: string) => unknown, waitMs: number = 150): Promise<FoundWallet[]> {
  const found = new Map<string, FoundWallet>();
  const onAnnounce = (event: unknown) => {
    const d = (event as { detail?: { info?: { name?: unknown; icon?: unknown; uuid?: unknown; rdns?: unknown }; provider?: unknown } } | null)?.detail;
    const provider = d?.provider as Provider | undefined;
    if (!d?.info || !provider || typeof provider.request !== "function") return;
    const id = typeof d.info.rdns === "string" ? d.info.rdns : typeof d.info.uuid === "string" ? d.info.uuid : String(found.size);
    // A wallet's own name is shown as text; an icon is used only if it is an embedded image.
    const name = typeof d.info.name === "string" ? d.info.name.slice(0, 40) : "Wallet";
    const icon = typeof d.info.icon === "string" && d.info.icon.startsWith("data:image/") ? d.info.icon : null;
    if (!found.has(id)) found.set(id, { name, icon, id, provider });
  };
  win.addEventListener("eip6963:announceProvider", onAnnounce);
  try {
    win.dispatchEvent(makeEvent("eip6963:requestProvider"));
    await new Promise((r) => setTimeout(r, waitMs));
  } finally {
    win.removeEventListener("eip6963:announceProvider", onAnnounce);
  }
  const list = [...found.values()];
  const legacy = win.ethereum as Provider | undefined;
  if (list.length === 0 && legacy && typeof legacy.request === "function") {
    list.push({ name: "Browser wallet", icon: null, id: "window.ethereum", provider: legacy });
  }
  return list;
}
