import { describe, expect, it } from "vitest";

import { affineInverse, affineMul, cssLinear2x2, IDENTITY_AFFINE, nodeMatrix, type Affine } from "@/mirror/affine";

function expectAffineClose(a: Affine, b: Affine): void {
  for (let i = 0; i < 6; i += 1) {
    expect(a[i]).toBeCloseTo(b[i], 6);
  }
}

describe("affine helpers", () => {
  it("nodeMatrix composes the global transform with the local-box origin", () => {
    // translate(100,50) · scale(2) box at (10, 20) → origin maps to (100 + 2*10, 50 + 2*20).
    const m = nodeMatrix([2, 0, 0, 2, 100, 50], { x: 10, y: 20 });
    expectAffineClose(m, [2, 0, 0, 2, 120, 90]);
  });

  it("affineInverse · M = identity", () => {
    const m: Affine = [2, 0, 0, 3, 120, 90];
    const inv = affineInverse(m);
    expect(inv).not.toBeNull();
    expectAffineClose(affineMul(inv!, m), IDENTITY_AFFINE);
  });

  it("re-expresses a child relative to its clip parent (clipInv · childGlobal)", () => {
    const clipper = nodeMatrix([1, 0, 0, 1, 200, 100], { x: 0, y: 0 }); // clipper box origin at (200,100)
    const child = nodeMatrix([1, 0, 0, 1, 205, 96], { x: 0, y: 0 }); // child 5px right, 4px above
    const rel = affineMul(affineInverse(clipper)!, child);
    expectAffineClose(rel, [1, 0, 0, 1, 5, -4]);
  });

  it("returns null for a singular matrix", () => {
    expect(affineInverse([0, 0, 0, 0, 1, 1])).toBeNull();
  });
});

// R10-B1 — the deraster scale gate reads the LINEAR (2×2) part out of the transform strings the mirror itself
// wrote, to tell a translation-only tween (no re-raster needed) from one that changes the rasterization scale.
// Anything it cannot model must come back null, which the caller treats as "assume it changed".
describe("cssLinear2x2", () => {
  it("reads the 2x2 out of the shapes nodeStyle emits", () => {
    expect(cssLinear2x2("matrix(1, 0, 0, 1, 300, 140)")).toEqual([1, 0, 0, 1]);
    expect(cssLinear2x2("matrix(2, 0, 0, 3, 10, 20)")).toEqual([2, 0, 0, 3]);
    // The atlas leaf's `matrix(...) scale(...)` fit composes into the linear part.
    expect(cssLinear2x2("matrix(1, 0, 0, 1, 10, 20) scale(0.5)")).toEqual([0.5, 0, 0, 0.5]);
    expect(cssLinear2x2("matrix(2, 0, 0, 2, 0, 0) scale(-1, 1)")).toEqual([-2, 0, 0, 2]);
    // Pure translation never touches it.
    expect(cssLinear2x2("translate(4px, 8px)")).toEqual([1, 0, 0, 1]);
    expect(cssLinear2x2("matrix(1, 0, 0, 1, 0, 0) translate(4px, 8px)")).toEqual([1, 0, 0, 1]);
    // An un-transformed element counts as identity (a tween FROM no transform to a translate must still skip).
    expect(cssLinear2x2("")).toEqual([1, 0, 0, 1]);
    expect(cssLinear2x2("none")).toEqual([1, 0, 0, 1]);
  });

  it("returns null for anything it does not model", () => {
    expect(cssLinear2x2(null)).toBeNull();
    expect(cssLinear2x2(undefined)).toBeNull();
    expect(cssLinear2x2("rotate(30deg)")).toBeNull();
    expect(cssLinear2x2("translate(50%, 0)")).toBeNull();
    expect(cssLinear2x2("matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1)")).toBeNull();
    expect(cssLinear2x2("wat")).toBeNull();
  });
});
