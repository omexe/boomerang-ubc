"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { short } from "../../../../web/src/data/keeper.ts";
import { AppHeader } from "@/components/app/AppHeader";
import { useEngine, type Role } from "@/lib/boomerang/engine";

export default function LoginPage() {
  const { wallet, setRole } = useEngine();
  const router = useRouter();
  const [busy, setBusy] = useState<Role | null>(null);
  // after "use my own wallet", go on once the wallet has connected
  const [pending, setPending] = useState<Role | null>(null);

  const go = (role: Role) => router.push(role === "backer" ? "/explore" : "/sponsor");
  const practice = async (role: Role) => {
    setBusy(role);
    setRole(role);
    const ok = wallet.account ? true : await wallet.startPractice();
    setBusy(null);
    if (ok) go(role);
  };
  const own = (role: Role) => {
    setRole(role);
    setPending(role);
    wallet.connect();
  };
  useEffect(() => {
    if (pending && wallet.account) {
      setPending(null);
      router.push(pending === "backer" ? "/explore" : "/sponsor");
    }
  }, [pending, wallet.account, router]);

  return (
    <div className="min-h-screen bg-charcoal">
      <AppHeader tone="dark" />
      <main className="mx-auto max-w-[1040px] px-6 pb-24 pt-16">
        <h1 className="font-serif text-[52px] leading-[1.05] text-paper">Log in to Boomerang</h1>
        <p className="mt-4 max-w-[560px] text-[17px] leading-[1.6] text-paper">
          Pick how you&apos;ll use it. The practice wallet needs no install and comes with test USDC, and you can switch roles any time.
        </p>
        {wallet.account ? (
          <p className="mt-6 text-[15px] text-mist">
            Signed in with {wallet.practising ? "a practice wallet" : "your wallet"} <span className="font-mono text-paper">{short(wallet.account)}</span>.
          </p>
        ) : null}

        <div className="mt-12 grid gap-5 md:grid-cols-2">
          <RoleCard
            title="I want to back campaigns"
            body="Find a campaign your community cares about, pledge early, and earn a bonus if it falls short."
            primary={wallet.account ? "Continue as a backer" : "Start with a practice wallet"}
            onPrimary={() => void practice("backer")}
            busy={busy === "backer" || wallet.practiceBusy}
            onOwn={wallet.account || !wallet.hasWallet ? null : () => own("backer")}
          />
          <RoleCard
            title="I run a DAO treasury"
            body="Put up a match and a bonus, set a goal, and give your community a reason to move first."
            primary={wallet.account ? "Continue as a sponsor" : "Start with a practice wallet"}
            onPrimary={() => void practice("sponsor")}
            busy={busy === "sponsor"}
            onOwn={wallet.account || !wallet.hasWallet ? null : () => own("sponsor")}
          />
        </div>
        <p className="mt-8 text-[14px] text-mist">Everything runs on Arc Testnet with test USDC. No real money moves.</p>
      </main>
    </div>
  );
}

function RoleCard({ title, body, primary, onPrimary, busy, onOwn }: { title: string; body: string; primary: string; onPrimary: () => void; busy: boolean; onOwn: (() => void) | null }) {
  return (
    <section className="flex flex-col rounded-[6px] border border-line bg-smoke/60 p-7">
      <h2 className="font-serif text-[30px] leading-tight text-paper">{title}</h2>
      <p className="mt-3 flex-1 text-[15px] leading-[1.6] text-paper">{body}</p>
      <div className="mt-8 flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={onPrimary}
          disabled={busy}
          className="inline-flex h-12 items-center gap-3 rounded-[5px] bg-paper px-6 text-[15px] font-medium text-ink transition-colors hover:bg-glow disabled:bg-line disabled:text-mist"
        >
          {busy ? "Setting up…" : primary} <span aria-hidden>→</span>
        </button>
        {onOwn ? (
          <button type="button" onClick={onOwn} className="text-[14px] text-paper underline decoration-1 underline-offset-4 hover:text-glow">
            Use my own wallet
          </button>
        ) : null}
      </div>
    </section>
  );
}
