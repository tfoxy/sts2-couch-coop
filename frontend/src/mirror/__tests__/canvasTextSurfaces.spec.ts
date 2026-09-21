import { describe, expect, it } from "vitest";

import type { CanvasTextureCache, ExecutorTexture } from "@godot-scene-web/canvas";

import { baselineOf, layoutText, resolveTextSpec, textDigest, type TextSpec } from "@/mirror/canvas/textLayout";
import {
  SCRATCH_MAX_TEX_W_DEFAULT,
  TEXT_ATLAS_GUTTER,
  TEXT_KEY_PREFIX,
  TEXT_PAGE_DIM,
  TEXT_SHELF_QUANTUM,
  createTextSurfaces,
  inkBoxOf,
  textDigestFromKey,
  textKeyFor
} from "@/mirror/canvas/textSurfaces";
import { createTextureBridge } from "@/mirror/canvas/textureBridge";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorNode } from "@/mirror/sceneTree";

// THE FOURTH TEXTURE REGISTRY. jsdom has no 2D context, so the scratch canvas is stood in for by a recorder that
// reports a fixed metric and logs every draw call — which is what lets these specs assert the RASTER's structure
// (three passes, stroke under fill, the shadow carrying the stroke) rather than its pixels. The pacing, residency
// and eviction rules are the shape `spineSurfaces` established and are asserted the same way.

/** Every character measures this wide in the fake context, and the fake face is 20 up / 5 down. */
const CH = 10;
const ASCENT = 20;
const DESCENT = 5;
/**
 * …AND THE FALLBACK FACE, which is a DIFFERENT width and a different line box.
 *
 * The whole point of modelling two faces: `ctx.font` resolves its face AT ASSIGNMENT, so a context that was told
 * a font string while the face was still loading keeps measuring in the fallback until something ASSIGNS AGAIN —
 * and no number disagrees with any other number while that is true, because every measurement is taken through
 * the same wrong face. Before this the fake's `measureText` ignored `ctx.font` entirely, which made every
 * font-resolution defect in this module structurally invisible to every spec in this file.
 */
const FALLBACK_CH = 6;
const FALLBACK_ASCENT = 16;
const FALLBACK_DESCENT = 4;

interface DrawCall {
  op: "fill" | "stroke";
  text: string;
  x: number;
  y: number;
  color: string;
  lineWidth: number;
}

/** Which face an assignment RESOLVED to — `null` between a canvas resize and the next assignment. */
type ResolvedFace = "real" | "fallback" | null;

/**
 * ONE ORDERED SEQUENCE of everything the module did to the context.
 *
 * Separate arrays (`sizes`, `scales`, `calls`) can each say what happened but none of them can say what happened
 * BEFORE what, and the ordering across them is exactly the question a font-resolution defect turns on: a measure
 * taken before the resize and a draw taken after it can run under different faces, and only an interleaved log
 * shows that.
 */
type FakeEvent =
  | { kind: "font"; value: string; resolved: Exclude<ResolvedFace, null> }
  | { kind: "resize"; w: number; h: number }
  | { kind: "measure"; text: string; width: number; face: ResolvedFace }
  // Fill and stroke are separate members rather than one with a `"fill" | "stroke"` tag: `Extract` distributes
  // over the UNION, not over a member's own tag union, so a combined member cannot be narrowed to just the fills.
  | { kind: "fill"; text: string; face: ResolvedFace }
  | { kind: "stroke"; text: string; face: ResolvedFace };

interface FakeFaces {
  /** Has this exact font string's face arrived? Consulted at ASSIGNMENT time and never again. */
  ready(font: string): boolean;
}

interface FakeCanvas {
  el: HTMLCanvasElement;
  calls: DrawCall[];
  sizes: Array<[number, number]>;
  scales: Array<[number, number]>;
  translates: Array<[number, number]>;
  baselines: string[];
  /** The interleaved log. See {@link FakeEvent}. */
  events: FakeEvent[];
  /** Font ASSIGNMENTS in order — the memo's observable behaviour, one entry per write that actually happened. */
  fontWrites: () => { value: string; resolved: "real" | "fallback" }[];
  /** Every `fillText`, carrying the face that was IN FORCE when it ran — the draw's own side of the memo. */
  fills: () => Extract<FakeEvent, { kind: "fill" }>[];
  /** The face in force right now, i.e. the one the NEXT measure or draw would speak. */
  face: () => ResolvedFace;
}

/** Everything is loaded unless a spec says otherwise — which is what keeps every pre-existing pin unchanged. */
const ALL_FACES_READY: FakeFaces = { ready: () => true };

function fakeCanvas(faces: FakeFaces = ALL_FACES_READY): FakeCanvas {
  const calls: DrawCall[] = [];
  const sizes: Array<[number, number]> = [];
  const scales: Array<[number, number]> = [];
  const translates: Array<[number, number]> = [];
  const baselines: string[] = [];
  const events: FakeEvent[] = [];
  const state = { fillStyle: "", strokeStyle: "", lineWidth: 0, font: "", face: null as ResolvedFace };
  /** The drawing-state stack `save`/`restore` push and pop. See the note on those two below. */
  const stack: (typeof state)[] = [];
  const metrics = () =>
    state.face === "real"
      ? { ch: CH, ascent: ASCENT, descent: DESCENT }
      : { ch: FALLBACK_CH, ascent: FALLBACK_ASCENT, descent: FALLBACK_DESCENT };
  const ctx = {
    set font(v: string) {
      // RESOLUTION HAPPENS HERE, once, against readiness AS OF NOW. A face that lands later does not retroactively
      // fix this assignment — only another assignment can, which is the property the memo is able to defeat.
      state.font = v;
      state.face = faces.ready(v) ? "real" : "fallback";
      events.push({ kind: "font", value: v, resolved: state.face });
    },
    get font() {
      // THE STRING, not the face. A real `CanvasRenderingContext2D` serializes back what it was told and says
      // nothing about what it resolved — so a spec (or a probe) that expects this getter to witness a fallback is
      // expecting something no browser offers, and the fake must not pretend otherwise.
      return state.font;
    },
    set fillStyle(v: string) {
      state.fillStyle = v;
    },
    get fillStyle() {
      return state.fillStyle;
    },
    set strokeStyle(v: string) {
      state.strokeStyle = v;
    },
    get strokeStyle() {
      return state.strokeStyle;
    },
    set lineWidth(v: number) {
      state.lineWidth = v;
    },
    get lineWidth() {
      return state.lineWidth;
    },
    set textBaseline(v: string) {
      baselines.push(v);
    },
    textAlign: "left",
    lineJoin: "round",
    miterLimit: 2,
    measureText: (s: string) => {
      const m = metrics();
      const width = s.length * m.ch;
      events.push({ kind: "measure", text: s, width, face: state.face });
      return { width, fontBoundingBoxAscent: m.ascent, fontBoundingBoxDescent: m.descent };
    },
    clearRect: () => {},
    // SAVE/RESTORE MOVE THE FONT, and modelling that is the whole reason this fake was upgraded.
    //
    // `font` is part of a 2D context's DRAWING STATE, exactly like `fillStyle` and `lineWidth`, so `restore()`
    // puts back whatever font was in force at the matching `save()` — silently, and with no way for a caller to
    // observe it except by measuring. A fake whose `save`/`restore` are no-ops therefore cannot express the
    // single most likely way for a memoized font assignment to go stale, which made the defect this file is now
    // about structurally unreachable from every spec in it. Scoped to the state this module actually touches.
    save: () => {
      stack.push({ ...state });
    },
    restore: () => {
      const prev = stack.pop();
      if (prev) Object.assign(state, prev);
    },
    scale: (x: number, y: number) => scales.push([x, y]),
    translate: (x: number, y: number) => translates.push([x, y]),
    fillText: (text: string, x: number, y: number) => {
      calls.push({ op: "fill", text, x, y, color: state.fillStyle, lineWidth: 0 });
      events.push({ kind: "fill", text, face: state.face });
    },
    strokeText: (text: string, x: number, y: number) => {
      calls.push({ op: "stroke", text, x, y, color: state.strokeStyle, lineWidth: state.lineWidth });
      events.push({ kind: "stroke", text, face: state.face });
    }
  };
  // SIZING A CANVAS RESETS ITS CONTEXT, font included — which is why the module re-declares the font after the
  // resize and clears its own memo. The fake drops the resolved face to null so that a measure taken in that
  // window would be visibly face-less rather than silently inheriting the old one.
  const onResize = (w: number, h: number) => {
    state.font = "";
    state.face = null;
    events.push({ kind: "resize", w, h });
  };
  const el = {
    _w: 0,
    _h: 0,
    get width() {
      return this._w;
    },
    set width(v: number) {
      this._w = v;
      sizes.push([v, this._h]);
      onResize(v, this._h);
    },
    get height() {
      return this._h;
    },
    set height(v: number) {
      this._h = v;
      const last = sizes[sizes.length - 1];
      if (last) last[1] = v;
      const lastEvent = events[events.length - 1];
      if (lastEvent && lastEvent.kind === "resize") lastEvent.h = v;
    },
    // The scratch probe's readback. A constant: these specs are about WHICH acquires get sampled and what
    // arithmetic the sample carries, never about the pixels — jsdom has none to give.
    toDataURL: () => "data:image/png;base64,SCRATCH",
    getContext: () => ctx
  };
  return {
    el: el as unknown as HTMLCanvasElement,
    calls,
    sizes,
    scales,
    translates,
    baselines,
    events,
    fontWrites: () =>
      events.filter((e): e is Extract<FakeEvent, { kind: "font" }> => e.kind === "font").map((e) => ({ value: e.value, resolved: e.resolved })),
    fills: () => events.filter((e): e is Extract<FakeEvent, { kind: "fill" }> => e.kind === "fill"),
    face: () => state.face
  };
}

interface FakeCache extends CanvasTextureCache {
  uploaded: string[];
  released: string[];
  failNext(key: string): void;
  /** R6 P6-D2: page keys allocated through `acquireBytes`, and the region writes made into each. */
  pageBytes: Map<string, { w: number; h: number }>;
  regionWrites: { key: string; x: number; y: number; w: number; h: number }[];
}

function fakeCache(): FakeCache {
  const entries = new Map<string, ExecutorTexture>();
  const uploaded: string[] = [];
  const released: string[] = [];
  const failing = new Set<string>();
  const pageBytes = new Map<string, { w: number; h: number }>();
  const regionWrites: { key: string; x: number; y: number; w: number; h: number }[] = [];
  const stats = { entries: 0, uploads: 0, evictions: 0, bytes: 0, respecs: 0 };
  return {
    uploaded,
    released,
    failNext: (key) => failing.add(key),
    pageBytes,
    regionWrites,
    stats,
    white: () => ({ texture: {} as WebGLTexture, width: 1, height: 1, revision: 1 }),
    peek: (key) => entries.get(key),
    acquire: (key, source) => {
      if (failing.has(key)) {
        failing.delete(key);
        throw new Error("the driver would not take this source");
      }
      const src = source as { width?: number; height?: number };
      const handle = { texture: {} as WebGLTexture, width: src.width ?? 1, height: src.height ?? 1, revision: 1 };
      entries.set(key, handle);
      stats.entries++;
      stats.uploads++;
      uploaded.push(key);
      return handle;
    },
    // R6 P6-D2 — an ATLAS PAGE is allocated from zeroed bytes; only the LABEL rasters are canvas elements.
    acquireBytes: (key, pixels, width, height) => {
      const handle = { texture: {} as WebGLTexture, width, height, revision: 1 };
      entries.set(key, handle);
      pageBytes.set(key, { w: width, h: height });
      stats.entries++;
      stats.uploads++;
      uploaded.push(key);
      // The gutter argument depends on the page being CLEARED, so the fake checks it rather than assuming it.
      if (pixels.some((b) => b !== 0)) {
        throw new Error("an atlas page must be allocated zeroed");
      }
      return handle;
    },
    retain: (key) => entries.get(key)!,
    release: (key) => {
      released.push(key);
      entries.delete(key);
    },
    update: () => {
      throw new Error("a label raster is IMMUTABLE per digest — it acquires, it never updates");
    },
    // gsw's own contract, restated: a rect outside the storage is refused with null and no write.
    updateRegion: (key, source, x, y) => {
      const page = pageBytes.get(key);
      const entry = entries.get(key);
      if (!page || !entry) return null;
      const src = source as { width?: number; height?: number };
      const w = src.width ?? 0;
      const h = src.height ?? 0;
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || w <= 0 || h <= 0) return null;
      if (x + w > page.w || y + h > page.h) return null;
      regionWrites.push({ key, x, y, w, h });
      stats.uploads++;
      return entry;
    },
    reset: () => entries.clear(),
    dispose: () => entries.clear()
  };
}

function nodeOf(over: Record<string, unknown>): MirrorNode {
  const state = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      orderedIds: ["n"],
      upserts: [
        {
          id: "n",
          parentId: null,
          name: "n",
          nodeType: "Godot.Label",
          transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
          localRect: { position: { x: 0, y: 0 }, size: { x: 200, y: 60 } },
          visible: true,
          font: { resourcePath: "res://fonts/kreon_regular.ttf" },
          ...over
        }
      ]
    })!
  );
  return state.nodes.get("n")!;
}

function specOf(text: string, over: Record<string, unknown> = {}): TextSpec {
  return resolveTextSpec(
    nodeOf({ text: { text, fontSize: 20, textColor: { html: "#ffffffff" }, ...over } }),
    { self: {}, text: {} }
  )!;
}

/** A registry over the fakes, plus the helper that drives one label all the way through it. */
function harness(options: Partial<Parameters<typeof createTextSurfaces>[0]> = {}, faces: FakeFaces = ALL_FACES_READY) {
  const cache = fakeCache();
  const canvas = fakeCanvas(faces);
  const texts = createTextSurfaces({ cache, createCanvas: () => canvas.el, ...options });
  const draw = (spec: TextSpec, scale = 1) => {
    const digest = textDigest(spec, scale);
    const hit = texts.boxFor(digest);
    if (hit) return { digest, box: hit, hit: true };
    const layout = layoutText(spec, texts.measureFor(spec.cssFont)!);
    return { digest, box: texts.acquire(digest, spec, layout, scale), hit: false };
  };
  return { cache, canvas, texts, draw };
}

describe("the text raster key space", () => {
  it("namespaces a digest so it cannot collide with a page url in the shared cache", () => {
    expect(textKeyFor("abc")).toBe(`${TEXT_KEY_PREFIX}abc`);
    expect(textDigestFromKey(textKeyFor("abc"))).toBe("abc");
  });

  it("does not claim a key belonging to another population", () => {
    expect(textDigestFromKey("spine:///spines/iron")).toBeNull();
    expect(textDigestFromKey("/res/cards.png")).toBeNull();
  });
});

describe("inkBoxOf — what the raster has to cover", () => {
  const spec = specOf("abcd");

  it("covers the INK, not the streamed box — a short label in a wide plaque wastes no texture", () => {
    const layout = layoutText(spec, (s) => s.length * CH);
    const ink = inkBoxOf(layout, spec, ASCENT, DESCENT);
    // 4 chars = 40px of ink in a 200px box, plus the 1px antialias skirt on each side.
    expect(ink.w).toBeCloseTo(42, 5);
    expect(ink.h).toBeCloseTo(ASCENT + DESCENT + 2, 5);
  });

  it("grows for an outline, which is a CENTRED stroke straddling the glyph edge", () => {
    const outlined = specOf("abcd", { outlineColor: { html: "#000000ff" }, outlineSize: 10 });
    const layout = layoutText(outlined, (s) => s.length * CH);
    const ink = inkBoxOf(layout, outlined, ASCENT, DESCENT);
    // outlinePx is 5 after OUTLINE_SCALE; half of it lands outside, so 2.5 per side plus the skirt.
    expect(ink.w).toBeCloseTo(40 + 2 * (2.5 + 1), 5);
  });

  it("grows in the SHADOW's direction only — a shadow displaces ink one way", () => {
    const shadowed = resolveTextSpec(
      nodeOf({
        text: { text: "abcd", fontSize: 20, textColor: { html: "#ffffffff" } },
        shadow: { color: { html: "#000000aa" }, offset: { x: 3, y: 4 } }
      }),
      { self: {}, text: {} }
    )!;
    const layout = layoutText(shadowed, (s) => s.length * CH);
    const ink = inkBoxOf(layout, shadowed, ASCENT, DESCENT);
    expect(ink.w).toBeCloseTo(40 + 1 + (1 + 3), 5);
    expect(ink.h).toBeCloseTo(ASCENT + DESCENT + 1 + (1 + 4), 5);
    // …and the origin does NOT move for a positive offset: the shadow grows the box to the right and down.
    expect(ink.dx).toBeCloseTo(-1, 5);
  });

  it("lets ink escape ABOVE the line box when the pitch is tighter than the font", () => {
    // The End-Turn rule's `calc(0.79em + 1px)` is deliberately tighter than ascent+descent, so the half-leading
    // goes negative — which is what the browser does with it too, and a raster that clamped would crop the caps.
    const tight = resolveTextSpec(nodeOf({ text: { text: "ab", fontSize: 20, textColor: { html: "#fff" } } }), {
      self: {},
      text: { "line-height": "calc(0.5em + 0px)" }
    })!;
    const layout = layoutText(tight, (s) => s.length * CH);
    const ink = inkBoxOf(layout, tight, ASCENT, DESCENT);
    expect(tight.pitchPx).toBe(10);
    // half-leading = (10 - 25)/2 = -7.5, so the ink starts above the line box's top.
    expect(ink.dy).toBeCloseTo(-7.5 - 1, 5);
  });

  it("answers a zero box for a layout with no lines", () => {
    expect(inkBoxOf({ lines: [], blockW: 0, blockH: 0, wrapped: false }, spec, ASCENT, DESCENT)).toEqual({
      dx: 0,
      dy: 0,
      w: 0,
      h: 0
    });
  });
});

describe("the raster itself", () => {
  it("draws the outline UNDER the fill — `paint-order: stroke fill`, the DOM path's own declaration", () => {
    const { canvas, draw } = harness();
    draw(specOf("hi", { outlineColor: { html: "#000000ff" }, outlineSize: 10 }));
    expect(canvas.calls.map((c) => c.op)).toEqual(["stroke", "fill"]);
    expect(canvas.calls[0].lineWidth).toBe(5);
    expect(canvas.calls[0].color).toBe("#000000ff");
    expect(canvas.calls[1].color).toBe("#ffffffff");
  });

  it("draws the SHADOW as a whole extra pass FIRST, carrying the stroke", () => {
    // CSS composites a silhouette of the element's ink — outline included — behind it. A shadow pass that drew
    // only the fill would be visibly thinner than the DOM's on every outlined label, which is most of them.
    const { canvas, draw } = harness();
    const spec = resolveTextSpec(
      nodeOf({
        text: { text: "hi", fontSize: 20, textColor: { html: "#ffffffff" }, outlineColor: { html: "#000000ff" }, outlineSize: 10 },
        shadow: { color: { html: "#00000088" }, offset: { x: 2, y: 2 } }
      }),
      { self: {}, text: {} }
    )!;
    draw(spec);
    expect(canvas.calls.map((c) => `${c.op}:${c.color}`)).toEqual([
      "stroke:#00000088",
      "fill:#00000088",
      "stroke:#000000ff",
      "fill:#ffffffff"
    ]);
  });

  it("offsets the shadow pass and only the shadow pass", () => {
    const { canvas, draw } = harness();
    const spec = resolveTextSpec(
      nodeOf({
        text: { text: "hi", fontSize: 20, textColor: { html: "#ffffffff" } },
        shadow: { color: { html: "#00000088" }, offset: { x: 2, y: 3 } }
      }),
      { self: {}, text: {} }
    )!;
    draw(spec);
    const [shadow, main] = canvas.calls;
    expect(shadow.x - main.x).toBeCloseTo(2, 5);
    expect(shadow.y - main.y).toBeCloseTo(3, 5);
  });

  it("draws one call per LINE, on the alphabetic baseline", () => {
    const { canvas, draw } = harness();
    draw(specOf("ab\ncd"));
    expect(canvas.calls.map((c) => c.text)).toEqual(["ab", "cd"]);
    expect(canvas.baselines).toContain("alphabetic");
    // The second line sits one pitch below the first.
    expect(canvas.calls[1].y - canvas.calls[0].y).toBeCloseTo(20 * 1.1, 5);
  });

  it("sizes the texture in DEVICE px and scales the context to match", () => {
    const { canvas, draw } = harness();
    const out = draw(specOf("abcd"), 2);
    expect(out.box).not.toBeNull();
    expect(out.box!.w).toBeCloseTo(42, 5); // box space
    expect(out.box!.texW).toBe(84); // device px
    expect(canvas.scales.at(-1)).toEqual([2, 2]);
    expect(canvas.sizes.at(-1)).toEqual([84, out.box!.texH]);
  });

  it("translates the context so the ink's own origin lands at the texture's 0,0", () => {
    const { canvas, draw } = harness();
    const out = draw(specOf("abcd"));
    expect(canvas.translates.at(-1)).toEqual([-out.box!.dx, -out.box!.dy]);
  });
});

describe("the registry's residency rules", () => {
  it("reuses one texture for two labels that say the same thing in the same style", () => {
    const { cache, draw, texts } = harness();
    const first = draw(specOf("80"));
    const second = draw(specOf("80"));
    expect(second.hit).toBe(true);
    expect(second.box).toEqual(first.box);
    // ONE raster, whichever arm. On the atlas arm `cache.uploaded` also carries the page allocation, so the
    // question is asked of the registry's own upload count rather than of the cache's entry list.
    expect(texts.stats().uploads).toBe(1);
    expect(cache.regionWrites).toHaveLength(1);
  });

  it("skips the LAYOUT entirely on a hit — the whole reason the digest is checked first", () => {
    const { canvas, draw } = harness();
    const spec = specOf("80");
    draw(spec);
    const before = canvas.calls.length;
    const again = draw(spec);
    expect(again.hit).toBe(true);
    expect(canvas.calls.length).toBe(before); // not one further draw call
  });

  it("paces uploads per build and lands the rest on the next one", () => {
    const { draw, texts } = harness({ paceCount: 1 });
    expect(draw(specOf("a")).box).not.toBeNull();
    expect(draw(specOf("b")).box).toBeNull(); // …and `b` keeps its overlay element for one more build
    expect(texts.stats().paced).toBe(1);
    texts.endBuild();
    expect(draw(specOf("b")).box).not.toBeNull();
  });

  it("refuses an upload that would breach the resident byte ceiling", () => {
    // A 4-char label rasters to 42x27 (4,536 B) and a 20-char one to 202x27 (21,816 B), so a 10 KB ceiling
    // admits the first and cannot admit the second. Asked of the DEDICATED arm, which is where a label's own
    // bytes are what residency means; the atlas arm's answer to the same ceiling is the case below.
    const { draw, texts } = harness({ paceBytes: 10_000, paceCount: 0, pageDim: 0 });
    expect(draw(specOf("aaaa")).box).not.toBeNull();
    expect(draw(specOf("bbbbbbbbbbbbbbbbbbbb")).box).toBeNull();
    expect(texts.stats().refusedForBudget).toBe(1);
    // The ceiling is on RESIDENCY, so this is not a deferral — ending the build does not admit it either.
    texts.endBuild();
    expect(draw(specOf("bbbbbbbbbbbbbbbbbbbb")).box).toBeNull();
  });

  it("refuses the PAGE, not the label, when the ceiling cannot hold one (R6 P6-D2)", () => {
    // On the atlas arm the ceiling is asked about the 4 MB allocation, because that is the only thing residency
    // grows by: a rect that fits an existing shelf costs nothing. A ceiling under one page therefore admits
    // NOTHING, and says so with its own counter rather than by silently minting the dedicated textures the
    // ceiling was about to stop.
    const { draw, texts } = harness({ paceBytes: 1_000, paceCount: 0 });
    expect(draw(specOf("aaaa")).box).toBeNull();
    expect(texts.stats().atlasFull).toBe(1);
    expect(texts.stats().pages).toBe(0);
    expect(texts.stats().refusedForBudget).toBe(0);
  });

  it("declines a raster larger than the driver's maximum rather than uploading a black slab", () => {
    const { draw, texts } = harness({ maxTextureDim: 32 });
    expect(draw(specOf("aaaaaaaaaa")).box).toBeNull();
    expect(texts.stats().declined).toBe(1);
    // …and never retries it: a permanent property of the raster's size, not a transient budget.
    draw(specOf("aaaaaaaaaa"));
    expect(texts.stats().declined).toBe(1);
  });

  it("declines a source the driver refuses, and does not retry it every build", () => {
    // The dedicated arm: on the atlas arm a label never calls `acquire` under its own key, so there is no source
    // for a driver to refuse — the page's allocation is the only thing that can fail, and it fails once.
    const { cache, draw, texts } = harness({ pageDim: 0 });
    const spec = specOf("hi");
    cache.failNext(textKeyFor(textDigest(spec, 1)));
    expect(draw(spec).box).toBeNull();
    expect(texts.stats().declined).toBe(1);
    expect(draw(spec).box).toBeNull();
    expect(texts.stats().uploads).toBe(0);
  });

  it("evicts a digest no build has named for the eviction window", () => {
    const { cache, draw, texts } = harness({ evictAfterBuilds: 2, pageDim: 0 });
    const spec = specOf("hi");
    draw(spec);
    const key = textKeyFor(textDigest(spec, 1));
    texts.endBuild();
    texts.endBuild();
    expect(cache.released).toContain(key);
    expect(texts.stats().evicted).toBe(1);
  });

  it("does NOT evict a digest the pacer is holding back — naming happens on a miss too", () => {
    // A paced label is still on screen. If a miss did not name it, the pacer and the evictor would fight and the
    // label would never land.
    const { draw, texts } = harness({ paceCount: 1, evictAfterBuilds: 2 });
    draw(specOf("a"));
    for (let i = 0; i < 4; i++) {
      draw(specOf("b")); // paced every time while `a` holds the single slot
      texts.endBuild();
    }
    expect(texts.stats().evicted).toBeLessThanOrEqual(1); // `a` may age out; `b` was never resident to evict
    expect(draw(specOf("b")).box).not.toBeNull();
  });

  it("forgets its uploads on context loss WITHOUT touching the dead driver", () => {
    const { cache, draw, texts } = harness();
    draw(specOf("hi"));
    const releasedBefore = cache.released.length;
    texts.invalidate();
    expect(cache.released).toHaveLength(releasedBefore); // no release against a context that is gone
    expect(texts.stats().resident).toBe(0);
    expect(texts.stats().bytes).toBe(0);
  });

  it("re-uploads after a context loss instead of trusting a stale box", () => {
    const { cache, draw, texts } = harness();
    const spec = specOf("hi");
    draw(spec);
    texts.invalidate();
    cache.reset();
    expect(draw(spec).hit).toBe(false);
    expect(cache.uploaded).toHaveLength(2);
  });

  it("reports a size in TEXTURE pixels — what a quad's source rect is expressed in", () => {
    const { draw, texts } = harness({ pageDim: 0 });
    const spec = specOf("abcd");
    const out = draw(spec, 2);
    expect(texts.sizeOf(out.digest)).toEqual({ width: out.box!.texW, height: out.box!.texH });
    expect(out.box).toMatchObject({ texX: 0, texY: 0 });
  });

  it("counts a digest collision and REFUSES the second claimant rather than drawing the wrong words", () => {
    // Structurally impossible with a NUL-joined descriptor, which is why this is a counter — but if it ever
    // happened, two labels would share one texture and one of them would be wrong. The instrument has to exist.
    const { draw, texts } = harness();
    const spec = specOf("hi");
    const digest = textDigest(spec, 1);
    draw(spec);
    texts.endBuild();
    const impostor = specOf("DIFFERENT WORDS");
    const layout = layoutText(impostor, texts.measureFor(impostor.cssFont)!);
    expect(texts.acquire(digest, impostor, layout, 1)).toBeNull();
    expect(texts.stats().digestCollisions).toBe(1);
  });

  it("has no digest collisions on ordinary traffic", () => {
    const { texts, draw } = harness({ paceCount: 0 });
    for (const word of ["80", "45/45", "END TURN", "Strike", "80", "Defend"]) {
      draw(specOf(word));
    }
    expect(texts.stats().digestCollisions).toBe(0);
  });

  it("answers null for everything when there is no 2D context at all", () => {
    const cache = fakeCache();
    const texts = createTextSurfaces({
      cache,
      createCanvas: () => ({ getContext: () => null }) as unknown as HTMLCanvasElement
    });
    expect(texts.measureFor('20px "kreon_regular"')).toBeNull();
    expect(texts.lineMetricsFor('20px "kreon_regular"')).toBeNull();
    const spec = specOf("hi");
    expect(texts.acquire(textDigest(spec, 1), spec, { lines: [], blockW: 0, blockH: 0, wrapped: false }, 1)).toBeNull();
    expect(cache.uploaded).toHaveLength(0);
  });
});

// --- the published line box (`lineMetricsFor`) -------------------------------------------------------------------
//
// The GLYPH path draws outlines and owns no 2D context, so the only place it can get a face's ascent and descent
// is here — and it has to be the SAME two numbers this module's own raster is placed with, or a screen that mixes
// the two backends (which is every screen: an outlined label can only raster) shows a row of labels at two
// different heights. Before this seam existed that path guessed `0.8 * fontPx` and drew most of a pixel high.

describe("the face's line box, published", () => {
  it("answers the face's OWN metrics, and they are the ones the raster is drawn with", () => {
    const { canvas, texts, draw } = harness({ paceCount: 0 });
    const spec = specOf("abcd");
    const metrics = texts.lineMetricsFor(spec.cssFont);
    expect(metrics).toEqual({ ascent: ASCENT, descent: DESCENT });
    // THE CLAIM ITSELF: the baseline the shared arithmetic computes from these metrics is the y the raster path
    // passed to `fillText`. Same expression, same numbers, same row of pixels — which is what the glyph path is
    // then entitled to place its pen origin at.
    draw(spec);
    const fill = canvas.calls.find((c) => c.op === "fill")!;
    expect(fill.y).toBeCloseTo(baselineOf(0, spec.pitchPx, metrics!), 10);
  });

  it("measures ONCE per shorthand — `blockFor` asks per label per build", () => {
    // A hundred labels on a screen is a hundred calls per build, and `measureText` forces layout work. The memo
    // is keyed on the whole shorthand, so a second SIZE of the same family is legitimately a second measurement.
    const { canvas, texts } = harness({ paceCount: 0 });
    const font = '20px "kreon_regular"';
    const probes = () => canvas.events.filter((e) => e.kind === "measure" && e.text === "M").length;
    texts.lineMetricsFor(font);
    const after = probes();
    for (let i = 0; i < 50; i++) {
      expect(texts.lineMetricsFor(font)).toEqual({ ascent: ASCENT, descent: DESCENT });
    }
    expect(probes()).toBe(after);
    texts.lineMetricsFor('14px "kreon_regular"');
    expect(probes()).toBe(after + 1);
  });

  it("REFUSES while the face is still loading rather than answering for the fallback", () => {
    // The whole reason this returns null at all. `measureText` never fails: with the face still in flight it
    // answers for whatever the browser fell back to, so a caller that took the number would place a real face's
    // baseline at a stranger's ascent — a WRONG answer, not a missing one, and nothing downstream could see it.
    let loaded = false;
    const canvas = fakeCanvas({ ready: () => loaded });
    const texts = createTextSurfaces({
      cache: fakeCache(),
      createCanvas: () => canvas.el,
      fonts: { check: () => loaded, load: () => new Promise<void>(() => {}) }
    });
    const font = '20px "kreon_regular"';
    expect(texts.lineMetricsFor(font)).toBeNull();
    // …and the refusal is not cached as a failure either: the face lands, and the next ask is the real face's.
    loaded = true;
    expect(texts.lineMetricsFor(font)).toEqual({ ascent: ASCENT, descent: DESCENT });
    expect(canvas.fontWrites().every((e) => e.resolved === "real")).toBe(true);
  });
});

// --- the font readiness gate --------------------------------------------------------------------------------
//
// The failure this prevents is not a slow first frame: a raster taken before the face arrives BAKES the browser's
// fallback typeface into a texture that is then reused for as long as the label says the same words. Permanently
// wrong pixels, and invisible to any gate that reads the requested font-family rather than the drawn glyphs —
// which is exactly how the canvas stage rendered every label in sans-serif for two rounds.

describe("the font readiness gate", () => {
  function fontEnv(ready: boolean) {
    let resolve: () => void = () => {};
    let reject: (e: unknown) => void = () => {};
    const loaded = new Promise<void>((r, j) => {
      resolve = r;
      reject = j;
    });
    // UNHANDLED-REJECTION GUARD: the registry attaches its own handler, but a spec that rejects before the
    // registry has asked for the face would otherwise take the run down with it.
    loaded.catch(() => {});
    let available = ready;
    const loads: string[] = [];
    return {
      loads,
      settle: () => {
        available = true;
        resolve();
        return loaded;
      },
      /** The host cannot serve this face. A DIFFERENT settlement from `settle`, and it must stay different. */
      fail: async () => {
        reject(new Error("the host has no such font"));
        await loaded.catch(() => {});
        await Promise.resolve();
      },
      fonts: {
        check: () => available,
        load: (font: string) => {
          loads.push(font);
          return loaded;
        }
      }
    };
  }

  it("REFUSES to raster before the face has loaded — the fallback would be baked in forever", () => {
    const cache = fakeCache();
    const canvas = fakeCanvas();
    const env = fontEnv(false);
    const texts = createTextSurfaces({ cache, createCanvas: () => canvas.el, fonts: env.fonts });
    const spec = specOf("hi");
    const layout = layoutText(spec, (s) => s.length * CH);
    expect(texts.acquire(textDigest(spec, 1), spec, layout, 1)).toBeNull();
    expect(texts.stats().fontsPending).toBe(1);
    expect(texts.stats().fontWaits).toBe(1);
    expect(canvas.calls).toHaveLength(0); // nothing was drawn at all
    expect(cache.uploaded).toHaveLength(0);
  });

  it("asks for the face ONCE, however many builds go by", () => {
    const cache = fakeCache();
    const canvas = fakeCanvas();
    const env = fontEnv(false);
    const texts = createTextSurfaces({ cache, createCanvas: () => canvas.el, fonts: env.fonts });
    const spec = specOf("hi");
    const layout = layoutText(spec, (s) => s.length * CH);
    for (let i = 0; i < 5; i++) {
      texts.acquire(textDigest(spec, 1), spec, layout, 1);
      texts.endBuild();
    }
    expect(env.loads).toHaveLength(1);
  });

  // --- the gauge, and why it is not the total ------------------------------------------------------------------
  //
  // The flip criterion is "`fontsPending` 0 on a settled screen", and until R8 the number it named could not
  // return to zero: one increment site, no decrement, so a healthy warm-up in which every face arrived still read
  // 45 at settle. `fontWaits` is that reading, kept and honestly named; `fontsPending` is now the gauge the
  // criterion always meant.

  it("counts ATTEMPTS and MISSING FACES separately — five refusals of one face is one missing face", () => {
    const cache = fakeCache();
    const canvas = fakeCanvas();
    const env = fontEnv(false);
    const texts = createTextSurfaces({ cache, createCanvas: () => canvas.el, fonts: env.fonts });
    const spec = specOf("hi");
    const layout = layoutText(spec, (s) => s.length * CH);
    for (let i = 0; i < 5; i++) {
      texts.acquire(textDigest(spec, 1), spec, layout, 1);
      texts.endBuild();
    }
    expect(texts.stats().fontWaits).toBe(5);
    expect(texts.stats().fontsPending).toBe(1);
    expect(texts.stats().fontsFailed).toBe(0);
  });

  it("returns to ZERO when the face lands, which is the whole point of a gauge", async () => {
    const cache = fakeCache();
    const canvas = fakeCanvas();
    const env = fontEnv(false);
    const texts = createTextSurfaces({ cache, createCanvas: () => canvas.el, fonts: env.fonts });
    const spec = specOf("hi");
    const layout = layoutText(spec, (s) => s.length * CH);
    texts.acquire(textDigest(spec, 1), spec, layout, 1);
    expect(texts.stats().fontsPending).toBe(1);
    await env.settle();
    await Promise.resolve();
    // The ATTEMPT still happened and is still reported; what has changed is that nothing is missing any more.
    expect(texts.stats().fontsPending).toBe(0);
    expect(texts.stats().fontWaits).toBe(1);
  });

  it("moves a face the host cannot serve into its OWN guardrail, not into the pending gauge", async () => {
    // A rejected load and a slow load mean opposite things: this label will NEVER be rastered, so leaving it in
    // `fontsPending` would make the settle criterion permanently unsatisfiable for a serving problem, and summing
    // the two into one number would hide which of the two it was.
    const cache = fakeCache();
    const canvas = fakeCanvas();
    const env = fontEnv(false);
    const texts = createTextSurfaces({ cache, createCanvas: () => canvas.el, fonts: env.fonts });
    const spec = specOf("hi");
    const layout = layoutText(spec, (s) => s.length * CH);
    texts.acquire(textDigest(spec, 1), spec, layout, 1);
    await env.fail();
    expect(texts.stats().fontsFailed).toBe(1);
    expect(texts.stats().fontsPending).toBe(0);
    expect(texts.stats().fontWaits).toBe(1);
  });

  it("arms a repaint when the face lands, and rasters on the next attempt", async () => {
    const cache = fakeCache();
    const canvas = fakeCanvas();
    const env = fontEnv(false);
    let armed = 0;
    const texts = createTextSurfaces({
      cache,
      createCanvas: () => canvas.el,
      fonts: env.fonts,
      onFontReady: () => {
        armed++;
      }
    });
    const spec = specOf("hi");
    const layout = layoutText(spec, (s) => s.length * CH);
    expect(texts.acquire(textDigest(spec, 1), spec, layout, 1)).toBeNull();
    await env.settle();
    await Promise.resolve();
    expect(armed).toBe(1);
    expect(texts.acquire(textDigest(spec, 1), spec, layout, 1)).not.toBeNull();
    expect(cache.uploaded).toHaveLength(1);
  });

  it("rasters when there is no FontFaceSet at all — a gate that can never open is worse", () => {
    const cache = fakeCache();
    const canvas = fakeCanvas();
    const texts = createTextSurfaces({ cache, createCanvas: () => canvas.el, fonts: null });
    const spec = specOf("hi");
    const layout = layoutText(spec, (s) => s.length * CH);
    expect(texts.acquire(textDigest(spec, 1), spec, layout, 1)).not.toBeNull();
    expect(texts.stats().fontsPending).toBe(0);
  });
});

// --- T10/T11: colour runs, and the promise that the plain path did not move -------------------------------------
//
// The rich path is DEFAULT OFF and its own evidence table is next round's. What these pin is the only thing that
// licenses landing it now, while the plain path is the thing under measurement: with no spans, nothing changes.
// Not "changes compatibly" — the same calls in the same order, and the same digest bytes.

describe("colour runs in the raster", () => {
  const RED = "#ff0000";

  it("draws EXACTLY the old call sequence when no line carries runs", () => {
    const { canvas, draw } = harness({ paceCount: 0 });
    draw(specOf("ab\ncd", { outlineColor: { html: "#000000ff" }, outlineSize: 10 }));
    // Two lines, stroke pass then fill pass, one call per line per pass — the pre-runs sequence verbatim.
    expect(canvas.calls.map((c) => `${c.op}:${c.text}`)).toEqual(["stroke:ab", "stroke:cd", "fill:ab", "fill:cd"]);
  });

  it("fills each run at its OWN x in its OWN colour", () => {
    const { canvas, texts } = harness({ paceCount: 0 });
    const spec = specOf("abcd");
    const spans = [{ start: 0, end: 2, color: RED }];
    const layout = layoutText(spec, texts.measureFor(spec.cssFont)!, spans);
    expect(layout.lines[0].runs?.map((r) => r.text)).toEqual(["ab", "cd"]);
    texts.acquire(textDigest(spec, 1, spans), spec, layout, 1, spans);
    const fills = canvas.calls.filter((c) => c.op === "fill");
    expect(fills.map((f) => `${f.text}:${f.color}`)).toEqual([`ab:${RED}`, "cd:#ffffffff"]);
    // The second run starts one run-width along, and that x came from a CUMULATIVE prefix measurement rather
    // than a sum of piece widths — nothing in the rasterizer re-derives it.
    expect(fills[1].x - fills[0].x).toBeCloseTo(2 * CH, 5);
  });

  it("does NOT split the stroke per run — one outline, and no doubled ink at a seam", () => {
    // `spec.outlineColor` is a single value and `[outline_color]` is a named refusal in richSimple, so an outline
    // has no per-run colour to take. Stroking per run would also double the ink along every run boundary, where
    // one stroke over the whole line has none.
    const { canvas, texts } = harness({ paceCount: 0 });
    const spec = specOf("abcd", { outlineColor: { html: "#000000ff" }, outlineSize: 10 });
    const spans = [{ start: 0, end: 2, color: RED }];
    const layout = layoutText(spec, texts.measureFor(spec.cssFont)!, spans);
    texts.acquire(textDigest(spec, 1, spans), spec, layout, 1, spans);
    expect(canvas.calls.filter((c) => c.op === "stroke").map((c) => c.text)).toEqual(["abcd"]);
  });

  it("draws the SHADOW pass in the shadow's colour, runs and all — a silhouette has no colours", () => {
    const { canvas, texts } = harness({ paceCount: 0 });
    const spec = resolveTextSpec(
      nodeOf({
        text: { text: "abcd", fontSize: 20, textColor: { html: "#ffffffff" } },
        shadow: { color: { html: "#00000088" }, offset: { x: 2, y: 2 } }
      }),
      { self: {}, text: {} }
    )!;
    const spans = [{ start: 0, end: 2, color: RED }];
    const layout = layoutText(spec, texts.measureFor(spec.cssFont)!, spans);
    texts.acquire(textDigest(spec, 1, spans), spec, layout, 1, spans);
    const fills = canvas.calls.filter((c) => c.op === "fill");
    // Shadow pass: both runs in the shadow colour. Main pass: the run's own colour, then the spec's.
    expect(fills.map((f) => f.color)).toEqual(["#00000088", "#00000088", RED, "#ffffffff"]);
  });
});

describe("the digest and the witness under spans", () => {
  it("is BYTE-IDENTICAL with no spans, which is what lets this land early", () => {
    const spec = specOf("abcd");
    expect(textDigest(spec, 1, undefined)).toBe(textDigest(spec, 1));
    expect(textDigest(spec, 1, [])).toBe(textDigest(spec, 1));
  });

  it("cannot collide with a spanned digest, by COUNTING rather than by luck", () => {
    const spec = specOf("abcd");
    const plain = textDigest(spec, 1);
    const spanned = textDigest(spec, 1, [{ start: 0, end: 2, color: "#ff0000" }]);
    expect(spanned).not.toBe(plain);
    // The base is twelve NUL-joined fields, so eleven NULs; a spanned digest has twelve. No string with eleven
    // can equal one with twelve, whatever the game's words are. (Both counts rose by one when the paragraph gap
    // joined the base — what the argument needs is that they stay DISTINCT, not that they stay put.)
    const nuls = (v: string) => v.split("\u0000").length - 1;
    expect(nuls(plain)).toBe(11);
    expect(nuls(spanned)).toBe(12);
  });

  it("distinguishes two labels that say the same thing in different colours", () => {
    const spec = specOf("abcd");
    const a = textDigest(spec, 1, [{ start: 0, end: 2, color: "#ff0000" }]);
    const b = textDigest(spec, 1, [{ start: 0, end: 2, color: "#00ff00" }]);
    const c = textDigest(spec, 1, [{ start: 0, end: 3, color: "#ff0000" }]);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("catches a witness mismatch when one digest is claimed with different spans", () => {
    // The collision counter's own job, extended to runs: the words and the face are no longer sufficient on
    // their own, because two labels can say the same thing in the same face and differ only in what is red.
    const { texts } = harness({ paceCount: 0 });
    const spec = specOf("abcd");
    const digest = textDigest(spec, 1);
    const layout = layoutText(spec, texts.measureFor(spec.cssFont)!);
    expect(texts.acquire(digest, spec, layout, 1, [{ start: 0, end: 2, color: "#ff0000" }])).not.toBeNull();
    expect(texts.stats().digestCollisions).toBe(0);
    // Same digest string, different run colours: refused rather than allowed to draw the wrong pixels.
    expect(texts.acquire(digest, spec, layout, 1, [{ start: 0, end: 2, color: "#00ff00" }])).toBeNull();
    expect(texts.stats().digestCollisions).toBe(1);
  });
});

// --- the font memo, and the two ways it goes stale -------------------------------------------------------------
//
// THE DEFECT THESE ARE ABOUT, named by measurement rather than by argument (R8 R1,
// `.sts2/artifacts/r8-text/probe-pre/`): on the shop screen nine of eleven fragment rasters were SIZED from a
// measurement taken at `10px sans-serif` — a canvas's untouched default — and then DRAWN with the label's real
// 46.8px face. The glyphs land 4-5x larger than the surface allocated for them and only a corner survives the
// bound, which is the photographed "magnified fragment" exactly. Not one number disagreed with another at
// measure time, which is why `metricsMismatch` read 0 through the whole of round 7.
//
// The memo is what makes that possible: `setFont` writes `ctx.font` only when the string differs from the last
// one it wrote, and `ctx.font` resolves its face AT ASSIGNMENT. So an assignment that is SKIPPED leaves the
// context speaking whatever it was last actually told — and there are exactly two ways for that to stop being
// the string the memo remembers.

describe("the font memo's honesty", () => {
  it("re-declares the font after a restore, because restore MOVES it", () => {
    // SOURCE ONE, and the one R1 caught in the field. The raster brackets its draw in `save()`/`restore()`, and
    // the `save()` happens AFTER `target.width = texW` has reset the context — so the state it banks is the
    // canvas default, and the `restore()` at the end of the raster puts the default back. The memo is not told,
    // so the NEXT label that says the same font string measures at `10px sans-serif`.
    const { canvas, draw, texts } = harness({ paceCount: 0 });
    const first = draw(specOf("77"));
    expect(first.box).not.toBeNull();
    // A DIFFERENT label in the SAME face: it misses the digest cache, so it measures — and it must measure
    // through its own face, not through whatever the previous raster's `restore()` left behind.
    const second = draw(specOf("196"));
    expect(second.box).not.toBeNull();
    // 3 characters at the real face's 10px advance, plus the 1px skirt on each side.
    expect(second.box!.w).toBeCloseTo(3 * CH + 2, 5);
    expect(second.box!.h).toBeCloseTo(ASCENT + DESCENT + 2, 5);
    // …and the draw ran through the SAME face the sizing was taken from, which is the property that actually
    // matters. `fill` events carry the face in force when they ran.
    expect(canvas.fills().every((e) => e.face === "real")).toBe(true);
    expect(texts.stats().metricsMismatch).toBe(0);
  });

  it("still writes the font only ONCE for a run of labels that share a face", () => {
    // The memo's saving, pinned so the fix above cannot quietly become "assign on every measure". Within a single
    // label's layout the font is written once however many lines it measures; a new label needs one more write
    // because the raster's own `restore()` has since moved the context's font back.
    const { canvas, texts } = harness({ paceCount: 0 });
    const spec = specOf("ab\ncd\nef");
    const measure = texts.measureFor(spec.cssFont)!;
    const before = canvas.fontWrites().length;
    layoutText(spec, measure);
    expect(canvas.fontWrites().length - before).toBe(1);
    // A second batch through the same measurer, with no raster in between, writes nothing further at all.
    layoutText(spec, measure);
    expect(canvas.fontWrites().length - before).toBe(1);
  });

  it("never memoizes a font whose face has not arrived — the refusal path's own poisoning", () => {
    // SOURCE TWO. `measureFor` runs during the caller's LAYOUT, which happens before `acquire` is entered and so
    // before the readiness gate has said anything. A label measured while its face is still loading resolves to
    // the fallback and is then REFUSED — no raster, no `restore()`, and a memo that now claims the real string.
    // When the face lands the label is measured again, the memo suppresses the write, and the surface is sized
    // from the fallback's metrics while the draw uses the face that has since arrived.
    const cache = fakeCache();
    let loaded = false;
    let resolveLoad: () => void = () => {};
    const loadPromise = new Promise<void>((r) => {
      resolveLoad = r;
    });
    const canvas = fakeCanvas({ ready: () => loaded });
    const texts = createTextSurfaces({
      cache,
      createCanvas: () => canvas.el,
      paceCount: 0,
      fonts: {
        check: () => loaded,
        load: () => loadPromise
      }
    });
    const spec = specOf("196");
    const digest = textDigest(spec, 1);

    // Build 1: the face is not there. The layout measures (through the fallback) and the gate refuses.
    const measurer = texts.measureFor(spec.cssFont)!;
    expect(texts.acquire(digest, spec, layoutText(spec, measurer), 1)).toBeNull();
    expect(texts.stats().fontsPending).toBe(1);

    // …the face lands.
    loaded = true;
    resolveLoad();

    // Build 2: the same label, laid out again. The memo must NOT be able to keep the fallback in force.
    const box = texts.acquire(digest, spec, layoutText(spec, texts.measureFor(spec.cssFont)!), 1);
    expect(box).not.toBeNull();
    expect(box!.w).toBeCloseTo(3 * CH + 2, 5);
    expect(canvas.fills().every((e) => e.face === "real")).toBe(true);
  });
});

// --- the scratch probe (`?textScratchProbe=<n>`) ---------------------------------------------------------------
//
// ROUND 7 used this seam to answer a bisect: the scratch canvas is ALREADY WRONG before anything uploads it, so
// the rasterizer is the defect and the upload and the region write are not. Round 8's job is to name the TERM,
// which needs the sample to carry the arithmetic rather than just the picture — every input to
// `texW = ceil(ink.w * rasterScale)`, and the same two measurements taken on BOTH sides of the resize that
// clears the context's font.
//
// These specs pin the seam's CONTRACT (which acquires are sampled, and what a row carries), never pixels: jsdom
// has no rasterizer, so the picture is a constant here and the defect itself is only observable in a browser.

describe("the scratch probe seam", () => {
  const narrow = () => specOf("80"); // 2 chars * 10 + 2px skirt = 22 device px at scale 1 — inside round 7's band
  const wide = () => specOf("8000"); // 42 device px — the shape of the broken sibling that band could not see

  it("samples only rasters inside the band, and the DEFAULT band is round 7's 24px verbatim", () => {
    const { draw, texts } = harness({ captureScratch: true, paceCount: 0 });
    draw(narrow());
    draw(wide());
    const samples = texts.stats().scratchSamples;
    expect(SCRATCH_MAX_TEX_W_DEFAULT).toBe(24);
    expect(samples).toHaveLength(1);
    expect(samples[0].texW).toBe(22);
  });

  it("widens on request — which is the whole reason the band is a parameter", () => {
    // `?textScratchProbe=64`. The 28-wide label on the same shop shelf renders wrong in exactly the same way and
    // was invisible to round 7's sample; "identical font, identical scale, adjacent acquires, some right and some
    // wrong" is an observation that needs both of them in one run.
    const { draw, texts } = harness({ captureScratch: true, scratchMaxTexW: 64, paceCount: 0 });
    draw(narrow());
    draw(wide());
    expect(texts.stats().scratchSamples.map((s) => s.texW)).toEqual([22, 42]);
  });

  it("takes nothing at all with the probe off — a `toDataURL` per acquire is the readback this module avoids", () => {
    const { draw, texts } = harness({ paceCount: 0 });
    draw(narrow());
    expect(texts.stats().scratchSamples).toHaveLength(0);
  });

  it("carries every input to the surface's own size, so one row says whether it fit its ink", () => {
    const { draw, texts } = harness({ captureScratch: true, scratchMaxTexW: 64, paceCount: 0 });
    const out = draw(narrow(), 2);
    const [s] = texts.stats().scratchSamples;
    expect(s.rasterScale).toBe(2);
    expect(s.ink).toEqual({ dx: out.box!.dx, dy: out.box!.dy, w: out.box!.w, h: out.box!.h });
    // The arithmetic under investigation, checkable from the row and nothing else.
    expect(Math.ceil(s.ink.w * s.rasterScale)).toBe(s.texW);
    expect(s.cssFont).toBe(narrow().cssFont);
  });

  it("re-asks the SAME measurements after the resize, which is where a font can change underneath the memo", () => {
    const { draw, texts } = harness({ captureScratch: true, paceCount: 0 });
    draw(narrow());
    const [s] = texts.stats().scratchSamples;
    // One ready face throughout, so the two sides agree — and that agreement is the control the defect is read
    // against, not a tautology: `preW`/`ascent` are taken before `target.width = texW` and `postW`/`postAscent`
    // after it, through two separate font assignments.
    expect(s.laidOutW).toBe(20);
    expect(s.preW).toBe(20);
    expect(s.postW).toBe(20);
    expect(s.ascent).toBe(ASCENT);
    expect(s.descent).toBe(DESCENT);
    expect(s.postAscent).toBe(ASCENT);
    expect(s.postDescent).toBe(DESCENT);
  });

  it("witnesses that the memo is ALREADY set when acquire is entered — the layout measured through it first", () => {
    // Not a defect on its own, and pinned because it is the precondition for one: `measureFor` and the raster
    // share one context and one memo, and the caller's `layoutText` runs BEFORE `acquire` is entered (it is an
    // argument expression at the call site). So by the time the readiness gate has certified the face, the
    // assignment that resolved it has already happened somewhere the gate never saw.
    const { draw, texts } = harness({ captureScratch: true, paceCount: 0 });
    draw(narrow());
    const [s] = texts.stats().scratchSamples;
    expect(s.memoWasSet).toBe(true);
    // …and `ctx.font` is the STRING on both sides of the resize, because that is all a real context ever returns.
    // The face is witnessed by the widths above, never by this getter.
    expect(s.fontBefore).toBe(s.fontAfter);
  });
});

// --- the bridge's text:// leg ---------------------------------------------------------------------------------

describe("the bridge's text:// seam", () => {
  function bridged(text?: ReturnType<typeof createTextSurfaces>) {
    const cache = fakeCache();
    let images = 0;
    const bridge = createTextureBridge({
      cache,
      onResolved: () => {},
      createImage: () => {
        images++;
        return document.createElement("img");
      },
      text
    });
    return { bridge, cache, images: () => images };
  }

  it("never treats a text:// key as a url to LOAD — its suffix is a label's own STRING", () => {
    // The sharpest reason the prefix legs come first. A digest's first field is the label's text, so a
    // fall-through would hand arbitrary game words to `entryFor` AS A URL: a fetch of nonsense, a permanently
    // failed entry, and a label that never paints again on either path.
    const cache = fakeCache();
    const canvas = fakeCanvas();
    const texts = createTextSurfaces({ cache, createCanvas: () => canvas.el });
    const b = bridged(texts);
    expect(b.bridge.sizeOf(textKeyFor("Add a card to your deck"))).toBeNull();
    expect(b.images()).toBe(0);
    expect(b.bridge.stats.requested).toBe(0);
    expect(b.bridge.stats.failed).toBe(0);
  });

  it("resolves a text:// key through the registry once its raster is up", () => {
    const cache = fakeCache();
    const canvas = fakeCanvas();
    const texts = createTextSurfaces({ cache, createCanvas: () => canvas.el });
    const spec = specOf("abcd");
    const digest = textDigest(spec, 1);
    const layout = layoutText(spec, texts.measureFor(spec.cssFont)!);
    const raster = texts.acquire(digest, spec, layout, 1)!;
    const b = bridged(texts);
    // The texture `handleFor` answers with, which on the atlas arm is the PAGE — that is what a source rect is
    // normalized against, and the label's own extent rides in the quad's `srcX/srcY/srcW/srcH` instead.
    expect(b.bridge.sizeOf(textKeyFor(digest))).toEqual({ width: TEXT_PAGE_DIM, height: TEXT_PAGE_DIM });
    expect(raster).toMatchObject({ texW: 42, texH: 27 });
  });

  it("does not even test the prefix without a text source configured", () => {
    // With the lever off no key the builder emits starts with `text://`, so this is the pre-M4 path verbatim.
    const b = bridged(undefined);
    b.bridge.sizeOf("/res/ui_atlas_0.png");
    expect(b.bridge.stats.requested).toBe(1);
  });
});

// THE LABEL ATLAS (R6 P6-D2). The promotion criterion this module wrote for itself was met — measured
// texture-slot flushes of +20 and +45 per build against a +8 budget — so labels share 1024x1024 pages.
//
// The properties that has to have are all about what does NOT change: the key space (a label is still
// `text://<digest>` to everything outside), the answers `handleFor`/`sizeOf` give the bridge, and the fact that a
// refusal still costs nothing but an overlay element. Plus the two that are new: rects do not overlap, and the
// gutter between them is real.
describe("the label atlas", () => {
  it("packs many labels onto ONE page — one allocation, one handle, one bind", () => {
    const { cache, draw, texts } = harness({ paceCount: 0 });
    const words = ["80", "45/45", "END TURN", "Strike", "Defend", "Bash", "Anger", "Cleave"];
    const digests = words.map((w) => draw(specOf(w)).digest);

    const st = texts.stats();
    expect(st.pages).toBe(1);
    expect(st.pageDim).toBe(TEXT_PAGE_DIM);
    expect(st.dedicated).toBe(0);
    expect(st.uploads).toBe(words.length);
    // ONE page allocation and one region write per label: the atlas's whole arithmetic in two numbers.
    expect(cache.pageBytes.size).toBe(1);
    expect(cache.regionWrites).toHaveLength(words.length);
    // …and every label answers with the SAME texture, which is what makes gsw's batcher (which dedupes slots by
    // texture identity, not by key) bind one slot for all of them.
    const handles = digests.map((d) => texts.handleFor(d));
    expect(handles.every((h) => h !== null && h === handles[0])).toBe(true);
  });

  it("keeps the key space to itself — a page key never escapes", () => {
    const { draw, texts } = harness();
    const digest = draw(specOf("80")).digest;
    // Everything outside still names the label by its own digest; the page is an implementation detail of this
    // module, exactly as `rp://` keys are of the re-packer.
    expect(texts.handleFor(digest)).not.toBeNull();
    expect(textDigestFromKey(textKeyFor(digest))).toBe(digest);
    expect(texts.sizeOf(digest)).toEqual({ width: TEXT_PAGE_DIM, height: TEXT_PAGE_DIM });
  });

  it("leaves a cleared gutter between rects, and never overlaps two", () => {
    const { cache, draw } = harness({ paceCount: 0 });
    for (const word of ["80", "45/45", "END TURN", "Strike", "Defend", "Bash"]) {
      draw(specOf(word));
    }
    const rects = cache.regionWrites;
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        // Disjoint even when GROWN by the gutter on the right and bottom — which is the claim the LINEAR/CLAMP
        // argument rests on: a border texel's blend partner is a cleared texel, never another label's ink.
        const overlaps =
          a.x < b.x + b.w + TEXT_ATLAS_GUTTER &&
          b.x < a.x + a.w + TEXT_ATLAS_GUTTER &&
          a.y < b.y + b.h + TEXT_ATLAS_GUTTER &&
          b.y < a.y + a.h + TEXT_ATLAS_GUTTER;
        expect(overlaps).toBe(false);
      }
    }
  });

  it("puts the packed origin in the BOX, which is the only thing the quad needed", () => {
    const { cache, draw } = harness({ paceCount: 0 });
    const first = draw(specOf("80"));
    const second = draw(specOf("a much longer label than the first"));
    expect(first.box).toMatchObject({ texX: 0, texY: 0 });
    // The second lands somewhere else on the page, and its box says exactly where the region write went.
    expect(second.box!.texX + second.box!.texY).toBeGreaterThan(0);
    const write = cache.regionWrites[1];
    expect({ x: second.box!.texX, y: second.box!.texY }).toEqual({ x: write.x, y: write.y });
    expect({ w: second.box!.texW, h: second.box!.texH }).toEqual({ w: write.w, h: write.h });
  });

  it("quantizes shelf heights so a row of similar labels shares one shelf", () => {
    const { cache, draw } = harness({ paceCount: 0 });
    for (const word of ["80", "45", "12", "99", "31"]) {
      draw(specOf(word));
    }
    // Same font, same one line: every rect is the same height, so they belong on ONE shelf — same y, marching
    // across in x. A per-rect shelf would put each at its own y and burn the page in rows of one.
    const ys = new Set(cache.regionWrites.map((w) => w.y));
    expect(ys.size).toBe(1);
    expect([...ys][0]).toBe(0);
    const xs = cache.regionWrites.map((w) => w.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(TEXT_SHELF_QUANTUM).toBe(8);
  });

  it("gives a label too big for a page its own texture, and counts it", () => {
    // The pre-atlas path, kept for exactly this: a rect no page can hold still draws, at the cost of the bind the
    // atlas exists to remove. `--raster-hist` puts this at zero for every recorded screen at every scale a device
    // picks, so a non-zero reading in the field is a page-size finding.
    const { cache, draw, texts } = harness({ paceCount: 0, pageDim: 64 });
    const out = draw(specOf("a label far wider than a sixty-four pixel page"));
    expect(out.box).not.toBeNull();
    expect(texts.stats().dedicated).toBe(1);
    expect(texts.stats().pages).toBe(0);
    expect(out.box).toMatchObject({ texX: 0, texY: 0 });
    expect(cache.uploaded).toContain(textKeyFor(out.digest));
  });

  it("frees the ALLOCATION on eviction, and then the empty page itself (R6 P6-D3)", () => {
    const { cache, draw, texts } = harness({ evictAfterBuilds: 2, paceCount: 0 });
    draw(specOf("80"));
    draw(specOf("END TURN"));
    expect(texts.stats().pageLiveFraction).toBeGreaterThan(0);
    const pageKey = cache.uploaded.find((k) => k.startsWith("txp://"))!;

    // Neither label is named again, so both age out. A shelf cannot take a rect BACK — the room stays spent —
    // but once NOTHING live is left the page is pure waste, and it is the only thing in this module that ever
    // frees an allocation: without it a session that walks through screens grows a page per screenful forever.
    texts.endBuild();
    texts.endBuild();
    expect(texts.stats().evicted).toBe(2);
    expect(texts.stats().resident).toBe(0);
    expect(texts.stats().pages).toBe(0);
    expect(texts.stats().retiredPages).toBe(1);
    expect(texts.stats().bytes).toBe(0);
    expect(cache.released).toContain(pageKey);
  });

  it("keeps a page that still holds ONE live label — empty is the only case reclaimed", () => {
    // The half of the rule that is NOT obvious. Reclaiming a partially live page means retiring it and migrating
    // the survivors, which is a real cost against a measurement this module does not have yet; empty needs no
    // such argument because there is nothing to migrate.
    const { draw, texts } = harness({ evictAfterBuilds: 2, paceCount: 0 });
    draw(specOf("80"));
    draw(specOf("END TURN"));
    for (let i = 0; i < 4; i++) {
      draw(specOf("80")); // kept alive by being named; `END TURN` is not
      texts.endBuild();
    }
    expect(texts.stats().evicted).toBe(1);
    expect(texts.stats().pages).toBe(1);
    expect(texts.stats().retiredPages).toBe(0);
    // …and the surviving label still draws from the page it was packed onto.
    expect(draw(specOf("80")).hit).toBe(true);
  });

  it("reuses a released page's slot, so a long session's key space stays bounded", () => {
    const { cache, draw, texts } = harness({ evictAfterBuilds: 2, paceCount: 0, pageDim: 64 });
    // A 64px page holds one small label at a time, so each screenful retires a page and takes a fresh one.
    for (let screen = 0; screen < 3; screen++) {
      draw(specOf(String(screen)));
      texts.endBuild();
      texts.endBuild();
      texts.endBuild();
    }
    expect(texts.stats().retiredPages).toBe(3);
    expect(texts.stats().pages).toBe(0);
    // Three allocations, all under ONE key: the freed slot is reused rather than a fresh index minted, so a
    // surface's remembered page index can never point at a page that has moved.
    const pageAllocs = cache.uploaded.filter((k) => k.startsWith("txp://"));
    expect(pageAllocs).toHaveLength(3);
    expect(new Set(pageAllocs)).toEqual(new Set(["txp://0"]));
  });

  it("drops its pages on a context loss, and re-allocates from scratch", () => {
    const { cache, draw, texts } = harness({ paceCount: 0 });
    draw(specOf("80"));
    expect(texts.stats().pages).toBe(1);
    const releasedBefore = cache.released.length;

    texts.invalidate();
    // NO RELEASE: the entries are already gone, and a release would decrement a refcount on nothing.
    expect(cache.released).toHaveLength(releasedBefore);
    expect(texts.stats().pages).toBe(0);
    expect(texts.stats().bytes).toBe(0);

    cache.reset();
    expect(draw(specOf("80")).hit).toBe(false);
    expect(texts.stats().pages).toBe(1);
  });

  it("counts page bytes as residency, so the ceiling still means something", () => {
    const { draw, texts } = harness({ paceCount: 0 });
    draw(specOf("80"));
    // The PAGE is what is resident, not the glyphs — which is the honest number for a ceiling to be about, and
    // the one that makes a low `pageLiveFraction` worth reading.
    expect(texts.stats().bytes).toBe(TEXT_PAGE_DIM * TEXT_PAGE_DIM * 4);
  });
});
