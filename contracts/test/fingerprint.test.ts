// Every amount, address and byte in these tests is invented. None is a reading of any real campaign.
//
// The kit ships BOOMERANG_FINGERPRINT so a browser can check the live code without the artifact.
// These tests pin that constant to the build and prove the fingerprint rows agree with the
// artifact-based code row on a contract deployed in Hardhat's in-memory chain.
//
// Run: cd contracts && npx hardhat test nodejs test/fingerprint.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { keccak256 } from "viem";

import { checkLive, codeCheck, fingerprintCheck, fingerprintOf, noOwnerByFingerprint } from "../../scripts/lib/check.ts";
import { BOOMERANG_FINGERPRINT } from "../../packages/kit/src/index.ts";
import { setup } from "./helpers.ts";

const ARTIFACT_URL = new URL("../artifacts/contracts/Boomerang.sol/Boomerang.json", import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BoomerangArtifact: any = JSON.parse(readFileSync(ARTIFACT_URL, "utf8"));

// Flip one hex character of a hex body to a different one (xor the low bit of its nibble).
function flipHexChar(body: string, index: number): string {
  const nibble = parseInt(body[index], 16);
  const other = (nibble ^ 1).toString(16);
  return body.slice(0, index) + other + body.slice(index + 1);
}

describe("fingerprint", function () {
  it("fp.pins: fingerprintOf(artifact) deep-equals the kit's BOOMERANG_FINGERPRINT", function () {
    assert.deepEqual(fingerprintOf(BoomerangArtifact), BOOMERANG_FINGERPRINT);
  });

  it("fp.live: against a deployed Boomerang the fingerprint rows pass, and the code row fails for the wrong token and a changed byte", async function () {
    const w = await setup();
    const onChain = (await w.publicClient.getCode({ address: w.boomerang.address }))!;

    const code = fingerprintCheck(onChain, w.usdc.address, BOOMERANG_FINGERPRINT);
    assert.ok(code.ok, code.detail);
    // Byte for byte, and the hash named is the whole live code's, as the command line names it.
    assert.match(code.detail, /^matches the code this repository builds byte for byte; /);
    assert.ok(code.detail.endsWith(`code hash ${keccak256(onChain)}`), code.detail);

    const noOwner = noOwnerByFingerprint(onChain, BoomerangArtifact.abi, BOOMERANG_FINGERPRINT);
    assert.ok(noOwner.ok, noOwner.detail);
    assert.match(noOwner.detail, /no CALLCODE, DELEGATECALL, SELFDESTRUCT/);

    // The wrong token: the immutable slots do not hold it, so the row fails naming the token.
    const otherToken = await w.viem.deployContract("TestUSDC");
    const wrongToken = fingerprintCheck(onChain, otherToken.address, BOOMERANG_FINGERPRINT);
    assert.equal(wrongToken.ok, false);
    assert.match(wrongToken.detail, /the token built into the contract is/);

    // One byte of the code changed (the first instruction, outside every immutable slot): the hash
    // no longer matches, so the row fails.
    const body = onChain.replace(/^0x/, "");
    const changed = ("0x" + flipHexChar(body, 0)) as `0x${string}`;
    const bad = fingerprintCheck(changed, w.usdc.address, BOOMERANG_FINGERPRINT);
    assert.equal(bad.ok, false);
    assert.match(bad.detail, /differs from the code this repository builds/);
  });

  it("fp.metadata: a change in the compiler's metadata alone is named, as the command line names it; a changed length word fails", async function () {
    const w = await setup();
    const onChain = (await w.publicClient.getCode({ address: w.boomerang.address }))!;
    const body = onChain.replace(/^0x/, "");
    const metaStart = body.length - BOOMERANG_FINGERPRINT.metadataBytes * 2;

    // One character inside the metadata blob (not its two length bytes): the instructions are the same.
    const inMeta = ("0x" + flipHexChar(body, metaStart + 10)) as `0x${string}`;
    const row = fingerprintCheck(inMeta, w.usdc.address, BOOMERANG_FINGERPRINT);
    const cli = codeCheck(inMeta, w.usdc.address, BoomerangArtifact);
    assert.deepEqual([row.ok, cli.ok], [true, true]);
    assert.match(row.detail, /^same instructions as the code this repository builds, but the source metadata differs/);
    assert.match(cli.detail, /^same instructions as compiled code, but the source metadata differs/);
    assert.doesNotMatch(row.detail, /byte for byte/);

    // The last byte (the blob's own length) changed: neither check can line the code up, and both fail.
    const inLength = ("0x" + flipHexChar(body, body.length - 1)) as `0x${string}`;
    const short = fingerprintCheck(inLength, w.usdc.address, BOOMERANG_FINGERPRINT);
    assert.deepEqual([short.ok, codeCheck(inLength, w.usdc.address, BoomerangArtifact).ok], [false, false]);
    assert.match(short.detail, /differs from the code this repository builds/);

    // The last instruction byte before the blob: fails in both.
    const lastCode = ("0x" + flipHexChar(body, metaStart - 1)) as `0x${string}`;
    assert.deepEqual([fingerprintCheck(lastCode, w.usdc.address, BOOMERANG_FINGERPRINT).ok, codeCheck(lastCode, w.usdc.address, BoomerangArtifact).ok], [false, false]);
  });

  it("fp.agrees: for the deployed contract fingerprintCheck's ok matches the artifact code row's ok", async function () {
    const w = await setup();
    const onChain = (await w.publicClient.getCode({ address: w.boomerang.address }))!;
    const fp = fingerprintCheck(onChain, w.usdc.address, BOOMERANG_FINGERPRINT);
    const rows = await checkLive({ client: w.publicClient, boomerang: w.boomerang.address, usdc: w.usdc.address, fromBlock: 0n, artifact: BoomerangArtifact });
    const codeRow = rows.find((r) => r.name === "code")!;
    assert.equal(fp.ok, codeRow.ok);
    assert.ok(fp.ok, fp.detail);
    // Both rows name the same hash: the whole code's, as it sits at the address.
    const hashIn = (detail: string) => /code hash (0x[0-9a-f]{64})/.exec(detail)?.[1];
    assert.equal(hashIn(fp.detail), hashIn(codeRow.detail));
    assert.equal(hashIn(fp.detail), keccak256(onChain));
  });
});
