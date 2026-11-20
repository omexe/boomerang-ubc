// Asking the keeper: its ledger and health for the feed and the Proof page, and the demo desk's
// two buttons. The keeper is a convenience, so nothing here throws: a keeper that is absent,
// slow or answering nonsense comes back as a plain reason, and the page carries on without it.
import type { Address } from "../../../packages/kit/src/index.ts";
import { readHealth, type HealthView } from "./health.ts";
import { readLedger, type LedgerView } from "./keeper.ts";

export type Fetch = (
  url: string,
  init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: string; signal: AbortSignal; redirect: "error"; credentials: "omit"; cache: "no-store" },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export type KeeperAnswer =
  | { up: true; ledger: LedgerView; health: HealthView }
  | { up: false; why: "none" | "unreachable" | "unreadable" };

const init = (ms: number) => ({ signal: AbortSignal.timeout(ms), redirect: "error", credentials: "omit", cache: "no-store" }) as const;

/** The keeper's ledger and health, or why not. `url` is null when the site runs without a keeper. */
export async function askKeeper(o: { url: string | null; fetch: Fetch; timeoutMs?: number }): Promise<KeeperAnswer> {
  if (o.url === null) return { up: false, why: "none" };
  const ms = o.timeoutMs ?? 4000;
  let raw: [unknown, unknown];
  try {
    const [l, h] = await Promise.all([o.fetch(`${o.url}/ledger`, { method: "GET", ...init(ms) }), o.fetch(`${o.url}/health`, { method: "GET", ...init(ms) })]);
    if (l.status !== 200 || h.status !== 200) return { up: false, why: "unreachable" };
    raw = [await l.json(), await h.json()];
  } catch {
    return { up: false, why: "unreachable" };
  }
  try {
    return { up: true, ledger: readLedger(raw[0]), health: readHealth(raw[1]) };
  } catch {
    return { up: false, why: "unreadable" };
  }
}

export type DeskAnswer = { ok: true; line: string } | { ok: false; line: string };

// The desk's refusals, each in a sentence. A reason this page does not know gets the last one.
const REFUSALS: Record<string, string> = {
  "bad-address": "The desk could not use that address.",
  "already-given": "This address has already had its USDC from the desk.",
  "desk-low": "The desk is out of USDC for now. Circle's faucet gives USDC for Arc Testnet.",
  "campaign-open": "A campaign from the desk is already running. It is on the list; a new one can open when it ends.",
  busy: "The desk is busy. Try again in a moment.",
  "no-desk": "This site's keeper is not running a desk.",
  unconfirmed: "The desk sent it, but the chain has not confirmed it yet. Check your balance in a moment; the desk will not send to this address again.",
  failed: "The desk could not do that just now.",
};
const DOWN = "The desk could not be reached.";

async function post(o: { url: string | null; fetch: Fetch; timeoutMs?: number }, path: string, body: unknown): Promise<{ ok: boolean; reason: string; id: string | null } | null> {
  if (o.url === null) return null;
  try {
    const res = await o.fetch(`${o.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...init(o.timeoutMs ?? 60_000) });
    const j = await res.json();
    if (j === null || typeof j !== "object") return null;
    const a = j as { ok?: unknown; reason?: unknown; id?: unknown };
    if (typeof a.ok !== "boolean") return null;
    return { ok: a.ok, reason: typeof a.reason === "string" ? a.reason : "", id: typeof a.id === "string" && /^[0-9]{1,30}$/.test(a.id) ? a.id : null };
  } catch {
    return null;
  }
}

const said = (a: { ok: boolean; reason: string } | null, done: string): DeskAnswer =>
  a === null ? { ok: false, line: DOWN } : a.ok ? { ok: true, line: done } : { ok: false, line: Object.hasOwn(REFUSALS, a.reason) ? REFUSALS[a.reason] : REFUSALS.failed };

export type RelayAnswer = { ok: true; hash: `0x${string}` } | { ok: false; reason: string | null };

/** Hand a signed pledge to the keeper. `reason` is the keeper's refusal, or null when it gave no answer that can be read in time. */
export async function askRelay(o: { url: string | null; fetch: Fetch; body: unknown; timeoutMs?: number }): Promise<RelayAnswer> {
  if (o.url === null) return { ok: false, reason: "no-relay" };
  try {
    const res = await o.fetch(`${o.url}/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o.body), ...init(o.timeoutMs ?? 20_000) });
    const j = (await res.json()) as { ok?: unknown; reason?: unknown; hash?: unknown } | null;
    if (j === null || typeof j !== "object") return { ok: false, reason: null };
    if (j.ok === true) return typeof j.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(j.hash) ? { ok: true, hash: j.hash as `0x${string}` } : { ok: false, reason: null };
    return { ok: false, reason: typeof j.reason === "string" ? j.reason.slice(0, 40) : null };
  } catch {
    return { ok: false, reason: null };
  }
}

// The refusals after which the desk counts the address as given and will not send to it again.
const GIVEN = new Set(["already-given", "unconfirmed"]);
/** The desk's answer about USDC. `had` says the desk will not send to this address again: it sent just now, had sent before, or sent something it could not confirm. */
export type UsdcAnswer = DeskAnswer & { had: boolean };

/** Ask the desk for test USDC for `address`. */
export async function askForUsdc(o: { url: string | null; fetch: Fetch; address: Address; timeoutMs?: number }): Promise<UsdcAnswer> {
  const a = await post(o, "/demo/usdc", { address: o.address });
  return { ...said(a, "The desk sent 2.00 USDC to your address."), had: a !== null && (a.ok || GIVEN.has(a.reason)) };
}

/** The two campaigns the desk opens: the same pots on different times. */
export type DeskKind = "two" | "ten";
// Each kind has its own path at the keeper and its own sentence. The times in the sentences are
// the desk's constants (tested against them) plus the half minute the keeper takes to settle.
const KINDS: Record<DeskKind, { path: string; done: string }> = {
  two: { path: "/demo/campaign/two", done: "A two-minute campaign is open. It takes pledges in under a minute and settles in about three and a half minutes." },
  ten: { path: "/demo/campaign", done: "A ten-minute campaign is open. It takes pledges in about a minute and settles in about eleven." },
};

/** Ask the desk to open a demo campaign of one kind; `id` is the new campaign's number when it did. */
export async function askForCampaign(o: { url: string | null; fetch: Fetch; timeoutMs?: number; kind: DeskKind }): Promise<DeskAnswer & { id: bigint | null }> {
  const kind = KINDS[o.kind];
  const a = await post(o, kind.path, {});
  const answer = said(a, kind.done);
  return { ...answer, id: a !== null && a.ok && a.id !== null ? BigInt(a.id) : null };
}
