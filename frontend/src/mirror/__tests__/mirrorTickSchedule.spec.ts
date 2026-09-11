import type { GpuInfo } from "@godot-scene-web/html";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMirrorRenderer,
  mirrorWalkStats,



  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { resolveRenderQuality, __setRenderQualityForTest } from "@/render/quality";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";
import type { LoadedSpineClip } from "@/mirror/spineClip";

// WS-B — the renderer's animation loop is DEADLINE-SCHEDULED, not a free-running 60Hz rAF poll. These specs drive a
// FULLY SIMULATED browser clock (performance.now + setTimeout + a 60Hz rAF/vsync) so "how many times did the loop
// actually run per second" is an exact, assertable number:
//
//   • nothing armed        → 0 wakeups, no timer, no rAF (fully parked)
//   • one 30fps clip       → ~30 wakeups/s (the poll did 60)
//   • N clips at that fps  → the SAME ~30 (a shared period grid, not N staggered wakeups)
//   • a tween              → ONE wakeup at its expiry deadline (the poll checked every frame)
//   • `?spineClipFps=0`    → per-rAF while a clip is active (the explicit uncapped opt-in)
//
// The clip client fetches + decodes over the network; jsdom has no server, so mock loadSpineClip (same shape as
// spineMount.spec) — the reconciler's real playback + scheduling math is what's under test.
const { loadSpineClipMock } = vi.hoisted(() => ({ loadSpineClipMock: vi.fn() }));
vi.mock("@/mirror/spineClip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/spineClip")>();
  return { ...actual, loadSpineClip: (url: string) => loadSpineClipMock(url) };
});

const UNKNOWN_GPU: GpuInfo = { renderer: "", software: false, unavailable: true };
const VSYNC_MS = 1000 / 60;

// --- the simulated world ------------------------------------------------------------------------------------

let clock = 0;
let timers: { id: number; at: number; cb: () => void }[] = [];
let rafs: { cb: FrameRequestCallback }[] = [];
let nextTimerId = 1;

// The next display refresh strictly after `t` (the epsilon keeps a rAF requested exactly ON a vsync from firing
// again at that same instant — a real display would show it on the FOLLOWING frame).
function nextVsync(t: number): number {
  return (Math.floor(t / VSYNC_MS + 1e-9) + 1) * VSYNC_MS;
}

// Advance the simulated world by `ms`, firing timers at their deadline and rAF callbacks at the next vsync — the
// two wake mechanisms the scheduler composes. Timers win a tie (a timer that lands on a vsync still has to wait
// for the NEXT frame to mutate, exactly like the real thing).
function run(ms: number): void {
  const end = clock + ms;
  for (let guard = 0; guard < 100000; guard++) {
    let timerNext = Infinity;
    for (const t of timers) {
      if (t.at < timerNext) timerNext = t.at;
    }
    const rafNext = rafs.length > 0 ? nextVsync(clock) : Infinity;
    const next = Math.min(timerNext, rafNext);
    if (next > end) {
      break;
    }
    clock = next;
    if (timerNext <= rafNext) {
      const due = timers.filter((t) => t.at <= clock);
      timers = timers.filter((t) => t.at > clock);
      for (const t of due) t.cb();
    } else {
      const batch = rafs;
      rafs = [];
      for (const r of batch) r.cb(clock);
    }
  }
  clock = end;
}

// Let the mocked loadSpineClip's resolve + the reconciler's chained .then run (setTimeout is stubbed here, so this
// drains microtasks rather than sleeping).
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

function wakeups(): number {
  return mirrorWalkStats.tickWakeups;
}

// --- fixtures -----------------------------------------------------------------------------------------------

const FRAME_BMP = (id: string) => ({ id }) as unknown as ImageBitmap;

// A 6-frame clip at ~30fps (33ms/frame) so the frame index really does move between grid wakeups.
function fakeClip(): LoadedSpineClip {
  const frames = [0, 1, 2, 3, 4, 5].map((i) => ({
    index: i,
    offsetX: 0,
    offsetY: 0,
    width: 10,
    height: 10,
    durationMs: 33,
    startMs: i * 33,
    png: new Uint8Array(),
    bitmap: FRAME_BMP(`f${i}`)
  }));
  return {
    canvasWidth: 100,
    canvasHeight: 100,
    totalDurationMs: 198,
    localX: 0,
    localY: 0,
    localWidth: 100,
    localHeight: 100,
    frames,
    stillUrl: null,
    degraded: false,
    retain() {},
    release() {},
    dispose() {}
  };
}

const drawImage = vi.fn();
const clearRect = vi.fn();
// save/restore/translate/scale: the R10-B1 intent STRIP paints each cell under a canvas transform.
const fakeCtx = {
  drawImage,
  clearRect,
  save: vi.fn(),
  restore: vi.fn(),
  translate: vi.fn(),
  scale: vi.fn()
} as unknown as CanvasRenderingContext2D;

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function spineNode(id: string): Record<string, unknown> {
  return {
    id,
    parentId: null,
    name: "SpineSprite",
    nodeType: "SpineSprite",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 960, y: 540 } },
    visible: true,
    spine: {
      sceneResPath: `res://scenes/enemies/${id}.tscn`,
      nodePath: "Visuals/SpineSprite",
      animations: ["idle_loop"]
    },
    spineCurrentAnim: "idle_loop",
    spineTrackTime: 0
  };
}

const rect = (x: number, y: number, w: number, h: number) => ({ position: { x, y }, size: { x: w, y: h } });
const ATLAS = "res://atlases/intent_atlas.png";

// A multi-frame enemy-intent glyph (the second wall-clock animator sharing the grid).
function intentNode(id: string): Record<string, unknown> {
  return {
    id,
    parentId: null,
    name: "Intent",
    nodeType: "Sprite2D",
    visible: true,
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 100, y: 100 } },
    localRect: rect(0, 0, 64, 64),
    intentFrames: {
      animationName: "attack",
      fps: 15,
      frames: [
        { atlasPath: ATLAS, region: rect(0, 0, 48, 48) },
        { atlasPath: ATLAS, region: rect(48, 0, 48, 48) },
        { atlasPath: ATLAS, region: rect(96, 0, 48, 48) }
      ]
    }
  };
}

// A plain boxed node (nothing time-driven about it) — the "clean screen" case.
function plainNode(id: string, x: number, y: number): Record<string, unknown> {
  return {
    id,
    parentId: null,
    name: id,
    nodeType: "ColorRect",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x, y } },
    localRect: rect(0, 0, 90, 130),
    visible: true,
    fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#e0574a" }
  };
}

function full(state: MirrorState, nodes: Record<string, unknown>[]): void {
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

function hintsOnly(state: MirrorState, hints: unknown[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", hints })!);
}

function transformHint(targetId: string, durationMs: number, endX: number): Record<string, unknown> {
  return {
    targetId,
    property: "position",
    durationMs,
    trans: "Cubic",
    ease: "Out",
    endTransform: [1, 0, 0, 1, endX, 0]
  };
}

function el(stage: HTMLElement, id: string): HTMLElement {
  return stage.querySelector(`[data-node-id="${id}"]`) as HTMLElement;
}

// --- suite --------------------------------------------------------------------------------------------------

describe("mirror animation-loop scheduling (WS-B)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    clock = 0;
    timers = [];
    rafs = [];
    nextTimerId = 1;
    mirrorWalkStats.reset(); // one fetch per identity — the still→clip chain is spineStillFirst.spec's job
    loadSpineClipMock.mockReset();
    loadSpineClipMock.mockImplementation(() => Promise.resolve(fakeClip()));
    drawImage.mockReset();
    clearRect.mockReset();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeCtx as unknown as null);
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafs.push({ cb });
      return rafs.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      rafs = [];
    });
    vi.stubGlobal("setTimeout", (cb: () => void, ms?: number) => {
      const id = nextTimerId++;
      timers.push({ id, at: clock + (ms ?? 0), cb });
      return id;
    });
    vi.stubGlobal("clearTimeout", (id: number) => {
      timers = timers.filter((t) => t.id !== id);
    });
  });

  afterEach(() => {
    __setRenderQualityForTest(undefined);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function cappedQuality(fps = 30): void {
    __setRenderQualityForTest(
      resolveRenderQuality({ search: `?quality=high&spineClips=on&spineClipFps=${fps}`, gpu: UNKNOWN_GPU })
    );
  }

  // Mount `count` spine nodes and let their clips resolve, so they're all registered in the playback set.
  async function mountClips(count: number): Promise<{ stage: HTMLElement; renderer: MirrorRenderer; state: MirrorState }> {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    const nodes: Record<string, unknown>[] = [];
    for (let i = 0; i < count; i++) {
      nodes.push(spineNode(`spine${i}`));
    }
    full(state, nodes);
    renderer.reconcile(state);
    await flushMicrotasks();
    return { stage, renderer, state };
  }

  it("parks COMPLETELY when nothing is armed: no timer, no rAF, zero wakeups over 3 simulated seconds", () => {
    cappedQuality();
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, [plainNode("a", 10, 10), plainNode("b", 20, 20)]);
    renderer.reconcile(state);

    expect(timers).toHaveLength(0);
    expect(rafs).toHaveLength(0);

    run(3000);
    expect(wakeups()).toBe(0);
    expect(timers).toHaveLength(0);
    expect(rafs).toHaveLength(0);
    renderer.dispose();
  });

  it("ONE 30fps clip wakes ~30×/s, not 60 (the free-running poll's rate)", async () => {
    cappedQuality(30);
    const { renderer } = await mountClips(1);

    mirrorWalkStats.tickWakeups = 0;
    const before = clock;
    run(1000);
    expect(clock - before).toBe(1000);
    // 30fps grid → 30 wakeups (±1 for where the second boundary falls); emphatically NOT the 60 a per-rAF poll does.
    expect(wakeups()).toBeGreaterThanOrEqual(29);
    expect(wakeups()).toBeLessThanOrEqual(31);
    renderer.dispose();
  });

  it("THREE clips at the same fps share ONE wakeup per grid period (not one each)", async () => {
    cappedQuality(30);
    const { renderer } = await mountClips(3);

    mirrorWalkStats.tickWakeups = 0;
    run(1000);
    const three = wakeups();
    expect(three).toBeGreaterThanOrEqual(29);
    expect(three).toBeLessThanOrEqual(31);
    renderer.dispose();

    // Same window with ONE clip: the identical count — the grid is shared, so adding canvases adds zero wakeups.
    mirrorWalkStats.reset();
    timers = [];
    rafs = [];
    const single = await mountClips(1);
    mirrorWalkStats.tickWakeups = 0;
    run(1000);
    expect(wakeups()).toBe(three);
    single.renderer.dispose();
  });

  // R10-B1 — THE point of the compositor glyph path: on an idle screen whose only animator was the intent
  // cycling, the loop is now fully parked. The A4 idle baseline measured the old path waking 30-37×/s and every
  // wakeup forcing a full main frame (~7.1ms desktop / ~20.2ms at 6× CPU throttle).
  it("an enemy-intent glyph adds ZERO tick wakeups (compositor path, default)", async () => {
    cappedQuality(30);
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [intentNode("glyph")]);
    renderer.reconcile(state);
    await flushMicrotasks();
    const strip = el(stage, "glyph").querySelector(".mirror-intent-strip") as HTMLElement;
    expect(strip).not.toBeNull();
    expect(strip.style.animation).toContain("steps(3)");

    mirrorWalkStats.tickWakeups = 0;
    run(1000);
    expect(wakeups()).toBe(0);
    expect(timers).toHaveLength(0);
    expect(rafs).toHaveLength(0);
    renderer.dispose();
  });

  // …and it doesn't drag a spine clip's grid with it: the clip still wakes at its own ~30Hz, no more.
  it("a spine clip beside a compositor glyph still wakes only at the clip's own grid", async () => {
    cappedQuality(30);
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [spineNode("spine0"), intentNode("glyph")]);
    renderer.reconcile(state);
    await flushMicrotasks();
    expect(el(stage, "glyph")).not.toBeNull();

    mirrorWalkStats.tickWakeups = 0;
    run(1000);
    expect(wakeups()).toBeGreaterThanOrEqual(29);
    expect(wakeups()).toBeLessThanOrEqual(31);
    renderer.dispose();
  });

  it("uncapped (?spineClipFps=0) runs PER-rAF while a clip is active — the explicit opt-in", async () => {
    cappedQuality(0);
    const { renderer } = await mountClips(1);

    mirrorWalkStats.tickWakeups = 0;
    run(1000);
    expect(wakeups()).toBeGreaterThanOrEqual(55); // ~60Hz: one wakeup per vsync
    renderer.dispose();
  });

  it("wakes at a TWEEN's expiry deadline (once), settles it there, and advances the geometry epoch AT the settle", () => {
    cappedQuality();
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [plainNode("p", 100, 100)]);
    renderer.reconcile(state);

    hintsOnly(state, [transformHint("p", 200, 400)]);
    renderer.reconcile(state);
    const epochAtArm = mirrorWalkStats.geomEpoch;
    expect(el(stage, "p").style.transition).toBe("transform 200ms cubic-bezier(0.33, 1, 0.68, 1)");

    // Parked on ONE timer for the whole 200ms — no per-frame polling in between.
    expect(timers).toHaveLength(1);
    mirrorWalkStats.tickWakeups = 0;
    run(150);
    expect(wakeups()).toBe(0);
    expect(el(stage, "p").style.transition).toBe("transform 200ms cubic-bezier(0.33, 1, 0.68, 1)");

    // Past the deadline: exactly one wakeup, the transition is cleared, and the epoch moved AT the settle (between
    // walks — no reconcile has run since), which is what lets the geometry caches see the un-pinned transform.
    run(100);
    expect(wakeups()).toBe(1);
    expect(el(stage, "p").style.transition).toBe("");
    expect(mirrorWalkStats.geomEpoch).toBeGreaterThan(epochAtArm);
    expect(mirrorWalkStats.tickParkedMs).toBeGreaterThan(150);

    // …and then it parks again: the set drained, so nothing is left armed.
    mirrorWalkStats.tickWakeups = 0;
    run(2000);
    expect(wakeups()).toBe(0);
    expect(timers).toHaveLength(0);
    renderer.dispose();
  });

  it("arming an EARLIER deadline replaces the pending longer timer", () => {
    cappedQuality();
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [plainNode("slow", 100, 100), plainNode("fast", 300, 100)]);
    renderer.reconcile(state);

    // A long (500ms) slide parks the scheduler out at t=500.
    hintsOnly(state, [transformHint("slow", 500, 800)]);
    renderer.reconcile(state);
    expect(timers).toHaveLength(1);
    expect(timers[0].at).toBe(500);

    run(100);
    expect(wakeups()).toBe(0);

    // A SHORT (50ms) slide armed at t=100 must pull the wake in to t=150 — a stale 500ms timer here would freeze it.
    hintsOnly(state, [transformHint("fast", 50, 900)]);
    renderer.reconcile(state);
    expect(timers).toHaveLength(1);
    expect(timers[0].at).toBe(150);

    run(100); // → t=200: the short tween settled, the long one is still running
    expect(wakeups()).toBe(1);
    expect(el(stage, "fast").style.transition).toBe("");
    expect(el(stage, "slow").style.transition).toBe("transform 500ms cubic-bezier(0.33, 1, 0.68, 1)");

    // The long tween is still armed, and its own (later) deadline survived the replacement.
    run(400); // → t=600
    expect(el(stage, "slow").style.transition).toBe("");
    renderer.dispose();
  });

  it("stops the clip grid once the clips go away (a screen change parks the loop again)", async () => {
    cappedQuality(30);
    const { renderer, state } = await mountClips(2);
    mirrorWalkStats.tickWakeups = 0;
    run(200);
    expect(wakeups()).toBeGreaterThan(0);

    // The combat screen is replaced by a plain one: the spine records are torn down by the keyframe walk.
    full(state, [plainNode("p", 10, 10)]);
    renderer.reconcile(state);
    run(50); // let any in-flight wake retire

    mirrorWalkStats.tickWakeups = 0;
    run(2000);
    expect(wakeups()).toBe(0);
    expect(timers).toHaveLength(0);
    renderer.dispose();
  });
});
