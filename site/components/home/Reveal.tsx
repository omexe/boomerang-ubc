"use client";

import { useEffect, useRef } from "react";
import { animate, stagger } from "animejs";

/** Slides each line up from behind a mask. Moves text, never fades it. */
export function LineReveal({
  lines,
  className,
  as: Tag = "h1",
  delay = 150,
}: {
  lines: string[];
  className?: string;
  as?: "h1" | "h2";
  delay?: number;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const targets = ref.current.querySelectorAll<HTMLElement>("[data-line]");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      targets.forEach((t) => (t.style.transform = "none"));
      return;
    }
    const a = animate(targets, {
      translateY: ["110%", "0%"],
      duration: 1300,
      delay: stagger(110, { start: delay }),
      ease: "outExpo",
    });
    return () => {
      a.revert();
    };
  }, [delay]);
  return (
    <Tag ref={ref} className={className}>
      {lines.map((l, i) => (
        <span key={i} className="mask-line">
          <span data-line className="inline-block" style={{ transform: "translateY(110%)" }}>
            {l}
          </span>
        </span>
      ))}
    </Tag>
  );
}

/** Counts a number up when it scrolls into view. */
export function CountUp({
  to,
  prefix = "",
  suffix = "",
  decimals = 0,
}: {
  to: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fmt = (v: number) => `${prefix}${v.toFixed(decimals)}${suffix}`;
    el.textContent = fmt(0);
    const state = { v: 0 };
    let started = false;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting || started) return;
        started = true;
        animate(state, {
          v: to,
          duration: 1800,
          ease: "outExpo",
          onUpdate: () => {
            el.textContent = fmt(state.v);
          },
        });
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [to, prefix, suffix, decimals]);
  return <span ref={ref}>{`${prefix}${to.toFixed(decimals)}${suffix}`}</span>;
}
