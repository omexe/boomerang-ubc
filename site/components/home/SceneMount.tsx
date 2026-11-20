"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

// v2 (pixel island) is the default. Add ?scene=v1 to the URL to see the
// original smooth island, kept for comparison and easy rollback.
const PixelScene = dynamic(() => import("./IslandScenePixel"), { ssr: false, loading: () => null });
const SmoothScene = dynamic(() => import("./IslandSceneV1"), { ssr: false, loading: () => null });

export default function SceneMount() {
  const [v1, setV1] = useState(false);
  useEffect(() => {
    setV1(new URLSearchParams(window.location.search).get("scene") === "v1");
  }, []);
  return (
    <div className="fixed inset-0 z-0" aria-hidden>
      {v1 ? <SmoothScene /> : <PixelScene />}
      {/* fade the scene into the page */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 48% 62% at 70% 44%, rgba(29,29,29,0) 45%, rgba(29,29,29,0.9) 100%), linear-gradient(90deg, #1d1d1d 0%, rgba(29,29,29,0.75) 30%, rgba(29,29,29,0) 52%)",
        }}
      />
    </div>
  );
}
