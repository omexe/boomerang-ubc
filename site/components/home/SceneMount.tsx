"use client";

import dynamic from "next/dynamic";

const IslandScene = dynamic(() => import("./IslandScene"), {
  ssr: false,
  loading: () => null,
});

export default function SceneMount() {
  return (
    <div className="fixed inset-0 z-0" aria-hidden>
      <IslandScene />
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
