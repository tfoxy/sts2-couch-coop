import { describe, expect, it, vi } from "vitest";

import type { MirrorFont, MirrorNode } from "@/mirror/sceneTree";
import { fnv1a32 } from "@/mirror/textWrap";
import {
  buildPreparedText,
  composePreparedTextRecords,
  createFontCheckCache,
  createTextPrepCache,
  resolveSemanticTextSpec,
  type PreparedText,
  type TextPrepRefusal
} from "./rustTextPreparation";

// Everything here is the PURE half (see the module header): a stub `measure`/`measureLineMetrics` stand in for a
// 2D context exactly like `canvasTextLayout.spec.ts` does for `layoutText`, so none of this needs jsdom's missing
// canvas backend. Every character measures 10 design px; the line box is a fixed 20-up/5-down face.
const CH = 10;
const measure = (s: string) => s.length * CH;
const measureLineMetrics = () => ({ ascent: 20, descent: 5 });

const FONT: MirrorFont = { family: "kreon_regular", url: "res://fonts/kreon_regular.ttf", weight: null, style: null };

function node(id: string, parentId: string | null, over: Record<string, unknown> = {}): MirrorNode {
  return {
    id,
    parentId,
    name: id,
    sceneFilePath: null,
    text: { text: "Gain 5 Block.", colorHtml: "#ffffff", fontSizePx: 20, halign: null, valign: null,
      outlineColorHtml: null, outlineSize: 0 },
    font: FONT,
    richText: false,
    textWrap: null,
    shadow: null,
    outline: null,
    localRect: { x: 0, y: 0, width: 200, height: 60 },
    ...over
  } as MirrorNode;
}

function nodeMap(list: readonly MirrorNode[]): Map<string, MirrorNode> {
  return new Map(list.map((n) => [n.id, n]));
}

/** The slow path, end to end — what `semanticText`'s `compute()` thunk calls on a cache miss. */
function resolve(n: MirrorNode, nodes: ReadonlyMap<string, MirrorNode>, fontVersion = 0): PreparedText | TextPrepRefusal {
  const resolved = resolveSemanticTextSpec(n, nodes);
  if ("refusal" in resolved) return resolved;
  return buildPreparedText(resolved, fontVersion, n.font!, measure, measureLineMetrics);
}

function assertPrepared(result: PreparedText | TextPrepRefusal): PreparedText {
  if ("refusal" in result) throw new Error(`expected a prepared text, got refusal: ${result.refusal}`);
  return result;
}

describe("resolveSemanticTextSpec + buildPreparedText — the pure half", () => {
  it("prepares mixed bold, coloured, and inline-image runs for Rust", () => {
    const root = node("root", null, { sceneFilePath: "res://scenes/ui/event_option_button.tscn" });
    const boldFont = { ...FONT, family: "kreon_bold", url: "res://fonts/kreon_bold.ttf" };
    const label = node("label", "root", { richText: true, richBoldFont: boldFont,
      richBoldFontSpacingPx: 1, text: { ...node("unused", null).text,
        text: "[gold][b]Power[/b][/gold]\nGain [img]res://icons/energy.png[/img] now" } });
    const resolved = resolveSemanticTextSpec(label, nodeMap([root, label]), true);
    expect("refusal" in resolved).toBe(false);
    if ("refusal" in resolved) return;
    const prepared = assertPrepared(buildPreparedText(resolved, 0, FONT, measure, measureLineMetrics,
      (face, value) => value.length * (face.font.family === "kreon_bold" ? 12 : 10) + value.length * face.spacingPx,
      () => ({ width: 24, height: 24 })));
    expect(prepared.layout.lines.map((line) => line.text)).toEqual(["Power", "Gain \uFFFC now"]);
    expect(prepared.runs.find((run) => run.text === "Power")?.style).toMatchObject({
      fontFamily: "kreon_bold", letterSpacing: 1, fill: "#efc851" });
    expect(prepared.runs.find((run) => run.text === "\uFFFC")?.inlineImage).toMatchObject({ width: 24, height: 24 });
    expect(composePreparedTextRecords(prepared, "label", 0,
      { transform: [1, 0, 0, 1, 0, 0], opacity: 1, tintR: 1, tintG: 1, tintB: 1 }, 0)
      .some((record) => "inlineImage" in record)).toBe(true);
  });

  it("uses the normal face after a streamed role face fails", () => {
    const root = node("root", null, { sceneFilePath: "res://scenes/ui/event_option_button.tscn" });
    const label = node("label", "root", { richText: true,
      richBoldFont: { ...FONT, family: "kreon_bold" },
      text: { ...node("unused", null).text, text: "[b]Power[/b]" } });
    const resolved = resolveSemanticTextSpec(label, nodeMap([root, label]), true, new Set(["kreon_bold"]));
    if ("refusal" in resolved) throw new Error(resolved.refusal);
    const prepared = assertPrepared(buildPreparedText(resolved, 0, FONT, measure, measureLineMetrics,
      (face, value) => value.length * (face.font.family === "kreon_bold" ? 12 : 10)));
    expect(prepared.fallbackRoles).toEqual(["bold"]);
    expect(prepared.runs[0].style.fontFamily).toBe("kreon_regular");
  });

  it("draws surrounding words while an image loads, then retries without caching the pending layout", () => {
    const root = node("root", null, { sceneFilePath: "res://scenes/ui/event_option_button.tscn" });
    const label = node("label", "root", { richText: true,
      text: { ...node("unused", null).text, text: "Gain [img]res://icons/energy.png[/img]" } });
    const nodes = nodeMap([root, label]);
    const cache = createTextPrepCache();
    let loaded = false;
    const compute = () => {
      const resolved = resolveSemanticTextSpec(label, nodes, true);
      if ("refusal" in resolved) return resolved;
      return buildPreparedText(resolved, 0, FONT, measure, measureLineMetrics,
        undefined, () => loaded ? { width: 24, height: 24 } : null);
    };
    const pending = assertPrepared(cache.resolve(label, nodes, 0, "native", false, compute));
    expect(pending.imagePending).toBe(true);
    expect(pending.runs.map((run) => run.text).join("")).toContain("Gain ");
    expect(composePreparedTextRecords(pending, "label", 0,
      { transform: [1, 0, 0, 1, 0, 0], opacity: 1, tintR: 1, tintG: 1, tintB: 1 }, 0)
      .some((record) => "inlineImage" in record)).toBe(false);
    loaded = true;
    const ready = assertPrepared(cache.resolve(label, nodes, 0, "native", false, compute));
    expect(ready.imagePending).toBe(false);
    expect(ready.runs.some((run) => run.inlineImage)).toBe(true);
    expect(cache.stats().misses).toBe(2);
  });

  it("omits a permanently failed image but keeps words and a nonfatal degradation", () => {
    const root = node("root", null, { sceneFilePath: "res://scenes/ui/event_option_button.tscn" });
    const label = node("label", "root", { richText: true,
      text: { ...node("unused", null).text, text: "Gain [img]res://icons/missing.png[/img] energy" } });
    const resolved = resolveSemanticTextSpec(label, nodeMap([root, label]), true);
    if ("refusal" in resolved) throw new Error(resolved.refusal);
    const prepared = assertPrepared(buildPreparedText(resolved, 0, FONT, measure, measureLineMetrics,
      undefined, () => ({ width: 0, height: 0 })));
    expect(prepared.imagePending).toBe(false);
    expect(prepared.degradations).toContain("rich:img:image-unavailable:/res/icons/missing.png");
    expect(composePreparedTextRecords(prepared, "label", 0,
      { transform: [1, 0, 0, 1, 0, 0], opacity: 1, tintR: 1, tintG: 1, tintB: 1 }, 0)
      .map((record) => record.text).join("")).toBe("Gain  energy");
  });

  it("replays matching parsed breaks for a bold label and rejects stale breaks", () => {
    const root = node("root", null, { sceneFilePath: "res://scenes/ui/event_option_button.tscn" });
    const plain = "Alpha Beta Gamma";
    const wrap = { basis: "parsed" as const, parsedText: plain, sourceLength: plain.length,
      sourceHash: fnv1a32(plain), lines: [{ start: 0, end: 10 }, { start: 11, end: plain.length }] };
    const label = node("label", "root", { richText: true, localRect: { x: 0, y: 0, width: 80, height: 60 },
      text: { ...node("unused", null).text, text: `[b]${plain}[/b]` }, textWrap: wrap });
    const render = (current: MirrorNode) => {
      const resolved = resolveSemanticTextSpec(current, nodeMap([root, current]), true);
      if ("refusal" in resolved) throw new Error(resolved.refusal);
      return assertPrepared(buildPreparedText(resolved, 0, FONT, measure, measureLineMetrics,
        (_face, value) => measure(value))).layout.lines.map((line) => line.text);
    };
    expect(render(label)).toEqual(["Alpha Beta", "Gamma"]);
    expect(render({ ...label, textWrap: { ...wrap, parsedText: "stale" } })).not.toEqual(["Alpha Beta", "Gamma"]);
  });
  it("resolves a plain label to a spec with no spans and one run per line", () => {
    const root = node("root", null, { sceneFilePath: "res://scenes/ui/x.tscn" });
    const label = node("label", "root");
    const prepared = assertPrepared(resolve(label, nodeMap([root, label])));
    expect(prepared.spans).toBeUndefined();
    expect(prepared.runs.length).toBeGreaterThan(0);
    expect(prepared.resourceRevision).toBe(`0:${JSON.stringify(FONT)}`);
    expect(prepared.runs[0].style.fontFamily).toBe("kreon_regular");
  });

  it("refuses a node with no text the same way the inline branch always has", () => {
    const root = node("root", null, { sceneFilePath: "res://scenes/ui/x.tscn" });
    const label = node("label", "root", { text: null });
    expect(resolve(label, nodeMap([root, label]))).toEqual({ refusal: "unresolved-text" });
  });

  it("refuses a node with text but no font", () => {
    const root = node("root", null, { sceneFilePath: "res://scenes/ui/x.tscn" });
    const label = node("label", "root", { font: null });
    expect(resolve(label, nodeMap([root, label]))).toEqual({ refusal: "no-font" });
  });

  it("parses a rich label into spans, matching the inline rich branch", () => {
    const root = node("root", null, { sceneFilePath: "res://scenes/ui/x.tscn" });
    const label = node("label", "root", {
      richText: true,
      text: { text: "[color=#ff0000]hot[/color] and cold", colorHtml: "#ffffff", fontSizePx: 20,
        halign: null, valign: null, outlineColorHtml: null, outlineSize: 0 }
    });
    const prepared = assertPrepared(resolve(label, nodeMap([root, label])));
    expect(prepared.spec.text).toBe("hot and cold");
    expect(prepared.spans).toEqual([{ start: 0, end: 3, color: "#ff0000" }]);
    // The run touching the coloured span carries it in its style's `fill`; a later run falls back to the spec.
    const coloredRun = prepared.runs.find((run) => run.style.fill === "#ff0000");
    expect(coloredRun).toBeDefined();
  });

  it("draws a balanced rich reward label and replays matching parsed breaks", () => {
    const root = node("root", null, { sceneFilePath: "res://scenes/rewards/reward_button.tscn" });
    const container = node("container", "root", { name: "LabelContainer", text: null });
    const plain = "Alpha Beta Gamma Delta";
    const label = node("label", "container", { name: "Label", richText: true,
      text: { text: `[color=#ff0000]Alpha Beta[/color] Gamma Delta`, colorHtml: "#ffffff", fontSizePx: 20,
        halign: null, valign: null, outlineColorHtml: null, outlineSize: 0 } });
    const nodes = nodeMap([root, container, label]);
    const balanced = assertPrepared(resolve(label, nodes));
    expect(balanced.spec).toMatchObject({ text: plain, balance: true, refusal: null });
    expect(balanced.layout.lines.map((line) => line.text.trim())).toEqual(["Alpha Beta", "Gamma Delta"]);
    expect(balanced.spans).toEqual([{ start: 0, end: 10, color: "#ff0000" }]);

    const streamed = { basis: "parsed" as const, parsedText: plain, sourceLength: plain.length,
      sourceHash: fnv1a32(plain), lines: [{ start: 0, end: 16 }, { start: 17, end: plain.length }] };
    const withWrap = { ...label, textWrap: streamed };
    expect(assertPrepared(resolve(withWrap, nodeMap([root, container, withWrap]))).layout.lines.map((line) => line.text))
      .toEqual(["Alpha Beta Gamma", "Delta"]);
    const stale = { ...label, textWrap: { ...streamed, parsedText: "stale parsed source" } };
    expect(assertPrepared(resolve(stale, nodeMap([root, container, stale]))).layout.lines.map((line) => line.text.trim()))
      .toEqual(["Alpha Beta", "Gamma Delta"]);
  });

  it("resolves a shadow into a pixi color/alpha pair and threads it into every run's style", () => {
    const root = node("root", null, { sceneFilePath: "res://scenes/ui/x.tscn" });
    const label = node("label", "root", { shadow: { colorHtml: "#00000080", offsetX: 2, offsetY: 3 } });
    const prepared = assertPrepared(resolve(label, nodeMap([root, label])));
    expect(prepared.shadow).toEqual({ color: "#000000", alpha: 128 / 255 });
    for (const run of prepared.runs) expect(run.style.dropShadow).toMatchObject({ color: "#000000" });
  });

  it("refuses an invalid shadow color exactly like the inline branch did", () => {
    const root = node("root", null, { sceneFilePath: "res://scenes/ui/x.tscn" });
    const label = node("label", "root", { shadow: { colorHtml: "not-a-color", offsetX: 2, offsetY: 3 } });
    expect(resolve(label, nodeMap([root, label]))).toEqual({ refusal: "invalid-shadow-color" });
  });
});

describe("createTextPrepCache", () => {
  it("hits on a repeated call with the identical ancestor chain, fontVersion and textMode", () => {
    const cache = createTextPrepCache();
    const root = node("root", null, { sceneFilePath: "res://scenes/ui/x.tscn" });
    const label = node("label", "root");
    const map = nodeMap([root, label]);
    const compute = vi.fn(() => resolve(label, map));
    const first = cache.resolve(label, map, 0, "native", false, compute);
    const second = cache.resolve(label, map, 0, "native", false, compute);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, verifyMismatches: 0 });
  });

  it("misses when the node object itself is replaced, even with identical id and content", () => {
    const cache = createTextPrepCache();
    const root = node("root", null, { sceneFilePath: "res://scenes/ui/x.tscn" });
    const label1 = node("label", "root");
    const map1 = nodeMap([root, label1]);
    cache.resolve(label1, map1, 0, "native", false, () => resolve(label1, map1));

    const label2 = node("label", "root"); // same id/content, a DIFFERENT object — e.g. a reconciled rebuild
    const map2 = nodeMap([root, label2]);
    const compute2 = vi.fn(() => resolve(label2, map2));
    const second = cache.resolve(label2, map2, 0, "native", false, compute2);
    expect(compute2).toHaveBeenCalledTimes(1);
    expect(cache.stats().misses).toBe(2);
    // Same CONTENT though — recomputing from scratch agrees with what the first node produced.
    expect(assertPrepared(second)).toEqual(assertPrepared(resolve(label1, map1)));
  });

  it("misses when an ancestor is swapped for a new object, even though the leaf node is unchanged", () => {
    const cache = createTextPrepCache();
    const root1 = node("root", null, { sceneFilePath: "res://scenes/ui/x.tscn" });
    const label = node("label", "root");
    const map1 = nodeMap([root1, label]);
    cache.resolve(label, map1, 0, "native", false, () => resolve(label, map1));

    const root2 = node("root", null, { sceneFilePath: "res://scenes/ui/x.tscn" }); // new object, identical content
    const map2 = nodeMap([root2, label]);
    const compute2 = vi.fn(() => resolve(label, map2));
    cache.resolve(label, map2, 0, "native", false, compute2);
    expect(compute2).toHaveBeenCalledTimes(1);
    expect(cache.stats().misses).toBe(2);
  });

  it("misses again when fontVersion changes, and again when textMode changes", () => {
    const cache = createTextPrepCache();
    const root = node("root", null, { sceneFilePath: "res://scenes/ui/x.tscn" });
    const label = node("label", "root");
    const map = nodeMap([root, label]);
    cache.resolve(label, map, 0, "native", false, () => resolve(label, map, 0));
    cache.resolve(label, map, 1, "native", false, () => resolve(label, map, 1));
    cache.resolve(label, map, 1, "slug", false, () => resolve(label, map, 1));
    expect(cache.stats()).toEqual({ hits: 0, misses: 3, verifyMismatches: 0 });
  });

  it("verify mode recomputes on a hit and uses the fresh answer when it disagrees with the cache", () => {
    const cache = createTextPrepCache();
    const root = node("root", null, { sceneFilePath: "res://scenes/ui/x.tscn" });
    const label = node("label", "root");
    const map = nodeMap([root, label]);
    let text = "first";
    const compute = () => resolve({ ...label, text: { ...label.text!, text } }, map);
    cache.resolve(label, map, 0, "native", true, compute); // miss — seeds the cache keyed on `label`
    text = "second"; // the thunk now disagrees with what got cached — a simulated coherency bug
    const result = cache.resolve(label, map, 0, "native", true, compute);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, verifyMismatches: 1 });
    expect(assertPrepared(result).spec.text).toBe("second");
  });

  it("does not count a verify mismatch when the cached answer still agrees", () => {
    const cache = createTextPrepCache();
    const root = node("root", null, { sceneFilePath: "res://scenes/ui/x.tscn" });
    const label = node("label", "root");
    const map = nodeMap([root, label]);
    const compute = vi.fn(() => resolve(label, map));
    cache.resolve(label, map, 0, "native", true, compute);
    cache.resolve(label, map, 0, "native", true, compute);
    expect(compute).toHaveBeenCalledTimes(2); // verify always recomputes on a hit...
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, verifyMismatches: 0 }); // ...but agrees, so no mismatch
  });
});

describe("composePreparedTextRecords", () => {
  it("positions every run through the live transform and reuses the SAME style object reference", () => {
    const root = node("root", null, { sceneFilePath: "res://scenes/ui/x.tscn" });
    const label = node("label", "root");
    const prepared = assertPrepared(resolve(label, nodeMap([root, label])));
    const record = { transform: [1, 0, 0, 1, 100, 200], opacity: 0.5, tintR: 1, tintG: 0, tintB: 0 };
    const records = composePreparedTextRecords(prepared, "label", 7, record, 2);
    expect(records.length).toBe(prepared.runs.length);
    expect(records[0].insertionIndex).toBe(7);
    expect(records[0].alpha).toBe(0.5);
    expect(records[0].blend).toBe(2);
    expect(records[0].tint).toBe(0xff0000);
    // What lets the EXECUTOR's own style-string WeakMap cache hit across builds: the same `PreparedText` must hand
    // back the identical style object every time it is composed, not a fresh literal.
    expect(records[0].style).toBe(prepared.runs[0].style);
    const again = composePreparedTextRecords(prepared, "label", 9, record, 2);
    expect(again[0].style).toBe(records[0].style);
    expect(again[0]).not.toBe(records[0]); // the PixiTextRecord itself is a fresh object every call —
    // retainedComposition.ts stamps `parentId` directly onto it, so two builds must never share one.
  });
});

// --- the font-check cache ------------------------------------------------------------------------------------

/** A controllable stand-in for `FontFaceSet` — `check`'s answer and its three events are both scriptable. */
function fakeFontFaceSet() {
  const listeners = new Map<string, Set<() => void>>();
  let result = true;
  let calls = 0;
  const fonts = {
    addEventListener: (type: string, listener: () => void) => {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
    check: () => { calls++; return result; }
  };
  return {
    fonts: fonts as unknown as FontFaceSet,
    dispatch: (type: string) => { for (const listener of listeners.get(type) ?? []) listener(); },
    setResult: (next: boolean) => { result = next; },
    get calls() { return calls; },
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0
  };
}

describe("createFontCheckCache", () => {
  it("caches a true result and never calls the real check again for the same key", () => {
    const fake = fakeFontFaceSet();
    const cache = createFontCheckCache(fake.fonts, () => 0);
    expect(cache.check("16px x", "hi", 0, false)).toBe(true);
    expect(cache.check("16px x", "hi", 0, false)).toBe(true);
    expect(fake.calls).toBe(1);
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, verifyMismatches: 0 });
  });

  it("never caches a false result — every call re-asks the real FontFaceSet", () => {
    const fake = fakeFontFaceSet();
    fake.setResult(false);
    const cache = createFontCheckCache(fake.fonts, () => 0);
    expect(cache.check("16px x", "hi", 0, false)).toBe(false);
    expect(cache.check("16px x", "hi", 0, false)).toBe(false);
    expect(fake.calls).toBe(2);
    expect(cache.stats()).toEqual({ hits: 0, misses: 2, verifyMismatches: 0 });
  });

  it("clears on loading, loadingdone and loadingerror", () => {
    for (const event of ["loading", "loadingdone", "loadingerror"]) {
      const fake = fakeFontFaceSet();
      const cache = createFontCheckCache(fake.fonts, () => 0);
      cache.check("16px x", "hi", 0, false);
      fake.dispatch(event);
      cache.check("16px x", "hi", 0, false);
      expect(fake.calls, `event ${event} should have invalidated the cache`).toBe(2);
    }
  });

  it("clears when the font-face injection counter changes", () => {
    const fake = fakeFontFaceSet();
    let injection = 0;
    const cache = createFontCheckCache(fake.fonts, () => injection);
    cache.check("16px x", "hi", 0, false);
    injection = 1;
    cache.check("16px x", "hi", 0, false);
    expect(fake.calls).toBe(2);
  });

  it("clears when the caller's own fontVersion argument changes", () => {
    const fake = fakeFontFaceSet();
    const cache = createFontCheckCache(fake.fonts, () => 0);
    cache.check("16px x", "hi", 0, false);
    cache.check("16px x", "hi", 1, false);
    expect(fake.calls).toBe(2);
  });

  it("verify mode recomputes a cached true against the real check and demotes a mismatch", () => {
    const fake = fakeFontFaceSet();
    const cache = createFontCheckCache(fake.fonts, () => 0);
    cache.check("16px x", "hi", 0, false); // true, cached
    fake.setResult(false); // simulate a coherency bug — nothing SHOULD flip a cached true but the DOM events/counter
    const verified = cache.check("16px x", "hi", 0, true);
    expect(verified).toBe(false); // uses the real, fresh answer — not the stale cached true
    expect(cache.stats().verifyMismatches).toBe(1);
    // The demoted key is gone, so the next call re-asks the real FontFaceSet rather than re-caching the stale true.
    const callsBefore = fake.calls;
    cache.check("16px x", "hi", 0, false);
    expect(fake.calls).toBe(callsBefore + 1);
  });

  it("removes its listeners on dispose", () => {
    const fake = fakeFontFaceSet();
    const cache = createFontCheckCache(fake.fonts, () => 0);
    expect(fake.listenerCount("loadingdone")).toBe(1);
    cache.dispose();
    expect(fake.listenerCount("loadingdone")).toBe(0);
    expect(fake.listenerCount("loading")).toBe(0);
    expect(fake.listenerCount("loadingerror")).toBe(0);
  });
});
