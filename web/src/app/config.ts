// Where the app points: the chain, the three contracts and the keeper. Read once at start; a
// missing or malformed value stops the app there, naming the value, before any page is shown.
//
// On Arc Testnet the contract addresses come only from the kit's addresses file, the one the
// deploy script writes and `check-live` reads, so a build-time variable cannot point the hosted
// page at some other contract. Any other chain is a developer's local node: its RPC must be on
// this machine and its addresses are given in full.
import { addressesFor, arcTestnet, type Address } from "../../../packages/kit/src/index.ts";

export type Config = {
  chain: { id: number; name: string; rpcUrl: string; explorer: string | null; local: boolean };
  boomerang: Address;
  usdc: Address;
  router: Address;
  /** The demo desk's address, from the deployment (Arc) or VITE_DESK_ADDRESS (local); null when none. Only this names the desk's campaigns; the keeper's /health never does. */
  desk: Address | null;
  /** SignedPledge, the one-signature pledge helper, from the deployment (Arc) or VITE_SIGNED_PLEDGE (local); null when none, and the page then offers only the two-step pledge. */
  signedPledge: Address | null;
  /** The keeper's base URL, without a trailing slash; null when none is set (the feed is then unavailable). */
  keeperUrl: string | null;
  /** The block the contract was created in, where its events start; 0 on a local chain, or when the deployment did not record it. */
  deployBlock: bigint;
};

export class ConfigError extends Error {}

type Env = Readonly<Record<string, string | undefined>>;
type Deployed = (chainId: number) => { boomerang: Address; router: Address; usdc: Address; desk?: Address | null; signedPledge?: Address | null; deployBlock?: bigint | null };

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function url(env: Env, name: string, o: { localOnly: boolean }): string | null {
  const text = env[name];
  if (text === undefined || text === "") return null;
  // A bare "?" or "#" in the raw text is dropped by the URL parser, so refuse it on the text itself.
  if (/[?#]/.test(text)) throw new ConfigError(`${name} must not carry a query or a fragment`);
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new ConfigError(`${name} is not a URL`);
  }
  const local = LOCAL_HOSTS.has(u.hostname);
  if (u.username !== "" || u.password !== "") throw new ConfigError(`${name} must not carry a user name or password`);
  if (u.search !== "" || u.hash !== "") throw new ConfigError(`${name} must not carry a query or a fragment`);
  if (o.localOnly && !local) throw new ConfigError(`${name} must be on this machine (127.0.0.1 or localhost)`);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new ConfigError(`${name} must be https (http is allowed only on this machine)`);
  return u.toString().replace(/\/+$/, "");
}

function address(env: Env, name: string): Address {
  const text = env[name];
  if (text === undefined || !ADDRESS.test(text)) throw new ConfigError(`${name} must be an address (0x and 40 hex digits)`);
  return text as Address;
}

/** Build the app's configuration from build-time variables. Throws ConfigError naming the first bad value. */
export function configFrom(env: Env, deployed: Deployed = addressesFor): Config {
  const idText = env.VITE_CHAIN_ID;
  if (idText !== undefined && idText !== "" && !/^[1-9][0-9]{0,15}$/.test(idText)) throw new ConfigError("VITE_CHAIN_ID must be a whole number");
  const id = idText === undefined || idText === "" ? arcTestnet.id : Number(idText);

  if (id === arcTestnet.id) {
    for (const name of ["VITE_BOOMERANG", "VITE_USDC", "VITE_ROUTER", "VITE_RPC_URL", "VITE_DESK_ADDRESS", "VITE_SIGNED_PLEDGE"]) {
      if (env[name] !== undefined && env[name] !== "") throw new ConfigError(`${name} is for a local chain only; on Arc Testnet the app uses the deployed addresses file`);
    }
    let at: ReturnType<Deployed>;
    try {
      at = deployed(id);
    } catch (e) {
      throw new ConfigError(e instanceof Error ? e.message : "no deployment is recorded for Arc Testnet");
    }
    return {
      chain: { id, name: arcTestnet.name, rpcUrl: arcTestnet.rpcUrls.default.http[0], explorer: arcTestnet.blockExplorers.default.url, local: false },
      boomerang: at.boomerang,
      usdc: at.usdc,
      router: at.router,
      desk: at.desk ?? null,
      signedPledge: at.signedPledge ?? null,
      keeperUrl: url(env, "VITE_KEEPER_URL", { localOnly: false }),
      deployBlock: at.deployBlock ?? 0n,
    };
  }

  const rpcUrl = url(env, "VITE_RPC_URL", { localOnly: true });
  if (rpcUrl === null) throw new ConfigError("VITE_RPC_URL is needed for a local chain");
  return {
    chain: { id, name: `Local chain ${id}`, rpcUrl, explorer: null, local: true },
    boomerang: address(env, "VITE_BOOMERANG"),
    usdc: address(env, "VITE_USDC"),
    router: address(env, "VITE_ROUTER"),
    desk: env.VITE_DESK_ADDRESS === undefined || env.VITE_DESK_ADDRESS === "" ? null : address(env, "VITE_DESK_ADDRESS"),
    signedPledge: env.VITE_SIGNED_PLEDGE === undefined || env.VITE_SIGNED_PLEDGE === "" ? null : address(env, "VITE_SIGNED_PLEDGE"),
    keeperUrl: url(env, "VITE_KEEPER_URL", { localOnly: true }),
    deployBlock: 0n,
  };
}
