// The guilloche generator: the right number of paths, well-formed path data, stable output, and
// a first point that matches the mockup's formula worked by hand.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rosettePaths, wavePaths } from "../src/views/guilloche.ts";

describe("guilloche.counts", () => {
  it("draws four rosette paths and eighteen wave paths", () => {
    assert.equal(rosettePaths().length, 4);
    assert.equal(wavePaths().length, 18);
  });
});

describe("guilloche.shape", () => {
  it("every path begins with a move and holds no NaN", () => {
    for (const p of [...rosettePaths(), ...wavePaths()]) {
      assert.equal(p.d[0], "M");
      assert.ok(!p.d.includes("NaN"), `unexpected NaN in: ${p.d.slice(0, 40)}`);
    }
  });

  it("gives equal output when called twice", () => {
    assert.deepEqual(rosettePaths(), rosettePaths());
    assert.deepEqual(wavePaths(), wavePaths());
  });

  it("starts the first rosette path where the formula puts it", () => {
    // troch(96, 36, 62, 0.78) at t = 0: x = ((R - r) + d) * k, y = 0.
    const R = 96, r = 36, d = 62, k = 0.78;
    const x = ((R - r) * Math.cos(0) + d * Math.cos(0)) * k;
    const y = ((R - r) * Math.sin(0) - d * Math.sin(0)) * k;
    assert.ok(rosettePaths()[0].d.startsWith("M" + x.toFixed(2) + " " + y.toFixed(2)));
  });
});
