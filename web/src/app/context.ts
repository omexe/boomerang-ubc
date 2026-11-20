// What every page is handed: the latest read, the configuration, and the few things a page can do.
import type { Address } from "../../../packages/kit/src/index.ts";
import type { DeskAnswer, DeskKind } from "../data/ask.ts";
import type { Label } from "../data/labels.ts";
import type { Call } from "../flows/calls.ts";
import type { Answer } from "../views/pledge.ts";
import type { Config } from "./config.ts";
import type { World } from "./world.ts";

export type SendState = { key: string; lines: string[]; error: string | null; busy: boolean; done: boolean };

/**
 * How a one-signature pledge ended: in (the pledge is on the chain); stopped (declined, or sent
 * and not yet confirmed: the send state says which); or fallback, with the sentence to show. A
 * signature that may still land is remembered by the app (flows/outstanding.ts), and `signedGuard`
 * holds every pledge to that campaign back until its window has passed.
 */
export type RelayOutcome = { kind: "done" } | { kind: "stopped" } | { kind: "fallback"; line: string };

/** Before any pledge to a campaign: clear; wait `left` seconds for a remembered signature; one landed after all; or the chain could not be asked. */
export type SignedGuard = { kind: "clear" } | { kind: "wait"; left: bigint } | { kind: "landed" } | { kind: "unknown" };

export type Ctx = {
  config: Config;
  world: World;
  labels: readonly Label[];
  /** The desk address the keeper's /health reports, used only to decide whether to offer the desk buttons (deskOffer). Campaign naming uses config.desk, never this. */
  desk: Address | null;
  /** The helper the keeper's /health says it relays one-signature pledges through; null when the keeper is down or relays none. */
  relay: Address | null;
  /** The connected account; the world's wallet figures are this account's only when `world.account` equals it. */
  account: Address | null;
  onRightChain: boolean;
  /** False while the chain cannot be read or another send is under way. */
  maySend: boolean;
  send(key: string, calls: readonly Call[]): Promise<boolean>;
  /** Pledge `amount` to campaign `id` with one signature, which the keeper submits. `closesAt` bounds the signature's window. */
  relayPledge(key: string, o: { id: bigint; amount: bigint; closesAt: bigint }): Promise<RelayOutcome>;
  /** Ask before sending any pledge to campaign `id`, signed or two-step. */
  signedGuard(id: bigint): Promise<SignedGuard>;
  sendState(key: string): SendState | null;
  connect(): void;
  /** Whether this browser has any wallet at all; without one `connect` has nothing to open. */
  hasWallet: boolean;
  /**
   * Start, or pick up again, the practice wallet: a key this page makes and keeps in this browser,
   * for test money only. A new one is given USDC by the desk. Null where it cannot be offered (no
   * desk to fund a new one and no key from an earlier visit) or one is already in use.
   */
  practice: (() => void) | null;
  /** True while the practice wallet is being made and the desk asked. */
  practiceBusy: boolean;
  /** Whether the connected account is the practice wallet's. */
  practising: boolean;
  /** A campaign the desk has just opened and the next read has not shown yet. */
  expected(id: bigint): boolean;
  expect(id: bigint): void;
  /** Ask the contract what a pledge of `amount` to campaign `id` would do, now. */
  quote(id: bigint, amount: bigint): Promise<Answer>;
  askForUsdc(): Promise<DeskAnswer>;
  /** Whether the desk has said it will not send USDC to the connected account again (it gave, or had given). */
  hadUsdc: boolean;
  askForCampaign(kind: DeskKind): Promise<DeskAnswer & { id: bigint | null }>;
  refresh(): void;
};
