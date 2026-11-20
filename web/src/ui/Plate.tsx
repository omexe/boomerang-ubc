// One plate of the board: a caption, a figure and its unit. When `flips` is set and the figure
// changes after the plate is on screen (a real pledge or settlement read from the chain), each
// changed character swaps like a hand-changed plate: the old one slides up and out, the new one
// comes up from below, right to left, 40 ms apart. Unchanged characters do not move; nothing
// moves on first render. With reduced motion the swap is a 120 ms crossfade.
import { useLayoutEffect, useRef, useState } from "react";

import type { Plate as PlateView } from "../views/board.ts";
import { changedPositions } from "../views/flip.ts";

const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

export function Figure({ text, flips, className = "figure" }: { text: string; flips: boolean; className?: string }) {
  const [shown, setShown] = useState(text);
  const [ghost, setGhost] = useState<{ before: string; changed: number[]; n: number } | null>(null);
  const cells = useRef<(HTMLSpanElement | null)[]>([]);

  // A change of text after mount starts one flip; the old text is kept only for the ghosts.
  if (shown !== text) {
    setShown(text);
    if (flips) setGhost((g) => ({ before: shown, changed: changedPositions(shown, text), n: (g?.n ?? 0) + 1 }));
  }

  useLayoutEffect(() => {
    if (ghost === null) return;
    const order = [...ghost.changed].sort((a, b) => a - b); // right to left
    const slow = !reduced();
    const animations: Animation[] = [];
    order.forEach((fromRight, i) => {
      const cell = cells.current[text.length - 1 - fromRight];
      if (!cell) return;
      const now = cell.querySelector<HTMLElement>(".ch");
      const old = cell.querySelector<HTMLElement>(".ghost");
      const timing: KeyframeAnimationOptions = slow ? { duration: 280, easing: EASE, delay: i * 40, fill: "both" } : { duration: 120, easing: "linear", fill: "both" };
      if (now) animations.push(now.animate(slow ? [{ transform: "translateY(100%)" }, { transform: "translateY(0)" }] : [{ opacity: 0 }, { opacity: 1 }], timing));
      if (old) animations.push(old.animate(slow ? [{ transform: "translateY(0)" }, { transform: "translateY(-100%)" }] : [{ opacity: 1 }, { opacity: 0 }], timing));
    });
    let live = true;
    void Promise.all(animations.map((a) => a.finished.catch(() => undefined))).then(() => {
      if (!live) return;
      for (const a of animations) a.cancel();
      setGhost((g) => (g?.n === ghost.n ? null : g));
    });
    return () => {
      live = false;
      for (const a of animations) a.cancel();
    };
  }, [ghost, text]);

  const chars = [...text];
  const before = ghost?.before ?? "";
  return (
    <span className={className} aria-hidden="true">
      {chars.map((c, i) => {
        const fromRight = chars.length - 1 - i;
        const changed = ghost !== null && ghost.changed.includes(fromRight);
        const old = changed ? before[before.length - 1 - fromRight] : undefined;
        return (
          <span
            className="cell"
            key={fromRight}
            ref={(el) => {
              cells.current[i] = el;
            }}
          >
            <span className="ch">{c}</span>
            {old !== undefined ? <span className="ghost">{old}</span> : null}
          </span>
        );
      })}
    </span>
  );
}

export function Plate({ plate }: { plate: PlateView }) {
  // Only figures that change when money moves flip; the clocks just read the newest block.
  const flips = plate.key === "togo" || plate.key === "backers";
  const label = `${plate.caption.toLowerCase()}: ${plate.figure}${plate.unit ? ` ${plate.unit}` : ""}`;
  return (
    <div className={`plate plate-${plate.key}${plate.live ? " live" : ""}`} role="group" aria-label={label}>
      <span className="caption" aria-hidden="true">
        {plate.caption}
      </span>
      <span className="reading" aria-hidden="true">
        <Figure text={plate.figure} flips={flips} />
        {plate.unit ? <span className="unit">{plate.unit}</span> : null}
      </span>
    </div>
  );
}
