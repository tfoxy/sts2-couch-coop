import assert from "node:assert/strict";
import { stepCanvasParityAnimationInPage } from "./lib/canvas-parity-animation.mjs";

const saved = { window: globalThis.window, raf: globalThis.requestAnimationFrame };
let rebuilds = 0, clock = null;
const value = { instance: { id: 7 }, builds: 0, frames: 0, animFrames: 0, patch: { referenceReuse: { presentedFrames: 0 } } };
try {
  globalThis.window = {
    __mirrorCanvasStats: () => structuredClone(value),
    __mirrorRendererDiagnostics: () => ({ ready: true, resources: { pending: 0, failed: 0 } }),
    __mirrorSetDiagnosticClock: async ms => { rebuilds++; value.builds++; clock = { nowMs: ms }; window.__mirrorCanvasBenchClock = clock; },
  };
  globalThis.requestAnimationFrame = callback => {
    value.frames++; value.animFrames++; value.patch.referenceReuse.presentedFrames++; callback();
  };
  const result = await stepCanvasParityAnimationInPage({ clockMs: 5000, steps: 89 });
  assert.equal(rebuilds, 1); assert.equal(clock.nowMs, 5000);
  assert.equal(result.after.animFrames - result.before.animFrames, 89);
  assert.equal(result.finalStepBuilt, false); assert.equal(result.finalStepReferencePresented, true);
  await assert.rejects(stepCanvasParityAnimationInPage({ clockMs: 1, steps: 181 }), /invalid/);
  globalThis.requestAnimationFrame = callback => { value.instance.id++; value.frames++; value.animFrames++; callback(); };
  await assert.rejects(stepCanvasParityAnimationInPage({ clockMs: 5000, steps: 1 }), /restarted/);
} finally {
  if (saved.window === undefined) delete globalThis.window; else globalThis.window = saved.window;
  if (saved.raf === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = saved.raf;
}
console.log("Canvas parity ordinary-animation stepping tests passed");
