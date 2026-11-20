"use client";

import Link from "next/link";
import { AppHeader } from "@/components/app/AppHeader";
import { Breadcrumbs } from "@/components/app/Breadcrumbs";

export default function SponsorPage() {
  return (
    <div className="min-h-screen bg-charcoal">
      <AppHeader tone="dark" />
      <main className="mx-auto max-w-[1040px] px-6 pb-24 pt-8">
        <Breadcrumbs items={[{ label: "Sponsor" }]} tone="dark" />
        <h1 className="mt-10 font-serif text-[48px] leading-tight text-paper">Sponsor tools come next.</h1>
        <Link href="/explore" className="mt-8 inline-flex h-12 items-center gap-3 rounded-[5px] bg-paper px-6 text-[15px] font-medium text-ink hover:bg-glow">
          Explore campaigns <span aria-hidden>→</span>
        </Link>
      </main>
    </div>
  );
}
