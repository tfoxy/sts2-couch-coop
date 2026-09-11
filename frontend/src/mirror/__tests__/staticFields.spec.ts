import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applySceneDelta,
  createMirrorState,
  parseSceneDelta,
  type MirrorNode,
  type MirrorState
} from "@/mirror/sceneTree";

// THREE-WAY LOCKSTEP (vitest side). The checked-in fixture tests/fixtures/wire/static-fields.json lists the wire
// static-kept fields; the C# side (CouchCoopSceneObserverTests) asserts MergeVolatile keeps them and ToVolatile
// drops them, and THIS spec asserts the client's mergeNode keeps the corresponding client field across a
// volatile-only upsert. Drift on any side breaks a test. This is the exact contract Stage 1 relies on: the server
// now ships lean volatile-only projections for re-inflated ids, so mergeNode's carry-forward MUST match the set.

interface Fixture {
  wireStaticFields: string[];
  stickyFields: string[];
  volatileOutlineFields: string[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), "../tests/fixtures/wire/static-fields.json"), "utf8")
);

function xform(tx: number, ty: number): Record<string, unknown> {
  return { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } };
}
function box(w: number, h: number): Record<string, unknown> {
  return { position: { x: 0, y: 0 }, size: { x: w, y: h } };
}
function color(html: string): Record<string, unknown> {
  return { r: 0.1, g: 0.2, b: 0.3, a: 1, html };
}

// A retained wire node with a distinctive sentinel for EVERY static field + distinctive volatiles.
function sentinelWire(): Record<string, unknown> {
  return {
    id: "n",
    parentId: "parent-1",
    name: "existing-name",
    nodeType: "Existing.Type",
    showBehindParent: true,
    clipChildren: 2,
    clipContents: true,
    ninePatchMargins: { left: 1, top: 2, right: 3, bottom: 4 },
    font: { resourcePath: "res://fonts/f.ttf" },
    fontWeight: "bold",
    fontStyle: "italic",
    // Per-role rich-text fonts + their theme sizes / glyph spacing (producer-static, add/keyframe only).
    richBoldFont: { resourcePath: "res://fonts/kreon_bold.ttf" },
    richItalicFont: { resourcePath: "res://fonts/kreon_italic.ttf" },
    richBoldItalicFont: { resourcePath: "res://fonts/kreon_bold_italic.ttf" },
    richBoldFontSizePx: 21,
    richItalicFontSizePx: 22,
    richBoldItalicFontSizePx: 23,
    richBoldFontSpacingPx: 1,
    richItalicFontSpacingPx: 2,
    richBoldItalicFontSpacingPx: 3,
    shadow: { color: color("#000000ff"), offset: { x: 1, y: 1 } },
    richText: true,
    material: { resourcePath: "res://mat.tres" },
    shader: { resourcePath: "res://shader.gdshader" },
    textureStretchMode: 5,
    textureFlipH: true,
    textureFlipV: true,
    canvasBlendMode: 1,
    particleSpec: { kind: "GPUParticles2D", amount: 8 },
    spine: { sceneResPath: "res://spine.tscn", nodePath: "Node/Path", animations: ["idle", "attack"] },
    sceneFilePath: "res://scene.tscn",
    mouseFilter: 1,
    anchorLeft: 0.25,
    anchorRight: 0.75,
    anchorOwnerId: "owner-1",
    containerLayout: "hbox-center",
    // sticky (producer re-ships only on change; mergeNode carries them forward) — see the fixture's stickyFields
    intentFrames: {
      animationName: "attack",
      fps: 15,
      frames: [{ atlasPath: "res://images/intent_atlas.png" }]
    },
    linePoints: [17, 98, 457, 249],
    lineWidth: 4,
    lineColor: color("#ff0000ff"),
    // volatile
    transform: xform(11, 22),
    localRect: box(100, 50),
    visible: true,
    opacity: 0.5,
    modulate: color("#1a334cff"),
    outlineColor: color("#1a334cff"),
    outlineSize: 3
  };
}

// A pure volatile-only upsert: NO static fields, NO name → mergeNode takes the volatile-merge branch.
function volatileWire(): Record<string, unknown> {
  return {
    id: "n",
    parentId: "parent-2",
    transform: xform(99, 88),
    localRect: box(10, 10),
    visible: false,
    opacity: 0.9,
    modulate: color("#e6ccb3ff"),
    outlineColor: color("#e6ccb3ff"),
    outlineSize: 5,
    spineCurrentAnim: "attack"
  };
}

function apply(state: MirrorState, upserts: Record<string, unknown>[], full = false): void {
  applySceneDelta(
    state,
    parseSceneDelta({ type: "scene-delta", full, screenType: "run", upserts, orderedIds: full ? ["n"] : null })!
  );
}

// For each wire static field, how to read its RETAINED value off the merged client node (encodes the wire→client
// field renames/splits documented in the fixture's clientFieldNotes). A drop from mergeNode's keep-list makes the
// volatile upsert's default win → the check returns a non-sentinel → the test fails.
const checks: Record<string, (n: MirrorNode) => unknown> = {
  name: (n) => n.name,
  nodeType: (n) => n.nodeType,
  showBehindParent: (n) => n.showBehindParent,
  clipChildren: (n) => n.clipChildren,
  clipContents: (n) => n.clipContents,
  ninePatchMargins: (n) => n.ninePatchMargins?.left,
  font: (n) => n.font?.family,
  fontWeight: (n) => n.font?.weight,
  fontStyle: (n) => n.font?.style,
  richBoldFont: (n) => n.richBoldFont?.family,
  richItalicFont: (n) => n.richItalicFont?.family,
  richBoldItalicFont: (n) => n.richBoldItalicFont?.family,
  richBoldFontSizePx: (n) => n.richBoldFontSizePx,
  richItalicFontSizePx: (n) => n.richItalicFontSizePx,
  richBoldItalicFontSizePx: (n) => n.richBoldItalicFontSizePx,
  richBoldFontSpacingPx: (n) => n.richBoldFontSpacingPx,
  richItalicFontSpacingPx: (n) => n.richItalicFontSpacingPx,
  richBoldItalicFontSpacingPx: (n) => n.richBoldItalicFontSpacingPx,
  shadow: (n) => n.shadow?.offsetX,
  richText: (n) => n.richText,
  material: (n) => n.materialRef,
  shader: (n) => n.shaderId,
  textureStretchMode: (n) => n.textureStretchMode,
  textureFlipH: (n) => n.textureFlipH,
  textureFlipV: (n) => n.textureFlipV,
  canvasBlendMode: (n) => n.canvasBlendMode,
  particleSpec: (n) => n.particleSpec?.kind,
  spine: (n) => n.spineSceneResPath,
  sceneFilePath: (n) => n.sceneFilePath,
  mouseFilter: (n) => n.mouseFilter,
  anchorLeft: (n) => n.anchorLeft,
  anchorRight: (n) => n.anchorRight,
  anchorOwnerId: (n) => n.anchorOwnerId,
  containerLayout: (n) => n.containerLayout
};

// The sentinel value each retained field should still hold after the volatile merge.
const expected: Record<string, unknown> = {
  name: "existing-name",
  nodeType: "Existing.Type",
  showBehindParent: true,
  clipChildren: 2,
  clipContents: true,
  ninePatchMargins: 1,
  font: "f",
  fontWeight: "bold",
  fontStyle: "italic",
  richBoldFont: "kreon_bold",
  richItalicFont: "kreon_italic",
  richBoldItalicFont: "kreon_bold_italic",
  richBoldFontSizePx: 21,
  richItalicFontSizePx: 22,
  richBoldItalicFontSizePx: 23,
  richBoldFontSpacingPx: 1,
  richItalicFontSpacingPx: 2,
  richBoldItalicFontSpacingPx: 3,
  shadow: 1,
  richText: true,
  material: "res://mat.tres",
  shader: "res://shader.gdshader",
  textureStretchMode: 5,
  textureFlipH: true,
  textureFlipV: true,
  canvasBlendMode: 1,
  particleSpec: "GPUParticles2D",
  spine: "res://spine.tscn",
  sceneFilePath: "res://scene.tscn",
  mouseFilter: 1,
  anchorLeft: 0.25,
  anchorRight: 0.75,
  anchorOwnerId: "owner-1",
  containerLayout: "hbox-center"
};

// How to read each STICKY wire field's retained value off the merged client node, and the sentinel it must hold.
const stickyChecks: Record<string, (n: MirrorNode) => unknown> = {
  intentFrames: (n) => n.intentFrames?.animationName,
  linePoints: (n) => n.linePoints,
  lineWidth: (n) => n.lineWidth,
  lineColor: (n) => n.lineColor?.html
};

const stickyExpected: Record<string, unknown> = {
  intentFrames: "attack",
  linePoints: [17, 98, 457, 249],
  lineWidth: 4,
  lineColor: "#ff0000ff"
};

describe("static-kept field lockstep (mergeNode)", () => {
  it("carries every wire static field forward across a volatile-only upsert", () => {
    const state = createMirrorState();
    apply(state, [sentinelWire()], true);
    apply(state, [volatileWire()]);
    const merged = state.nodes.get("n")!;

    for (const wireName of fixture.wireStaticFields) {
      const check = checks[wireName];
      expect(check, `fixture field '${wireName}' has no client check — update staticFields.spec.ts in lockstep`).toBeTruthy();
      expect(check(merged), `mergeNode kept static field '${wireName}'`).toEqual(expected[wireName]);
    }
  });

  it("takes VOLATILE fields (outline, transform, parentId) from the upsert, not the retained node", () => {
    const state = createMirrorState();
    apply(state, [sentinelWire()], true);
    apply(state, [volatileWire()]);
    const merged = state.nodes.get("n")!;

    // outlineColor/outlineSize are producer-volatile (fixture.volatileOutlineFields): the fresh upsert wins.
    expect(fixture.volatileOutlineFields).toContain("outlineColor");
    expect(merged.outline?.colorHtml).toBe("#e6ccb3ff");
    expect(merged.outline?.size).toBe(5);
    expect(merged.parentId).toBe("parent-2");
    expect(merged.transform?.[4]).toBe(99);
    expect(merged.opacity).toBe(0.9);
    expect(merged.visible).toBe(false);
    expect(merged.spineCurrentAnim).toBe("attack");
  });

  // STICKY is a third category, distinct from wireStaticFields: the producer re-ships these only when their own
  // value changed, so mergeNode uses `upsert ?? existing` — a null upsert value means "unchanged, keep yours" and a
  // fresh one REPLACES. Both halves are asserted; the fixture list drives the first, so a new sticky field without a
  // check fails here.
  it("carries every sticky field forward across a volatile-only upsert", () => {
    const state = createMirrorState();
    apply(state, [sentinelWire()], true);
    apply(state, [volatileWire()]);
    const merged = state.nodes.get("n")!;

    for (const wireName of fixture.stickyFields) {
      const check = stickyChecks[wireName];
      expect(check, `fixture sticky field '${wireName}' has no client check — update staticFields.spec.ts`).toBeTruthy();
      expect(check(merged), `mergeNode carried sticky field '${wireName}' forward`).toEqual(stickyExpected[wireName]);
    }
  });

  it("lets a FRESH sticky value replace the retained one (a growing stroke, a cleared stroke)", () => {
    const state = createMirrorState();
    apply(state, [sentinelWire()], true);
    apply(state, [
      { ...volatileWire(), linePoints: [17, 98, 457, 249, 390.25, 554.5], lineWidth: 12, lineColor: color("#0000ffff") }
    ]);
    const grown = state.nodes.get("n")!;
    expect(grown.linePoints).toEqual([17, 98, 457, 249, 390.25, 554.5]);
    expect(grown.lineWidth).toBe(12);
    expect(grown.lineColor?.html).toBe("#0000ffff");

    // An EMPTY array is the producer's "stroke cleared" (undo / clear-all) INSTRUCTION, not an absence — it must
    // beat the retained geometry, which is exactly what `upsert ?? existing` gives (only null/undefined falls back).
    const cleared = createMirrorState();
    apply(cleared, [sentinelWire()], true);
    apply(cleared, [{ ...volatileWire(), linePoints: [] }]);
    expect(cleared.nodes.get("n")!.linePoints).toEqual([]);
  });
});
