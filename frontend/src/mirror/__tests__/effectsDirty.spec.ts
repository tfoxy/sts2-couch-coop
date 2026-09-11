// R10-PERF4 WS-2 — the EFFECTS-DIRTY seam (`renderer.consumeEffectsDirty`) and the MirrorView gate built on it.
//
// MirrorView used to reconcile BOTH gsw runtimes after every rendered frame. Each reconcile is a whole-stage
// `querySelectorAll` sweep plus per-binding attribute re-reads, and the shader one brackets itself in
// `invalidateRects()` — which defeats gsw's 0.12s rect-cache TTL, so every SCREEN_UV binding pays a fresh
// `getBoundingClientRect` on the next tick. None of that can find anything new unless the reconciler touched an
// effect marker, a self-layer, an element's existence or an occlusion suspend.
//
// These specs pin the two halves: which reconciler sites set which bit (so a later change that adds a site can be
// audited against them), and that MirrorView actually skips a runtime whose bit is clear.
import { mount } from "@vue/test-utils";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Spy runtimes + factory mocks, hoisted so the vi.mock factory below can close over them (same idiom as
// mirrorViewEffectModes.spec.ts).
const { shaderRt, particleRt, createWebglShaderRuntime, createParticleRuntime, createHtmlEffectsHost } = vi.hoisted(() => {
  const shaderRt = {
    reconcile: vi.fn(),
    setRenderScale: vi.fn(),
    setFps: vi.fn(),
    setStaticShaders: vi.fn(),
    // The frozen-mode backing pin (staticPin.ts): MirrorView pushes it after creating the runtime.
    setStaticShaderPixelRatio: vi.fn(),
    dispose: vi.fn()
  };
  const particleRt = {
    reconcile: vi.fn(),
    setRenderScale: vi.fn(),
    setFps: vi.fn(),
    setStaticParticles: vi.fn(),
    setStaticParticlePixelRatio: vi.fn(),
    dispose: vi.fn()
  };
  type HostOptions = {
    shaderOptions?: { enableWebglShaders?: boolean };
    particleOptions?: { enableParticles?: boolean };
  };
  const createHtmlEffectsHost = vi.fn((root: HTMLElement) => {
    let shaders: typeof shaderRt | null = null;
    let particles: typeof particleRt | null = null;
    return {
      get shaders() { return shaders; },
      get particles() { return particles; },
      updateOptions(options: HostOptions) {
        if (options.shaderOptions?.enableWebglShaders) shaders ??= createWebglShaderRuntime(root);
        else { shaders?.dispose(); shaders = null; }
        if (options.particleOptions?.enableParticles) particles ??= createParticleRuntime(root);
        else { particles?.dispose(); particles = null; }
      },
      reconcile() { shaders?.reconcile(); particles?.reconcile(); },
      dispose() { shaders?.dispose(); particles?.dispose(); shaders = null; particles = null; },
    };
  });
  return {
    shaderRt,
    particleRt,
    createWebglShaderRuntime: vi.fn((_root?: HTMLElement, _options?: unknown) => shaderRt),
    createParticleRuntime: vi.fn((_root?: HTMLElement, _options?: unknown) => particleRt),
    createHtmlEffectsHost,
  };
});

vi.mock("@godot-scene-web/html/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@godot-scene-web/html/runtime")>();
  return { ...actual, createWebglShaderRuntime, createParticleRuntime, createHtmlEffectsHost };
});

import MirrorView from "@/mirror/MirrorView.vue";
import { createMirrorRenderer, type MirrorRenderer } from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// --- fixtures ---------------------------------------------------------------------------------------------

type Raw = Record<string, unknown>;

const rect = (x: number, y: number, w: number, h: number) => ({ position: { x, y }, size: { x: w, y: h } });
const xf = (tx: number, ty: number) => ({ xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } });
const rgba = (r: number, g: number, b: number, a: number) => ({ r, g, b, a, html: "" });

function plain(id: string, parentId: string | null, extra: Raw = {}): Raw {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Godot.ColorRect",
    visible: true,
    transform: xf(100, 100),
    localRect: rect(0, 0, 120, 80),
    fillColor: rgba(1, 0, 0, 1),
    ...extra
  };
}

// A WebGL-shader node (the shape shaderMount.spec.ts uses): gsw's assignMaterialAttributes stamps the
// data-godot-shader-* markers the shader runtime selects on.
function shaderNode(strength: number): Raw {
  return {
    id: "shader",
    parentId: null,
    name: "Card",
    nodeType: "TextureRect",
    visible: true,
    transform: xf(200, 200),
    localRect: rect(0, 0, 200, 280),
    texture: { resourcePath: "res://images/card.png", resourceType: "Texture2D" },
    shader: { resourcePath: "res://shaders/card_ripple.gdshader", resourceType: "Shader" },
    shaderParameters: [{ name: "strength", kind: "number", number: strength }]
  };
}

// A particle node (the shape particleMount.spec.ts uses): the renderer stamps data-godot-particle-runtime +
// data-godot-particle-specs, which is what the particle runtime selects on / signatures by.
function particleNode(epoch: number): Raw {
  return {
    id: "particles",
    parentId: null,
    name: "EnergyVfxBack",
    nodeType: "GPUParticles2D",
    visible: true,
    transform: xf(320, 540),
    particleSpec: {
      kind: "GPUParticles2D",
      amount: 1,
      lifetime: 2,
      oneShot: true,
      scaleMin: 5,
      scaleMax: 5,
      emissionShape: 0,
      texture: {
        resourcePath: "res://images/vfx/common/common_glow.png",
        resourceType: "Texture2D",
        resourceName: ""
      },
      blendMode: 1
    },
    particleEmitting: true,
    particleRestartEpoch: epoch
  };
}

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function full(state: MirrorState, nodes: Raw[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      upserts: nodes,
      orderedIds: nodes.map((n) => n.id as string)
    })!
  );
}

// A VOLATILE-only delta (no orderedIds ⇒ the reconcile takes the pruned `update` path, never a structural walk).
function update(state: MirrorState, nodes: Raw[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: nodes })!);
}

// A STRUCTURAL delta (a new orderedIds array ⇒ the incremental structural walk).
function structural(state: MirrorState, nodes: Raw[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: false,
      screenType: "run",
      upserts: nodes,
      orderedIds: nodes.map((n) => n.id as string)
    })!
  );
}

// The scene every renderer-level spec starts from: one plain node, one shader node, one particle node.
function baseScene(): Raw[] {
  return [plain("plain", null), shaderNode(0.5), particleNode(1)];
}

// Reconcile then read+clear the bits — the exact call shape MirrorView uses.
function step(renderer: MirrorRenderer, state: MirrorState): { shader: boolean; particle: boolean } {
  renderer.reconcile(state);
  return renderer.consumeEffectsDirty();
}

describe("mirrorRenderer.consumeEffectsDirty", () => {
  it("reports BOTH dirty after the first build, and CLEARS on read", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, baseScene());

    expect(step(renderer, state)).toEqual({ shader: true, particle: true });
    // Read-and-clear: a second consume with nothing in between reports nothing.
    expect(renderer.consumeEffectsDirty()).toEqual({ shader: false, particle: false });
    renderer.dispose();
  });

  it("a re-style that reproduces the SAME marker values reports nothing", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, baseScene());
    step(renderer, state);

    // Re-upsert both effect nodes VERBATIM: fresh objects (so they are dirty and get fully re-styled, applyAttrs
    // and the self-layer writes included) carrying identical values. This is the steady state the gate lives on.
    update(state, [shaderNode(0.5), particleNode(1)]);
    expect(step(renderer, state)).toEqual({ shader: false, particle: false });
    renderer.dispose();
  });

  it("a changed shader PARAM dirties the shader bit only", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, baseScene());
    step(renderer, state);

    update(state, [shaderNode(0.9)]); // data-godot-shader-params changes
    expect(step(renderer, state)).toEqual({ shader: true, particle: false });
    renderer.dispose();
  });

  it("a changed particle SPEC dirties the particle bit only", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, baseScene());
    step(renderer, state);

    update(state, [particleNode(2)]); // data-godot-particle-specs (the runtime's signature) changes
    expect(step(renderer, state)).toEqual({ shader: false, particle: true });
    renderer.dispose();
  });

  it("dropping the shader off a node dirties the shader bit (the marker + self-layer are removed)", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, baseScene());
    step(renderer, state);

    const stripped = { ...shaderNode(0.5) };
    delete stripped.shader;
    delete stripped.shaderParameters;
    update(state, [stripped]);
    expect(step(renderer, state)).toEqual({ shader: true, particle: false });
    renderer.dispose();
  });

  it("dropping the particle spec off a node dirties the particle bit", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, baseScene());
    step(renderer, state);

    const stripped = { ...particleNode(1) };
    delete stripped.particleSpec;
    delete stripped.particleEmitting;
    delete stripped.particleRestartEpoch;
    update(state, [stripped]);
    expect(step(renderer, state)).toEqual({ shader: true, particle: true }); // removeEl-shaped: conservative BOTH
    renderer.dispose();
  });

  it("a purely NON-marker volatile change (a plain node moving) reports nothing", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, baseScene());
    step(renderer, state);

    update(state, [plain("plain", null, { transform: xf(140, 100) })]);
    expect(step(renderer, state)).toEqual({ shader: false, particle: false });
    renderer.dispose();
  });

  it("any STRUCTURAL walk dirties BOTH (the conservative bump that covers adds/removes/adoption)", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, baseScene());
    step(renderer, state);

    // An incremental structural walk that touches neither effect node: still BOTH, by design.
    structural(state, [...baseScene(), plain("extra", null)]);
    expect(step(renderer, state)).toEqual({ shader: true, particle: true });

    // ...and so does the removal of a node (removeEl).
    structural(state, baseScene());
    expect(step(renderer, state)).toEqual({ shader: true, particle: true });
    renderer.dispose();
  });

  it("an occlusion SUSPEND and its RESUME each dirty BOTH", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // A full-stage opaque cover over the effect nodes → the occlusion pass stamps EFFECTS_SUSPENDED_ATTR on the
    // gated roots (which is the only thing that tells either runtime to park a binding).
    const cover = plain("Cover", null, {
      transform: xf(0, 0),
      localRect: rect(0, 0, 1920, 1080),
      fillColor: rgba(0, 0, 0, 1),
      mouseFilter: 0
    });
    full(state, [plain("plain", null), shaderNode(0.5), particleNode(1), cover]);
    step(renderer, state);

    // The gate engages after OCCLUSION_ENGAGE_WALKS consecutive walks; these are volatile-only re-reconciles of
    // the same state, so nothing else can dirty a bit.
    let engaged = { shader: false, particle: false };
    for (let i = 0; i < 4 && !engaged.shader; i++) {
      engaged = step(renderer, state);
    }
    expect(engaged).toEqual({ shader: true, particle: true });
    expect(stage.querySelector("[data-godot-effects-suspended]")).not.toBeNull();

    renderer.consumeEffectsDirty();
    // Hide the cover → the gate releases (clearRootOcclusion removes the attribute).
    update(state, [{ ...cover, visible: false }]);
    expect(step(renderer, state)).toEqual({ shader: true, particle: true });
    expect(stage.querySelector("[data-godot-effects-suspended]")).toBeNull();
    renderer.dispose();
  });
});

// --- the MirrorView gate ----------------------------------------------------------------------------------

let origRAF: typeof globalThis.requestAnimationFrame;
let origCAF: typeof globalThis.cancelAnimationFrame;
let frames: FrameRequestCallback[];

function flushFrames(): void {
  for (const cb of frames.splice(0)) {
    cb(0);
  }
}

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  origRAF = globalThis.requestAnimationFrame;
  origCAF = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    frames.push(cb)) as unknown as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
});

afterAll(() => {
  globalThis.requestAnimationFrame = origRAF;
  globalThis.cancelAnimationFrame = origCAF;
});

beforeEach(() => {
  frames = [];
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

function mirrorState(): MirrorState {
  const state = createMirrorState();
  full(state, baseScene());
  return state;
}

describe("MirrorView effects-reconcile gate", () => {
  it("skips BOTH runtime reconciles on a rendered frame that changed no effect marker", async () => {
    const state = mirrorState();
    const wrapper = mount(MirrorView, { props: { state, revision: 1 } });
    // Mount forces a reconcile of both (the first build dirties everything anyway).
    expect(shaderRt.reconcile).toHaveBeenCalled();
    expect(particleRt.reconcile).toHaveBeenCalled();

    shaderRt.reconcile.mockClear();
    particleRt.reconcile.mockClear();
    // A rendered frame with nothing new: the coalesced render runs a walk, but no marker moves.
    await wrapper.setProps({ revision: 2 });
    flushFrames();
    expect(shaderRt.reconcile).not.toHaveBeenCalled();
    expect(particleRt.reconcile).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("reconciles only the SHADER runtime when only a shader marker moved", async () => {
    const state = mirrorState();
    const wrapper = mount(MirrorView, { props: { state, revision: 1 } });
    shaderRt.reconcile.mockClear();
    particleRt.reconcile.mockClear();

    update(state, [shaderNode(0.9)]);
    await wrapper.setProps({ revision: 2 });
    flushFrames();
    expect(shaderRt.reconcile).toHaveBeenCalledTimes(1);
    expect(particleRt.reconcile).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("reconciles only the PARTICLE runtime when only a particle marker moved", async () => {
    const state = mirrorState();
    const wrapper = mount(MirrorView, { props: { state, revision: 1 } });
    shaderRt.reconcile.mockClear();
    particleRt.reconcile.mockClear();

    update(state, [particleNode(2)]);
    await wrapper.setProps({ revision: 2 });
    flushFrames();
    expect(particleRt.reconcile).toHaveBeenCalledTimes(1);
    expect(shaderRt.reconcile).not.toHaveBeenCalled();
    wrapper.unmount();
  });

});
