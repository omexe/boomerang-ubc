// Keeping the island crisp. island.png is 986×853, and every one of those pixels carries detail.
// Shown larger than about 1.75 screen pixels per island pixel, each island pixel is drawn as a
// whole number of screen pixels (no smoothing), so the art stays sharp and even. Shown smaller,
// it is drawn smoothly, which is cleaner than dropping or doubling stray pixels.
export const SNAP_FROM = 1.75;

/**
 * `scale` is the wanted CSS scale of the island, `dpr` the screen's device-pixel ratio. `fit`
 * rounds down, for a frame the island must fit inside; otherwise it rounds to the nearest.
 */
export function fitPixels(scale: number, dpr: number, mode: "fit" | "nearest" = "fit") {
  const ratio = scale * dpr;
  const pixelated = ratio >= SNAP_FROM;
  const k = pixelated ? (mode === "fit" ? Math.floor(ratio) : Math.round(ratio)) : ratio;
  return {
    scale: pixelated ? k / dpr : scale,
    pixelated,
    /** A CSS length, moved onto the screen's pixel grid. */
    snap: (v: number) => Math.round(v * dpr) / dpr,
  };
}
