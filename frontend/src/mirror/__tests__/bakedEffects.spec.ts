import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bakedStillCoversNode,
  bakedStillFor,
  bakedStillNeedsOwnLayer,
  CARD_RIPPLE_SHOWN_WIDTH
} from "@/mirror/bakedEffects";
import { mirrorSettings, EFFECT_MODES, type EffectMode } from "@/mirror/mirrorSettings";
import { CARD_RIPPLE_SHADER_IDS, setStageOwnsEffectPixels } from "@/mirror/shaderResources";
import type { MirrorNode, MirrorShaderParam } from "@/mirror/sceneTree";

// The two glow emitters, spelled exactly as the producer streams them (confirmed against a recorded mirror
// session, `.sts2/bench/audit-cardreward-open.ndjson`).
const UNCOMMON_GLOW = "MegaCrit.Sts2.Core.Nodes.Vfx.Cards.NCardUncommonGlow";
const RARE_GLOW = "MegaCrit.Sts2.Core.Nodes.Vfx.Cards.NCardRareGlow";

function mkNode(over: Partial<MirrorNode> = {}): MirrorNode {
  return { id: "n", nodeType: "Godot.Node2D", shaderId: null, shaderParams: null, particleSpec: null, ...over } as MirrorNode;
}

/** A card highlight whose ripple the game currently has tweened to `width`. */
function rippleNode(width: number | null): MirrorNode {
  const params: MirrorShaderParam[] =
    width === null ? [] : [{ name: "width", kind: "number", number: width } as MirrorShaderParam];
  return mkNode({
    nodeType: "MegaCrit.Sts2.Core.Nodes.Cards.NCardHighlight",
    shaderId: CARD_RIPPLE_SHADER_IDS[0],
    shaderParams: params
  });
}

function glowNode(nodeType: string): MirrorNode {
  return mkNode({ nodeType, particleSpec: { kind: "GPUParticles2D" } as MirrorNode["particleSpec"] });
}

let savedShaderMode: EffectMode;
let savedParticleMode: EffectMode;

beforeEach(() => {
  savedShaderMode = mirrorSettings.shaderMode;
  savedParticleMode = mirrorSettings.particleMode;
  mirrorSettings.shaderMode = "off";
  mirrorSettings.particleMode = "off";
});

afterEach(() => {
  mirrorSettings.shaderMode = savedShaderMode;
  mirrorSettings.particleMode = savedParticleMode;
  setStageOwnsEffectPixels(false);
});

/** The modes a still stands in for, and the modes that still render the real effect. */
const STILL_MODES: readonly EffectMode[] = ["off", "static"];
const LIVE_MODES = EFFECT_MODES.filter((mode) => !STILL_MODES.includes(mode));

describe("bakedStillFor — the card ripple", () => {
  it.each(STILL_MODES)("stands in for a SHOWN ripple while shaders are %s", (mode) => {
    mirrorSettings.shaderMode = mode;
    const still = bakedStillFor(rippleNode(CARD_RIPPLE_SHOWN_WIDTH));

    expect(still).not.toBeNull();
    expect(still!.url).toMatch(/card-ripple/);
    // Baked at the node's own localRect, so the element paints it across itself.
    expect(still!.box).toBe("localRect");
    // The shader declares `render_mode blend_add` and NOTHING streams that, so this paint has to carry the
    // additive blend itself — unlike the glows, whose material reaches the DOM as `canvasBlendMode`.
    expect(still!.additive).toBe(true);
    expect(still!.opacityScale).toBe(1);
  });

  it("paints NOTHING for a ripple the game has hidden", () => {
    // `width` 0 is NCardHighlight at rest — every unplayable card in the hand. Painting the still there would
    // light up the whole hand, which is the opposite of the cue.
    expect(bakedStillFor(rippleNode(0))).toBeNull();
  });

  it("paints NOTHING when the width uniform is not streamed at all", () => {
    // An effect we cannot measure is not invented. (The WebGL path makes the opposite call for the same node —
    // there an unmeasurable uniform must not wrongly HIDE a live effect.)
    expect(bakedStillFor(rippleNode(null))).toBeNull();
  });

  it("scales opacity with the tween so the glow fades in rather than popping", () => {
    // AnimShow/AnimHide tween `width` over 0.5 s, and a card's playability flips on every energy change.
    const half = bakedStillFor(rippleNode(CARD_RIPPLE_SHOWN_WIDTH / 2));
    expect(half!.opacityScale).toBeCloseTo(0.5, 5);
  });

  it("clamps the opacity scale through AnimFlash's overshoot", () => {
    // AnimFlash peaks at 0.15 — double the shown width — before settling back.
    expect(bakedStillFor(rippleNode(0.15))!.opacityScale).toBe(1);
  });

  it("paints nothing in any mode that still renders the real shader", () => {
    // The three DYNAMIC modes only. They exist to animate, and a still is not a cheaper animation — which is
    // exactly the line `static` crossed when it joined `off`.
    expect(LIVE_MODES).toEqual(["dynamic", "dynamic-half", "dynamic-quarter"]);
    for (const mode of LIVE_MODES) {
      mirrorSettings.shaderMode = mode;
      expect(bakedStillFor(rippleNode(CARD_RIPPLE_SHOWN_WIDTH))).toBeNull();
    }
  });

  it("ignores a shader node that is not the ripple", () => {
    mirrorSettings.shaderMode = "off";
    const other = mkNode({ shaderId: "res://shaders/hsv.gdshader", shaderParams: [] });
    expect(bakedStillFor(other)).toBeNull();
  });
});

describe("bakedStillFor — the rarity glows", () => {
  it.each(STILL_MODES)("stands in for each emitter while particles are %s", (mode) => {
    mirrorSettings.particleMode = mode;
    const uncommon = bakedStillFor(glowNode(UNCOMMON_GLOW));
    const rare = bakedStillFor(glowNode(RARE_GLOW));

    expect(uncommon!.url).toMatch(/glow-uncommon/);
    expect(rare!.url).toMatch(/glow-rare/);
    // A GPUParticles2D streams no localRect, so each still must state its own node-local box.
    expect(uncommon!.box).toEqual({ x: -256, y: -256, width: 512, height: 512 });
    expect(rare!.box).toEqual({ x: -384, y: -384, width: 768, height: 768 });
    // Centred on the emitter origin, which is what makes the placement one translate.
    for (const still of [uncommon!, rare!]) {
      const box = still.box as { x: number; y: number; width: number; height: number };
      expect(box.x).toBe(-box.width / 2);
      expect(box.y).toBe(-box.height / 2);
    }
  });

  it("does NOT ask for its own blend — the emitter's material already streams one", () => {
    // `canvas_item_material_additive_shared.tres` reaches the DOM as `canvasBlendMode: 1`, which nodeStyle maps
    // to plus-lighter. Asking again here would be the same blend claimed from two places.
    expect(bakedStillFor(glowNode(UNCOMMON_GLOW))!.additive).toBe(false);
    expect(bakedStillFor(glowNode(RARE_GLOW))!.additive).toBe(false);
  });

  it("bakes no modulate in, so the game's own fade stays the element's", () => {
    // Both glow scripts tween modulate:a 1.0 -> 0.9 on tree entry and the mirror streams that as opacity.
    expect(bakedStillFor(glowNode(UNCOMMON_GLOW))!.opacityScale).toBe(1);
  });

  it("paints nothing in any mode that still simulates particles", () => {
    for (const mode of LIVE_MODES) {
      mirrorSettings.particleMode = mode;
      expect(bakedStillFor(glowNode(UNCOMMON_GLOW))).toBeNull();
    }
  });

  it("ignores an unrelated particle emitter", () => {
    expect(bakedStillFor(glowNode("MegaCrit.Sts2.Core.Nodes.Vfx.NSomeOtherVfx"))).toBeNull();
  });

  it("does not answer for a glow node with no particle spec", () => {
    expect(bakedStillFor(mkNode({ nodeType: UNCOMMON_GLOW }))).toBeNull();
  });
});

describe("bakedStillFor — the families are independent", () => {
  it("shaders off does not enable the glow stills", () => {
    mirrorSettings.particleMode = "dynamic";
    expect(bakedStillFor(rippleNode(CARD_RIPPLE_SHOWN_WIDTH))).not.toBeNull();
    expect(bakedStillFor(glowNode(RARE_GLOW))).toBeNull();
  });

  it("particles off does not enable the ripple still", () => {
    mirrorSettings.shaderMode = "dynamic";
    expect(bakedStillFor(glowNode(RARE_GLOW))).not.toBeNull();
    expect(bakedStillFor(rippleNode(CARD_RIPPLE_SHOWN_WIDTH))).toBeNull();
  });

  it("answers null on one field read for an ordinary node", () => {
    expect(bakedStillFor(mkNode())).toBeNull();
  });
});

// THE PAIR THAT MUST NOT DRIFT. `bakedStillCoversNode` is what stops the live binding being built, and
// `bakedStillFor` is what paints instead. A node where the first is true and the second is null renders NOTHING
// AT ALL — no canvas, no still — which is the single failure mode this design has. They are one entry helper and
// one mode helper apart precisely so that cannot happen; these tests say so out loud.
describe("bakedStillCoversNode", () => {
  const cases = (): MirrorNode[] => [
    rippleNode(CARD_RIPPLE_SHOWN_WIDTH),
    rippleNode(CARD_RIPPLE_SHOWN_WIDTH / 2),
    rippleNode(0), // the game's HIDDEN ripple — NOT covered, so its dormant binding survives
    rippleNode(null), // unmeasurable — NOT covered, so the real shader keeps running
    glowNode(UNCOMMON_GLOW),
    glowNode(RARE_GLOW),
    glowNode("MegaCrit.Sts2.Core.Nodes.Vfx.NSomeOtherVfx"),
    mkNode()
  ];

  it("answers exactly `bakedStillFor(node) !== null`, in every mode", () => {
    for (const shaderMode of EFFECT_MODES) {
      for (const particleMode of EFFECT_MODES) {
        mirrorSettings.shaderMode = shaderMode;
        mirrorSettings.particleMode = particleMode;
        for (const node of cases()) {
          expect(bakedStillCoversNode(node)).toBe(bakedStillFor(node) !== null);
        }
      }
    }
  });

  it("covers a SHOWN ripple and both glows in the still modes, and nothing in the dynamic ones", () => {
    for (const mode of STILL_MODES) {
      mirrorSettings.shaderMode = mode;
      mirrorSettings.particleMode = mode;
      expect(bakedStillCoversNode(rippleNode(CARD_RIPPLE_SHOWN_WIDTH))).toBe(true);
      expect(bakedStillCoversNode(glowNode(UNCOMMON_GLOW))).toBe(true);
      expect(bakedStillCoversNode(glowNode(RARE_GLOW))).toBe(true);
    }
    for (const mode of LIVE_MODES) {
      mirrorSettings.shaderMode = mode;
      mirrorSettings.particleMode = mode;
      expect(bakedStillCoversNode(rippleNode(CARD_RIPPLE_SHOWN_WIDTH))).toBe(false);
      expect(bakedStillCoversNode(glowNode(RARE_GLOW))).toBe(false);
    }
  });

  it("never covers a ripple the game has hidden or one it cannot measure", () => {
    // Both keep their (dormant, or fully live) WebGL binding — suppressing those would be the failure above.
    for (const mode of STILL_MODES) {
      mirrorSettings.shaderMode = mode;
      expect(bakedStillCoversNode(rippleNode(0))).toBe(false);
      expect(bakedStillCoversNode(rippleNode(null))).toBe(false);
    }
  });
});

describe("bakedStillNeedsOwnLayer", () => {
  it("separates the two mount paths", () => {
    // The ripple is a background on the node's own element; a boxless emitter needs a positioned <img>.
    expect(bakedStillNeedsOwnLayer(bakedStillFor(rippleNode(CARD_RIPPLE_SHOWN_WIDTH))!)).toBe(false);
    expect(bakedStillNeedsOwnLayer(bakedStillFor(glowNode(RARE_GLOW))!)).toBe(true);
  });
});

// THE SCOPE, recorded so it does not read as an oversight. The baked stills are wired into the DOM stage only —
// `?stage=dom`, the shipping default. The `?stage=canvas` backend is an opt-in experiment whose draw-list builder
// deliberately does not consult this module, so on that stage an off-mode effect still paints nothing at all. If
// the canvas stage ever ships as the default this test is the thing that should fail first.
describe("canvas stage scope", () => {
  it("does not consult the baked stills", () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../canvas/paintSpec.ts"),
      "utf8"
    );

    expect(source).not.toContain("bakedEffects");
    expect(source).not.toContain("bakedStillFor");
  });

  // …and the module REFUSES to answer there, which became load-bearing when the stills started suppressing the
  // live binding. On that stage `paintSpec.fxHostIsLive` IS "the builder returned a binding", so a suppression
  // would delete the effect outright rather than substitute for it — the stage draws the gsw surface as a quad.
  it("covers nothing while the stage owns the effect pixels", () => {
    for (const mode of STILL_MODES) {
      mirrorSettings.shaderMode = mode;
      mirrorSettings.particleMode = mode;
      setStageOwnsEffectPixels(true);

      expect(bakedStillCoversNode(rippleNode(CARD_RIPPLE_SHOWN_WIDTH))).toBe(false);
      expect(bakedStillCoversNode(glowNode(RARE_GLOW))).toBe(false);
      expect(bakedStillFor(rippleNode(CARD_RIPPLE_SHOWN_WIDTH))).toBeNull();
      expect(bakedStillFor(glowNode(RARE_GLOW))).toBeNull();

      // Read LIVE, like the mode itself: un-latching (a canvas renderer being disposed for the DOM fallback)
      // hands the stills straight back.
      setStageOwnsEffectPixels(false);
      expect(bakedStillCoversNode(rippleNode(CARD_RIPPLE_SHOWN_WIDTH))).toBe(true);
      expect(bakedStillFor(glowNode(RARE_GLOW))).not.toBeNull();
    }
  });
});
