import { describe, expect, it } from "vitest";

import { uvWindowAttr, visibleUvWindow } from "@/mirror/visibleWindow";
import type { MirrorNode } from "@/mirror/sceneTree";

// Minimal node with just the fields visibleUvWindow reads.
function node(over: Partial<MirrorNode> = {}): MirrorNode {
  return {
    localRect: { x: 0, y: 0, width: 1920, height: 1080 },
    transform: [1, 0, 0, 1, 0, 0],
    ...over
  } as MirrorNode;
}

describe("visibleUvWindow", () => {
  it("returns null for a node that exactly fills the viewport (no clamp needed)", () => {
    expect(visibleUvWindow(node())).toBeNull();
  });

  it("clamps a node twice the viewport width to its visible left half", () => {
    const w = visibleUvWindow(node({ localRect: { x: 0, y: 0, width: 3840, height: 1080 } }));
    expect(w).not.toBeNull();
    expect(w![0]).toBeCloseTo(0, 5); // u0
    expect(w![1]).toBeCloseTo(0, 5); // v0
    expect(w![2]).toBeCloseTo(0.5, 5); // du — only the left 1920 of 3840 is on-screen
    expect(w![3]).toBeCloseTo(1, 5); // dv
  });

  it("clamps an oversized node shifted left off-screen to its visible right half", () => {
    // 3840-wide (2× viewport) shifted left by 1920 → its left half sits off the left edge; right half visible.
    const w = visibleUvWindow(
      node({ localRect: { x: 0, y: 0, width: 3840, height: 1080 }, transform: [1, 0, 0, 1, -1920, 0] })
    );
    expect(w).not.toBeNull();
    expect(w![0]).toBeCloseTo(0.5, 5);
    expect(w![2]).toBeCloseTo(0.5, 5);
  });

  it("uses the explicit gTransform (global) argument over node.transform (local-space composition)", () => {
    // node.transform is a plain identity (a LOCAL matrix); the GLOBAL passed explicitly is 2× the viewport shifted
    // left by 1920 → only the right half is on-screen. Reading node.transform would wrongly give the left half.
    const w = visibleUvWindow(
      node({ localRect: { x: 0, y: 0, width: 3840, height: 1080 }, transform: [1, 0, 0, 1, 0, 0] }),
      [1, 0, 0, 1, -1920, 0]
    );
    expect(w).not.toBeNull();
    expect(w![0]).toBeCloseTo(0.5, 5); // u0 — clamped per the GLOBAL, not the local identity
    expect(w![2]).toBeCloseTo(0.5, 5);
  });

  it("does NOT clamp a small node that merely pokes past an edge (the card_ripple flicker fix)", () => {
    // A ~card-sized node (200×280) fanned partly below the viewport bottom. Clamping it would resize+clear its
    // shader canvas every frame as it moves → strobe. Box < viewport on both axes ⇒ left full.
    expect(
      visibleUvWindow(node({ localRect: { x: 0, y: 0, width: 200, height: 280 }, transform: [1, 0, 0, 1, 800, 950] }))
    ).toBeNull();
  });

  it("does NOT clamp a huge node scaled down to exactly fit the viewport", () => {
    // 3840×2160 box at scale 0.5 → on-screen 1920×1080 == viewport → fully visible.
    expect(
      visibleUvWindow(node({ localRect: { x: 0, y: 0, width: 3840, height: 2160 }, transform: [0.5, 0, 0, 0.5, 0, 0] }))
    ).toBeNull();
  });

  it("leaves a rotated/skewed node unclamped (AABB clamp would be wrong)", () => {
    expect(visibleUvWindow(node({ transform: [0, 1, -1, 0, 0, 0] }))).toBeNull();
  });

  it("leaves an entirely off-screen node unclamped (a zero-size canvas is pointless)", () => {
    // translate well past the right edge.
    expect(visibleUvWindow(node({ transform: [1, 0, 0, 1, 5000, 0] }))).toBeNull();
  });

  it("returns null for a degenerate / missing box", () => {
    expect(visibleUvWindow(node({ localRect: { x: 0, y: 0, width: 0, height: 1080 } }))).toBeNull();
    expect(visibleUvWindow(node({ localRect: null as unknown as MirrorNode["localRect"] }))).toBeNull();
  });

  it("uvWindowAttr serializes to 4-dp comma-joined fractions", () => {
    expect(uvWindowAttr([0, 0, 0.5, 1])).toBe("0,0,0.5,1");
    expect(uvWindowAttr([0.33333, 0.1, 0.66667, 0.9])).toBe("0.3333,0.1,0.6667,0.9");
  });
});

// The widescreen bg-gap fix (Aug-12): `viewportWidth` widens the clip box to the spread stage (1920·F). The
// UNDERDOCKS numbers below are the on-device evidence from .sts2/artifacts/regression-aug12/bggap-evidence.json,
// reconstructed exactly: stage F = 2520/1920 (MIRROR_MAX_DESIGN_WIDTH cap), bg localRect 2764.8×1296, SHIFTED
// global [0.85,0,0,0.85,36.88,29.19] (data-spread-dx 232 ⇒ unshifted tx −195.12). Every 1-dp CSS rect in the
// capture (canvas x 33.3 / right 523.2, node right 644.7, y 7.6) reproduces from these inputs at stage scale
// 281/1080 with 23.67px side bars.
describe("visibleUvWindow — spread-aware viewport width", () => {
  const WIDE = 2520; // 1920 · 1.3125, the capped phone stage
  const UNDERDOCKS = { localRect: { x: 0, y: 0, width: 2764.8, height: 1296 } };
  const G_SHIFTED: [number, number, number, number, number, number] = [0.85, 0, 0, 0.85, 36.88, 29.19];
  const G_UNSHIFTED: [number, number, number, number, number, number] = [0.85, 0, 0, 0.85, -195.12, 29.19];

  it("explicit viewportWidth=1920 is byte-identical to the default (the F=1 regression guard)", () => {
    const cases: Array<[Partial<MirrorNode>, [number, number, number, number, number, number] | null]> = [
      [{ localRect: { x: 0, y: 0, width: 3840, height: 1080 } }, null],
      [{ localRect: { x: 0, y: 0, width: 3840, height: 1080 } }, [1, 0, 0, 1, -1920, 0]],
      [{ localRect: { x: 0, y: 0, width: 200, height: 280 } }, [1, 0, 0, 1, 800, 950]],
      [{ localRect: { x: 0, y: 0, width: 3840, height: 2160 } }, [0.5, 0, 0, 0.5, 0, 0]],
      [UNDERDOCKS, G_SHIFTED],
      [UNDERDOCKS, G_UNSHIFTED]
    ];
    for (const [over, g] of cases) {
      const n = node(over);
      const gArg = g ?? (n.transform as unknown as [number, number, number, number, number, number]);
      expect(visibleUvWindow(n, gArg, 1920)).toEqual(visibleUvWindow(n, gArg));
    }
  });

  it("reproduces the captured UNDERDOCKS defect against the old 1920 box (the black right-edge gap)", () => {
    // The live capture: data-godot-shader-uv-window = "0,0,0.8013,0.9539" → canvas right edge at design x=1920
    // (523.2 CSS on the phone) while the node ran on to 644.7 — the gap.
    const w = visibleUvWindow(node(UNDERDOCKS), G_SHIFTED, 1920);
    expect(w).not.toBeNull();
    expect(uvWindowAttr(w!)).toBe("0,0,0.8013,0.9539");
  });

  it("windows the UNDERDOCKS bg to the FULL widened stage (the fix: no right-edge gap)", () => {
    // Against [0,2520]: vx1 = (2520−36.88)/0.85 = 2921.3 > 2764.8 ⇒ the whole width is visible (du=1) — the
    // canvas now runs to the node's own right edge. Height still clips (box 1101.6 > 1080 ⇒ dv unchanged).
    const w = visibleUvWindow(node(UNDERDOCKS), G_SHIFTED, WIDE);
    expect(w).not.toBeNull();
    expect(uvWindowAttr(w!)).toBe("0,0,1,0.9539");
  });

  it("documents the old fast-path divergence: the UNSHIFTED global gives a DIFFERENT window", () => {
    // The walk fast path fed the unshifted gNode while the slow path used gNodeStretched (dx=232) — path-
    // dependent windows at F≠1. Locked here as algebra; the renderer-level parity spec proves the fix.
    const fast = visibleUvWindow(node(UNDERDOCKS), G_UNSHIFTED, 1920);
    expect(uvWindowAttr(fast!)).toBe("0.083,0,0.817,0.9539");
    expect(uvWindowAttr(fast!)).not.toBe("0,0,0.8013,0.9539");
  });

  it("keeps content RIGHT of design x=1920 visible on a widened stage (was: 'entirely off-screen')", () => {
    // A 3840-wide bg translated to x=2000: the 16:9 box called it fully off-screen (null ⇒ full canvas — no gap
    // by luck), but the widened stage really shows design [2000,2520] of it → a real left-edge window.
    const n = node({ localRect: { x: 0, y: 0, width: 3840, height: 1080 } });
    const g: [number, number, number, number, number, number] = [1, 0, 0, 1, 2000, 0];
    expect(visibleUvWindow(n, g, 1920)).toBeNull();
    const w = visibleUvWindow(n, g, WIDE);
    expect(w).not.toBeNull();
    expect(w![0]).toBeCloseTo(0, 5); // u0 — its left edge is the first visible pixel
    expect(w![2]).toBeCloseTo(520 / 3840, 5); // du — design [2000,2520] of the 3840 box
  });

  it("widens the oversized gate: a box that fits the WIDENED stage is no longer clamped", () => {
    // 2200×1000 at origin: wider than 1920 (old: clamped) but inside 2520×1080 — at most stage-sized, so the
    // canvas needs no window at all on the wide stage.
    const n = node({ localRect: { x: 0, y: 0, width: 2200, height: 1000 } });
    const g: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
    expect(visibleUvWindow(n, g, 1920)).not.toBeNull();
    expect(visibleUvWindow(n, g, WIDE)).toBeNull();
  });
});
