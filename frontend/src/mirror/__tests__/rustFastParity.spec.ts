// End-to-end gate for the Rust producer CPU controls (`rustFast` and its items): the same scene stream, delivered
// on the same deterministic clock, must reach the Rust executor as the same submissions with every control off and
// with the controls under test on. The executor here records instead of drawing; nothing else is stubbed out of the
// producer path (build, retained composition, retained patches, wire patches, snapshot publication).
//
// `rustHeldOverridePatch` is the one control that changes the call sequence: it turns full builds into retained
// patches while stale tween overrides are held. Under it the gate is the picture instead: after every submission,
// the last admitted scene with each later patch applied must match the baseline's within float32 rounding.
//
// Add a query to PARITY_QUERIES (or set COUCHCOOP_RUST_FAST_PARITY_QUERY) to gate another combination.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrawList } from "@godot-scene-web/canvas";
import { createClipRectView, createNinePatchView, createQuadView, createTexturedMeshView } from "@godot-scene-web/canvas";
import type { PixiTextRecord } from "@godot-scene-web/canvas/pixi";
import * as rustScene from "@godot-scene-web/canvas/rust-prototype";
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
import { resolveRustFastFlags } from "@/mirror/renderer/pixi/rustFastFlags";
import { readRendererComparisonConfig, rendererComparisonConfig } from "@/mirror/rendererComparison";

const PARITY_QUERIES = [
  "rustFast=0&rustLazyComposition=1&rustOmitStaticPixelCaches=1&rustSnapshotReuse=1&ccPaintOrderReuse=1",
  "rustFast=0&rustLazyComposition=1&rustSnapshotReuse=1&rustFastVerify=1",
  "rustFast=0&rustSceneIndex=1",
  "rustFast=0&rustSceneIndex=1&rustSnapshotReuse=0&rustFastVerify=1",
  "rustFast=1&rustHeldOverridePatch=0",
  "rustFast=1",
  "rustFastVerify=1",
  "",
  ...(process.env.COUCHCOOP_RUST_FAST_PARITY_QUERY ? [process.env.COUCHCOOP_RUST_FAST_PARITY_QUERY] : []),
];

// Captured before any test fakes timers: yielding one real macrotask drains the executor's promise chain.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const turn = () => new Promise<void>((resolve) => realSetTimeout(resolve, 0));

const encodeRustScene = rustScene.encodeRustScene as unknown as (input: Record<string, unknown>) => { scene: unknown };

type Submission = Record<string, unknown> & { call: "admit" | "patch" | "present" };

const I = [1, 0, 0, 1, 0, 0];
const xf = (m: readonly number[]) => ({ xAxis: { x: m[0], y: m[1] }, yAxis: { x: m[2], y: m[3] }, origin: { x: m[4], y: m[5] } });
const box = (w: number, h: number) => ({ position: { x: 0, y: 0 }, size: { x: w, y: h } });
const fill = (html: string) => ({ r: 1, g: 1, b: 1, a: 1, html });
const FONT = { resourcePath: "res://fonts/kreon_regular.ttf" };
const BG_SCENE = "res://scenes/backgrounds/glade/glade_background.tscn";
const label = (text: string) => ({ text: { text, fontSize: 20, textColor: { html: "#ffffffff" } }, font: FONT });

function sceneNodes(rewards: boolean): Array<Record<string, unknown>> {
  const node = (id: string, parentId: string | null, nodeType: string, transform: readonly number[],
    extra: Record<string, unknown> = {}) => ({ id, parentId, name: id, nodeType, visible: true, transform: xf(transform), ...extra });
  const nodes = [
    node("stage", null, "Control", I, { localRect: box(1920, 1080) }),
    // A combat backdrop the static background replaces: its subtree is skipped by the build.
    node("combat", "stage", "Control", I, { name: "CombatSceneContainer", localRect: box(1920, 1080) }),
    node("bgc", "combat", "Control", I, { name: "BgContainer", localRect: box(1920, 1080) }),
    node("bg", "bgc", "ColorRect", I, { sceneFilePath: BG_SCENE, localRect: box(1920, 1080), fillColor: fill("#203040ff") }),
    // An opaque static island with text: a static pixel-cache candidate.
    node("panel", "stage", "ColorRect", [1, 0, 0, 1, 100, 120], { localRect: box(300, 200), fillColor: fill("#336699ff") }),
    node("panelLabel", "panel", "Label", [1, 0, 0, 1, 10, 80], { localRect: box(200, 40), ...label("Panel") }),
    node("panelA", "panel", "ColorRect", [1, 0, 0, 1, 10, 10], { localRect: box(50, 50), fillColor: fill("#aa3333ff") }),
    node("panelB", "panel", "ColorRect", [1, 0, 0, 1, 70, 10], { localRect: box(40, 40), fillColor: fill("#33aa33ff") }),
    // A wire-pinned idle loop: retained local-animation patches.
    node("pulse", "stage", "ColorRect", [1, 0, 0, 1, 500, 500], { localRect: box(40, 40), fillColor: fill("#ffcc00ff"),
      pinnedLoopAnim: "mapPointPulse" }),
    // Position tweens: transform overrides until the wire pose arrives, so every frame is a full build.
    node("mover", "stage", "ColorRect", [1, 0, 0, 1, 700, 300], { localRect: box(120, 80), fillColor: fill("#8844ccff") }),
    node("moverHit", "mover", "Control", [1, 0, 0, 1, 10, 10], { name: "Hitbox", localRect: box(100, 60), mouseFilter: 0 }),
    node("moverLabel", "mover", "Label", [1, 0, 0, 1, 0, 90], { localRect: box(120, 30), ...label("Move") }),
    // An opacity tween: retained alpha patches.
    node("fader", "stage", "ColorRect", [1, 0, 0, 1, 1200, 600], { localRect: box(160, 90), fillColor: fill("#cc8844ff") }),
    node("faderLabel", "fader", "Label", I, { localRect: box(160, 30), ...label("Fade") }),
    // A box-less group whose volatile transform upsert is admitted as a retained wire patch.
    node("orbit", "stage", "Node2D", [1, 0, 0, 1, 1500, 200]),
    node("orbitDot", "orbit", "ColorRect", I, { localRect: box(30, 30), fillColor: fill("#ffffffff") }),
    node("orbitLabel", "orbit", "Label", [1, 0, 0, 1, 0, 40], { localRect: box(100, 30), ...label("Orbit") }),
    node("orbitDot2", "orbit", "ColorRect", [1, 0, 0, 1, 40, 0], { localRect: box(30, 30), fillColor: fill("#eeeeeeff") }),
    node("orbitHit", "orbit", "Control", I, { name: "Hitbox", localRect: box(70, 30), mouseFilter: 0 }),
    // A hand holder, present on every step (R2-P3 `rustSceneIndex`): exercises `handPresent`'s candidate scan
    // on every tick, not just the reward steps below.
    node("hand", "stage", "NPlayerHand", I, { localRect: box(400, 300) }),
    node("holder", "hand", "NHandCardHolder", [1, 0, 0, 1, 700, 900], { localRect: box(200, 300) }),
    node("holderHit", "holder", "Control", I, { name: "Hitbox", localRect: box(200, 300), mouseFilter: 0 }),
  ];
  if (rewards) nodes.push(
    node("rewards", "stage", "NRewardsScreen", [1, 0, 0, 1, 800, 200], { localRect: box(400, 500) }),
    node("rowA", "rewards", "NRewardButton", I, { localRect: box(400, 80), fillColor: fill("#444444ff") }),
    node("rowAHit", "rowA", "Control", I, { name: "Hitbox", localRect: box(400, 80), mouseFilter: 0 }),
    node("rowB", "rewards", "NRewardButton", [1, 0, 0, 1, 0, 100], { localRect: box(400, 80), focused: true, fillColor: fill("#555555ff") }),
    node("rowBHit", "rowB", "Control", I, { name: "Hitbox", localRect: box(400, 80), mouseFilter: 0 }),
    // A full-stage opaque curtain painted AFTER the reward rows (a later `stage` child): exercises `coverAbove`'s
    // candidate scan actually finding a cover (R2-P3 `rustSceneIndex`), not just agreeing on an empty miss.
    node("coverCurtain", "stage", "ColorRect", I, { localRect: box(1920, 1080), fillColor: fill("#000000cc") }),
  );
  return nodes;
}

function keyframe(state: MirrorState, rewards: boolean): void {
  const upserts = sceneNodes(rewards);
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "combat", upserts,
    orderedIds: upserts.map((node) => node.id as string) })!);
}

function delta(state: MirrorState, upserts: Array<Record<string, unknown>>, hints: unknown[] = []): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "combat", upserts, hints })!);
}

const positionHint = (targetId: string, end: readonly number[], durationMs: number) =>
  ({ targetId, property: "position", durationMs, trans: "Expo", ease: "Out", endTransform: [...end] });

function dumpList(list: DrawList<string>): unknown[] {
  const views = { quad: createQuadView(), ninePatch: createNinePatchView(), texturedMesh: createTexturedMeshView(64, 96),
    clipPush: createClipRectView() };
  const copy = (view: object) => Object.fromEntries(Object.entries(view).map(([key, value]) =>
    [key, ArrayBuffer.isView(value) ? Array.from(value as Float32Array) : value]));
  return Array.from({ length: list.count }, (_, index) => {
    const kind = list.kindNameAt(index);
    const view = kind === "quad" ? list.readQuad(index, views.quad)
      : kind === "ninePatch" ? list.readNinePatch(index, views.ninePatch)
        : kind === "texturedMesh" ? list.readTexturedMesh(index, views.texturedMesh)
          : kind === "clipPush" ? list.readClipRect(index, views.clipPush) : null;
    return { kind, texture: list.textureAt(index), view: view ? copy(view) : null };
  });
}

/** Whether the recording executor advertises clip translation (`translatesClips`), as the Rust executor does. */
let executorTranslatesClips = true;

function recordingExecutor(log: Submission[]) {
  const stats = { completedFrames: 0, frames: 0, resourcePending: 0, textureFailures: 0, textures: 0,
    contextReady: true, presentationValid: false, objects: 0 };
  const settle = () => { stats.frames++; stats.completedFrames++; stats.presentationValid = true;
    return Promise.resolve({ presented: true }); };
  return {
    stats, app: { renderer: {} }, resize: () => { stats.presentationValid = false; }, dispose: () => {},
    textureSize: () => null, prefetch: () => {}, textureFailureDetails: () => [], setTraceFrameId: () => {},
    bindPixelTexture: () => {}, pollDiagnostics: () => {},
    textOutcomes: () => ({ requested: "native", actual: "native", native: 0, slug: 0, slugCached: 0, reasons: {} }),
    render: () => { throw new Error("the retained Rust path never submits a legacy render"); },
    admitScene: (list: DrawList<string>, texts: readonly PixiTextRecord[], plan: unknown) => {
      const encoded = encodeRustScene({ drawList: list, revision: 1, width: 1920, height: 1080, designWidth: 1920,
        designHeight: 1080, resolveTexture: (texture: string) => ({ key: texture, width: 64, height: 64 }), texts, plan,
        resolveText: (record: PixiTextRecord) => ({ resource: { key: `text:${record.key}`, width: 4, height: 4 },
          pixels: new Uint8Array(64), width: 4, height: 4, transform: record.transform, alpha: record.alpha }) });
      log.push({ call: "admit", encoded: JSON.stringify(encoded.scene), list: dumpList(list),
        texts: structuredClone(texts), plan: structuredClone(plan) });
      return settle();
    },
    patchScene: (patch: unknown) => { log.push({ call: "patch", patch: structuredClone(patch) }); return settle(); },
    presentScene: () => { log.push({ call: "present" }); return settle(); },
    translatesClips: executorTranslatesClips,
  };
}

function stage(): HTMLElement {
  const element = document.createElement("div");
  Object.defineProperties(element, { clientWidth: { value: 1920 }, clientHeight: { value: 1080 } });
  element.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1920, bottom: 1080, width: 1920, height: 1080, toJSON() {} });
  document.body.append(element);
  return element;
}

type Diagnostics = { draw: Record<string, number>; effective: Record<string, unknown>; frameIdentity: unknown;
  asyncSubmissionRevision: number | null; readiness: string; failure?: string };
const diagnostics = () => (window as unknown as { __mirrorRendererDiagnostics(): Diagnostics }).__mirrorRendererDiagnostics();
const clockAt = (ms: number) => (window as unknown as { __mirrorSetDiagnosticClock(ms: number): Promise<unknown> })
  .__mirrorSetDiagnosticClock(ms);

/** What a scenario script drives: the scene, plus one reconcile (`offer`) or one clock frame (`tick`) per step. */
type ScenarioContext = { state: MirrorState; renderer: ReturnType<typeof createPixiMirrorRenderer>;
  offer(step: string): Promise<void>; tick(step: string, at: number): Promise<void> };
type HiddenMemoDiagnostics = { builds: number; bypassedBuilds: number; hits: number; replayedNodes: number;
  verified: number; verifyMismatches: number; missReasons: Record<string, number> };
type HeldOverrideDiagnostics = { heldOverridePatches: number; heldOverrideDeclines: Record<string, number>;
  heldOverrideVerifyRuns?: number; heldOverrideVerifyMismatches?: number; heldOverrideVerifyMaxError?: number;
  heldOverrideVerifyFirstMismatch?: string | null };

async function runScenario(query: string, script?: (context: ScenarioContext) => Promise<void>) {
  window.history.replaceState(null, "", `/?rendererCompare=1&stage=rust&rustDiagnostics=1${query ? `&${query}` : ""}`);
  Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
  vi.stubGlobal("__benchDiagnosticClockMs", 1000);
  const measureText = (value: string) => ({ width: value.length * 10, fontBoundingBoxAscent: 16, fontBoundingBoxDescent: 4,
    actualBoundingBoxAscent: 16, actualBoundingBoxDescent: 4 });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ font: "", measureText } as never);
  // Only the steps below may produce frames: no animation-frame, park or texture wake runs on its own.
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const log: Submission[] = [];
  const steps: unknown[] = [];
  const renderer = createPixiMirrorRenderer(stage(), document.createElementNS("http://www.w3.org/2000/svg", "defs"), null,
    undefined, { backend: "rust", createExecutor: async () => recordingExecutor(log) as never });
  const state = createMirrorState();
  const observe = (step: string, result: unknown) => {
    const rects = renderer.interactiveRects().map(({ id, transform, localRect, spreadDx, renderedWidth, raiseDy }) =>
      ({ id, transform: [...transform], localRect, spreadDx, renderedWidth, raiseDy }));
    // Asked twice: the second answer for an unchanged picture must equal the first.
    steps.push({ step, result, submissions: log.length, identity: diagnostics().frameIdentity,
      reward: [renderer.rewardFocusSnapshot(), renderer.rewardFocusSnapshot()], rects,
      // handPresent/coverAbove (R2-P3 `rustSceneIndex`): the hand holder is present every step, the curtain only
      // once rewards are on screen, so this exercises both a steady hit and a hit/miss transition.
      hand: renderer.handPresent(), cover: renderer.coverAbove("rowA") });
  };
  // A reconcile whose presentation is still in flight is re-offered once it settles, as the view does.
  const offer = async (step: string) => {
    const first = renderer.reconcile(state);
    if (first !== false) return observe(step, [first]);
    await turn();
    expect(diagnostics().asyncSubmissionRevision).toBeNull();
    observe(step, [first, renderer.reconcile(state)]);
  };
  const tick = async (step: string, at: number) => observe(step, await clockAt(at));
  const finish = () => {
    const final = diagnostics();
    expect(final.readiness).toBe("ready");
    expect(final.failure).toBeUndefined();
    return { log, steps, draw: final.draw, held: final.effective.rustHeldOverride as HeldOverrideDiagnostics | undefined,
      memo: final.effective.rustHiddenMemo as HiddenMemoDiagnostics | undefined, offsets: final.effective.rustOffsetPatch };
  };
  try {
    if (script) {
      await script({ state, renderer, offer, tick });
      return finish();
    }
    keyframe(state, false);
    renderer.setStaticBackgroundSource!({ scenePath: BG_SCENE, url: "/bg/glade.png" }, () => {});
    expect(renderer.reconcile(state)).toBe(false);
    await turn();
    await offer("startup");
    for (const at of [1050, 1100]) await tick(`pulse@${at}`, at);
    const moverAt = (m: readonly number[]) => sceneNodes(false).map((row) => row.id === "mover" ? { ...row, transform: xf(m) } : row)
      .filter((row) => row.id === "mover");
    delta(state, [], [positionHint("mover", [1, 0, 0, 1, 760, 340], 300)]);
    await offer("tween");
    for (const at of [1150, 1200, 1250, 1300, 1350, 1400]) await tick(`tween@${at}`, at);
    delta(state, moverAt([1, 0, 0, 1, 760, 340]));
    await offer("tween-landed");
    for (const at of [1450, 1500]) await tick(`settled@${at}`, at);
    delta(state, [], [{ targetId: "fader", property: "modulate:a", durationMs: 200, trans: "Linear", ease: "In", endOpacity: 0.4 }]);
    await offer("fade");
    for (const at of [1550, 1600, 1650, 1700, 1800]) await tick(`fade@${at}`, at);
    delta(state, [{ id: "orbit", parentId: "stage", visible: true, transform: xf([1, 0, 0, 1, 1520, 230]) }]);
    await offer("wire");
    await tick("after-wire", 1850);
    delta(state, [], [positionHint("mover", [1, 0, 0, 1, 700, 300], 200)]);
    await offer("tween-back");
    for (const at of [1900, 1950, 2000, 2050, 2100]) await tick(`tween-back@${at}`, at);
    delta(state, moverAt([1, 0, 0, 1, 700, 300]));
    await offer("tween-back-landed");
    for (const at of [2150, 2200]) await tick(`settled-back@${at}`, at);
    keyframe(state, true);
    await offer("keyframe");
    for (const at of [2350, 2400]) await tick(`rewards@${at}`, at);
    delta(state, [{ id: "orbit", parentId: "stage", visible: true, transform: xf([1, 0, 0, 1, 1490, 210]) }]);
    await offer("wire-rewards");
    await tick("after-wire-rewards", 2450);
    return finish();
  } finally {
    renderer.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
}

/** Static pixel-cache groups are an adapter hint the Rust serializer turns into identity parents. */
function withoutStaticCaches(entry: Submission): Submission {
  if (entry.call !== "admit") return entry;
  const plan = entry.plan as { primitives: Array<{ parentId?: string }>; groups: Array<{ id: string }> };
  const unparent = <T extends { parentId?: string }>(row: T): T => {
    if (!row.parentId?.startsWith("static:")) return row;
    const { parentId: _static, ...rest } = row;
    return rest as T;
  };
  return { ...entry, plan: { primitives: plan.primitives.map(unparent),
    groups: plan.groups.filter(({ id }) => !id.startsWith("static:")) },
    texts: (entry.texts as Array<{ parentId?: string }>).map(unparent) };
}

type PlanPrimitive = { id: string; index: number; parentId?: string };
type PatchPrimitive = { id: string; transform?: number[]; alpha?: number;
  source?: { texture: string | null; x: number; y: number; w: number; h: number } };
const mul = (a: readonly number[], b: readonly number[]) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];

/**
 * The picture after each submission: the last admitted commands and texts with every later patch applied, the way
 * the executor composes them. A patched transform is local to the primitive's group, so a grouped primitive draws
 * at group · own; an alpha patch rescales the premultiplied tint, as a rebuild at that alpha would have written it.
 * Plan structure (groups, static caches, parents) is not part of the picture and is dropped.
 */
function effectiveFrames(log: Submission[]): unknown[] {
  type Command = { kind: string; texture: string | null; view: Record<string, unknown> | null };
  let base: { list: Command[]; texts: Array<Record<string, unknown>>; byIndex: Map<number, PlanPrimitive> } | null = null;
  const patched = new Map<string, PatchPrimitive>();
  const groups = new Map<string, readonly number[]>();
  /** Clip translations since the last admission, by `clipPush` index. */
  const clipShift = new Map<number, [number, number]>();
  return log.map((entry) => {
    if (entry.call === "admit") {
      const plan = entry.plan as { primitives: PlanPrimitive[]; groups: Array<{ id: string; transform: number[] }> };
      base = { list: entry.list as Command[], texts: entry.texts as Array<Record<string, unknown>>,
        byIndex: new Map(plan.primitives.map((primitive) => [primitive.index, primitive])) };
      patched.clear(); groups.clear(); clipShift.clear();
      for (const group of plan.groups) groups.set(group.id, group.transform);
    } else if (entry.call === "patch") {
      const patch = entry.patch as { primitives: PatchPrimitive[]; groups: Array<{ id: string; transform: number[] }> };
      for (const primitive of patch.primitives) patched.set(primitive.id, { ...patched.get(primitive.id), ...primitive });
      for (const group of patch.groups) groups.set(group.id, group.transform);
      for (const clip of (entry.patch as { clips?: Array<{ index: number; dx: number; dy: number }> }).clips ?? []) {
        const shift = clipShift.get(clip.index) ?? [0, 0];
        clipShift.set(clip.index, [shift[0] + clip.dx, shift[1] + clip.dy]);
      }
    }
    if (!base) return null;
    const place = (matrix: readonly number[], parentId: unknown) =>
      typeof parentId === "string" && groups.has(parentId) ? mul(groups.get(parentId)!, matrix) : [...matrix];
    const commands = base.list.map((command, index) => {
      const shift = command.kind === "clipPush" && command.view ? clipShift.get(index) : undefined;
      if (shift) return { kind: command.kind, texture: command.texture,
        view: { ...command.view, x: (command.view!.x as number) + shift[0], y: (command.view!.y as number) + shift[1] } };
      const primitive = base!.byIndex.get(index);
      if (!primitive || !command.view) return { kind: command.kind, texture: command.texture, view: command.view };
      const view = { ...command.view };
      let texture = command.texture;
      const update = patched.get(primitive.id);
      if (update?.transform) view.m = update.transform;
      if (update?.alpha !== undefined) {
        const ratio = (view.a as number) > 0 ? update.alpha / (view.a as number) : 0;
        for (const channel of ["r", "g", "b"]) view[channel] = (view[channel] as number) * ratio;
        view.a = update.alpha;
      }
      if (update?.source) {
        texture = update.source.texture;
        Object.assign(view, { srcX: update.source.x, srcY: update.source.y, srcW: update.source.w, srcH: update.source.h });
      }
      if (Array.isArray(view.m)) view.m = place(view.m as number[], primitive.parentId);
      return { kind: command.kind, texture, view };
    });
    const texts = base.texts.map(({ parentId, ...text }) => {
      const update = patched.get(`text:${text.key as string}`);
      return { ...text, transform: place(update?.transform ?? (text.transform as number[]), parentId),
        ...(update?.alpha !== undefined ? { alpha: update.alpha } : {}) };
    });
    return { commands, texts };
  });
}

/** The first place two values differ, numbers within relative 1e-5 (float32 lists against float64 patches). */
function firstDifference(a: unknown, b: unknown, ignore: ReadonlySet<string> = new Set(), path = "$"): string | null {
  if (typeof a === "number" && typeof b === "number")
    return Object.is(a, b) || Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(a), Math.abs(b)) ? null : `${path}: ${a} vs ${b}`;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object")
    return Object.is(a, b) ? null : `${path}: ${String(a)} vs ${String(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (ignore.has(key)) continue;
    const difference = firstDifference(left[key], right[key], ignore, `${path}.${key}`);
    if (difference) return difference;
  }
  return null;
}

type ScenarioResult = Awaited<ReturnType<typeof runScenario>>;

/**
 * The held-override gate: the same steps (a patch never bumps the build epoch, and its hit poses are composed rather
 * than rebuilt), one submission per baseline submission, an admit wherever the candidate admits, and the same picture
 * after every submission. Returns the positions where a baseline admit became a patch.
 */
function expectSamePicture(candidate: ScenarioResult, baseline: ScenarioResult, omitStaticPixelCaches: boolean): number[] {
  expect(firstDifference(candidate.steps, baseline.steps, new Set(["buildEpoch"]))).toBeNull();
  expect(candidate.log.length).toBe(baseline.log.length);
  const replaced: number[] = [];
  candidate.log.forEach((entry, index) => {
    const expected = baseline.log[index];
    if (entry.call === expected.call) return;
    expect([index, expected.call, entry.call === "admit" ? "admit" : "patch"]).toEqual([index, "admit", "patch"]);
    replaced.push(index);
  });
  candidate.log.forEach((entry, index) => {
    if (entry.call !== "admit") return;
    const expected = baseline.log[index];
    if (omitStaticPixelCaches) expect(withoutStaticCaches(entry)).toEqual(withoutStaticCaches(expected));
    else expect(entry).toEqual(expected);
  });
  const pictures = effectiveFrames(candidate.log), expected = effectiveFrames(baseline.log);
  pictures.forEach((picture, index) => expect([index, firstDifference(picture, expected[index])]).toEqual([index, null]));
  return replaced;
}

describe("Rust producer controls submit the same scene stream", () => {
  beforeEach(() => { document.body.replaceChildren(); });
  afterEach(() => {
    window.history.replaceState(null, "", "/");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
  });

  it.each(PARITY_QUERIES)("with %s", async (query) => {
    const baseline = await runScenario("rustFast=0");
    const candidate = await runScenario(query);
    const flags = resolveRustFastFlags(new URLSearchParams(query), "rust");
    const calls = (log: Submission[], call: Submission["call"]) => log.filter((entry) => entry.call === call).length;

    // The scenario must reach every lane it claims to cover.
    expect(calls(baseline.log, "admit")).toBeGreaterThanOrEqual(12);
    expect(calls(baseline.log, "patch")).toBeGreaterThanOrEqual(8);
    expect(baseline.log.some((entry) => entry.call === "admit" &&
      (entry.plan as { groups: Array<{ id: string }> }).groups.some(({ id }) => id.startsWith("static:")))).toBe(true);
    expect(baseline.log.some((entry) => entry.call === "patch" &&
      (entry.patch as { primitives: Array<{ alpha?: number }> }).primitives.some(({ alpha }) => alpha !== undefined))).toBe(true);
    expect(baseline.steps.some((step) => (step as { reward: Array<{ screenId: string | null }> }).reward[0].screenId === "rewards")).toBe(true);
    expect(baseline.log.some((entry) => entry.call === "patch" && JSON.stringify(entry.patch).includes("text:orbitLabel"))).toBe(true);

    if (flags.heldOverridePatch) {
      // This scenario holds an override after each of its two position tweens, until the landing delta drops it.
      expect(expectSamePicture(candidate, baseline, flags.omitStaticPixelCaches).length).toBeGreaterThan(0);
      expect(candidate.held!.heldOverridePatches).toBeGreaterThan(0);
      if (flags.verify) {
        expect(candidate.held!.heldOverrideVerifyRuns).toBe(candidate.held!.heldOverridePatches);
        expect(candidate.held!.heldOverrideVerifyFirstMismatch ?? null).toBeNull();
        expect(candidate.held!.heldOverrideVerifyMismatches).toBe(0);
      }
    } else {
      expect(candidate.steps).toEqual(baseline.steps);
      expect(candidate.log.map(({ call }) => call)).toEqual(baseline.log.map(({ call }) => call));
      // The serialized scene is compared exactly in every case. The raw plan and text parents are compared exactly
      // too, except that omitting static pixel caches may drop `static:` groups and their parents.
      expect(candidate.log.map((entry) => entry.encoded)).toEqual(baseline.log.map((entry) => entry.encoded));
      if (flags.omitStaticPixelCaches) {
        expect(candidate.log.some((entry) => entry.call === "admit" &&
          (entry.plan as { groups: Array<{ id: string }> }).groups.some(({ id }) => id.startsWith("static:")))).toBe(false);
        expect(candidate.log.map(withoutStaticCaches)).toEqual(baseline.log.map(withoutStaticCaches));
      } else {
        expect(candidate.log).toEqual(baseline.log);
      }
    }

    // Each control under test actually engaged.
    const admits = calls(candidate.log, "admit");
    if (flags.lazyComposition) {
      expect(candidate.draw.lazyCompositionIndexBuilds).toBeGreaterThan(0);
      expect(candidate.draw.lazyCompositionIndexBuilds).toBeLessThan(admits);
      expect(candidate.draw.lazyCompositionVerifyMismatches).toBe(0);
    }
    if (flags.snapshotReuse) {
      expect(candidate.draw.snapshotNodeReuses).toBeGreaterThan(0);
      expect(candidate.draw.staticSkipRootReuses).toBeGreaterThan(0);
      expect(candidate.draw.rewardFocusSkips).toBeGreaterThan(0);
    }
    if (flags.sceneIndex) {
      // Every candidate-restricted / memoized answer agreed with its full-scan twin, every time it was checked.
      expect(candidate.draw.sceneIndexVerifyMismatches).toBe(0);
      // The scenario actually exercised both a hit and a miss for the hand holder and the cover curtain.
      expect(candidate.steps.some((step) => (step as { hand: boolean }).hand === true)).toBe(true);
      expect(candidate.steps.some((step) => (step as { cover: boolean }).cover === true)).toBe(true);
      expect(candidate.steps.some((step) => (step as { cover: boolean }).cover === false)).toBe(true);
    }
    expect(baseline.draw.lazyCompositionIndexBuilds).toBeUndefined();
    expect(baseline.draw.snapshotNodeReuses).toBeUndefined();
    expect(baseline.draw.sceneIndexVerifyMismatches).toBeUndefined();
  });
});

const heldNode = (id: string, parentId: string, nodeType: string, transform: readonly number[],
  extra: Record<string, unknown> = {}) => ({ id, parentId, name: id, nodeType, visible: true, transform: xf(transform), ...extra });
const WHITE = { html: "#ffffffff" };

/**
 * The parity scene plus three held-override subjects: a tween lineage (deck > card > art, label, hitbox, and a
 * pulsing gem that animates under the override), a volatile group whose upserts rebuild their colour objects (eye),
 * and an idle-pulsing holder with a child (beacon).
 */
function heldSceneNodes(): Array<Record<string, unknown>> {
  return [...sceneNodes(false),
    heldNode("deck", "stage", "Node2D", [1, 0, 0, 1, 300, 650]),
    heldNode("card", "deck", "Control", I, { localRect: box(150, 200) }),
    heldNode("cardArt", "card", "ColorRect", [1, 0, 0, 1, 10, 10], { localRect: box(130, 150), fillColor: fill("#aa66ccff") }),
    heldNode("cardLabel", "card", "Label", [1, 0, 0, 1, 10, 165], { localRect: box(130, 30), ...label("Card") }),
    heldNode("cardHit", "card", "Control", I, { name: "Hitbox", localRect: box(150, 200), mouseFilter: 0 }),
    heldNode("cardGem", "card", "ColorRect", [1, 0, 0, 1, 60, 40], { localRect: box(30, 30), fillColor: fill("#ffee55ff"),
      pinnedLoopAnim: "mapPointPulse" }),
    heldNode("eye", "stage", "Node2D", [1, 0, 0, 1, 1700, 900], { modulate: WHITE, selfModulate: WHITE }),
    heldNode("eyeDot", "eye", "ColorRect", I, { localRect: box(24, 24), fillColor: fill("#ff3333ff"), modulate: WHITE }),
    heldNode("eyeLabel", "eye", "Label", [1, 0, 0, 1, 0, 30], { localRect: box(80, 30), ...label("Eye") }),
    heldNode("eyeHit", "eye", "Control", I, { name: "Hitbox", localRect: box(24, 24), mouseFilter: 0 }),
    heldNode("beacon", "stage", "Control", [1, 0, 0, 1, 900, 820], { localRect: box(40, 40), pinnedLoopAnim: "mapPointPulse" }),
    heldNode("beaconCore", "beacon", "ColorRect", [1, 0, 0, 1, 10, 10], { localRect: box(20, 20), fillColor: fill("#33ccffff") }),
  ];
}

/** One keyframe row with a new transform: every other field equal by value, as the producer re-sends it. */
const heldRowAt = (id: string, m: readonly number[]) => ({ ...heldSceneNodes().find((row) => row.id === id)!, transform: xf(m) });
/** The eye's volatile upsert: no static fields, and fresh colour objects every time. */
const eyeAt = (x: number, y: number) => ({ id: "eye", parentId: "stage", visible: true, transform: xf([1, 0, 0, 1, x, y]),
  modulate: { ...WHITE }, selfModulate: { ...WHITE } });

async function heldScript({ state, renderer, offer, tick }: ScenarioContext): Promise<void> {
  const rows = heldSceneNodes();
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "combat", upserts: rows,
    orderedIds: rows.map((row) => row.id as string) })!);
  renderer.setStaticBackgroundSource!({ scenePath: BG_SCENE, url: "/bg/glade.png" }, () => {});
  expect(renderer.reconcile(state)).toBe(false);
  await turn();
  await offer("startup");
  await tick("pulse@1050", 1050);
  // The card tween ends at 1250 and nothing upserts the card afterwards: its endpoint stays as a held override.
  delta(state, [], [positionHint("card", [1, 0, 0, 1, 340, 600], 200)]);
  await offer("card-tween");
  for (const at of [1100, 1150, 1200, 1250]) await tick(`card-tween@${at}`, at);
  for (const at of [1300, 1350]) await tick(`held@${at}`, at);
  for (const [index, x] of [1720, 1745, 1760].entries()) {
    delta(state, [eyeAt(x, 900 - index * 10)]);
    await offer(`eye-${index}`);
  }
  await tick("held-eye@1400", 1400);
  // Wire changes under and above the held override fall back to full builds; each build banks the override again.
  delta(state, [heldRowAt("cardArt", [1, 0, 0, 1, 14, 12])]);
  await offer("under");
  await tick("held-after-under@1450", 1450);
  delta(state, [heldRowAt("deck", [1, 0, 0, 1, 310, 640])]);
  await offer("above");
  await tick("held-after-above@1500", 1500);
  // A second override arrives through its own tween and is held beside the first.
  delta(state, [], [positionHint("panel", [1, 0, 0, 1, 130, 150], 100)]);
  await offer("panel-tween");
  for (const at of [1550, 1600]) await tick(`panel-tween@${at}`, at);
  await tick("held-two@1650", 1650);
  delta(state, [eyeAt(1700, 880)]);
  await offer("eye-two");
  // The producer lands the panel where its tween ended. The upsert drops the panel's override, so the bank no
  // longer matches: the panel was drawn at the override, and the streamed delta does not start from there.
  delta(state, [heldRowAt("panel", [1, 0, 0, 1, 130, 150])]);
  await offer("on");
  await tick("held-one@1700", 1700);
  // An override under an idle-pulsing holder: the holder's patch would carry the overridden child along.
  delta(state, [], [positionHint("beaconCore", [1, 0, 0, 1, 930, 850], 100)]);
  await offer("beacon-tween");
  for (const at of [1750, 1800]) await tick(`beacon-tween@${at}`, at);
  await tick("beacon-held@1850", 1850);
  await tick("beacon-held@1900", 1900);
}

describe("held transform overrides (rustHeldOverridePatch)", () => {
  beforeEach(() => { document.body.replaceChildren(); });
  afterEach(() => {
    window.history.replaceState(null, "", "/");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
  });

  const HELD_QUERIES = ["rustFast=0&rustHeldOverridePatch=1", "rustFast=0&rustHeldOverridePatch=1&rustFastVerify=1", "", "rustFastVerify=1"];

  it.each(HELD_QUERIES)("patch held overrides and match the full-build picture with %s", async (query) => {
    const baseline = await runScenario("rustFast=0", heldScript);
    const candidate = await runScenario(query, heldScript);
    const flags = resolveRustFastFlags(new URLSearchParams(query), "rust");
    const callAt = (result: ScenarioResult, name: string) => {
      const index = result.steps.findIndex((step) => (step as { step: string }).step === name);
      const before = index > 0 ? (result.steps[index - 1] as { submissions: number }).submissions : 0;
      const after = (result.steps[index] as { submissions: number }).submissions;
      expect([name, after - before]).toEqual([name, 1]);
      return result.log[after - 1].call === "admit" ? "admit" : "patch";
    };

    const replaced = expectSamePicture(candidate, baseline, flags.omitStaticPixelCaches);
    const patched = ["held@1300", "held@1350", "eye-0", "eye-1", "eye-2", "held-eye@1400", "held-after-under@1450",
      "held-after-above@1500", "held-two@1650", "eye-two", "held-one@1700"];
    const rebuilt = ["under", "above", "on", "beacon-held@1850", "beacon-held@1900"];
    for (const step of [...patched, ...rebuilt]) expect([step, callAt(baseline, step)]).toEqual([step, "admit"]);
    for (const step of patched) expect([step, callAt(candidate, step)]).toEqual([step, "patch"]);
    for (const step of rebuilt) expect([step, callAt(candidate, step)]).toEqual([step, "admit"]);
    expect(replaced.length).toBe(patched.length);
    // A held patch re-poses the gem that pulses under the override, against the override the build applied.
    const held1300 = (candidate.steps.find((row) => (row as { step: string }).step === "held@1300") as { submissions: number }).submissions - 1;
    expect(JSON.stringify(candidate.log[held1300])).toContain("cardGem:quad:0");
    // The coloured upserts reached the executor as wire patches that moved the eye's dot, label and hitbox.
    for (const step of ["eye-0", "eye-1", "eye-2", "eye-two"]) {
      const index = (candidate.steps.find((row) => (row as { step: string }).step === step) as { submissions: number }).submissions - 1;
      expect(JSON.stringify(candidate.log[index])).toContain("eyeDot:quad:0");
      expect(JSON.stringify(candidate.log[index])).toContain("text:eyeLabel");
    }

    const held = candidate.held!;
    expect(held.heldOverridePatches).toBe(patched.length);
    expect(held.heldOverrideDeclines["wire-under-override"]).toBe(2);
    expect(held.heldOverrideDeclines["anim-over-override"]).toBe(2);
    expect(held.heldOverrideDeclines["transform-overrides"]).toBeGreaterThanOrEqual(1);
    if (flags.verify) {
      expect(held.heldOverrideVerifyRuns).toBe(held.heldOverridePatches);
      expect(held.heldOverrideVerifyFirstMismatch).toBeNull();
      expect(held.heldOverrideVerifyMismatches).toBe(0);
      expect(held.heldOverrideVerifyMaxError).toBeGreaterThan(0);
      expect(held.heldOverrideVerifyMaxError).toBeLessThan(1e-3);
    }
    expect(baseline.held).toBeUndefined();
  });

  // The landing delta drops the last override. The committed build still drew the node at that override, so the
  // streamed delta does not start where the picture is; only a bank that remembers the override can refuse it.
  it.each(["rustFast=0&rustHeldOverridePatch=1&rustFastVerify=1", ""])("rebuild when a landing drops the last override with %s", async (query) => {
    const result = await runScenario(query, async ({ state, renderer, offer, tick }) => {
      const rows = [...sceneNodes(false), heldNode("slot", "stage", "Node2D", [1, 0, 0, 1, 1000, 500]),
        heldNode("slotDot", "slot", "ColorRect", I, { localRect: box(20, 20), fillColor: fill("#ff0000ff") })];
      applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "combat", upserts: rows,
        orderedIds: rows.map((row) => row.id as string) })!);
      renderer.setStaticBackgroundSource!({ scenePath: BG_SCENE, url: "/bg/glade.png" }, () => {});
      expect(renderer.reconcile(state)).toBe(false);
      await turn();
      await offer("startup");
      delta(state, [], [positionHint("slot", [1, 0, 0, 1, 1040, 520], 100)]);
      await offer("tween");
      for (const at of [1050, 1100, 1150]) await tick(`tween@${at}`, at);
      await tick("held@1200", 1200);
      delta(state, [{ id: "slot", parentId: "stage", visible: true, transform: xf([1, 0, 0, 1, 1040, 520]) }]);
      await offer("land");
      await tick("after@1250", 1250);
    });
    const at = (name: string) => (result.steps.find((row) => (row as { step: string }).step === name) as { submissions: number }).submissions - 1;
    const frames = effectiveFrames(result.log) as Array<{ commands: Array<{ texture: string | null; view: { m?: number[] } | null }> }>;
    const dot = (index: number) => frames[index].commands.filter((command) => command.view?.m &&
      command.view.m[4] >= 1000 && command.view.m[4] < 1100 && command.view.m[5] >= 480 && command.view.m[5] < 560).map((command) => command.view!.m);
    expect(result.log[at("held@1200")].call).not.toBe("admit");
    expect(result.log[at("land")].call).toBe("admit");
    expect(dot(at("land"))).toEqual([[1, 0, 0, 1, 1040, 520]]);
    expect(dot(at("after@1250"))).toEqual([[1, 0, 0, 1, 1040, 520]]);
    expect(result.held!.heldOverrideDeclines["transform-overrides"]).toBeGreaterThanOrEqual(1);
    if (result.held!.heldOverrideVerifyRuns !== undefined) expect(result.held!.heldOverrideVerifyMismatches).toBe(0);
  });

  // A build skips a node whose own opacity is at or below the paint threshold (0.02), so an opacity patch that
  // carries a node across it would keep records a build drops (fading out) or miss a node a build draws (fading
  // in). Both happen here under a held override, where the rustFast=0 baseline rebuilds every frame.
  it.each(["rustFast=0&rustHeldOverridePatch=1&rustFastVerify=1", ""])("rebuild when a fade crosses the paint threshold with %s", async (query) => {
    const script = async ({ state, renderer, offer, tick }: ScenarioContext) => {
      const rows = heldSceneNodes();
      applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "combat", upserts: rows,
        orderedIds: rows.map((row) => row.id as string) })!);
      renderer.setStaticBackgroundSource!({ scenePath: BG_SCENE, url: "/bg/glade.png" }, () => {});
      expect(renderer.reconcile(state)).toBe(false);
      await turn();
      await offer("startup");
      delta(state, [], [positionHint("card", [1, 0, 0, 1, 340, 600], 200)]);
      await offer("card-tween");
      for (const at of [1100, 1200, 1250]) await tick(`card-tween@${at}`, at);
      await tick("held@1300", 1300);
      delta(state, [], [{ targetId: "fader", property: "modulate:a", durationMs: 200, trans: "Linear", ease: "In", endOpacity: 0 }]);
      await offer("fade-out");
      for (const at of [1350, 1400, 1450, 1495, 1499, 1500, 1550]) await tick(`fade-out@${at}`, at);
      delta(state, [], [{ targetId: "fader", property: "modulate:a", durationMs: 300, trans: "Expo", ease: "In",
        startOpacity: 0, endOpacity: 1 }]);
      await offer("fade-in");
      for (const at of [1650, 1700, 1750, 1800, 1850, 1900, 1950]) await tick(`fade-in@${at}`, at);
    };
    const baseline = await runScenario("rustFast=0", script);
    const candidate = await runScenario(query, script);
    const flags = resolveRustFastFlags(new URLSearchParams(query), "rust");
    expectSamePicture(candidate, baseline, flags.omitStaticPixelCaches);
    const steps = (result: ScenarioResult) => new Map(result.steps.map((row) => {
      const { step, submissions } = row as { step: string; submissions: number };
      return [step, result.log[submissions - 1]] as const;
    }));
    const calls = steps(candidate);
    // The fade itself still patches on either side of the threshold; the crossings rebuild.
    expect(["fade-out@1350", "fade-out@1400", "fade-in@1850"].map((step) => calls.get(step)!.call)).toEqual(["patch", "patch", "patch"]);
    expect(JSON.stringify(calls.get("fade-out@1400"))).toContain('"alpha"');
    expect(calls.get("fade-out@1499")!.call).toBe("admit");
    expect(candidate.held!.heldOverrideDeclines["opacity-paint-threshold"]).toBeGreaterThanOrEqual(2);
    if (flags.verify) {
      expect(candidate.held!.heldOverrideVerifyFirstMismatch).toBeNull();
      expect(candidate.held!.heldOverrideVerifyMismatches).toBe(0);
    }
  });
});

// A WIDENED stage (`rustHiddenMemoSpread`): the parity scene on an anchored stage root, plus a hidden drawer whose
// subtree takes the anchor, box-child, pass-through and positional spread branches. The script stretches the stage
// before the first frame, changes the drawer while it is hidden, shows and hides it, and turns the stretch off and on.
const WIDE = 1.3125;

function wideSceneNodes(): Array<Record<string, unknown>> {
  const rows = sceneNodes(false).map((row) => row.id === "stage" ? { ...row, anchorLeft: 0, anchorRight: 1 } : row);
  const node = (id: string, parentId: string, nodeType: string, transform: readonly number[], extra: Record<string, unknown> = {}) =>
    ({ id, parentId, name: id, nodeType, visible: true, transform: xf(transform), ...extra });
  rows.push(
    node("drawer", "stage", "Control", I, { visible: false, anchorLeft: 0, anchorRight: 1, localRect: box(1920, 1080) }),
    node("drawerRow", "drawer", "HBoxContainer", [1, 0, 0, 1, 200, 700], { anchorLeft: 0, anchorRight: 1,
      containerLayout: "hbox-center", localRect: box(800, 120) }),
    node("drawerA", "drawerRow", "ColorRect", I, { localRect: box(100, 100), fillColor: fill("#22aa88ff") }),
    node("drawerB", "drawerRow", "ColorRect", [1, 0, 0, 1, 120, 0], { localRect: box(100, 100), fillColor: fill("#2288aaff") }),
    node("drawerLabel", "drawerRow", "Label", [1, 0, 0, 1, 240, 0], { localRect: box(200, 40), ...label("Drawer") }),
    node("drawerGroup", "drawer", "Node2D", [1, 0, 0, 1, 1300, 400]),
    node("drawerDot", "drawerGroup", "Sprite2D", I, { localRect: box(40, 40), fillColor: fill("#ff8800ff") }),
    node("drawerHit", "drawerGroup", "Control", I, { name: "Hitbox", anchorLeft: 0, anchorRight: 0, localRect: box(40, 40), mouseFilter: 0 }),
  );
  return rows;
}

async function wideScript({ state, renderer, offer, tick }: ScenarioContext): Promise<void> {
  const rows = wideSceneNodes();
  const rowOf = (id: string, over: Record<string, unknown>) => ({ ...rows.find((row) => row.id === id)!, ...over });
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "combat", upserts: rows,
    orderedIds: rows.map((row) => row.id as string) })!);
  renderer.setStretch(WIDE);
  renderer.setStaticBackgroundSource!({ scenePath: BG_SCENE, url: "/bg/glade.png" }, () => {});
  expect(renderer.reconcile(state)).toBe(false);
  await turn();
  await offer("startup");
  for (const at of [1050, 1100]) await tick(`pulse@${at}`, at);
  delta(state, [], [positionHint("mover", [1, 0, 0, 1, 760, 340], 200)]);
  await offer("tween");
  for (const at of [1150, 1200, 1250, 1300]) await tick(`tween@${at}`, at);
  delta(state, [rowOf("mover", { transform: xf([1, 0, 0, 1, 760, 340]) })]);
  await offer("tween-landed");
  delta(state, [rowOf("drawerB", { transform: xf([1, 0, 0, 1, 130, 0]) })]);
  await offer("hidden-change");
  await tick("after-hidden-change@1350", 1350);
  delta(state, [rowOf("drawer", { visible: true })]);
  await offer("drawer-shown");
  await tick("drawer-shown@1400", 1400);
  delta(state, [rowOf("drawer", { visible: false })]);
  await offer("drawer-hidden");
  for (const at of [1450, 1500]) await tick(`drawer-hidden@${at}`, at);
  renderer.setStretch(1);
  await turn();
  await offer("stretch-off");
  for (const at of [1550, 1600]) await tick(`stretch-off@${at}`, at);
  renderer.setStretch(WIDE);
  await turn();
  await offer("stretch-on");
  for (const at of [1650, 1700]) await tick(`stretch-on@${at}`, at);
  delta(state, [{ id: "orbit", parentId: "stage", visible: true, transform: xf([1, 0, 0, 1, 1520, 230]) }]);
  await offer("wire");
  await tick("after-wire@1750", 1750);
}

describe("hidden-subtree memo on a widened stage (rustHiddenMemoSpread)", () => {
  beforeEach(() => { document.body.replaceChildren(); });
  afterEach(() => {
    window.history.replaceState(null, "", "/");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
  });

  it.each(["", "rustFastVerify=1"])("submits the same stream with the switch on and off (%s)", async (query) => {
    const extra = query ? `&${query}` : "";
    const off = await runScenario(`rustHiddenMemoSpread=0${extra}`, wideScript);
    const on = await runScenario(query, wideScript);
    // The scene really is widened: the drawer's box child and the stage's anchored children carry shifts.
    expect(on.steps.some((step) => (step as { rects: Array<{ spreadDx: number }> }).rects.some(({ spreadDx }) => spreadDx !== 0)))
      .toBe(true);
    expect(on.steps).toEqual(off.steps);
    expect(on.log).toEqual(off.log);
    // Off: every widened build sat the memo out. On: none did, and the drawer was replayed (or verified) under spread.
    expect(off.memo!.bypassedBuilds).toBeGreaterThan(0);
    expect(on.memo!.bypassedBuilds).toBe(0);
    expect(on.memo!.missReasons.env).toBeGreaterThan(0);
    if (query.includes("rustFastVerify=1")) {
      expect(on.memo!.verified).toBeGreaterThan(off.memo!.verified);
      expect(on.memo!.verifyMismatches).toBe(0);
    } else {
      expect(on.memo!.hits).toBeGreaterThan(off.memo!.hits);
      expect(on.memo!.replayedNodes).toBeGreaterThan(off.memo!.replayedNodes);
    }
  });

  it("draws the same picture as every control off", async () => {
    const baseline = await runScenario("rustFast=0", wideScript);
    // A submission-for-submission gate: `rustCoalescedBuilds` folds each `setStretch` build into the next
    // reconcile, so it is held off here and gated by its own spec (rustCoalescedBuilds.spec.ts).
    const candidate = await runScenario("rustCoalescedBuilds=0", wideScript);
    expectSamePicture(candidate, baseline, true);
  });

  // The default configuration (coalescing on) on the same widened script: its submissions differ (a stretch build
  // moves into the next reconcile), so it is compared on what each step leaves drawn and on the final picture
  // rather than submission by submission.
  it.each(["rustCoalescedBuilds=0", "rustFast=0"])("with coalesced builds, ends every step on the same picture as %s", async (query) => {
    const baseline = await runScenario(query, wideScript);
    const candidate = await runScenario("", wideScript);
    // Per step: hit rects, reward focus, hand/cover answers and the drawn revision and clock, everything but the
    // submission counters (and the reconcile's own return values, which differ by when a build settled).
    expect(firstDifference(candidate.steps, baseline.steps,
      new Set(["buildEpoch", "presentEpoch", "submissions", "result"]))).toBeNull();
    expect(firstDifference(effectiveFrames(candidate.log).at(-1), effectiveFrames(baseline.log).at(-1))).toBeNull();
    expect(candidate.log.length).toBeLessThanOrEqual(baseline.log.length);
  });
});

// COSMETIC OFFSETS AS A RETAINED TRANSLATE PATCH (`rustOffsetPatch`). A held card lifts and drops, an ancestor of it
// takes a client-side offset on top, a clipping group takes one (refused: a clip rect is built from the drawn pose),
// and the producer streams a pure translation of the held card itself (captured, recomputed by the wire patch).
function offsetSceneNodes(): Array<Record<string, unknown>> {
  return [...sceneNodes(false),
    heldNode("tray", "stage", "Control", I, { localRect: box(1920, 1080) }),
    heldNode("card", "tray", "NCard", [1, 0, 0, 1, 600, 800], { localRect: box(160, 220) }),
    heldNode("cardFace", "card", "ColorRect", I, { localRect: box(160, 220), fillColor: fill("#aa66ccff") }),
    heldNode("cardLabel", "card", "Label", [1, 0, 0, 1, 10, 180], { localRect: box(140, 30), ...label("Strike") }),
    heldNode("cardHit", "card", "Control", I, { name: "Hitbox", localRect: box(160, 220), mouseFilter: 0 }),
    // A local-animation root under the offset owner `tray`: its whole span moves with the tray's offset.
    heldNode("trayPulse", "tray", "ColorRect", [1, 0, 0, 1, 900, 500], { localRect: box(40, 40), fillColor: fill("#ffcc00ff"),
      pinnedLoopAnim: "mapPointPulse" }),
    heldNode("trayPulseDot", "trayPulse", "ColorRect", [1, 0, 0, 1, 10, 10], { localRect: box(10, 10), fillColor: fill("#ff0000ff") }),
    heldNode("clipper", "stage", "Control", [1, 0, 0, 1, 1300, 700], { localRect: box(200, 200), clipContents: true }),
    heldNode("clipped", "clipper", "ColorRect", [1, 0, 0, 1, 20, 20], { localRect: box(100, 100), fillColor: fill("#22aa88ff") }),
  ];
}

async function offsetScript({ state, renderer, offer, tick }: ScenarioContext): Promise<void> {
  const rows = offsetSceneNodes();
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "combat", upserts: rows,
    orderedIds: rows.map((row) => row.id as string) })!);
  renderer.setStaticBackgroundSource!({ scenePath: BG_SCENE, url: "/bg/glade.png" }, () => {});
  expect(renderer.reconcile(state)).toBe(false);
  await turn();
  await offer("startup");
  renderer.setHeldCard("card", 0, 900); // a pick-up: the next build captures the card
  await tick("pickup@1050", 1050);
  renderer.setHeldCard("card", 0, 300); // into the play zone: still lifted
  await tick("aim@1100", 1100);
  renderer.setHeldCard("card", 0, 1040); // back to the hand: the lift drops
  await tick("drop@1150", 1150);
  renderer.setHeldCard("card", 0, 300); // and lifts again
  await tick("lift@1200", 1200);
  renderer.applyLocalOffset!("tray", 25); // a new owner the committed build did not capture: one build
  await tick("tray@1250", 1250);
  renderer.applyLocalOffset!("tray", 40); // then nested under the held card's own lift
  await tick("tray-again@1300", 1300);
  renderer.applyLocalOffset!("clipper", 30);
  await tick("clipper@1350", 1350);
  renderer.applyLocalOffset!("clipper", 45);
  await tick("clipper-again@1400", 1400);
  const cardAt = (x: number, y: number) => ({ ...offsetSceneNodes().find((row) => row.id === "card")!, transform: xf([1, 0, 0, 1, x, y]) });
  delta(state, [cardAt(640, 780)]); // the game moves the held card: a translation of a captured node
  await offer("card-moves");
  await tick("after-move@1450", 1450);
  // The game moves the clipping group (a captured offset owner): its clip rect has to move with its children.
  const clipperAt = (x: number, y: number) => ({ ...offsetSceneNodes().find((row) => row.id === "clipper")!,
    transform: xf([1, 0, 0, 1, x, y]) });
  delta(state, [clipperAt(1290, 720)]);
  await offer("clipper-moves");
  await tick("after-clipper@1475", 1475);
  renderer.setHeldCard(null, 0, 0); // let go: a release builds
  await tick("release@1500", 1500);
}

// A STREAMED TRANSLATION OF SEVERAL CAPTURED NODES AT ONCE: the hand container moves, and with it every hand holder
// (each one a captured global) plus their faces, labels and hitboxes. Every holder's captured entry must move.
function handSceneNodes(): Array<Record<string, unknown>> {
  return [...sceneNodes(false),
    heldNode("holder2", "hand", "NHandCardHolder", [1, 0, 0, 1, 920, 900], { localRect: box(200, 300) }),
    heldNode("holder2Face", "holder2", "ColorRect", I, { localRect: box(200, 300), fillColor: fill("#6688aaff") }),
    heldNode("holder2Label", "holder2", "Label", [1, 0, 0, 1, 10, 260], { localRect: box(180, 30), ...label("Defend") }),
    heldNode("holder2Hit", "holder2", "Control", I, { name: "Hitbox", localRect: box(200, 300), mouseFilter: 0 }),
    heldNode("holder3", "hand", "NHandCardHolder", [1, 0, 0, 1, 1140, 900], { localRect: box(200, 300) }),
    heldNode("holder3Face", "holder3", "ColorRect", I, { localRect: box(200, 300), fillColor: fill("#aa8866ff") }),
  ];
}

async function handScript({ state, renderer, offer, tick }: ScenarioContext): Promise<void> {
  const rows = handSceneNodes();
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "combat", upserts: rows,
    orderedIds: rows.map((row) => row.id as string) })!);
  renderer.setStaticBackgroundSource!({ scenePath: BG_SCENE, url: "/bg/glade.png" }, () => {});
  expect(renderer.reconcile(state)).toBe(false);
  await turn();
  await offer("startup");
  await tick("settled@1050", 1050);
  const handAt = (x: number, y: number) => ({ ...rows.find((row) => row.id === "hand")!, transform: xf([1, 0, 0, 1, x, y]) });
  delta(state, [handAt(30, -20)]); // a pure translation of the hand: three captured holders move with it
  await offer("hand-moves");
  await tick("after-hand@1100", 1100);
  delta(state, [handAt(10, -40)]);
  await offer("hand-moves-again");
  await tick("after-hand-again@1150", 1150);
}

// A STREAMED TRANSLATION OF A CLIPPER NOTHING CAPTURES: its clip moves with it on a 16:9 stage. On a widened stage
// the clipper claims the spread field at its own X, which the translation changes: refused, rebuilt.
function clipMoveScript(stretch: number) {
  return async ({ state, renderer, offer, tick }: ScenarioContext): Promise<void> => {
    // An anchored stage hands the widening down, so the clipper (a boxed, unanchored Control) claims the field.
    const rows = offsetSceneNodes().map((row) => row.id === "stage" ? { ...row, anchorLeft: 0, anchorRight: 1 } : row);
    applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "combat", upserts: rows,
      orderedIds: rows.map((row) => row.id as string) })!);
    if (stretch !== 1) renderer.setStretch(stretch);
    renderer.setStaticBackgroundSource!({ scenePath: BG_SCENE, url: "/bg/glade.png" }, () => {});
    expect(renderer.reconcile(state)).toBe(false);
    await turn();
    await offer("startup");
    await tick("settled@1050", 1050);
    const clipperAt = (x: number, y: number) => ({ ...rows.find((row) => row.id === "clipper")!, transform: xf([1, 0, 0, 1, x, y]) });
    delta(state, [clipperAt(1290, 720)]);
    await offer("clipper-moves");
    await tick("after-clipper@1100", 1100);
  };
}

// A CLIPPER INSIDE A LOCAL-ANIMATION ROOT'S SPAN, under the offset owner `tray`: the root's frame shift would move the
// clipped content but not the clip, so the shift refuses (`offset-anim-clip`) and the step builds.
async function animClipScript({ state, renderer, offer, tick }: ScenarioContext): Promise<void> {
  const rows = [...offsetSceneNodes(),
    heldNode("pulseClip", "trayPulse", "Control", [1, 0, 0, 1, 2, 2], { localRect: box(30, 30), clipContents: true }),
    heldNode("pulseClipped", "pulseClip", "ColorRect", [1, 0, 0, 1, 5, 5], { localRect: box(40, 40), fillColor: fill("#00ff88ff") })];
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "combat", upserts: rows,
    orderedIds: rows.map((row) => row.id as string) })!);
  renderer.setStaticBackgroundSource!({ scenePath: BG_SCENE, url: "/bg/glade.png" }, () => {});
  expect(renderer.reconcile(state)).toBe(false);
  await turn();
  await offer("startup");
  renderer.applyLocalOffset!("tray", 25); // a new owner: one build, which captures it
  await tick("tray@1050", 1050);
  renderer.applyLocalOffset!("tray", 40);
  await tick("tray-again@1100", 1100);
}

describe("cosmetic offsets as a retained translate patch (rustOffsetPatch)", () => {
  beforeEach(() => { document.body.replaceChildren(); });
  afterEach(() => {
    window.history.replaceState(null, "", "/");
    Object.assign(rendererComparisonConfig, readRendererComparisonConfig());
  });

  type OffsetDiagnostics = { offsetPatches: number; offsetPatchedNodes: number; wireCapturedPatches: number;
    offsetDeclines: Record<string, number>; verifyRuns?: number; verifyMismatches?: number; verifyFirstMismatch?: string | null };

  // With an executor that moves clips (the Rust one), a translated clipper patches too; without one it rebuilds.
  it.each([
    ["", true], ["rustFastVerify=1", true], ["rustFastVerify=1", false],
  ] as const)("draws the same picture as rustOffsetPatch=0, patching what it can (%s, clips %s)", async (query, clips) => {
    executorTranslatesClips = clips;
    try {
      const extra = query ? `&${query}` : "";
      const baseline = await runScenario(`rustOffsetPatch=0${extra}`, offsetScript);
      const candidate = await runScenario(query, offsetScript);
      const replaced = expectSamePicture(candidate, baseline, false);
      // Full builds per step: a step's submissions run from the previous step's count to its own (a held-card
      // request is served at once, then the clock frame submits its own present or patch).
      const admitsIn = (result: ScenarioResult, step: string) => {
        const index = result.steps.findIndex((entry) => (entry as { step: string }).step === step);
        const from = index === 0 ? 0 : (result.steps[index - 1] as { submissions: number }).submissions;
        const to = (result.steps[index] as { submissions: number }).submissions;
        return result.log.slice(from, to).filter((entry) => entry.call === "admit").length;
      };
      const clipSteps = ["clipper-again@1400", "clipper-moves"];
      const patched = ["drop@1150", "lift@1200", "tray-again@1300", "card-moves", ...(clips ? clipSteps : [])];
      for (const step of patched) {
        expect([step, admitsIn(baseline, step)]).toEqual([step, 1]);
        expect([step, admitsIn(candidate, step)]).toEqual([step, 0]);
      }
      // A pick-up, an uncaptured new owner and a release still build, and so does a moved clip nothing can move.
      for (const step of ["pickup@1050", "tray@1250", "clipper@1350", "release@1500", ...(clips ? [] : clipSteps)])
        expect([step, admitsIn(candidate, step)]).toEqual([step, admitsIn(baseline, step)]);
      expect(replaced.length).toBe(patched.length);
      const offsets = candidate.offsets as OffsetDiagnostics | undefined;
      expect(offsets).toBeDefined();
      if (clips) expect(offsets!.offsetDeclines["offset-clip"]).toBeUndefined();
      else expect(offsets!.offsetDeclines["offset-clip"]).toBeGreaterThanOrEqual(1);
      expect(offsets!.offsetDeclines["offset-uncaptured"]).toBeGreaterThanOrEqual(1);
      // The tray carries a local-animation root along: its frame moves, nothing refuses `offset-anim`.
      expect(offsets!.offsetDeclines["offset-anim"]).toBeUndefined();
      expect(offsets!.wireCapturedPatches).toBe(clips ? 2 : 1);
      // The clip moves reach the executor as clip translations of the clipper's push.
      const clipMoves = candidate.log.flatMap((entry) => entry.call === "patch"
        ? ((entry.patch as { clips?: Array<{ id: string }> }).clips ?? []).map((clip) => clip.id) : []);
      expect(clipMoves).toEqual(clips ? ["clipper", "clipper"] : []);
      if (query) {
        expect(offsets!.verifyFirstMismatch).toBeNull();
        expect(offsets!.verifyMismatches).toBe(0);
        expect(offsets!.verifyRuns).toBeGreaterThanOrEqual(patched.length);
      }
    } finally {
      executorTranslatesClips = true;
    }
  });

  // The shadow build is the reference: with `rustOffsetPatch=0` a clipper's wire move is a full build, so there is no
  // patch to compare submission for submission.
  it.each([[1, "patch"], [WIDE, "admit"]] as const)("moves an uncaptured clipper's clip only where the spread allows (stretch %s)", async (stretch, call) => {
    const candidate = await runScenario("rustFastVerify=1", clipMoveScript(stretch));
    const step = candidate.steps.findIndex((entry) => (entry as { step: string }).step === "clipper-moves");
    const from = (candidate.steps[step - 1] as { submissions: number }).submissions;
    const to = (candidate.steps[step] as { submissions: number }).submissions;
    expect(candidate.log.slice(from, to).map((entry) => entry.call)).toEqual([call]);
    const offsets = candidate.offsets as OffsetDiagnostics;
    if (call === "admit") expect(offsets.offsetDeclines["wire-spread"]).toBe(1);
    else expect((candidate.log[to - 1].patch as { clips?: Array<{ id: string; dx: number }> }).clips)
      .toEqual([expect.objectContaining({ id: "clipper", dx: -10, dy: 20 })]);
    // The drawn clip after the step is where a full build puts it.
    const clipX = (picture: unknown) => ((picture as { commands: Array<{ kind: string; view: { x: number } }> }).commands
      .find((command) => command.kind === "clipPush")!.view.x);
    const final = effectiveFrames(candidate.log).at(-1);
    const rebuilt = effectiveFrames(candidate.log.filter((entry) => entry.call === "admit")).at(-1);
    if (call === "patch") expect(clipX(final)).toBeCloseTo(1290, 4);
    else expect(clipX(final)).toBe(clipX(rebuilt));
    expect(offsets.verifyMismatches).toBe(0);
    expect(offsets.verifyRuns).toBe(call === "patch" ? 1 : 0);
  });

  it("refuses a local-animation root's shift over a clipper in its span", async () => {
    const baseline = await runScenario("rustOffsetPatch=0&rustFastVerify=1", animClipScript);
    const candidate = await runScenario("rustFastVerify=1", animClipScript);
    expect(expectSamePicture(candidate, baseline, false)).toEqual([]);
    const offsets = candidate.offsets as OffsetDiagnostics & { offsetDeclineTypes: Record<string, number> };
    expect(offsets.offsetDeclines["offset-anim-clip"]).toBe(1);
    expect(offsets.verifyMismatches).toBe(0);
  });

  it.each(["", "rustFastVerify=1"])("moves every captured node of a streamed translation (%s)", async (query) => {
    const extra = query ? `&${query}` : "";
    const baseline = await runScenario(`rustOffsetPatch=0${extra}`, handScript);
    const candidate = await runScenario(query, handScript);
    const replaced = expectSamePicture(candidate, baseline, false);
    // Both hand moves were full builds before (`wire-captured-global`) and are wire patches now.
    expect(replaced.length).toBe(2);
    const offsets = candidate.offsets as OffsetDiagnostics;
    expect(offsets.wireCapturedPatches).toBe(2);
    if (query) {
      // The shadow build compares every captured global, so a holder left at its old pose is a mismatch here.
      expect(offsets.verifyFirstMismatch).toBeNull();
      expect(offsets.verifyMismatches).toBe(0);
      expect(offsets.verifyRuns).toBe(2);
    }
  });
});
