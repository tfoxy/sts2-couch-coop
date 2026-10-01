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

describe("GPU stage failure without DOM fallback", () => {
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

  it.each(["canvas", "pixi", "rust"] as const)("keeps %s selected after a construction failure", (backend) => {
    setComparisonStageBackend(backend);
    backendMocks[backend === "canvas" ? "rust" : backend].mockImplementationOnce(() => { throw new Error("WebGL2 unavailable"); });
    const { stage, defs } = hosts();

    expect(createMirrorRendererFor(stage, defs)).toBeNull();
    expect(backendMocks.dom).not.toHaveBeenCalled();
    expect(requestedStageBackend()).toBe(backend);
    expect(activeStageBackend()).toBe(backend === "canvas" ? "rust" : backend);
    expect(rendererRuntimeStatus).toMatchObject({ actualBackend: backend === "canvas" ? "rust" : backend,
      phase: "failed", reason: "WebGL2 unavailable" });
    if (backend === "canvas") expect(mirrorSettings.runtimeStage).toBe("canvas");
  });

  it.each(["canvas", "pixi", "rust"] as const)("keeps %s mounted after a runtime failure", (backend) => {
    setComparisonStageBackend(backend);
    const revision = rendererComparisonViewRevision.value;
    let onStatus!: (phase: "initializing" | "ready" | "failed", reason?: string) => void;
    backendMocks[backend === "canvas" ? "rust" : backend].mockImplementationOnce((_stage, _defs, _host, callback) => {
      onStatus = callback;
      return fakeRenderer;
    });
    const { stage, defs } = hosts();

    const renderer = createMirrorRendererFor(stage, defs)!;
    onStatus("failed", "context lost");
    expect(activeStageBackend()).toBe(backend === "canvas" ? "rust" : backend);
    expect(rendererComparisonViewRevision.value).toBe(revision);
    expect(rendererRuntimeStatus).toMatchObject({ actualBackend: backend === "canvas" ? "rust" : backend,
      phase: "failed", reason: "context lost" });
    expect(backendMocks.dom).not.toHaveBeenCalled();

    onStatus("ready");
    expect(rendererRuntimeStatus.phase).toBe("failed");
    renderer.dispose();
  });

  it.each(["canvas", "pixi", "rust"] as const)("reports %s context loss without switching backends", (backend) => {
    setComparisonStageBackend(backend);
    const actual = backend === "canvas" ? "rust" : backend;
    backendMocks[actual].mockImplementationOnce((stage: HTMLElement) => {
      const canvas = document.createElement("canvas");
      canvas.className = `mirror-${actual}-stage`;
      stage.append(canvas);
      return fakeRenderer;
    });
    const { stage, defs } = hosts();
    const renderer = createMirrorRendererFor(stage, defs)!;
    const event = new Event("webglcontextlost", { cancelable: true });
    stage.querySelector("canvas")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(rendererRuntimeStatus).toMatchObject({ actualBackend: actual, phase: "failed", reason: "WebGL context lost" });
    expect(backendMocks.dom).not.toHaveBeenCalled();
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
    const renderer = createMirrorRendererFor(stage, defs)!;
    renderer.dispose();

    onStatus("failed", "late failure");
    await Promise.resolve();
    expect(rendererComparisonViewRevision.value).toBe(revision);
    expect(mirrorSettings.runtimeStage).toBe("canvas");
    expect(backendMocks.dom).not.toHaveBeenCalled();
  });

  it("uses DOM only after the viewer selects it", () => {
    setComparisonStageBackend("canvas");
    backendMocks.rust.mockImplementationOnce(() => { throw new Error("WebGL2 unavailable"); });
    const { stage, defs } = hosts();
    expect(createMirrorRendererFor(stage, defs)).toBeNull();
    setComparisonStageBackend("dom");
    expect(createMirrorRendererFor(stage, defs)).toBe(fakeRenderer);
    expect(backendMocks.dom).toHaveBeenCalledOnce();
    expect(rendererRuntimeStatus.phase).toBe("active");
  });
});
