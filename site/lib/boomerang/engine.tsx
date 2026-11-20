"use client";

// The site's one stateful piece for the working pages (login, explore, campaign). It is the
// existing app's engine (web/src/app/App.tsx) without its router and screens: it keeps the
// wallet, the latest read of the chain and whatever is being sent, and hands pages a `Ctx`, the
// same object the existing pages take, so every rule and sentence comes from the shared code.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createWalletClient, custom, type Abi } from "viem";

import { authorizationStateAbi, boomerangAbi, type Address } from "../../../packages/kit/src/index.ts";
import { askForCampaign, askForUsdc, askKeeper, askRelay, type Fetch } from "../../../web/src/data/ask.ts";
import { explain } from "../../../web/src/data/errors.ts";
import { readLabels, type Label } from "../../../web/src/data/labels.ts";
import { oneAtATime, sendEach, type Call } from "../../../web/src/flows/calls.ts";
import { givenStore } from "../../../web/src/flows/given.ts";
import { outstandingStore, signedWait } from "../../../web/src/flows/outstanding.ts";
import { authorization, newSalt, relayBody } from "../../../web/src/flows/signed.ts";
import { fallbackLine, relayLine, relayRefusedBeforeSending } from "../../../web/src/views/pledge.ts";
import { PRACTICE, practiceResult } from "../../../web/src/views/practice.ts";
import { stepLine, WORDS } from "../../../web/src/views/shell.ts";
import { connect as askWallet, connected, declined, discover, ensureChain, type FoundWallet } from "../../../web/src/wallet/injected.ts";
import { browserKeyStore, PRACTICE_ID, practiceWallet } from "../../../web/src/wallet/practice.ts";
import { chainOf, clientFor } from "../../../web/src/app/chain.ts";
import { configFrom, ConfigError, type Config } from "../../../web/src/app/config.ts";
import type { Ctx, RelayOutcome, SendState, SignedGuard } from "../../../web/src/app/context.ts";
import { startPoll, type Poll, type PollHost } from "../../../web/src/app/poll.ts";
import { campaignIn, readWorld, type World } from "../../../web/src/app/world.ts";
import { mockWorld } from "./mock";

const MOCK = process.env.NEXT_PUBLIC_MOCK === "1";

const EVERY_MS = 4000;
const netFetch: Fetch = (url, init) => fetch(url, init);

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const pollHost: PollHost = {
  visible: () => document.visibilityState === "visible",
  onVisibility: (fn) => {
    document.addEventListener("visibilitychange", fn);
    return () => document.removeEventListener("visibilitychange", fn);
  },
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (handle) => window.clearTimeout(handle as number),
};

const chainNumber = (v: unknown): number | null => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{1,13}$/.test(v)) return null;
  return Number.parseInt(v, 16);
};

// Build-time settings. On Arc Testnet the contract addresses always come from the kit's
// deployment file; only the keeper's address is set here (NEXT_PUBLIC_KEEPER_URL).
function siteConfig(): { config: Config | null; problem: string | null } {
  try {
    return { config: configFrom({ VITE_KEEPER_URL: process.env.NEXT_PUBLIC_KEEPER_URL }), problem: null };
  } catch (e) {
    return { config: null, problem: e instanceof ConfigError ? e.message : "The site's settings could not be read." };
  }
}

export type Role = "backer" | "sponsor";

export type WalletState = {
  account: Address | null;
  practising: boolean;
  practiceBusy: boolean;
  /** The desk's answer once a new practice wallet is set up. */
  practiceNote: { ok: boolean; line: string } | null;
  walletError: string | null;
  wrongNetwork: boolean;
  /** Whether this browser has any wallet of its own (false once the search has ended and found none). */
  hasWallet: boolean;
  wallets: FoundWallet[];
  choosing: boolean;
  balance: bigint | null;
  startPractice(): Promise<boolean>;
  connect(): void;
  choose(w: FoundWallet): void;
  cancelChoose(): void;
  switchNetwork(): void;
  logOut(): void;
};

export type Engine = {
  config: Config | null;
  problem: string | null;
  labels: readonly Label[];
  world: World | null;
  readFailed: boolean;
  /** Null until the chain has been read once. */
  ctx: Ctx | null;
  wallet: WalletState;
  role: Role | null;
  setRole(r: Role | null): void;
  /** The campaign a page shows, so each read takes in its backers. */
  show(id: bigint | null): void;
};

const EngineContext = createContext<Engine | null>(null);

export function useEngine(): Engine {
  const e = useContext(EngineContext);
  if (!e) throw new Error("useEngine must be used inside BoomerangProvider");
  return e;
}

/** Point every read at a campaign while a page shows it. */
export function useShownCampaign(id: bigint | null) {
  const { show } = useEngine();
  useEffect(() => {
    show(id);
    return () => show(null);
  }, [id, show]);
}

export function BoomerangProvider({ children }: { children: React.ReactNode }) {
  const [{ config, problem }] = useState(siteConfig);
  if (!config) {
    return (
      <EngineContext.Provider value={stoppedEngine(problem)}>
        {children}
      </EngineContext.Provider>
    );
  }
  return <Running config={config}>{children}</Running>;
}

function stoppedEngine(problem: string | null): Engine {
  const noop = () => {};
  return {
    config: null,
    problem,
    labels: [],
    world: null,
    readFailed: true,
    ctx: null,
    wallet: {
      account: null,
      practising: false,
      practiceBusy: false,
      practiceNote: null,
      walletError: null,
      wrongNetwork: false,
      hasWallet: false,
      wallets: [],
      choosing: false,
      balance: null,
      startPractice: async () => false,
      connect: noop,
      choose: noop,
      cancelChoose: noop,
      switchNetwork: noop,
      logOut: noop,
    },
    role: null,
    setRole: noop,
    show: noop,
  };
}

function Running({ config, children }: { config: Config; children: React.ReactNode }) {
  const chain = useMemo(() => chainOf(config), [config]);
  const client = useMemo(() => clientFor(config), [config]);

  // This site's names for campaigns. Missing or unreadable means campaigns go by number.
  const [labels, setLabels] = useState<Label[]>([]);
  useEffect(() => {
    fetch("/labels.json", { cache: "no-store", credentials: "omit" })
      .then((r) => (r.status === 200 ? r.json() : []))
      .then((j) => setLabels(readLabels(j)))
      .catch(() => {});
  }, []);

  // The chosen role, kept in this browser so the demo can switch views.
  const [role, setRoleState] = useState<Role | null>(null);
  useEffect(() => {
    const r = browserStorage()?.getItem("boomerang:role");
    if (r === "backer" || r === "sponsor") setRoleState(r);
  }, []);
  const setRole = useCallback((r: Role | null) => {
    setRoleState(r);
    const s = browserStorage();
    if (!s) return;
    if (r) s.setItem("boomerang:role", r);
    else s.removeItem("boomerang:role");
  }, []);

  // The wallet.
  const [wallets, setWallets] = useState<FoundWallet[]>([]);
  const [looked, setLooked] = useState(false);
  const [wallet, setWallet] = useState<FoundWallet | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [walletChainId, setWalletChainId] = useState<number | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);

  const use = useCallback(async (w: FoundWallet, ask: boolean) => {
    setWalletError(null);
    try {
      const a = ask ? await askWallet(w.provider) : await connected(w.provider);
      if (a === null) return false;
      const id = chainNumber(await w.provider.request({ method: "eth_chainId" }));
      setWallet(w);
      setAccount(a);
      setWalletChainId(id);
      return true;
    } catch (e) {
      if (ask && !declined(e)) setWalletError(explain(e));
      return false;
    }
  }, []);

  // The practice wallet: a key this page makes and keeps in this browser, for test money only.
  const practiceStore = useMemo(() => browserKeyStore(browserStorage(), config.chain.id), [config]);
  const practiceW = useMemo(
    () =>
      practiceWallet({
        name: PRACTICE.name,
        chain,
        usdc: config.usdc,
        store: practiceStore,
        rpc: (method, params) => client.request({ method, params } as never) as Promise<unknown>,
      }),
    [chain, client, config, practiceStore],
  );
  const practising = wallet?.id === PRACTICE_ID;
  const [practiceBusy, setPracticeBusy] = useState(false);
  const [practiceNote, setPracticeNote] = useState<{ ok: boolean; line: string } | null>(null);
  // Logging out of the demo forgets nothing; it only stops using the wallet in this tab.
  const [loggedOut, setLoggedOut] = useState(false);

  // Find the wallets once. One already sharing an account with this page is used without asking;
  // failing that, a practice wallet kept from an earlier visit.
  useEffect(() => {
    let gone = false;
    void discover(window, (type) => new Event(type)).then(async (found) => {
      if (gone) return;
      setWallets(found);
      setLooked(true);
      if (browserStorage()?.getItem("boomerang:loggedOut") === "1") return;
      for (const w of found) if (await use(w, false)) return;
      if (!gone) await use(practiceW, false);
    });
    return () => {
      gone = true;
    };
  }, [use, practiceW]);

  useEffect(() => {
    const p = wallet?.provider;
    if (!p?.on) return;
    const onAccounts = (list: unknown) => {
      const first = Array.isArray(list) ? list[0] : undefined;
      if (typeof first === "string" && /^0x[0-9a-fA-F]{40}$/.test(first)) setAccount(first as Address);
      else {
        setAccount(null);
        setWallet(null);
        setWalletChainId(null);
      }
    };
    const onChain = (id: unknown) => setWalletChainId(chainNumber(id));
    p.on("accountsChanged", onAccounts);
    p.on("chainChanged", onChain);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
    };
  }, [wallet]);

  const clearLoggedOut = () => {
    setLoggedOut(false);
    browserStorage()?.removeItem("boomerang:loggedOut");
  };

  const connect = useCallback(() => {
    if (practiceBusy) return;
    clearLoggedOut();
    if (wallets.length === 1) void use(wallets[0], true);
    else if (wallets.length > 1) setChoosing(true);
  }, [wallets, use, practiceBusy]);

  const switchNetwork = useCallback(async () => {
    if (!wallet) return;
    setWalletError(null);
    try {
      await ensureChain(wallet.provider, chain);
      setWalletChainId(chainNumber(await wallet.provider.request({ method: "eth_chainId" })));
    } catch (e) {
      if (!declined(e)) setWalletError(explain(e));
    }
  }, [wallet, chain]);

  const logOut = useCallback(() => {
    setAccount(null);
    setWallet(null);
    setWalletChainId(null);
    setLoggedOut(true);
    setPracticeNote(null);
    browserStorage()?.setItem("boomerang:loggedOut", "1");
  }, []);

  // The chain, read every few seconds.
  const [world, setWorld] = useState<World | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const accountRef = useRef<Address | null>(null);
  accountRef.current = account;
  const shownRef = useRef<bigint | null>(null);
  const [shownId, setShownId] = useState<bigint | null>(null);
  const show = useCallback((id: bigint | null) => {
    shownRef.current = id;
    setShownId(id);
  }, []);
  const poll = useRef<Poll | null>(null);
  useEffect(() => {
    if (!MOCK) return;
    const tick = () => setWorld(mockWorld(BigInt(Math.floor(Date.now() / 1000))));
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    if (MOCK) return;
    const p = startPoll({
      every: EVERY_MS,
      host: pollHost,
      read: async (live) => {
        try {
          const w = await readWorld({
            client,
            where: { boomerang: config.boomerang, usdc: config.usdc },
            account: accountRef.current,
            keeper: () => askKeeper({ url: config.keeperUrl, fetch: netFetch }),
            also: shownRef.current,
            backersOf: shownRef.current,
          });
          if (!live()) return;
          setWorld(w);
          setReadFailed(false);
        } catch {
          if (live()) setReadFailed(true);
        }
      },
    });
    poll.current = p;
    return () => {
      p.stop();
      poll.current = null;
    };
  }, [client, config]);
  const refresh = useCallback(() => poll.current?.now(), []);
  useEffect(() => {
    refresh();
  }, [account, shownId, refresh]);
  const shownMissing = shownId !== null && world !== null && campaignIn(world, shownId) === undefined;
  useEffect(() => {
    if (shownMissing) refresh();
  }, [shownMissing, refresh]);

  // The desk's USDC, and the addresses it will not send to again.
  const given = useMemo(() => givenStore(browserStorage(), config.chain.id), [config]);
  const [, setGivenSeen] = useState(0);
  const askDesk = useCallback(
    async (address: Address) => {
      const answer = await askForUsdc({ url: config.keeperUrl, fetch: netFetch, address });
      if (answer.had) {
        given.add(address);
        setGivenSeen((n) => n + 1);
      }
      return answer;
    },
    [config, given],
  );

  const startPractice = useCallback(async (): Promise<boolean> => {
    clearLoggedOut();
    const fresh = practiceStore.get() === null;
    setPracticeNote(null);
    setPracticeBusy(true);
    try {
      if (!(await use(practiceW, true))) return false;
      if (!fresh) return true;
      const address = await connected(practiceW.provider);
      if (address === null) return true;
      const desk = await askDesk(address);
      setPracticeNote(practiceResult({ asked: true, desk }));
      refresh();
      return true;
    } finally {
      setPracticeBusy(false);
    }
  }, [practiceStore, practiceW, use, askDesk, refresh]);

  const [expecting, setExpecting] = useState<readonly { id: bigint; until: number }[]>([]);
  const expect = useCallback((id: bigint) => setExpecting((all) => [...all.filter((e) => e.id !== id), { id, until: Date.now() + 90_000 }]), []);

  // What is being sent, one send at a time.
  const [sends, setSends] = useState<Record<string, SendState>>({});
  const gate = useRef(oneAtATime()).current;
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const send = useCallback(
    async (key: string, calls: readonly Call[]): Promise<boolean> => {
      if (!wallet || !account || calls.length === 0) return false;
      const went = await gate(async () => {
        setBusyKey(key);
        const put = (change: (s: SendState) => SendState) =>
          setSends((all) => ({ ...all, [key]: change(all[key] ?? { key, lines: [], error: null, busy: true, done: false }) }));
        setSends((all) => ({ ...all, [key]: { key, lines: [], error: null, busy: true, done: false } }));
        let ok = false;
        try {
          await ensureChain(wallet.provider, chain);
          setWalletChainId(chainNumber(await wallet.provider.request({ method: "eth_chainId" })));
          const walletClient = createWalletClient({ account, chain, transport: custom(wallet.provider) });
          await sendEach({
            publicClient: client,
            walletClient,
            account,
            calls,
            onStep: (step) =>
              put((s) => {
                const lines = [...s.lines];
                lines[step.index] = stepLine(step, calls.length, practising);
                return { ...s, lines };
              }),
          });
          put((s) => ({ ...s, busy: false, done: true }));
          ok = true;
        } catch (e) {
          put((s) => ({ ...s, busy: false, error: explain(e) }));
        }
        setBusyKey(null);
        refresh();
        return ok;
      });
      return went ?? false;
    },
    [wallet, account, chain, client, refresh, gate, practising],
  );

  // One-signature pledge: the wallet signs, the keeper sends.
  const worldNow = world?.now ?? null;
  const worldBlock = world?.block ?? null;
  const outstanding = useMemo(() => outstandingStore(browserStorage()), []);
  const relayPledge = useCallback(
    async (key: string, o: { id: bigint; amount: bigint; closesAt: bigint }): Promise<RelayOutcome> => {
      const helper = config.signedPledge;
      if (!wallet || !account || helper === null || worldNow === null) return { kind: "stopped" };
      const went = await gate(async (): Promise<RelayOutcome> => {
        setBusyKey(key);
        const set = (s: Partial<SendState>) => setSends((all) => ({ ...all, [key]: { key, lines: [], error: null, busy: true, done: false, ...s } }));
        set({ lines: [practising ? PRACTICE.signing : WORDS.pledge.signing] });
        try {
          await ensureChain(wallet.provider, chain);
          setWalletChainId(chainNumber(await wallet.provider.request({ method: "eth_chainId" })));
          const salt = newSalt();
          const a = authorization({ chainId: config.chain.id, usdc: config.usdc, helper, backer: account, id: o.id, amount: o.amount, now: worldNow, closesAt: o.closesAt, salt });
          const used = async () =>
            (await client.readContract({ address: config.usdc, abi: authorizationStateAbi, functionName: "authorizationState", args: [account, a.nonce] })) as boolean;
          const forget = () => outstanding.drop(config.chain.id, account, a.nonce);
          const back = (line: string): RelayOutcome => {
            setSends((all) => Object.fromEntries(Object.entries(all).filter(([k]) => k !== key)));
            return { kind: "fallback", line };
          };
          let signature: `0x${string}`;
          try {
            const walletClient = createWalletClient({ account, chain, transport: custom(wallet.provider) });
            signature = await walletClient.signTypedData({ account, ...a.typed });
          } catch (e) {
            if (declined(e)) {
              set({ busy: false, error: explain(e) });
              return { kind: "stopped" };
            }
            return back(fallbackLine(WORDS.pledge.cannotSign));
          }
          set({ lines: [WORDS.pledge.relaying] });
          outstanding.add(config.chain.id, account, { id: o.id, nonce: a.nonce, until: a.validBefore });
          const answer = await askRelay({
            url: config.keeperUrl,
            fetch: netFetch,
            body: relayBody({ id: o.id, backer: account, amount: o.amount, validAfter: a.validAfter, validBefore: a.validBefore, salt, signature }),
          });
          if (answer.ok) {
            set({ lines: [WORDS.pledge.relaying, WORDS.pledge.waiting] });
            let status: string;
            try {
              status = (await client.waitForTransactionReceipt({ hash: answer.hash, timeout: 60_000 })).status;
            } catch {
              set({ busy: false, error: WORDS.pledge.unconfirmed });
              return { kind: "stopped" };
            }
            if (status === "success") {
              forget();
              set({ lines: [WORDS.pledge.relaying, WORDS.pledge.waiting], busy: false, done: true });
              return { kind: "done" };
            }
            return back(relayLine("failed"));
          }
          if (await used().catch(() => false)) {
            forget();
            set({ lines: [WORDS.pledge.landed], busy: false, done: true });
            return { kind: "done" };
          }
          if (relayRefusedBeforeSending(answer.reason)) forget();
          return back(relayLine(answer.reason));
        } catch (e) {
          set({ busy: false, error: explain(e) });
          return { kind: "stopped" };
        } finally {
          setBusyKey(null);
          refresh();
        }
      });
      return went ?? { kind: "stopped" };
    },
    [wallet, account, chain, client, config, worldNow, refresh, gate, outstanding, practising],
  );

  const signedGuard = useCallback(
    async (id: bigint): Promise<SignedGuard> => {
      if (account === null || worldNow === null || worldBlock === null) return { kind: "clear" };
      const { left, expired } = signedWait(outstanding.list(config.chain.id, account), id, worldNow);
      let landed = false;
      for (const o of expired) {
        let used: boolean;
        try {
          used = (await client.readContract({
            address: config.usdc,
            abi: authorizationStateAbi,
            functionName: "authorizationState",
            args: [account, o.nonce],
            blockNumber: worldBlock,
          })) as boolean;
        } catch {
          return { kind: "unknown" };
        }
        outstanding.drop(config.chain.id, account, o.nonce);
        if (used) landed = true;
      }
      if (left !== null) return { kind: "wait", left };
      return landed ? { kind: "landed" } : { kind: "clear" };
    },
    [account, worldNow, worldBlock, client, config, outstanding],
  );

  const quote = useCallback(
    async (id: bigint, amount: bigint) => {
      const [wouldFund, counted, bonus] = (await client.readContract({
        address: config.boomerang,
        abi: boomerangAbi as unknown as Abi,
        functionName: "quoteIfMissed",
        args: [id, amount],
      })) as [boolean, bigint, bigint];
      return { wouldFund, counted, bonus };
    },
    [client, config],
  );

  const deskUp = world !== null && world.keeper.up && world.keeper.health.desk !== null;
  const practiceOffered = looked && account === null && (deskUp || practiceStore.get() !== null);

  const ctx: Ctx | null =
    world === null
      ? null
      : {
          config,
          world,
          labels,
          desk: world.keeper.up ? world.keeper.health.desk : null,
          relay: world.keeper.up ? world.keeper.health.relay : null,
          account,
          onRightChain: account !== null && walletChainId === config.chain.id,
          maySend: !readFailed && busyKey === null,
          send,
          relayPledge,
          signedGuard,
          sendState: (key) => sends[key] ?? null,
          connect,
          hasWallet: wallets.length > 0 || !looked,
          practice: practiceOffered ? () => void startPractice() : null,
          practiceBusy,
          practising,
          expected: (id) => expecting.some((e) => e.id === id && Date.now() < e.until),
          expect,
          quote,
          askForUsdc: () => (account === null ? Promise.resolve({ ok: false as const, line: WORDS.connect }) : askDesk(account)),
          hadUsdc: account !== null && given.has(account),
          askForCampaign: (kind) => askForCampaign({ url: config.keeperUrl, fetch: netFetch, kind }),
          refresh,
        };

  const balance = world !== null && account !== null && world.account === account ? world.balance : null;

  const engine: Engine = {
    config,
    problem: null,
    labels,
    world,
    readFailed,
    ctx,
    wallet: {
      account: loggedOut ? null : account,
      practising,
      practiceBusy,
      practiceNote,
      walletError,
      wrongNetwork: account !== null && walletChainId !== null && walletChainId !== config.chain.id,
      hasWallet: wallets.length > 0,
      wallets,
      choosing,
      balance,
      startPractice,
      connect,
      choose: (w) => {
        setChoosing(false);
        clearLoggedOut();
        void use(w, true);
      },
      cancelChoose: () => setChoosing(false),
      switchNetwork: () => void switchNetwork(),
      logOut,
    },
    role,
    setRole,
    show,
  };

  return <EngineContext.Provider value={engine}>{children}</EngineContext.Provider>;
}
