import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backendMocks = vi.hoisted(() => ({
  dom: vi.fn(),
  canvas: vi.fn(),
  pixi: vi.fn(),
  rust: vi.fn()
}));

vi.mock("@/mirror/mirrorRenderer", () => ({ createMirrorRenderer: backendMocks.dom }));
vi.mock("@/mirror/canvas/canvasRenderer", () => ({ createCanvasMirrorRenderer: backendMocks.canvas }));
vi.mock("@/mirror/renderer/pixi/createPixiMirrorRenderer", () => ({ createPixiMirrorRenderer: backendMocks.pixi }));
vi.mock("@/mirror/renderer/pixi/createRustMirrorRenderer", () => ({ createRustMirrorRenderer: backendMocks.rust }));

import { mirrorSettings } from "@/mirror/mirrorSettings";
import {
  activeStageBackend,
  createMirrorRendererFor,
  requestedStageBackend,
  setComparisonStageBackend
} from "@/mirror/rendererFactory";
import {
  rendererComparisonViewRevision,
  rendererRuntimeStatus,
  setRendererRuntimeStatus
} from "@/mirror/rendererComparison";

const fakeRenderer = { dispose: vi.fn() };

function hosts(): { stage: HTMLElement; defs: SVGElement } {
  const stage = document.createElement("div");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  document.body.append(stage, defs);
  return { stage, defs };
}

beforeEach(() => {
  backendMocks.dom.mockReset().mockReturnValue(fakeRenderer);
  backendMocks.canvas.mockReset();
  backendMocks.pixi.mockReset();
  backendMocks.rust.mockReset().mockReturnValue(fakeRenderer);
  fakeRenderer.dispose.mockReset();
  mirrorSettings.stage = "dom";
  mirrorSettings.runtimeStage = "dom";
  setRendererRuntimeStatus({ actualBackend: null, actualConfig: null, phase: "initializing", reason: null });
  document.body.replaceChildren();
});

afterEach(() => {
  setComparisonStageBackend("dom");
  document.body.replaceChildren();
});

describe("public Rust stage fallback", () => {
  it("selects an explicit Rust comparison URL at factory module initialization without persisting it", async () => {
    const priorUrl = window.location.href;
    const storageKey = "couchcoop.mirrorSettings.v1";
    const priorStorage = localStorage.getItem(storageKey);
    try {
      localStorage.setItem(storageKey, JSON.stringify({ stage: "canvas" }));
      window.history.replaceState(null, "", "/?rendererCompare=1&stage=rust");
      vi.resetModules();
      const [{ mirrorSettings: freshSettings }, factory, comparison] = await Promise.all([
        import("@/mirror/mirrorSettings"), import("@/mirror/rendererFactory"), import("@/mirror/rendererComparison")
      ]);
      expect(freshSettings.stage).toBe("canvas");
      expect(freshSettings.runtimeStage).toBe("canvas");
      expect(factory.requestedStageBackend()).toBe("rust");
      const { stage, defs } = hosts();
      factory.createMirrorRendererFor(stage, defs);
      expect(backendMocks.rust).toHaveBeenCalledOnce();
      expect(backendMocks.dom).not.toHaveBeenCalled();
      expect(comparison.rendererRuntimeStatus.requested.backend).toBe("rust");
    } finally {
      window.history.replaceState(null, "", priorUrl);
      if (priorStorage === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, priorStorage);
      vi.resetModules();
    }
  });

  it("recovers to DOM and records a renderer construction failure", () => {
    setComparisonStageBackend("canvas");
    mirrorSettings.stage = "canvas";
    backendMocks.rust.mockImplementationOnce(() => { throw new Error("WebGL2 unavailable"); });
    const { stage, defs } = hosts();

    expect(createMirrorRendererFor(stage, defs)).toBe(fakeRenderer);
    expect(backendMocks.dom).toHaveBeenCalledOnce();
    expect(requestedStageBackend()).toBe("dom");
    expect(activeStageBackend()).toBe("dom");
    expect(mirrorSettings.stage).toBe("canvas");
    expect(mirrorSettings.runtimeStage).toBe("dom");
    expect(rendererRuntimeStatus).toMatchObject({ actualBackend: "dom", phase: "active", reason: "WebGL2 unavailable" });
  });

  it("falls back once on runtime failure and ignores a stale status callback after recovery", async () => {
    setComparisonStageBackend("canvas");
    mirrorSettings.stage = "canvas";
    const revision = rendererComparisonViewRevision.value;
    let onStatus!: (phase: "initializing" | "ready" | "failed", reason?: string) => void;
    backendMocks.rust.mockImplementationOnce((_stage, _defs, _host, callback) => {
      onStatus = callback;
      return fakeRenderer;
    });
    const { stage, defs } = hosts();

    const renderer = createMirrorRendererFor(stage, defs);
    expect(activeStageBackend()).toBe("rust");
    onStatus("failed", "context lost");
    await Promise.resolve();
    expect(activeStageBackend()).toBe("dom");
    expect(mirrorSettings.stage).toBe("canvas");
    expect(mirrorSettings.runtimeStage).toBe("dom");
    expect(rendererComparisonViewRevision.value).toBe(revision + 1);
    expect(rendererRuntimeStatus).toMatchObject({ actualBackend: "rust", phase: "failed", reason: "context lost" });

    onStatus("ready");
    await Promise.resolve();
    expect(rendererComparisonViewRevision.value).toBe(revision + 1);
    renderer.dispose();
  });

  it("ignores a failed initialization callback from a disposed Rust renderer", async () => {
    setComparisonStageBackend("canvas");
    mirrorSettings.stage = "canvas";
    const revision = rendererComparisonViewRevision.value;
    let onStatus!: (phase: "initializing" | "ready" | "failed", reason?: string) => void;
    backendMocks.rust.mockImplementationOnce((_stage, _defs, _host, callback) => {
      onStatus = callback;
      return fakeRenderer;
    });
    const { stage, defs } = hosts();
    const renderer = createMirrorRendererFor(stage, defs);
    renderer.dispose();

    onStatus("failed", "late failure");
    await Promise.resolve();
    expect(rendererComparisonViewRevision.value).toBe(revision);
    expect(mirrorSettings.runtimeStage).toBe("canvas");
    expect(backendMocks.dom).not.toHaveBeenCalled();
  });
});
