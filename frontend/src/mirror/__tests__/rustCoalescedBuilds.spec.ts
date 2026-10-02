// `rustCoalescedBuilds` end to end: the Rust renderer, its interaction runtime and frame scheduler, with an executor
// that records submissions instead of drawing. Display frames are vitest's fake animation frames; the scheduler's
// frame epoch closes on a real posted task, drained between frames.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrawList } from "@godot-scene-web/canvas";
import { createQuadView } from "@godot-scene-web/canvas";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

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

import { HELD_CARD_DRAG_LIFT_PX } from "@/mirror/raise/constants";
import { createPixiMirrorRenderer } from "@/mirror/renderer/pixi/createPixiMirrorRenderer";
import { readRendererComparisonConfig, rendererComparisonConfig } from "@/mirror/rendererComparison";

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const turn = () => new Promise<void>((resolve) => realSetTimeout(resolve, 0));
/** Settle executor promises and let the scheduler's posted frame close run. */
const drain = async () => { await turn(); await turn(); };

const I = [1, 0, 0, 1, 0, 0];
const xf = (m: readonly number[]) => ({ xAxis: { x: m[0], y: m[1] }, yAxis: { x: m[2], y: m[3] }, origin: { x: m[4], y: m[5] } });
const box = (w: number, h: number) => ({ position: { x: 0, y: 0 }, size: { x: w, y: h } });
const fill = (html: string) => ({ r: 1, g: 1, b: 1, a: 1, html });
const CARD_Y = 800;

function sceneNodes(): Array<Record<string, unknown>> {
  const node = (id: string, parentId: string | null, nodeType: string, transform: readonly number[],
    extra: Record<string, unknown> = {}) => ({ id, parentId, name: id, nodeType, visible: true, transform: xf(transform), ...extra });
  return [
    node("stage", null, "Control", I, { localRect: box(1920, 1080) }),
    node("card", "stage", "NCard", [1, 0, 0, 1, 540, CARD_Y], { localRect: box(160, 220) }),
    node("cardFace", "card", "ColorRect", I, { localRect: box(160, 220), fillColor: { r: 1, g: 0, b: 1, a: 1, html: "#ff00ffff" } }),
    node("mover", "stage", "ColorRect", [1, 0, 0, 1, 1200, 300], { localRect: box(120, 80), fillColor: fill("#8844ccff") }),
    node("other", "stage", "ColorRect", [1, 0, 0, 1, 200, 200], { localRect: box(50, 50), fillColor: fill("#33aa33ff") }),
  ];
}

type Submission = { call: "admit" | "patch" | "present"; faceY: number | null };

/** The card face's drawn y in an admitted list: the one magenta quad. */
function faceY(list: DrawList<string>): number | null {
  const view = createQuadView();
  for (let index = 0; index < list.count; index++) {
    if (list.kindNameAt(index) !== "quad") continue;
    list.readQuad(index, view);
    if (view.r === 1 && view.g === 0 && view.b === 1) return view.m[5];
  }
  return null;
}

type Control = { sync: boolean; hold: boolean; held: Array<(outcome?: "refused" | "error") => void> };

function recordingExecutor(log: Submission[], control: Control) {
  const stats = { completedFrames: 0, frames: 0, resourcePending: 0, textureFailures: 0, textures: 0,
    contextReady: true, presentationValid: false, objects: 0 };
  const settle = () => {
    const done = () => { stats.frames++; stats.completedFrames++; stats.presentationValid = true; return { presented: true }; };
    if (control.sync) return done();
    if (control.hold) return new Promise((resolve, reject) => control.held.push((outcome) => {
      if (outcome === "error") reject(new Error("executor lost the device"));
      else if (outcome === "refused") resolve({ presented: false, reason: "resource pending" });
      else resolve(done());
    }));
    return Promise.resolve(done());
  };
  return {
    stats, app: { renderer: {} }, resize: () => { stats.presentationValid = false; }, dispose: () => {},
    textureSize: () => null, prefetch: () => {}, textureFailureDetails: () => [], setTraceFrameId: () => {},
    bindPixelTexture: () => {}, pollDiagnostics: () => {},
    textOutcomes: () => ({ requested: "native", actual: "native", native: 0, slug: 0, slugCached: 0, reasons: {} }),
    render: () => { throw new Error("the retained Rust path never submits a legacy render"); },
    admitScene: (list: DrawList<string>) => { log.push({ call: "admit", faceY: faceY(list) }); return settle(); },
    patchScene: () => { log.push({ call: "patch", faceY: null }); return settle(); },
    presentScene: () => { log.push({ call: "present", faceY: null }); return settle(); },
  };
}

function stage(): HTMLElement {
  const element = document.createElement("div");
  Object.defineProperties(element, { clientWidth: { value: 1920 }, clientHeight: { value: 1080 } });
  element.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1920, bottom: 1080, width: 1920, height: 1080, toJSON() {} });
  document.body.append(element);
  return element;
}

type CoalesceStats = { requests: number; immediate: number; deferred: number; urgentExtraBuilds: number;
  workPerFrame: Record<string, number>; maxWorkPerFrame: number };
type Diagnostics = { asyncSubmissionRevision: number | null; readiness: string;
  effective: { rustCoalescedBuilds?: CoalesceStats; rustProducerReasons?: { bySource: Record<string, { count: number }> } } };
const diagnostics = () => (window as unknown as { __mirrorRendererDiagnostics(): Diagnostics }).__mirrorRendererDiagnostics();

async function setup(query: string, options: { sync?: boolean } = {}) {
  window.history.replaceState(null, "", `/?rendererCompare=1&stage=rust&rustProducerReasons=1&${query}`);
  Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
  const measureText = (value: string) => ({ width: value.length * 10, fontBoundingBoxAscent: 16, fontBoundingBoxDescent: 4,
    actualBoundingBoxAscent: 16, actualBoundingBoxDescent: 4 });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ font: "", measureText } as never);
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const log: Submission[] = [];
  const control: Control = { sync: false, hold: false, held: [] };
  const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
    undefined, { backend: "rust", createExecutor: async () => recordingExecutor(log, control) as never });
  const state: MirrorState = createMirrorState();
  const rows = sceneNodes();
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "combat", upserts: rows,
    orderedIds: rows.map((row) => row.id as string) })!);
  renderer.setStaticBackgroundSource!({ scenePath: "res://scenes/backgrounds/glade/glade_background.tscn", url: "/bg/glade.png" }, () => {});
  expect(renderer.reconcile(state)).toBe(false);
  await drain();
  // The first reconcile ran before the executor existed; the view re-offers it.
  if (renderer.reconcile(state) === false) { await drain(); renderer.reconcile(state); }
  await drain();
  expect(diagnostics().readiness).toBe("ready");
  control.sync = options.sync ?? false;

  // The view's own reconcile lane: a delta books a render rAF the scheduler may pull into its tick.
  let renderRaf = 0;
  renderer.setReconcilePull!({
    pending: () => renderRaf !== 0,
    now: () => { cancelAnimationFrame(renderRaf); renderRaf = 0; renderer.reconcile(state); },
  });
  const deltaArrives = (upserts: Array<Record<string, unknown>>, hints: unknown[] = []) => {
    applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "combat", upserts, hints })!);
    if (renderRaf === 0) renderRaf = requestAnimationFrame(() => { renderRaf = 0; renderer.reconcile(state); });
  };
  const frame = async () => { vi.advanceTimersToNextFrame(); await drain(); };
  /** A long position tween: the animation tick has per-frame demand and builds or patches every frame. */
  const startTween = async () => {
    deltaArrives([], [{ targetId: "mover", property: "position", durationMs: 60_000, trans: "Linear", ease: "In",
      endTransform: [1, 0, 0, 1, 1600, 300] }]);
    await frame();
    await frame();
  };
  return { renderer, state, log, control, deltaArrives, frame, startTween };
}

describe("one build per frame (rustCoalescedBuilds)", () => {
  beforeEach(() => { document.body.replaceChildren(); });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
  });

  it.each(["rustCoalescedBuilds=0", ""])("lifts a card picked up on an idle stage at once (%s)", async (query) => {
    const h = await setup(query);
    const before = h.log.length;
    h.renderer.setHeldCard("card", 0, 900, "drag");
    // No tick is coming: the request builds where the synchronous build did, before the next frame.
    expect(h.log.slice(before)).toEqual([{ call: "admit", faceY: CARD_Y - HELD_CARD_DRAG_LIFT_PX }]);
    h.renderer.dispose();
  });

  it("presents a lift raised between frames in the next frame, with that frame's tick as the only build", async () => {
    const results: Record<string, { work: Submission[]; lifted: number | null }> = {};
    for (const query of ["rustCoalescedBuilds=0", ""]) {
      const h = await setup(query);
      await h.startTween();
      const before = h.log.length;
      h.renderer.setHeldCard("card", 0, 900, "drag"); // a pointer event: its own task, before the frame
      await drain();
      await h.frame();
      const work = h.log.slice(before);
      results[query] = { work, lifted: work.find((entry) => entry.call === "admit")?.faceY ?? null };
      h.renderer.dispose();
    }
    // Same frame as before: by the end of the next display frame the lift is drawn on both arms.
    expect(results["rustCoalescedBuilds=0"].lifted).toBe(CARD_Y - HELD_CARD_DRAG_LIFT_PX);
    expect(results[""].lifted).toBe(CARD_Y - HELD_CARD_DRAG_LIFT_PX);
    // Off: the synchronous build plus the tick's own. On: the tick's build carries the lift.
    expect(results["rustCoalescedBuilds=0"].work.length).toBe(2);
    expect(results[""].work).toEqual([{ call: "admit", faceY: CARD_Y - HELD_CARD_DRAG_LIFT_PX }]);
  });

  it("folds a held-card lift, the animation tick and a streamed delta into one build", async () => {
    const counts: Record<string, number> = {};
    for (const query of ["rustCoalescedBuilds=0", ""]) {
      const h = await setup(query);
      await h.startTween();
      const before = h.log.length;
      h.deltaArrives([{ id: "other", parentId: "stage", name: "other", nodeType: "ColorRect", visible: true,
        transform: xf([1, 0, 0, 1, 210, 200]), localRect: box(50, 50), fillColor: fill("#33aa33ff") }]);
      h.renderer.setHeldCard("card", 0, 900, "drag");
      await drain();
      await h.frame();
      const work = h.log.slice(before);
      counts[query] = work.length;
      expect(work.at(-1)).toEqual({ call: "admit", faceY: CARD_Y - HELD_CARD_DRAG_LIFT_PX });
      h.renderer.dispose();
    }
    expect(counts[""]).toBe(1);
    expect(counts["rustCoalescedBuilds=0"]).toBeGreaterThan(1);
  });

  it("builds an urgent lift from an input lane that runs after the frame's tick, in that lane", async () => {
    const h = await setup("", { sync: true });
    await h.startTween();
    let inLane: Submission[] = [];
    // Booked after the tick re-armed itself, so it runs after the tick in the next frame (flushHover's order).
    requestAnimationFrame(() => {
      const before = h.log.length;
      h.renderer.setHeldCard("card", 0, 900, "drag");
      inLane = h.log.slice(before);
    });
    await h.frame();
    expect(inLane).toEqual([{ call: "admit", faceY: CARD_Y - HELD_CARD_DRAG_LIFT_PX }]);
    expect(diagnostics().effective.rustCoalescedBuilds!.urgentExtraBuilds).toBe(1);
    // A later finger move that changes nothing drawn requests nothing.
    const before = h.log.length;
    h.renderer.setHeldCard("card", 0, 905, "drag");
    expect(h.log.length).toBe(before);
    h.renderer.dispose();
  });

  it("keeps a lift raised while a presentation is in flight and draws it once that settles", async () => {
    const lifted: Record<string, number | null> = {};
    for (const query of ["rustCoalescedBuilds=0", ""]) {
      const h = await setup(query);
      h.control.hold = true;
      h.deltaArrives([{ id: "other", parentId: "stage", name: "other", nodeType: "ColorRect", visible: true,
        transform: xf([1, 0, 0, 1, 220, 200]), localRect: box(50, 50), fillColor: fill("#33aa33ff") }]);
      await h.frame(); // the reconcile's build is now in flight
      expect(diagnostics().asyncSubmissionRevision).not.toBeNull();
      h.renderer.setHeldCard("card", 0, 900, "drag");
      h.control.hold = false;
      for (const release of h.control.held.splice(0)) release();
      await h.frame();
      await h.frame();
      lifted[query] = h.log.filter((entry) => entry.call === "admit").at(-1)!.faceY;
      h.renderer.dispose();
    }
    // Off keeps today's behaviour: the build refused as in flight is lost and the card is drawn unlifted.
    expect(lifted["rustCoalescedBuilds=0"]).toBe(CARD_Y);
    expect(lifted[""]).toBe(CARD_Y - HELD_CARD_DRAG_LIFT_PX);
  });

  // Every settle path of both in-flight kinds: a full build (a delta that changes a fill) and a retained wire patch
  // (a transform-only delta). Committed and stale settles are covered by the specs above and the parity suite.
  it.each([
    ["build", "refused"], ["build", "error"], ["patch", "refused"], ["patch", "error"],
  ] as const)("re-arms a lift held during an in-flight %s that settles %s", async (kind, outcome) => {
    const h = await setup("");
    h.control.hold = true;
    const before0 = h.log.length;
    h.deltaArrives([{ id: "other", parentId: "stage", name: "other", nodeType: "ColorRect", visible: true,
      transform: xf([1, 0, 0, 1, 220, 200]), localRect: box(50, 50),
      fillColor: kind === "build" ? { r: 0, g: 0, b: 1, a: 1, html: "#0000ffff" } : fill("#33aa33ff") }]);
    await h.frame();
    expect(h.log.slice(before0).map((entry) => entry.call)).toEqual([kind === "build" ? "admit" : "patch"]);
    expect(diagnostics().asyncSubmissionRevision).not.toBeNull();
    h.renderer.setHeldCard("card", 0, 900, "drag");
    const before = h.log.length;
    h.control.hold = false;
    for (const release of h.control.held.splice(0)) release(outcome);
    await drain();
    expect(diagnostics().asyncSubmissionRevision).toBeNull();
    await h.frame();
    // Nothing else wakes the scheduler here: the settle itself (its re-arm, or the reconcile it re-offers) must
    // draw the held lift, once.
    expect(h.log.slice(before)).toEqual([{ call: "admit", faceY: CARD_Y - HELD_CARD_DRAG_LIFT_PX }]);
    h.renderer.dispose();
  });

  it("builds no more than switch-off for an eager-scroll burst on a quiet stage", async () => {
    const results: Record<string, { admits: number; faceY: number | null }> = {};
    // Counted in full builds: the translate patch (`rustOffsetPatch`, own spec) would carry the trailing offsets.
    for (const query of ["rustCoalescedBuilds=0&rustOffsetPatch=0", "rustOffsetPatch=0"]) {
      const h = await setup(query);
      const before = h.log.length;
      h.renderer.applyLocalOffset!("card", 10); // the burst's first offset, then two more in the same task
      h.renderer.applyLocalOffset!("card", 20);
      h.renderer.applyLocalOffset!("card", 30);
      await drain();
      for (let i = 0; i < 3; i++) await h.frame();
      const admits = h.log.slice(before).filter((entry) => entry.call === "admit");
      results[query] = { admits: admits.length, faceY: admits.at(-1)?.faceY ?? null };
      h.renderer.dispose();
    }
    expect(results["rustOffsetPatch=0"].faceY).toBe(CARD_Y + 30);
    expect(results["rustCoalescedBuilds=0&rustOffsetPatch=0"].faceY).toBe(CARD_Y + 30);
    expect(results["rustOffsetPatch=0"].admits).toBeLessThanOrEqual(results["rustCoalescedBuilds=0&rustOffsetPatch=0"].admits);
  });

  // The default configuration: the translate patch (`rustOffsetPatch`) carries the trailing offsets, and the shadow
  // build proves each patched picture is the one a full build of the same offsets draws.
  it("patches an eager-scroll burst's trailing offsets in the default configuration", async () => {
    const offArm = await setup("rustCoalescedBuilds=0&rustOffsetPatch=0");
    const offBefore = offArm.log.length;
    offArm.renderer.applyLocalOffset!("card", 10);
    offArm.renderer.applyLocalOffset!("card", 20);
    offArm.renderer.applyLocalOffset!("card", 30);
    await drain();
    for (let i = 0; i < 3; i++) await offArm.frame();
    const offAdmits = offArm.log.slice(offBefore).filter((entry) => entry.call === "admit").length;
    offArm.renderer.dispose();

    const h = await setup("rustFastVerify=1");
    const before = h.log.length;
    h.renderer.applyLocalOffset!("card", 10); // the first offset builds at once and captures the card
    h.renderer.applyLocalOffset!("card", 20);
    h.renderer.applyLocalOffset!("card", 30);
    await drain();
    for (let i = 0; i < 3; i++) await h.frame();
    const work = h.log.slice(before);
    const admits = work.filter((entry) => entry.call === "admit");
    expect(admits.length).toBeLessThanOrEqual(offAdmits);
    expect(admits[0]?.faceY).toBe(CARD_Y + 10);
    expect(work.some((entry) => entry.call === "patch")).toBe(true);
    const offsets = (diagnostics().effective as { rustOffsetPatch?: { offsetPatches: number; verifyRuns?: number;
      verifyMismatches?: number; verifyFirstMismatch?: string | null; verifyLog?: Array<{ recent: string[] }> } }).rustOffsetPatch!;
    expect(offsets.offsetPatches).toBeGreaterThanOrEqual(1);
    expect(offsets.verifyRuns).toBe(offsets.offsetPatches);
    expect(offsets.verifyFirstMismatch).toBeNull();
    expect(offsets.verifyMismatches).toBe(0);
    h.renderer.dispose();
  });

  it.each([{ sync: false }, { sync: true }])("never does two builds or patches in one frame while a drag streams deltas and late requests (%o)", async (executor) => {
    const h = await setup("", executor);
    await h.startTween();
    for (let i = 0; i < 6; i++) {
      // flushHover's lane, after the tick: the finger moves and a client-only change asks for a build each frame.
      requestAnimationFrame(() => {
        h.renderer.setHeldCard("card", 0, 900 - i * 10, "drag");
        h.renderer.setStretch(1);
      });
      if (i % 2 === 0) h.deltaArrives([{ id: "other", parentId: "stage", name: "other", nodeType: "ColorRect",
        visible: true, transform: xf([1, 0, 0, 1, 200 + i, 200]), localRect: box(50, 50), fillColor: fill("#33aa33ff") }]);
      await h.frame();
    }
    const stats = diagnostics().effective.rustCoalescedBuilds!;
    expect(stats.requests).toBeGreaterThanOrEqual(6);
    // The only allowed second build in a frame is an urgent pick-up lift itself.
    expect(stats.workPerFrame["3+"]).toBe(0);
    expect(stats.workPerFrame["2"]).toBeLessThanOrEqual(stats.urgentExtraBuilds);
    expect(h.log.filter((entry) => entry.call === "admit").at(-1)!.faceY).toBe(CARD_Y - HELD_CARD_DRAG_LIFT_PX);
    h.renderer.dispose();
  });
});
