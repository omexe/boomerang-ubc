"use client";

import { useEffect } from "react";

// Two things for the home page's text, and only its text (the island is left alone):
// 1. Each section's text fades out as it scrolls up toward the header, so it never slides under it.
// 2. Scrolling comes to rest with a section's text in the middle of the screen.
const HEADER = 84; // the header's height: text is fully gone by here
const FADE = 70; // over this many pixels below it

export default function HeaderFade() {
  useEffect(() => {
    const root = document.documentElement;
    root.style.scrollSnapType = "y mandatory";
    const blocks = Array.from(document.querySelectorAll<HTMLElement>("[data-fade]"));
    let raf = 0;
    const update = () => {
      raf = 0;
      for (const el of blocks) {
        const cut = HEADER - el.getBoundingClientRect().top; // how far the header reaches into the block
        if (cut + FADE <= 0) {
          if (el.style.maskImage) {
            el.style.maskImage = "";
            el.style.webkitMaskImage = "";
          }
          continue;
        }
        const mask = `linear-gradient(to bottom, transparent ${cut}px, black ${cut + FADE}px)`;
        el.style.maskImage = mask;
        el.style.webkitMaskImage = mask;
      }
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      root.style.scrollSnapType = "";
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return null;
}
