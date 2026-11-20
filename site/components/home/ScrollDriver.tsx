"use client";

import { useEffect } from "react";
import { story } from "@/lib/story";

/** Maps window scroll onto a continuous section index (0..8) for the scene. */
export default function ScrollDriver() {
  useEffect(() => {
    const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-story]"));
    let raf = 0;
    const update = () => {
      raf = 0;
      const mid = window.innerHeight * 0.5;
      const centers = sections.map((el) => {
        const r = el.getBoundingClientRect();
        return r.top + r.height / 2;
      });
      let p = 0;
      if (mid <= centers[0]) p = 0;
      else if (mid >= centers[centers.length - 1]) p = centers.length - 1;
      else {
        for (let i = 0; i < centers.length - 1; i++) {
          if (mid >= centers[i] && mid < centers[i + 1]) {
            p = i + (mid - centers[i]) / (centers[i + 1] - centers[i]);
            break;
          }
        }
      }
      // hold each state for a moment around its section center
      const i = Math.floor(p);
      const f = p - i;
      const held = f < 0.2 ? 0 : f > 0.8 ? 1 : (f - 0.2) / 0.6;
      story.target = i + held;
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    story.p = story.target;
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return null;
}
