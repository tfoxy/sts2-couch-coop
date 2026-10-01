// jsdom. THE CANVAS STAGE'S IDENTITY LAYOUT — the template half of the `?stage=canvas` blur fix.
//
// Blink allocates a render surface for a `transform: scale(fit)` element that has a composited descendant, sized at
// LAYER space (CSS x devicePixelRatio); the stage canvas's texture is then bilinearly magnified into that surface
// and minified back out when it is drawn — net geometry 1.0, two resamples, and a visibly soft stage on any desktop
// whose dpr is not 1. So on the canvas arm the canvas gets its OWN host, laid out at the fitted box with no
// transform, and the design box stays on `.mirror-stage` for the DOM overlays (whose supersampling is benign).
// Mechanism, compositor trace and byte-crisp identity arm: `.sts2/canvas-blur-sep03/FINDINGS.md`, per checkout;
// the backing-store arithmetic is canvasRenderer's, and is pinned in canvasStage.spec.
//
// What only THIS component can get wrong is the layout, which is what this spec is about: the host is the fitted
// box (following the widened design width, not a hardcoded 1920), it carries no transform, the stage keeps its
// design box + scale, and the one piece of stage content that has to paint UNDER the canvas — the static
// background, through the `underlay` slot — lands in the design-space layer below it rather than in the stage.
import { mount } from "@vue/test-utils";
import { defineComponent, h, inject, nextTick, ref, type ShallowRef } from "vue";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import MirrorView from "@/mirror/MirrorView.vue";
import { createMirrorRenderer } from "@/mirror/mirrorRenderer";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { __setStageBackendForTest, requestedStageBackend, type StageBackend } from "@/mirror/rendererFactory";
import * as rendererFactory from "@/mirror/rendererFactory";
import * as inputCaptureModule from "@/mirror/inputCapture";
import { rendererRuntimeStatus, setRendererRuntimeStatus } from "@/mirror/rendererComparison";
import { MIRROR_RENDERER_KEY } from "@/mirror/rendererKey";
import type { MirrorRenderer } from "@/mirror/renderer/contracts";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// The frame box the next recomputeScale measures (jsdom has no layout, so the rect is stubbed like every other
// MirrorView spec does it). Every box below is chosen so the fit is exact in binary — a 0.75 scale, not
// 0.8333333333333334 — because these assertions are on the STRINGS the component writes into `style`.
let frameBox = { width: 0, height: 0 };

let origRect: typeof Element.prototype.getBoundingClientRect;
let origRAF: typeof globalThis.requestAnimationFrame;
let origCAF: typeof globalThis.cancelAnimationFrame;
let backendAtStart: StageBackend;

function emptyState(): MirrorState {
  return createMirrorState();
}

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  origRAF = globalThis.requestAnimationFrame;
  origCAF = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (() => 1) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
  origRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      ...frameBox,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: frameBox.width,
      bottom: frameBox.height,
      toJSON: () => ({})
    } as DOMRect;
  };
});

afterAll(() => {
  globalThis.requestAnimationFrame = origRAF;
  globalThis.cancelAnimationFrame = origCAF;
  Element.prototype.getBoundingClientRect = origRect;
});

beforeEach(() => {
  backendAtStart = requestedStageBackend();
  frameBox = { width: 0, height: 0 };
  mirrorSettings.stretchEnabled = true;
  // The canvas backend cannot be built in jsdom (no WebGL2), so this view stays blank.
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  __setStageBackendForTest(backendAtStart);
  setRendererRuntimeStatus({ actualBackend: null, actualConfig: null, phase: "initializing", reason: null });
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** Mount with a marker in the `underlay` slot, so a test can ask WHERE that slot rendered. */
function mountView() {
  return mount(MirrorView, {
    props: { state: emptyState(), revision: 1 },
    slots: { underlay: '<i data-testid="underlay-marker"></i>' },
    attachTo: document.body
  });
}

const hostEl = () => document.querySelector<HTMLElement>(".mirror-canvas-host");
const stageEl = () => document.querySelector<HTMLElement>(".mirror-stage");
const underlayEl = () => document.querySelector<HTMLElement>(".mirror-stage-underlay");

describe("MirrorView's canvas host (`?stage=canvas`)", () => {
  beforeEach(() => {
    __setStageBackendForTest("canvas");
  });

  it("lays the canvas host out at the FITTED box, with no transform on it", async () => {
    frameBox = { width: 1440, height: 810 }; // 16:9 → design 1920x1080, fit exactly 0.75
    const wrapper = mountView();
    await wrapper.vm.$nextTick();

    const host = hostEl();
    expect(host, "the canvas arm renders a host for the canvas").not.toBeNull();
    expect(host!.style.width).toBe("1440px");
    expect(host!.style.height).toBe("810px");
    // THE WHOLE POINT. Anything here — even a translate, which would tempt a centring refactor — puts the canvas
    // back under a transformed ancestor, which is where the double resample lives.
    expect(host!.style.transform).toBe("");

    // …while the stage keeps the DESIGN box and the fit transform, because the DOM overlays are laid out in it.
    expect(stageEl()!.style.width).toBe("1920px");
    expect(stageEl()!.style.transform).toBe("scale(0.75)");
    wrapper.unmount();
  });

  it("follows the WIDENED design width, not a hardcoded 1920", async () => {
    // An ultra-wide frame: the design box widens to MIRROR_MAX_DESIGN_WIDTH (2520) and the fit is set by the
    // SHORT edge (810/1080 = 0.75), so a host sized off a fixed 1920 would be 630 CSS px too narrow and the canvas
    // would be drawn into a box that is not the one the stage occupies.
    frameBox = { width: 2520, height: 810 };
    const wrapper = mountView();
    await wrapper.vm.$nextTick();

    expect(stageEl()!.style.width).toBe("2520px");
    expect(hostEl()!.style.width).toBe("1890px"); // 2520 x 0.75
    expect(hostEl()!.style.height).toBe("810px");
    wrapper.unmount();
  });

  it("leaves the canvas stage blank when jsdom rejects its renderer", async () => {
    frameBox = { width: 1440, height: 810 };
    const wrapper = mountView();
    await wrapper.vm.$nextTick();

    // There is no canvas or DOM scene after construction fails. The stage host remains in place for retry.
    const kids = Array.from(document.querySelector<HTMLElement>(".mirror-frame")!.children);
    expect(kids.indexOf(hostEl()!)).toBeLessThan(kids.indexOf(stageEl()!));
    expect(underlayEl()).toBeNull();
    expect(stageEl()!.querySelector(".mirror-node")).toBeNull();

    expect(stageEl()!.classList.contains("mirror-stage-over-canvas")).toBe(true);
    wrapper.unmount();
  });

  it("does not install input capture or acknowledge a blank GPU stage", async () => {
    const sendInput = vi.fn();
    const onSceneRendered = vi.fn();
    const wrapper = mount(MirrorView, {
      props: { state: emptyState(), revision: 1, sendInput, onSceneRendered },
      attachTo: document.body
    });
    await nextTick();
    stageEl()!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 20, clientY: 20 }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sendInput).not.toHaveBeenCalled();
    expect(onSceneRendered).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("releases input capture when a mounted GPU renderer fails", async () => {
    const dispose = vi.fn();
    const originalCapture = inputCaptureModule.createInputCapture;
    vi.spyOn(inputCaptureModule, "createInputCapture").mockImplementation((...args) => {
      const capture = originalCapture(...args);
      const originalDispose = capture.dispose.bind(capture);
      capture.dispose = () => { dispose(); originalDispose(); };
      return capture;
    });
    vi.spyOn(rendererFactory, "createMirrorRendererFor").mockImplementation((stage, defs) => createMirrorRenderer(stage, defs));
    const sendInput = vi.fn();
    setRendererRuntimeStatus({ requested: { ...rendererRuntimeStatus.requested, backend: "canvas" },
      actualBackend: "rust", phase: "active", reason: null });
    const wrapper = mount(MirrorView, { props: { state: emptyState(), revision: 1, sendInput }, attachTo: document.body });
    expect(dispose).not.toHaveBeenCalled();
    setRendererRuntimeStatus({ phase: "failed", reason: "WebGL context lost" });
    expect(dispose).toHaveBeenCalledOnce();
    stageEl()!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 20, clientY: 20 }));
    expect(sendInput).not.toHaveBeenCalled();
    wrapper.unmount();
  });

});

describe("MirrorView on the DOM arm", () => {
  beforeEach(() => {
    __setStageBackendForTest("dom");
  });

  it("adds NOTHING: no host, no underlay layer, and the slot renders in the stage as it always has", async () => {
    frameBox = { width: 1440, height: 810 };
    const wrapper = mountView();
    await wrapper.vm.$nextTick();

    expect(hostEl()).toBeNull();
    expect(underlayEl()).toBeNull();
    expect(stageEl()!.querySelector('[data-testid="underlay-marker"]')).not.toBeNull();
    expect(stageEl()!.classList.contains("mirror-stage-over-canvas")).toBe(false);
    expect(stageEl()!.style.width).toBe("1920px");
    expect(stageEl()!.style.transform).toBe("scale(0.75)");
    wrapper.unmount();
  });

  it("disposes the old renderer and reconciles the retained scene after a view-only remount", async () => {
    const state = createMirrorState();
    applySceneDelta(state, parseSceneDelta({
      type: "scene-delta", full: true, screenType: "lobby",
      upserts: [{ id: "retained-root", parentId: null, name: "RetainedRoot", nodeType: "Control", visible: true,
        transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
        localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } } }],
      orderedIds: ["retained-root"]
    })!);
    const viewKey = ref(0);
    const rendererRefs: ShallowRef<MirrorRenderer | null>[] = [];
    const Probe = defineComponent({
      setup() {
        const rendererRef = inject(MIRROR_RENDERER_KEY);
        if (!rendererRef) throw new Error("MirrorView did not provide its renderer");
        rendererRefs.push(rendererRef as ShallowRef<MirrorRenderer | null>);
        return () => h("i");
      }
    });
    const Parent = defineComponent({
      setup: () => () => h(MirrorView, { key: viewKey.value, state, revision: 1 }, {
        underlay: () => h(Probe)
      })
    });
    const wrapper = mount(Parent, { attachTo: document.body });
    await nextTick();
    const first = rendererRefs[0]?.value;
    expect(first).toBeTruthy();
    const dispose = vi.spyOn(first!, "dispose");
    const oldNode = document.querySelector('[data-node-id="retained-root"]');
    expect(oldNode).not.toBeNull();

    viewKey.value++;
    await nextTick();
    expect(dispose).toHaveBeenCalledOnce();
    expect(rendererRefs[0]?.value).toBeNull();
    expect(rendererRefs[1]?.value).toBeTruthy();
    expect(rendererRefs[1]?.value).not.toBe(first);
    const newNode = document.querySelector('[data-node-id="retained-root"]');
    expect(newNode).not.toBeNull();
    expect(newNode).not.toBe(oldNode);
    expect(state.nodes.has("retained-root")).toBe(true);
    wrapper.unmount();
  });
});
