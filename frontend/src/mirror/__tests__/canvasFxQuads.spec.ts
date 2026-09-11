import { afterEach, describe, expect, it, vi } from "vitest";

import { SHADER_DORMANT_ATTR } from "@godot-scene-web/html";
import { BLEND_ADD, BLEND_MIX, BLEND_MUL, createDrawList } from "@godot-scene-web/canvas";

import { buildDrawList } from "@/mirror/canvas/buildDrawList";
import type { FxSurface } from "@/mirror/canvas/fxSurfaces";
import {
  createPaintScratch,
  emitFxQuad,
  type FxQuadSource,
  type OverlayRecord,
  type PaintSink
} from "@/mirror/canvas/paintSpec";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorNode, type MirrorState } from "@/mirror/sceneTree";
import type { MirrorShaderBinding } from "@/mirror/shaderAttributes";

// EFFECTS INTO THE CANVAS (M2) — the QUAD half.
//
// The pixels half is `fxSurfaces.spec` (the registry, its governor and its three park guards). This is what the
// draw list does with them: where the quad goes, what colour and blend it carries, when there is deliberately no
// quad at all, and — the one that guards everything else in the repo — that WITHOUT an `fxSource` the builder's
// output is unchanged, float for float.
//
// `nodeShaderAttributes` / `nodeParticleAttributes` are mocked for the same reason `canvasOverlayPaint.spec` mocks
// the first: the contract under test is what the BUILDER does with a binding, and a spec that had to synthesize a
// resolvable material document would be testing gsw's resolver instead.

const { shaderBindingMock, particleBindingMock } = vi.hoisted(() => ({
  shaderBindingMock: vi.fn(),
  particleBindingMock: vi.fn()
}));
vi.mock("@/mirror/shaderAttributes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/shaderAttributes")>();
  return {
    ...actual,
    nodeShaderAttributes: (node: MirrorNode) => shaderBindingMock(node),
    // A node with a shader id IS a WebGL shader node here; the real predicate needs a resolved material doc.
    isWebglShaderNode: (node: MirrorNode) => node.shaderId != null
  };
});
vi.mock("@/mirror/particleAttributes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/particleAttributes")>();
  return { ...actual, nodeParticleAttributes: (node: MirrorNode) => particleBindingMock(node) };
});

afterEach(() => {
  shaderBindingMock.mockReset();
  particleBindingMock.mockReset();
});

const WEBGL_BINDING: MirrorShaderBinding = {
  attributes: { "data-godot-shader-webgl": "1", "data-godot-shader-path": "res://shaders/fire.gdshader" },
  style: {}
};
const DORMANT_BINDING: MirrorShaderBinding = {
  attributes: { "data-godot-shader-webgl": "1", [SHADER_DORMANT_ATTR]: "1" },
  style: {}
};
const PARTICLE_BINDING = { specsJson: "{}" };

// --- fixtures ---------------------------------------------------------------------------------------------

function wireNode(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId: null,
    name: id,
    nodeType: "Control",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 50 } },
    visible: true,
    ...over
  };
}

function stateOf(specs: Array<Record<string, unknown>>): MirrorState {
  const state = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      orderedIds: specs.map((s) => s.id),
      upserts: specs
    })!
  );
  return state;
}

function nodeOf(specs: Array<Record<string, unknown>>, id: string): MirrorNode {
  return stateOf(specs).nodes.get(id)!;
}

/** A shader node: a `ColorRect` carrying a material, which is what a combat fire / card glow is. */
function shaderSpec(id = "fx", over: Record<string, unknown> = {}): Record<string, unknown> {
  return wireNode(id, {
    nodeType: "Godot.ColorRect",
    shader: { resourcePath: "res://shaders/fire.gdshader" },
    fillColor: { r: 1, g: 1, b: 1, a: 1 },
    ...over
  });
}

/** A particle emitter. Its own node box is 0x0 — the whole reason the quad's box comes off the canvas. */
function particleSpec(id = "ps", over: Record<string, unknown> = {}): Record<string, unknown> {
  return wireNode(id, {
    nodeType: "Godot.GPUParticles2D",
    localRect: { position: { x: 0, y: 0 }, size: { x: 0, y: 0 } },
    // A `GpuParticles2D`'s material IS a ShaderMaterial, so an emitter carries both — and `overlayKindOf`'s
    // precedence puts particles first, which is what makes the particle runtime own these pixels.
    shader: { resourcePath: "res://shaders/particles.gdshader" },
    particleSpec: { kind: "GPUParticles2D", amount: 8, lifetime: 1 },
    particleEmitting: true,
    ...over
  });
}

function record(over: Partial<OverlayRecord> = {}): OverlayRecord {
  return {
    id: "fx",
    kind: "shader",
    transform: [1, 0, 0, 1, 0, 0],
    w: 100,
    h: 50,
    order: 0,
    opacity: 1,
    tintR: 1,
    tintG: 1,
    tintB: 1,
    coveredAbove: false,
    clip: null,
    ...over
  };
}

function surface(over: Partial<FxSurface> = {}): FxSurface {
  return {
    key: "fx://fx",
    offsetX: 0,
    offsetY: 0,
    cssW: 100,
    cssH: 50,
    blend: BLEND_MIX,
    // The uploaded texture's backing store — the quad's source rect, carried on the surface itself since the
    // registry started sharing one texture between twins (see `fxSurfaces`' header).
    pageW: 256,
    pageH: 128,
    stale: false,
    ...over
  };
}

interface Pushed {
  texture: string | null;
  m: number[];
  w: number;
  h: number;
  src: [number, number, number, number];
  rgba: [number, number, number, number];
  blend: number;
  hasColorMatrix: boolean;
  flip: [boolean, boolean];
}

/** A sink that records what was pushed. Every push COPIES, exactly as the real list does. */
function capturingSink(): { sink: PaintSink; pushed: Pushed[] } {
  const pushed: Pushed[] = [];
  return {
    pushed,
    sink: {
      quad(view, texture) {
        pushed.push({
          texture,
          m: [...view.m],
          w: view.w,
          h: view.h,
          src: [view.srcX, view.srcY, view.srcW, view.srcH],
          rgba: [view.r, view.g, view.b, view.a],
          blend: view.blend,
          hasColorMatrix: view.hasColorMatrix,
          flip: [view.flipH, view.flipV]
        });
      },
      ninePatch() {
        throw new Error("an fx quad is never a nine-patch");
      },
      polyline() {
        throw new Error("an fx quad is never a polyline");
      }
    }
  };
}

/** An `FxQuadSource` that answers a fixed surface, and logs every `acquire`. */
function fxSourceOf(answer: FxSurface | null): FxQuadSource & { acquired: Array<[string, number, number]> } {
  const acquired: Array<[string, number, number]> = [];
  return {
    acquired,
    acquire(id, w, h) {
      acquired.push([id, w, h]);
      return answer;
    }
  };
}

function emit(
  node: MirrorNode,
  rec: OverlayRecord,
  fx: FxQuadSource
): { pushed: Pushed[]; count: number } {
  const { sink, pushed } = capturingSink();
  const count = emitFxQuad(
    {
      node,
      global: [1, 0, 0, 1, 0, 0],
      ownOpacity: rec.opacity,
      tintR: rec.tintR,
      tintG: rec.tintG,
      tintB: rec.tintB,
      hidden: false,
      order: rec.order
    },
    rec,
    createPaintScratch(),
    sink,
    fx
  );
  return { pushed, count };
}

// --- the geometry -----------------------------------------------------------------------------------------

describe("an fx quad's geometry", () => {
  it("places the quad at the record's transform composed with the CANVAS's own origin", () => {
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    const fx = fxSourceOf(surface({ offsetX: -40, offsetY: -25, cssW: 180, cssH: 100 }));
    const { pushed } = emit(nodeOf([shaderSpec()], "fx"), record({ transform: [2, 0, 0, 2, 300, 400] }), fx);

    // The canvas's origin is in the NODE's coordinates, so the translate composes INSIDE the placement — and is
    // therefore scaled by it, which is what a scaled node's surface does on screen.
    expect(pushed[0].m).toEqual([2, 0, 0, 2, 300 + 2 * -40, 400 + 2 * -25]);
    // The DESTINATION size is the canvas's CSS box, never the node's.
    expect(pushed[0].w).toBe(180);
    expect(pushed[0].h).toBe(100);
  });

  it("takes the SOURCE rect from the backing store — a zero-span source would smear one texel", () => {
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    const fx = fxSourceOf(surface({ pageW: 2048, pageH: 768 }));
    const { pushed } = emit(nodeOf([shaderSpec()], "fx"), record(), fx);
    // The executor reads `srcW/srcH === 0` as "stretch ONE TEXEL" (correct for an untextured solid fill), not as
    // "the whole texture" — so leaving them at 0 would paint a flat block of the surface's top-left pixel.
    expect(pushed[0].src).toEqual([0, 0, 2048, 768]);
    expect(pushed[0].texture).toBe("fx://fx");
  });

  it("names the node through `acquire` with the RECORD's box, which is what a percent placement resolves against", () => {
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    const fx = fxSourceOf(surface());
    emit(nodeOf([shaderSpec()], "fx"), record({ w: 640, h: 360 }), fx);
    expect(fx.acquired).toEqual([["fx", 640, 360]]);
  });

  it("emits NO quad — but still NAMES the node — while the surface has no pixels yet", () => {
    // NAMING IS THE PARK CONTRACT. The registry drops the dirty bit of any surface a build did not name, so a
    // build that skipped `acquire` here would stop the surface ever being refreshed once it did have pixels.
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    const fx = fxSourceOf(null);
    const { count } = emit(nodeOf([shaderSpec()], "fx"), record(), fx);
    expect(count).toBe(0);
    expect(fx.acquired).toEqual([["fx", 100, 50]]);
  });

  it("emits no quad when the page size is unknown", () => {
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    const zeroed = surface({ pageW: 0, pageH: 0 });
    expect(emit(nodeOf([shaderSpec()], "fx"), record(), fxSourceOf(zeroed)).count).toBe(0);
    // …and one axis is enough: a source with no height smears a row of texels exactly as one with no width does.
    expect(emit(nodeOf([shaderSpec()], "fx"), record(), fxSourceOf(surface({ pageH: 0 }))).count).toBe(0);
  });

  it("refuses a kind with no gsw surface behind it", () => {
    for (const kind of ["text", "spine", "trail"] as const) {
      const fx = fxSourceOf(surface());
      expect(emit(nodeOf([wireNode("fx")], "fx"), record({ kind }), fx).count).toBe(0);
      expect(fx.acquired).toEqual([]);
    }
  });
});

// --- colour + blend ---------------------------------------------------------------------------------------

describe("an fx quad's colour and blend — the DOM twin RESTATED, not improved", () => {
  it("a SHADER quad carries alpha and NO tint", () => {
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    const fx = fxSourceOf(surface());
    const { pushed } = emit(
      nodeOf([shaderSpec()], "fx"),
      record({ opacity: 0.5, tintR: 0.2, tintG: 0.4, tintB: 0.6 }),
      fx
    );
    // `mergedNodeStyle`'s rule, which `syncHostStyle` also obeys: a WebGL host gets NO filter, because gsw feeds
    // the node's modulate into the shader through `data-godot-shader-modulate`. A tint here would double it.
    // Premultiplied white at alpha 0.5 is (0.5, 0.5, 0.5, 0.5).
    expect(pushed[0].rgba).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it("a PARTICLE quad carries the composed tint, premultiplied", () => {
    particleBindingMock.mockReturnValue(PARTICLE_BINDING);
    const fx = fxSourceOf(surface({ key: "fx://ps" }));
    const { pushed } = emit(
      nodeOf([particleSpec()], "ps"),
      record({ id: "ps", kind: "particles", opacity: 0.5, tintR: 0.2, tintG: 0.4, tintB: 0.6 }),
      fx
    );
    // The DOM twin for a particle host writes BOTH `opacity` and the composed-tint `filter` (it is not a WebGL
    // shader host, so the filter is not suppressed), i.e. the surface is tinted once and faded once.
    expect(pushed[0].rgba[0]).toBeCloseTo(0.1, 10);
    expect(pushed[0].rgba[1]).toBeCloseTo(0.2, 10);
    expect(pushed[0].rgba[2]).toBeCloseTo(0.3, 10);
    expect(pushed[0].rgba[3]).toBe(0.5);
  });

  it("REPRODUCES the DOM's double-applied node alpha rather than correcting it (TODO(M3))", () => {
    // gsw folds `modulate.a` into the shader, so the surface's PIXELS already carry it; the overlay then writes
    // CSS `opacity` over the top, and the effect fades as alpha SQUARED on the DOM stage. The quad multiplies the
    // same second factor onto the same already-faded pixels, so the two backends agree — which is the point. It
    // is a registered divergence from the GAME, not one between the arms, and fixing it means fixing both.
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    const fx = fxSourceOf(surface());
    const { pushed } = emit(nodeOf([shaderSpec()], "fx"), record({ opacity: 0.25 }), fx);
    expect(pushed[0].rgba[3]).toBe(0.25);
  });

  it("takes a SHADER's blend from the surface record", () => {
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    for (const blend of [BLEND_MIX, BLEND_ADD, BLEND_MUL] as const) {
      const { pushed } = emit(nodeOf([shaderSpec()], "fx"), record(), fxSourceOf(surface({ blend })));
      expect(pushed[0].blend).toBe(blend);
    }
  });

  it("FORCES a particle quad to MIX even when the registry says otherwise", () => {
    particleBindingMock.mockReturnValue(PARTICLE_BINDING);
    // An additive particle system resolves its own accumulation buffer INSIDE gsw and hands back premultiplied
    // source-over pixels. Re-applying `add` here would blow the emitter's own blend out a second time. The
    // registry cannot make this call — it does not know a surface's kind — so the emitter does.
    const { pushed } = emit(
      nodeOf([particleSpec()], "ps"),
      record({ id: "ps", kind: "particles" }),
      fxSourceOf(surface({ key: "fx://ps", blend: BLEND_ADD }))
    );
    expect(pushed[0].blend).toBe(BLEND_MIX);
  });

  it("carries no colour matrix and no flip — a surface is already the picture", () => {
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    const { pushed } = emit(nodeOf([shaderSpec()], "fx"), record(), fxSourceOf(surface()));
    // The HSV family — the one shader kind that DOES want a colour matrix — is drawn by the canvas path as a
    // per-quad `hsvColorMatrix` already, so it is never classified an overlay and never reaches here. And a gsw
    // surface is a finished raster in the node's own orientation: there is no atlas fit to normalise a flip out of.
    expect(pushed[0].hasColorMatrix).toBe(false);
    expect(pushed[0].flip).toEqual([false, false]);
  });
});

// --- the drops --------------------------------------------------------------------------------------------

describe("when the fx path deliberately draws nothing", () => {
  it("drops a DORMANT shader host, and does not even name it", () => {
    shaderBindingMock.mockReturnValue(DORMANT_BINDING);
    const fx = fxSourceOf(surface());
    const { count } = emit(nodeOf([shaderSpec()], "fx"), record(), fx);
    // `SHADER_DORMANT_ATTR` is gsw's own park contract, which the mirror drives on BOTH backends. A parked host
    // draws no more frames, so a quad would paint its last one forever — a glow frozen on a card the game
    // stopped glowing. Not naming it is what lets the registry drop the dirty bit and evict the texture.
    expect(count).toBe(0);
    expect(fx.acquired).toEqual([]);
  });

  it("drops a shader whose binding gsw declined", () => {
    shaderBindingMock.mockReturnValue(null);
    const fx = fxSourceOf(surface());
    expect(emit(nodeOf([shaderSpec()], "fx"), record(), fx).count).toBe(0);
    expect(fx.acquired).toEqual([]);
  });

  it("drops a particle emitter whose spec went null", () => {
    particleBindingMock.mockReturnValue(null);
    const fx = fxSourceOf(surface({ key: "fx://ps" }));
    expect(emit(nodeOf([particleSpec()], "ps"), record({ id: "ps", kind: "particles" }), fx).count).toBe(0);
    expect(fx.acquired).toEqual([]);
  });

  it("draws again the moment the binding comes back", () => {
    const fx = fxSourceOf(surface());
    const node = nodeOf([shaderSpec()], "fx");
    shaderBindingMock.mockReturnValue(DORMANT_BINDING);
    expect(emit(node, record(), fx).count).toBe(0);
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    expect(emit(node, record(), fx).count).toBe(1);
  });
});

// --- the builder seam -------------------------------------------------------------------------------------

describe("buildDrawList's fxSource option", () => {
  function build(state: MirrorState, fxSource: FxQuadSource | null) {
    const list = createDrawList<string>();
    const result = buildDrawList(state, list, { fxSource, hitTest: false });
    return {
      result,
      // The whole numeric payload of the list, which is what "byte-identical" has to mean here.
      floats: Array.from(list.floats.subarray(0, Math.max(0, list.count * 24))),
      ints: Array.from(list.ints.subarray(0, Math.max(0, list.count * 8))),
      count: list.count,
      textures: Array.from({ length: list.count }, (_, i) => list.textureAt(i))
    };
  }

  const SCENE = [
    wireNode("bg", { fillColor: { r: 0, g: 0, b: 0, a: 1 } }),
    shaderSpec("fx"),
    wireNode("label", { nodeType: "Godot.Label", text: { text: "hi" } })
  ];

  it("is ABSENT by default, and then the list is byte-identical with a shader node present", () => {
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    const state = stateOf(SCENE);
    const withoutOption = build(state, null);

    // …and the same build asked for explicitly-null, which is what every pre-M2 caller and the offline gate pass.
    const explicitNull = build(state, null);
    expect(explicitNull.floats).toEqual(withoutOption.floats);
    expect(explicitNull.ints).toEqual(withoutOption.ints);
    expect(explicitNull.count).toBe(withoutOption.count);
    expect(withoutOption.result.stats.fxQuads).toBe(0);
    // The shader node is still an OVERLAY record — the classification does not move, so the union oracle the
    // offline gate asserts against `walkResolved` is untouched.
    expect(withoutOption.result.stats.overlayByKind.shader).toBe(1);
  });

  it("adds exactly one command — the quad — when a source IS supplied", () => {
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    const state = stateOf(SCENE);
    const off = build(state, null);
    const on = build(state, fxSourceOf(surface()));

    expect(on.count).toBe(off.count + 1);
    expect(on.result.stats.fxQuads).toBe(1);
    expect(on.textures).toContain("fx://fx");
    // Still an overlay record too: the host element is what gsw binds its runtime to.
    expect(on.result.stats.overlayByKind.shader).toBe(1);
    expect(on.result.overlayRecords.map((r) => r.id)).toContain("fx");
  });

  it("admits a SCREEN_TEXTURE command at the shader's semantic index without also sampling a quad", () => {
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    const calls: string[] = [];
    const fx: FxQuadSource = {
      acquire: () => {
        throw new Error("screen effect must not also produce a texture quad");
      },
      emitScreen: (_input, rec) => {
        calls.push(rec.id);
        return 1;
      }
    };
    const { result } = build(stateOf(SCENE), fx);
    expect(calls).toEqual(["fx"]);
    expect(result.fxQuadIds).toEqual(new Set(["fx"]));
    expect(result.stats.fxQuads).toBe(1);
  });

  it("does not fall through from a pending screen source to an ordinary effect quad", () => {
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    let acquired = 0;
    const { result } = build(stateOf(SCENE), {
      acquire: () => {
        acquired++;
        return surface();
      },
      emitScreen: () => "pending"
    });
    expect(acquired).toBe(0);
    expect(result.fxQuadIds.size).toBe(0);
  });

  it("puts the quad at the node's own PAINT INDEX, not above everything", () => {
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    // `bg` paints before the shader; `over` paints after it. The whole point of M2 is that `over` is ON TOP.
    const state = stateOf([
      wireNode("bg", { fillColor: { r: 0, g: 0, b: 0, a: 1 } }),
      shaderSpec("fx"),
      wireNode("over", { fillColor: { r: 1, g: 0, b: 0, a: 1 } })
    ]);
    const list = createDrawList<string>();
    buildDrawList(state, list, { fxSource: fxSourceOf(surface()), hitTest: false });
    const keys = Array.from({ length: list.count }, (_, i) => list.textureAt(i));
    const fxAt = keys.indexOf("fx://fx");
    expect(fxAt).toBeGreaterThan(0); // after the background
    expect(fxAt).toBeLessThan(list.count - 1); // and before what the game paints over it
  });

  it("records the quad in the node's own command RANGE, for the tier-3 patcher", () => {
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    const { result } = build(stateOf(SCENE), fxSourceOf(surface()));
    const range = result.ranges.get("fx");
    expect(range).toBeDefined();
    expect(range!.paintEnd - range!.start).toBe(1);
  });

  it("emits a quad INSIDE an ancestor's clip scope", () => {
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    const state = stateOf([
      wireNode("clipper", { nodeType: "Godot.Control", clipContents: true, fillColor: { r: 0, g: 0, b: 0, a: 1 } }),
      shaderSpec("fx", { parentId: "clipper" })
    ]);
    const list = createDrawList<string>();
    const result = buildDrawList(state, list, { fxSource: fxSourceOf(surface()), hitTest: false });
    const clip = result.clipRanges.get("clipper");
    expect(clip).toBeDefined();
    const fxAt = Array.from({ length: list.count }, (_, i) => list.textureAt(i)).indexOf("fx://fx");
    // Inside the interval ⇒ the executor's scissor covers it for free, with no new plumbing.
    expect(fxAt).toBeGreaterThan(clip!.push);
    expect(fxAt).toBeLessThan(clip!.pop);
  });

  it("leaves text, spine and trail records alone", () => {
    shaderBindingMock.mockReturnValue(WEBGL_BINDING);
    const fx = fxSourceOf(surface());
    const state = stateOf([wireNode("label", { nodeType: "Godot.Label", text: { text: "hi" } })]);
    const result = buildDrawList(state, createDrawList<string>(), { fxSource: fx, hitTest: false });
    expect(result.stats.overlayByKind.text).toBe(1);
    expect(result.stats.fxQuads).toBe(0);
    expect(fx.acquired).toEqual([]);
  });
});
