import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  atlasStripKey,
  onAtlasRegionsReady,
  __keyWaitersForTest,
  __publishStripBlobForTest,
  __resetAtlasCacheForTest
} from "@/mirror/atlasBaker";
import { atlasBakePoolStats } from "@/mirror/atlasBakePool";
import {
  ensureIntentStepsKeyframes,
  INTENT_STEPS_PREFIX,
  intentStepsAnimationCss,
  intentStepsKeyframesCss,
  intentStepsPhaseMs,
  intentStripGeometry,
  __resetIntentStepsKeyframesForTest
} from "@/mirror/intentStrip";
import {
  createMirrorRenderer,
  intentFrameIndex,
  __resetAtlasDecodeGateForTest,


  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";
import { __setStillDecoderForTest, type StillDecoder } from "@/mirror/stillDecode";

// R10-B1 — COMPOSITOR-DRIVEN enemy-intent glyph cycling.
//
// The glyph used to be cycled by the renderer's deadline tick (one atlas blit per frame index change). That tick
// is a MAIN-THREAD wakeup and every wakeup forces a full main frame, which the A4 idle baseline measured at
// 30-37Hz / ~7.1ms per frame (desktop) and ~20.2ms (6× CPU throttle) on a settled combat screen. The frames are
// now pre-rendered once into a strip canvas that a `translate` + `steps(N)` animation cycles on the compositor,
// and the record never joins `activeIntents` — so an idle screen parks the loop completely (asserted in
// mirrorTickSchedule.spec: "an enemy-intent glyph adds ZERO tick wakeups").
//
// What must stay TRUE across that swap, and is asserted here:
//   • the shown frame at any time is EXACTLY intentFrameIndex's (the flip-book the glyph runs on screen);
//   • the strip is phase-anchored to the record's cycle origin, so a rebuild doesn't jump the animation;
//   • a spec change rebuilds + restarts; a single-frame set stays static; the occlusion gate still parks it.

// --- fixtures ---------------------------------------------------------------------------------------------

const rect = (x: number, y: number, w: number, h: number) => ({ position: { x, y }, size: { x: w, y: h } });
const xf = (tx: number, ty: number) => ({ xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } });
const ATLAS = "res://atlases/intent_atlas.png";
const ATLAS_URL = "/res/atlases/intent_atlas.png";

type Raw = Record<string, unknown>;

function glyph(over: Raw = {}, frames?: Raw[], name = "attack", fps = 15): Raw {
  return {
    id: "glyph",
    parentId: null,
    name: "Intent",
    nodeType: "Sprite2D",
    visible: true,
    transform: xf(100, 100),
    localRect: rect(0, 0, 48, 51),
    intentFrames: {
      animationName: name,
      fps,
      frames: frames ?? [
        { atlasPath: ATLAS, region: rect(0, 0, 48, 51) },
        { atlasPath: ATLAS, region: rect(48, 0, 48, 51) },
        { atlasPath: ATLAS, region: rect(96, 0, 48, 51) },
        { atlasPath: ATLAS, region: rect(144, 0, 48, 51) }
      ]
    },
    ...over
  };
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

// A controllable fake Image so the atlas decode can be fired on demand (the atlasBaker.spec pattern).
let images: FakeImage[] = [];
class FakeImage {
  loadCbs: Array<() => void> = [];
  decoding = "";
  crossOrigin = "";
  src = "";
  constructor() {
    images.push(this);
  }
  addEventListener(type: string, cb: () => void): void {
    if (type === "load") this.loadCbs.push(cb);
  }
  // The real Image detaches both handlers once the page settles (imageListenerHygiene.spec) — a fake without
  // this throws the moment the production code cleans up.
  removeEventListener(type: string, cb: () => void): void {
    if (type !== "load") return;
    const i = this.loadCbs.indexOf(cb);
    if (i >= 0) this.loadCbs.splice(i, 1);
  }
  fireLoad(): void {
    for (const cb of [...this.loadCbs]) cb();
  }
}

interface Draw {
  op: string;
  args: number[];
}
let draws: Draw[] = [];
function makeCtx(): CanvasRenderingContext2D {
  const push = (op: string) => (...args: unknown[]) => {
    draws.push({ op, args: args.filter((a) => typeof a === "number") as number[] });
  };
  return {
    clearRect: push("clearRect"),
    drawImage: push("drawImage"),
    save: push("save"),
    restore: push("restore"),
    translate: push("translate"),
    scale: push("scale")
  } as unknown as CanvasRenderingContext2D;
}

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function view(stage: HTMLElement): HTMLElement | null {
  return stage.querySelector(".mirror-intent-view");
}
function strip(stage: HTMLElement): HTMLCanvasElement | null {
  return stage.querySelector(".mirror-intent-strip");
}
function intentImg(stage: HTMLElement): HTMLImageElement | null {
  return stage.querySelector("img.mirror-intent-img");
}

// The default glyph()'s frame regions, and its STRIP's cache identity + blob publication (the seam that stands in
// for a completed worker strip bake — jsdom encodes nothing). The key must be built exactly as the renderer builds
// it: `animationName|fps` as the tag, every cell's page+rect, and the cell box (the max frame, here 48×51).
const FRAME_REGIONS = [0, 1, 2, 3].map((i) => ({ x: i * 48, y: 0, width: 48, height: 51 }));
const cells = (regions: Array<{ x: number; y: number; width: number; height: number }>) =>
  regions.map((region) => ({ url: ATLAS_URL, region }));
function stripKeyFor(
  regions = FRAME_REGIONS,
  tag = "attack|15",
  cellW = 48,
  cellH = 51
): string {
  return atlasStripKey(tag, cells(regions), cellW, cellH);
}
function publishStrip(regions = FRAME_REGIONS, url = "blob:strip-attack", tag = "attack|15"): string {
  __publishStripBlobForTest(stripKeyFor(regions, tag), url);
  return url;
}
// The renderer's targeted-restyle seam, wired exactly as MirrorView wires it (mirrorLayerDiet's wireRegionSeam).
function wireRegionSeam(renderer: MirrorRenderer, state: MirrorState): () => void {
  return onAtlasRegionsReady((ids) => {
    renderer.markTextureDirty(ids);
    renderer.reconcile(state);
  });
}

/** The cycle length (ms) out of an element's `animation` shorthand (`<name> <duration>ms steps(N) …`). */
function durationOf(el: HTMLElement): number {
  return Number(/\s([\d.]+)ms\s/.exec(el.style.animation)![1]);
}

let clock = 0;

beforeEach(() => {
  document.body.innerHTML = "";
  document.head.querySelectorAll("style[data-mirror-intent-steps]").forEach((s) => s.remove());
  __resetIntentStepsKeyframesForTest();
  __resetAtlasCacheForTest();
  __resetAtlasDecodeGateForTest();
  images = [];
  draws = [];
  clock = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => makeCtx() as unknown as null
  );
  vi.stubGlobal("Image", FakeImage as unknown as typeof Image);
  vi.stubGlobal("createImageBitmap", undefined);
});

afterEach(() => {
  __setStillDecoderForTest(null);
  __resetAtlasCacheForTest();
  __resetAtlasDecodeGateForTest();
  __resetIntentStepsKeyframesForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- the geometry / CSS contract --------------------------------------------------------------------------

describe("intent strip geometry + CSS", () => {
  it("cells are max-sized, the strip travels one cell per frame, one cycle = count/fps", () => {
    const geo = intentStripGeometry({
      animationName: "attack",
      fps: 15,
      frames: [
        { url: ATLAS_URL, region: { x: 0, y: 0, width: 48, height: 51 }, margin: null },
        { url: ATLAS_URL, region: { x: 48, y: 0, width: 60, height: 40 }, margin: null }
      ]
    })!;
    expect(geo.count).toBe(2);
    expect(geo.cellW).toBe(60); // intrinsic resolution = the BIGGEST frame (nothing is downsampled)
    expect(geo.cellH).toBe(51);
    expect(geo.dispW).toBe(48); // display box = frame 0's region, i.e. the box the single-frame canvas has today
    expect(geo.dispH).toBe(51);
    expect(geo.travelPx).toBe(96);
    expect(geo.durationMs).toBeCloseTo((2 / 15) * 1000, 6);
  });

  it("refuses to strip a degenerate set (single frame, no region, zero box)", () => {
    const one = { animationName: "a", fps: 15, frames: [{ url: ATLAS_URL, region: { x: 0, y: 0, width: 8, height: 8 }, margin: null }] };
    expect(intentStripGeometry(one)).toBeNull();
    expect(
      intentStripGeometry({
        animationName: "a",
        fps: 15,
        frames: [
          { url: ATLAS_URL, region: { x: 0, y: 0, width: 8, height: 8 }, margin: null },
          { url: ATLAS_URL, region: null, margin: null }
        ]
      })
    ).toBeNull();
    expect(
      intentStripGeometry({
        animationName: "a",
        fps: 15,
        frames: [
          { url: ATLAS_URL, region: { x: 0, y: 0, width: 0, height: 8 }, margin: null },
          { url: ATLAS_URL, region: { x: 0, y: 0, width: 8, height: 8 }, margin: null }
        ]
      })
    ).toBeNull();
  });

  it("emits LITERAL-px translate keyframes (compositable) — never background-position", () => {
    const css = intentStepsKeyframesCss(192);
    expect(css).toContain("translate:0px 0px");
    expect(css).toContain("translate:-192px 0px");
    expect(css).not.toContain("background-position");
    expect(css).not.toContain("%");
  });

  it("phase is the elapsed time folded into one cycle (and never negative)", () => {
    expect(intentStepsPhaseMs(1000, 1000, 400)).toBe(0);
    expect(intentStepsPhaseMs(1250, 1000, 400)).toBe(250);
    expect(intentStepsPhaseMs(1900, 1000, 400)).toBeCloseTo(100, 6);
    expect(intentStepsPhaseMs(900, 1000, 400)).toBeCloseTo(300, 6); // clock ran backwards → still in [0, T)
  });

  // THE parity assertion: the cell the emitted CSS shows at time t must be the frame `intentFrameIndex` picks.
  // `steps(N)` is jump-end, i.e. progress p → floor(p*N)/N, so with duration N/fps*1000 the cell index is
  // floor(t*fps/1000) mod N — the same expression `intentFrameIndex` and the legacy blit path both use.
  it("the emitted animation shows EXACTLY intentFrameIndex's frame at every sampled time", () => {
    for (const [count, fps] of [[4, 15], [3, 15], [7, 12], [12, 30]] as const) {
      const frames = Array.from({ length: count }, (_, i) => ({
        url: ATLAS_URL,
        region: { x: i * 48, y: 0, width: 48, height: 51 },
        margin: null
      }));
      const geo = intentStripGeometry({ animationName: "a", fps, frames })!;
      const css = intentStepsAnimationCss(geo, 0);
      const durationMs = Number(/\s([\d.]+)ms\s/.exec(css)![1]);
      const steps = Number(/steps\((\d+)\)/.exec(css)![1]);
      expect(steps).toBe(count);
      const frameMs = 1000 / fps;
      let checked = 0;
      for (let t = 0; t < 4000; t += 7) {
        // Skip samples sitting ON a frame boundary: both mappings change value there, and which side a boundary
        // sample lands on is decided by float rounding in the last ULP (the emitted duration is rounded to 6
        // decimals). A sub-microsecond disagreement at the instant of a swap is not observable.
        if (Math.abs(t / frameMs - Math.round(t / frameMs)) * frameMs < 1e-3) {
          continue;
        }
        // What the browser renders: the strip is translated by -(cell * dispW), cell = floor(p*steps).
        const p = (t % durationMs) / durationMs;
        const cell = Math.floor(p * steps);
        expect(cell, `t=${t} count=${count} fps=${fps}`).toBe(intentFrameIndex(t, fps, count));
        checked++;
      }
      expect(checked).toBeGreaterThan(500); // the skip list must stay a handful of boundary samples
    }
  });

  it("injects one keyframes rule per travel distance, idempotently", () => {
    expect(ensureIntentStepsKeyframes(192)).toBe(ensureIntentStepsKeyframes(192));
    ensureIntentStepsKeyframes(144);
    const sheet = document.head.querySelector("style[data-mirror-intent-steps]")!;
    expect(sheet.textContent!.match(/@keyframes/g)).toHaveLength(2);
  });

  it("buckets rule names and endpoints to one fiftieth CSS pixel", () => {
    const sameBucketA = 192.001;
    const sameBucketB = 192.009;
    const nextBucket = 192.011;

    expect(ensureIntentStepsKeyframes(sameBucketA)).toBe(ensureIntentStepsKeyframes(sameBucketB));
    expect(intentStepsKeyframesCss(sameBucketA)).toContain("translate:-192px 0px");
    expect(intentStepsKeyframesCss(sameBucketB)).toContain("translate:-192px 0px");
    expect(ensureIntentStepsKeyframes(nextBucket)).not.toBe(ensureIntentStepsKeyframes(sameBucketA));

    const sheet = document.head.querySelector("style[data-mirror-intent-steps]")!;
    expect(sheet.textContent!.match(/@keyframes/g)).toHaveLength(2);
    expect(sheet.textContent).toContain("translate:-192.02px 0px");
  });
});

// --- the renderer wiring ----------------------------------------------------------------------------------

describe("mirror renderer — intent glyph on the compositor", () => {
  it("mounts a clipping viewport + a strip canvas instead of the single-frame atlas canvas", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [glyph()]);
    renderer.reconcile(state);

    const v = view(stage)!;
    const s = strip(stage)!;
    expect(v).not.toBeNull();
    expect(s.parentElement).toBe(v);
    expect(stage.querySelector(".mirror-atlas-canvas")).toBeNull(); // mutually exclusive — no double paint
    // The strip is N cells wide on screen and one cell tall; its intrinsic pixels are N × the max cell.
    expect(s.style.width).toBe("192px"); // 4 × 48
    expect(s.style.height).toBe("51px");
    expect(s.width).toBe(192);
    expect(s.height).toBe(51);
    // …and it is the STRIP that animates, not the viewport (the viewport carries the placement).
    expect(s.style.animation).toContain("spirectl-mirror-intent-steps-192");
    expect(s.style.animation).toContain("steps(4)");
    expect(s.style.animation).toContain("infinite");
    expect(durationOf(s)).toBeCloseTo((4 / 15) * 1000, 3);
    expect(v.style.animation).toBe("");
    renderer.dispose();
  });

  it("paints every frame into its own cell, scaled to fill it", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [glyph()]);
    renderer.reconcile(state);
    expect(strip(stage)).not.toBeNull();

    // Nothing is drawn until the atlas decodes; the cell transforms are still issued once per frame.
    expect(draws.filter((d) => d.op === "translate").map((d) => d.args[0])).toEqual([0, 48, 96, 144]);
    expect(draws.filter((d) => d.op === "drawImage")).toHaveLength(0);

    draws = [];
    images[0].fireLoad(); // the decode lands → the whole strip repaints from the callback
    const blits = draws.filter((d) => d.op === "drawImage");
    expect(blits).toHaveLength(4);
    // Source rects walk the atlas row; the destination is the full cell (0,0,cellW,cellH) under the cell translate.
    expect(blits.map((b) => b.args[0])).toEqual([0, 48, 96, 144]);
    for (const b of blits) {
      expect(b.args.slice(4)).toEqual([0, 0, 48, 51]);
    }
    renderer.dispose();
  });

  it("re-anchors the phase on a rebuild instead of jumping the cycle", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [glyph()]);
    renderer.reconcile(state);
    expect(strip(stage)!.style.animation).toContain("-0ms"); // armed at the cycle origin

    // 100ms later the SAME intent (same name + frame count, so the cycle origin is retained) is re-styled with
    // shifted regions → the strip must rebuild AT its current phase, not restart from frame 0.
    clock += 100;
    full(state, [
      glyph({}, [
        { atlasPath: ATLAS, region: rect(0, 51, 48, 51) },
        { atlasPath: ATLAS, region: rect(48, 51, 48, 51) },
        { atlasPath: ATLAS, region: rect(96, 51, 48, 51) },
        { atlasPath: ATLAS, region: rect(144, 51, 48, 51) }
      ])
    ]);
    renderer.reconcile(state);
    expect(strip(stage)!.style.animation).toContain("-100ms");
    renderer.dispose();
  });

  it("restarts the cycle (phase 0) and repaints when the intent ANIMATION changes", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [glyph()]);
    renderer.reconcile(state);
    images[0].fireLoad();

    clock += 250;
    draws = [];
    full(state, [
      glyph({}, [
        { atlasPath: ATLAS, region: rect(0, 102, 48, 51) },
        { atlasPath: ATLAS, region: rect(48, 102, 48, 51) }
      ], "defend")
    ]);
    renderer.reconcile(state);

    const s = strip(stage)!;
    expect(s.style.animation).toContain("steps(2)"); // new frame count …
    expect(durationOf(s)).toBeCloseTo((2 / 15) * 1000, 3); // … and its own cycle length
    expect(s.style.animation).toContain("-0ms"); // a NEW intent restarts from frame 0
    expect(s.style.width).toBe("96px");
    expect(draws.filter((d) => d.op === "drawImage")).toHaveLength(2); // repainted with the new frames
    renderer.dispose();
  });

  it("leaves a SINGLE-frame set on the static atlas path (nothing to cycle)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [glyph({}, [{ atlasPath: ATLAS, region: rect(0, 0, 48, 51) }])]);
    renderer.reconcile(state);

    expect(view(stage)).toBeNull();
    // Stage C: the static frame paints through the normal atlas mechanism — here the page-crop placeholder div
    // (jsdom never bakes a region blob), never a strip.
    expect(stage.querySelector(".mirror-atlas-page")).not.toBeNull();
    expect(strip(stage)).toBeNull();
    renderer.dispose();
  });

  it("tears the strip down when the node goes away", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [glyph()]);
    renderer.reconcile(state);
    expect(view(stage)).not.toBeNull();

    full(state, []);
    renderer.reconcile(state);
    expect(view(stage)).toBeNull();
    expect(strip(stage)).toBeNull();
    renderer.dispose();
  });

});

// --- STAGE-C item 3: the strip as an <img> --------------------------------------------------------------------
//
// THE DEFECT THIS BLOCK PINS (Aug-15 phone trace, http://worky.local:13337, bundle index-C-adVWPm.js). The first
// version of this path kept the frames as N separate blobs and swapped `img.src` between them from ONE shared
// `setInterval`. On a SETTLED combat screen that timer fired on a 66.0ms grid (112 → 215 → 281 → 347 → … →
// 1139ms — 1000/15fps) at 0.19-0.26ms of script per fire, each followed by an image `load` EventDispatch and
// dragging a whole main-frame lifecycle behind it: 16 Commits / 30 Paints / 16 UpdateLayoutTrees in ~1.3s of a
// screen where nothing had changed. That is the SAME class of wakeup the R10-B1 strip above deleted, put back in
// JS. So the img path now shows ONE worker-baked strip image stepped by the SAME compositor animation, and these
// specs assert exactly that: same CSS, same phase law, no interval, and the strip cached across the run.
describe("intent glyph as a worker-baked strip <img> (Stage C)", () => {
  let unwire: (() => void) | null = null;
  afterEach(() => {
    unwire?.();
    unwire = null;
  });

  /** The geometry the renderer derives for the default glyph() — what the emitted CSS must be built from. */
  const defaultGeo = () =>
    intentStripGeometry({
      animationName: "attack",
      fps: 15,
      frames: FRAME_REGIONS.map((region) => ({ url: ATLAS_URL, region, margin: null }))
    })!;

  it("swaps the strip CANVAS for ONE strip <img>, animated by exactly the same steps() cycle", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    unwire = wireRegionSeam(renderer, state);
    full(state, [glyph()]);
    renderer.reconcile(state);

    // Not ready yet: the canvas strip paints, and the SET's strip bake rode the existing baker queues with this
    // node as the waiter (that one registration is what re-styles the glyph when the strip lands).
    expect(strip(stage)).not.toBeNull();
    expect(intentImg(stage)).toBeNull();
    expect(__keyWaitersForTest(stripKeyFor()), "ONE waiter registration for the whole set").toEqual(["glyph"]);

    const blob = publishStrip(); // → seam → targeted re-style; the decode passes through synchronously (jsdom)

    const img = intentImg(stage)!;
    expect(img, "the glyph became one strip <img>").not.toBeNull();
    expect(img.parentElement).toBe(view(stage)); // same placement-carrying viewport as the canvas strip
    expect(strip(stage), "the strip canvas is gone").toBeNull();
    expect(stage.querySelectorAll("canvas").length, "…and with it the promoted canvas layer").toBe(0);
    expect(img.getAttribute("src")).toBe(blob);
    // THE CONTRACT: the img carries the strip's own animation — same keyframes family, same law, literal-px
    // translate (never background-position), and it is the IMG that animates, not the placement viewport.
    expect(img.style.animation).toBe(intentStepsAnimationCss(defaultGeo(), 0));
    expect(img.style.animation).toContain(`${INTENT_STEPS_PREFIX}-192`);
    expect(img.style.animation).toContain("steps(4)");
    expect(img.style.backgroundPosition).toBe("");
    expect(view(stage)!.style.animation).toBe("");
    // …displayed at the same N-cell box the canvas strip had (4 × 48 wide, one cell tall).
    expect([img.style.width, img.style.height]).toEqual(["192px", "51px"]);
  });

  it("installs NO interval — the img path never asks for a main-thread wakeup", () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const { stage, renderer } = harness();
    const state = createMirrorState();
    unwire = wireRegionSeam(renderer, state);
    full(state, [glyph()]);
    renderer.reconcile(state);
    publishStrip();
    expect(intentImg(stage)).not.toBeNull();

    // …and it stays that way across re-styles and a new intent (the ticker used to re-arm on membership changes).
    clock += 500;
    full(state, [glyph()]);
    renderer.reconcile(state);
    expect(interval, "a composited animation costs the main thread no timers at all").not.toHaveBeenCalled();
    renderer.dispose();
  });

  it("shows EXACTLY intentFrameIndex's frame at every sampled time, from the img's own emitted CSS", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    unwire = wireRegionSeam(renderer, state);
    full(state, [glyph()]);
    renderer.reconcile(state);
    publishStrip();
    const css = intentImg(stage)!.style.animation;

    expect(css, "armed AT the cycle origin ⇒ frame 0 (intentFrameIndex(0, …) === 0)").toContain("-0ms");
    const durationMs = Number(/\s([\d.]+)ms\s/.exec(css)![1]);
    const steps = Number(/steps\((\d+)\)/.exec(css)![1]);
    // Non-boundary samples only — at an exact frame boundary the two mappings change value together and which
    // side a sample lands on is float rounding in the last ULP (same skip rule as the parity spec above).
    for (const t of [7, 40, 100, 140, 210, 300, 1057, 1234]) {
      const cell = Math.floor(((t % durationMs) / durationMs) * steps);
      expect(cell, `t=${t}`).toBe(intentFrameIndex(t, 15, 4));
    }
    renderer.dispose();
  });

  // THE NO-REGRESSION-WINDOW CONTRACT. The canvas strip paints first and the <img> takes over whenever the bake
  // happens to land — mid-cycle, always. The img is therefore armed at the cycle's CURRENT phase off the same
  // `intentStartMs`, so the swap is invisible: the glyph shows the frame it was already showing.
  it("arms the img at the cycle's CURRENT phase when the bake lands mid-cycle (no jump on the swap)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    unwire = wireRegionSeam(renderer, state);
    full(state, [glyph()]);
    renderer.reconcile(state);
    expect(strip(stage)!.style.animation, "the canvas armed AT the origin").toContain("-0ms");

    clock += 100; // the strip bake lands 100ms into the 266.67ms cycle
    publishStrip();
    const img = intentImg(stage)!;
    expect(img.style.animation).toBe(intentStepsAnimationCss(defaultGeo(), 100));
    expect(img.style.animation).toContain("-100ms");
    renderer.dispose();
  });

  it("a SECOND glyph with the same frame set reuses the cached strip — one bake, no second waiter round-trip", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    unwire = wireRegionSeam(renderer, state);
    full(state, [glyph()]);
    renderer.reconcile(state);
    publishStrip();
    expect(stage.querySelectorAll("img.mirror-intent-img").length).toBe(1);

    // A second enemy shows the SAME intent. Its strip is a pure cache hit: it mounts its <img> on the very walk
    // that creates it — no bake, no waiter registration, nothing pending anywhere.
    full(state, [glyph(), glyph({ id: "glyph2", transform: xf(300, 100) })]);
    renderer.reconcile(state);
    const imgs = [...stage.querySelectorAll("img.mirror-intent-img")] as HTMLImageElement[];
    expect(imgs.length, "both glyphs are on the img path immediately").toBe(2);
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual(["blob:strip-attack", "blob:strip-attack"]);
    expect(strip(stage), "neither of them fell back to a canvas").toBeNull();
    expect(__keyWaitersForTest(stripKeyFor()), "nobody is waiting on a bake that already landed").toEqual([]);
    renderer.dispose();
  });

  it("keeps the canvas strip until the strip blob is DECODED (the decode gate), then swaps", () => {
    const pending: Array<{ url: string; ready: (ok: boolean) => void }> = [];
    __setStillDecoderForTest(((url, ready) => {
      pending.push({ url, ready });
    }) as StillDecoder);
    const { stage, renderer } = harness();
    const state = createMirrorState();
    unwire = wireRegionSeam(renderer, state);
    full(state, [glyph()]);
    renderer.reconcile(state);

    publishStrip(); // baked — but not decoded yet
    expect(pending.length, "ONE decode for the whole set, not one per frame").toBe(1);
    expect(strip(stage), "baked but undecoded — still the canvas strip").not.toBeNull();
    expect(intentImg(stage)).toBeNull();

    pending[0].ready(true); // the decode resolves → the notify chain re-styles the glyph → img
    expect(intentImg(stage)).not.toBeNull();
    expect(strip(stage)).toBeNull();
    renderer.dispose();
  });

  it("a NEW intent whose strip isn't baked falls back to the canvas, then upgrades again", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    unwire = wireRegionSeam(renderer, state);
    full(state, [glyph()]);
    renderer.reconcile(state);
    publishStrip();
    expect(intentImg(stage)).not.toBeNull();

    // The intent changes to a set nobody has baked: the img goes, the canvas strip returns (synchronous paint).
    clock += 250;
    const defend = [
      { atlasPath: ATLAS, region: rect(0, 102, 48, 51) },
      { atlasPath: ATLAS, region: rect(48, 102, 48, 51) }
    ];
    full(state, [glyph({}, defend, "defend")]);
    renderer.reconcile(state);
    expect(intentImg(stage)).toBeNull();
    expect(strip(stage)).not.toBeNull();
    expect(strip(stage)!.style.animation).toContain("steps(2)");

    // …and once the new strip bakes, the img path takes over again — at the new set's own cycle, from frame 0.
    const defendRegions = [
      { x: 0, y: 102, width: 48, height: 51 },
      { x: 48, y: 102, width: 48, height: 51 }
    ];
    publishStrip(defendRegions, "blob:strip-defend", "defend|15");
    const img = intentImg(stage)!;
    expect(img).not.toBeNull();
    expect(strip(stage)).toBeNull();
    expect(img.getAttribute("src")).toBe("blob:strip-defend");
    expect(img.style.animation).toContain("steps(2)");
    expect(img.style.animation).toContain("-0ms");
    renderer.dispose();
  });

  // The worker is the ONLY place a strip is composed (there is no inline strip encode), so "no pool" has to leave
  // the glyph on the canvas mechanism — correct pixels, correct cycling, one composited layer. jsdom has no
  // `Worker` at all, which exercises the inline fallback.
  it("falls back to the canvas strip — still animating — when no worker can take the bake", async () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    unwire = wireRegionSeam(renderer, state);
    full(state, [glyph()]);
    renderer.reconcile(state);

    await new Promise((resolve) => setTimeout(resolve, 0)); // let the baker's drain task run
    renderer.reconcile(state);

    expect(atlasBakePoolStats.poolSize, "no pool at all").toBe(0);
    expect(intentImg(stage)).toBeNull();
    const s = strip(stage)!;
    expect(s, "the glyph stayed on the canvas strip").not.toBeNull();
    expect(s.style.animation).toBe(intentStepsAnimationCss(defaultGeo(), 0));
    renderer.dispose();
  });

  it("tears down with the node, and a single-frame set never takes the img path", () => {
    publishStrip();
    const { stage, renderer } = harness();
    const state = createMirrorState();
    unwire = wireRegionSeam(renderer, state);
    full(state, [glyph()]);
    renderer.reconcile(state);
    expect(intentImg(stage)).not.toBeNull();

    full(state, []);
    renderer.reconcile(state);
    expect(intentImg(stage)).toBeNull();
    expect(view(stage)).toBeNull();

    // Single-frame set: static sprite, no viewport, no img (the strip's own degenerate-set law).
    full(state, [glyph({}, [{ atlasPath: ATLAS, region: rect(0, 0, 48, 51) }])]);
    renderer.reconcile(state);
    expect(intentImg(stage)).toBeNull();
    expect(view(stage)).toBeNull();
    renderer.dispose();
  });

  it("the occlusion gate pauses the img's animation and resumes it (re-phased) on reveal", () => {
    publishStrip();
    const { stage, renderer } = harness();
    const state = createMirrorState();
    unwire = wireRegionSeam(renderer, state);
    const scene = (): Raw[] => [
      { id: "Game", parentId: null, name: "Game", nodeType: "Godot.Control", visible: true, transform: xf(0, 0), localRect: rect(0, 0, 1920, 1080) },
      { id: "World", parentId: "Game", name: "World", nodeType: "Godot.Control", visible: true },
      { ...glyph(), parentId: "World" },
      { id: "Dialog", parentId: "Game", name: "Dialog", nodeType: "Godot.Control", visible: true },
      {
        id: "Scrim",
        parentId: "Dialog",
        name: "Scrim",
        nodeType: "Godot.ColorRect",
        visible: true,
        transform: xf(0, 0),
        localRect: rect(0, 0, 1920, 1080),
        fillColor: { r: 0, g: 0, b: 0, a: 0.851, html: "#000000d9" },
        mouseFilter: 2
      }
    ];
    full(state, scene());
    renderer.reconcile(state); // gate engages after OCCLUSION_ENGAGE_WALKS qualifying walks
    const img = intentImg(stage)!;
    expect(img).not.toBeNull();
    expect(img.style.animationPlayState).toBe("");
    renderer.reconcile(state);
    renderer.reconcile(state);
    expect(img.style.animationPlayState, "a covered glyph stops on the compositor").toBe("paused");

    // Reveal: the animation runs again immediately, re-anchored — so it shows the frame it WOULD have been
    // showing had it never stopped (the same phase-correct-by-construction reveal the canvas strip gets).
    clock += 500;
    full(state, scene().filter((n) => n.id !== "Scrim"));
    renderer.reconcile(state);
    expect(img.style.animationPlayState).toBe("");
    renderer.dispose();
  });
});

// --- occlusion parity -------------------------------------------------------------------------------------

describe("intent strip under the occlusion gate", () => {
  // The covered scene from mirrorOcclusion.spec, reduced to what matters here: a translucent full-stage scrim
  // painted AFTER the glyph. Tier 2 (suspend) keeps everything painted, so the only visible effect on the glyph
  // must be that its animation stops.
  function coveredScene(): Raw[] {
    return [
      { id: "Game", parentId: null, name: "Game", nodeType: "Godot.Control", visible: true, transform: xf(0, 0), localRect: rect(0, 0, 1920, 1080) },
      { id: "World", parentId: "Game", name: "World", nodeType: "Godot.Control", visible: true },
      { ...glyph(), parentId: "World" },
      { id: "Dialog", parentId: "Game", name: "Dialog", nodeType: "Godot.Control", visible: true },
      {
        id: "Scrim",
        parentId: "Dialog",
        name: "Scrim",
        nodeType: "Godot.ColorRect",
        visible: true,
        transform: xf(0, 0),
        localRect: rect(0, 0, 1920, 1080),
        fillColor: { r: 0, g: 0, b: 0, a: 0.851, html: "#000000d9" },
        mouseFilter: 2
      }
    ];
  }

  it("pauses the strip while covered and resumes it (re-phased) on reveal", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, coveredScene());
    // The gate engages only after OCCLUSION_ENGAGE_WALKS consecutive qualifying walks.
    renderer.reconcile(state);
    expect(strip(stage)!.style.animationPlayState).toBe("");
    renderer.reconcile(state);
    renderer.reconcile(state);
    expect(strip(stage)!.style.animationPlayState).toBe("paused");

    // Reveal: the cover goes away → the animation runs again immediately (no hysteresis on disengage).
    clock += 500;
    full(state, coveredScene().filter((n) => n.id !== "Scrim"));
    renderer.reconcile(state);
    expect(strip(stage)!.style.animationPlayState).toBe("");
    renderer.dispose();
  });
});
