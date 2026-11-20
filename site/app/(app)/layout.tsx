import { BoomerangProvider } from "@/lib/boomerang/engine";

// The working pages (login, explore, campaigns) share one engine: one wallet, one read of the chain.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <BoomerangProvider>{children}</BoomerangProvider>;
}
