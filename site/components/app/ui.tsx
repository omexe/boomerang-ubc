"use client";

// Small shared pieces for the working pages. `tone` picks the dark site style or the garden
// palette used on campaign pages.
import type { Row } from "../../../web/src/views/campaign.ts";
import { explorerLink } from "../../../web/src/views/links.ts";

export type Tone = "dark" | "garden";

export function SendStatus({ state, tone }: { state: { lines: string[]; error: string | null; busy: boolean } | null; tone: Tone }) {
  if (!state) return null;
  return (
    <div className="mt-3 space-y-1 text-[14px] leading-[1.5]" role="status" aria-live="polite">
      {state.lines.map((line, i) => (
        <p key={i} className={tone === "dark" ? "text-paper" : "text-g-ink"}>
          {line}
        </p>
      ))}
      {state.error ? <p className={tone === "dark" ? "text-missed" : "text-g-red"}>{state.error}</p> : null}
    </div>
  );
}

export function Rows({ rows, explorer, tone }: { rows: readonly Row[]; explorer: string | null; tone: Tone }) {
  const line = tone === "dark" ? "border-line divide-line" : "border-g-line divide-g-line";
  const label = tone === "dark" ? "text-mist" : "text-g-ink2";
  const value = tone === "dark" ? "text-paper" : "text-g-ink";
  return (
    <dl className={`divide-y ${line} border-y ${line}`}>
      {rows.map((r) => {
        const link = explorerLink(explorer, "address", r.address);
        const long = r.value.length > 60;
        return (
          <div key={r.label} className={long ? "py-3" : "flex items-baseline justify-between gap-6 py-3"}>
            <dt className={`text-[14px] ${label}`}>{r.label}</dt>
            <dd className={`text-[14px] ${value} ${long ? "mt-1" : "text-right"}`}>
              {link ? (
                <a href={link} target="_blank" rel="noreferrer noopener" className="underline decoration-1 underline-offset-2">
                  {r.value}
                </a>
              ) : (
                r.value
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

export function Btn({
  children,
  onClick,
  disabled,
  tone,
  kind = "solid",
  type = "button",
  className = "",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone: Tone;
  kind?: "solid" | "line";
  type?: "button" | "submit";
  className?: string;
}) {
  const base = "inline-flex h-11 items-center justify-center gap-2 rounded-[5px] px-5 text-[15px] font-medium transition-colors disabled:cursor-not-allowed";
  const styles =
    tone === "dark"
      ? kind === "solid"
        ? "bg-paper text-ink hover:bg-glow disabled:bg-smoke disabled:text-mist"
        : "border border-paper text-paper hover:border-glow hover:text-glow disabled:border-line disabled:text-mist"
      : kind === "solid"
        ? "bg-g-green text-g-sheet hover:bg-g-ink disabled:bg-g-line disabled:text-g-ink2"
        : "border border-g-ink text-g-ink hover:bg-g-sheet disabled:border-g-line disabled:text-g-ink2";
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${styles} ${className}`}>
      {children}
    </button>
  );
}
