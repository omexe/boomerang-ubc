// The whole app on one machine, for development and for looking at the page before anything is
// deployed. Nothing here touches Arc or any other network: it starts a local node, puts the test
// token and the contracts on it, makes example campaigns, and runs the keeper (with its demo
// desk, reading the local node as it reads Arc's) and the page's dev server.
//
//   node scripts/dev-local.mjs
//
// Stop it with Ctrl-C; everything it started stops with it. The keeper's files go in a temporary
// folder. The keeper's key is made here for this run, lives only in the keeper's environment,
// and is never printed or written.
//
// Every address it uses is 127.0.0.1. It takes no settings that could point it elsewhere.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { makeDemoCampaigns } from "./lib/demo.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const NODE_PORT = 8545;
const KEEPER_PORT = 8787;
const WEB_PORT = 5173;
const rpcUrl = `http://127.0.0.1:${NODE_PORT}`;
const keeperUrl = `http://127.0.0.1:${KEEPER_PORT}`;
const CHAIN_ID = 31337;
const USD = 1_000_000n;

const children = [];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill();
  process.exit(code);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

// Start one child. Its output is passed on with a short name in front (`mute` keeps only its
// errors, `quiet` drops matching lines); if it ends, everything ends.
function start(name, command, args, o) {
  const child = spawn(command, args, { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (text) => {
      if (o.mute && stream === child.stdout) return;
      for (const line of text.split("\n")) if (line.trim() !== "" && !(o.quiet && o.quiet.test(line))) console.log(`[${name}] ${line}`);
    });
  }
  child.on("exit", (code) => {
    if (!stopping) {
      console.error(`[${name}] stopped (exit ${code}); stopping everything`);
      stop(1);
    }
  });
  return child;
}

async function until(what, check, tries = 150) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await check()) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.error(`${what} did not come up`);
  stop(1);
}

const artifact = (path) => JSON.parse(readFileSync(join(root, "contracts/artifacts/contracts", path), "utf8"));

async function main() {
  let built;
  try {
    built = {
      usdc: artifact("test/TestUSDC.sol/TestUSDC.json"),
      boomerang: artifact("Boomerang.sol/Boomerang.json"),
      router: artifact("PledgeRouter.sol/PledgeRouter.json"),
      signedPledge: artifact("SignedPledge.sol/SignedPledge.json"),
    };
  } catch {
    console.error("The compiled contracts are not here. Build them first: cd contracts && npx hardhat build");
    process.exit(2);
  }

  // 1. A local node. Its accounts are unlocked and its keys are public test keys: worthless anywhere else.
  start("node", "npx", ["hardhat", "node", "--hostname", "127.0.0.1", "--port", String(NODE_PORT)], { cwd: join(root, "contracts"), mute: true }); // it logs every request; only its errors are shown
  const chain = defineChain({ id: CHAIN_ID, name: "Local chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  await until("the local node", async () => (await publicClient.getChainId()) === CHAIN_ID);
  const accounts = await publicClient.request({ method: "eth_accounts" });
  const [sponsorAddress, recipient, visitor] = accounts;
  const sponsor = createWalletClient({ account: sponsorAddress, chain, transport: http(rpcUrl) });

  // 2. The token and the contracts.
  const deploy = async (a, args) => {
    const hash = await sponsor.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
    return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress;
  };
  const write = async (address, abi, functionName, args) => {
    await publicClient.waitForTransactionReceipt({ hash: await sponsor.writeContract({ address, abi, functionName, args }) });
  };
  const usdc = await deploy(built.usdc, []);
  const boomerang = await deploy(built.boomerang, [usdc]);
  // Bringing USDC in from another chain cannot be tried on one machine; the router is deployed so
  // the page has its address, with stand-in addresses where Circle's contracts would be.
  const router = await deploy(built.router, [usdc, boomerang, accounts[18], accounts[19]]);
  // The one-signature pledge helper: the keeper relays a backer's signature through it.
  const signedPledge = await deploy(built.signedPledge, [usdc, boomerang]);

  // 3. Money: the sponsor of the examples, a visitor's wallet, and the keeper's own account (the desk).
  const keeperKey = generatePrivateKey();
  const desk = privateKeyToAccount(keeperKey).address;
  await write(usdc, built.usdc.abi, "mint", [sponsorAddress, 200n * USD]);
  await write(usdc, built.usdc.abi, "mint", [visitor, 50n * USD]);
  await write(usdc, built.usdc.abi, "mint", [desk, 20n * USD]);
  const fundGas = (address) => publicClient.request({ method: "hardhat_setBalance", params: [address, "0x8ac7230489e80000"] });
  await fundGas(desk);

  // 4. Example campaigns: one funded, one missed, and one left open for an hour. The chain's
  // clock is moved forward for the first two; afterwards a block is mined every second, so the
  // open one counts down as the page watches.
  const wait = async (untilTimestamp) => {
    const now = (await publicClient.getBlock()).timestamp;
    if (untilTimestamp > now) {
      await publicClient.request({ method: "evm_setNextBlockTimestamp", params: [`0x${untilTimestamp.toString(16)}`] });
      await publicClient.request({ method: "evm_mine", params: [] });
    }
  };
  const made = await makeDemoCampaigns({ publicClient, sponsor, boomerang, usdc, recipient, which: ["funded", "missed", "live"], wait, liveOpenFor: 3600n, fundGas, log: (line) => console.log(`[examples] ${line}`) });
  await publicClient.request({ method: "evm_setIntervalMining", params: [1000] });

  // 5. The keeper, with a signer and the demo desk. It reads this node itself every five seconds.
  start("keeper", "node", ["services/keeper/src/main.ts"], {
    cwd: root,
    env: {
      CHAIN_ID: String(CHAIN_ID),
      RPC_URL: rpcUrl,
      BOOMERANG_ADDRESS: boomerang,
      USDC_ADDRESS: usdc,
      SIGNED_PLEDGE_ADDRESS: signedPledge,
      KEEPER_PRIVATE_KEY: keeperKey,
      DEMO_RECIPIENT: recipient,
      PORT: String(KEEPER_PORT),
      KEEPER_DATA: mkdtempSync(join(tmpdir(), "boomerang-keeper-")),
    },
    quiet: /^(GET|OPTIONS) \/(ledger|health|relay) 20[04]$/,
  });
  await until("the keeper", async () => (await fetch(`${keeperUrl}/health`)).status === 200);

  // 6. The page.
  start("web", "npx", ["vite", "--host", "127.0.0.1", "--port", String(WEB_PORT), "--strictPort"], {
    cwd: join(root, "web"),
    env: {
      VITE_CHAIN_ID: String(CHAIN_ID),
      VITE_RPC_URL: rpcUrl,
      VITE_BOOMERANG: boomerang,
      VITE_USDC: usdc,
      VITE_ROUTER: router,
      VITE_SIGNED_PLEDGE: signedPledge,
      VITE_KEEPER_URL: keeperUrl,
      VITE_DESK_ADDRESS: desk,
      VITE_DEV_WALLET: visitor,
    },
  });
  await until("the page", async () => (await fetch(`http://127.0.0.1:${WEB_PORT}/`)).status === 200);

  console.log("");
  console.log(`page      http://127.0.0.1:${WEB_PORT}/`);
  console.log(`keeper    ${keeperUrl}/health`);
  console.log(`node      ${rpcUrl} (chain ${CHAIN_ID})`);
  console.log(`contract  ${boomerang}   token ${usdc}`);
  console.log(`relay     one-signature pledges through ${signedPledge}`);
  console.log(`examples  ${made.map((m) => `${m.kind} #${m.id}`).join(", ")}`);
  console.log(`visitor   ${visitor} holds 50 test USDC; the page offers it as "Local test wallet"`);
  console.log("Ctrl-C stops everything.");
}

main().catch((e) => {
  console.error(String(e?.message ?? e).split("\n")[0]);
  stop(1);
});
