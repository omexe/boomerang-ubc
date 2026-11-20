// Every amount, address and time in these tests is invented. None is a reading of any real campaign.
//
// The deployment and verification scripts, driven against Hardhat's in-memory chain. Each test's
// outputs (a copy of addresses.json) go to a fresh temp directory, never into the repo.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { network } from "hardhat";
import { encodeAbiParameters, encodeEventTopics, getAbiItem, toFunctionSelector } from "viem";
import type { Abi, AbiEvent, AbiParameter, Address, PublicClient, WalletClient } from "viem";

import { checkLive } from "../../scripts/lib/check.ts";
import { deployAll } from "../../scripts/lib/deploy.ts";
import { liveDaysFrom, makeDemoCampaigns } from "../../scripts/lib/demo.ts";
import { Outcome, setup, USD } from "./helpers.ts";

const ARTIFACT_URL = new URL("../artifacts/contracts/Boomerang.sol/Boomerang.json", import.meta.url);
const ADDRESSES_URL = new URL("../../packages/kit/addresses.json", import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BoomerangArtifact: any = JSON.parse(readFileSync(ARTIFACT_URL, "utf8"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SignedPledgeArtifact: any = JSON.parse(readFileSync(new URL("../artifacts/contracts/SignedPledge.sol/SignedPledge.json", import.meta.url), "utf8"));
const boomerangAbi = BoomerangArtifact.abi as Abi;
const PledgedEvent = getAbiItem({ abi: boomerangAbi, name: "Pledged" }) as AbiEvent;
const CampaignCreatedEvent = getAbiItem({ abi: boomerangAbi, name: "CampaignCreated" }) as AbiEvent;
const PaidEvent = getAbiItem({ abi: boomerangAbi, name: "Paid" }) as AbiEvent;

const TRANSMITTER = "0x00000000000000000000000000000000000000a1" as Address;
const MESSENGER = "0x00000000000000000000000000000000000000b2" as Address;
const BACKER = "0x00000000000000000000000000000000000000c1" as Address;

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Flip one hex character of a hex body to a different one (xor the low bit of its nibble).
function flipHexChar(body: string, index: number): string {
  const nibble = parseInt(body[index], 16);
  const other = (nibble ^ 1).toString(16);
  return body.slice(0, index) + other + body.slice(index + 1);
}

describe("deploy", function () {
  it("deploy.outputs: deploys the contracts, updates addresses.json, and records the right deploy block", async function () {
    const { viem } = await network.create();
    const publicClient = await viem.getPublicClient();
    const usdc = await viem.deployContract("TestUSDC");

    const dir = tmp("boomerang-deploy-");
    const addressesPath = join(dir, "addresses.json");
    const original = readFileSync(ADDRESSES_URL, "utf8");
    writeFileSync(addressesPath, original);

    const out = await deployAll({ viem, chainId: 99999, usdc: usdc.address, transmitter: TRANSMITTER, messenger: MESSENGER, addressesPath });

    // The returned addresses hold code.
    assert.ok(((await publicClient.getCode({ address: out.boomerang })) ?? "0x").length > 2);
    assert.ok(((await publicClient.getCode({ address: out.router })) ?? "0x").length > 2);

    // addresses.json: the new chain has the five addresses and deployBlock; every other key stays.
    const writtenText = readFileSync(addressesPath, "utf8");
    assert.ok(writtenText.endsWith("}\n"), "trailing newline");
    assert.ok(writtenText.includes('  "99999"'), "two-space indentation");
    const written = JSON.parse(writtenText);
    assert.deepEqual(written["5042002"], JSON.parse(original)["5042002"], "the untouched chain is preserved");
    const e = written["99999"];
    assert.equal(e.boomerang.toLowerCase(), out.boomerang.toLowerCase());
    assert.equal(e.router.toLowerCase(), out.router.toLowerCase());
    assert.equal(e.usdc.toLowerCase(), usdc.address.toLowerCase());
    assert.equal(e.transmitter.toLowerCase(), TRANSMITTER.toLowerCase());
    assert.equal(e.messenger.toLowerCase(), MESSENGER.toLowerCase());
    assert.equal(e.deployBlock, out.deployBlock.toString());

    // addresses.json also records the transaction that created Boomerang, and it matches the output.
    assert.match(out.boomerangTx, /^0x[0-9a-fA-F]{64}$/, "the output carries the creation transaction hash");
    assert.equal(e.boomerangTx, out.boomerangTx, "addresses.json records the same boomerangTx");

    // The one-signature pledge helper went up beside them, bound to this token and this Boomerang.
    assert.equal(e.signedPledge.toLowerCase(), out.signedPledge.toLowerCase());
    const helper = await viem.getContractAt("SignedPledge", out.signedPledge);
    assert.equal((await helper.read.usdc()).toLowerCase(), usdc.address.toLowerCase());
    assert.equal((await helper.read.boomerang()).toLowerCase(), out.boomerang.toLowerCase());

    // That hash, fed to checkLive against the freshly deployed contract, passes the creation row.
    const creationRows = await checkLive({ client: publicClient, boomerang: out.boomerang, usdc: usdc.address, fromBlock: 0n, artifact: BoomerangArtifact, deployTx: out.boomerangTx });
    const creationRow = creationRows.find((r) => r.name === "creation")!;
    assert.ok(creationRow.ok, creationRow.detail);
    assert.match(creationRow.detail, new RegExp(out.boomerangTx), "the creation row names the transaction hash");

    // deploy.block: the recorded deployBlock really is the block Boomerang went up in, proven by
    // code presence at that block and absence the block before, not by trusting the number. The
    // router is deployed in a later block, so it has no code yet at Boomerang's deploy block.
    const deployBlock = BigInt(written["99999"].deployBlock);
    assert.equal((await publicClient.getCode({ address: out.boomerang, blockNumber: deployBlock - 1n })) ?? "0x", "0x", "boomerang has no code the block before");
    assert.ok(((await publicClient.getCode({ address: out.boomerang, blockNumber: deployBlock })) ?? "0x").length > 2, "boomerang has code at its deploy block");
    assert.equal((await publicClient.getCode({ address: out.router, blockNumber: deployBlock })) ?? "0x", "0x", "the router is deployed in a later block");
  });

  it("deploy.keep: an existing key on this chain's entry, and another chain's entry, survive the write", async function () {
    const { viem } = await network.create();
    const usdc = await viem.deployContract("TestUSDC");
    const dir = tmp("boomerang-keep-");
    const addressesPath = join(dir, "addresses.json");
    // Seed this chain with an extra key, plus a second chain that must be left alone.
    const seed = { "99999": { note: "keep me" }, "777": { boomerang: "0xdead", usdc: "0xbeef" } };
    writeFileSync(addressesPath, JSON.stringify(seed, null, 2) + "\n");

    await deployAll({ viem, chainId: 99999, usdc: usdc.address, transmitter: TRANSMITTER, messenger: MESSENGER, addressesPath });

    const written = JSON.parse(readFileSync(addressesPath, "utf8"));
    assert.equal(written["99999"].note, "keep me", "the extra key on this chain's entry is kept");
    assert.deepEqual(written["777"], seed["777"], "the other chain's entry is untouched");
  });

});

describe("checkLive", function () {
  it("check.pass: after real actions on a missed, finalized, partly-paid campaign, all five rows pass", async function () {
    // setup() deploys a Boomerang without keeping its creation hash, and the creation row needs it,
    // so deploy a fresh one here with sendDeploymentTransaction and drive the same flow against it.
    const w = await setup();
    const { contract: boomerang, deploymentTransaction } = await w.viem.sendDeploymentTransaction("Boomerang", [w.usdc.address]);
    await w.publicClient.waitForTransactionReceipt({ hash: deploymentTransaction.hash });
    const deployTx = deploymentTransaction.hash;

    const t = await w.terms();
    await boomerang.write.createCampaign([t], { account: w.sponsor.account });
    const id = await boomerang.read.campaignCount();
    await w.usdc.write.mint([w.sponsor.account.address, t.matchAmount]);
    await w.usdc.write.approve([boomerang.address, t.matchAmount], { account: w.sponsor.account });
    await boomerang.write.fundMatch([id], { account: w.sponsor.account });
    await w.usdc.write.mint([w.sponsor.account.address, t.bonusPool]);
    await w.usdc.write.approve([boomerang.address, t.bonusPool], { account: w.sponsor.account });
    await boomerang.write.fundBonus([id], { account: w.sponsor.account });

    const pledge = async (who: typeof w.alice, amount: bigint, at: bigint) => {
      await w.usdc.write.mint([who.account.address, amount]);
      await w.usdc.write.approve([boomerang.address, amount], { account: who.account });
      await w.time.setNextBlockTimestamp(at);
      await boomerang.write.pledge([id, amount], { account: who.account });
    };
    await pledge(w.alice, 30n * USD, t.opensAt + 10n);
    await pledge(w.bob, 20n * USD, t.opensAt + 20n); // 50 against a 100 target: the campaign misses
    await w.time.increaseTo(t.closesAt);
    await boomerang.write.finalize([id], { account: w.stranger.account });
    await boomerang.write.pay([id, w.alice.account.address], { account: w.stranger.account });

    const rows = await checkLive({ client: w.publicClient, boomerang: boomerang.address, usdc: w.usdc.address, fromBlock: 0n, artifact: BoomerangArtifact, deployTx });
    assert.deepEqual(rows.map((r) => r.name), ["code", "creation", "no-owner", "custody", "ledger"]);
    for (const r of rows) assert.ok(r.ok, `${r.name} should pass: ${r.detail}`);
    // The opcode scan on the real deployed code finds none of the forbidden opcodes.
    assert.match(rows.find((r) => r.name === "no-owner")!.detail, /no CALLCODE, DELEGATECALL, SELFDESTRUCT/);
    // The creation row names the transaction that created the contract.
    assert.match(rows.find((r) => r.name === "creation")!.detail, new RegExp(deployTx), "the creation row names the transaction hash");
  });

  it("check.helper: with the helper named, a sixth row checks its code and that it is bound to this token and this Boomerang", async function () {
    const w = await setup();
    const rows = (helper: Address) =>
      checkLive({ client: w.publicClient, boomerang: w.boomerang.address, usdc: w.usdc.address, fromBlock: 0n, artifact: BoomerangArtifact, helper: { address: helper, artifact: SignedPledgeArtifact } });
    const row = async (helper: Address) => (await rows(helper)).find((r) => r.name === "signed-pledge")!;
    const good = await w.viem.deployContract("SignedPledge", [w.usdc.address, w.boomerang.address]);
    assert.deepEqual((await rows(good.address)).map((r) => r.name), ["code", "creation", "no-owner", "custody", "ledger", "signed-pledge"]);
    const ok = await row(good.address);
    assert.ok(ok.ok, ok.detail);
    const other = await w.viem.deployContract("Boomerang", [w.usdc.address]);
    const elsewhere = await w.viem.deployContract("SignedPledge", [w.usdc.address, other.address]);
    const r1 = await row(elsewhere.address);
    assert.equal(r1.ok, false);
    assert.match(r1.detail, /boomerang/i);
    const token = await w.viem.deployContract("TestUSDC");
    const wrongToken = await w.viem.deployContract("SignedPledge", [token.address, w.boomerang.address]);
    assert.equal((await row(wrongToken.address)).ok, false);
    const r3 = await row(BACKER);
    assert.equal(r3.ok, false);
    assert.match(r3.detail, /no runtime code/);
    // Compiled code with the right getters but another Boomerang in one of the slots the calls use fails.
    const code = (await w.publicClient.getCode({ address: good.address }))!.replace(/^0x/, "");
    const slots = Object.values(SignedPledgeArtifact.immutableReferences as Record<string, { start: number; length: number }[]>).find((r) => r.length > 0 && code.slice(r[0].start * 2, (r[0].start + r[0].length) * 2).endsWith(w.boomerang.address.slice(2).toLowerCase()))!;
    const last = slots[slots.length - 1];
    const forged = code.slice(0, last.start * 2) + other.address.slice(2).toLowerCase().padStart(64, "0") + code.slice((last.start + last.length) * 2);
    const FORGED = "0x00000000000000000000000000000000000f0f0f" as Address;
    await w.publicClient.request({ method: "hardhat_setCode" as never, params: [FORGED, `0x${forged}`] as never });
    const r5 = await row(FORGED);
    assert.equal(r5.ok, false, r5.detail);
    // Another contract's code at the address fails even before its immutables are read.
    const r4 = await row(other.address);
    assert.equal(r4.ok, false);
    // Without a helper named, the five rows stay five.
    assert.equal((await checkLive({ client: w.publicClient, boomerang: w.boomerang.address, usdc: w.usdc.address, fromBlock: 0n, artifact: BoomerangArtifact })).length, 5);
  });

  it("check.custody: a token the contract holds none of fails the custody row; code and ledger still pass", async function () {
    const w = await setup();
    const { id, t } = await w.open();
    await w.pledge(id, w.alice, 30n * USD, t.opensAt + 10n);
    // Keep the real token (so code and ledger stand), but answer balanceOf with 0 so custody fails.
    const client = {
      ...w.publicClient,
      readContract: (args: { functionName: string }) =>
        args.functionName === "balanceOf" ? Promise.resolve(0n) : w.publicClient.readContract(args as never),
    } as unknown as PublicClient;
    const rows = await checkLive({ client, boomerang: w.boomerang.address, usdc: w.usdc.address, fromBlock: 0n, artifact: BoomerangArtifact });
    assert.equal(rows.find((r) => r.name === "custody")!.ok, false);
    assert.ok(rows.find((r) => r.name === "code")!.ok, rows.find((r) => r.name === "code")!.detail);
    assert.ok(rows.find((r) => r.name === "ledger")!.ok, rows.find((r) => r.name === "ledger")!.detail);
  });

  it("check.token: the code row fails for the wrong token and passes byte-for-byte for the built-in one", async function () {
    const { viem } = await network.create();
    const publicClient = await viem.getPublicClient();
    const tokenA = await viem.deployContract("TestUSDC");
    const tokenB = await viem.deployContract("TestUSDC");
    const b = await viem.deployContract("Boomerang", [tokenA.address]);

    const wrong = await checkLive({ client: publicClient, boomerang: b.address, usdc: tokenB.address, fromBlock: 0n, artifact: BoomerangArtifact });
    const wrongCode = wrong.find((r) => r.name === "code")!;
    assert.equal(wrongCode.ok, false);
    assert.match(wrongCode.detail, /the token built into the contract is/);

    const right = await checkLive({ client: publicClient, boomerang: b.address, usdc: tokenA.address, fromBlock: 0n, artifact: BoomerangArtifact });
    const rightCode = right.find((r) => r.name === "code")!;
    assert.ok(rightCode.ok, rightCode.detail);
    assert.match(rightCode.detail, /byte for byte/);
  });

  it("check.metadata: a metadata-only change still passes; an instruction change or missing immutables fail", async function () {
    const w = await setup();
    const body = (BoomerangArtifact.deployedBytecode as string).replace(/^0x/, "");
    // The last two bytes (four hex chars) are the metadata blob's length n; the blob is the final
    // n+2 bytes. A hex char well inside the blob but clear of those last two bytes is metadata only.
    const blobLen = (parseInt(body.slice(-4), 16) + 2) * 2; // hex chars of the blob
    const metaIdx = body.length - blobLen + Math.floor((blobLen - 4) / 2); // inside the blob, not the length word
    const metaArtifact = { ...BoomerangArtifact, deployedBytecode: `0x${flipHexChar(body, metaIdx)}` };
    const codeArtifact = { ...BoomerangArtifact, deployedBytecode: `0x${flipHexChar(body, 0)}` }; // first byte: an instruction, outside every immutable slot
    const noImmutables = { ...BoomerangArtifact, immutableReferences: undefined };

    const meta = await checkLive({ client: w.publicClient, boomerang: w.boomerang.address, usdc: w.usdc.address, fromBlock: 0n, artifact: metaArtifact });
    const metaCode = meta.find((r) => r.name === "code")!;
    assert.ok(metaCode.ok, metaCode.detail);
    assert.match(metaCode.detail, /source metadata differs/);

    const codeChg = await checkLive({ client: w.publicClient, boomerang: w.boomerang.address, usdc: w.usdc.address, fromBlock: 0n, artifact: codeArtifact });
    assert.equal(codeChg.find((r) => r.name === "code")!.ok, false);

    const none = await checkLive({ client: w.publicClient, boomerang: w.boomerang.address, usdc: w.usdc.address, fromBlock: 0n, artifact: noImmutables });
    const noneCode = none.find((r) => r.name === "code")!;
    assert.equal(noneCode.ok, false);
    assert.match(noneCode.detail, /no immutable slots/);
  });

  it("check.opcodes: the no-owner row names a forbidden opcode in the instructions but not in PUSH data, and the metadata length it trims comes from the artifact", async function () {
    const w = await setup();
    // The scan trims the artifact's metadata length off the end before looking at opcodes, so the
    // hand-made codes carry a tail of exactly that length; the instructions then survive the trim.
    const artBody = (BoomerangArtifact.deployedBytecode as string).replace(/^0x/, "");
    const metaLen = (parseInt(artBody.slice(-4), 16) + 2) * 2; // hex chars the scan removes, per the artifact
    const tail = "0".repeat(metaLen);
    const noOwnerFor = async (code: string) => {
      const client = { ...w.publicClient, getCode: async () => code as `0x${string}` } as unknown as PublicClient;
      const rows = await checkLive({ client, boomerang: w.boomerang.address, usdc: w.usdc.address, fromBlock: 0n, artifact: BoomerangArtifact });
      return rows.find((r) => r.name === "no-owner")!;
    };
    const codeFor = (instr: string) => noOwnerFor("0x" + instr + tail);

    // f4 (DELEGATECALL) as an instruction.
    const dele = await codeFor("600060006000600060006000f4");
    assert.equal(dele.ok, false);
    assert.match(dele.detail, /DELEGATECALL/);

    const self = await codeFor("ff");
    assert.equal(self.ok, false);
    assert.match(self.detail, /SELFDESTRUCT/);

    // f4 only as the data of a PUSH32: it must be skipped, so the row passes.
    const push = await codeFor("7f" + "f4".repeat(32));
    assert.ok(push.ok, push.detail);

    // The hole that was closed: a contract whose own last two bytes claim that everything before
    // them is metadata, with a DELEGATECALL in it, still FAILS, because the length trimmed is the
    // artifact's, not what the code says of itself. (It is longer than the artifact's blob, so the
    // DELEGATECALL at its front survives the trim.)
    const n = metaLen / 2 + 40; // total body bytes, comfortably longer than the artifact's metadata blob
    const lenWord = (n - 2).toString(16).padStart(4, "0"); // claims the whole body (bar the length word) is metadata
    const liar = await noOwnerFor("0x" + "f4" + "00".repeat(n - 3) + lenWord);
    assert.equal(liar.ok, false);
    assert.match(liar.detail, /DELEGATECALL/);
  });

  it("check.block: every readContract in a check reads at one and the same block", async function () {
    const w = await setup();
    const { id, t } = await w.open();
    await w.pledge(id, w.alice, 30n * USD, t.opensAt + 10n);
    await w.pledge(id, w.bob, 20n * USD, t.opensAt + 20n);
    await w.time.increaseTo(t.closesAt);
    await w.boomerang.write.finalize([id], { account: w.stranger.account });
    await w.boomerang.write.pay([id, w.alice.account.address], { account: w.stranger.account });

    const blocks: unknown[] = [];
    const client = {
      ...w.publicClient,
      readContract: (args: { blockNumber?: unknown }) => {
        blocks.push(args.blockNumber);
        return w.publicClient.readContract(args as never);
      },
    } as unknown as PublicClient;
    await checkLive({ client, boomerang: w.boomerang.address, usdc: w.usdc.address, fromBlock: 0n, artifact: BoomerangArtifact });

    assert.ok(blocks.length > 0, "the check made readContract calls");
    assert.ok(blocks.every((b) => typeof b === "bigint"), "every read carried a bigint block number");
    assert.equal(new Set(blocks as bigint[]).size, 1, "all reads are at the same block");
  });

  it("check.totalOwed: a contract that over-reports what it owes fails the ledger row", async function () {
    const w = await setup();
    const { id, t } = await w.open();
    await w.pledge(id, w.alice, 30n * USD, t.opensAt + 10n);
    await w.pledge(id, w.bob, 20n * USD, t.opensAt + 20n);
    await w.time.increaseTo(t.closesAt);
    await w.boomerang.write.finalize([id], { account: w.stranger.account });

    const client = {
      ...w.publicClient,
      readContract: async (args: { functionName: string }) => {
        const real = await w.publicClient.readContract(args as never);
        return args.functionName === "totalOwed" ? (real as bigint) + 1n : real;
      },
    } as unknown as PublicClient;
    const rows = await checkLive({ client, boomerang: w.boomerang.address, usdc: w.usdc.address, fromBlock: 0n, artifact: BoomerangArtifact });
    const ledger = rows.find((r) => r.name === "ledger")!;
    assert.equal(ledger.ok, false);
    assert.match(ledger.detail, /the contract owes/);
  });

  it("check.ledger: a fromBlock after the first event leaves a gap and fails the ledger row", async function () {
    const w = await setup();
    const { id, t } = await w.open();
    await w.pledge(id, w.alice, 30n * USD, t.opensAt + 10n);
    const logs = await w.publicClient.getLogs({ address: w.boomerang.address, fromBlock: 0n });
    const firstBlock = logs[0].blockNumber!;
    const rows = await checkLive({ client: w.publicClient, boomerang: w.boomerang.address, usdc: w.usdc.address, fromBlock: firstBlock + 1n, artifact: BoomerangArtifact });
    const ledger = rows.find((r) => r.name === "ledger")!;
    assert.equal(ledger.ok, false);
    assert.match(ledger.detail, /seq|waiting|missing/i);
  });

  it("check.chunk: the ledger row is chunk-size independent for sizes >= 1 and fails for a zero chunk", { timeout: 30_000 }, async function () {
    const w = await setup();
    const { id, t } = await w.open();
    await w.pledge(id, w.alice, 30n * USD, t.opensAt + 10n);
    await w.pledge(id, w.bob, 20n * USD, t.opensAt + 20n);
    await w.time.increaseTo(t.closesAt);
    await w.boomerang.write.finalize([id], { account: w.stranger.account });
    await w.boomerang.write.pay([id, w.alice.account.address], { account: w.stranger.account });

    // The events land across more than four distinct blocks, so a small chunk must paginate.
    const evLogs = await w.publicClient.getLogs({ address: w.boomerang.address, fromBlock: 0n });
    assert.ok(new Set(evLogs.map((l) => l.blockNumber)).size >= 4, "events span at least four blocks");

    for (const chunk of [1n, 2n, 3n]) {
      const rows = await checkLive({ client: w.publicClient, boomerang: w.boomerang.address, usdc: w.usdc.address, fromBlock: 0n, artifact: BoomerangArtifact, chunk });
      assert.ok(rows.find((r) => r.name === "ledger")!.ok, `chunk ${chunk}: ${rows.find((r) => r.name === "ledger")!.detail}`);
    }
    const zero = await checkLive({ client: w.publicClient, boomerang: w.boomerang.address, usdc: w.usdc.address, fromBlock: 0n, artifact: BoomerangArtifact, chunk: 0n });
    const ledger = zero.find((r) => r.name === "ledger")!;
    assert.equal(ledger.ok, false);
    assert.match(ledger.detail, /at least 1 block/);
  });

  it("check.noowner: the real ABI passes and rescue is not flagged; an added transferOwnership fails", async function () {
    const w = await setup();
    const rows = await checkLive({ client: w.publicClient, boomerang: w.boomerang.address, usdc: w.usdc.address, fromBlock: 0n, artifact: BoomerangArtifact });
    const no = rows.find((r) => r.name === "no-owner")!;
    assert.ok(no.ok, no.detail);
    assert.match(no.detail, /rescue/, "rescue is listed as a state-changing function, not flagged");

    const tampered = { ...BoomerangArtifact, abi: [...BoomerangArtifact.abi, { type: "function", name: "transferOwnership", stateMutability: "nonpayable", inputs: [{ name: "n", type: "address" }], outputs: [] }] };
    const rows2 = await checkLive({ client: w.publicClient, boomerang: w.boomerang.address, usdc: w.usdc.address, fromBlock: 0n, artifact: tampered });
    const no2 = rows2.find((r) => r.name === "no-owner")!;
    assert.equal(no2.ok, false);
    assert.match(no2.detail, /transferOwnership/);
  });

  it("check.creation: the creation row proves how the contract began, and nothing else can forge it", async function () {
    const w = await setup();
    const base = { client: w.publicClient, boomerang: w.boomerang.address, usdc: w.usdc.address, fromBlock: 0n, artifact: BoomerangArtifact };
    const creationOf = (rows: Awaited<ReturnType<typeof checkLive>>) => rows.find((r) => r.name === "creation")!;

    // (a) No deployTx: the creation row fails and says none is recorded; the other rows are untouched.
    const a = await checkLive({ ...base });
    assert.equal(creationOf(a).ok, false);
    assert.match(creationOf(a).detail, /no deployment transaction is recorded/);
    for (const name of ["code", "no-owner", "custody", "ledger"]) {
      const r = a.find((x) => x.name === name)!;
      assert.ok(r.ok, `${name} unaffected: ${r.detail}`);
    }

    // (b) A malformed hash fails.
    const b = await checkLive({ ...base, deployTx: "0xdeadbeef" });
    assert.equal(creationOf(b).ok, false);
    assert.match(creationOf(b).detail, /not a transaction hash/);

    // (c) The hash of some other transaction (a token mint, not a creation) fails.
    const mintHash = await w.usdc.write.mint([w.alice.account.address, 1n]);
    const c = await checkLive({ ...base, deployTx: mintHash });
    assert.equal(creationOf(c).ok, false);
    assert.match(creationOf(c).detail, /did not create a contract directly/);

    // (d) The hash of a transaction that created a DIFFERENT Boomerang fails, naming both addresses.
    const { contract: other, deploymentTransaction: otherTx } = await w.viem.sendDeploymentTransaction("Boomerang", [w.usdc.address]);
    await w.publicClient.waitForTransactionReceipt({ hash: otherTx.hash });
    const d = await checkLive({ ...base, deployTx: otherTx.hash });
    assert.equal(creationOf(d).ok, false);
    assert.match(creationOf(d).detail, new RegExp(other.address.slice(2), "i"));
    assert.match(creationOf(d).detail, new RegExp(w.boomerang.address.slice(2), "i"));

    // (e) THE ATTACK: creation code that writes a storage slot and then returns the artifact's exact
    // runtime (immutables filled with the token). The code row cannot see the planted state; the
    // creation row can, because the creation input is not the compiled creation code.
    const runtime = (await w.publicClient.getCode({ address: w.boomerang.address }))!; // artifact runtime, token baked in
    const runtimeBody = runtime.replace(/^0x/, "");
    const runtimeBytes = runtimeBody.length / 2;
    const word2 = (x: number) => x.toString(16).padStart(4, "0");
    // PUSH32 1, PUSH32 0, SSTORE, PUSH2 len, DUP1, PUSH2 offset, PUSH1 0, CODECOPY, PUSH1 0, RETURN.
    const prefix =
      "7f" + "00".repeat(31) + "01" + // PUSH32 value 1
      "7f" + "00".repeat(32) +        // PUSH32 slot 0
      "55" +                           // SSTORE
      "61" + word2(runtimeBytes) +     // PUSH2 len
      "80" +                           // DUP1
      "61" + word2(80) +               // PUSH2 offset (the prefix is 80 bytes long)
      "6000" +                         // PUSH1 0 (dest)
      "39" +                           // CODECOPY
      "6000" +                         // PUSH1 0
      "f3";                            // RETURN
    assert.equal(prefix.length / 2, 80, "the prefix is 80 bytes, so offset 80 points at the runtime");
    const creationCode = ("0x" + prefix + runtimeBody) as `0x${string}`;
    const attackHash = await w.sponsor.sendTransaction({ account: w.sponsor.account!, data: creationCode, chain: w.publicClient.chain });
    const attackReceipt = await w.publicClient.waitForTransactionReceipt({ hash: attackHash });
    const attackAddr = attackReceipt.contractAddress!;
    assert.equal(await w.publicClient.getCode({ address: attackAddr }), runtime, "the attack contract's runtime is the artifact's, byte for byte");
    const e = await checkLive({ client: w.publicClient, boomerang: attackAddr, usdc: w.usdc.address, fromBlock: 0n, artifact: BoomerangArtifact, deployTx: attackHash });
    assert.ok(e.find((r) => r.name === "code")!.ok, e.find((r) => r.name === "code")!.detail);
    assert.equal(creationOf(e).ok, false);

    // (e2) The same attack dressed to the right size: the planting code and the runtime, padded
    // with zeros to the compiled creation code's exact length, then the token address, as a real
    // deployment's input ends. Only comparing the bytes themselves can tell it apart.
    const compiledBytes = BoomerangArtifact.bytecode.replace(/^0x/, "").length / 2;
    const dressedBody = prefix + runtimeBody;
    assert.ok(dressedBody.length / 2 <= compiledBytes, "the attack fits inside the compiled length");
    const dressed = ("0x" + dressedBody + "00".repeat(compiledBytes - dressedBody.length / 2) + encodeAbiParameters([{ type: "address" }], [w.usdc.address]).slice(2)) as `0x${string}`;
    const dressedHash = await w.sponsor.sendTransaction({ account: w.sponsor.account!, data: dressed, chain: w.publicClient.chain, gas: 15_000_000n });
    const dressedAddr = (await w.publicClient.waitForTransactionReceipt({ hash: dressedHash })).contractAddress!;
    assert.equal(await w.publicClient.getCode({ address: dressedAddr }), runtime);
    const e2 = await checkLive({ client: w.publicClient, boomerang: dressedAddr, usdc: w.usdc.address, fromBlock: 0n, artifact: BoomerangArtifact, deployTx: dressedHash });
    assert.ok(e2.find((r) => r.name === "code")!.ok);
    assert.equal(creationOf(e2).ok, false);
    assert.match(creationOf(e2).detail, /is not the compiled creation code/);

    // (f) A constructor given a different token: the creation row fails, naming the token it was given.
    const tokenB = await w.viem.deployContract("TestUSDC");
    const { contract: bb, deploymentTransaction: bbTx } = await w.viem.sendDeploymentTransaction("Boomerang", [tokenB.address]);
    await w.publicClient.waitForTransactionReceipt({ hash: bbTx.hash });
    const f = await checkLive({ client: w.publicClient, boomerang: bb.address, usdc: w.usdc.address, fromBlock: 0n, artifact: BoomerangArtifact, deployTx: bbTx.hash });
    assert.equal(creationOf(f).ok, false);
    assert.match(creationOf(f).detail, /the constructor was given/);
    assert.match(creationOf(f).detail, new RegExp(tokenB.address.slice(2), "i"));

    // (g) An artifact with no creation code fails, saying to rebuild.
    const g = await checkLive({ ...base, deployTx: otherTx.hash, artifact: { ...BoomerangArtifact, bytecode: undefined } });
    assert.equal(creationOf(g).ok, false);
    assert.match(creationOf(g).detail, /no creation code; rebuild/);
  });

  it("check.once: the runtime code is read exactly once, and a getCode error with details fails both the code and no-owner rows", async function () {
    const w = await setup();
    let getCodeCalls = 0;
    const counting = {
      ...w.publicClient,
      getCode: (args: { address: Address }) => {
        getCodeCalls++;
        return w.publicClient.getCode(args);
      },
    } as unknown as PublicClient;
    await checkLive({ client: counting, boomerang: w.boomerang.address, usdc: w.usdc.address, fromBlock: 0n, artifact: BoomerangArtifact });
    assert.equal(getCodeCalls, 1, "the runtime code is read once per checkLive, not once per row");

    const failing = {
      ...w.publicClient,
      getCode: async () => {
        const err = new Error("the node is down") as Error & { details?: string };
        err.details = "upstream RPC refused the connection";
        throw err;
      },
    } as unknown as PublicClient;
    const rows = await checkLive({ client: failing, boomerang: w.boomerang.address, usdc: w.usdc.address, fromBlock: 0n, artifact: BoomerangArtifact });
    const code = rows.find((r) => r.name === "code")!;
    const noOwner = rows.find((r) => r.name === "no-owner")!;
    assert.equal(code.ok, false);
    assert.equal(noOwner.ok, false);
    assert.match(code.detail, /upstream RPC refused the connection/);
    assert.match(noOwner.detail, /upstream RPC refused the connection/);
  });
});

describe("demo campaigns", function () {
  it("demo.outcomes: all five kinds give Funded, Missed, Funded, Void, Open and custody holds", async function () {
    const { viem, networkHelpers } = await network.create();
    const publicClient = await viem.getPublicClient();
    const usdc = await viem.deployContract("TestUSDC");
    const boomerang = await viem.deployContract("Boomerang", [usdc.address]);
    const [sponsor, recipient] = await viem.getWalletClients();
    // one grant from Circle's faucet is 20 test USDC: all five campaigns must fit inside it
    await usdc.write.mint([sponsor.account.address, 20n * USD]);

    const logs: string[] = [];
    const made = await makeDemoCampaigns({
      publicClient,
      sponsor,
      boomerang: boomerang.address,
      usdc: usdc.address,
      recipient: recipient.account.address,
      which: ["funded", "missed", "rescued", "void", "live"],
      wait: (until) => networkHelpers.time.increaseTo(until),
      fundGas: (address) => networkHelpers.setBalance(address, 10n ** 18n),
      log: (line) => logs.push(line),
    });

    assert.deepEqual(made.map((m) => m.kind), ["funded", "missed", "rescued", "void", "live"]);
    assert.deepEqual(made.map((m) => m.outcome), [Outcome.Funded, Outcome.Missed, Outcome.Funded, Outcome.Void, Outcome.Open]);

    // A clean run points no refund at the sponsor in the finally sweep: the funded, rescued and
    // paid-out campaigns need none, and the live campaign's backer was already redirected in its flow.
    assert.deepEqual(logs.filter((l) => /now goes to the sponsor|could not be pointed/.test(l)), [], "no redirect is made or even tried on a clean run");

    const held = await usdc.read.balanceOf([boomerang.address]);
    const owed = await boomerang.read.totalOwed();
    assert.ok(held >= owed, `custody: holds ${held} but owes ${owed}`);
    const left = await usdc.read.balanceOf([sponsor.account.address]);
    assert.ok(left >= 10n * USD, `the sponsor spent ${20n * USD - left}; the demo is meant to cost under 10`);
  });

  it("demo.id: each returned id is read from the sponsor's own CampaignCreated event, not a running count", async function () {
    const { viem, networkHelpers } = await network.create();
    const publicClient = await viem.getPublicClient();
    const usdc = await viem.deployContract("TestUSDC");
    const boomerang = await viem.deployContract("Boomerang", [usdc.address]);
    const [sponsor, recipient, interloper] = await viem.getWalletClients();
    await usdc.write.mint([sponsor.account.address, 20n * USD]);
    const chain = publicClient.chain;

    // After each createCampaign the sponsor sends, a different account creates one of its own, so a
    // count-based id would point at the wrong campaign. The interloper's terms mirror the demo's.
    const interloperCampaign = async () => {
      const now = (await publicClient.getBlock()).timestamp;
      const terms = {
        recipient: interloper.account.address,
        opensAt: now + 90n,
        earlyUntil: now + 210n,
        closesAt: now + 330n,
        target: 200n * 10_000n,
        minPledge: 5n * 10_000n,
        matchAmount: 50n * 10_000n,
        bonusPool: 20n * 10_000n,
        rateBps: 1000,
        linearWeight: false,
        bonusFromRecipient: false,
      };
      const h = await interloper.writeContract({ account: interloper.account, address: boomerang.address, abi: boomerangAbi, functionName: "createCampaign", args: [terms], chain });
      await publicClient.waitForTransactionReceipt({ hash: h });
    };
    const realWrite = sponsor.writeContract.bind(sponsor);
    const wrappedSponsor = {
      ...sponsor,
      writeContract: async (args: { functionName: string }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hash = await realWrite(args as any);
        if (args.functionName === "createCampaign") {
          await publicClient.waitForTransactionReceipt({ hash });
          await interloperCampaign();
        }
        return hash;
      },
    } as unknown as WalletClient;

    const made = await makeDemoCampaigns({
      publicClient,
      sponsor: wrappedSponsor,
      boomerang: boomerang.address,
      usdc: usdc.address,
      recipient: recipient.account.address,
      which: ["funded", "void"],
      wait: (until) => networkHelpers.time.increaseTo(until),
      fundGas: (address) => networkHelpers.setBalance(address, 10n ** 18n),
    });

    assert.deepEqual(made.map((m) => m.kind), ["funded", "void"]);
    assert.deepEqual(made.map((m) => m.outcome), [Outcome.Funded, Outcome.Void]);

    // Each id's CampaignCreated event must name the sponsor, proving the id is the sponsor's own.
    for (const m of made) {
      const logs = await publicClient.getLogs({ address: boomerang.address, event: CampaignCreatedEvent, args: { id: m.id }, fromBlock: 0n });
      assert.equal(logs.length, 1, `exactly one CampaignCreated for id ${m.id}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assert.equal((logs[0].args as any).sponsor.toLowerCase(), sponsor.account!.address.toLowerCase(), `id ${m.id} is the sponsor's campaign`);
    }
  });

  it("demo.revert: a reverted fund transaction fails the whole run", async function () {
    const { viem, networkHelpers } = await network.create();
    const publicClient = await viem.getPublicClient();
    const usdc = await viem.deployContract("TestUSDC");
    const boomerang = await viem.deployContract("Boomerang", [usdc.address]);
    const [sponsor, recipient] = await viem.getWalletClients();
    await usdc.write.mint([sponsor.account.address, 20n * USD]);

    const fundMatchSelector = toFunctionSelector("fundMatch(uint256)").toLowerCase();
    let tripped = false;
    const realWait = publicClient.waitForTransactionReceipt.bind(publicClient);
    const wrappedClient = {
      ...publicClient,
      waitForTransactionReceipt: async (args: { hash: `0x${string}` }) => {
        const receipt = await realWait(args);
        if (!tripped) {
          const tx = await publicClient.getTransaction({ hash: args.hash });
          if (typeof tx.input === "string" && tx.input.slice(0, 10).toLowerCase() === fundMatchSelector) {
            tripped = true;
            return { ...receipt, status: "reverted" as const };
          }
        }
        return receipt;
      },
    } as unknown as PublicClient;

    await assert.rejects(
      makeDemoCampaigns({
        publicClient: wrappedClient,
        sponsor,
        boomerang: boomerang.address,
        usdc: usdc.address,
        recipient: recipient.account.address,
        which: ["funded"],
        wait: (until) => networkHelpers.time.increaseTo(until),
        fundGas: (address) => networkHelpers.setBalance(address, 10n ** 18n),
      }),
      /reverted on-chain/,
    );
  });

  it("demo.live: the open campaign's windows follow liveOpenFor and its backer pays the sponsor", async function () {
    const runLive = async (liveOpenFor?: bigint) => {
      const { viem, networkHelpers } = await network.create();
      const publicClient = await viem.getPublicClient();
      const usdc = await viem.deployContract("TestUSDC");
      const boomerang = await viem.deployContract("Boomerang", [usdc.address]);
      const [sponsor, recipient] = await viem.getWalletClients();
      await usdc.write.mint([sponsor.account.address, 20n * USD]);

      const made = await makeDemoCampaigns({
        publicClient,
        sponsor,
        boomerang: boomerang.address,
        usdc: usdc.address,
        recipient: recipient.account.address,
        which: ["live"],
        wait: (until) => networkHelpers.time.increaseTo(until),
        fundGas: (address) => networkHelpers.setBalance(address, 10n ** 18n),
        ...(liveOpenFor === undefined ? {} : { liveOpenFor }),
      });
      const id = made[0].id;
      const terms = (await publicClient.readContract({ address: boomerang.address, abi: boomerangAbi, functionName: "termsOf", args: [id] })) as { opensAt: bigint; earlyUntil: bigint; closesAt: bigint };
      const pledges = await publicClient.getLogs({ address: boomerang.address, event: PledgedEvent, args: { id }, fromBlock: 0n });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const backer = (pledges[0].args as any).backer as Address;
      const b = (await publicClient.readContract({ address: boomerang.address, abi: boomerangAbi, functionName: "backerOf", args: [id, backer] })) as { payTo: Address };
      return { outcome: made[0].outcome, terms, payTo: b.payTo, sponsor: sponsor.account!.address };
    };

    const def = await runLive();
    assert.equal(def.outcome, Outcome.Open);
    assert.equal(def.terms.closesAt - def.terms.opensAt, 604800n);
    assert.equal(def.terms.earlyUntil - def.terms.opensAt, 362880n); // six tenths of the week
    assert.equal(def.payTo.toLowerCase(), def.sponsor.toLowerCase(), "the live backer's payout is pointed at the sponsor");

    const short = await runLive(86400n);
    assert.equal(short.outcome, Outcome.Open);
    assert.equal(short.terms.closesAt - short.terms.opensAt, 86400n);
    assert.equal(short.terms.earlyUntil - short.terms.opensAt, 51840n);
    assert.equal(short.payTo.toLowerCase(), short.sponsor.toLowerCase());
  });

  it("demo.sweep: backers end with only the gas reserve, the missed backers are paid, and the sponsor's balance is exact", async function () {
    const { viem, networkHelpers } = await network.create();
    const publicClient = await viem.getPublicClient();
    const usdc = await viem.deployContract("TestUSDC");
    const boomerang = await viem.deployContract("Boomerang", [usdc.address]);
    const [sponsor, recipient] = await viem.getWalletClients();
    await usdc.write.mint([sponsor.account.address, 20_000_000n]); // exactly 20 USDC

    const logs: string[] = [];
    const made = await makeDemoCampaigns({
      publicClient,
      sponsor,
      boomerang: boomerang.address,
      usdc: usdc.address,
      recipient: recipient.account.address,
      which: ["funded", "missed", "rescued", "void", "live"],
      wait: (until) => networkHelpers.time.increaseTo(until),
      fundGas: (address) => networkHelpers.setBalance(address, 10n ** 18n),
      log: (line) => logs.push(line),
    });

    // A clean run redirects nothing to the sponsor in the finally sweep.
    assert.deepEqual(logs.filter((l) => /now goes to the sponsor|could not be pointed/.test(l)), [], "no redirect is made or even tried on a clean run");

    const pledges = await publicClient.getLogs({ address: boomerang.address, event: PledgedEvent, fromBlock: 0n });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const backerOf = (l: { args: any }) => (l.args.backer as Address).toLowerCase();
    const backers = [...new Set(pledges.map(backerOf))];
    assert.equal(backers.length, 3, "three throwaway backers across all campaigns");
    for (const b of backers) {
      assert.equal(await usdc.read.balanceOf([b as Address]), 50_000n, `backer ${b} is swept down to the gas reserve`);
    }

    // Each backer was funded from the sponsor with exactly 1.70 USDC (1.50 to pledge plus a 0.20
    // on-chain-gas reserve). The sponsor's only USDC transfer to a backer is that one funding.
    const TransferEvent = getAbiItem({ abi: usdc.abi, name: "Transfer" }) as AbiEvent;
    for (const b of backers) {
      const funding = await publicClient.getLogs({ address: usdc.address, event: TransferEvent, args: { from: sponsor.account.address, to: b as Address }, fromBlock: 0n });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const total = funding.reduce((s, l) => s + ((l.args as any).amount as bigint), 0n);
      assert.equal(total, 1_700_000n, `backer ${b} is funded with exactly 1.70 USDC (got ${total})`);
    }

    // The missed campaign's three backers are all paid out by the script.
    const missedId = made.find((m) => m.kind === "missed")!.id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const missedBackers = [...new Set(pledges.filter((l) => (l.args as any).id === missedId).map(backerOf))];
    assert.equal(missedBackers.length, 3);
    for (const b of missedBackers) {
      const bk = (await boomerang.read.backerOf([missedId, b as Address])) as { paid: boolean };
      assert.equal(bk.paid, true, `missed backer ${b} is marked paid`);
    }

    // Every cent is accounted for: the sponsor started with 20.000000, and what it no longer has
    // is with the recipient (the funded campaigns), in the contract (the open campaign, and the
    // void one's unclaimed match), or is the three backers' gas reserves. The bonus amounts
    // themselves depend on when each pledge landed (the weight is linear) and are checked against
    // the contract's rule in pledge.test.ts and kit.test.ts.
    const left = await usdc.read.balanceOf([sponsor.account.address]);
    const withRecipient = await usdc.read.balanceOf([recipient.account.address]);
    const inContract = await usdc.read.balanceOf([boomerang.address]);
    assert.equal(left, 20_000_000n - withRecipient - inContract - 3n * 50_000n, `sponsor balance is exact (got ${left})`);
    assert.equal(inContract, await boomerang.read.totalOwed(), "the contract holds exactly what it owes");
    assert.ok(left >= 12_000_000n, `the whole demo cost the sponsor ${20_000_000n - left}; it is meant to cost under 8`);
  });

  it("demo.halfway: a run that stops before the close still points every refund at the sponsor", async function () {
    const { viem, networkHelpers } = await network.create();
    const publicClient = await viem.getPublicClient();
    const usdc = await viem.deployContract("TestUSDC");
    const boomerang = await viem.deployContract("Boomerang", [usdc.address]);
    const [sponsor, recipient, anyone] = await viem.getWalletClients();
    await usdc.write.mint([sponsor.account.address, 20n * USD]);

    // The missed flow waits three times: open, earlyUntil, then closesAt. Throw on the third, after
    // all three pledges but before finalize, so the campaign is left open with live backer keys.
    let waitCalls = 0;
    const logs: string[] = [];
    await assert.rejects(
      makeDemoCampaigns({
        publicClient,
        sponsor,
        boomerang: boomerang.address,
        usdc: usdc.address,
        recipient: recipient.account.address,
        which: ["missed"],
        wait: async (until) => {
          waitCalls++;
          if (waitCalls === 3) throw new Error("stopped before the close");
          await networkHelpers.time.increaseTo(until);
        },
        fundGas: (address) => networkHelpers.setBalance(address, 10n ** 18n),
        log: (line) => logs.push(line),
      }),
      /stopped before the close/,
    );

    const pledges = await publicClient.getLogs({ address: boomerang.address, event: PledgedEvent, fromBlock: 0n });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const backers = [...new Set(pledges.map((l) => (l.args as any).backer as Address))];
    assert.equal(backers.length, 3, "three throwaway backers pledged before the stop");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const id = (pledges[0].args as any).id as bigint;

    // Every pledge now pays the sponsor, and there is one redirect log line per backer.
    for (const b of backers) {
      const bk = (await boomerang.read.backerOf([id, b])) as { payTo: Address };
      assert.equal(bk.payTo.toLowerCase(), sponsor.account.address.toLowerCase(), `backer ${b} points at the sponsor`);
    }
    assert.equal(logs.filter((l) => /now goes to the sponsor/.test(l)).length, 3, "one redirect line per backer");

    // Anyone finalizes and pays: the money reaches the sponsor, not the thrown-away backer keys.
    const terms = (await publicClient.readContract({ address: boomerang.address, abi: boomerangAbi, functionName: "termsOf", args: [id] })) as { closesAt: bigint };
    await networkHelpers.time.increaseTo(terms.closesAt);
    await boomerang.write.finalize([id], { account: anyone.account });

    const sponsorBefore = await usdc.read.balanceOf([sponsor.account.address]);
    const backersBefore = await Promise.all(backers.map((b) => usdc.read.balanceOf([b])));
    await boomerang.write.payMany([id, backers], { account: anyone.account });
    const sponsorAfter = await usdc.read.balanceOf([sponsor.account.address]);

    // The refunds (three principals plus any bonus) land on the sponsor; the backers do not rise.
    const paid = await publicClient.getLogs({ address: boomerang.address, event: PaidEvent, args: { id }, fromBlock: 0n });
    assert.equal(paid.length, 3, "all three backers are paid");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toSponsor = paid.reduce((s, l) => s + ((l.args as any).principal as bigint) + ((l.args as any).bonus as bigint), 0n);
    assert.ok(toSponsor > 0n, "there is a refund to make");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const l of paid) assert.equal(((l.args as any).to as Address).toLowerCase(), sponsor.account.address.toLowerCase(), "each refund is sent to the sponsor");
    assert.equal(sponsorAfter - sponsorBefore, toSponsor, "the sponsor's balance rises by the refunds");
    for (let i = 0; i < backers.length; i++) {
      assert.equal(await usdc.read.balanceOf([backers[i]]), backersBefore[i], `backer ${backers[i]} does not rise`);
    }
  });

  it("demo.lostReceipt: a pledge that landed but whose receipt never came is still pointed at the sponsor", async function () {
    const { viem, networkHelpers } = await network.create();
    const real = await viem.getPublicClient();
    const usdc = await viem.deployContract("TestUSDC");
    const boomerang = await viem.deployContract("Boomerang", [usdc.address]);
    const [sponsor, recipient] = await viem.getWalletClients();
    await usdc.write.mint([sponsor.account.address, 20n * USD]);

    // The second pledge is mined, and then the wait for its receipt fails.
    const pledgedTopic = encodeEventTopics({ abi: [PledgedEvent], eventName: "Pledged" })[0];
    let pledgesSeen = 0;
    const publicClient = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop !== "waitForTransactionReceipt") return Reflect.get(target, prop, receiver);
        return async (args: never) => {
          const receipt = await target.waitForTransactionReceipt(args);
          if (receipt.logs.some((l) => l.address.toLowerCase() === boomerang.address.toLowerCase() && l.topics[0] === pledgedTopic) && ++pledgesSeen === 2) {
            throw new Error("timed out waiting for the receipt");
          }
          return receipt;
        };
      },
    }) as typeof real;
    const logs: string[] = [];
    await assert.rejects(
      makeDemoCampaigns({
        publicClient,
        sponsor,
        boomerang: boomerang.address,
        usdc: usdc.address,
        recipient: recipient.account.address,
        which: ["missed"],
        wait: (until) => networkHelpers.time.increaseTo(until),
        fundGas: (address) => networkHelpers.setBalance(address, 10n ** 18n),
        log: (line) => logs.push(line),
      }),
      /timed out waiting for the receipt/,
    );

    const pledges = await real.getLogs({ address: boomerang.address, event: PledgedEvent, fromBlock: 0n });
    assert.equal(pledges.length, 2, "both pledges are on the chain, the second included");
    for (const l of pledges) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { id, backer } = l.args as any as { id: bigint; backer: Address };
      const bk = (await boomerang.read.backerOf([id, backer])) as { payTo: Address };
      assert.equal(bk.payTo.toLowerCase(), sponsor.account.address.toLowerCase(), `backer ${backer} points at the sponsor`);
    }
    assert.equal(logs.filter((l) => /could not be pointed/.test(l)).length, 0);
  });

  it("demo.liveDays: liveDaysFrom reads a 1-2 digit day count and nothing else", function () {
    assert.equal(liveDaysFrom(undefined), 7);
    assert.equal(liveDaysFrom("1"), 1);
    assert.equal(liveDaysFrom("7"), 7);
    assert.equal(liveDaysFrom("60"), 60);
    assert.equal(liveDaysFrom("07"), 7); // two digits, in range
    for (const bad of ["", "0", "61", "7.0", " 7", "0x7", "1e1", "-3", "seven", "007"]) {
      assert.equal(liveDaysFrom(bad), null, `${JSON.stringify(bad)} is not a day count`);
    }
  });
});

describe("cli scripts", function () {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

  it("checklive.exit: check-live.mjs exits 2, says what is missing and what to do, and never asks the network", function () {
    const dir = mkdtempSync(join(tmpdir(), "checklive-"));
    const B = "0x00000000000000000000000000000000000000b1";
    const TX = `0x${"ab".repeat(32)}`;
    const ARC_USDC = "0x3600000000000000000000000000000000000000";
    const run = (entry: unknown) => {
      const file = join(dir, "addresses.json");
      writeFileSync(file, typeof entry === "string" ? entry : JSON.stringify({ "5042002": entry }));
      // The RPC points nowhere: had the script gone to the network it would not exit 2.
      return spawnSync("node", ["scripts/check-live.mjs", "--rpc", "http://127.0.0.1:9"], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, BOOMERANG_ADDRESSES_FILE: file } });
    };
    const cases: [string, unknown, RegExp][] = [
      ["nothing deployed", { boomerang: null, router: null, usdc: ARC_USDC }, /not deployed/i],
      ["no entry for the chain", undefined, /not deployed/i],
      ["not JSON", "{ not json", /could not be read/],
      ["no deploy block", { boomerang: B, usdc: ARC_USDC, boomerangTx: TX }, /no usable deployBlock/],
      ["a deploy block that is not a number", { boomerang: B, usdc: ARC_USDC, boomerangTx: TX, deployBlock: "abc" }, /no usable deployBlock/],
      ["no deployment transaction", { boomerang: B, usdc: ARC_USDC, deployBlock: "12" }, /boomerangTx.*re-run scripts\/deploy\.ts/],
      ["a deployment transaction that is not a string", { boomerang: B, usdc: ARC_USDC, deployBlock: 12, boomerangTx: 7 }, /boomerangTx/],
      ["another token", { boomerang: B, usdc: "0x00000000000000000000000000000000000000c2", deployBlock: "12", boomerangTx: TX }, /accepts only Circle's USDC/],
    ];
    for (const [name, entry, want] of cases) {
      const res = run(entry);
      assert.equal(res.status, 2, `${name}: expected exit 2; stderr: ${res.stderr}`);
      assert.match(res.stderr, want, name);
      assert.doesNotMatch(res.stderr, /\n\s+at /, `${name}: no stack trace`);
      assert.equal(res.stdout, "", `${name}: no check was printed`);
    }
    // A flag where the node's address should be is not taken for an address.
    {
      const file = join(dir, "addresses.json");
      writeFileSync(file, JSON.stringify({ "5042002": { boomerang: B, usdc: ARC_USDC, deployBlock: "12", boomerangTx: TX } }));
      const res = spawnSync("node", ["scripts/check-live.mjs", "--rpc", "--full"], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, BOOMERANG_ADDRESSES_FILE: file } });
      assert.equal(res.status, 2, res.stderr);
      assert.match(res.stderr, /--rpc needs the address of a node/);
      assert.equal(res.stdout, "");
    }
    // The repository's own file, as it stands before any deployment, gives the same answer.
    const real = JSON.parse(readFileSync(ADDRESSES_URL, "utf8"))["5042002"];
    if (real.boomerang === null) {
      const res = spawnSync("node", ["scripts/check-live.mjs"], { cwd: repoRoot, encoding: "utf8" });
      assert.equal(res.status, 2);
      assert.match(res.stderr, /not deployed/i);
    }
  });

  it("checklive.token: the token the check holds the contract to is written in the script, not read from the addresses file", function () {
    const src = readFileSync(new URL("../../scripts/check-live.mjs", import.meta.url), "utf8");
    assert.match(src, /const ARC_USDC = "0x3600000000000000000000000000000000000000";/);
    assert.match(src, /checkLive\(\{[^}]*usdc: ARC_USDC[^}]*\}\)/);
    assert.doesNotMatch(src, /usdc:\s*(raw|addresses)\./);
  });

  it("crosschain.exit: the cross-chain pledge script says what it was not told and exits 2 before it asks any network or reads any key", function () {
    const run = (env: Record<string, string>, args: string[] = []) =>
      spawnSync("node", ["scripts/cross-chain-pledge.mjs", ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        // Nodes that do not exist: a script that asked one would fail with exit 1, not 2.
        env: { PATH: process.env.PATH ?? "", SOURCE_RPC_URL: "http://127.0.0.1:1", ARC_RPC_URL: "http://127.0.0.1:1", ...env },
      });
    const cases: [Record<string, string>, string[], RegExp][] = [
      [{}, [], /^CAMPAIGN must be the campaign's number/],
      [{ CAMPAIGN: "twelve" }, [], /^CAMPAIGN must be the campaign's number/],
      [{ CAMPAIGN: "12", AMOUNT: "-1" }, [], /^AMOUNT must be a USDC amount/],
      [{ CAMPAIGN: "12", AMOUNT: "0" }, [], /^AMOUNT must be more than zero/],
      [{ CAMPAIGN: "12", SOURCE: "mainnet" }, [], /^SOURCE must be base-sepolia or sepolia/],
      [{ CAMPAIGN: "12", SPEED: "instant" }, [], /^SPEED must be fast or standard/],
      [{ CAMPAIGN: "12", BURN_TX: "0x12" }, [], /^BURN_TX is not a transaction hash/],
      [{ CAMPAIGN: "12", BACKER: "me" }, [], /^BACKER is not an address/],
      [{ CAMPAIGN: "12" }, [], /^give PLEDGER_KEY_FILE, or PLEDGER_ADDRESS to look without sending/],
      [{ CAMPAIGN: "12", PLEDGER_ADDRESS: "0x00000000000000000000000000000000000000c1" }, ["--send"], /^--send needs PLEDGER_KEY_FILE/],
      [{ CAMPAIGN: "12", PLEDGER_KEY_FILE: "/no/such/file" }, ["--send"], /^PLEDGER_KEY_FILE could not be read/],
      [{ CAMPAIGN: "12", PLEDGER_ADDRESS: "0x00000000000000000000000000000000000000c1" }, ["--now"], /^unknown argument --now/],
    ];
    for (const [env, args, want] of cases) {
      const res = run(env, args);
      assert.equal(res.status, 2, JSON.stringify([env, args, res.stderr]));
      assert.match(res.stderr, want);
      assert.equal(res.stdout, "");
    }

    // A key file that does not hold a key is refused without its text being repeated.
    const dir = tmp("boomerang-crosschain-");
    const bad = join(dir, "key");
    writeFileSync(bad, "not-a-key-but-secret-looking-text\n");
    const res = run({ CAMPAIGN: "12", PLEDGER_KEY_FILE: bad }, ["--send"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /^PLEDGER_KEY_FILE does not hold one private key in hex/);
    assert.doesNotMatch(res.stderr + res.stdout, /secret-looking/);

    // Sixty-four hex digits that are not a usable key (invented: all zeros, and all f, which is
    // past the curve's order) are refused the same way: no stack, and none of the digits.
    for (const digits of ["0".repeat(64), "f".repeat(64)]) {
      writeFileSync(bad, `${digits}\n`);
      const out = run({ CAMPAIGN: "12", PLEDGER_KEY_FILE: bad }, ["--send"]);
      assert.equal(out.status, 2, out.stderr);
      assert.match(out.stderr, /^PLEDGER_KEY_FILE holds 64 hex digits that are not a usable private key/);
      assert.equal(out.stderr.trim().split("\n").length, 1);
      assert.doesNotMatch(out.stderr + out.stdout, /0{20}|f{20}|1157920892/);
    }

    // Told enough, it does ask the network: with nodes that do not exist it fails (1) and shows no address.
    const asked = run({ CAMPAIGN: "12", PLEDGER_ADDRESS: "0x00000000000000000000000000000000000000c1" });
    assert.equal(asked.status, 1);
    assert.match(asked.stderr, /^failed: /);
    assert.doesNotMatch(asked.stderr, /127\.0\.0\.1/);
  });
});
