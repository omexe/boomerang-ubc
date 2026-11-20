// A stand-in wallet for a developer's local chain, so the page can be tried end to end on one
// machine with no browser extension. It holds no key: it names one of the local node's unlocked
// test accounts, sends that account's transactions through the node (which signs for it), and
// passes on the plain questions a page asks of a chain. It passes on nothing else but one kind of
// signature, typed data (eth_signTypedData_v4) for that same account, which the one-signature
// pledge asks for: no other message signing, and none of the node's own controls.
//
// It exists only when the app is pointed at a local chain. The configuration already refuses a
// local chain whose RPC is not on this machine, so this wallet can never reach a real network,
// and on Arc Testnet setting it stops the app at start.
import type { Address } from "../../../packages/kit/src/index.ts";
import { ConfigError, type Config } from "../app/config.ts";
import type { FoundWallet, Provider } from "./injected.ts";

type Env = Readonly<Record<string, string | undefined>>;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The local test account named by VITE_DEV_WALLET, or null when none is set. Throws ConfigError when it is set for a chain that is not local, or is not an address. */
export function devWalletFrom(env: Env, config: Config): Address | null {
  const text = env.VITE_DEV_WALLET;
  if (text === undefined || text === "") return null;
  if (!config.chain.local) throw new ConfigError("VITE_DEV_WALLET is for a local chain only");
  if (!ADDRESS.test(text)) throw new ConfigError("VITE_DEV_WALLET must be an address (0x and 40 hex digits)");
  return text as Address;
}

export type RpcFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<{ json(): Promise<unknown> }>;

class RpcError extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

/** The wallet the page lists for a local chain. `name` is what the chooser shows. */
export function devWallet(o: { name: string; address: Address; chainId: number; rpcUrl: string; fetch: RpcFetch }): FoundWallet {
  const here = `0x${o.chainId.toString(16)}`;
  let next = 1;
  const provider: Provider = {
    async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [o.address];
      if (method === "eth_chainId") return here;
      if (method === "wallet_switchEthereumChain") {
        const asked = (params?.[0] as { chainId?: unknown } | undefined)?.chainId;
        if (typeof asked === "string" && asked.toLowerCase() === here) return null;
        throw new RpcError("this wallet is only on the local chain", 4902);
      }
      if (method === "wallet_addEthereumChain") throw new RpcError("this wallet is only on the local chain", 4200);
      // Only the chain's own `eth_` questions and this account's transactions go to the local node.
      const typedData = method === "eth_signTypedData_v4";
      if (!typedData && (!/^eth_[A-Za-z]+$/.test(method) || /^eth_sign/.test(method))) throw new RpcError("this wallet does not do that", 4200);
      if (typedData) {
        const who = params?.[0];
        if (typeof who !== "string" || who.toLowerCase() !== o.address.toLowerCase()) throw new RpcError("this wallet signs only for its own account", 4100);
      }
      if (method === "eth_sendTransaction") {
        const from = (params?.[0] as { from?: unknown } | undefined)?.from;
        if (typeof from !== "string" || from.toLowerCase() !== o.address.toLowerCase()) throw new RpcError("this wallet sends only from its own account", 4100);
      }
      const res = await o.fetch(o.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: next++, method, params: params ?? [] }) });
      const answer = (await res.json()) as { result?: unknown; error?: { message?: unknown; code?: unknown; data?: unknown } } | null;
      if (answer === null || typeof answer !== "object") throw new RpcError("the local node gave no answer", -32603);
      if (answer.error) {
        const e = new RpcError(typeof answer.error.message === "string" ? answer.error.message : "the local node refused the request", typeof answer.error.code === "number" ? answer.error.code : -32603);
        (e as RpcError & { data?: unknown }).data = answer.error.data;
        throw e;
      }
      return answer.result;
    },
  };
  return { name: o.name, icon: null, id: "local-test-wallet", provider };
}
