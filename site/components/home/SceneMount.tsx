"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

// v3 (the 2D garden image) is the default. Older scenes stay available for
// comparison and rollback: ?scene=v1 (smooth 3D island), ?scene=v2 (3D pixel island).
const GardenScene = dynamic(() => import("./IslandScene2D"), { ssr: false, loading: () => null });
const PixelScene = dynamic(() => import("./IslandScenePixel"), { ssr: false, loading: () => null });
const SmoothScene = dynamic(() => import("./IslandSceneV1"), { ssr: false, loading: () => null });

export default function SceneMount() {
  const [scene, setScene] = useState<string | null>(null);
  useEffect(() => {
    setScene(new URLSearchParams(window.location.search).get("scene") ?? "v3");
  }, []);
  return (
    <div className="fixed inset-0 z-0" aria-hidden>
      {scene === "v1" ? <SmoothScene /> : scene === "v2" ? <PixelScene /> : scene ? <GardenScene /> : null}
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
