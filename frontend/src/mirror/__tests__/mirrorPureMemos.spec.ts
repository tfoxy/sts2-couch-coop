import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Seed atlas-page natural sizes for the nine-patch slicing tests (warmImage's real Image() load is a no-op in
// jsdom, so naturalSize would otherwise always be null and no slice would ever be emitted). Unseeded urls behave
// exactly as they do in plain jsdom (null), so nothing else in this file is affected.
vi.mock("@/mirror/textureCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/textureCache")>();
  const sizes = new Map<string, { width: number; height: number }>();
  return {
    ...actual,
    naturalSize: (url: string) => sizes.get(url) ?? null,
    __setSize: (url: string, width: number, height: number) => sizes.set(url, { width, height })
  };
});

import { SHADER_DORMANT_ATTR } from "@godot-scene-web/html";

import * as textureCache from "@/mirror/textureCache";

import {
  nodeShaderAttributes,
  resetShaderDocCache
} from "@/mirror/shaderAttributes";
import { nodeParticleAttributes } from "@/mirror/particleAttributes";
import { mirrorSettings, type EffectMode } from "@/mirror/mirrorSettings";
import {
  createMirrorRenderer,
  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorNode, type MirrorState } from "@/mirror/sceneTree";

// R10-B3 pure-work memos + reflow batching.
//
// The mirror's content-pure work was keyed on OBJECT IDENTITY, which busts on any field change — and a card play
// replaces every node object under the hand at once. These specs pin the CONTENT-keyed layer (L2): a rebuilt but
// byte-identical node must HIT it, any change to any input must MISS it, and the memoized answer must equal the
// uncached one. Plus: nine-patch per-slice diffing, the deferred phase anchors, and the card-ripple dormancy.

function baseNode(over: Partial<MirrorNode> = {}): MirrorNode {
  return {
    id: "n",
    parentId: null,
    name: "Node",
    nodeType: "TextureRect",
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
    localRect: { x: 0, y: 0, width: 200, height: 280 },
    rect: null,
    visible: true,
    opacity: 1,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    pivotX: 0,
    pivotY: 0,
    zIndex: null,
    textureUrl: "/res/images/card.png",
    textureRegion: null,
    textureMargin: null,
    ninePatch: false,
    modulate: null,
    selfModulate: null,
    fillColor: null,
    range: null,
    text: null,
    intentFrames: null,
    canvasBlendMode: undefined,
    ...over
  } as MirrorNode;
}

function numberParam(name: string, value: number) {
  return {
    name,
    kind: "number",
    number: value,
    bool: null,
    string: null,
    color: null,
    vector2: null,
    resourcePath: null,
    vector3: null,
    vector4: null,
    rect2: null,
    transform2d: null,
    numberArray: null
  };
}

function shaderNode(over: Partial<MirrorNode> = {}): MirrorNode {
  return baseNode({
    shaderId: "res://shaders/screen_vfx.gdshader",
    shaderParams: [numberParam("strength", 0.5)],
    ...over
  });
}

// A DEEP COPY of a node — the reconciler hands the walk a brand-new object for a node that changed in ANY field,
// and a pooled shell is re-instantiated wholesale, so this is what L2 has to see through.
function rebuilt(node: MirrorNode): MirrorNode {
  return JSON.parse(JSON.stringify(node)) as MirrorNode;
}

describe("shader binding memo — L2 (content-keyed)", () => {
  it("hits on a REBUILT but identical node (L1 would miss)", () => {
    const a = shaderNode();
    const first = nodeShaderAttributes(a);
    expect(first).not.toBeNull();

    // A distinct object: L1 (WeakMap on the node object) cannot possibly hit.
    const second = nodeShaderAttributes(rebuilt(a));
    expect(second).toBe(first); // same binding INSTANCE ⇒ served from L2, nothing recomputed
  });

  it("survives resetShaderDocCache (a full walk must not throw the content memo away)", () => {
    const a = shaderNode();
    const first = nodeShaderAttributes(a);
    resetShaderDocCache();
    expect(nodeShaderAttributes(rebuilt(a))).toBe(first);
  });

  it("misses on every input that can change the output", () => {
    const base = shaderNode();
    const first = nodeShaderAttributes(base)!;
    const differs = (over: Partial<MirrorNode>): void => {
      const other = nodeShaderAttributes(shaderNode(over));
      expect(other).not.toBe(first);
    };
    differs({ shaderId: "res://shaders/other.gdshader" });
    differs({ shaderParams: [numberParam("strength", 0.6)] });
    differs({ shaderParams: [numberParam("other", 0.5)] });
    differs({ shaderParams: null });
    differs({ modulate: { r: 1, g: 0, b: 0, a: 1, html: "#ff0000" } });
    differs({ selfModulate: { r: 1, g: 0, b: 0, a: 0.5, html: "#ff0000" } });
    differs({ textureUrl: "/res/images/other.png" });
    differs({ textureUrl: null, fillColor: { r: 0, g: 0, b: 0, a: 1, html: "#000000" } });
    differs({ textureRegion: { x: 0, y: 0, width: 8, height: 8 } });
    differs({ textureStretchMode: 5 });
    differs({ particleSpec: { texture: null } as never });
  });

  it("keys the HSV ancestor skip so a stable node under a CHANGED ancestor cannot reuse a stale answer", () => {
    const hsv = (id: string, parentId: string | null): MirrorNode =>
      baseNode({
        id,
        parentId,
        shaderId: "res://shaders/hsv.gdshader",
        shaderParams: [numberParam("h", 0.5), numberParam("s", 1), numberParam("v", 1)]
      });
    const plainParent = baseNode({ id: "p", nodeType: "Control" });
    const energyParent = baseNode({ id: "p", nodeType: "MegaCrit.Sts2.Core.Nodes.Combat.NEnergyCounter" });
    const child = hsv("c", "p");

    const underPlain = nodeShaderAttributes(child, new Map([["p", plainParent]]));
    // Same node CONTENT, different ancestry: the NEnergyCounter skip must apply (null), not the cached filter.
    const underEnergy = nodeShaderAttributes(rebuilt(child), new Map([["p", energyParent]]));
    expect(underPlain?.style.filter).toMatch(/^url\(#mhsv-\d+\)$/);
    expect(underEnergy).toBeNull();
  });

});

describe("card-ripple dormancy", () => {
  const ripple = (width: number): MirrorNode =>
    shaderNode({ shaderId: "res://shaders/card_ripple.gdshader", shaderParams: [numberParam("width", width)] });

  // Dormancy is a LIVE-path contract, so the block runs in a dynamic mode: in `off`/`static` a shown ripple has
  // no binding to park at all (bakedEffects.ts stands a committed still in for it).
  let savedShaderMode: EffectMode;
  beforeEach(() => {
    savedShaderMode = mirrorSettings.shaderMode;
    mirrorSettings.shaderMode = "dynamic";
  });
  afterEach(() => {
    mirrorSettings.shaderMode = savedShaderMode;
  });

  it("keeps the full attribute set and adds the dormant marker at rest", () => {
    const off = nodeShaderAttributes(ripple(0))!;
    const on = nodeShaderAttributes(ripple(0.075))!;
    expect(off.attributes["data-godot-shader-webgl"]).toBe("1");
    expect(off.attributes["data-godot-shader-path"]).toBe(on.attributes["data-godot-shader-path"]);
    expect(off.attributes[SHADER_DORMANT_ATTR]).toBe("1");
    // Waking is exactly the ABSENCE of the marker — gsw's syncDormant then unhides + re-renders the kept binding.
    expect(on.attributes[SHADER_DORMANT_ATTR]).toBeUndefined();
  });

  it("keeps the marker out of the key-equal answer for a non-ripple shader", () => {
    expect(nodeShaderAttributes(shaderNode())!.attributes[SHADER_DORMANT_ATTR]).toBeUndefined();
  });

  // THE CACHE TRAP, pinned. The L2 memo is keyed on CONTENT, and the effect mode is not on the node — it was
  // keyed on the quality tier's `shadersEnabled`, which does not move when the settings panel does. So the moment
  // the binding builder started consulting the mode (a covered ripple returns NO binding), a viewer flipping
  // Static → Dynamic would have been served the cached `null` for the rest of the session and their shaders would
  // never have come back. The node content is IDENTICAL across the flip here — that is the whole point.
  it("re-answers when the effect mode moves, for identical node content", () => {
    const shown = ripple(0.075);

    mirrorSettings.shaderMode = "static";
    expect(nodeShaderAttributes(shown)).toBeNull(); // the baked still owns it

    mirrorSettings.shaderMode = "dynamic";
    const live = nodeShaderAttributes(rebuilt(shown));
    expect(live?.attributes["data-godot-shader-webgl"]).toBe("1");

    // …and back, so the entry the flip created cannot shadow the still either.
    mirrorSettings.shaderMode = "static";
    expect(nodeShaderAttributes(rebuilt(shown))).toBeNull();
  });
});

describe("particle binding memo", () => {
  const particleNode = (over: Partial<MirrorNode> = {}): MirrorNode =>
    baseNode({ particleSpec: { texture: null, amount: 4 } as never, ...over });

  it("returns the SAME binding object for repeat calls on one spec", () => {
    const n = particleNode();
    const first = nodeParticleAttributes(n)!;
    expect(nodeParticleAttributes(n)).toBe(first);
  });

  it("re-stringifies when the emitting flag or the restart epoch moves", () => {
    const spec = { texture: null, amount: 4 } as never;
    const a = particleNode({ particleSpec: spec });
    const first = nodeParticleAttributes(a)!;
    const b = particleNode({ particleSpec: spec, particleEmitting: true });
    const second = nodeParticleAttributes(b)!;
    expect(second).not.toBe(first);
    expect(second.specsJson).not.toBe(first.specsJson);
    const c = particleNode({ particleSpec: spec, particleEmitting: true, particleRestartEpoch: 3 });
    expect(nodeParticleAttributes(c)!.specsJson).not.toBe(second.specsJson);
  });

});

// --- renderer-side memos + reflow batching -------------------------------------------------------------------

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function wireNode(id: string, parentId: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Control",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 200, y: 100 } },
    visible: true,
    ...over
  };
}

function full(state: MirrorState, nodes: Record<string, unknown>[], order: string[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: nodes, orderedIds: order })!
  );
}
function volatileDelta(state: MirrorState, nodes: Record<string, unknown>[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: nodes })!);
}

describe("nine-patch slice diffing", () => {
  // A nine-patch over an ATLAS page renders as nine <span> slices; each re-style used to re-assign every
  // declaration of all nine.
  function npNode(modA: number): Record<string, unknown> {
    return wireNode("np", null, {
      nodeType: "NinePatchRect",
      texture: { resourcePath: "res://images/atlas.png", resourceType: "Texture2D" },
      textureRegion: { position: { x: 0, y: 0 }, size: { x: 64, y: 64 } },
      ninePatch: true,
      ninePatchMargins: { left: 8, top: 8, right: 8, bottom: 8 },
      modulate: { r: 1, g: 1, b: 1, a: modA, html: "#ffffff" }
    });
  }

  function sliceWrites(_sliceDiff: boolean): number {
    (textureCache as unknown as { __setSize: (u: string, w: number, h: number) => void }).__setSize(
      "/res/images/atlas.png",
      512,
      512
    );
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [npNode(1)], ["np"]);
    renderer.reconcile(state);
    const slices = [...stage.querySelectorAll<HTMLElement>(".mirror-np-slice")];
    expect(slices.length).toBeGreaterThan(0);
    // Count style writes from here on: only a modulate change arrives, which moves NO slice geometry.
    let writes = 0;
    for (const slice of slices) {
      const proto = slice.style;
      const orig = proto.setProperty.bind(proto);
      slice.style.setProperty = (...a: Parameters<CSSStyleDeclaration["setProperty"]>) => {
        writes++;
        return orig(...a);
      };
      for (const key of ["backgroundImage", "backgroundPosition", "backgroundSize", "left", "top", "width", "height"]) {
        let v = (slice.style as unknown as Record<string, string>)[key];
        Object.defineProperty(slice.style, key, {
          configurable: true,
          get: () => v,
          set: (next: string) => {
            writes++;
            v = next;
          }
        });
      }
    }
    volatileDelta(state, [npNode(0.5)]);
    renderer.reconcile(state);
    renderer.dispose();
    return writes;
  }

  it("writes nothing for the unchanged slices of a re-styled 9-patch", () => {
    expect(sliceWrites(true)).toBe(0);
  });

});

describe("phase-anchor application", () => {
  // A producer-pinned loop anchors its animation's startTime via getAnimations() before reconcile() returns.
  function pulseState(): MirrorState {
    const state = createMirrorState();
    full(
      state,
      [
        wireNode("pt", null, {
          nodeType: "MegaCrit.Sts2.Core.Nodes.Map.NNormalMapPoint",
          localRect: { position: { x: 0, y: 0 }, size: { x: 56, y: 56 } },
          pinnedLoopAnim: "mapPointPulse"
        })
      ],
      ["pt"]
    );
    return state;
  }

  function anchorTrace(): { calls: number[]; starts: number[] } {
    const calls: number[] = [];
    const starts: number[] = [];
    let writes = 0;
    // Count element style writes so we can tell WHERE in the reconcile getAnimations() happened.
    const proto = HTMLElement.prototype as unknown as { setAttribute: HTMLElement["setAttribute"] };
    const origSetAttribute = proto.setAttribute;
    proto.setAttribute = function (this: HTMLElement, ...a: [string, string]) {
      writes++;
      return origSetAttribute.apply(this, a);
    };
    const origGetAnimations = (HTMLElement.prototype as unknown as { getAnimations?: unknown }).getAnimations;
    (HTMLElement.prototype as unknown as { getAnimations: () => Animation[] }).getAnimations = function () {
      calls.push(writes);
      const fake = { set startTime(v: number) { starts.push(v); }, get startTime() { return 0; } } as unknown as Animation;
      return [fake];
    };
    try {
      const { renderer } = harness();
      const state = pulseState();
      renderer.reconcile(state);
      renderer.dispose();
    } finally {
      proto.setAttribute = origSetAttribute;
      if (origGetAnimations === undefined) {
        delete (HTMLElement.prototype as unknown as { getAnimations?: unknown }).getAnimations;
      } else {
        (HTMLElement.prototype as unknown as { getAnimations?: unknown }).getAnimations = origGetAnimations;
      }
    }
    return { calls, starts };
  }

  it("drains the queue within the same reconcile (nothing is left un-anchored)", () => {
    const { starts } = anchorTrace();
    expect(starts.length).toBeGreaterThan(0);
  });
});
