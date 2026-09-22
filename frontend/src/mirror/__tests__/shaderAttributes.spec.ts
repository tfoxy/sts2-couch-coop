import { afterEach, describe, expect, it } from "vitest";

import { SHADER_DORMANT_ATTR } from "@godot-scene-web/html";

import {
  isShaderInputNode,
  isWebglShaderNode,
  nodeShaderAttributes,
  stretchModeToBackgroundSize
} from "@/mirror/shaderAttributes";
import { __setRenderQualityForTest, type RenderQuality } from "@/render/quality";
import type { MirrorNode, MirrorShaderParam } from "@/mirror/sceneTree";

function shaderNode(over: Partial<MirrorNode> = {}): MirrorNode {
  return {
    id: "n",
    parentId: null,
    name: "Card",
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
    textWrap: null,
    shadow: null,
    richText: false,
    shaderId: "res://shaders/card_ripple.gdshader",
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
    transform: [1, 0, 0, 1, 0, 0],
    localRect: { x: 0, y: 0, width: 200, height: 280 },
    visible: true,
    focused: false,
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
    outline: null,
    ...over
  };
}

const numberParam = (name: string, n: number): MirrorShaderParam => ({
  name,
  kind: "number",
  number: n,
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
});

describe("nodeShaderAttributes", () => {
  it("returns null for a node with no shader", () => {
    expect(nodeShaderAttributes(shaderNode({ shaderId: null }))).toBeNull();
  });

  it("stamps WebGL attributes for a non-HSV shader (inline material, params from the delta)", () => {
    const binding = nodeShaderAttributes(shaderNode({ shaderParams: [numberParam("strength", 0.5)] }));
    expect(binding).not.toBeNull();
    expect(binding?.attributes["data-godot-shader-webgl"]).toBe("1");
    expect(binding?.attributes["data-godot-shader-path"]).toBe("res://shaders/card_ripple.gdshader");
    // The streamed uniform is forwarded to the runtime.
    expect(binding?.attributes["data-godot-shader-params"]).toContain("strength");
    // Not an HSV node → no color-matrix filter.
    expect(binding?.style.filter).toBeUndefined();
  });

  it("maps a KEEP_ASPECT_CENTERED texture (card_ripple Highlight) to a 'contain' self-layer fit", () => {
    // stretch_mode 5 = KeepAspectCentered → contain, so the SDF isn't fill-stretched across the oversized box.
    const binding = nodeShaderAttributes(shaderNode({ textureStretchMode: 5 }));
    expect(binding?.selfLayerFit).toBe("contain");
  });

  it("keeps 'fill' for a textureless fill-color base (a 1×1 solid must cover the node, not letterbox)", () => {
    const binding = nodeShaderAttributes(
      shaderNode({
        shaderId: "res://shaders/texture_transition.gdshader",
        textureUrl: null,
        fillColor: { r: 0, g: 0, b: 0, a: 1, html: "#000000ff" },
        textureStretchMode: null
      })
    );
    expect(binding?.selfLayerFit).toBe("fill");
  });

  describe("stretchModeToBackgroundSize", () => {
    it("maps Godot StretchMode enum values to gsw fits", () => {
      expect(stretchModeToBackgroundSize(0)).toBe("fill"); // Scale
      expect(stretchModeToBackgroundSize(1)).toBe("fill"); // Tile
      expect(stretchModeToBackgroundSize(4)).toBe("contain"); // KeepAspect
      expect(stretchModeToBackgroundSize(5)).toBe("contain"); // KeepAspectCentered
      expect(stretchModeToBackgroundSize(6)).toBe("cover"); // KeepAspectCovered
      expect(stretchModeToBackgroundSize(null)).toBe("fill"); // unknown / non-TextureRect
    });
  });

  it("renders a textureless transition over a solid base built from its fill color (not white)", () => {
    const binding = nodeShaderAttributes(
      shaderNode({
        nodeType: "NTransition",
        shaderId: "res://shaders/texture_transition.gdshader",
        textureUrl: null,
        fillColor: { r: 0, g: 0, b: 0, a: 1, html: "#000000ff" },
        shaderParams: [numberParam("alpha", 1)]
      })
    );
    expect(binding?.attributes["data-godot-shader-webgl"]).toBe("1");
    // Base is a 1×1 solid of the (black) fill color — so a COLOR.a-only shader isn't white.
    expect(binding?.textureUrl).toMatch(/^data:image\/svg\+xml,/);
    expect(decodeURIComponent(binding?.textureUrl ?? "")).toContain("rgba(0,0,0,1)");
  });

  it("skips a shader node with neither a texture nor a fill (no usable base)", () => {
    const binding = nodeShaderAttributes(
      shaderNode({ shaderId: "res://shaders/screen_vfx.gdshader", textureUrl: null, fillColor: null })
    );
    expect(binding).toBeNull();
  });

  it("skips an atlas-sprite shader (region set) to avoid sampling the whole atlas page", () => {
    const binding = nodeShaderAttributes(
      shaderNode({
        shaderId: "res://shaders/relic.gdshader",
        textureUrl: "/res/images/relic_atlas.png",
        textureRegion: { x: 0, y: 0, width: 60, height: 60 }
      })
    );
    expect(binding).toBeNull();
  });

  describe("isWebglShaderNode", () => {
    it("is true for a non-HSV, non-atlas shader node with a base texture", () => {
      expect(isWebglShaderNode(shaderNode())).toBe(true);
    });

    it("is true for a textureless shader node with a fill color (transition over a fill)", () => {
      expect(
        isWebglShaderNode(
          shaderNode({ textureUrl: null, fillColor: { r: 0, g: 0, b: 0, a: 1, html: "#000000ff" } })
        )
      ).toBe(true);
    });

    it("is false with no shader", () => {
      expect(isWebglShaderNode(shaderNode({ shaderId: null }))).toBe(false);
    });

    it("is false for an HSV-adjust shader (rendered via feColorMatrix, not the canvas)", () => {
      expect(isWebglShaderNode(shaderNode({ shaderId: "res://shaders/hsv.gdshader" }))).toBe(false);
    });

    it("is false with neither a texture nor a fill (no base to sample)", () => {
      expect(isWebglShaderNode(shaderNode({ textureUrl: null, fillColor: null }))).toBe(false);
    });

    it("is false for an atlas-region shader (CSS crop is the fallback)", () => {
      expect(isWebglShaderNode(shaderNode({ textureRegion: { x: 0, y: 0, width: 60, height: 60 } }))).toBe(false);
    });

    it("is false for a particle node even though it carries a ShaderMaterial (particle path wins)", () => {
      // A GpuParticles2D's Material IS a ShaderMaterial, so the shader probe also fires — but a node with a
      // particleSpec must render via the particle runtime, not the shader self-layer.
      expect(
        isWebglShaderNode(
          shaderNode({
            nodeType: "GPUParticles2D",
            particleSpec: { kind: "GPUParticles2D" } as MirrorNode["particleSpec"]
          })
        )
      ).toBe(false);
    });
  });

  it("renders an HSV-adjust shader via a feColorMatrix filter, NOT WebGL", () => {
    const binding = nodeShaderAttributes(
      shaderNode({
        shaderId: "res://shaders/hsv.gdshader",
        // Non-identity h/s/v so the matrix isn't collapsed to identity.
        shaderParams: [numberParam("h", 0.5), numberParam("s", 1), numberParam("v", 1)]
      })
    );
    expect(binding).not.toBeNull();
    expect(binding?.attributes["data-godot-shader-webgl"]).toBeUndefined();
    expect(binding?.style.filter).toMatch(/^url\(#mhsv-\d+\)$/);
  });

  describe("card_ripple width gate", () => {
    // A non-playable card (reward/deck/etc.) streams width 0 — the game's HIDDEN ripple. R10-B3: instead of
    // dropping the binding (which made gsw dispose it, so the next playability flip rebuilt it + paid a
    // syncCanvasSize forced layout), the node keeps its full attribute set and is marked DORMANT — gsw parks the
    // binding with its canvas hidden, so the degenerate-smoothstep sliver still never shows.
    it("marks the WebGL ripple dormant when card_ripple width ≈ 0", () => {
      const binding = nodeShaderAttributes(shaderNode({ shaderParams: [numberParam("width", 0)] }));
      expect(binding?.attributes["data-godot-shader-webgl"]).toBe("1");
      expect(binding?.attributes[SHADER_DORMANT_ATTR]).toBe("1");
    });

    // A playable card / reward-screen flash tweens width up to ~0.075 — the full ripple renders on WebGL.
    it("renders the WebGL ripple when card_ripple width is non-zero", () => {
      const binding = nodeShaderAttributes(shaderNode({ shaderParams: [numberParam("width", 0.075)] }));
      expect(binding?.attributes["data-godot-shader-webgl"]).toBe("1");
    });

    // No `width` streamed (shaderParams absent) → fall through to WebGL, never hide a ripple we can't measure.
    it("does not suppress when width is not streamed", () => {
      const binding = nodeShaderAttributes(shaderNode({ shaderParams: null }));
      expect(binding?.attributes["data-godot-shader-webgl"]).toBe("1");
    });

    // The gate is card_ripple-specific: another shader with a width-0 uniform still renders on WebGL.
    it("does not gate a non-card_ripple shader with a zero `width` uniform", () => {
      const binding = nodeShaderAttributes(
        shaderNode({ shaderId: "res://shaders/screen_vfx.gdshader", shaderParams: [numberParam("width", 0)] })
      );
      expect(binding?.attributes["data-godot-shader-webgl"]).toBe("1");
    });
  });

  // AUG-14 never-drawn surfaces. `Game/GameTransitionRect` is the biggest node in the fleet (2560×1200 design px,
  // full-bleed) and it is invisible unless a screen change is fading: every transition shader resolves the
  // fragment alpha from `threshold` alone, so at 0 it paints nothing. Across all 37 recorded mirror sessions in
  // `.sts2/bench` the node appears in every one, is upserted exactly once, and its `threshold` is 0 in every
  // upsert — so this is the steady state, not an edge case.
  describe("screen-transition threshold gate", () => {
    const transitionNode = (over: Partial<MirrorNode> = {}): MirrorNode =>
      shaderNode({
        nodeType: "MegaCrit.Sts2.Core.Nodes.NTransition",
        name: "GameTransitionRect",
        shaderId: "res://shaders/fade_transition.gdshader",
        textureUrl: null,
        fillColor: { r: 0, g: 0, b: 0, a: 1, html: "#000000ff" },
        localRect: { x: 0, y: 0, width: 2560, height: 1200 },
        ...over
      });

    it("marks the transition overlay dormant when threshold ≈ 0", () => {
      const binding = nodeShaderAttributes(transitionNode({ shaderParams: [numberParam("threshold", 0)] }));
      // Still a full shader node — gsw PARKS the binding (canvas hidden, syncCanvasSize deferred) rather than
      // disposing it, so the wake is one attribute and the node's raw paint stays suppressed either way.
      expect(binding?.attributes["data-godot-shader-webgl"]).toBe("1");
      expect(binding?.attributes[SHADER_DORMANT_ATTR]).toBe("1");
    });

    it("covers the per-character transition materials (embedded .tres sub-resource shaders)", () => {
      // The gate is keyed on the NODE TYPE, not the shader id — the id is a per-character sub-resource
      // (`Shader_spnx5`, `Shader_2greq`, …), and every one of those bodies is `COLOR.a = step(…, mix(-0.1, …))`,
      // i.e. 0 at threshold 0.
      const binding = nodeShaderAttributes(
        transitionNode({
          shaderId: "res://materials/transitions/ironclad_transition_mat.tres::Shader_spnx5",
          shaderParams: [numberParam("threshold", 0)]
        })
      );
      expect(binding?.attributes[SHADER_DORMANT_ATTR]).toBe("1");
    });

    it("wakes the overlay the moment a transition starts (threshold > 0)", () => {
      const binding = nodeShaderAttributes(transitionNode({ shaderParams: [numberParam("threshold", 0.332)] }));
      expect(binding?.attributes["data-godot-shader-webgl"]).toBe("1");
      expect(binding?.attributes[SHADER_DORMANT_ATTR]).toBeUndefined();
    });

    it("does not park a transition whose threshold is not streamed", () => {
      const binding = nodeShaderAttributes(transitionNode({ shaderParams: null }));
      expect(binding?.attributes[SHADER_DORMANT_ATTR]).toBeUndefined();
    });

    it("does not park another node type that happens to carry a zero `threshold` uniform", () => {
      const binding = nodeShaderAttributes(
        shaderNode({
          shaderId: "res://shaders/screen_vfx.gdshader",
          shaderParams: [numberParam("threshold", 0)]
        })
      );
      expect(binding?.attributes["data-godot-shader-webgl"]).toBe("1");
      expect(binding?.attributes[SHADER_DORMANT_ATTR]).toBeUndefined();
    });

    // The L2 content memo keys on the binding's real inputs; the transition gate reads `nodeType`, which nothing
    // else in the key covered. Without it a transition node and a same-shader/same-params node of another type
    // would share one cached binding.
    it("does not leak a parked binding to a same-shader node of another type through the content memo", () => {
      const params = [numberParam("threshold", 0)];
      // Freshly-built node objects each time, so only the CONTENT key can produce a hit.
      expect(
        nodeShaderAttributes(transitionNode({ shaderParams: params.map((p) => ({ ...p })) }))?.attributes[
          SHADER_DORMANT_ATTR
        ]
      ).toBe("1");
      expect(
        nodeShaderAttributes(
          transitionNode({
            nodeType: "Godot.ColorRect",
            shaderParams: params.map((p) => ({ ...p }))
          })
        )?.attributes[SHADER_DORMANT_ATTR]
      ).toBeUndefined();
    });
  });

  // AUG-14 never-drawn surfaces, part 2. `Run/GlobalUi/vfx_low_hp_border` is a 2048×922 full-screen shader
  // surface that renders `meanAlpha 0` across the recorded benches while streaming `alpha_multiplier 0.0025295`.
  //
  // The bound is PROVEN, not sampled: the vignette shader's final alpha is a smoothstep (∈ [0,1] for every input)
  // scaled by `clamp(alpha_multiplier, 0, 1)` and then modulated, so max fragment alpha ≤ the streamed multiplier
  // for EVERY value of every other uniform. The canvas is 8-bit, so below 1/255 that upper bound quantizes to zero.
  //
  // The node is NOT dead: on screen the vignette runs from all-but-invisible up to full strength as the player is
  // hurt, and the multiplier is streamed the whole way. Every case below therefore also pins the WAKE.
  describe("low-HP vignette alpha_multiplier gate", () => {
    const LOW_HP_TYPE = "MegaCrit.Sts2.Core.Nodes.Vfx.Ui.NLowHpBorderVfx";
    // 1/255: the smallest alpha an 8-bit destination can represent.
    const EIGHT_BIT_STEP = 1 / 255;

    const lowHpNode = (over: Partial<MirrorNode> = {}): MirrorNode =>
      shaderNode({
        nodeType: LOW_HP_TYPE,
        name: "vfx_low_hp_border",
        shaderId: "res://shaders/vfx/ui/vfx_ui_low_hp_border_shader.gdshader",
        textureUrl: null,
        // Wire-shaped: the recorded node is a ColorRect with a white fill and self_modulate #ffffffc0.
        fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffffff" },
        selfModulate: { r: 1, g: 1, b: 1, a: 0.7529412, html: "#ffffffc0" },
        localRect: { x: 0, y: 0, width: 1920, height: 1080 },
        ...over
      });

    it("parks the vignette at the recorded resting multiplier (0.0025295)", () => {
      const binding = nodeShaderAttributes(
        lowHpNode({ shaderParams: [numberParam("alpha_multiplier", 0.0025295019149780273)] })
      );
      // Still a full shader node — gsw PARKS the binding (canvas hidden, syncCanvasSize deferred) rather than
      // disposing it, so the wake is the removal of one attribute.
      expect(binding?.attributes["data-godot-shader-webgl"]).toBe("1");
      expect(binding?.attributes[SHADER_DORMANT_ATTR]).toBe("1");
    });

    // THE WAKE. The curve's other endpoint is 1.0, and everything in between must render: a purely value-driven
    // gate is what makes the vignette reappear the instant the player is hurt.
    it.each([EIGHT_BIT_STEP, 0.005, 0.05, 0.5, 1])("wakes at alpha_multiplier %p", (multiplier) => {
      const binding = nodeShaderAttributes(
        lowHpNode({ shaderParams: [numberParam("alpha_multiplier", multiplier)] })
      );
      expect(binding?.attributes["data-godot-shader-webgl"]).toBe("1");
      expect(binding?.attributes[SHADER_DORMANT_ATTR]).toBeUndefined();
    });

    // REGRESSION PIN on the epsilon itself. The neighbouring ripple/transition gates use `< 0.005`, which is
    // 1.275/255 — ABOVE the provable bound, so reusing it here would park a surface that can still set a bit.
    // 1/255 is the boundary and the comparison is strict, so exactly 1/255 must stay live (asserted above) while
    // one ULP below it parks.
    it("uses the 8-bit floor, not the ripple/transition 0.005 heuristic", () => {
      const justUnder = nodeShaderAttributes(
        lowHpNode({ shaderParams: [numberParam("alpha_multiplier", EIGHT_BIT_STEP * (1 - Number.EPSILON))] })
      );
      expect(justUnder?.attributes[SHADER_DORMANT_ATTR]).toBe("1");
      const rippleEpsilon = nodeShaderAttributes(
        lowHpNode({ shaderParams: [numberParam("alpha_multiplier", 0.005)] })
      );
      expect(rippleEpsilon?.attributes[SHADER_DORMANT_ATTR]).toBeUndefined();
    });

    it("does not park a vignette whose alpha_multiplier is not streamed", () => {
      expect(
        nodeShaderAttributes(lowHpNode({ shaderParams: null }))?.attributes[SHADER_DORMANT_ATTR]
      ).toBeUndefined();
      // …nor one whose OTHER uniforms are streamed but the multiplier is absent.
      expect(
        nodeShaderAttributes(lowHpNode({ shaderParams: [numberParam("alpha", 1)] }))?.attributes[
          SHADER_DORMANT_ATTR
        ]
      ).toBeUndefined();
    });

    // Only THIS shader is proven to be bounded above by its `alpha_multiplier`; another shader exposing a uniform
    // of the same name proves nothing, so the node type is part of the gate.
    it("does not park another node type carrying a tiny `alpha_multiplier`", () => {
      const binding = nodeShaderAttributes(
        shaderNode({
          shaderId: "res://shaders/screen_vfx.gdshader",
          shaderParams: [numberParam("alpha_multiplier", 0)]
        })
      );
      expect(binding?.attributes["data-godot-shader-webgl"]).toBe("1");
      expect(binding?.attributes[SHADER_DORMANT_ATTR]).toBeUndefined();
    });

    // Explicitly NOT keyed on `main_color` / `smoothstep_factors`: neither bounds the output (a zero main_color
    // still writes alpha, and smoothstep_factors only reshape the ramp), so neither may park the node on its own.
    it("ignores main_color / smoothstep_factors — only the multiplier bounds the output", () => {
      const binding = nodeShaderAttributes(
        lowHpNode({
          shaderParams: [
            numberParam("alpha_multiplier", 1),
            {
              ...numberParam("main_color", 0),
              kind: "color",
              number: null,
              color: { r: 0, g: 0, b: 0, a: 0, html: "#00000000" }
            },
            {
              ...numberParam("smoothstep_factors", 0),
              kind: "vector2",
              number: null,
              vector2: { x: 0, y: 0 }
            }
          ]
        })
      );
      expect(binding?.attributes[SHADER_DORMANT_ATTR]).toBeUndefined();
    });

    // The L2 content memo keys on the binding's real inputs; this gate reads `nodeType`, which the key only
    // covered as "is this the TRANSITION overlay". Without its own bit, a parked vignette and a same-shader,
    // same-params node of another type would share one cached binding.
    it("does not leak a parked binding to a same-shader node of another type through the content memo", () => {
      const params = () => [numberParam("alpha_multiplier", 0.0025295)];
      // Freshly-built node objects each time, so only the CONTENT key can produce a hit.
      expect(nodeShaderAttributes(lowHpNode({ shaderParams: params() }))?.attributes[SHADER_DORMANT_ATTR]).toBe(
        "1"
      );
      expect(
        nodeShaderAttributes(lowHpNode({ nodeType: "Godot.ColorRect", shaderParams: params() }))?.attributes[
          SHADER_DORMANT_ATTR
        ]
      ).toBeUndefined();
    });

    // The WAKE through the memo: the reconciler hands the styler a FRESH node object whenever a uniform moves, so
    // the wake has to survive both cache layers. `alpha_multiplier` is part of the content key via `params`.
    it("wakes through the L1/L2 memos when the streamed multiplier rises", () => {
      const resting = lowHpNode({ shaderParams: [numberParam("alpha_multiplier", 0.0025295)] });
      expect(nodeShaderAttributes(resting)?.attributes[SHADER_DORMANT_ATTR]).toBe("1");
      // Same node object again → the L1 WeakMap hit must still report dormant.
      expect(nodeShaderAttributes(resting)?.attributes[SHADER_DORMANT_ATTR]).toBe("1");
      // A fresh object with a risen multiplier (the player took a hit) → awake.
      const hurt = lowHpNode({ shaderParams: [numberParam("alpha_multiplier", 0.42)] });
      expect(nodeShaderAttributes(hurt)?.attributes[SHADER_DORMANT_ATTR]).toBeUndefined();
      // …and back down again re-parks it (the curve runs both ways as HP is restored).
      const healed = lowHpNode({ shaderParams: [numberParam("alpha_multiplier", 0.0025295)] });
      expect(nodeShaderAttributes(healed)?.attributes[SHADER_DORMANT_ATTR]).toBe("1");
    });
  });
});

describe("nodeShaderAttributes — shaders off (true floor)", () => {
  const OFF: RenderQuality = {
    tier: "minimum",
    shadersEnabled: false,
    shadersStatic: false,
    particlesEnabled: false,
    spineClipsEnabled: false,
    spineClipFps: 0,
    renderScale: 1,
    shaderFps: 0,
    particleFps: 0,
    maxTextureDim: 2048,
    maxTrailPoints: 0,
    staticShaderScale: 1,
    staticParticleScale: 1,
    source: "query"
  };

  afterEach(() => __setRenderQualityForTest(undefined));

  it("returns no shader binding for any shader node (no WebGL canvas, no per-shader CSS hack)", () => {
    __setRenderQualityForTest(OFF);
    // The card glow node (card_ripple) no longer synthesizes a bespoke CSS halo — its raw paint is suppressed
    // generically by nodeStyles (isShaderInputNode), and the normal low-end path is the `very-low` tier instead.
    expect(nodeShaderAttributes(shaderNode({ shaderParams: [numberParam("width", 4)] }))).toBeNull();
    expect(nodeShaderAttributes(shaderNode({ shaderId: "res://shaders/relic.gdshader" }))).toBeNull();
  });

  it("uses the real WebGL self-layer (data-godot-shader-webgl) when shaders are ON", () => {
    const binding = nodeShaderAttributes(shaderNode({ shaderParams: [numberParam("width", 4)] }));
    expect(binding?.attributes["data-godot-shader-webgl"]).toBe("1");
    expect(binding?.style.boxShadow).toBeUndefined();
  });
});

describe("isShaderInputNode", () => {
  // True for nodes whose painted texture is shader INPUT (suppressed as a raw blob when shaders are off) —
  // exactly the WebGL-eligible nodes, but evaluated REGARDLESS of the quality tier.
  it("is true for a shader node with a base texture (e.g. card_ripple's SDF)", () => {
    expect(isShaderInputNode(shaderNode())).toBe(true);
  });

  it("is false for a non-shader node, an HSV node, an atlas-region node, and a particle node", () => {
    expect(isShaderInputNode(shaderNode({ shaderId: null }))).toBe(false);
    expect(isShaderInputNode(shaderNode({ shaderId: "res://shaders/hsv.gdshader" }))).toBe(false);
    expect(isShaderInputNode(shaderNode({ textureRegion: { x: 0, y: 0, width: 60, height: 60 } }))).toBe(false);
    expect(
      isShaderInputNode(
        shaderNode({
          nodeType: "GPUParticles2D",
          particleSpec: { kind: "GPUParticles2D" } as MirrorNode["particleSpec"]
        })
      )
    ).toBe(false);
  });

  it("does not depend on the quality tier (true whether shaders are on or off)", () => {
    const node = shaderNode();
    __setRenderQualityForTest({
      tier: "minimum",
      shadersEnabled: false,
      shadersStatic: false,
      particlesEnabled: false,
      spineClipsEnabled: false,
      spineClipFps: 0,
      renderScale: 1,
      shaderFps: 0,
      particleFps: 0,
      maxTextureDim: 2048,
      maxTrailPoints: 0,
      staticShaderScale: 1,
      staticParticleScale: 1,
      source: "query"
    });
    expect(isShaderInputNode(node)).toBe(true);
    __setRenderQualityForTest(undefined);
    expect(isShaderInputNode(node)).toBe(true);
  });
});
