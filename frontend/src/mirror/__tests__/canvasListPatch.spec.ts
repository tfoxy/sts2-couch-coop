// TIER-3 PATCHING: does writing four floats produce the list a rebuild would have produced?
//
// THE ORACLE IS THE BUILDER ITSELF. Almost every case below builds a list at alpha A, patches it to alpha B, and
// compares it — command for command, float for float — against a list BUILT at alpha B. That is the whole claim
// the feature makes, and it cannot drift from the walk's composition rules the way a hand-written expectation
// would: if `buildDrawList` changes how alpha cascades, these fail.
//
// The refusals are tested for what they LEAVE BEHIND as much as for the reason they answer: a patcher that bailed
// after writing half a plan would corrupt a frame in a way no rebuild could explain, so the "touched nothing"
// assertion is the load-bearing half of those cases.

import { describe, expect, it } from "vitest";

import { createDrawList, createNinePatchView, createQuadView } from "@godot-scene-web/canvas";

import {
  buildDrawList,
  type AlphaOverride,
  type DrawListBuild,
  type NodeCommandRange
} from "@/mirror/canvas/buildDrawList";
import {
  PATCH_CHAIN_MAX,
  createPatchScratch,
  patchOpacity,
  patchSource,
  planSource,
  type PatchBailReason,
  type PatchEnv,
  type PatchOutcome,
  type SourcePatch,
  type SourcePatchTarget
} from "@/mirror/canvas/listPatch";
import { createMirrorState, type MirrorNode, type MirrorState } from "@/mirror/sceneTree";

function mkNode(id: string, parentId: string | null, over: Partial<MirrorNode> = {}): MirrorNode {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Godot.TextureRect",
    showBehindParent: false,
    clipChildren: 0,
    clipContents: false,
    ninePatchMargins: null,
    font: null,
    richBoldFont: null,
    richItalicFont: null,
    richBoldItalicFont: null,
    richBoldFontSizePx: null,
    richItalicFontSizePx: null,
    richBoldItalicFontSizePx: null,
    richBoldFontSpacingPx: null,
    richItalicFontSpacingPx: null,
    richBoldItalicFontSpacingPx: null,
    textWrap: null,
    shadow: null,
    richText: false,
    shaderId: null,
    materialRef: null,
    shaderParams: null,
    textureStretchMode: null,
    textureFlipH: false,
    textureFlipV: false,
    particleSpec: null,
    particleEmitting: false,
    particleRestartEpoch: 0,
    spineSceneResPath: null,
    spineNodePath: null,
    spineAnimations: null,
    spineSkelResPath: null,
    sceneFilePath: null,
    mouseFilter: null,
    anchorLeft: null,
    anchorRight: null,
    anchorOwnerId: null,
    containerLayout: null,
    contentKey: null,
    spineCurrentAnim: null,
    spineSkin: null,
    spineMat: null,
    spinePaused: false,
    spineTrackTime: 0,
    spineLooping: true,
    pinnedLoopAnim: null,
    outline: null,
    transform: [1, 0, 0, 1, 0, 0],
    localRect: { x: 0, y: 0, width: 100, height: 100 },
    visible: true,
    focused: false,
    opacity: 1,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    pivotX: 0,
    pivotY: 0,
    zIndex: null,
    textureUrl: null,
    textureRegion: null,
    textureMargin: null,
    ninePatch: false,
    modulate: null,
    selfModulate: null,
    fillColor: { r: 0.8, g: 0.6, b: 0.4, a: 1, html: "#000000" },
    range: null,
    text: null,
    intentFrames: null,
    linePoints: null,
    lineWidth: null,
    lineColor: null,
    ...over
  };
}

function color(r: number, g: number, b: number, a: number) {
  return { r, g, b, a, html: "#000000" };
}

function mkState(nodes: MirrorNode[]): MirrorState {
  const state = createMirrorState();
  for (const node of nodes) {
    state.nodes.set(node.id, node);
  }
  state.orderedIds = nodes.map((n) => n.id);
  state.revision = 1;
  return state;
}

type Overrides = Map<string, AlphaOverride>;

function alpha(mod: number | null, self: number | null = null): AlphaOverride {
  return { mod, self };
}

function buildAt(state: MirrorState, overrides: Overrides) {
  const list = createDrawList<string>();
  const build = buildDrawList(state, list, {
    alphaOverrides: overrides.size > 0 ? overrides : null,
    assert: true
  });
  return { list, build };
}

/** Every command's colour, in order — the surface a colour patch is allowed to move. */
function colours(list: ReturnType<typeof createDrawList<string>>): number[][] {
  const quad = createQuadView();
  const nine = createNinePatchView();
  const out: number[][] = [];
  for (let i = 0; i < list.count; i++) {
    const kind = list.kindNameAt(i);
    if (kind === "quad") {
      const v = list.readQuad(i, quad);
      out.push([v.r, v.g, v.b, v.a]);
    } else if (kind === "ninePatch") {
      const v = list.readNinePatch(i, nine);
      out.push([v.r, v.g, v.b, v.a]);
    } else {
      out.push([]);
    }
  }
  return out;
}

/** Every command's GEOMETRY (and kind) — the surface a colour patch must not move. */
function geometry(list: ReturnType<typeof createDrawList<string>>): unknown[] {
  const quad = createQuadView();
  const nine = createNinePatchView();
  const out: unknown[] = [];
  for (let i = 0; i < list.count; i++) {
    const kind = list.kindNameAt(i);
    if (kind === "quad" || kind === "ninePatch") {
      const v = kind === "ninePatch" ? list.readNinePatch(i, nine) : list.readQuad(i, quad);
      out.push([kind, [...v.m], v.w, v.h, v.srcX, v.srcY, v.srcW, v.srcH, v.blend, v.flipH, v.flipV]);
    } else {
      out.push([kind]);
    }
  }
  return out;
}

/** The complete source surface — both the UV arena values and the draw-list's texture reference. */
function sources(list: ReturnType<typeof createDrawList<string>>): unknown[] {
  const quad = createQuadView();
  const nine = createNinePatchView();
  const out: unknown[] = [];
  for (let i = 0; i < list.count; i++) {
    const kind = list.kindNameAt(i);
    if (kind === "quad" || kind === "ninePatch") {
      const v = kind === "quad" ? list.readQuad(i, quad) : list.readNinePatch(i, nine);
      out.push([kind, list.textureAt(i), v.srcX, v.srcY, v.srcW, v.srcH]);
    } else {
      out.push([kind, null]);
    }
  }
  return out;
}

/** Everything a source patch promises to preserve. */
function nonSourceGeometry(list: ReturnType<typeof createDrawList<string>>): unknown[] {
  const quad = createQuadView();
  const nine = createNinePatchView();
  const out: unknown[] = [];
  for (let i = 0; i < list.count; i++) {
    const kind = list.kindNameAt(i);
    if (kind === "quad" || kind === "ninePatch") {
      const v = kind === "quad" ? list.readQuad(i, quad) : list.readNinePatch(i, nine);
      out.push([kind, [...v.m], v.w, v.h, v.r, v.g, v.b, v.a, v.blend, v.flipH, v.flipV]);
    } else {
      out.push([kind]);
    }
  }
  return out;
}

function envFor(state: MirrorState, build: DrawListBuild, applied: Overrides, current: Overrides): PatchEnv {
  return {
    nodeOf: (id) => state.nodes.get(id),
    childrenOf: (id) => build.order.childrenOf(id),
    rangeOf: (id): NodeCommandRange | undefined => build.ranges.get(id),
    appliedAlphaOf: (id) => applied.get(id),
    currentAlphaOf: (id) => current.get(id)
  };
}

function newOutcome(): PatchOutcome {
  return { patched: false, bail: null, quads: 0, nodes: 0, visited: 0 };
}

function scratch() {
  return createPatchScratch(createQuadView(), createNinePatchView());
}

function sourcePatchFor(id: string, range: NodeCommandRange, texture: string | null, region: NonNullable<MirrorNode["textureRegion"]>): SourcePatch<string> {
  return { id, range, texture, srcX: region.x, srcY: region.y, srcW: region.width, srcH: region.height };
}

/**
 * Build at `applied`, patch to `current`, and hand back both the patched list and a list BUILT at `current`.
 * `roots` defaults to every id the two override maps disagree about — which is what the sweep publishes.
 */
function patchRun(
  nodes: MirrorNode[],
  applied: Overrides,
  current: Overrides,
  roots?: Set<string>
) {
  const state = mkState(nodes);
  const { list, build } = buildAt(state, applied);
  const before = { colours: colours(list), geometry: geometry(list) };
  const ids = roots ?? new Set([...current.keys()]);
  const outcome = newOutcome();
  patchOpacity(ids, envFor(state, build, applied, current), list, scratch(), outcome);
  const rebuilt = buildAt(state, current);
  return { state, list, build, before, outcome, rebuilt };
}

describe("patchSource against the builder's own answer", () => {
  function runSourcePatch(nextRegion = { x: 48, y: 0, width: 48, height: 51 }, texture: string | null = "/res/intent-next.png") {
    const node = mkNode("Intent", null, {
      nodeType: "Godot.Sprite2D",
      fillColor: null,
      textureUrl: "/res/intent-base.png",
      textureRegion: { x: 0, y: 0, width: 48, height: 51 },
      localRect: { x: 0, y: 0, width: 48, height: 51 }
    });
    const state = mkState([node]);
    const { list, build } = buildAt(state, new Map());
    const before = { sources: sources(list), geometry: nonSourceGeometry(list) };
    const replacement = { ...node, textureUrl: texture, textureRegion: nextRegion };
    const range = build.ranges.get(node.id)!;
    const outcome = newOutcome();
    patchSource([sourcePatchFor(node.id, range, texture, nextRegion)], list as SourcePatchTarget<string>, scratch(), outcome);
    const rebuiltList = createDrawList<string>();
    buildDrawList(state, rebuiltList, { frameSubstitutes: new Map([[node.id, replacement]]), assert: true });
    return { list, build, before, outcome, rebuiltList, node, replacement };
  }

  it("patches a resident intent frame's texture reference and UVs to the forced-rebuild list", () => {
    const run = runSourcePatch();

    expect(run.build.ranges.get("Intent")?.paintEnd).toBe(run.build.ranges.get("Intent")?.start! + 1);
    expect(run.outcome).toMatchObject({ patched: true, bail: null, quads: 1, nodes: 1 });
    expect(sources(run.list)).toEqual(sources(run.rebuiltList));
    expect(nonSourceGeometry(run.list)).toEqual(run.before.geometry);
  });

  it("refuses a nonresident next texture without changing the current frame", () => {
    const run = runSourcePatch({ x: 48, y: 0, width: 48, height: 51 }, null);

    expect(run.outcome).toMatchObject({ patched: false, bail: "sourceTexture" });
    expect(sources(run.list)).toEqual(run.before.sources);
    expect(nonSourceGeometry(run.list)).toEqual(run.before.geometry);
  });

  it("refuses a changed source shape, leaving the prior source intact for the rebuild", () => {
    const run = runSourcePatch({ x: 48, y: 0, width: 64, height: 51 });

    expect(run.outcome).toMatchObject({ patched: false, bail: "sourceShape" });
    expect(sources(run.list)).toEqual(run.before.sources);
    expect(nonSourceGeometry(run.list)).toEqual(run.before.geometry);
  });

  it("refuses an empty SAMPLE_SOURCE plan instead of claiming the stale source was patched", () => {
    const node = mkNode("Intent", null, {
      nodeType: "Godot.Sprite2D",
      fillColor: null,
      textureUrl: "/res/intent-base.png",
      textureRegion: { x: 0, y: 0, width: 48, height: 51 }
    });
    const state = mkState([node]);
    const { list } = buildAt(state, new Map());
    const before = sources(list);
    const outcome = newOutcome();

    planSource([], list as SourcePatchTarget<string>, scratch(), outcome);

    expect(outcome).toMatchObject({ patched: false, bail: "source", quads: 0 });
    expect(sources(list)).toEqual(before);
  });

  it("does not apply an otherwise-valid opacity patch when a later source plan refuses", () => {
    const fade = mkNode("Fade", null, { modulate: color(1, 1, 1, 1) });
    const intent = mkNode("Intent", null, {
      nodeType: "Godot.Sprite2D",
      fillColor: null,
      textureUrl: "/res/intent-base.png",
      textureRegion: { x: 0, y: 0, width: 48, height: 51 }
    });
    const state = mkState([fade, intent]);
    const applied: Overrides = new Map([["Fade", alpha(1)]]);
    const current: Overrides = new Map([["Fade", alpha(0.5)]]);
    const { list, build } = buildAt(state, applied);
    const before = { colours: colours(list), sources: sources(list) };
    const region = intent.textureRegion!;
    const sourceOutcome = newOutcome();
    const patchOutcome = newOutcome();
    const patchScratch = scratch();
    const source = sourcePatchFor("Intent", build.ranges.get("Intent")!, "/res/intent-next.png", region);

    // The first entry is fully valid and fills the plan; the second fails after it. This is the ordering that used
    // to let opacity write first in the renderer, leaving a frame that no full rebuild had ever produced.
    planSource([source, { ...source, texture: null }], list as SourcePatchTarget<string>, patchScratch, sourceOutcome);
    if (sourceOutcome.patched) {
      patchOpacity(new Set(["Fade"]), envFor(state, build, applied, current), list, patchScratch, patchOutcome);
    }

    expect(sourceOutcome).toMatchObject({ patched: false, bail: "sourceTexture" });
    expect(patchOutcome.patched).toBe(false);
    expect(colours(list)).toEqual(before.colours);
    expect(sources(list)).toEqual(before.sources);
  });
});

function expectClose(actual: number[][], expected: number[][], eps = 1e-6): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i].length, `command ${i} kind`).toBe(expected[i].length);
    for (let c = 0; c < expected[i].length; c++) {
      expect(Math.abs(actual[i][c] - expected[i][c]), `command ${i} channel ${c}`).toBeLessThanOrEqual(eps);
    }
  }
}

describe("patchOpacity against the builder's own answer", () => {
  it("fades one node to exactly what a rebuild at the new alpha would have drawn", () => {
    const applied: Overrides = new Map([["A", alpha(1)]]);
    const current: Overrides = new Map([["A", alpha(0.25)]]);
    const { list, outcome, rebuilt, before } = patchRun([mkNode("A", null)], applied, current);

    expect(outcome.patched).toBe(true);
    expect([outcome.quads, outcome.nodes]).toEqual([1, 1]);
    expectClose(colours(list), colours(rebuilt.list));
    // …and moved nothing else.
    expect(geometry(list)).toEqual(before.geometry);
  });

  it("cascades a modulate change to the whole subtree, exactly as the walk does", () => {
    const nodes = [
      mkNode("P", null, { nodeType: "Godot.Control" }),
      mkNode("C", "P", { modulate: color(1, 1, 1, 0.5) }),
      mkNode("G", "C", { selfModulate: color(1, 1, 1, 0.75) })
    ];
    const applied: Overrides = new Map([["P", alpha(0.9)]]);
    const current: Overrides = new Map([["P", alpha(0.3)]]);
    const { list, outcome, rebuilt } = patchRun(nodes, applied, current);

    expect(outcome.patched).toBe(true);
    expect(outcome.quads).toBe(3);
    expectClose(colours(list), colours(rebuilt.list));
  });

  it("applies a SELF-modulate change to the node's own paint and to nothing under it", () => {
    const nodes = [mkNode("P", null, { nodeType: "Godot.Control" }), mkNode("C", "P")];
    const applied: Overrides = new Map([["P", alpha(null, 1)]]);
    const current: Overrides = new Map([["P", alpha(null, 0.4)]]);
    const { list, before, outcome, rebuilt } = patchRun(nodes, applied, current);

    expect(outcome.patched).toBe(true);
    expect(outcome.quads).toBe(1);
    expectClose(colours(list), colours(rebuilt.list));
    // The child's command is byte-identical to what it was: a self-modulate never cascades.
    expect(colours(list)[1]).toEqual(before.colours[1]);
  });

  it("composes a fade INSIDE a fade without applying the inner factor twice", () => {
    const nodes = [
      mkNode("P", null, { nodeType: "Godot.Control" }),
      mkNode("C", "P", { nodeType: "Godot.Control" }),
      mkNode("G", "C")
    ];
    const applied: Overrides = new Map([
      ["P", alpha(1)],
      ["C", alpha(1)]
    ]);
    const current: Overrides = new Map([
      ["P", alpha(0.5)],
      ["C", alpha(0.5)]
    ]);
    // BOTH are roots, and C is under P: the outer walk covers C's subtree, and a second walk from C would square
    // C's own factor (the grandchild would land at 0.125 instead of 0.25).
    const { list, outcome, rebuilt } = patchRun(nodes, applied, current);
    expect(outcome.patched).toBe(true);
    expectClose(colours(list), colours(rebuilt.list));
    expect(colours(list)[2][3]).toBeCloseTo(0.25, 9);
  });

  it("patches a node whose alpha came from the WIRE, with no override on either side", () => {
    // The subtree of a faded parent: these nodes are not roots, have no override at all, and still have to move.
    const nodes = [
      mkNode("P", null, { nodeType: "Godot.Control", modulate: color(1, 1, 1, 0.8) }),
      mkNode("C", "P", { opacity: 0.5 })
    ];
    const applied: Overrides = new Map([["P", alpha(0.8)]]);
    const current: Overrides = new Map([["P", alpha(0.2)]]);
    const { list, outcome, rebuilt } = patchRun(nodes, applied, current);
    expect(outcome.patched).toBe(true);
    expectClose(colours(list), colours(rebuilt.list));
  });

  it("patches a nine-patch as readily as a quad", () => {
    const nodes = [
      mkNode("N", null, {
        ninePatch: true,
        textureUrl: "/res/x.png",
        ninePatchMargins: { left: 4, top: 4, right: 4, bottom: 4 },
        localRect: { x: 0, y: 0, width: 120, height: 60 }
      })
    ];
    const applied: Overrides = new Map([["N", alpha(1)]]);
    const current: Overrides = new Map([["N", alpha(0.5)]]);
    const { list, outcome, rebuilt } = patchRun(nodes, applied, current, new Set(["N"]));
    expect(outcome.patched).toBe(true);
    expect(outcome.quads).toBeGreaterThan(0);
    expectClose(colours(list), colours(rebuilt.list));
  });

  it("skips a hidden subtree without bailing — it has no commands to be wrong about", () => {
    const nodes = [mkNode("H", null, { visible: false }), mkNode("V", null)];
    const applied: Overrides = new Map([["H", alpha(1)]]);
    const current: Overrides = new Map([["H", alpha(0.2)]]);
    const { list, before, outcome } = patchRun(nodes, applied, current);
    expect(outcome.patched).toBe(true);
    expect(outcome.quads).toBe(0);
    expect(colours(list)).toEqual(before.colours);
  });

  it("writes nothing when the alpha did not actually move", () => {
    const applied: Overrides = new Map([["A", alpha(0.5)]]);
    const current: Overrides = new Map([["A", alpha(0.5)]]);
    const { list, before, outcome } = patchRun([mkNode("A", null)], applied, current);
    expect(outcome.patched).toBe(true);
    expect(outcome.quads).toBe(0);
    expect(colours(list)).toEqual(before.colours);
  });
});

describe("patchOpacity refusals", () => {
  function bailOf(
    nodes: MirrorNode[],
    applied: Overrides,
    current: Overrides,
    roots?: Set<string>
  ): { bail: PatchBailReason | null; untouched: boolean } {
    const run = patchRun(nodes, applied, current, roots);
    return {
      bail: run.outcome.bail,
      untouched: JSON.stringify(colours(run.list)) === JSON.stringify(run.before.colours)
    };
  }

  it("refuses a fade that crosses the painting threshold, in either direction", () => {
    const out = bailOf([mkNode("A", null)], new Map([["A", alpha(0.5)]]), new Map([["A", alpha(0.01)]]));
    expect(out.bail).toBe("classFlip");
    expect(out.untouched).toBe(true);

    // …and back: the node has NO commands at 0.01, so there is nothing to scale up.
    const back = bailOf([mkNode("A", null)], new Map([["A", alpha(0.01)]]), new Map([["A", alpha(0.5)]]));
    expect(back.bail).toBe("classFlip");
  });

  it("refuses an over-bright alpha, where clamp01 stops being a multiply", () => {
    const out = bailOf([mkNode("A", null)], new Map([["A", alpha(1)]]), new Map([["A", alpha(1.5)]]));
    expect(out.bail).toBe("clamp");
    expect(out.untouched).toBe(true);
  });

  it("names the CLASS FLIP, not the division, for a node the list holds at zero", () => {
    // `zeroApplied` guards a division, and the guard above it makes that division unreachable: a node at applied
    // alpha 0 was not painting, so it has no commands, and any change that gives it some is a class flip. This
    // pins the ORDER — the reason a reader gets is the one that explains the frame, not the arithmetic.
    const nodes = [mkNode("P", null, { nodeType: "Godot.Control" }), mkNode("C", "P")];
    const state = mkState(nodes);
    const applied: Overrides = new Map([["C", alpha(0)]]);
    const { list, build } = buildAt(state, applied);
    expect(build.ranges.has("C")).toBe(false);
    const current: Overrides = new Map([["C", alpha(0.5)]]);
    const outcome = newOutcome();
    patchOpacity(new Set(["C"]), envFor(state, build, applied, current), list, scratch(), outcome);
    expect(outcome.bail).toBe("classFlip");
  });

  it("refuses when an overlay node is inside the subtree", () => {
    const nodes = [
      mkNode("P", null, { nodeType: "Godot.Control" }),
      mkNode("T", "P", { text: { text: "hi", colorHtml: "#fff", fontSizePx: 20, halign: 0, valign: 0 } as never })
    ];
    const out = bailOf(nodes, new Map([["P", alpha(1)]]), new Map([["P", alpha(0.5)]]));
    expect(out.bail).toBe("overlay");
    // AND the parent's own quad — visited before the text node — is untouched, which is the validate-then-apply
    // rule doing its job.
    expect(out.untouched).toBe(true);
  });

  it("refuses a stroke: a polyline's colour is not a quad's", () => {
    const nodes = [
      mkNode("L", null, {
        fillColor: null,
        linePoints: [0, 0, 10, 10, 20, 30],
        lineWidth: 3,
        lineColor: color(1, 1, 1, 1)
      })
    ];
    const out = bailOf(nodes, new Map([["L", alpha(1)]]), new Map([["L", alpha(0.5)]]));
    expect(out.bail).toBe("polyline");
    expect(out.untouched).toBe(true);
  });

  it("refuses a root the state no longer holds", () => {
    const out = bailOf([mkNode("A", null)], new Map(), new Map([["GONE", alpha(0.5)]]));
    expect(out.bail).toBe("unknownNode");
    expect(out.untouched).toBe(true);
  });

  it("leaves an EARLIER root's quads alone when a later one bails", () => {
    // The plan is filled by a walk that writes nothing; only a complete plan is applied. A patcher that wrote as
    // it walked would leave "A" faded and "B" not, which no rebuild could produce.
    const nodes = [
      mkNode("A", null),
      mkNode("B", null),
      mkNode("BT", "B", { text: { text: "hi", colorHtml: "#fff", fontSizePx: 20, halign: 0, valign: 0 } as never })
    ];
    const applied: Overrides = new Map([
      ["A", alpha(1)],
      ["B", alpha(1)]
    ]);
    const current: Overrides = new Map([
      ["A", alpha(0.5)],
      ["B", alpha(0.5)]
    ]);
    const run = patchRun(nodes, applied, current);
    expect(run.outcome.bail).toBe("overlay");
    expect(run.outcome.patched).toBe(false);
    expect(colours(run.list)).toEqual(run.before.colours);
  });
});

describe("a chain of patches", () => {
  it("stays within half a bit of an 8-bit channel over the whole chain bound", () => {
    // THE DRIFT CLAIM. A patch is a float32 multiply, so a chain of them is not bit-identical to a rebuild. This
    // walks the chain to its bound and prices the difference against the rebuild at the same alpha.
    const nodes = [mkNode("P", null, { nodeType: "Godot.Control" }), mkNode("C", "P")];
    const state = mkState(nodes);
    const applied: Overrides = new Map([["P", alpha(1)]]);
    const { list, build } = buildAt(state, applied);
    const current: Overrides = new Map([["P", alpha(1)]]);
    const outcome = newOutcome();
    const env = envFor(state, build, applied, current);
    const patchScratch = scratch();

    let a = 1;
    for (let i = 0; i < PATCH_CHAIN_MAX; i++) {
      a *= 0.9;
      (current.get("P") as AlphaOverride).mod = a;
      patchOpacity(new Set(["P"]), env, list, patchScratch, outcome);
      expect(outcome.patched).toBe(true);
      // BOOK, exactly as the renderer does: the list now holds what the overrides say.
      applied.set("P", alpha(a));
    }

    const rebuilt = buildAt(state, new Map([["P", alpha(a)]]));
    const got = colours(list);
    const want = colours(rebuilt.list);
    let worst = 0;
    for (let i = 0; i < want.length; i++) {
      for (let c = 0; c < want[i].length; c++) {
        const rel = Math.abs(got[i][c] - want[i][c]) / Math.max(1e-9, Math.abs(want[i][c]));
        worst = Math.max(worst, rel);
      }
    }
    expect(worst).toBeLessThan(2e-6);
    // An 8-bit channel step is 1/255; the drift is far below half of one, so the pixels are identical.
    expect(worst * a).toBeLessThan(0.5 / 255);
  });

});
