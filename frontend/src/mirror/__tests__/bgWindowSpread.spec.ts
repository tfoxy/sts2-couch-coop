import { beforeEach, describe, expect, it } from "vitest";

import {
  createMirrorRenderer,
  mirrorWalkStats,


  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// An OVERSIZED background's shader canvas is uv-windowed against the SPREAD-WIDENED stage
// ([0, 1920·F]×[0,1080]) and from the SHIFTED global that actually places it. This keeps the visible window on
// the full phone stage rather than clipping it to the 16:9 design box.
//
// The fixture is the UNDERDOCKS shape in miniature: pass-through groups (boxless — they hand the spread budget
// through) over an oversized non-Control shader bg, which therefore takes computeSpread's POSITIONAL-CLAIMER
// branch (dx = clamp(centerGx)·(F−1), data-spread-mode="prop") — exactly how the real bg layers classify.

const F_WIDE = 2520 / 1920; // the capped phone stage (MIRROR_MAX_DESIGN_WIDTH)

function xform(tx: number, ty: number): Record<string, unknown> {
  return { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } };
}

function rect(w: number, h: number): Record<string, unknown> {
  return { position: { x: 0, y: 0 }, size: { x: w, y: h } };
}

// Boxless pass-through group (no localRect, no mouseFilter): passes the spread budget to its children.
function group(id: string, parentId: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, parentId, name: id, nodeType: "Node2D", transform: xform(0, 0), visible: true, ...over };
}

// The oversized parallax shader bg: a non-Control leaf (no mouseFilter/anchors ⇒ positional claimer) whose
// 2600×1400 box exceeds even the widened 2520×1080 stage on both axes, with a WebGL shader + base texture.
function shaderBg(): Record<string, unknown> {
  return {
    id: "shaderbg",
    parentId: "scroll",
    name: "shaderbg",
    nodeType: "TextureRect",
    transform: xform(300, -200),
    localRect: rect(2600, 1400),
    visible: true,
    texture: { resourcePath: "res://images/underdocks_bg.png", resourceType: "Texture2D" },
    shader: { resourcePath: "res://shaders/underdocks_water.gdshader", resourceType: "Shader" },
    shaderParameters: [{ name: "strength", kind: "number", number: 0.5 }]
  };
}

function scene(): Record<string, unknown>[] {
  return [
    group("world", null),
    group("scroll", "world", { transform: xform(0, -600) }),
    shaderBg(),
    // A second plain rider so the walk has ordinary fast-path traffic alongside the shader node.
    {
      id: "friend",
      parentId: "scroll",
      name: "friend",
      nodeType: "Sprite2D",
      transform: xform(800, 300),
      localRect: rect(100, 100),
      visible: true
    }
  ];
}

function scrollTo(y: number): Record<string, unknown>[] {
  // The real shape of a scroll frame: ONE volatile upsert on the moving group, transform only.
  return [{ id: "scroll", parentId: "world", name: "scroll", nodeType: "Node2D", transform: xform(0, y), visible: true }];
}

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function keyframe(state: MirrorState, nodes: Record<string, unknown>[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "Screens.Map.NMapScreen",
      upserts: nodes,
      orderedIds: nodes.map((n) => n.id as string)
    })!
  );
}

function update(state: MirrorState, nodes: Record<string, unknown>[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: false,
      screenType: "Screens.Map.NMapScreen",
      upserts: nodes
    })!
  );
}

// Every element under the stage with its full inline style + attribute set — the parity oracle (the uv-window
// attribute lives on the shader self-layer, so it is covered).
function domSnapshot(stage: HTMLElement): string[] {
  const out: string[] = [];
  const walk = (el: Element, path: string): void => {
    const attrs = Array.from(el.attributes)
      .map((a) => `${a.name}=${a.value}`)
      .sort()
      .join(",");
    out.push(`${path}|${el.tagName}|${(el as HTMLElement).style?.cssText ?? ""}|${attrs}`);
    let i = 0;
    for (const child of Array.from(el.children)) {
      walk(child, `${path}/${i++}`);
    }
  };
  let i = 0;
  for (const child of Array.from(stage.children)) {
    walk(child, String(i++));
  }
  return out;
}

function uvWindowOf(stage: HTMLElement): string | null {
  const self = stage.querySelector('[data-node-id="shaderbg"] .mirror-shader-self');
  return self ? self.getAttribute("data-godot-shader-uv-window") : null;
}

function spreadDxOf(stage: HTMLElement): string | null {
  return stage.querySelector('[data-node-id="shaderbg"]')?.getAttribute("data-spread-dx") ?? null;
}

// Drive the identical delta sequence and return the DOM + the shader bg's uv-window at rest and after scrolling.
function run(stretch: number): { dom: string[]; affine: number; uvRested: string | null; uvScrolled: string | null; dx: string | null } {
  mirrorWalkStats.reset();
  const { stage, renderer } = harness();
  renderer.setStretch(stretch);
  const state = createMirrorState();
  keyframe(state, scene());
  renderer.reconcile(state);
  const uvRested = uvWindowOf(stage);
  for (const y of [-580, -470, -300]) {
    update(state, scrollTo(y));
    renderer.reconcile(state);
  }
  return {
    dom: domSnapshot(stage),
    affine: mirrorWalkStats.affineFastPathVisits,
    uvRested,
    uvScrolled: uvWindowOf(stage),
    dx: spreadDxOf(stage)
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  mirrorWalkStats.reset();
});

describe("spread-aware shader uv-window", () => {
  it("windows against the WIDENED stage from the SHIFTED global (the algebra, both paths)", () => {
    // After the last scroll (y=−300) the bg's shifted global is [1,0,0,1, 300+500, −500]; against [0,2520]×[0,1080]:
    //   u0 = 0 (left edge on-stage at 800), du = (2520−800)/2600 = 0.6615 — the canvas runs to the stage's right
    //   edge (design 2520), NOT to the old hard-coded 1920 — v0 = 500/1400 = 0.3571, dv = 900/1400 = 0.6429.
    const expected = "0,0.3571,0.6615,0.6429";
    const result = run(F_WIDE);
    expect(result.uvScrolled).toBe(expected);
    expect(result.dx).toBe("500");
    expect(result.affine).toBeGreaterThan(0);
    expect(result.uvScrolled).not.toBe(result.uvRested);
  });

  it("F=1 keeps its 16:9 shader window stable", () => {
    const initial = run(1);
    const repeated = run(1);
    // The bg is still oversized at 16:9 (2600×1400 > 1920×1080), so a window IS present — and identical everywhere.
    expect(initial.uvScrolled).not.toBeNull();
    expect(initial.dx).toBeNull(); // no spread shift at F=1
    expect(repeated.dom).toEqual(initial.dom);
  });
});
