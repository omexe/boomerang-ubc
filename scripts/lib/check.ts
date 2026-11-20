// Five keyless checks on a live Boomerang, and a sixth on its one-signature helper when one is named, each one row. They read the chain and the kit; they
// send nothing and hold no key. None of them throws: an RPC error becomes that row's failure.
//
//   code     the deployed runtime code is the compiled code, and its one immutable is the USDC address
//   creation the transaction that created the contract carried the compiled creation code and the
//            USDC address and nothing else, so the contract started with no state of anyone's making
//   no-owner the ABI has no privileged function, and the deployed code has no opcode that could
//            run someone else's code as the contract or destroy it
//   custody  the contract holds at least what it owes, read at one block
//   ledger   the event-sourced ledger rebuilt from the logs matches the contract's own state. The logs
//            are the node's; an explorer may say which blocks hold them, and the contract's own
//            count of its events is what shows none was left out
//   signed-pledge  (when named) SignedPledge's code is the compiled code, bound to this token and this Boomerang
import { keccak256 } from "viem";
import type { Abi, Address, PublicClient } from "viem";

import { applyEvents, decodeLogs, emptyLedger, missing } from "../../packages/kit/src/index.ts";
import type { RawLog } from "../../packages/kit/src/index.ts";
import type { Backer, State } from "../../packages/kit/src/types.ts";

export type Check = { name: string; ok: boolean; detail: string };

export type Artifact = {
  abi: readonly unknown[];
  bytecode?: `0x${string}`;
  deployedBytecode: `0x${string}`;
  immutableReferences?: Record<string, { start: number; length: number }[]>;
};

// Function-name patterns a crowdfund with no owner must not have. `rescue` (a sponsor closing a
// campaign's gap) is deliberately not matched: the token-rescue pattern is `rescueTokens`.
// The names are a first screen only. What the row rests on is the code row (the deployed code is
// the compiled code) and the opcode scan below.
export const PRIVILEGED =
  /owner|admin|pause|upgrade|sweep|withdraw|rescueTokens|rescueAll|drain|skim|recover|emergency|setFee|setRecipient|initialize|selfdestruct|destroy|kill|migrate|execute|multicall|grantRole/i;

// Opcodes that let other code run with this contract's storage and balance, or remove it.
export const FORBIDDEN: Record<number, string> = { 0xf2: "CALLCODE", 0xf4: "DELEGATECALL", 0xff: "SELFDESTRUCT" };

// A 20-byte address, zero-padded to a 32-byte word, as the lowercase hex it sits as in bytecode.
export function paddedWord(addr: Address): string {
  return addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

// Zero out the immutable byte ranges in a runtime-code hex body (no 0x prefix). Each ref is a
// byte offset and length in the deployed code; one hex char is half a byte.
export function maskImmutables(body: string, refs: readonly { start: number; length: number }[]): string {
  const chars = body.split("");
  for (const r of refs) {
    for (let i = r.start * 2; i < (r.start + r.length) * 2 && i < chars.length; i++) chars[i] = "0";
  }
  return chars.join("");
}

// Solidity ends runtime code with a metadata blob (a hash of the sources and the compiler
// version) and that blob's length in the last two bytes. Split a hex body into code and blob.
// A comment edited in a source file changes the blob and nothing else.
export function splitMetadata(body: string): { code: string; metadata: string } {
  if (body.length < 4) return { code: body, metadata: "" };
  const size = (parseInt(body.slice(-4), 16) + 2) * 2;
  if (!Number.isFinite(size) || size > body.length) return { code: body, metadata: "" };
  return { code: body.slice(0, body.length - size), metadata: body.slice(body.length - size) };
}

// Walk the instructions of a hex code body, skipping the data bytes of each PUSH, and name any
// forbidden opcode found.
export function forbiddenOpcodes(code: string): string[] {
  const found = new Set<string>();
  for (let i = 0; i + 1 < code.length; i += 2) {
    const op = parseInt(code.slice(i, i + 2), 16);
    if (op >= 0x60 && op <= 0x7f) i += (op - 0x5f) * 2;
    else if (FORBIDDEN[op] !== undefined) found.add(FORBIDDEN[op]);
  }
  return [...found];
}

// A browser cannot hold the compiled artifact, so the kit ships a fingerprint of it: the runtime
// code's length, where its immutable slots sit, how long the trailing metadata blob is, and the
// hash of the code with the immutables zeroed and that blob removed. `codeHash` is keccak256 of
// exactly the bytes `codeCheck` compares (the masked, metadata-stripped runtime code), and
// `metadataHash` is keccak256 of the blob itself, so a browser can tell "byte for byte" from
// "same instructions, metadata differs" just as `codeCheck` does.
export type Fingerprint = {
  bytes: number;
  immutables: readonly { start: number; length: number }[];
  metadataBytes: number;
  codeHash: `0x${string}`;
  metadataHash: `0x${string}`;
};

export function fingerprintOf(artifact: Artifact): Fingerprint {
  const body = artifact.deployedBytecode.replace(/^0x/, "").toLowerCase();
  const immutables = Object.values(artifact.immutableReferences ?? {})
    .flat()
    .map((r) => ({ start: r.start, length: r.length }))
    .sort((a, b) => a.start - b.start);
  const split = splitMetadata(maskImmutables(body, immutables));
  return {
    bytes: body.length / 2,
    immutables,
    metadataBytes: split.metadata.length / 2,
    codeHash: keccak256(`0x${split.code}`),
    metadataHash: keccak256(`0x${split.metadata}`),
  };
}

// The code row from the fingerprint alone, with no artifact: the same screens as `codeCheck` run
// against a browser-held fingerprint, with the same three answers: byte for byte, same
// instructions with other metadata, or different. `code hash` is the whole live code's hash.
export function fingerprintCheck(onChain: `0x${string}` | undefined, usdc: Address, fp: Fingerprint): Check {
  const name = "code";
  if (!onChain || onChain === "0x") return { name, ok: false, detail: "no runtime code at the address" };
  const hash = keccak256(onChain);
  const live = onChain.replace(/^0x/, "").toLowerCase();
  if (live.length !== fp.bytes * 2) {
    return { name, ok: false, detail: `length ${live.length} vs ${fp.bytes * 2}; code hash ${hash}` };
  }
  if (fp.immutables.length === 0) {
    return { name, ok: false, detail: `the fingerprint lists no immutable slots; rebuild the contracts; code hash ${hash}` };
  }
  const want = paddedWord(usdc);
  const wrongSlot = fp.immutables.find((r) => live.slice(r.start * 2, (r.start + r.length) * 2) !== want);
  if (wrongSlot) {
    const holds = live.slice(wrongSlot.start * 2, (wrongSlot.start + wrongSlot.length) * 2);
    return { name, ok: false, detail: `the token built into the contract is 0x${holds.slice(-40)}, expected ${usdc}; code hash ${hash}` };
  }
  // Split as `codeCheck` splits it: by the length the live code states in its own last two bytes.
  // A blob of another length than the build's cannot be lined up, and fails as it does there.
  const split = splitMetadata(maskImmutables(live, fp.immutables));
  if (split.metadata.length !== fp.metadataBytes * 2 || keccak256(`0x${split.code}`) !== fp.codeHash) {
    return { name, ok: false, detail: `differs from the code this repository builds; code hash ${hash}` };
  }
  const exact = keccak256(`0x${split.metadata}`) === fp.metadataHash;
  const detail = exact
    ? `matches the code this repository builds byte for byte; token ${usdc} in ${fp.immutables.length} immutable slot(s); code hash ${hash}`
    : `same instructions as the code this repository builds, but the source metadata differs (a comment, a path or a setting that does not change the code); token ${usdc} in ${fp.immutables.length} immutable slot(s); code hash ${hash}`;
  return { name, ok: true, detail };
}

// The no-owner row from the fingerprint alone: the same two screens as `noOwnerCheck`, the opcode
// scan trimming `fp.metadataBytes` bytes off the end.
export function noOwnerByFingerprint(onChain: `0x${string}` | undefined, abi: readonly unknown[], fp: Fingerprint): Check {
  return noOwnerFrom(onChain, abi, fp.metadataBytes);
}

export function codeCheck(onChain: `0x${string}` | undefined, usdc: Address, artifact: Artifact): Check {
  if (!onChain || onChain === "0x") return { name: "code", ok: false, detail: "no runtime code at the address" };
  const hash = keccak256(onChain);
  const live = onChain.replace(/^0x/, "").toLowerCase();
  const compiled = artifact.deployedBytecode.replace(/^0x/, "").toLowerCase();
  if (live.length !== compiled.length) {
    return { name: "code", ok: false, detail: `length ${live.length} vs ${compiled.length}; code hash ${hash}` };
  }

  // Boomerang has one immutable, the token. The compiler says where it sits; without that the
  // comparison cannot be made, and the row fails instead of guessing.
  const refs = Object.values(artifact.immutableReferences ?? {}).flat();
  if (refs.length === 0) {
    return { name: "code", ok: false, detail: `the artifact lists no immutable slots; rebuild the contracts; code hash ${hash}` };
  }
  const want = paddedWord(usdc);
  const wrongSlot = refs.find((r) => live.slice(r.start * 2, (r.start + r.length) * 2) !== want);
  if (wrongSlot) {
    const holds = live.slice(wrongSlot.start * 2, (wrongSlot.start + wrongSlot.length) * 2);
    return { name: "code", ok: false, detail: `the token built into the contract is 0x${holds.slice(-40)}, expected ${usdc}; code hash ${hash}` };
  }

  const a = splitMetadata(maskImmutables(live, refs));
  const b = splitMetadata(maskImmutables(compiled, refs));
  if (a.code !== b.code) {
    return { name: "code", ok: false, detail: `differs from compiled code; code hash ${hash}` };
  }
  const exact = a.metadata === b.metadata;
  const detail = exact
    ? `matches compiled code byte for byte; token ${usdc} in ${refs.length} immutable slot(s); code hash ${hash}`
    : `same instructions as compiled code, but the source metadata differs (a comment, a path or a setting that does not change the code); token ${usdc} in ${refs.length} immutable slot(s); code hash ${hash}`;
  return { name: "code", ok: true, detail };
}

// The same runtime code can be put on chain by creation code of someone's own that first writes
// storage (a backer record nobody pledged for, say) and then returns that runtime. The code row
// cannot see that; this row can. It reads the transaction recorded at deployment and requires
// that it created this contract directly and that its input is exactly the compiled creation
// code followed by the token address. The compiler's constructor then decides the starting
// state, and it writes none beyond the token.
async function creationCheck(client: PublicClient, boomerang: Address, usdc: Address, artifact: Artifact, deployTx: `0x${string}` | null | undefined): Promise<Check> {
  const fail = (detail: string): Check => ({ name: "creation", ok: false, detail });
  if (!deployTx) return fail("no deployment transaction is recorded for this contract, so how it was created cannot be checked");
  if (!/^0x[0-9a-fA-F]{64}$/.test(deployTx)) return fail("the recorded deployment transaction is not a transaction hash");
  if (!artifact.bytecode || artifact.bytecode.length <= 2) return fail("the artifact has no creation code; rebuild the contracts");
  const [tx, receipt] = await Promise.all([client.getTransaction({ hash: deployTx }), client.getTransactionReceipt({ hash: deployTx })]);
  if (receipt.status !== "success") return fail(`transaction ${deployTx} did not succeed`);
  if (tx.to !== null || !receipt.contractAddress) return fail(`transaction ${deployTx} did not create a contract directly (it called ${tx.to ?? "nothing"})`);
  if (receipt.contractAddress.toLowerCase() !== boomerang.toLowerCase()) return fail(`transaction ${deployTx} created ${receipt.contractAddress}, not ${boomerang}`);

  const sent = tx.input.replace(/^0x/, "").toLowerCase();
  const compiled = artifact.bytecode.replace(/^0x/, "").toLowerCase();
  const want = paddedWord(usdc);
  if (sent.length !== compiled.length + want.length) return fail(`the creation input is ${sent.length / 2} bytes; the compiled creation code and one address are ${(compiled.length + want.length) / 2}`);
  if (sent.slice(compiled.length) !== want) return fail(`the constructor was given 0x${sent.slice(-40)}, expected ${usdc}`);
  // The creation code ends with the same metadata blob the runtime code ends with. As in the
  // code row, a difference there alone (a comment, a path) is named and allowed.
  const metadata = splitMetadata(artifact.deployedBytecode.replace(/^0x/, "").toLowerCase()).metadata.length;
  const body = compiled.length - metadata;
  if (sent.slice(0, body) !== compiled.slice(0, body)) return fail("the creation code sent is not the compiled creation code");
  const exact = sent.slice(body, compiled.length) === compiled.slice(body);
  return {
    name: "creation",
    ok: true,
    detail: `created directly by transaction ${deployTx} in block ${receipt.blockNumber}; its input is the compiled creation code${exact ? "" : " (source metadata differs)"} and the token address, nothing else`,
  };
}

// The two no-owner screens, from the ABI and the runtime code with its last `metadataBytes` bytes
// trimmed. Shared by the artifact row below and the fingerprint row above, so both read the same.
export function noOwnerFrom(onChain: `0x${string}` | undefined, abi: readonly unknown[], metadataBytes: number): Check {
  const functions = (abi as { type?: string; name?: string; stateMutability?: string }[]).filter(
    (x) => x.type === "function",
  );
  const flagged = functions.filter((f) => typeof f.name === "string" && PRIVILEGED.test(f.name)).map((f) => f.name);
  const changing = functions
    .filter((f) => f.stateMutability === "nonpayable" || f.stateMutability === "payable")
    .map((f) => f.name);
  if (flagged.length > 0) {
    return { name: "no-owner", ok: false, detail: `privileged function(s): ${flagged.join(", ")}` };
  }
  if (!onChain || onChain === "0x") return { name: "no-owner", ok: false, detail: "no runtime code at the address" };
  const live = onChain.replace(/^0x/, "").toLowerCase();
  const opcodes = forbiddenOpcodes(live.slice(0, Math.max(0, live.length - metadataBytes * 2)));
  if (opcodes.length > 0) {
    return { name: "no-owner", ok: false, detail: `the deployed code contains ${opcodes.join(", ")}` };
  }
  return {
    name: "no-owner",
    ok: true,
    detail: `no ${Object.values(FORBIDDEN).join(", ")} in the deployed code; state-changing functions: ${changing.join(", ")}`,
  };
}

export function noOwnerCheck(onChain: `0x${string}` | undefined, artifact: Artifact): Check {
  // The metadata blob at the end is data, not instructions, and is left out of the scan. How
  // long it is comes from the compiled artifact, never from what the deployed code says of itself.
  const metadataChars = splitMetadata(artifact.deployedBytecode.replace(/^0x/, "").toLowerCase()).metadata.length;
  return noOwnerFrom(onChain, artifact.abi, metadataChars / 2);
}

const BALANCE_OF_ABI = [
  { inputs: [{ name: "a", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

export async function custodyCheck(client: PublicClient, boomerang: Address, usdc: Address, abi: Abi, blockNumber: bigint): Promise<Check> {
  const held = (await client.readContract({ address: usdc, abi: BALANCE_OF_ABI, functionName: "balanceOf", args: [boomerang], blockNumber })) as bigint;
  const owed = (await client.readContract({ address: boomerang, abi, functionName: "totalOwed", blockNumber })) as bigint;
  const ok = held >= owed;
  return { name: "custody", ok, detail: `holds ${held}, owes ${owed}, at block ${blockNumber}` };
}

export type Range = { from: bigint; to: bigint };

/**
 * How the ledger row reads the contract's logs.
 *
 * `hints` names blocks said to hold the contract's events. Whoever names them (an explorer) is
 * not trusted: the logs themselves are asked of the node, and the read counts as whole only when
 * the events are numbered 1 to N with none missing and N is the contract's own `eventCount` at
 * the same block. Short of that the row reads the blocks after the last named one, and failing
 * that every block, as it does when nobody names any.
 *
 * `gapMs` is the pause between two log requests (none unless set): a public node takes only so
 * many a second. `wait` stands in for the clock in tests.
 */
export type LedgerRead = {
  hints?: { from: string; blocks: () => Promise<readonly bigint[]> };
  gapMs?: number;
  wait?: (ms: number) => Promise<void>;
};

// What a refused log request is given before it is asked again: 63 seconds in all, which outlasts
// a limit counted by the clock minute.
const REFUSAL_WAITS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000];

/** The named blocks inside [fromBlock, toBlock], as the fewest ranges of at most `chunk` blocks that hold them all. */
export function hintRanges(hints: readonly bigint[], fromBlock: bigint, toBlock: bigint, chunk: bigint): Range[] {
  if (chunk < 1n) throw new Error("the log chunk must be at least 1 block");
  const blocks = [...new Set(hints.filter((h) => typeof h === "bigint" && h >= fromBlock && h <= toBlock))].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const out: Range[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (last !== undefined && b <= last.from + chunk - 1n) last.to = b;
    else out.push({ from: b, to: b });
  }
  return out;
}

/** [fromBlock, toBlock] cut into ranges of `chunk` blocks; none when the range is empty. */
function chunksOf(fromBlock: bigint, toBlock: bigint, chunk: bigint): Range[] {
  if (chunk < 1n) throw new Error("the log chunk must be at least 1 block");
  const out: Range[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    out.push({ from: start, to: start + chunk - 1n < toBlock ? start + chunk - 1n : toBlock });
  }
  return out;
}

// A node saying "too many requests": HTTP or JSON-RPC 429, those words, or JSON-RPC -32005 (which
// some nodes also use for an answer that is too large: that one is not a matter of waiting), on
// the error or on what caused it.
function isRateLimit(e: unknown): boolean {
  let at: unknown = e;
  for (let depth = 0; depth < 6 && at !== null && typeof at === "object"; depth++) {
    const err = at as { code?: unknown; status?: unknown; message?: unknown; details?: unknown; shortMessage?: unknown; cause?: unknown };
    const texts = [err.message, err.details, err.shortMessage].filter((t): t is string => typeof t === "string");
    if (err.status === 429 || err.code === 429) return true;
    if (texts.some((t) => /rate limit|too many requests/i.test(t))) return true;
    if (err.code === -32005 && !texts.some((t) => /result|range|block/i.test(t))) return true;
    at = err.cause;
  }
  return false;
}

// A block's time as a log may carry it (Arc's logs do): a bigint, a hex string or a whole number.
function ownTime(log: unknown): bigint | null {
  const t = (log as { blockTimestamp?: unknown }).blockTimestamp;
  if (typeof t === "bigint") return t >= 0n ? t : null;
  if (typeof t === "number") return Number.isSafeInteger(t) && t >= 0 ? BigInt(t) : null;
  if (typeof t === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(t)) return BigInt(t);
  return null;
}

/**
 * Reads the contract's logs range by range, each log with its block's time. One reader serves one
 * run of the row: it keeps the pace across every range it is given (`gapMs` between two requests,
 * a refused request asked again after 1, 2, 4... seconds) and asks for a block's time once.
 */
function logReader(client: PublicClient, boomerang: Address, read: LedgerRead, onChunk?: (done: number, of: number) => void) {
  const wait = read.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const gapMs = read.gapMs ?? 0;
  const times = new Map<bigint, bigint>();
  let asked = false;

  const logsOf = async (r: Range) => {
    for (let attempt = 0; ; attempt++) {
      if (asked && gapMs > 0 && attempt === 0) await wait(gapMs);
      asked = true;
      try {
        return await client.getLogs({ address: boomerang, fromBlock: r.from, toBlock: r.to });
      } catch (e) {
        if (!isRateLimit(e)) throw e;
        if (attempt >= REFUSAL_WAITS.length) throw new Error("the node refused the log requests for over a minute (its rate limit); try again in a minute");
        await wait(REFUSAL_WAITS[attempt]);
      }
    }
  };

  return async (ranges: readonly Range[]): Promise<RawLog[]> => {
    const raw: RawLog[] = [];
    let done = 0;
    for (const r of ranges) {
      for (const lg of await logsOf(r)) {
        const bn = lg.blockNumber!;
        let t = times.get(bn);
        if (t === undefined) {
          t = ownTime(lg) ?? (await client.getBlock({ blockNumber: bn })).timestamp;
          times.set(bn, t);
        }
        raw.push({ address: lg.address, topics: lg.topics, data: lg.data, blockNumber: bn, blockTimestamp: t });
      }
      done += 1;
      onChunk?.(done, ranges.length);
    }
    return raw;
  };
}

// The ledger the logs make, or null when they cannot be applied at all (a part of them is not a ledger).
function ledgerOf(raw: readonly RawLog[], boomerang: Address) {
  try {
    const ledger = emptyLedger();
    applyEvents(ledger, decodeLogs([...raw], boomerang));
    return ledger;
  } catch {
    return null;
  }
}

/**
 * The blocks an explorer (Blockscout's API, as Arc's runs it) lists logs of `contract` in. Only
 * the block numbers are taken, each checked to be a plain number; nothing else of the answer is
 * kept or repeated, in a failure either. It throws when the explorer cannot be read or lists more
 * than `maxPages` pages; the caller then reads every block instead.
 */
export async function explorerBlocks(
  explorer: string,
  contract: Address,
  fetch: (url: string) => Promise<{ status: number; json(): Promise<unknown> }>,
  maxPages = 40,
): Promise<bigint[]> {
  const base = `${explorer}/api/v2/addresses/${contract}/logs`;
  const blocks: bigint[] = [];
  let query = "";
  for (let pageNo = 0; pageNo < maxPages; pageNo++) {
    const res = await fetch(base + query);
    if (res.status !== 200) throw new Error(`the explorer answered with status ${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const b = body as { items?: unknown; next_page_params?: unknown } | null;
    if (b === null || typeof b !== "object" || !Array.isArray(b.items)) throw new Error("the explorer's list of logs could not be read");
    for (const item of b.items) {
      const n = (item as { block_number?: unknown } | null)?.block_number;
      if (typeof n === "string" && /^[0-9]{1,15}$/.test(n)) blocks.push(BigInt(n));
      else if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) blocks.push(BigInt(n));
      else throw new Error("the explorer's list of logs could not be read");
    }
    const next = b.next_page_params;
    if (next === null || next === undefined) return blocks;
    if (typeof next !== "object" || Array.isArray(next)) throw new Error("the explorer's list of logs could not be read");
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(next as Record<string, unknown>)) {
      if (typeof v !== "string" && typeof v !== "number") throw new Error("the explorer's list of logs could not be read");
      params.set(k, String(v));
    }
    query = `?${params.toString()}`;
  }
  throw new Error("the explorer lists more pages of logs than this check follows");
}

export async function ledgerCheck(
  client: PublicClient,
  boomerang: Address,
  abi: Abi,
  fromBlock: bigint,
  toBlock: bigint,
  chunk: bigint,
  onChunk?: (done: number, of: number) => void,
  how: LedgerRead = {},
): Promise<Check> {
  if (chunk < 1n) throw new Error("the log chunk must be at least 1 block");
  const read = <T>(fn: string, args: readonly unknown[] = []) => client.readContract({ address: boomerang, abi, functionName: fn, args, blockNumber: toBlock }) as Promise<T>;
  const logsIn = logReader(client, boomerang, how, onChunk);
  // The contract's own count of its events at this block: what makes a read of only some blocks whole.
  const eventCount = await read<bigint>("eventCount");
  const whole = (l: ReturnType<typeof ledgerOf>): boolean => l !== null && missing(l) === null && l.lastSeq === eventCount;

  let ledger: ReturnType<typeof ledgerOf> = null;
  let readAs = "";
  if (how.hints !== undefined) {
    let named: readonly bigint[] = [];
    try {
      named = await how.hints.blocks();
    } catch {
      named = [];
    }
    const ranges = Array.isArray(named) ? hintRanges(named, fromBlock, toBlock, chunk) : [];
    // Naming more ranges than a read of every block would take is no help.
    const fullCount = toBlock < fromBlock ? 0n : (toBlock - fromBlock) / chunk + 1n;
    if (ranges.length > 0 && BigInt(ranges.length) < fullCount) {
      const where = `${ranges.length} range(s) of blocks named by ${how.hints.from}`;
      let raw = await logsIn(ranges);
      let made = ledgerOf(raw, boomerang);
      if (made !== null && whole(made)) {
        ledger = made;
        readAs = `the logs were read from the node at ${where}, and the contract's own count of ${eventCount} event(s) shows none is missing`;
      } else if (made !== null && missing(made) === null && made.lastSeq < eventCount) {
        // Numbered from 1 with no hole, but short of the count: the rest is after the last named block.
        raw = raw.concat(await logsIn(chunksOf(ranges[ranges.length - 1].to + 1n, toBlock, chunk)));
        made = ledgerOf(raw, boomerang);
        if (made !== null && whole(made)) {
          ledger = made;
          readAs = `the logs were read from the node at ${where} and every block after them, and the contract's own count of ${eventCount} event(s) shows none is missing`;
        }
      }
    }
  }
  if (ledger === null) {
    const raw = await logsIn(chunksOf(fromBlock, toBlock, chunk));
    ledger = emptyLedger();
    applyEvents(ledger, decodeLogs(raw, boomerang));
    readAs = `every block from ${fromBlock} was read`;
  }

  const gap = missing(ledger);
  if (gap !== null) return { name: "ledger", ok: false, detail: `the ledger is waiting for seq ${gap.from}..${gap.to}; a log is missing from the scanned range` };

  if (ledger.lastSeq !== eventCount) return { name: "ledger", ok: false, detail: `lastSeq ${ledger.lastSeq} but the contract's eventCount is ${eventCount}` };
  const totalOwed = await read<bigint>("totalOwed");
  if (ledger.totalOwed !== totalOwed) return { name: "ledger", ok: false, detail: `ledger totalOwed ${ledger.totalOwed} but the contract owes ${totalOwed}` };

  const campaignCount = await read<bigint>("campaignCount");
  let backersCompared = 0;
  for (let id = 1n; id <= campaignCount; id++) {
    const c = ledger.campaigns.get(id);
    if (c === undefined) return { name: "ledger", ok: false, detail: `campaign ${id} exists on-chain but not in the ledger` };
    const s = await read<State>("stateOf", [id]);
    const fields: [string, bigint | number | boolean, bigint | number | boolean][] = [
      ["outcome", c.outcome, s.outcome],
      ["matchIn", c.matchIn, s.matchIn],
      ["bonusIn", c.bonusIn, s.bonusIn],
      ["recipientPaid", c.recipientPaid, s.recipientPaid],
      ["matchReturned", c.matchReturned, s.matchReturned],
      ["bonusReturned", c.bonusReturned, s.bonusReturned],
      ["pledged", c.pledged, s.pledged],
      ["pledgedEarly", c.pledgedEarly, s.pledgedEarly],
      ["weighted", c.weighted, s.weighted],
      ["bonusPaid", c.bonusPaid, s.bonusPaid],
      ["backers", BigInt(c.backers.size), BigInt(s.backers)],
    ];
    for (const [name, mine, theirs] of fields) {
      if (mine !== theirs) return { name: "ledger", ok: false, detail: `campaign ${id} ${name}: ledger ${mine} vs contract ${theirs}` };
    }
    for (const [addr, b] of c.backers) {
      const chain = await read<Backer>("backerOf", [id, addr as Address]);
      if (b.principal !== chain.principal) return { name: "ledger", ok: false, detail: `campaign ${id} backer ${addr} principal: ledger ${b.principal} vs contract ${chain.principal}` };
      if (b.weighted !== chain.weighted) return { name: "ledger", ok: false, detail: `campaign ${id} backer ${addr} weighted: ledger ${b.weighted} vs contract ${chain.weighted}` };
      if (b.paid !== chain.paid) return { name: "ledger", ok: false, detail: `campaign ${id} backer ${addr} paid: ledger ${b.paid} vs contract ${chain.paid}` };
      if (b.payTo !== null && b.payTo.toLowerCase() !== chain.payTo.toLowerCase()) {
        return { name: "ledger", ok: false, detail: `campaign ${id} backer ${addr} payTo: ledger ${b.payTo} vs contract ${chain.payTo}` };
      }
      backersCompared++;
    }
  }
  return { name: "ledger", ok: true, detail: `${campaignCount} campaign(s), ${backersCompared} backer(s), seq 1..${ledger.lastSeq} match the contract at block ${toBlock}; ${readAs}` };
}

const helperAbi = [
  { type: "function", name: "usdc", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "boomerang", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

// SignedPledge, the one-signature pledge helper: its instructions are the compiled ones (its two
// immutables masked), and the two it holds are this token and this Boomerang, read at one block.
async function helperCheck(client: PublicClient, helper: Address, usdc: Address, boomerang: Address, artifact: Artifact, blockNumber: bigint): Promise<Check> {
  const name = "signed-pledge";
  const onChain = await client.getCode({ address: helper, blockNumber });
  if (!onChain || onChain === "0x") return { name, ok: false, detail: `no runtime code at ${helper}` };
  const hash = keccak256(onChain);
  const live = onChain.replace(/^0x/, "").toLowerCase();
  const compiled = artifact.deployedBytecode.replace(/^0x/, "").toLowerCase();
  const refs = Object.values(artifact.immutableReferences ?? {}).flat();
  if (refs.length === 0) return { name, ok: false, detail: `the helper's artifact lists no immutable slots; rebuild the contracts; code hash ${hash}` };
  if (live.length !== compiled.length || splitMetadata(maskImmutables(live, refs)).code !== splitMetadata(maskImmutables(compiled, refs)).code) {
    return { name, ok: false, detail: `the code at ${helper} is not the compiled SignedPledge; code hash ${hash}` };
  }
  // Every slot the compiler set aside must hold one of the two addresses, each immutable the same
  // one in all its slots, and the two immutables different ones: so the address the calls use is
  // the address the getters show, which are checked next.
  const groups = Object.values(artifact.immutableReferences ?? {}).filter((g) => g.length > 0);
  const allowed = new Set([paddedWord(usdc), paddedWord(boomerang)]);
  const held = groups.map((g) => new Set(g.map((r) => live.slice(r.start * 2, (r.start + r.length) * 2))));
  if (groups.length !== 2 || held.some((h) => h.size !== 1 || !allowed.has([...h][0])) || [...held[0]][0] === [...held[1]][0]) {
    return { name, ok: false, detail: `the addresses built into the code at ${helper} are not this token and this Boomerang, one in every slot of each; code hash ${hash}` };
  }
  const [t, b] = await Promise.all([
    client.readContract({ address: helper, abi: helperAbi, functionName: "usdc", blockNumber }),
    client.readContract({ address: helper, abi: helperAbi, functionName: "boomerang", blockNumber }),
  ]);
  if (t.toLowerCase() !== usdc.toLowerCase()) return { name, ok: false, detail: `the helper's token is ${t}, expected ${usdc}` };
  if (b.toLowerCase() !== boomerang.toLowerCase()) return { name, ok: false, detail: `the helper's boomerang is ${b}, expected ${boomerang}` };
  return { name, ok: true, detail: `${helper} runs the compiled SignedPledge, bound to token ${usdc} and boomerang ${boomerang}; code hash ${hash}` };
}

export async function checkLive(o: {
  client: PublicClient;
  boomerang: Address;
  usdc: Address;
  fromBlock: bigint;
  artifact: Artifact;
  /** The hash of the transaction that created the contract, as the deploy script recorded it. */
  deployTx?: `0x${string}` | null;
  chunk?: bigint;
  /** How the ledger row reads the logs: blocks someone names, the pace, the clock (see LedgerRead). */
  read?: LedgerRead;
  /** Called after each log request of the ledger row with how many are done and how many in all. */
  onChunk?: (done: number, of: number) => void;
  /** SignedPledge, when deployed: adds a sixth row. */
  helper?: { address: Address; artifact: Artifact };
}): Promise<Check[]> {
  const { client, boomerang, usdc, fromBlock, artifact } = o;
  // 10,000 blocks is the most Arc's node takes in one log request (measured 2026-11-18).
  const chunk = o.chunk ?? 10_000n;
  const abi = artifact.abi as Abi;

  const guard = async (name: string, run: () => Promise<Check>): Promise<Check> => {
    try {
      return await run();
    } catch (e) {
      return { name, ok: false, detail: short(e) };
    }
  };

  // The runtime code is read once and serves two rows.
  let onChain: `0x${string}` | undefined;
  let codeError: string | null = null;
  try {
    onChain = await client.getCode({ address: boomerang });
  } catch (e) {
    codeError = short(e);
  }
  const code = codeError !== null ? { name: "code", ok: false, detail: codeError } : await guard("code", async () => codeCheck(onChain, usdc, artifact));
  const noOwner = codeError !== null ? { name: "no-owner", ok: false, detail: codeError } : await guard("no-owner", async () => noOwnerCheck(onChain, artifact));
  const creation = await guard("creation", () => creationCheck(client, boomerang, usdc, artifact, o.deployTx));

  // One block number for the custody snapshot and the ledger's upper bound, read once.
  let blockNumber: bigint;
  try {
    blockNumber = await client.getBlockNumber();
  } catch (e) {
    const detail = short(e);
    const failed = [code, creation, noOwner, { name: "custody", ok: false, detail }, { name: "ledger", ok: false, detail }];
    return o.helper ? [...failed, { name: "signed-pledge", ok: false, detail }] : failed;
  }
  const custody = await guard("custody", () => custodyCheck(client, boomerang, usdc, abi, blockNumber));
  const ledger = await guard("ledger", () => ledgerCheck(client, boomerang, abi, fromBlock, blockNumber, chunk, o.onChunk, o.read));
  if (!o.helper) return [code, creation, noOwner, custody, ledger];
  const { address, artifact: helperArtifact } = o.helper;
  const helper = await guard("signed-pledge", () => helperCheck(client, address, usdc, boomerang, helperArtifact, blockNumber));
  return [code, creation, noOwner, custody, ledger, helper];
}

function short(e: unknown): string {
  const err = e as { shortMessage?: string; details?: string; message?: string };
  const msg = e instanceof Error ? err.shortMessage ?? err.message ?? String(e) : String(e);
  const first = msg.split("\n")[0];
  // viem's short message often drops the cause ("An unknown RPC error occurred."); keep it.
  const cause = typeof err.details === "string" && err.details.length > 0 && !first.includes(err.details) ? ` (${err.details.split("\n")[0]})` : "";
  return (first + cause).slice(0, 240);
}
