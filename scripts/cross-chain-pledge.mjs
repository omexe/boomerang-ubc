// One pledge from another chain, start to finish, from the command line:
//
//   PLEDGER_KEY_FILE=/path/to/key CAMPAIGN=12 node scripts/cross-chain-pledge.mjs [--send]
//
// It burns test USDC on a source testnet with Circle's CCTP V2, waits for Circle's attestation,
// and relays the attested message to the PledgeRouter on Arc Testnet, which turns the mint into
// a pledge in one transaction. These are the same three moves the page's flow functions make
// (web/src/flows/crossChain.ts); this script only strings them together and reads the result back.
//
// Without --send it changes nothing: it reads the campaign, the balances and Circle's fee, and
// says what it would do. With --send it asks each chain whether each call would succeed before
// it sends it.
//
// The key: a file holding one private key in hex, named by PLEDGER_KEY_FILE. The key is read,
// used to sign, and never printed, logged or written anywhere. Use a throwaway wallet that holds
// test money only. It needs test USDC and a little gas on the source chain, and a little USDC on
// Arc (Arc's gas) for the relay.
//
// Settings (environment):
//   PLEDGER_KEY_FILE  required with --send; without it, PLEDGER_ADDRESS is enough to look
//   PLEDGER_ADDRESS   the wallet to look at when no key file is given
//   CAMPAIGN          the campaign's number on Arc (required)
//   AMOUNT            USDC to burn, default 1.00
//   SOURCE            base-sepolia (default) or sepolia
//   SPEED             fast (default) or standard
//   BACKER            the address on Arc the pledge is credited to; default the wallet itself
//   BURN_TX           a burn already sent: skip the burn and carry on from the attestation
//   SOURCE_RPC_URL, ARC_RPC_URL   other nodes than the public ones
//
// Exit 0: done (or, without --send, nothing stood in the way). Exit 1: something failed or would
// fail. Exit 2: it was not told enough to start, said what is missing, and asked no network.
import { readFile } from "node:fs/promises";

import { createPublicClient, createWalletClient, formatUnits, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { addressesFor, arcTestnet, outcomeName, reader } from "../packages/kit/src/index.ts";
import { tokenAbi } from "../web/src/flows/calls.ts";
import { SOURCE_CHAINS } from "../web/src/flows/chains.ts";
import { FAST, STANDARD, burnCalls, fetchFeeRates, maxFeeFor, relayCall, waitForAttestation } from "../web/src/flows/crossChain.ts";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const SOURCES = { "base-sepolia": 84532, sepolia: 11155111 };
// A pledge that arrives after the campaign closes is not taken: the router sends the money to the
// backer on Arc instead. So the script will not start a burn this close to the close.
const NEED_SECONDS = { fast: 90n, standard: 25n * 60n };

// A USDC amount with at least two decimal places: 3 reads "3.00", 1.3 reads "1.30", 40.604077 stays as it is.
const usd = (v) => {
  const [whole, part = ""] = formatUnits(v, 6).split(".");
  return `${whole}.${part.padEnd(2, "0")}`;
};
const say = (line) => console.log(line);
function stop(code, line) {
  console.error(line);
  process.exit(code);
}

// ---- 1. What it was told. Nothing here touches a network. ----
const env = process.env;
const send = process.argv.includes("--send");
const unknown = process.argv.slice(2).filter((a) => a !== "--send");
if (unknown.length) stop(2, `unknown argument ${unknown[0]}; the only one is --send`);

if (!/^[0-9]{1,9}$/.test(env.CAMPAIGN ?? "")) stop(2, "CAMPAIGN must be the campaign's number on Arc, for example CAMPAIGN=12");
const campaignId = BigInt(env.CAMPAIGN);

const amountText = env.AMOUNT ?? "1.00";
if (!/^[0-9]{1,6}(\.[0-9]{1,6})?$/.test(amountText)) stop(2, "AMOUNT must be a USDC amount, for example AMOUNT=1.00");
const amount = parseUnits(amountText, 6);
if (amount <= 0n) stop(2, "AMOUNT must be more than zero");

const sourceName = env.SOURCE ?? "base-sepolia";
if (!(sourceName in SOURCES)) stop(2, "SOURCE must be base-sepolia or sepolia");
const source = SOURCE_CHAINS.find((s) => s.chain.id === SOURCES[sourceName]);

const speedName = env.SPEED ?? "fast";
if (speedName !== "fast" && speedName !== "standard") stop(2, "SPEED must be fast or standard");
const speed = speedName === "fast" ? FAST : STANDARD;

if (env.BURN_TX !== undefined && !HASH.test(env.BURN_TX)) stop(2, "BURN_TX is not a transaction hash");
if (env.BACKER !== undefined && !ADDRESS.test(env.BACKER)) stop(2, "BACKER is not an address");

let account = null;
let wallet;
if (env.PLEDGER_KEY_FILE) {
  let text;
  try {
    text = (await readFile(env.PLEDGER_KEY_FILE, "utf8")).trim();
  } catch {
    stop(2, "PLEDGER_KEY_FILE could not be read");
  }
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(text)) stop(2, "PLEDGER_KEY_FILE does not hold one private key in hex");
  try {
    account = privateKeyToAccount(text.startsWith("0x") ? text : `0x${text}`);
  } catch {
    // The library's own error carries the number it was given, so it is never shown.
    stop(2, "PLEDGER_KEY_FILE holds 64 hex digits that are not a usable private key");
  }
  wallet = account.address;
} else {
  if (send) stop(2, "--send needs PLEDGER_KEY_FILE, a file holding the throwaway wallet's key");
  if (!ADDRESS.test(env.PLEDGER_ADDRESS ?? "")) stop(2, "give PLEDGER_KEY_FILE, or PLEDGER_ADDRESS to look without sending");
  wallet = env.PLEDGER_ADDRESS;
}
const backer = env.BACKER ?? wallet;

let where;
try {
  where = addressesFor(arcTestnet.id);
} catch {
  stop(2, "Boomerang is not deployed on Arc Testnet by this repository's record");
}

// ---- 2. Read both chains and Circle. Nothing is sent yet. ----
const sourceRpc = env.SOURCE_RPC_URL ?? source.chain.rpcUrls.default.http[0];
const arcRpc = env.ARC_RPC_URL ?? arcTestnet.rpcUrls.default.http[0];
const sourceClient = createPublicClient({ chain: source.chain, transport: http(sourceRpc) });
const arcClient = createPublicClient({ chain: arcTestnet, transport: http(arcRpc) });
const fetchJson = async (url) => {
  const res = await fetch(url, { redirect: "error" });
  return { status: res.status, json: () => res.json() };
};

async function main() {
  const read = reader(arcClient, where.boomerang);
  const count = await read.campaignCount();
  if (campaignId === 0n || campaignId > count) stop(1, `there is no campaign ${campaignId} on Arc; the newest is ${count}`);
  const [terms, state, arcBlock] = await Promise.all([read.termsOf(campaignId), read.stateOf(campaignId), arcClient.getBlock()]);
  const now = arcBlock.timestamp;
  const left = terms.closesAt - now;

  say(`wallet        ${wallet}`);
  say(`credited to   ${backer} on Arc`);
  say(`campaign      ${campaignId}: target ${usd(terms.target)}, pledged ${usd(state.pledged)}, ${outcomeName(state.outcome)}`);
  say(`              opens ${terms.opensAt <= now ? "already" : `in ${terms.opensAt - now}s`}, closes in ${left > 0n ? `${left}s` : "the past"}`);

  const [sourceUsdc, sourceGas, arcUsdc, allowance, rates] = await Promise.all([
    sourceClient.readContract({ address: source.usdc, abi: tokenAbi, functionName: "balanceOf", args: [wallet] }),
    sourceClient.getBalance({ address: wallet }),
    arcClient.readContract({ address: where.usdc, abi: tokenAbi, functionName: "balanceOf", args: [wallet] }),
    sourceClient.readContract({ address: source.usdc, abi: tokenAbi, functionName: "allowance", args: [wallet, source.messenger] }),
    fetchFeeRates({ fetch: fetchJson, sourceDomain: source.domain }),
  ]);
  const rate = speed === FAST ? rates.fast : rates.standard;
  say(`on ${source.label}: ${usd(sourceUsdc)} USDC, ${formatUnits(sourceGas, 18)} ETH for gas`);
  say(`on Arc Testnet: ${usd(arcUsdc)} USDC (Arc's gas, for the relay)`);
  say(`Circle's fee, ${speedName}: ${rate === null ? "not offered on this route" : `${rate} basis points`}`);

  const problems = [];
  if (state.outcome !== 0) problems.push(`campaign ${campaignId} is already settled (${outcomeName(state.outcome)})`);
  if (!state.matchIn || !state.bonusIn) problems.push("the campaign's pots are not both locked yet");
  if (amount < terms.minPledge) problems.push(`the campaign takes no pledge under ${usd(terms.minPledge)}`);
  if (rate === null) problems.push(`Circle does not offer ${speedName} from ${source.label} to Arc`);
  if (env.BURN_TX === undefined) {
    if (left < NEED_SECONDS[speedName]) problems.push(`the campaign closes in ${left > 0n ? left : 0n}s, and a ${speedName} transfer needs about ${NEED_SECONDS[speedName]}s to be safe`);
    if (sourceUsdc < amount) problems.push(`the wallet holds ${usd(sourceUsdc)} USDC on ${source.label}; this burn needs ${usd(amount)}`);
    if (sourceGas === 0n) problems.push(`the wallet holds no ETH on ${source.label} to pay gas`);
  }
  if (arcUsdc === 0n) problems.push("the wallet holds no USDC on Arc to pay the relay's gas");
  if (problems.length) {
    for (const p of problems) console.error(`cannot go: ${p}`);
    process.exit(1);
  }

  const maxFee = maxFeeFor(amount, rate);
  say(`plan: burn ${usd(amount)} USDC on ${source.label} (Circle may keep up to ${usd(maxFee)}), wait for Circle, relay on Arc`);
  if (!send) {
    say("nothing sent. Run again with --send to do it.");
    return;
  }

  // ---- 3. Send. Each call is put to its chain as a question first. ----
  const sourceWallet = createWalletClient({ account, chain: source.chain, transport: http(sourceRpc) });
  const arcWallet = createWalletClient({ account, chain: arcTestnet, transport: http(arcRpc) });
  async function sendCall(client, walletClient, call) {
    const { request } = await client.simulateContract({ account, address: call.to, abi: call.abi, functionName: call.functionName, args: call.args });
    const hash = await walletClient.writeContract(request);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new Error(`"${call.label}" was mined and failed (${hash})`);
    say(`${call.label}: ${hash}`);
    return hash;
  }

  let burnTx = env.BURN_TX;
  if (burnTx === undefined) {
    const calls = burnCalls({ sourceUsdc: source.usdc, sourceMessenger: source.messenger, router: where.router, campaignId, backer, amount, allowance, maxFee, speed });
    for (const call of calls) burnTx = await sendCall(sourceClient, sourceWallet, call);
  }
  say(`burn on ${source.label}: ${burnTx}`);

  const started = Date.now();
  const attested = await waitForAttestation({
    fetch: fetchJson,
    sourceDomain: source.domain,
    txHash: burnTx,
    router: where.router,
    messenger: where.messenger,
    everyMs: 3_000,
    onTick: (a, waited) => {
      if (a.state === "waiting" && waited % 15_000 === 0) say(`waiting for Circle (${a.why}), ${Math.round((Date.now() - started) / 1000)}s`);
    },
  });
  say(`attested after ${Math.round((Date.now() - started) / 1000)}s: ${usd(attested.arrives)} USDC for campaign ${attested.campaignId}, credited to ${attested.backer}`);

  const before = await read.backerOf(campaignId, backer);
  const relayTx = await sendCall(arcClient, arcWallet, relayCall({ router: where.router, message: attested.message, attestation: attested.attestation }));

  // ---- 4. Read the result back from the contract. ----
  const [after, stateAfter] = await Promise.all([read.backerOf(campaignId, backer), read.stateOf(campaignId)]);
  const took = after.principal - before.principal;
  say(`relay on Arc:  ${relayTx}`);
  say(`the contract now holds ${usd(after.principal)} USDC pledged by ${backer} in campaign ${campaignId} (${usd(took)} from this pledge); the campaign stands at ${usd(stateAfter.pledged)} of ${usd(terms.target)}`);
  if (took === 0n) {
    say("the campaign took none of it (closed, full or under its minimum by then): the router sent the mint to the backer's address on Arc instead.");
    process.exit(1);
  }
  say(`Arc explorer:  ${arcTestnet.blockExplorers?.default.url ?? "https://explorer.testnet.arc.io"}/tx/${relayTx}`);
}

main().catch((e) => {
  // The first line only, and never a node's address: an RPC address can carry a key.
  const line = String(e?.shortMessage ?? e?.message ?? e).split("\n")[0].replace(/https?:\/\/\S+/g, "(address not shown)");
  stop(1, `failed: ${line}`);
});
