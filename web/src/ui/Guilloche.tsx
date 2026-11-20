// The guilloche SVGs: fine waves behind the cheque, the rosette behind the flight. Both read
// their geometry from the pure generator, so the shapes are identical to the mockup's. The
// rosette exposes its group so the flight scene can trace it in and turn it.
import type { Ref } from "react";

import { rosettePaths, wavePaths } from "../views/guilloche.ts";

/** The cheque's background: eighteen stretched sine lines. Stands alone wherever it is placed. */
export function Waves() {
  return (
    <svg className="waves" viewBox="0 0 600 300" preserveAspectRatio="none" aria-hidden="true">
      {wavePaths().map((p, i) => (
        <path key={i} d={p.d} fill="none" stroke={p.stroke} strokeWidth={p.width} opacity={p.opacity} vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

/** The flight scene's rosette. The optional groupRef hands the turning group to the caller. */
export function Rosette({ groupRef }: { groupRef?: Ref<SVGGElement> }) {
  return (
    <svg className="rose" viewBox="-100 -100 200 200" aria-hidden="true">
      <g ref={groupRef}>
        {rosettePaths().map((p, i) => (
          <path key={i} d={p.d} fill="none" stroke={p.stroke} strokeWidth={p.width} opacity={p.opacity} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
    </svg>
  );
}
