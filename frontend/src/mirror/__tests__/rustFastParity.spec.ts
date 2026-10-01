// End-to-end gate for the Rust producer CPU controls (`rustFast` and its items): the same scene stream, delivered
// on the same deterministic clock, must reach the Rust executor as the same submissions with every control off and
// with the controls under test on. The executor here records instead of drawing; nothing else is stubbed out of the
// producer path (build, retained composition, retained patches, wire patches, snapshot publication).
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
  "rustFast=1",
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
  ];
  if (rewards) nodes.push(
    node("rewards", "stage", "NRewardsScreen", [1, 0, 0, 1, 800, 200], { localRect: box(400, 500) }),
    node("rowA", "rewards", "NRewardButton", I, { localRect: box(400, 80), fillColor: fill("#444444ff") }),
    node("rowAHit", "rowA", "Control", I, { name: "Hitbox", localRect: box(400, 80), mouseFilter: 0 }),
    node("rowB", "rewards", "NRewardButton", [1, 0, 0, 1, 0, 100], { localRect: box(400, 80), focused: true, fillColor: fill("#555555ff") }),
    node("rowBHit", "rowB", "Control", I, { name: "Hitbox", localRect: box(400, 80), mouseFilter: 0 }),
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

async function runScenario(query: string) {
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
      reward: [renderer.rewardFocusSnapshot(), renderer.rewardFocusSnapshot()], rects });
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
  try {
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
    const final = diagnostics();
    expect(final.readiness).toBe("ready");
    expect(final.failure).toBeUndefined();
    return { log, steps, draw: final.draw };
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
    expect(baseline.draw.lazyCompositionIndexBuilds).toBeUndefined();
    expect(baseline.draw.snapshotNodeReuses).toBeUndefined();
  });
});
