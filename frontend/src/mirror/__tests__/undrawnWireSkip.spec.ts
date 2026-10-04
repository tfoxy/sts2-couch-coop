// `rustSkipUndrawnWire` end to end: a wire delta whose every changed node lies in a subtree the committed build drew
// nothing for is APPLIED to the committed state and acknowledged (`reconcile` returns "applied") without sampling a
// visual, a retained patch, a build or a present. The scheduler's own ticks keep drawing tweens, settles and idle loops
// at their own times, and a later delta that makes the subtree visible poses it at the latest transform the skipped
// deltas left. The executor here records instead of drawing.
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

import { createPixiMirrorRenderer } from "@/mirror/renderer/pixi/createPixiMirrorRenderer";
import { readRendererComparisonConfig, rendererComparisonConfig } from "@/mirror/rendererComparison";
import { HELD_CARD_DRAG_LIFT_PX } from "@/mirror/raise/constants";

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const turn = () => new Promise<void>((resolve) => realSetTimeout(resolve, 0));
const drain = async () => { await turn(); await turn(); };

const I = [1, 0, 0, 1, 0, 0];
const xf = (m: readonly number[]) => ({ xAxis: { x: m[0], y: m[1] }, yAxis: { x: m[2], y: m[3] }, origin: { x: m[4], y: m[5] } });
const box = (w: number, h: number) => ({ position: { x: 0, y: 0 }, size: { x: w, y: h } });
/** A unique colour so the quad it paints is identifiable in a committed draw list. */
const EYE_FIRE_COLOR = { r: 1, g: 0, b: 1, a: 1, html: "#ff00ffff" };
const MOVER_COLOR = { r: 0, g: 1, b: 0, a: 1, html: "#00ff00ff" };
const OTHER_COLOR = { r: 0, g: 0, b: 1, a: 1, html: "#0000ffff" };
const MOVER_Y = 800;
const WIDE = 1.3125;

type SceneOptions = { pulse?: boolean; ghost?: boolean; floater?: boolean; wide?: boolean };

/**
 * `eyeSlot` is a bare `Node2D` — a bone-follower transform aggregator that paints nothing itself. `eyeFire` is its
 * only child and starts invisible: the EyeSlot/EyeFire shape the idle-combat recording is built on
 * (`docs/agents/handoff-wire-shaped-renderer.md` §1).
 */
function sceneNodes(options: SceneOptions = {}): Array<Record<string, unknown>> {
  return [
    { id: "stage", parentId: null, name: "stage", nodeType: "Control", visible: true, transform: xf(I), localRect: box(1920, 1080),
      ...(options.wide ? { anchorLeft: 0, anchorRight: 1 } : {}) },
    { id: "eyeSlot", parentId: "stage", name: "eyeSlot", nodeType: "Node2D", visible: true, transform: xf([1, 0, 0, 1, 500, 400]) },
    { id: "eyeFire", parentId: "eyeSlot", name: "eyeFire", nodeType: "ColorRect", visible: false,
      transform: xf(I), localRect: box(40, 40), fillColor: EYE_FIRE_COLOR },
    // A draggable card, unrelated to eyeSlot/eyeFire: `setHeldCard` gives it a cosmetic offset.
    { id: "mover", parentId: "stage", name: "mover", nodeType: "NCard", visible: true, transform: xf([1, 0, 0, 1, 540, MOVER_Y]),
      localRect: box(160, 220) },
    { id: "moverFace", parentId: "mover", name: "moverFace", nodeType: "ColorRect", visible: true, transform: xf(I),
      localRect: box(160, 220), fillColor: MOVER_COLOR },
    // A drawn node: a delta that changes it alongside `eyeSlot` is not fully undrawn.
    { id: "other", parentId: "stage", name: "other", nodeType: "ColorRect", visible: true, transform: xf([1, 0, 0, 1, 300, 300]),
      localRect: box(30, 30), fillColor: OTHER_COLOR },
    // A wire-pinned idle loop: keeps an idle loop visible (`visual.frameSampleMask` nonzero) on every frame.
    ...(options.pulse ? [{ id: "pulse", parentId: "stage", name: "pulse", nodeType: "ColorRect", visible: true,
      transform: xf([1, 0, 0, 1, 1500, 500]), localRect: box(40, 40), fillColor: { r: 1, g: 0.8, b: 0, a: 1, html: "#ffcc00ff" },
      pinnedLoopAnim: "mapPointPulse" }] : []),
    // A group streamed with NO transform at first, over an invisible child: its first transform is a structure change.
    ...(options.ghost ? [
      { id: "ghost", parentId: "stage", name: "ghost", nodeType: "Node2D", visible: true },
      { id: "ghostFire", parentId: "ghost", name: "ghostFire", nodeType: "ColorRect", visible: false, transform: xf(I),
        localRect: box(20, 20), fillColor: EYE_FIRE_COLOR },
    ] : []),
    // Widened stage: `rig` holds `owner`, both box-less groups that paint nothing and claim the spread field at their
    // own X, and `floater` — a drawn node elsewhere — is anchored to `owner`, so the committed build resolved it
    // against `owner`. Moving `rig` in X changes the shifts in its span, `owner`'s among them.
    ...(options.floater ? [
      { id: "rig", parentId: "stage", name: "rig", nodeType: "Node2D", visible: true, transform: xf([1, 0, 0, 1, 1300, 400]) },
      { id: "owner", parentId: "rig", name: "owner", nodeType: "Node2D", visible: true, transform: xf([1, 0, 0, 1, 20, 0]) },
      { id: "floater", parentId: "stage", name: "floater", nodeType: "ColorRect", visible: true, transform: xf([1, 0, 0, 1, 1300, 300]),
        localRect: box(40, 20), fillColor: { r: 0.5, g: 0.5, b: 0.5, a: 1, html: "#808080ff" }, anchorOwnerId: "owner" },
    ] : []),
  ];
}

/** A rotation + translation, so a wire delta built from it is not a pure translation. */
const rot = (theta: number, x: number, y: number) => [Math.cos(theta), Math.sin(theta), -Math.sin(theta), Math.cos(theta), x, y];

type RetainedPatchLike = { primitives: Array<{ id: string; transform?: number[] }>; groups?: Array<{ id: string; transform: number[] }> };
type Submission = { call: "admit" | "patch" | "present"; list?: DrawList<string>; patch?: RetainedPatchLike };
type Control = { sync: boolean };

function recordingExecutor(log: Submission[], control: Control) {
  const stats = { completedFrames: 0, frames: 0, resourcePending: 0, textureFailures: 0, textures: 0,
    contextReady: true, presentationValid: false, objects: 0 };
  const settle = () => {
    const done = () => { stats.frames++; stats.completedFrames++; stats.presentationValid = true; return { presented: true }; };
    return control.sync ? done() : Promise.resolve(done());
  };
  return {
    stats, app: { renderer: {} }, resize: () => { stats.presentationValid = false; }, dispose: () => {},
    textureSize: () => null, prefetch: () => {}, textureFailureDetails: () => [], setTraceFrameId: () => {},
    bindPixelTexture: () => {}, pollDiagnostics: () => {},
    textOutcomes: () => ({ requested: "native", actual: "native", native: 0, slug: 0, slugCached: 0, reasons: {} }),
    render: () => { throw new Error("the retained Rust path never submits a legacy render"); },
    admitScene: (list: DrawList<string>) => { log.push({ call: "admit", list }); return settle(); },
    patchScene: (patch: RetainedPatchLike) => { log.push({ call: "patch", patch }); return settle(); },
    presentScene: () => { log.push({ call: "present" }); return settle(); },
  };
}

function stage(): HTMLElement {
  const element = document.createElement("div");
  Object.defineProperties(element, { clientWidth: { value: 1920 }, clientHeight: { value: 1080 } });
  element.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1920, bottom: 1080, width: 1920, height: 1080, toJSON() {} });
  document.body.append(element);
  return element;
}

type SkipDiagnostics = { skipped: number; appliedPulls: number; declines: Record<string, number>; verifyRuns?: number;
  verifyMismatches?: number; verifyBuilt?: number; verifyFirstMismatch?: string | null };
type FrameIdentity = { revision: number; buildEpoch: number; presentEpoch: number; clock: number | null };
type Diagnostics = { readiness: string; frameIdentity: FrameIdentity | null; draw: Record<string, number>;
  effective: { rustSkipUndrawnWire?: SkipDiagnostics } };
const diagnostics = () => (window as unknown as { __mirrorRendererDiagnostics(): Diagnostics }).__mirrorRendererDiagnostics();
const skipStats = () => diagnostics().effective.rustSkipUndrawnWire!;
/** The diagnostic clock: samples and presents one frame at `ms` (`setRustDiagnosticClock`). */
const clockAt = (ms: number) => (window as unknown as { __mirrorSetDiagnosticClock(ms: number): Promise<unknown> })
  .__mirrorSetDiagnosticClock(ms);
type LifecycleRow = { source: string; outcome: string };
const lifecycleRows = () => (window as unknown as { __mirrorFrameLifecycle(): { rows: LifecycleRow[] } }).__mirrorFrameLifecycle().rows;

/** The quad painted in `color` in an admitted list, or null when nothing painted it. */
function quadMatrix(list: DrawList<string>, color: { r: number; g: number; b: number }): readonly number[] | null {
  const view = createQuadView();
  for (let index = 0; index < list.count; index++) {
    if (list.kindNameAt(index) !== "quad") continue;
    list.readQuad(index, view);
    if (view.r === color.r && view.g === color.g && view.b === color.b) return Array.from(view.m as unknown as ArrayLike<number>);
  }
  return null;
}

/** The idle loop's latest group pose (`anim:<root>`) in the log. */
function animPose(log: Submission[], root: string): readonly number[] | null {
  let pose: readonly number[] | null = null;
  for (const entry of log) {
    const group = entry.patch?.groups?.find((candidate) => candidate.id === `anim:${root}`);
    if (group) pose = group.transform;
  }
  return pose;
}

/** `node`'s drawn matrix after the whole log: the last admission, with every later patch's primitive applied. */
function drawnMatrix(log: Submission[], node: string, color: { r: number; g: number; b: number }): readonly number[] | null {
  let matrix: readonly number[] | null = null;
  for (const entry of log) {
    if (entry.call === "admit") matrix = quadMatrix(entry.list!, color);
    const patched = entry.patch?.primitives.find((primitive) => primitive.id.startsWith(`${node}:`));
    if (patched?.transform) matrix = patched.transform;
  }
  return matrix;
}

type SetupOptions = SceneOptions & { pinned?: number; fakeClock?: boolean };

async function setup(query: string, options: SetupOptions = {}) {
  window.history.replaceState(null, "", `/?rendererCompare=1&stage=rust${query ? `&${query}` : ""}`);
  Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
  if (options.pinned !== undefined) vi.stubGlobal("__benchDiagnosticClockMs", options.pinned);
  const measureText = (value: string) => ({ width: value.length * 10, fontBoundingBoxAscent: 16, fontBoundingBoxDescent: 4,
    actualBoundingBoxAscent: 16, actualBoundingBoxDescent: 4 });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ font: "", measureText } as never);
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout", "setInterval",
    "clearInterval", ...(options.fakeClock ? ["performance" as const] : [])] });
  const log: Submission[] = [];
  const control: Control = { sync: false };
  const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
    undefined, { backend: "rust", createExecutor: async () => recordingExecutor(log, control) as never });
  const state: MirrorState = createMirrorState();
  const rows = sceneNodes(options);
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "combat", upserts: rows,
    orderedIds: rows.map((row) => row.id as string) })!);
  if (options.wide) renderer.setStretch(WIDE);
  renderer.setStaticBackgroundSource!({ scenePath: "res://scenes/backgrounds/glade/glade_background.tscn", url: "/bg/glade.png" }, () => {});
  expect(renderer.reconcile(state)).toBe(false);
  await drain();
  if (renderer.reconcile(state) === false) { await drain(); renderer.reconcile(state); }
  await drain();
  expect(diagnostics().readiness).toBe("ready");
  control.sync = true;
  const delta = (upserts: Array<Record<string, unknown>>, hints: unknown[] = []) =>
    applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "combat", upserts, hints })!);
  const move = (x: number, y: number) => delta([{ id: "eyeSlot", parentId: "stage", visible: true, transform: xf([1, 0, 0, 1, x, y]) }]);
  // A real producer resends a node's whole volatile-field set on every upsert that touches it.
  const flipVisible = () => delta([{ id: "eyeFire", parentId: "eyeSlot", visible: true, transform: xf(I),
    localRect: box(40, 40), fillColor: EYE_FIRE_COLOR }]);
  const rotate = (theta: number) => delta([{ id: "eyeSlot", parentId: "stage", visible: true, transform: xf(rot(theta, 500, 400)) }]);
  const rotateWithOther = (theta: number, otherX: number) => delta([
    { id: "eyeSlot", parentId: "stage", visible: true, transform: xf(rot(theta, 500, 400)) },
    { id: "other", parentId: "stage", visible: true, transform: xf([1, 0, 0, 1, otherX, 300]), localRect: box(30, 30), fillColor: OTHER_COLOR },
  ]);
  const moveSingular = () => delta([{ id: "eyeSlot", parentId: "stage", visible: true, transform: xf([0, 0, 0, 0, 500, 400]) }]);
  const moveBoth = (x: number, y: number) => delta([
    { id: "eyeSlot", parentId: "stage", visible: true, transform: xf([1, 0, 0, 1, x, y]) },
    { id: "eyeFire", parentId: "eyeSlot", visible: false, transform: xf([1, 0, 0, 1, 5, 5]), localRect: box(40, 40), fillColor: EYE_FIRE_COLOR },
  ]);

  // The view's own reconcile lane, as MirrorView wires it: a delta books a render rAF the scheduler may pull into its
  // tick. Every reconcile result is recorded.
  const results: Array<ReturnType<typeof renderer.reconcile>> = [];
  let renderRaf = 0;
  const runView = () => { const result = renderer.reconcile(state); results.push(result); return result; };
  renderer.setReconcilePull!({
    pending: () => renderRaf !== 0,
    now: () => { cancelAnimationFrame(renderRaf); renderRaf = 0; runView(); },
  });
  const arrive = (apply: () => void) => {
    apply();
    if (renderRaf === 0) renderRaf = requestAnimationFrame(() => { renderRaf = 0; runView(); });
  };
  const frame = async () => { vi.advanceTimersToNextFrame(); await drain(); };
  return { renderer, state, log, control, delta, move, flipVisible, rotate, rotateWithOther, moveSingular, moveBoth,
    arrive, frame, results };
}

describe("skipping undrawn wire deltas (rustSkipUndrawnWire)", () => {
  beforeEach(() => { document.body.replaceChildren(); });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
  });

  it("applies transform-only moves on an invisible subtree with no patch, present or build", async () => {
    const h = await setup("");
    const before = h.log.length;
    const identity = diagnostics().frameIdentity!;
    for (const [x, y] of [[520, 420], [540, 440], [560, 460]] as const) {
      h.move(x, y);
      expect(h.renderer.reconcile(h.state)).toBe("applied");
    }
    expect(h.log.slice(before)).toEqual([]);
    expect(skipStats().skipped).toBe(3);
    // The committed revision moves on; the presented frame does not.
    const after = diagnostics().frameIdentity!;
    expect(after.revision).toBe(h.state.revision);
    expect([after.presentEpoch, after.clock, after.buildEpoch]).toEqual([identity.presentEpoch, identity.clock, identity.buildEpoch]);
    h.renderer.dispose();
  });

  // The idle-combat case the switch exists for: an idle loop is visible on every frame.
  it("skips an undrawn delta while an idle loop is visible, and idle frames keep presenting every display frame", async () => {
    const h = await setup("rustDiagnostics=1", { pulse: true });
    expect(diagnostics().draw.frameSampleMask).not.toBe(0);
    for (let i = 0; i < 3; i++) await h.frame();
    const before = h.log.length, epoch = diagnostics().frameIdentity!.presentEpoch;
    const frames = 8;
    for (let i = 0; i < frames; i++) {
      h.arrive(() => h.move(500 + i, 400));
      await h.frame();
    }
    // Every delta was pulled into the scheduler's tick and only applied there; the tick then drew its own frame.
    expect(h.results.slice(-frames)).toEqual(Array(frames).fill("applied"));
    expect(skipStats().skipped).toBe(frames);
    expect(skipStats().appliedPulls).toBe(frames);
    const work = h.log.slice(before);
    // One idle frame per display frame: no wire patch on top, none missing.
    expect(work.length).toBe(frames);
    expect(work.every((entry) => entry.call !== "admit")).toBe(true);
    expect(work.every((entry) => entry.patch?.groups?.some((group) => group.id === "anim:pulse"))).toBe(true);
    expect(diagnostics().frameIdentity!.presentEpoch).toBe(epoch + frames);
    h.renderer.dispose();
  });

  it("draws a drawn tween's settle on the scheduler's next tick while an undrawn delta is skipped", async () => {
    const h = await setup("", { fakeClock: true });
    h.arrive(() => h.delta([], [{ targetId: "other", property: "position", durationMs: 120, trans: "Linear", ease: "In",
      endTransform: [1, 0, 0, 1, 500, 500] }]));
    await h.frame();
    const skippedBefore = skipStats().skipped;
    // A skippable delta lands in every frame until well past the tween's end, settle frame included.
    for (let i = 0; i < 14; i++) {
      h.arrive(() => h.move(500 + i, 400));
      await h.frame();
    }
    expect(skipStats().skipped - skippedBefore).toBeGreaterThan(0);
    // ...pulled into ticks that each drew a tween step (or the settle) after applying it.
    expect(skipStats().appliedPulls).toBeGreaterThan(0);
    const drawn = drawnMatrix(h.log, "other", OTHER_COLOR);
    expect(drawn).not.toBeNull();
    expect(drawn![4]).toBeCloseTo(500, 3);
    expect(drawn![5]).toBeCloseTo(500, 3);
    h.renderer.dispose();
  });

  it("never skips a transform that goes from unset to set", async () => {
    const h = await setup("", { ghost: true });
    const before = h.log.length;
    h.delta([{ id: "ghost", parentId: "stage", visible: true, transform: xf([1, 0, 0, 1, 10, 10]) }]);
    expect(h.renderer.reconcile(h.state)).not.toBe("applied");
    expect(skipStats().skipped).toBe(0);
    expect(skipStats().declines.structure).toBe(1);
    expect(h.log.length).toBeGreaterThan(before);
    h.renderer.dispose();
  });

  // The strict (switch-off) field comparison reads the union of both nodes' keys: a field only the new node
  // carries is a change, not a transform-only move.
  it.each(["", "rustHeldOverridePatch=0"])("never skips a delta that adds a field (%s)", async (query) => {
    const h = await setup(query);
    // Parsed nodes always carry the full key set, so the extra key is written straight into the live map.
    const node = h.state.nodes.get("eyeSlot")!;
    h.state.nodes.set("eyeSlot", { ...node, transform: [1, 0, 0, 1, 520, 420], futureField: 1 } as typeof node);
    h.state.changedIds.add("eyeSlot");
    h.state.revision++;
    expect(h.renderer.reconcile(h.state)).not.toBe("applied");
    expect(skipStats().skipped).toBe(0);
    expect(skipStats().declines["nontransform-change"]).toBe(1);
    h.renderer.dispose();
  });

  it("does not skip an undrawn ancestor of a node a floater was resolved against", async () => {
    const h = await setup("", { wide: true, floater: true });
    h.delta([{ id: "rig", parentId: "stage", visible: true, transform: xf([1, 0, 0, 1, 1340, 400]) }]);
    expect(h.renderer.reconcile(h.state)).not.toBe("applied");
    expect(skipStats().skipped).toBe(0);
    expect(skipStats().declines["wire-spread-owner"]).toBe(1);
    // The control: an unrelated undrawn node on the same widened stage still skips.
    h.move(520, 420);
    expect(h.renderer.reconcile(h.state)).toBe("applied");
    h.renderer.dispose();
  });

  it("loses no idle frame under a pinned diagnostic clock", async () => {
    const run = async (query: string) => {
      const h = await setup(query, { pulse: true, pinned: 1000 });
      await clockAt(1050);
      const drawnAt1050 = diagnostics().frameIdentity!;
      expect(drawnAt1050.clock).toBe(1050);
      h.move(520, 420);
      const result = h.renderer.reconcile(h.state);
      const afterDelta = diagnostics().frameIdentity!;
      // The scheduler's chain at the same pinned instant: the 1050 idle frame is already drawn, nothing to redo.
      await h.frame();
      await clockAt(1100);
      const drawnAt1100 = diagnostics().frameIdentity!;
      const pulse = animPose(h.log, "pulse");
      h.renderer.dispose();
      vi.unstubAllGlobals();
      return { result, drawnAt1050, afterDelta, drawnAt1100, pulse };
    };
    const on = await run("");
    const off = await run("rustSkipUndrawnWire=0");
    expect(on.result).toBe("applied");
    expect(on.afterDelta.presentEpoch).toBe(on.drawnAt1050.presentEpoch);
    expect(on.afterDelta.clock).toBe(1050);
    // The 1100 frame is drawn, at the new revision, with the same pulse pose as the switch-off arm.
    expect(on.drawnAt1100.clock).toBe(1100);
    expect(on.drawnAt1100.revision).toBe(off.drawnAt1100.revision);
    expect(on.drawnAt1100.presentEpoch).toBeGreaterThan(on.afterDelta.presentEpoch);
    expect(on.pulse).not.toBeNull();
    expect(on.pulse).toEqual(off.pulse);
  });

  it("closes the reconcile's frame-lifecycle row as applied", async () => {
    const h = await setup("frameLifecycle=1");
    // Rows are sampled one in sixteen: enough skips that several reconciles are recorded.
    for (let i = 0; i < 48; i++) { h.move(500 + i, 400); expect(h.renderer.reconcile(h.state)).toBe("applied"); }
    const reconciles = lifecycleRows().filter((row) => row.source === "reconcile");
    expect(reconciles.length).toBeGreaterThan(0);
    expect(reconciles.every((row) => row.outcome === "applied")).toBe(true);
    h.renderer.dispose();
  });

  it("poses a node that turns visible mid-stream at the latest transform its skipped moves left", async () => {
    const h = await setup("");
    h.move(111, 222);
    expect(h.renderer.reconcile(h.state)).toBe("applied");
    h.move(333, 444);
    expect(h.renderer.reconcile(h.state)).toBe("applied");
    expect(skipStats().skipped).toBe(2);
    const before = h.log.length;
    h.flipVisible();
    expect(h.renderer.reconcile(h.state)).toBeUndefined();
    const admit = h.log.slice(before).find((entry) => entry.call === "admit");
    expect(admit).toBeDefined();
    const matrix = quadMatrix(admit!.list!, EYE_FIRE_COLOR);
    expect(matrix).not.toBeNull();
    // eyeFire's own local transform is identity, so it draws at eyeSlot's latest (not its first-skipped) position.
    expect(matrix![4]).toBeCloseTo(333, 5);
    expect(matrix![5]).toBeCloseTo(444, 5);
    h.renderer.dispose();
  });

  it("patches every move as before with the switch off", async () => {
    const h = await setup("rustSkipUndrawnWire=0");
    const before = h.log.length;
    h.move(520, 420);
    expect(h.renderer.reconcile(h.state)).toBeUndefined();
    expect(h.log.slice(before).length).toBeGreaterThan(0);
    expect(diagnostics().effective.rustSkipUndrawnWire).toBeUndefined();
    h.renderer.dispose();
  });

  it.each([{}, { pulse: true }, { wide: true, pulse: true }])("under rustFastVerify=1, presents the delta anyway and proves the skip exact (%o)",
    async (options) => {
      const h = await setup("rustFastVerify=1", options);
      const before = h.log.length;
      for (const theta of [0.1, 0.2]) {
        h.rotate(theta);
        expect(h.renderer.reconcile(h.state)).toBeUndefined();
      }
      h.move(520, 420);
      expect(h.renderer.reconcile(h.state)).toBeUndefined();
      // Verify never takes the shortcut: the delta is presented for real, and the shadow is checked at its commit.
      expect(h.log.slice(before).length).toBeGreaterThan(0);
      expect(skipStats().skipped).toBe(0);
      expect(skipStats().verifyRuns).toBe(3);
      expect(skipStats().verifyFirstMismatch).toBeNull();
      expect(skipStats().verifyMismatches).toBe(0);
      h.renderer.dispose();
    });

  it("still takes the retained-patch path on the next clock tick after skipping several moves", async () => {
    const h = await setup("");
    for (const [x, y] of [[520, 420], [540, 440], [560, 460]] as const) {
      h.move(x, y);
      expect(h.renderer.reconcile(h.state)).toBe("applied");
    }
    const before = h.log.length;
    await clockAt(1050);
    const sinceClock = h.log.slice(before);
    expect(sinceClock.some((entry) => entry.call === "admit")).toBe(false);
    expect(sinceClock.some((entry) => entry.call === "patch" || entry.call === "present")).toBe(true);
    h.renderer.dispose();
  });

  // `interactionRuntime` keys its per-build geometry (the cosmetic-offset bank a held card's lift lives in) off the
  // committed SNAPSHOT OBJECT: a skip that replaced the wrapper without carrying it would re-apply the whole lift.
  it("does not re-apply a held card's cosmetic-offset lift after an unrelated skip", async () => {
    const h = await setup("");
    const beforeLift = h.log.length;
    h.renderer.setHeldCard("mover", 0, MOVER_Y, "drag");
    const lifted = drawnMatrix(h.log.slice(beforeLift), "moverFace", MOVER_COLOR);
    expect(lifted?.[5]).toBe(MOVER_Y - HELD_CARD_DRAG_LIFT_PX);
    h.move(520, 420);
    expect(h.renderer.reconcile(h.state)).toBe("applied");
    await clockAt(1050);
    expect(drawnMatrix(h.log, "moverFace", MOVER_COLOR)?.[5]).toBe(MOVER_Y - HELD_CARD_DRAG_LIFT_PX);
    h.renderer.dispose();
  });

  // `retained`'s composed-pose cache must stay current for a skipped node, or a later spread-aware wire patch that
  // re-poses it refuses (`wire-spread-pose`) and builds. Only a linear change exposes it.
  it("does not force a full build for a wire patch after skipping several rotations", async () => {
    const h = await setup("rustProducerReasons=1");
    for (const theta of [0.1, 0.2, 0.3]) {
      h.rotate(theta);
      expect(h.renderer.reconcile(h.state)).toBe("applied");
    }
    const before = h.log.length;
    h.rotateWithOther(0.4, 320);
    expect(h.renderer.reconcile(h.state)).toBeUndefined();
    expect(h.log.slice(before).some((entry) => entry.call === "admit")).toBe(false);
    h.renderer.dispose();
  });

  it("takes the normal path when a parent and its child change in the same delta", async () => {
    const h = await setup("");
    h.moveBoth(520, 420);
    expect(h.renderer.reconcile(h.state)).toBeUndefined();
    expect(skipStats().skipped).toBe(0);
    expect(skipStats().declines["overlapping-span"]).toBe(1);
    h.renderer.dispose();
  });

  it("takes the normal path when a delta mixes drawn and undrawn nodes", async () => {
    const h = await setup("");
    const before = h.log.length;
    h.rotateWithOther(0.1, 320);
    expect(h.renderer.reconcile(h.state)).toBeUndefined();
    expect(skipStats().skipped).toBe(0);
    expect(skipStats().declines.drawn).toBe(1);
    expect(drawnMatrix(h.log.slice(before), "other", OTHER_COLOR)?.[4]).toBeCloseTo(320, 3);
    h.renderer.dispose();
  });

  it("declines the skip when the committed pose cannot be inverted, instead of dropping the move", async () => {
    const h = await setup("");
    h.moveSingular();
    expect(h.renderer.reconcile(h.state)).toBe("applied"); // from an invertible pose onto a singular one
    const before = h.log.length;
    h.move(520, 420); // now the committed ("old") pose is the singular one
    expect(h.renderer.reconcile(h.state)).toBeUndefined();
    expect(skipStats().skipped).toBe(1);
    expect(skipStats().declines.noninvertible).toBe(1);
    expect(h.log.slice(before).length).toBeGreaterThan(0);
    h.renderer.dispose();
  });
});
