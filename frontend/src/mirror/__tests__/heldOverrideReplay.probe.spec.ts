// Probe (not a gate): replay a recorded scene stream through the Rust producer with a recording-free executor and
// print the held-override verify log. Skipped unless COUCHCOOP_HELD_REPLAY names a repro/1 recording.
//   COUCHCOOP_HELD_REPLAY=<file> [COUCHCOOP_HELD_REPLAY_LIMIT=12500] [COUCHCOOP_HELD_REPLAY_QUERY=rustFastVerify=1]
//   [COUCHCOOP_HELD_REPLAY_FRAME_MS=16.667] [COUCHCOOP_HELD_REPLAY_OUT=<json>] npx vitest run heldOverrideReplay.probe
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { applySceneDelta, createMirrorState, parseSceneDelta } from "@/mirror/sceneTree";

vi.mock("@/render/quality", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/render/quality")>(),
  renderQuality: () => ({ tier: "very-low" }), stagePixelRatio: () => 1,
}));
vi.mock("@/mirror/mirrorSettings", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/mirror/mirrorSettings")>(),
  mirrorSettings: { ...(await importOriginal<typeof import("@/mirror/mirrorSettings")>()).mirrorSettings,
    shaderMode: "off", particleMode: "off", staticBgEnabled: true, spineMode: "static" },
}));
vi.mock("@/mirror/fonts", () => ({ ensureNodeFonts: vi.fn(), fontFaceInjectionVersion: () => 0, loadMirrorFont: vi.fn(async () => undefined) }));
// One stand-in still for every spine clip: the probe compares the producer with itself, not with real pixels.
vi.mock("@/mirror/spineClip", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/mirror/spineClip")>(),
  loadSpineClip: vi.fn(async () => ({ canvasWidth: 200, canvasHeight: 200, localWidth: 200, localX: -100, localY: -200,
    totalDurationMs: 0, frames: [{ offsetX: 0, offsetY: 0, width: 200, height: 200 }], stillUrl: "blob:still", degraded: false,
    retain() {}, release() {}, dispose() {} })),
}));

import { createPixiMirrorRenderer } from "@/mirror/renderer/pixi/createPixiMirrorRenderer";
import { readRendererComparisonConfig, rendererComparisonConfig } from "@/mirror/rendererComparison";

const recording = process.env.COUCHCOOP_HELD_REPLAY;
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const turn = () => new Promise<void>((resolve) => realSetTimeout(resolve, 0));

function executor() {
  const stats = { completedFrames: 0, frames: 0, resourcePending: 0, textureFailures: 0, textures: 0,
    contextReady: true, presentationValid: false, objects: 0 };
  const settle = () => { stats.frames++; stats.completedFrames++; stats.presentationValid = true; return Promise.resolve({ presented: true }); };
  return {
    stats, app: { renderer: {} }, resize: () => { stats.presentationValid = false; }, dispose: () => {},
    textureSize: () => ({ width: 2048, height: 2048 }), prefetch: () => {}, textureFailureDetails: () => [], setTraceFrameId: () => {},
    bindPixelTexture: () => {}, pollDiagnostics: () => {},
    textOutcomes: () => ({ requested: "native", actual: "native", native: 0, slug: 0, slugCached: 0, reasons: {} }),
    render: () => { throw new Error("legacy render"); },
    admitScene: () => settle(), patchScene: () => settle(), presentScene: () => settle(),
  };
}

describe.skipIf(!recording)("held-override replay probe", () => {
  it("replays the recording and reports the verify log", async () => {
    const limitMs = Number(process.env.COUCHCOOP_HELD_REPLAY_LIMIT ?? 12500);
    const frameMs = Number(process.env.COUCHCOOP_HELD_REPLAY_FRAME_MS ?? 16.667);
    const query = process.env.COUCHCOOP_HELD_REPLAY_QUERY ?? "rustFastVerify=1";
    window.history.replaceState(null, "", `/?rendererCompare=1&stage=rust&rustDiagnostics=1&${query}`);
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    vi.stubGlobal("__benchDiagnosticClockMs", 0);
    const measureText = (value: string) => ({ width: value.length * 10, fontBoundingBoxAscent: 16, fontBoundingBoxDescent: 4,
      actualBoundingBoxAscent: 16, actualBoundingBoxDescent: 4 });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ font: "", measureText } as never);
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const element = document.createElement("div");
    Object.defineProperties(element, { clientWidth: { value: 1920 }, clientHeight: { value: 1080 } });
    element.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1920, bottom: 1080, width: 1920, height: 1080, toJSON() {} });
    document.body.append(element);
    const renderer = createPixiMirrorRenderer(element, document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      undefined, { backend: "rust", createExecutor: async () => executor() as never });
    const globals = window as unknown as { __mirrorRendererDiagnostics(): { effective: Record<string, unknown>; readiness: string; failure?: string };
      __mirrorSetDiagnosticClock(ms: number): Promise<unknown> };
    const state = createMirrorState();
    const offer = async () => { if (renderer.reconcile(state) === false) { await turn(); renderer.reconcile(state); } };
    const lines = readFileSync(recording!, "utf8").trim().split("\n").slice(1).map((line) => JSON.parse(line) as { t: number; data: string });
    let clock = -1, deltas = 0;
    try {
      for (const { t, data } of lines) {
        if (t > limitMs) break;
        const delta = parseSceneDelta(JSON.parse(data));
        if (!delta) continue;
        if (clock >= 0) for (let at = clock + frameMs; at < t; at += frameMs) { await globals.__mirrorSetDiagnosticClock(at); clock = at; }
        if (clock >= 0) await globals.__mirrorSetDiagnosticClock(t);
        clock = t;
        applySceneDelta(state, delta);
        deltas++;
        if (deltas === 1) {
          renderer.setStaticBackgroundSource!({ scenePath: "res://scenes/backgrounds/overgrowth/overgrowth_background.tscn", url: "/bg/overgrowth.png" }, () => {});
          renderer.reconcile(state);
          await turn();
        }
        await offer();
      }
      const report = { deltas, clock, readiness: globals.__mirrorRendererDiagnostics().readiness, failure: globals.__mirrorRendererDiagnostics().failure,
        held: globals.__mirrorRendererDiagnostics().effective.rustHeldOverride };
      process.stderr.write(`HELD-REPLAY ${JSON.stringify(report, null, 1)}\n`);
      if (process.env.COUCHCOOP_HELD_REPLAY_OUT) writeFileSync(process.env.COUCHCOOP_HELD_REPLAY_OUT, JSON.stringify(report, null, 1));
      expect(report.readiness).toBe("ready");
    } finally {
      renderer.dispose();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  }, 600_000);
});
