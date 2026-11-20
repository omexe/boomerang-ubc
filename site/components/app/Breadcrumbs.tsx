import Link from "next/link";
import type { Tone } from "./ui";

export type Crumb = { label: string; href?: string };

/** Where you are: Home / Explore / Builder House, Denver. */
export function Breadcrumbs({ items, tone }: { items: Crumb[]; tone: Tone }) {
  const dark = tone === "dark";
  const link = dark ? "text-mist hover:text-paper" : "text-g-ink2 hover:text-g-ink";
  const here = dark ? "text-paper" : "text-g-ink";
  const sep = dark ? "text-line" : "text-g-line";
  const all: Crumb[] = [{ label: "Home", href: "/" }, ...items];
  return (
    <nav aria-label="Breadcrumb" className="text-[14px]">
      <ol className="flex flex-wrap items-center gap-2">
        {all.map((c, i) => {
          const last = i === all.length - 1;
          return (
            <li key={`${c.label}-${i}`} className="flex items-center gap-2">
              {last || !c.href ? (
                <span className={here} aria-current={last ? "page" : undefined}>
                  {c.label}
                </span>
              ) : (
                <Link href={c.href} className={link}>
                  {c.label}
                </Link>
              )}
              {!last ? <span className={sep}>/</span> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
