import Link from "next/link";

export default function Login() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="font-serif text-[48px] leading-tight text-paper">Login and dashboards come next.</h1>
      <Link href="/" className="rounded-[5px] border border-paper px-5 py-3 text-[15px] text-paper hover:text-glow">
        ← Back home
      </Link>
    </main>
  );
}
