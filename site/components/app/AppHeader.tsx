"use client";

// The bar on the working pages: brand, Explore, and the wallet chip (role, account, balance,
// test USDC, switch network, log out). Dark on overview pages, garden-toned on campaign pages.
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";

import { short } from "../../../web/src/data/keeper.ts";
import { formatUsd } from "../../../web/src/data/money.ts";
import { deskOffer } from "../../../web/src/views/shell.ts";
import { useEngine } from "@/lib/boomerang/engine";
import type { Tone } from "./ui";

export function AppHeader({ tone }: { tone: Tone }) {
  const { wallet, ctx, role, problem, readFailed, world } = useEngine();
  const [open, setOpen] = useState(false);
  const [desk, setDesk] = useState<{ busy: boolean; line: string | null; ok: boolean }>({ busy: false, line: null, ok: false });
  const dark = tone === "dark";
  const text = dark ? "text-paper" : "text-g-ink";
  const sub = dark ? "text-mist" : "text-g-ink2";
  const line = dark ? "border-line" : "border-g-line";
  const panel = dark ? "bg-smoke border-line" : "bg-g-sheet border-g-line";

  const offer =
    ctx && wallet.account && wallet.balance !== null && wallet.balance < 2_000_000n ? deskOffer({ desk: ctx.desk, account: wallet.account, had: ctx.hadUsdc }) : null;
  const getUsdc = async () => {
    if (!ctx) return;
    setDesk({ busy: true, line: null, ok: false });
    const a = await ctx.askForUsdc();
    setDesk({ busy: false, line: a.line, ok: a.ok });
    ctx.refresh();
  };

  return (
    <>
      <header className={`sticky top-0 z-30 border-b ${line} ${dark ? "bg-charcoal/90" : "bg-g-bg/90"} backdrop-blur-md`}>
        <div className="mx-auto flex h-16 max-w-[1240px] items-center justify-between px-6">
          <div className="flex items-center gap-10">
            <Link href="/" className="flex items-center gap-3">
              <span className={dark ? "" : "rounded-[5px] bg-g-ink p-1"}>
                <Image src="/logo-mark.png" alt="" width={dark ? 30 : 22} height={dark ? 30 : 22} />
              </span>
              <span className={`font-serif text-[21px] leading-none ${text}`}>Boomerang</span>
            </Link>
            <nav className={`hidden items-center gap-7 text-[14px] md:flex ${text}`}>
              <Link href="/explore" className="hover:underline">
                Explore
              </Link>
              <Link href="/pledges" className="hover:underline">
                My pledges
              </Link>
            </nav>
          </div>

          <div className="relative flex items-center gap-3">
            {wallet.account ? (
              <>
                {wallet.wrongNetwork ? (
                  <button type="button" onClick={wallet.switchNetwork} className={`h-9 rounded-[5px] border px-3 text-[13px] ${dark ? "border-missed text-missed" : "border-g-red text-g-red"}`}>
                    Switch to Arc Testnet
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setOpen((o) => !o)}
                  className={`flex h-9 items-center gap-3 rounded-[5px] border px-3 text-[13px] ${line} ${text}`}
                  aria-expanded={open}
                >
                  <span className={`rounded-[3px] px-1.5 py-0.5 text-[11px] ${dark ? "bg-line text-paper" : "bg-g-line text-g-ink"}`}>{role === "sponsor" ? "Sponsor" : "Backer"}</span>
                  <span className="font-mono">{wallet.practising ? `Practice ${short(wallet.account)}` : short(wallet.account)}</span>
                  <span className={`font-mono ${sub}`}>{wallet.balance === null ? "…" : `${formatUsd(wallet.balance)} USDC`}</span>
                </button>
                {open ? (
                  <div className={`absolute right-0 top-11 w-[300px] rounded-[6px] border p-4 text-[14px] shadow-xl ${panel} ${text}`}>
                    <p className={sub}>{wallet.practising ? "Practice wallet" : "Your wallet"}</p>
                    <p className="mt-2 break-all font-mono text-[12px]">{wallet.account}</p>
                    {offer ? (
                      <div className="mt-4">
                        <button type="button" onClick={getUsdc} disabled={desk.busy} className={`w-full rounded-[5px] border px-3 py-2 text-left ${line}`}>
                          {offer.button}
                        </button>
                      </div>
                    ) : null}
                    {desk.line ? <p className={`mt-2 text-[13px] ${desk.ok ? "" : dark ? "text-missed" : "text-g-red"}`}>{desk.line}</p> : null}
                    <div className={`mt-4 flex flex-col gap-2 border-t pt-3 ${line}`}>
                      {wallet.practising && wallet.hasWallet ? (
                        <button type="button" className="text-left hover:underline" onClick={wallet.connect}>
                          Use my own wallet
                        </button>
                      ) : null}
                      {!wallet.practising ? (
                        <button type="button" className="text-left hover:underline" onClick={() => void wallet.startPractice()}>
                          Use a practice wallet
                        </button>
                      ) : null}
                      <Link href="/pledges" className="hover:underline" onClick={() => setOpen(false)}>
                        My pledges
                      </Link>
                      <Link href="/login" className="hover:underline" onClick={() => setOpen(false)}>
                        Switch role
                      </Link>
                      <button
                        type="button"
                        className="text-left hover:underline"
                        onClick={() => {
                          wallet.logOut();
                          setOpen(false);
                        }}
                      >
                        Log out
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <Link href="/login" className={`flex h-9 items-center rounded-[5px] border px-4 text-[14px] ${line} ${text}`}>
                Log in
              </Link>
            )}
          </div>
        </div>
      </header>

      {/* notices: setup answers, wallet errors, a wallet chooser, a chain that cannot be read */}
      <div className="mx-auto max-w-[1240px] px-6">
        {problem ? <Notice tone={tone} bad>{problem}</Notice> : null}
        {readFailed && world !== null ? <Notice tone={tone} bad>The chain could not be read just now. The figures below are from the last read.</Notice> : null}
        {wallet.practiceBusy ? <Notice tone={tone}>Setting up a practice wallet and asking the desk for 2.00 test USDC…</Notice> : null}
        {wallet.practiceNote ? <Notice tone={tone} bad={!wallet.practiceNote.ok}>{wallet.practiceNote.line}</Notice> : null}
        {wallet.walletError ? <Notice tone={tone} bad>{wallet.walletError}</Notice> : null}
        {wallet.choosing ? (
          <div className={`mt-4 rounded-[6px] border p-4 ${panel} ${text}`}>
            <p className="text-[14px]">Choose a wallet</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {wallet.wallets.map((w) => (
                <button key={w.id} type="button" onClick={() => wallet.choose(w)} className={`flex items-center gap-2 rounded-[5px] border px-3 py-2 text-[14px] ${line}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {w.icon ? <img src={w.icon} alt="" width={18} height={18} /> : null}
                  {w.name}
                </button>
              ))}
              <button type="button" onClick={wallet.cancelChoose} className={`px-3 py-2 text-[14px] ${sub}`}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

function Notice({ children, tone, bad = false }: { children: React.ReactNode; tone: Tone; bad?: boolean }) {
  const dark = tone === "dark";
  const color = bad ? (dark ? "border-missed text-missed" : "border-g-red text-g-red") : dark ? "border-line text-paper" : "border-g-line text-g-ink";
  return (
    <p className={`mt-4 rounded-[6px] border px-4 py-3 text-[14px] ${color}`} role="status">
      {children}
    </p>
  );
}
