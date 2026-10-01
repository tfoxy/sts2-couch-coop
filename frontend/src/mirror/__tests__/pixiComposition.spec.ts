import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { applySceneDelta, createMirrorState, parseSceneDelta } from "@/mirror/sceneTree";
import { connectMirrorClient } from "@/mirror/mirrorClient";
import MirrorView from "@/mirror/MirrorView.vue";
import * as rendererFactory from "@/mirror/rendererFactory";
import { applyKeyframe, holderId, holderSpec, positionHint, slot, update } from "./handStageHarness";

const control = vi.hoisted(() => ({
  pending: null as null | { resolve(value: unknown): void; reject(error: unknown): void },
  created: [] as Array<Record<string, unknown>>,
  options: null as Record<string, unknown> | null,
  glyphReady: false,
  glyphOnReady: null as null | (() => void),
  glyphBlockCalls: 0,
  resizeObserver: null as null | (() => void),
}));
const rewardSpy = vi.hoisted(() => vi.fn((_nodes: unknown) => ({ screenId: null, rows: [] })));
const schedulerControl = vi.hoisted(() => ({ arms: vi.fn(), ports: null as any }));
const fontLoader = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@/render/quality", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/render/quality")>(),
  renderQuality: () => ({ tier: "very-low" }), stagePixelRatio: () => 1
}));
vi.mock("@/mirror/mirrorSettings", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/mirror/mirrorSettings")>(),
  mirrorSettings: { ...(await importOriginal<typeof import("@/mirror/mirrorSettings")>()).mirrorSettings,
    shaderMode: "off", particleMode: "off", staticBgEnabled: true, spineMode: "static" }
}));
vi.mock("@godot-scene-web/canvas/pixi", () => ({
  createPixiDrawListRenderer: (options: Record<string, unknown>) => new Promise((resolve, reject) => {
    control.options = options; control.pending = { resolve, reject };
  })
}));
vi.mock("@/mirror/canvas/glyphPass", () => ({ createGlyphPassRegistry: (options: { onReady?: () => void }) => {
  control.glyphOnReady = options.onReady ?? null;
  let refusedNotReady = 0;
  const borrowed = { runCount: 1, origins: new Float32Array([0, 16]), spans: new Int32Array([0, 2]),
    colors: new Float32Array([1, 1, 1, 1]), spreads: new Float32Array([0]), slots: new Int32Array([7, 8, 99]),
    positions: new Float32Array([0, 0, 10, 0, 99, 99]), pixelsPerEm: 20, blockScale: 1 };
  return { pass: { drawRun: () => ({ glyphs: 2, drawCalls: 1 }) }, invalidate: vi.fn(), restore: vi.fn(() => true), dispose: vi.fn(),
    stats: () => ({ ready: control.glyphReady, facesPending: 0, refusedNotReady }),
    blockFor: () => { control.glyphBlockCalls++; return control.glyphReady ? borrowed : (refusedNotReady++, null); },
    boundsFor: () => ({ x: 0, y: 0, width: 20, height: 20 }) };
} }));
vi.mock("@/mirror/fonts", () => ({ ensureNodeFonts: vi.fn(), fontFaceInjectionVersion: () => 0, loadMirrorFont: (...args: unknown[]) => fontLoader.load(...args) }));
vi.mock("@/mirror/rewardFocusSnapshot", () => ({ rewardFocusSnapshotFromScene: rewardSpy }));
vi.mock("@/mirror/renderer/canvas/frameScheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/renderer/canvas/frameScheduler")>();
  return { ...actual, createCanvasFrameScheduler: (ports: Parameters<typeof actual.createCanvasFrameScheduler>[0]) => {
    schedulerControl.ports = ports as typeof schedulerControl.ports;
    const scheduler = actual.createCanvasFrameScheduler(ports);
    const arm = scheduler.armAnimation.bind(scheduler);
    scheduler.armAnimation = (at: number) => { schedulerControl.arms(at); arm(at); };
    return scheduler;
  } };
});

import { createPixiMirrorRenderer } from "@/mirror/renderer/pixi/createPixiMirrorRenderer";
import { __setStageBackendForTest, createMirrorRendererFor } from "@/mirror/rendererFactory";
import { readRendererComparisonConfig, rendererComparisonConfig, rendererRuntimeStatus } from "@/mirror/rendererComparison";
import type { WarmAckTraceEvent } from "@/mirror/warmAckTrace";

type TestPixiText = { labelId?: string; key: string; glyph?: { block: { slots: Int32Array }; inkBounds: unknown; cacheEligible?: boolean };
  fallbackReason?: string; nativeFallback?: readonly TestPixiText[] };

function fakeAdapter(asynchronous = false) {
  let accept = true;
  const outcome = <T>(value: T) => asynchronous ? Promise.resolve(value) : value;
  let outcomes = { requested: "native", actual: "native", native: 0, slug: 0, slugCached: 0, reasons: {} as Record<string, number> };
  const adapter = {
    stats: { completedFrames: 0, frames: 0, resourcePending: 0, textureFailures: 0, textures: 0,
      contextReady: true, presentationValid: false },
    app: { renderer: {} }, resize: vi.fn(() => { adapter.stats.presentationValid = false; }), dispose: vi.fn(),
    textureSize: vi.fn((_url: string): { width: number; height: number } | null => null),
    setTraceFrameId: vi.fn(),
    prefetch: vi.fn(), textureFailureDetails: vi.fn(() => []),
    render: vi.fn(() => { adapter.stats.frames++; if (accept && adapter.stats.contextReady) adapter.stats.completedFrames++;
      adapter.stats.presentationValid = accept && adapter.stats.contextReady; return adapter.stats.presentationValid; }),
    admitScene: vi.fn((_list: unknown, texts: readonly TestPixiText[], _plan: unknown) => {
      adapter.stats.frames++; if (accept && adapter.stats.contextReady) {
        adapter.stats.completedFrames++;
        adapter.stats.presentationValid = true;
        const labels = new Map(texts.map((item) => [item.labelId ?? item.key, item]));
        const mode = (control.options?.textMode as string) ?? "native";
        let native = 0, slug = 0, slugCached = 0;
        const reasons: Record<string, number> = {};
        for (const item of labels.values()) {
          if (mode !== "native" && item.glyph) {
            if (mode === "slug-cached") slugCached++; else slug++;
          }
          else { native++; if (item.fallbackReason) reasons[item.fallbackReason] = (reasons[item.fallbackReason] ?? 0) + 1; }
        }
        outcomes = { requested: mode, actual: (slug || slugCached) && native ? "mixed" : (slug || slugCached) ? mode : "native", native, slug, slugCached, reasons };
      }
      else adapter.stats.presentationValid = false;
      return outcome({ presented: accept && adapter.stats.contextReady, reason: accept && adapter.stats.contextReady ? undefined : "test presentation refused" });
    }),
    patchScene: vi.fn((_patch: unknown) => {
      adapter.stats.frames++; if (accept && adapter.stats.contextReady) adapter.stats.completedFrames++;
      adapter.stats.presentationValid = accept && adapter.stats.contextReady;
      return outcome({ presented: adapter.stats.presentationValid, reason: adapter.stats.presentationValid ? undefined : "test presentation refused" });
    }),
    presentScene: vi.fn(() => {
      adapter.stats.frames++; if (accept && adapter.stats.contextReady) adapter.stats.completedFrames++;
      adapter.stats.presentationValid = accept && adapter.stats.contextReady;
      return outcome({ presented: adapter.stats.presentationValid, reason: adapter.stats.presentationValid ? undefined : "test presentation refused" });
    }),
    setAccept(next: boolean) { accept = next; },
    setTextOutcomes(next: typeof outcomes) { outcomes = next; },
    textOutcomes: vi.fn(() => outcomes),
  };
  control.created.push(adapter);
  return adapter;
}

function stage() {
  const element = document.createElement("div");
  Object.defineProperties(element, { clientWidth: { value: 1920 }, clientHeight: { value: 1080 } });
  element.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1920, bottom: 1080, width: 1920, height: 1080, toJSON() {} });
  document.body.append(element);
  return element;
}

function textScene(bob = false) {
  const state = createMirrorState();
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true,
    screenType: "run", orderedIds: ["root", "label"], upserts: [
      { id: "root", parentId: null, name: "Root", nodeType: "Control", visible: true,
        transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
        localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } } },
      { id: "label", parentId: "root", name: "Label", nodeType: "Label", visible: true,
        transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 20, y: 30 } },
        localRect: { position: { x: 0, y: 0 }, size: { x: 200, y: 60 } },
        text: { text: "Synthetic label", fontSize: 20, textColor: { html: "#ffffffff" } } }
    ] })!);
  state.nodes.get("label")!.font = { family: "TestFont", url: "/test-font.ttf", weight: "normal", style: "normal" };
  if (bob) {
    state.nodes.get("root")!.sceneFilePath = "res://scenes/combat/intent.tscn";
    state.nodes.get("root")!.nodeType = "NIntent";
    state.nodes.get("label")!.name = "IntentHolder";
  }
  return state;
}

function animatedColorScene() {
  const state = createMirrorState();
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", orderedIds: ["root"],
    upserts: [{ id: "root", parentId: null, name: "Root", nodeType: "ColorRect", visible: true,
      transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 20, y: 30 } },
      localRect: { position: { x: 0, y: 0 }, size: { x: 180, y: 110 } },
      fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffffff" }, pinnedLoopAnim: "mapPointPulse" }],
  })!);
  return state;
}

function handScene() {
  const state = createMirrorState();
  applyKeyframe(state, 1);
  return state;
}

function handEndpoint(x: number) {
  const resting = slot(0, 1);
  return [1, 0, 0, 1, x, resting[5]];
}

function measureStub() {
  const measureText = vi.fn((value: string) => ({ width: value.length * 10,
    fontBoundingBoxAscent: 16, fontBoundingBoxDescent: 4, actualBoundingBoxAscent: 16, actualBoundingBoxDescent: 4 }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ font: "", measureText } as never);
  return measureText;
}

const diagnostic = () => (window as unknown as {
  __mirrorRendererDiagnostics(): { draw: Record<string, number>; effective: Record<string, number>; frameIdentity: unknown;
    asyncSubmissionRevision: number | null; glyphs: { ready: boolean | null; refusedNotReady: number } | null };
}).__mirrorRendererDiagnostics();

async function clockAt(ms: number) {
  return (window as unknown as { __mirrorSetDiagnosticClock(ms: number): Promise<unknown> }).__mirrorSetDiagnosticClock(ms);
}

describe("Pixi composition initialization", () => {
  beforeEach(() => { control.pending = null; control.options = null; control.glyphReady = false; control.glyphOnReady = null; control.glyphBlockCalls = 0; control.resizeObserver = null; control.created.length = 0; rewardSpy.mockClear(); schedulerControl.arms.mockClear(); schedulerControl.ports = null; fontLoader.load.mockReset(); fontLoader.load.mockResolvedValue(undefined); document.body.replaceChildren(); window.history.replaceState(null, "", "/?stage=pixi&pixiScene=retained"); Object.assign(rendererComparisonConfig, readRendererComparisonConfig()); measureStub(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); Object.assign(rendererComparisonConfig, readRendererComparisonConfig()); });

  async function createReadyHandRenderer() {
    window.history.replaceState(null, "", "/?rendererCompare=1&stage=rust");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    vi.stubGlobal("__benchDiagnosticClockMs", 1000);
    measureStub();
    const adapter = fakeAdapter(true);
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      undefined, { backend: "rust", createExecutor: async () => adapter as never });
    const state = handScene();
    renderer.setRaiseHandCards(true);
    expect(renderer.reconcile(state)).toBe(false);
    await vi.waitFor(() => expect(diagnostic().frameIdentity).toMatchObject({ revision: state.revision, clock: 1000 }));
    renderer.reconcile(state);
    return { renderer, state, adapter };
  }

  async function submitPendingHandArm() {
    const ready = await createReadyHandRenderer();
    const end = handEndpoint(100);
    update(ready.state, [holderSpec(0, "container", null, { volatile: true })],
      [positionHint(holderId(0), end, 300)], ready.state.orderedIds.slice());
    let release!: (result: { presented: boolean; reason?: string }) => void;
    const callsBefore = ready.adapter.admitScene.mock.calls.length;
    ready.adapter.admitScene.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }) as never);
    expect(ready.renderer.reconcile(ready.state)).toBe(false);
    await vi.waitFor(() => expect(ready.adapter.admitScene).toHaveBeenCalledTimes(callsBefore + 1));
    return { ...ready, release, end };
  }

  it("exposes Rust hand, landing, and opt-in spread probes without disposing a replacement's readers", () => {
    window.history.replaceState(null, "", "/?stage=canvas&spreadAudit=1");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    measureStub();
    const create = () => createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      undefined, { backend: "rust", createExecutor: async () => fakeAdapter(true) as never });
    const probes = window as unknown as {
      __mirrorHandPoses?: () => { stage: string; holders: unknown[] };
      __mirrorLandingLog?: () => { rows: unknown[] };
      __mirrorSpreadAudit?: () => { rows: unknown[] };
    };
    const oldRenderer = create();
    const handReader = probes.__mirrorHandPoses;
    const landingReader = probes.__mirrorLandingLog;
    const spreadReader = probes.__mirrorSpreadAudit;
    expect(handReader?.().stage).toBe("canvas");
    expect(landingReader?.().rows).toEqual([]);
    expect(spreadReader?.().rows).toEqual([]);

    const newRenderer = create();
    try {
      expect(probes.__mirrorHandPoses).not.toBe(handReader);
      expect(probes.__mirrorLandingLog).not.toBe(landingReader);
      expect(probes.__mirrorSpreadAudit).not.toBe(spreadReader);
      oldRenderer.dispose();
      expect(probes.__mirrorHandPoses?.().stage).toBe("canvas");
      expect(probes.__mirrorLandingLog?.().rows).toEqual([]);
      expect(probes.__mirrorSpreadAudit?.().rows).toEqual([]);
    } finally {
      newRenderer.dispose();
      oldRenderer.dispose();
    }
    expect(probes.__mirrorHandPoses).toBeUndefined();
    expect(probes.__mirrorLandingLog).toBeUndefined();
    expect(probes.__mirrorSpreadAudit).toBeUndefined();
  });

  it("reports async publication without letting an observer throw into rendering", async () => {
    window.history.replaceState(null, "", "/?rendererCompare=1&stage=rust");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    measureStub();
    const events: WarmAckTraceEvent[] = [];
    vi.stubGlobal("__benchWarmAckTrace", (event: WarmAckTraceEvent) => {
      events.push(event);
      throw new Error("observer failed");
    });
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      undefined, { backend: "rust", createExecutor: async () => fakeAdapter(true) as never });
    try {
      await vi.waitFor(() => expect(control.created).toHaveLength(1));
      const state = animatedColorScene(); state.revision = 31;
      expect(renderer.reconcile(state)).toBe(false);
      await vi.waitFor(() => expect(diagnostic().frameIdentity).toMatchObject({ revision: 31 }));
      expect(events.some(event => event.kind === "renderer-awaiting-ack" && event.revision === 31)).toBe(true);
      expect(events.some(event => event.kind === "renderer-published" && event.revision === 31)).toBe(true);
      expect(events.some(event => event.kind === "renderer-async-published" && event.revision === 31)).toBe(true);
    } finally { renderer.dispose(); }
  });

  it("keeps the landing log passive while a full presentation is pending, then publishes its frozen candidate with matching hits", async () => {
    const { renderer, state, adapter, release, end } = await submitPendingHandArm();
    try {
      expect(renderer.landingLog()).toMatchObject({ openCount: 0, rows: [] });
      release({ presented: true });
      await vi.waitFor(() => expect(diagnostic().frameIdentity).toMatchObject({ revision: state.revision, clock: 1000 }));
      renderer.reconcile(state);
      expect(renderer.landingLog()).toMatchObject({ openCount: 1, rows: [] });

      // Pass the tween end while the producer still has not spoken. This commits another frame but must leave
      // the open landing alone; the next candidate carries the changed streamed pose that can settle it.
      await clockAt(1400);
      expect(renderer.landingLog()).toMatchObject({ openCount: 1, rows: [] });
      const expectedLift = renderer.handPoses().holders.find((row) => row.id === holderId(0))!.raiseDy;
      expect(Math.abs(expectedLift)).toBeGreaterThan(0);

      update(state, [holderSpec(0, "container", end, { volatile: true })], undefined, state.orderedIds.slice());
      let settle!: (result: { presented: boolean; reason?: string }) => void;
      const callsBefore = adapter.admitScene.mock.calls.length;
      adapter.admitScene.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }) as never);
      expect(renderer.reconcile(state)).toBe(false);
      await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalledTimes(callsBefore + 1));

      const pendingA = renderer.landingLog();
      const pendingB = renderer.landingLog();
      expect(pendingA).toMatchObject({ openCount: 1, rows: [] });
      expect(pendingB).toEqual(pendingA);
      // Change the live raise mode after this picture was built. The pending picture still owns its lift and hit
      // sidecar; the report itself must not run settlement against either the mutable scene or interaction state.
      renderer.setRaiseHandCards(false);
      expect(renderer.landingLog()).toEqual(pendingA);

      settle({ presented: true });
      await vi.waitFor(() => expect(diagnostic().frameIdentity).toMatchObject({
        revision: state.revision, clock: 1400
      }));
      const report = renderer.landingLog();
      expect(report.openCount).toBe(0);
      expect(report.rows).toHaveLength(1);
      const row = report.rows[0]!;
      expect(row.closedBy).toBe("settle");
      expect(row.settleAt).toBe(1400);
      expect(row.raiseDyAtSettle).toBe(expectedLift);
      expect(row.settledGame).toEqual([1, 0, 0, 1, 1060, end[5] + 1080]);

      const committedPose = renderer.handPoses().holders.find((holder) => holder.id === holderId(0))!;
      expect(committedPose.raiseDy).toBe(expectedLift);
      expect(row.settledDrawnRaw).toEqual(committedPose.mDrawn);
      expect(row.settledDrawn).toEqual([
        committedPose.mDrawn[0], committedPose.mDrawn[1], committedPose.mDrawn[2], committedPose.mDrawn[3],
        committedPose.mDrawn[4], committedPose.mDrawn[5] - expectedLift
      ]);
      expect(renderer.handRaiseDebug()).toMatchObject({ enabled: true });
      const stamp = renderer.raiseInputStamps().find((entry) => entry.ownerId === holderId(0));
      expect(stamp?.dy).toBe(expectedLift);
      const hit = renderer.interactiveRects().find((entry) => entry.id === `${holderId(0)}-hitbox`);
      expect(hit?.raiseDy).toBe(expectedLift);
    } finally { renderer.dispose(); }
  });

  it.each(["refused", "superseded", "disposed", "rewrite"] as const)(
    "does not close a landing from a pending full build that is %s",
    async (ending) => {
      const { renderer, state, adapter, release } = await submitPendingHandArm();
      try {
        if (ending === "superseded") {
          update(state, [holderSpec(0, "container", handEndpoint(40), { volatile: true })]);
        } else if (ending === "rewrite") {
          // A keyframe replaces the tree while the arm's candidate is still in flight. The old arm must be cleared
          // with the old landing rows so a later frame cannot publish evidence from the discarded scene.
          applyKeyframe(state, 1);
          expect(renderer.reconcile(state)).toBe(false);
          expect(renderer.landingLog()).toMatchObject({ openCount: 0, rows: [] });
        } else if (ending === "disposed") {
          renderer.dispose();
        }

        release({ presented: ending !== "refused", reason: ending === "refused" ? "test refused" : undefined });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(renderer.landingLog()).toMatchObject({ openCount: 0, rows: [] });
      } finally {
        if (ending !== "disposed") renderer.dispose();
      }
    }
  );

  it("omits a label after its font fails without stopping the Rust stage", async () => {
    measureStub();
    const previousFonts = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", { configurable: true, value: { check: () => false } });
    let rejectFont!: (reason: Error) => void;
    fontLoader.load.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFont = reject; }));
    const statuses: string[] = [];
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      (phase) => statuses.push(phase), { backend: "rust", createExecutor: async () => fakeAdapter(true) as never });
    try {
      await vi.waitFor(() => expect(control.created).toHaveLength(1));
      expect(renderer.reconcile(textScene())).toBe(false);
      expect(fontLoader.load).toHaveBeenCalledOnce();
      expect(statuses).not.toContain("failed");
      rejectFont(new Error("font unavailable"));
      await vi.waitFor(() => expect(statuses).toContain("ready"));
      expect(statuses).not.toContain("failed");
      expect((control.created[0] as ReturnType<typeof fakeAdapter>).admitScene).toHaveBeenCalled();
      expect((window as unknown as { __mirrorRendererDiagnostics(): { omissions?: { nodes: Record<string, string> } } })
        .__mirrorRendererDiagnostics().omissions?.nodes).toMatchObject({ label: "font-load" });
    } finally {
      renderer.dispose();
      if (previousFonts) Object.defineProperty(document, "fonts", previousFonts);
      else Reflect.deleteProperty(document, "fonts");
    }
  });

  it("fails Rust initialization when its text measurement context is unavailable", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const statuses: string[] = [];
    const createExecutor = vi.fn(async () => fakeAdapter(true) as never);
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      (phase) => statuses.push(phase), { backend: "rust", createExecutor });
    try {
      await vi.waitFor(() => expect(statuses).toContain("failed"));
      expect(createExecutor).not.toHaveBeenCalled();
      expect((window as unknown as { __mirrorRendererDiagnostics(): { failure?: string } })
        .__mirrorRendererDiagnostics().failure).toContain("text measurement context unavailable");
    } finally { renderer.dispose(); }
  });

  it.each(["rustFast=0", "rustFast=1"])("keeps supported text and hits after a node refusal (%s)", async (query) => {
    window.history.replaceState(null, "", `/?stage=canvas&${query}`);
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    measureStub();
    const state = textScene();
    const supported = state.nodes.get("label")!;
    supported.mouseFilter = 0;
    const unsupported = { ...supported, id: "unsupported", name: "Unsupported", font: null };
    state.nodes.set(unsupported.id, unsupported);
    state.orderedIds.push(unsupported.id);
    state.changedIds.add(unsupported.id);
    const statuses: string[] = [];
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      (phase) => statuses.push(phase), { backend: "rust", createExecutor: async () => fakeAdapter(true) as never });
    try {
      await vi.waitFor(() => expect(control.created).toHaveLength(1));
      expect(renderer.reconcile(state)).toBe(false);
      await vi.waitFor(() => expect(statuses).toContain("ready"));
      const adapter = control.created[0] as ReturnType<typeof fakeAdapter>;
      const submitted = adapter.admitScene.mock.calls.at(-1)?.[1] as readonly TestPixiText[];
      expect(submitted.some((record) => record.labelId === "label")).toBe(true);
      expect(submitted.some((record) => record.labelId === "unsupported")).toBe(false);
      expect(statuses).not.toContain("failed");
      expect(renderer.interactiveRects().some((rect) => rect.id === "label")).toBe(true);
      expect((window as unknown as { __mirrorRendererDiagnostics(): { ready: boolean;
        omissions?: { nodes: Record<string, string> } } }).__mirrorRendererDiagnostics())
        .toMatchObject({ ready: true, omissions: { nodes: { unsupported: "no-font" } } });
    } finally { renderer.dispose(); }
  });

  it.each(["rustFast=0", "rustFast=1"])("presents rich event options with their icon and hit target (%s)", async (query) => {
    window.history.replaceState(null, "", `/?stage=canvas&${query}`);
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    measureStub();
    const state = textScene();
    state.nodes.get("root")!.sceneFilePath = "res://scenes/ui/event_option_button.tscn";
    const label = state.nodes.get("label")!;
    label.richText = true;
    label.nodeType = "RichTextLabel";
    label.mouseFilter = 0;
    label.richBoldFont = { family: "BoldFace", url: "/bold.ttf", weight: null, style: null };
    label.richBoldFontSpacingPx = 1;
    label.text = { ...label.text!, text: "[gold][b]Spiked Gauntlets[/b][/gold]\nGain [img]res://icons/energy.png[/img] now" };
    const adapter = fakeAdapter(true);
    adapter.textureSize.mockImplementation((url: string) => url.includes("energy.png") ? { width: 24, height: 24 } : null);
    const statuses: string[] = [];
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      (phase) => statuses.push(phase), { backend: "rust", createExecutor: async () => adapter as never });
    try {
      await vi.waitFor(() => expect(control.created).toHaveLength(1));
      expect(renderer.reconcile(state)).toBe(false);
      await vi.waitFor(() => expect(statuses).toContain("ready"));
      const records = adapter.admitScene.mock.calls.at(-1)?.[1] as readonly TestPixiText[];
      expect(records.some((record) => record.key.startsWith("label:") &&
        (record as unknown as { style: { fontFamily: string } }).style.fontFamily === "BoldFace")).toBe(true);
      expect(records.some((record) => "inlineImage" in record)).toBe(true);
      expect(renderer.interactiveRects().some((rect) => rect.id === "label")).toBe(true);
      expect((window as unknown as { __mirrorRendererDiagnostics(): { omissions?: { nodes: Record<string, string> } } })
        .__mirrorRendererDiagnostics().omissions?.nodes?.label).toBeUndefined();
    } finally { renderer.dispose(); }
  });

  it("reports a failed bold face while drawing the event words in the normal face", async () => {
    window.history.replaceState(null, "", "/?stage=canvas");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    measureStub();
    const previousFonts = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", { configurable: true, value: {
      check: (font: string) => !font.includes("BoldFace") } });
    fontLoader.load.mockRejectedValueOnce(new Error("bold font unavailable"));
    const state = textScene();
    const label = state.nodes.get("label")!;
    label.richText = true;
    label.richBoldFont = { family: "BoldFace", url: "/bold.ttf", weight: null, style: null };
    label.text = { ...label.text!, text: "[b]Event choice[/b]" };
    const adapter = fakeAdapter(true);
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      undefined, { backend: "rust", createExecutor: async () => adapter as never });
    try {
      await vi.waitFor(() => expect(control.created).toHaveLength(1));
      expect(renderer.reconcile(state)).toBe(false);
      await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalled());
      const records = adapter.admitScene.mock.calls.at(-1)?.[1] as readonly TestPixiText[];
      expect(records.some((record) => (record as unknown as { style: { fontFamily: string } }).style.fontFamily ===
        "TestFont")).toBe(true);
      expect((window as unknown as { __mirrorRendererDiagnostics(): { degradations?: Record<string, string> } })
        .__mirrorRendererDiagnostics().degradations).toMatchObject({ label: "font-role-fallback:bold" });
    } finally {
      renderer.dispose();
      if (previousFonts) Object.defineProperty(document, "fonts", previousFonts);
      else Reflect.deleteProperty(document, "fonts");
    }
  });

  it("reproduces a pending newer revision that publishes without an ack pull", async () => {
    window.history.replaceState(null, "", "/?rendererCompare=1&stage=rust&pixiScene=retained");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    measureStub();
    const events: WarmAckTraceEvent[] = [];
    vi.stubGlobal("__benchWarmAckTrace", (event: WarmAckTraceEvent) => events.push(event));
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      undefined, { backend: "rust", createExecutor: async () => fakeAdapter(true) as never });
    const pull = vi.fn();
    renderer.setReconcilePull?.({ pending: () => false, now: pull });
    try {
      await vi.waitFor(() => expect(control.created).toHaveLength(1));
      const adapter = control.created[0] as ReturnType<typeof fakeAdapter>;
      let release!: (result: { presented: boolean }) => void;
      adapter.admitScene.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }) as never);
      const older = animatedColorScene(); older.revision = 30;
      expect(renderer.reconcile(older)).toBe(false);
      await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalledOnce());

      const newer = animatedColorScene(); newer.revision = 31;
      expect(renderer.reconcile(newer)).toBe(false);
      const stalled = (window as unknown as { __mirrorRendererDiagnostics(): {
        asyncSubmissionRevision: number | null; asyncAwaitingAckRevision: number | null } }).__mirrorRendererDiagnostics();
      expect(stalled.asyncSubmissionRevision).toBe(30);
      expect(stalled.asyncAwaitingAckRevision).not.toBe(31);
      expect(events.some(event => event.kind === "renderer-awaiting-ack" && event.revision === 31)).toBe(false);

      release({ presented: true });
      expect(await clockAt(3036)).toMatchObject({ revision: 31, clock: 3036 });
      expect(events.some(event => event.kind === "renderer-async-published" && event.revision === 31)).toBe(true);
      expect(events.some(event => event.kind === "renderer-pull" && event.revision === 31)).toBe(false);
      expect(pull).not.toHaveBeenCalled();
    } finally { renderer.dispose(); }
  });

  it("retries the pending Rust view after a newer async publication only when opted in", async () => {
    window.history.replaceState(null, "", "/?rendererCompare=1&stage=rust&rustPendingAckRetry=1");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    measureStub();
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      undefined, { backend: "rust", createExecutor: async () => fakeAdapter(true) as never });
    const newer = animatedColorScene(); newer.revision = 31;
    const ack = vi.fn();
    const now = vi.fn(() => {
      if (renderer.reconcile(newer) === false) return "pending" as const;
      ack();
      return "presented" as const;
    });
    renderer.setReconcilePull?.({ pending: () => false, now, retryNow: now });
    try {
      await vi.waitFor(() => expect(control.created).toHaveLength(1));
      const adapter = control.created[0] as ReturnType<typeof fakeAdapter>;
      let release!: (result: { presented: boolean }) => void;
      adapter.admitScene.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }) as never);
      const older = animatedColorScene(); older.revision = 30;
      expect(renderer.reconcile(older)).toBe(false);
      await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalledOnce());
      expect(renderer.reconcile(newer)).toBe(false);
      release({ presented: true });
      await clockAt(3036);
      expect(now).toHaveBeenCalledOnce();
      expect(ack).toHaveBeenCalledOnce();
    } finally { renderer.dispose(); }
  });

  it("re-enters the real view and sends the real client scene ack after publication", async () => {
    window.history.replaceState(null, "", "/?rendererCompare=1&stage=rust&rustPendingAckRetry=1");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    measureStub();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    class TestSocket extends EventTarget {
      static OPEN = 1;
      static instance: TestSocket;
      readyState = 1;
      sent: Array<{ type: string }> = [];
      constructor(_url: string) { super(); TestSocket.instance = this; queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      send(data: string) { this.sent.push(JSON.parse(data) as { type: string }); }
      close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
      emit(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })); }
      acks() { return this.sent.filter(message => message.type === "scene-ack").length; }
    }
    const client = connectMirrorClient({ watch: true, WebSocketCtor: TestSocket as unknown as typeof WebSocket,
      location: { href: "http://localhost/", protocol: "http:" } });
    const socket = TestSocket.instance;
    socket.emit({ type: "scene-delta", full: true, screenType: "run", screenInstanceId: "screen:test",
      upserts: [{ id: "root", name: "Root", nodeType: "Control", visible: true }], removedIds: [], orderedIds: ["root"] });
    const adapter = fakeAdapter(true);
    let release!: (result: { presented: boolean }) => void;
    adapter.admitScene.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }) as never);
    vi.spyOn(rendererFactory, "createMirrorRendererFor").mockImplementation((host, defs, canvasHost) =>
      createPixiMirrorRenderer(host, defs, canvasHost, undefined,
        { backend: "rust", createExecutor: async () => adapter as never }));
    const trace: WarmAckTraceEvent[] = [];
    vi.stubGlobal("__benchWarmAckTrace", (event: WarmAckTraceEvent) => trace.push(event));
    const wrapper = mount(MirrorView, { props: { state: client.state, revision: client.state.revision,
      onSceneRendered: () => client.sendSceneAck() } });
    try {
      await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalledOnce());
      socket.emit({ type: "scene-delta", full: false, screenType: "run", screenInstanceId: "screen:test",
        upserts: [{ id: "root", name: "Root", nodeType: "Control", visible: true }], removedIds: [], orderedIds: ["root"] });
      const deliveredRevision = client.state.revision;
      await wrapper.setProps({ revision: deliveredRevision });
      await vi.waitFor(() => expect(trace.some(event => event.kind === "view-reconcile-result" && event.revision === deliveredRevision &&
        event.result === "pending")).toBe(true));
      expect(socket.acks()).toBe(0);
      release({ presented: true });
      await clockAt(3036);
      await vi.waitFor(() => expect(socket.acks()).toBe(1));
      expect(trace.some(event => event.kind === "view-on-scene-rendered" && event.revision === deliveredRevision &&
        event.result === "before")).toBe(true);
      expect(trace.some(event => event.kind === "ack-sent" && event.revision === deliveredRevision)).toBe(true);
    } finally { wrapper.unmount(); client.close(); }
  });

  it("does not retry a superseded or disposed Rust view obligation", async () => {
    window.history.replaceState(null, "", "/?rendererCompare=1&stage=rust&rustPendingAckRetry=1");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    measureStub();
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      undefined, { backend: "rust", createExecutor: async () => fakeAdapter(true) as never });
    const newer = animatedColorScene(); newer.revision = 31;
    const latest = animatedColorScene(); latest.revision = 32;
    const pulled: number[] = [];
    const retryLatest = () => {
      pulled.push(latest.revision);
      return renderer.reconcile(latest) === false ? "pending" : "presented";
    };
    renderer.setReconcilePull?.({ pending: () => false, now: retryLatest, retryNow: retryLatest });
    try {
      await vi.waitFor(() => expect(control.created).toHaveLength(1));
      const adapter = control.created[0] as ReturnType<typeof fakeAdapter>;
      let release!: (result: { presented: boolean }) => void;
      adapter.admitScene.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }) as never);
      const older = animatedColorScene(); older.revision = 30;
      expect(renderer.reconcile(older)).toBe(false);
      await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalledOnce());
      expect(renderer.reconcile(newer)).toBe(false);
      expect(renderer.reconcile(latest)).toBe(false);
      release({ presented: true });
      await clockAt(3036);
      expect(pulled).toEqual([32]);
      renderer.dispose();
      await Promise.resolve();
      expect(pulled).toEqual([32]);
    } finally { renderer.dispose(); }
  });

  it("drops an old view obligation on dispose while a remount owns its own ack", async () => {
    window.history.replaceState(null, "", "/?rendererCompare=1&stage=rust&rustPendingAckRetry=1");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    measureStub();
    const oldAdapter = fakeAdapter(true);
    let releaseOld!: (result: { presented: boolean }) => void;
    oldAdapter.admitScene.mockImplementationOnce(() => new Promise((resolve) => { releaseOld = resolve; }) as never);
    const oldRenderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      undefined, { backend: "rust", createExecutor: async () => oldAdapter as never });
    const oldPull = vi.fn(() => "presented" as const);
    oldRenderer.setReconcilePull?.({ pending: () => false, now: oldPull, retryNow: oldPull });
    const oldState = animatedColorScene(); oldState.revision = 30;
    const nextState = animatedColorScene(); nextState.revision = 31;
    try {
      expect(oldRenderer.reconcile(oldState)).toBe(false);
      await vi.waitFor(() => expect(oldAdapter.admitScene).toHaveBeenCalledOnce());
      expect(oldRenderer.reconcile(nextState)).toBe(false);
      oldRenderer.dispose();
      releaseOld({ presented: true });
      await Promise.resolve();
      expect(oldPull).not.toHaveBeenCalled();

      const freshAdapter = fakeAdapter(true);
      const freshRenderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
        undefined, { backend: "rust", createExecutor: async () => freshAdapter as never });
      const freshAck = vi.fn();
      const retryFresh = () => {
        if (freshRenderer.reconcile(nextState) === false) return "pending";
        freshAck();
        return "presented";
      };
      freshRenderer.setReconcilePull?.({ pending: () => false, now: retryFresh, retryNow: retryFresh });
      try {
        expect(freshRenderer.reconcile(nextState)).toBe(false);
        await vi.waitFor(() => expect(freshAck).toHaveBeenCalledOnce());
        expect(oldPull).not.toHaveBeenCalled();
      } finally { freshRenderer.dispose(); }
    } finally { oldRenderer.dispose(); }
  });

  it("defers a reentrant Rust pull once without acknowledging twice", async () => {
    window.history.replaceState(null, "", "/?rendererCompare=1&stage=rust&rustPendingAckRetry=1");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    measureStub();
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      undefined, { backend: "rust", createExecutor: async () => fakeAdapter(true) as never });
    const newer = animatedColorScene(); newer.revision = 31;
    const ack = vi.fn();
    let first = true;
    const now = vi.fn(() => {
      if (first) { first = false; return "reentrant" as const; }
      if (renderer.reconcile(newer) === false) return "pending" as const;
      ack();
      return "presented" as const;
    });
    renderer.setReconcilePull?.({ pending: () => false, now, retryNow: now });
    try {
      await vi.waitFor(() => expect(control.created).toHaveLength(1));
      const adapter = control.created[0] as ReturnType<typeof fakeAdapter>;
      let release!: (result: { presented: boolean }) => void;
      adapter.admitScene.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }) as never);
      const older = animatedColorScene(); older.revision = 30;
      expect(renderer.reconcile(older)).toBe(false);
      await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalledOnce());
      expect(renderer.reconcile(newer)).toBe(false);
      release({ presented: true });
      await clockAt(3036);
      await vi.waitFor(() => expect(ack).toHaveBeenCalledOnce());
      expect(now).toHaveBeenCalledTimes(2);
    } finally { renderer.dispose(); }
  });

  it("emits opt-in Rust startup events from real renderer transitions", async () => {
    window.history.replaceState(null, "", "/?rendererCompare=1&stage=rust");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    measureStub();
    const events: Array<{ name: string; detail: Record<string, unknown> }> = [];
    vi.stubGlobal("__benchBusyStartupEvent", (name: string, detail: Record<string, unknown>) => {
      events.push({ name, detail });
    });
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      undefined, { backend: "rust", createExecutor: async () => fakeAdapter(true) as never });
    try {
      const state = animatedColorScene();
      expect(renderer.reconcile(state)).toBe(false);
      await vi.waitFor(() => expect(events.some((event) => event.name === "renderer.firstReady")).toBe(true));
      const names = events.map((event) => event.name);
      for (const name of ["renderer.create", "renderer.initStart", "renderer.initComplete",
        "renderer.framePrepare", "renderer.frameSubmit", "renderer.frameComplete", "renderer.firstReady"])
        expect(names).toContain(name);
      expect(events.find((event) => event.name === "renderer.frameComplete")?.detail.revision).toBe(state.revision);
      expect(events.find((event) => event.name === "renderer.firstReady")?.detail.pending).toBe(0);
    } finally { renderer.dispose(); }
  });

  it("maps the successful backend presentation to its committed scene before completion", async () => {
    window.history.replaceState(null, "", "/?rendererCompare=1&stage=rust&pixiScene=retained");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    vi.stubGlobal("__benchDocumentNonce", "document-1");
    const calls: Array<{ kind: string; detail?: Record<string, unknown> }> = [];
    vi.stubGlobal("__benchStartupCommittedPresentation", (detail: Record<string, unknown>) =>
      calls.push({ kind: "commit", detail }));
    vi.stubGlobal("__benchStartupPresentationComplete", () => calls.push({ kind: "completion" }));
    const adapter = fakeAdapter(true);
    adapter.admitScene.mockImplementationOnce(async () => {
      adapter.stats.completedFrames = 7;
      adapter.stats.presentationValid = true;
      return { presented: true, reason: undefined, revision: 7, completedFrames: 7 };
    });
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      undefined, { backend: "rust", createExecutor: async () => adapter as never });
    try {
      const state = animatedColorScene(); state.revision = 172;
      expect(renderer.reconcile(state)).toBe(false);
      await vi.waitFor(() => expect(calls.some((call) => call.kind === "commit")).toBe(true));
      expect(calls[0]).toMatchObject({ kind: "commit", detail: {
        documentNonce: "document-1", sceneRevision: 172, backendRevision: 7,
        completedFrames: 7, presented: true, frameIdentity: { revision: 172 },
      } });
      expect(calls[1]?.kind).toBe("completion");
      expect(calls.filter((call) => call.kind === "commit" &&
        call.detail?.backendRevision === 7)).toHaveLength(1);
    } finally { renderer.dispose(); }
  });

  it("joins sparse Couch build and Pixi submission markers only when requested", async () => {
    window.history.replaceState(null, "", "/?stage=pixi&pixiScene=retained&ccTraceFrames=1");
    const stamps = vi.fn();
    vi.stubGlobal("console", Object.assign(Object.create(console), { timeStamp: stamps }));
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"));
    try {
      await vi.waitFor(() => expect(control.pending).not.toBeNull());
      const adapter = fakeAdapter(); control.pending!.resolve(adapter);
      renderer.reconcile(createMirrorState());
      await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalled());
      const labels = stamps.mock.calls.map(([label]) => label);
      const buildStart = labels.find((label) => /cc:frame:\d+\.1:couch:build:start/.test(label));
      expect(buildStart).toBeDefined();
      const id = buildStart!.split(":")[2];
      expect(labels).toContain(`cc:frame:${id}:couch:build:end`);
      expect(labels).toContain(`cc:frame:${id}:couch:submit:start`);
      expect(labels).toContain(`cc:frame:${id}:couch:submit:end`);
      expect(adapter.setTraceFrameId).toHaveBeenNthCalledWith(1, id);
      expect(adapter.setTraceFrameId).toHaveBeenNthCalledWith(2, null);
    } finally { renderer.dispose(); }
  });

  it("admits the first scene when Pixi initialization finishes before any reconcile", async () => {
    const statuses: string[] = [];
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      (phase) => statuses.push(phase));
    await vi.waitFor(() => expect(control.pending).not.toBeNull());
    const adapter = fakeAdapter(); control.pending!.resolve(adapter);
    await vi.waitFor(() => expect(statuses).toContain("initializing"));
    expect(adapter.admitScene).not.toHaveBeenCalled();
    expect(renderer.reconcile(createMirrorState())).toBeUndefined();
    expect(adapter.admitScene).toHaveBeenCalledOnce();
    expect(adapter.setTraceFrameId).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toBe("ready");
    renderer.dispose();
  });

  it("reports an asynchronous Pixi failure without claiming an active preset", async () => {
    __setStageBackendForTest("pixi");
    const renderer = createMirrorRendererFor(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"))!;
    expect(rendererRuntimeStatus.phase).toBe("initializing");
    await vi.waitFor(() => expect(control.pending).not.toBeNull());
    control.pending!.reject(new Error("no WebGL"));
    await vi.waitFor(() => expect(rendererRuntimeStatus.phase).toBe("failed"));
    expect(rendererRuntimeStatus.actualBackend).toBe("pixi");
    expect(rendererRuntimeStatus.actualConfig).toBeNull();
    expect(rendererRuntimeStatus.reason).toBe("no WebGL");
    renderer.dispose();
    __setStageBackendForTest("dom");
  });

  it("holds offers during initialization and admits only the latest state", async () => {
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"));
    const first = createMirrorState(); first.revision = 1;
    const latest = createMirrorState(); latest.revision = 2;
    expect(renderer.reconcile(first)).toBe(false);
    expect(renderer.reconcile(latest)).toBe(false);
    await vi.waitFor(() => expect(control.pending).not.toBeNull());
    const adapter = fakeAdapter(); control.pending!.resolve(adapter);
    await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalled());
    expect((window as unknown as { __mirrorRendererDiagnostics(): { admittedRevision?: number } }).__mirrorRendererDiagnostics().admittedRevision).toBe(2);
    renderer.dispose();
  });

  it("keeps production-clock animation running after asynchronous first admission", async () => {
    measureStub();
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"));
    try {
      expect(renderer.reconcile(textScene(true))).toBe(false);
      await vi.waitFor(() => expect(control.pending).not.toBeNull());
      const adapter = fakeAdapter(); control.pending!.resolve(adapter);
      await vi.waitFor(() => expect(adapter.stats.completedFrames).toBeGreaterThan(0));
      const initial = diagnostic();
      await vi.waitFor(() => expect(adapter.stats.completedFrames).toBeGreaterThanOrEqual(initial.draw.completedFrames + 3));
      const after = diagnostic();
      expect(after.effective.buildEpoch).toBe(initial.effective.buildEpoch);
      expect(after.draw.nativeLayouts).toBe(initial.draw.nativeLayouts);
      const poses = adapter.patchScene.mock.calls.flatMap(([patch]) => {
        const value = patch as { groups?: Array<{ transform?: number[] }>; primitives?: Array<{ transform?: number[] }> };
        return [...value.groups ?? [], ...value.primitives ?? []].filter((item) => item.transform).map((item) => JSON.stringify(item.transform));
      });
      expect(new Set(poses).size).toBeGreaterThan(1);
    } finally { renderer.dispose(); }
  });

  it("samples a Rust pinned idle animation from retained commands without another producer build", async () => {
    window.history.replaceState(null, "", "/?rendererCompare=1&stage=rust&rustDiagnostics=1");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    measureStub();
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      undefined, { backend: "rust", createExecutor: async () => fakeAdapter(true) as never });
    try {
      vi.stubGlobal("__benchDiagnosticClockMs", 1000);
      const state = animatedColorScene();
      expect(renderer.reconcile(state)).toBe(false);
      await vi.waitFor(() => expect((control.created[0]?.stats as { completedFrames: number } | undefined)?.completedFrames).toBeGreaterThan(0));
      expect(renderer.reconcile(state)).toBeUndefined();
      await vi.waitFor(() => expect(diagnostic().draw.completedFrames).toBeGreaterThanOrEqual(4));
      const initial = diagnostic();
      expect(initial.draw.localAnimationCount).toBeGreaterThan(0);
      expect(initial.draw.frameSampleMask).toBe(16);
      await clockAt(1050);
      await vi.waitFor(() => expect(diagnostic().draw.retainedAsyncPublished).toBeGreaterThan(0));
      const after = diagnostic();
      expect(after.draw.producerBuilds).toBe(initial.draw.producerBuilds);
      expect(after.draw.retainedPlanCount).toBeGreaterThan(initial.draw.retainedPlanCount);
      expect((control.created[0]!.patchScene as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    } finally { renderer.dispose(); vi.unstubAllGlobals(); }
  });

  it("falls back to full Rust admission when retained patch planning requires it", async () => {
    window.history.replaceState(null, "", "/?rendererCompare=1&stage=rust&rustDiagnostics=1");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    vi.stubGlobal("__benchDiagnosticClockMs", 1000);
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      undefined, { backend: "rust", createExecutor: async () => fakeAdapter(true) as never });
    try {
      const state = animatedColorScene(); state.revision = 21;
      expect(renderer.reconcile(state)).toBe(false);
      await vi.waitFor(() => expect(control.created).toHaveLength(1));
      const adapter = control.created[0] as ReturnType<typeof fakeAdapter>;
      await vi.waitFor(() => expect(adapter.stats.completedFrames).toBeGreaterThan(0));
      expect(renderer.reconcile(state)).toBeUndefined();
      const buildsBeforeFallback = diagnostic().draw.producerBuilds;
      const admissionsBeforeFallback = adapter.admitScene.mock.calls.length;
      adapter.patchScene.mockImplementationOnce(() => Promise.resolve({ presented: false,
        reason: "retained patch requires full scene admission" }) as never);

      await clockAt(1050);

      expect(adapter.patchScene).toHaveBeenCalledOnce();
      expect(adapter.admitScene.mock.calls.length).toBe(admissionsBeforeFallback + 1);
      expect(diagnostic().draw.producerBuilds).toBe(buildsBeforeFallback + 1);
      expect(diagnostic().frameIdentity).toMatchObject({ revision: 21, clock: 1050 });
      expect((window as unknown as { __mirrorRendererDiagnostics(): { readiness: string; failure?: string } })
        .__mirrorRendererDiagnostics()).toMatchObject({ readiness: "ready" });
      expect((window as unknown as { __mirrorRendererDiagnostics(): { failure?: string } })
        .__mirrorRendererDiagnostics().failure).toBeUndefined();
    } finally { renderer.dispose(); vi.unstubAllGlobals(); }
  });

  it("waits for an older Rust presentation before submitting the requested diagnostic clock", async () => {
    window.history.replaceState(null, "", "/?rendererCompare=1&stage=rust&rustDiagnostics=1");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    const committedScenes: number[] = [];
    vi.stubGlobal("__benchStartupCommittedPresentation", (detail: { sceneRevision: number }) =>
      committedScenes.push(detail.sceneRevision));
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      undefined, { backend: "rust", createExecutor: async () => fakeAdapter(true) as never });
    try {
      await vi.waitFor(() => expect(control.created).toHaveLength(1));
      const adapter = control.created[0] as ReturnType<typeof fakeAdapter>;
      let release!: (result: { presented: boolean }) => void;
      const firstPresentation = new Promise<{ presented: boolean }>((resolve) => { release = resolve; });
      adapter.admitScene.mockImplementationOnce(() => firstPresentation as never);
      const state = animatedColorScene(); state.revision = 9;
      expect(renderer.reconcile(state)).toBe(false);
      await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalledOnce());
      let clockSettled = false;
      const clock = clockAt(500).then(() => { clockSettled = true; });
      await Promise.resolve();
      expect(clockSettled).toBe(false);
      expect(adapter.admitScene).toHaveBeenCalledOnce();
      const newer = animatedColorScene(); newer.revision = 10;
      expect(renderer.reconcile(newer)).toBe(false);
      release({ presented: true });
      await clock;
      expect(adapter.admitScene).toHaveBeenCalledTimes(2);
      expect(diagnostic().frameIdentity).toMatchObject({ revision: 10, clock: 500 });
      expect(committedScenes).not.toContain(9);
    } finally { renderer.dispose(); }
  });

  it("wakes a Rust diagnostic clock from late texture completion instead of an animation-frame retry limit", async () => {
    window.history.replaceState(null, "", "/?rendererCompare=1&stage=rust&rustDiagnostics=1");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    let onInvalidate!: (reason: "resource" | "present") => void;
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      undefined, { backend: "rust", createExecutor: async (options) => {
        onInvalidate = options.onInvalidate;
        return fakeAdapter(true) as never;
      } });
    try {
      await vi.waitFor(() => expect(control.created).toHaveLength(1));
      const adapter = control.created[0] as ReturnType<typeof fakeAdapter>;
      const first = animatedColorScene(); first.revision = 40;
      expect(renderer.reconcile(first)).toBe(false);
      await vi.waitFor(() => expect(diagnostic().frameIdentity).toMatchObject({ revision: 40 }));
      const admit = adapter.admitScene.getMockImplementation()!;
      let textureReady = false;
      adapter.admitScene.mockImplementation((...args) => textureReady
        ? admit(...args) : Promise.resolve({ presented: false, reason: "texture pending" }) as never);
      const next = animatedColorScene(); next.revision = 41; next.sceneRewrite = true;
      expect(renderer.reconcile(next)).toBe(false);
      await vi.waitFor(() => expect(diagnostic().asyncSubmissionRevision).toBeNull());
      const clock = clockAt(500);
      await vi.waitFor(() => expect(adapter.admitScene.mock.calls.length).toBeGreaterThanOrEqual(3));
      const admissionsWithoutWake = adapter.admitScene.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 180));
      expect(diagnostic().frameIdentity).toMatchObject({ revision: 40 });
      expect(adapter.admitScene).toHaveBeenCalledTimes(admissionsWithoutWake);
      textureReady = true;
      onInvalidate("resource");
      onInvalidate("resource");
      expect(await clock).toMatchObject({ revision: 41, clock: 500 });
      expect(diagnostic().frameIdentity).toMatchObject({ revision: 41, clock: 500 });
      expect(adapter.admitScene.mock.calls.length - admissionsWithoutWake).toBeLessThanOrEqual(2);
    } finally { renderer.dispose(); }
  });

  it("does not miss a Rust resource wake that occurs during admission", async () => {
    window.history.replaceState(null, "", "/?rendererCompare=1&stage=rust&rustDiagnostics=1");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    let onInvalidate!: (reason: "resource" | "present") => void;
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      undefined, { backend: "rust", createExecutor: async (options) => {
        onInvalidate = options.onInvalidate;
        return fakeAdapter(true) as never;
      } });
    try {
      await vi.waitFor(() => expect(control.created).toHaveLength(1));
      const adapter = control.created[0] as ReturnType<typeof fakeAdapter>;
      const first = animatedColorScene(); first.revision = 42;
      expect(renderer.reconcile(first)).toBe(false);
      await vi.waitFor(() => expect(diagnostic().frameIdentity).toMatchObject({ revision: 42 }));
      const admit = adapter.admitScene.getMockImplementation()!;
      const next = animatedColorScene(); next.revision = 43; next.sceneRewrite = true;
      adapter.admitScene.mockImplementationOnce(() => Promise.resolve({ presented: false, reason: "texture pending" }) as never);
      expect(renderer.reconcile(next)).toBe(false);
      await vi.waitFor(() => expect(diagnostic().asyncSubmissionRevision).toBeNull());
      adapter.admitScene.mockImplementationOnce((...args) => {
        onInvalidate("resource");
        return Promise.resolve({ presented: false, reason: "texture pending" }) as never;
      });
      adapter.admitScene.mockImplementation(admit);
      expect(await clockAt(600)).toMatchObject({ revision: 43, clock: 600 });
    } finally { renderer.dispose(); }
  });

  it("ends a stalled Rust diagnostic clock on disposal without certifying an older picture", async () => {
    window.history.replaceState(null, "", "/?rendererCompare=1&stage=rust&rustDiagnostics=1");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      undefined, { backend: "rust", createExecutor: async () => fakeAdapter(true) as never });
    await vi.waitFor(() => expect(control.created).toHaveLength(1));
    const adapter = control.created[0] as ReturnType<typeof fakeAdapter>;
    const first = animatedColorScene(); first.revision = 44;
    expect(renderer.reconcile(first)).toBe(false);
    await vi.waitFor(() => expect(diagnostic().frameIdentity).toMatchObject({ revision: 44 }));
    adapter.admitScene.mockImplementation(() => Promise.resolve({ presented: false, reason: "texture pending" }) as never);
    const next = animatedColorScene(); next.revision = 45; next.sceneRewrite = true;
    expect(renderer.reconcile(next)).toBe(false);
    await vi.waitFor(() => expect(diagnostic().asyncSubmissionRevision).toBeNull());
    const clock = clockAt(700);
    renderer.dispose();
    await expect(clock).rejects.toThrow(/renderer disposed/);
  });

  it("applies one deadline even when a Rust presentation promise never settles", async () => {
    window.history.replaceState(null, "", "/?rendererCompare=1&stage=rust&rustDiagnostics=1");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      undefined, { backend: "rust", createExecutor: async () => fakeAdapter(true) as never });
    try {
      await vi.waitFor(() => expect(control.created).toHaveLength(1));
      const adapter = control.created[0] as ReturnType<typeof fakeAdapter>;
      const first = animatedColorScene(); first.revision = 46;
      expect(renderer.reconcile(first)).toBe(false);
      await vi.waitFor(() => expect(diagnostic().frameIdentity).toMatchObject({ revision: 46 }));
      adapter.admitScene.mockImplementationOnce(() => new Promise(() => {}) as never);
      const next = animatedColorScene(); next.revision = 47; next.sceneRewrite = true;
      expect(renderer.reconcile(next)).toBe(false);
      await vi.waitFor(() => expect(diagnostic().asyncSubmissionRevision).toBe(47));
      await expect(clockAt(800)).rejects.toThrow(/deadline exceeded.*revision 46/);
      expect(diagnostic().frameIdentity).toMatchObject({ revision: 46 });
    } finally { renderer.dispose(); }
  }, 8_000);

  it("supersedes a Rust diagnostic request and certifies only the newer requested clock", async () => {
    window.history.replaceState(null, "", "/?rendererCompare=1&stage=rust&rustDiagnostics=1");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    let onInvalidate!: (reason: "resource" | "present") => void;
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      undefined, { backend: "rust", createExecutor: async (options) => {
        onInvalidate = options.onInvalidate;
        return fakeAdapter(true) as never;
      } });
    try {
      await vi.waitFor(() => expect(control.created).toHaveLength(1));
      const adapter = control.created[0] as ReturnType<typeof fakeAdapter>;
      const first = animatedColorScene(); first.revision = 48;
      expect(renderer.reconcile(first)).toBe(false);
      await vi.waitFor(() => expect(diagnostic().frameIdentity).toMatchObject({ revision: 48 }));
      const admit = adapter.admitScene.getMockImplementation()!;
      let ready = false;
      adapter.admitScene.mockImplementation((...args) => ready
        ? admit(...args) : Promise.resolve({ presented: false, reason: "texture pending" }) as never);
      const next = animatedColorScene(); next.revision = 49; next.sceneRewrite = true;
      expect(renderer.reconcile(next)).toBe(false);
      await vi.waitFor(() => expect(diagnostic().asyncSubmissionRevision).toBeNull());
      const older = clockAt(900);
      const rejectedOlder = expect(older).rejects.toThrow(/superseded by a newer diagnostic clock/);
      const newer = clockAt(950);
      await rejectedOlder;
      ready = true;
      onInvalidate("resource");
      expect(await newer).toMatchObject({ revision: 49, clock: 950 });
      expect(diagnostic().frameIdentity).toMatchObject({ revision: 49, clock: 950 });
    } finally { renderer.dispose(); }
  });

  it("restores the requested clock when superseding a blocked request with the last committed clock", async () => {
    window.history.replaceState(null, "", "/?rendererCompare=1&stage=rust&rustDiagnostics=1");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    let onInvalidate!: (reason: "resource" | "present") => void;
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      undefined, { backend: "rust", createExecutor: async (options) => {
        onInvalidate = options.onInvalidate;
        return fakeAdapter(true) as never;
      } });
    try {
      await vi.waitFor(() => expect(control.created).toHaveLength(1));
      const adapter = control.created[0] as ReturnType<typeof fakeAdapter>;
      const state = animatedColorScene(); state.revision = 50;
      expect(renderer.reconcile(state)).toBe(false);
      await vi.waitFor(() => expect(diagnostic().frameIdentity).toMatchObject({ revision: 50 }));
      expect(await clockAt(100)).toMatchObject({ revision: 50, clock: 100 });
      const admit = adapter.admitScene.getMockImplementation()!;
      const patchesBefore = adapter.patchScene.mock.calls.length;
      let resourceReady = false;
      const pending = { presented: false, reason: "texture pending" };
      adapter.patchScene.mockImplementation(() => Promise.resolve(pending) as never);
      adapter.admitScene.mockImplementation((...args) => resourceReady
        ? admit(...args) : Promise.resolve(pending) as never);
      const older = clockAt(200);
      const rejectedOlder = expect(older).rejects.toThrow(/superseded by a newer diagnostic clock/);
      await vi.waitFor(() => expect(adapter.patchScene.mock.calls.length).toBeGreaterThan(patchesBefore));
      const restored = clockAt(100);
      await rejectedOlder;
      resourceReady = true;
      onInvalidate("resource");
      expect(await restored).toMatchObject({ revision: 50, clock: 100 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(diagnostic().frameIdentity).toMatchObject({ revision: 50, clock: 100 });
    } finally { renderer.dispose(); }
  });

  it("leaves diagnostic clock requests uncertified until Rust has a committed picture", async () => {
    window.history.replaceState(null, "", "/?rendererCompare=1&stage=rust&rustDiagnostics=1");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
      undefined, { backend: "rust", createExecutor: async () => fakeAdapter(true) as never });
    try {
      await vi.waitFor(() => expect(control.created).toHaveLength(1));
      const adapter = control.created[0] as ReturnType<typeof fakeAdapter>;
      adapter.admitScene.mockImplementationOnce(() => Promise.resolve(false) as never);
      adapter.admitScene.mockImplementationOnce(() => Promise.resolve(false) as never);
      const pending = createMirrorState(); pending.revision = 11;
      expect(renderer.reconcile(pending)).toBe(false);
      await vi.waitFor(() => expect((window as unknown as { __mirrorRendererDiagnostics(): { asyncSubmissionRevision: number | null } })
        .__mirrorRendererDiagnostics().asyncSubmissionRevision).toBeNull());
      expect(await clockAt(500)).toBeNull();
      expect(diagnostic().frameIdentity).toBeNull();

      const state = animatedColorScene(); state.revision = 12;
      expect(renderer.reconcile(state)).toBe(false);
      await vi.waitFor(() => expect(diagnostic().frameIdentity).toMatchObject({ revision: 12 }));
      expect(await clockAt(500)).toMatchObject({ revision: 12, clock: 500 });
    } finally { renderer.dispose(); }
  });

  it("stays unready across context loss until a post-restore scene presents", async () => {
    measureStub();
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"));
    try {
      expect(renderer.reconcile(textScene())).toBe(false);
      await vi.waitFor(() => expect(control.pending).not.toBeNull());
      const adapter = fakeAdapter(); control.pending!.resolve(adapter);
      await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalledOnce());
      expect((diagnostic() as ReturnType<typeof diagnostic> & { ready: boolean }).ready).toBe(true);
      const identity = diagnostic().frameIdentity;
      adapter.stats.contextReady = false; adapter.stats.presentationValid = false;
      (control.options!.onInvalidate as (reason?: string) => void)("resource");
      await vi.waitFor(() => expect(adapter.admitScene.mock.calls.length).toBeGreaterThanOrEqual(2));
      expect((diagnostic() as ReturnType<typeof diagnostic> & { ready: boolean }).ready).toBe(false);
      expect(diagnostic().frameIdentity).toEqual(identity);

      adapter.stats.contextReady = true; adapter.setAccept(false);
      (control.options!.onInvalidate as (reason?: string) => void)("resource");
      await vi.waitFor(() => expect(adapter.admitScene.mock.calls.length).toBeGreaterThanOrEqual(3));
      expect((diagnostic() as ReturnType<typeof diagnostic> & { ready: boolean }).ready).toBe(false);
      adapter.setAccept(true);
      (control.options!.onInvalidate as (reason?: string) => void)("resource");
      await vi.waitFor(() => expect((diagnostic() as ReturnType<typeof diagnostic> & { ready: boolean }).ready).toBe(true));
      expect(adapter.stats.completedFrames).toBeGreaterThan(1);
    } finally { renderer.dispose(); }
  });

  it("repaints a stationary scene once after a real resize and ignores unchanged observer calls", async () => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { control.resizeObserver = () => callback([], this as unknown as ResizeObserver); }
      observe() {} disconnect() {}
    });
    const host = stage(); let hostWidth = 1920;
    host.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: hostWidth, bottom: 1080,
      width: hostWidth, height: 1080, toJSON() {} });
    measureStub();
    const renderer = createPixiMirrorRenderer(host, document.createElementNS("http://www.w3.org/2000/svg", "defs"));
    try {
      expect(renderer.reconcile(textScene())).toBe(false);
      await vi.waitFor(() => expect(control.pending).not.toBeNull());
      const adapter = fakeAdapter(); control.pending!.resolve(adapter);
      await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalledOnce());
      const admissions = adapter.admitScene.mock.calls.length, resizes = adapter.resize.mock.calls.length;
      control.resizeObserver?.();
      expect(adapter.resize).toHaveBeenCalledTimes(resizes);
      expect(adapter.admitScene).toHaveBeenCalledTimes(admissions);

      hostWidth = 960; control.resizeObserver?.();
      expect(adapter.resize).toHaveBeenCalledTimes(resizes + 1);
      expect((diagnostic() as ReturnType<typeof diagnostic> & { ready: boolean }).ready).toBe(false);
      await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalledTimes(admissions + 1));
      expect((diagnostic() as ReturnType<typeof diagnostic> & { ready: boolean }).ready).toBe(true);
      control.resizeObserver?.();
      expect(adapter.resize).toHaveBeenCalledTimes(resizes + 1);
      expect(adapter.admitScene).toHaveBeenCalledTimes(admissions + 1);
      renderer.dispose();
      hostWidth = 720; control.resizeObserver?.();
      expect(adapter.resize).toHaveBeenCalledTimes(resizes + 1);
    } finally { renderer.dispose(); }
  });

  it("reports one native fallback label, then admits a glyph when the shared provider becomes ready", async () => {
    window.history.replaceState(null, "", "/?stage=pixi&pixiScene=retained&pixiText=slug");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    measureStub();
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"));
    try {
      expect(renderer.reconcile(textScene())).toBe(false);
      await vi.waitFor(() => expect(control.pending).not.toBeNull());
      expect(control.options?.textMode).toBe("slug");
      (control.options!.createGlyphProvider as (gl: unknown) => unknown)({});
      const adapter = fakeAdapter(); control.pending!.resolve(adapter);
      await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalledOnce());
      const fallback = adapter.admitScene.mock.calls[0][1];
      expect(fallback).toHaveLength(1);
      expect(fallback[0].nativeFallback).toHaveLength(1);
      expect(fallback[0].fallbackReason).toBe("glyph-not-ready");
      expect(rendererRuntimeStatus.pixiText).toMatchObject({ requested: "slug", actual: "native", native: 1,
        slug: 0, reasons: { "glyph-not-ready": 1 } });
      expect(diagnostic().glyphs).toMatchObject({ ready: false, refusedNotReady: 1 });
      const layouts = diagnostic().draw.nativeLayouts;

      control.glyphReady = true;
      control.glyphOnReady?.();
      await vi.waitFor(() => expect(adapter.admitScene.mock.calls.length).toBeGreaterThanOrEqual(2));
      const glyph = adapter.admitScene.mock.lastCall![1][0];
      expect(glyph.glyph?.block.slots).toEqual(new Int32Array([7, 8]));
      expect(glyph.glyph?.inkBounds).toEqual({ x: 0, y: 0, width: 20, height: 20 });
      expect(rendererRuntimeStatus.pixiText).toMatchObject({ requested: "slug", actual: "slug", native: 0, slug: 1, reasons: {} });
      expect(diagnostic().glyphs).toMatchObject({ ready: true, refusedNotReady: 1 });
      expect(diagnostic().draw.nativeLayouts).toBe(layouts);
    } finally { renderer.dispose(); }
  });

  it("keeps committed glyph outcomes and frame identity when a fallback re-admission fails", async () => {
    window.history.replaceState(null, "", "/?stage=pixi&pixiScene=retained&pixiText=slug-cached");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    measureStub(); control.glyphReady = true;
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"));
    try {
      expect(renderer.reconcile(textScene())).toBe(false);
      await vi.waitFor(() => expect(control.pending).not.toBeNull());
      (control.options!.createGlyphProvider as (gl: unknown) => unknown)({});
      const adapter = fakeAdapter(); control.pending!.resolve(adapter);
      await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalledOnce());
      const before = diagnostic().frameIdentity;
      const textBefore = { ...rendererRuntimeStatus.pixiText };
      expect(textBefore.actual).toBe("slug-cached");
      adapter.setAccept(false); control.glyphReady = false; control.glyphOnReady?.();
      await vi.waitFor(() => expect(adapter.admitScene.mock.calls.length).toBeGreaterThanOrEqual(2));
      expect(diagnostic().frameIdentity).toEqual(before);
      expect(rendererRuntimeStatus.pixiText).toEqual(textBefore);
    } finally { renderer.dispose(); }
  });

  it("keeps label modulation on the carrier and native fallback runs neutral", async () => {
    window.history.replaceState(null, "", "/?stage=pixi&pixiScene=retained&pixiText=slug");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    measureStub(); control.glyphReady = true;
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"));
    try {
      const state = textScene(); state.nodes.get("label")!.canvasBlendMode = 1;
      expect(renderer.reconcile(state)).toBe(false);
      await vi.waitFor(() => expect(control.pending).not.toBeNull());
      (control.options!.createGlyphProvider as (gl: unknown) => unknown)({});
      const adapter = fakeAdapter(); control.pending!.resolve(adapter);
      await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalledOnce());
      const carrier = adapter.admitScene.mock.lastCall![1][0];
      expect((carrier as typeof carrier & { blend: number }).blend).toBe(1);
      expect((carrier.nativeFallback![0] as typeof carrier & { blend: number }).blend).toBe(0);
      expect((carrier.nativeFallback![0] as typeof carrier & { alpha: number }).alpha).toBe(1);
      expect((carrier.nativeFallback![0] as typeof carrier & { tint: number }).tint).toBe(0xffffff);
      expect(carrier.glyph?.cacheEligible).toBe(false);
    } finally { renderer.dispose(); }
  });

  it("keeps colored rich spans native with a per-label glyph refusal", async () => {
    window.history.replaceState(null, "", "/?stage=pixi&pixiScene=retained&pixiText=slug");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    measureStub(); control.glyphReady = true;
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"));
    try {
      const state = textScene(); const label = state.nodes.get("label")!;
      label.richText = true; label.text = { ...label.text!, text: "[color=#ff0000]Red[/color] white" };
      expect(renderer.reconcile(state)).toBe(false);
      await vi.waitFor(() => expect(control.pending).not.toBeNull());
      (control.options!.createGlyphProvider as (gl: unknown) => unknown)({});
      const adapter = fakeAdapter(); control.pending!.resolve(adapter);
      await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalledOnce());
      const carrier = adapter.admitScene.mock.lastCall![1][0];
      expect(carrier.fallbackReason).toBe("glyph-rich-spans");
      expect(carrier.glyph).toBeUndefined();
      expect(carrier.nativeFallback?.length).toBeGreaterThan(1);
      expect(control.glyphBlockCalls).toBe(0);
      expect(rendererRuntimeStatus.pixiText).toMatchObject({ actual: "native", native: 1, reasons: { "glyph-rich-spans": 1 } });
    } finally { renderer.dispose(); }
  });

  it("refines deferred glyph caches with a direct presentation and no scene rebuild", async () => {
    window.history.replaceState(null, "", "/?stage=pixi&pixiScene=retained&pixiText=slug-cached");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    measureStub(); control.glyphReady = true;
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"));
    try {
      expect(renderer.reconcile(textScene())).toBe(false);
      await vi.waitFor(() => expect(control.pending).not.toBeNull());
      (control.options!.createGlyphProvider as (gl: unknown) => unknown)({});
      const adapter = fakeAdapter(); control.pending!.resolve(adapter);
      await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalledOnce());
      const before = diagnostic();
      adapter.setTextOutcomes({ requested: "slug-cached", actual: "slug", native: 0, slug: 1, slugCached: 0, reasons: {} });
      (control.options!.onInvalidate as (reason: string) => void)("present");
      await vi.waitFor(() => expect(adapter.presentScene).toHaveBeenCalledOnce());
      const after = diagnostic();
      expect(adapter.admitScene).toHaveBeenCalledOnce();
      expect(after.effective.buildEpoch).toBe(before.effective.buildEpoch);
      expect(after.draw.nativeLayouts).toBe(before.draw.nativeLayouts);
      expect((after.frameIdentity as { presentEpoch: number }).presentEpoch)
        .toBe((before.frameIdentity as { presentEpoch: number }).presentEpoch + 1);
      expect(rendererRuntimeStatus.pixiText?.actual).toBe("slug");

      adapter.setAccept(false);
      (control.options!.onInvalidate as (reason: string) => void)("present");
      await vi.waitFor(() => expect(adapter.presentScene).toHaveBeenCalledTimes(2));
      expect(diagnostic().frameIdentity).toEqual(after.frameIdentity);
      expect((diagnostic() as ReturnType<typeof diagnostic> & { refinementFailure?: string }).refinementFailure).toBe("test presentation refused");
      expect(diagnostic().draw.refinementPending).toBe(1);

      adapter.setAccept(true);
      (control.options!.onInvalidate as (reason: string) => void)("present");
      await vi.waitFor(() => expect(adapter.presentScene).toHaveBeenCalledTimes(3));
      expect(diagnostic().draw.refinementPending).toBe(0);
      expect((diagnostic() as ReturnType<typeof diagnostic> & { refinementFailure?: string }).refinementFailure).toBeUndefined();
    } finally { renderer.dispose(); }
  });

  it("fails closed on initialization rejection without constructing a DOM fallback", async () => {
    const host = stage();
    const renderer = createPixiMirrorRenderer(host, document.createElementNS("http://www.w3.org/2000/svg", "defs"));
    await vi.waitFor(() => expect(control.pending).not.toBeNull());
    control.pending!.reject(new Error("no WebGL"));
    await vi.waitFor(() => expect((window as unknown as { __mirrorRendererDiagnostics(): { readiness: string } }).__mirrorRendererDiagnostics().readiness).toBe("failed"));
    expect(host.querySelectorAll("canvas")).toHaveLength(1);
    expect(renderer.reconcile(createMirrorState())).toBe(false);
    renderer.dispose();
  });

  it("disposes a renderer whose asynchronous initialization resolves after teardown", async () => {
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"));
    await vi.waitFor(() => expect(control.pending).not.toBeNull());
    renderer.dispose();
    const adapter = fakeAdapter(); control.pending!.resolve(adapter);
    await vi.waitFor(() => expect(adapter.dispose).toHaveBeenCalledOnce());
    expect("__mirrorRendererDiagnostics" in window).toBe(false);
  });

  it("keeps the completed frame identity and hit snapshot while a newer offer is blocked", async () => {
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"));
    const first = createMirrorState(); first.revision = 1;
    renderer.reconcile(first);
    await vi.waitFor(() => expect(control.pending).not.toBeNull());
    const adapter = fakeAdapter(); control.pending!.resolve(adapter);
    await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalled());
    const identity = (window as unknown as { __mirrorFrameIdentity(): unknown }).__mirrorFrameIdentity();
    const hits = renderer.touchStackAt(100, 100);

    adapter.setAccept(false);
    const blocked = createMirrorState(); blocked.revision = 2;
    expect(renderer.reconcile(blocked)).toBe(false);
    expect((window as unknown as { __mirrorFrameIdentity(): unknown }).__mirrorFrameIdentity()).toEqual(identity);
    expect(renderer.touchStackAt(100, 100)).toEqual(hits);
    renderer.rewardFocusSnapshot();
    expect(rewardSpy.mock.calls.at(-1)?.[0]).not.toBe(blocked.nodes);
    renderer.dispose();
  });

  it("publishes successful delta consumption and resolves diagnostic clocks at a frame boundary", async () => {
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"));
    const next = createMirrorState(); next.revision = 3; next.sceneRewrite = true; next.changedIds.add("changed");
    renderer.reconcile(next);
    await vi.waitFor(() => expect(control.pending).not.toBeNull());
    const adapter = fakeAdapter(); control.pending!.resolve(adapter);
    await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalled());
    expect(renderer.reconcile(next)).toBeUndefined();
    expect(next.sceneRewrite).toBe(false); expect(next.changedIds.size).toBe(0);
    expect(schedulerControl.arms).toHaveBeenCalled();

    adapter.setAccept(false);
    const completedBefore = adapter.stats.completedFrames;
    expect(schedulerControl.ports!.animation.runBuild(next)).toBe(false);
    expect(adapter.stats.completedFrames).toBe(completedBefore);

    let frame: FrameRequestCallback | null = null;
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frame = callback; return 1; });
    let settled = false;
    const promise = (window as unknown as { __mirrorSetDiagnosticClock(ms: number): Promise<unknown> }).__mirrorSetDiagnosticClock(500).then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    expect(frame).not.toBeNull(); (frame as unknown as FrameRequestCallback)(500); await promise; expect(settled).toBe(true);
    raf.mockRestore(); renderer.dispose();
  });

  it("starts and repeats the production idle frame chain after an admitted reconcile", async () => {
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"));
    const next = createMirrorState(); next.revision = 4;
    renderer.reconcile(next);
    await vi.waitFor(() => expect(control.pending).not.toBeNull());
    const adapter = fakeAdapter(); control.pending!.resolve(adapter);
    await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalled());
    schedulerControl.ports.deadlines.passiveDeadline = () => performance.now();
    schedulerControl.ports.deadlines.idleStageNotBefore = () => 0;
    const before = adapter.stats.completedFrames;
    expect(renderer.reconcile(next)).toBeUndefined();
    await vi.waitFor(() => expect(adapter.stats.completedFrames).toBeGreaterThan(before + 1));
    renderer.dispose();
  });

  it("retains native layout beyond 120 diagnostic presentations and invalidates changed text", async () => {
    const measure = measureStub();
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"));
    const state = textScene(true); renderer.reconcile(state);
    await vi.waitFor(() => expect(control.pending).not.toBeNull());
    const adapter = fakeAdapter(); control.pending!.resolve(adapter);
    await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalled());
    expect(renderer.reconcile(state)).toBeUndefined();
    const before = diagnostic(); const measured = measure.mock.calls.length;
    expect(before.draw.nativeLayouts).toBeGreaterThan(0);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      queueMicrotask(() => callback(0)); return 1;
    });
    try {
      for (let i = 0; i < 179; i++) await clockAt(1000 + i * 1000 / 60);
      expect(diagnostic().effective.buildEpoch).toBe(before.effective.buildEpoch);
      expect(diagnostic().draw.retainedPatches - before.draw.retainedPatches).toBe(179);
      expect(measure.mock.calls.length).toBe(measured);
      const poses = adapter.patchScene.mock.calls.flatMap(([value]) => {
        const patch = value as { primitives?: Array<{ transform?: readonly number[] }>; groups?: Array<{ transform?: readonly number[] }> };
        return [...(patch.primitives ?? []), ...(patch.groups ?? [])].filter((item) => item.transform).map((item) => JSON.stringify(item.transform));
      });
      expect(new Set(poses).size).toBeGreaterThan(1);
      state.revision++;
      expect(renderer.reconcile(state)).toBeUndefined();
      expect(diagnostic().effective.buildEpoch).toBe(before.effective.buildEpoch);
      const label = state.nodes.get("label")!;
      state.nodes.set(label.id, { ...label, text: { ...label.text!, text: "Changed label" } });
      state.changedIds.add(label.id); state.revision++;
      expect(renderer.reconcile(state)).toBeUndefined();
      expect(diagnostic().draw.nativeLayouts).toBe(before.draw.nativeLayouts + 1);
      expect(state.changedIds.size).toBe(0);
    } finally { renderer.dispose(); }
  });

  it("reuses one shaped glyph block through 179 retained animation presentations", async () => {
    window.history.replaceState(null, "", "/?stage=pixi&pixiScene=retained&pixiText=slug");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    const measure = measureStub(); control.glyphReady = true;
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"));
    try {
      const state = textScene(true); expect(renderer.reconcile(state)).toBe(false);
      await vi.waitFor(() => expect(control.pending).not.toBeNull());
      (control.options!.createGlyphProvider as (gl: unknown) => unknown)({});
      const adapter = fakeAdapter(); control.pending!.resolve(adapter);
      await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalledOnce());
      expect(control.glyphBlockCalls).toBe(1);
      const before = diagnostic(); const measurements = measure.mock.calls.length;
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        queueMicrotask(() => callback(0)); return 1;
      });
      for (let i = 0; i < 179; i++) await clockAt(1000 + i * 1000 / 60);
      expect(control.glyphBlockCalls).toBe(1);
      expect(measure.mock.calls.length).toBe(measurements);
      expect(diagnostic().draw.nativeLayouts).toBe(before.draw.nativeLayouts);
      expect(diagnostic().effective.buildEpoch).toBe(before.effective.buildEpoch);
      expect(diagnostic().draw.retainedPatches - before.draw.retainedPatches).toBe(179);
      expect(adapter.admitScene).toHaveBeenCalledOnce();
    } finally { renderer.dispose(); }
  });

  it("keeps the drawn identity on failed retained presentation and admits a retry", async () => {
    measureStub();
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"));
    const state = textScene(); renderer.reconcile(state);
    await vi.waitFor(() => expect(control.pending).not.toBeNull());
    const adapter = fakeAdapter(); control.pending!.resolve(adapter);
    await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalled());
    renderer.reconcile(state);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      queueMicrotask(() => callback(0)); return 1;
    });
    try {
      const before = diagnostic();
      adapter.setAccept(false); await clockAt(1000);
      expect(diagnostic().frameIdentity).toEqual(before.frameIdentity);
      expect(diagnostic().draw.completedFrames).toBe(before.draw.completedFrames);
      adapter.setAccept(true); await clockAt(1100);
      expect(diagnostic().draw.completedFrames).toBe(before.draw.completedFrames + 1);
      expect(diagnostic().frameIdentity).not.toEqual(before.frameIdentity);
    } finally { renderer.dispose(); }
  });

  it("remeasures native text after font readiness changes and removes its listener on disposal", async () => {
    measureStub();
    const original = Object.getOwnPropertyDescriptor(document, "fonts");
    const fonts = Object.assign(new EventTarget(), { check: () => true, load: vi.fn(async () => []) });
    const remove = vi.spyOn(fonts, "removeEventListener");
    Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"));
    try {
      const state = textScene(); renderer.reconcile(state);
      await vi.waitFor(() => expect(control.pending).not.toBeNull());
      const adapter = fakeAdapter(); control.pending!.resolve(adapter);
      await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalled());
      const layouts = diagnostic().draw.nativeLayouts;
      fonts.dispatchEvent(new Event("loadingdone"));
      expect(renderer.reconcile(state)).toBeUndefined();
      expect(diagnostic().draw.nativeLayouts).toBe(layouts + 1);
    } finally {
      renderer.dispose(); expect(remove).toHaveBeenCalledWith("loadingdone", expect.any(Function));
      if (original) Object.defineProperty(document, "fonts", original);
      else Reflect.deleteProperty(document, "fonts");
    }
  });

  it("invalidates native layout when the font resource changes under the same CSS family", async () => {
    measureStub();
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"));
    try {
      const state = textScene(); renderer.reconcile(state);
      await vi.waitFor(() => expect(control.pending).not.toBeNull());
      const adapter = fakeAdapter(); control.pending!.resolve(adapter);
      await vi.waitFor(() => expect(adapter.admitScene).toHaveBeenCalled());
      const layouts = diagnostic().draw.nativeLayouts;
      const label = state.nodes.get("label")!;
      state.nodes.set(label.id, { ...label, font: { ...label.font!, url: "/replacement-font.ttf" } });
      state.changedIds.add(label.id); state.revision++;
      expect(renderer.reconcile(state)).toBeUndefined();
      expect(diagnostic().draw.nativeLayouts).toBe(layouts + 1);
    } finally { renderer.dispose(); }
  });

  it.each(["legacy", "retained"])("uses display cadence for the %s scene control", async (scene) => {
    window.history.replaceState(null, "", `/?rendererCompare=1&stage=pixi&pixiScene=${scene}&cmpIdle=display`);
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
    const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"));
    try {
      await vi.waitFor(() => expect(control.pending).not.toBeNull());
      const adapter = fakeAdapter(); control.pending!.resolve(adapter);
      await vi.waitFor(() => expect(adapter.resize).toHaveBeenCalled());
      await vi.waitFor(() => expect(diagnostic().effective.pixiScene).toBe(scene));
      expect(schedulerControl.ports.displayPacedPassive).toBe(true);
      expect(renderer.reconcile(createMirrorState())).toBeUndefined();
      expect(scene === "legacy" ? adapter.render : adapter.admitScene).toHaveBeenCalledOnce();
    } finally { renderer.dispose(); }
  });
});
