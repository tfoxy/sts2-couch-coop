import { describe, expect, it } from "vitest";

import { createDrawList } from "@godot-scene-web/canvas";

import { applySceneDelta, createMirrorState, parseSceneDelta } from "@/mirror/sceneTree";
import { buildDrawList } from "@/mirror/canvas/buildDrawList";
import { intentFrameIndex } from "@/mirror/mirrorRenderer";

// Godot Rect2 wire shape ({position,size}) → the raw region the producer streams.
const rect = (x: number, y: number, w: number, h: number) => ({ position: { x, y }, size: { x: w, y: h } });

const ATLAS = "res://atlases/intent_atlas.png";

function glyphRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "glyph",
    parentId: "intent",
    name: "Intent",
    nodeType: "Sprite2D",
    visible: true,
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 100, y: 100 } },
    localRect: rect(0, 0, 64, 64),
    intentFrames: {
      animationName: "defend",
      fps: 15,
      frames: [
        { atlasPath: ATLAS, region: rect(0, 0, 48, 48), margin: rect(1, 1, 2, 2) },
        { atlasPath: ATLAS, region: rect(48, 0, 48, 48), margin: rect(1, 1, 2, 2) },
        { atlasPath: ATLAS, region: rect(96, 0, 48, 48), margin: rect(1, 1, 2, 2) }
      ]
    },
    ...over
  };
}

function delta(nodes: Record<string, unknown>[], opts: { full?: boolean; order?: string[] } = {}) {
  return parseSceneDelta({
    type: "scene-delta",
    full: opts.full ?? false,
    screenType: "run",
    upserts: nodes,
    ...(opts.order ? { orderedIds: opts.order } : {})
  })!;
}

describe("parseSceneDelta intentFrames", () => {
  it("parses the frame set and maps atlas paths to /res/ urls", () => {
    const node = delta([glyphRaw()], { full: true, order: ["glyph"] }).upserts[0];
    expect(node.intentFrames).toBeTruthy();
    expect(node.intentFrames!.animationName).toBe("defend");
    expect(node.intentFrames!.fps).toBe(15);
    expect(node.intentFrames!.frames).toHaveLength(3);
    expect(node.intentFrames!.frames[0].url).toBe("/res/atlases/intent_atlas.png");
    expect(node.intentFrames!.frames[1].region).toEqual({ x: 48, y: 0, width: 48, height: 48 });
    expect(node.intentFrames!.frames[0].margin).toEqual({ x: 1, y: 1, width: 2, height: 2 });
  });

  it("forces the node's texture to frame 0 so the atlas-canvas path renders the glyph", () => {
    const node = delta([glyphRaw()], { full: true, order: ["glyph"] }).upserts[0];
    expect(node.textureUrl).toBe("/res/atlases/intent_atlas.png");
    expect(node.textureRegion).toEqual({ x: 0, y: 0, width: 48, height: 48 });
    expect(node.textureMargin).toEqual({ x: 1, y: 1, width: 2, height: 2 });
  });

  it("defaults a missing/zero fps to 15 and drops sets with no frames", () => {
    const ok = delta([glyphRaw({ intentFrames: { animationName: "buff", frames: [{ atlasPath: ATLAS, region: rect(0, 0, 10, 10) }] } })], {
      full: true,
      order: ["glyph"]
    }).upserts[0];
    expect(ok.intentFrames!.fps).toBe(15);

    const empty = delta([glyphRaw({ intentFrames: { animationName: "buff", fps: 15, frames: [] } })], { full: true, order: ["glyph"] })
      .upserts[0];
    expect(empty.intentFrames).toBeNull();
  });

  it("carries the frame set forward across a volatile-only upsert and ignores a stale streamed texture", () => {
    const state = createMirrorState();
    applySceneDelta(state, delta([glyphRaw()], { full: true, order: ["glyph"] }));

    // A volatile-only upsert (empty name) carrying the FROZEN sprite's stale texture + no intentFrames.
    applySceneDelta(
      state,
      delta([
        {
          id: "glyph",
          parentId: "intent",
          name: "",
          visible: true,
          transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 100, y: 100 } },
          localRect: rect(0, 0, 64, 64),
          texture: { resourcePath: "res://stale.png" },
          textureRegion: rect(9, 9, 9, 9)
        }
      ])
    );

    const merged = state.nodes.get("glyph")!;
    expect(merged.intentFrames!.animationName).toBe("defend"); // retained
    // Frame 0 re-applied over the stale texture the upsert carried.
    expect(merged.textureUrl).toBe("/res/atlases/intent_atlas.png");
    expect(merged.textureRegion).toEqual({ x: 0, y: 0, width: 48, height: 48 });
  });

  it("replaces the frame set (and frame-0 texture) when the intent animation changes", () => {
    const state = createMirrorState();
    applySceneDelta(state, delta([glyphRaw()], { full: true, order: ["glyph"] }));

    applySceneDelta(
      state,
      delta([
        glyphRaw({
          name: "",
          intentFrames: {
            animationName: "attack_1",
            fps: 15,
            frames: [{ atlasPath: ATLAS, region: rect(0, 64, 50, 50), margin: null }]
          }
        })
      ])
    );

    const merged = state.nodes.get("glyph")!;
    expect(merged.intentFrames!.animationName).toBe("attack_1");
    expect(merged.intentFrames!.frames).toHaveLength(1);
    expect(merged.textureRegion).toEqual({ x: 0, y: 64, width: 50, height: 50 });
  });
});

describe("intentFrameIndex", () => {
  it("cycles floor(elapsedMs/1000 * fps) modulo the frame count", () => {
    expect(intentFrameIndex(0, 15, 3)).toBe(0);
    expect(intentFrameIndex(100, 15, 3)).toBe(1); // 0.1*15 = 1.5 → 1
    expect(intentFrameIndex(140, 15, 3)).toBe(2); // 0.14*15 = 2.1 → 2
    expect(intentFrameIndex(300, 15, 3)).toBe(1); // 0.3*15 = 4.5 → 4 → 4%3 = 1
  });

  it("returns frame 0 for single-frame sets and degenerate inputs", () => {
    expect(intentFrameIndex(9999, 15, 1)).toBe(0);
    expect(intentFrameIndex(100, 0, 3)).toBe(0);
    expect(intentFrameIndex(-50, 15, 3)).toBe(0);
    expect(intentFrameIndex(Number.NaN, 15, 3)).toBe(0);
  });
});

// --- the CANVAS arm (R6) ----------------------------------------------------------------------------------------
//
// The DOM backend blits the frame onto the node's own atlas canvas; the canvas backend has no canvas per node and
// needs none — a frame IS a source rect, so the whole port is a SUBSTITUTE node carrying that frame's texture
// fields, and `emitAtlasRegion` is untouched. What matters is that the substitution reaches the paint and nothing
// else: the walk, the clip chain, the spread and the hit entry are all still the wire node's.

describe("intent glyphs — the canvas arm", () => {
  function glyphState() {
    const state = createMirrorState();
    applySceneDelta(
      state,
      delta(
        [
          {
            id: "intent",
            parentId: null,
            name: "IntentHolder",
            nodeType: "Control",
            visible: true,
            transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
            localRect: rect(0, 0, 200, 200)
          },
          glyphRaw()
        ],
        { full: true, order: ["intent", "glyph"] }
      )
    );
    return state;
  }

  /** The source rect the list actually painted for the glyph. */
  function drawnRegion(state: ReturnType<typeof glyphState>, frameSubstitutes: Map<string, never> | null) {
    const list = createDrawList<string>();
    const build = buildDrawList(state, list, { frameSubstitutes });
    const range = build.ranges.get("glyph")!;
    const view = list.readQuad(range.start, {
      m: new Float32Array(6),
      w: 0,
      h: 0,
      srcX: 0,
      srcY: 0,
      srcW: 0,
      srcH: 0,
      r: 1,
      g: 1,
      b: 1,
      a: 1,
      blend: 0,
      flipH: false,
      flipV: false,
      hasColorMatrix: false,
      colorMatrix: new Float32Array(9)
    } as never);
    return [view.srcX, view.srcY, view.srcW, view.srcH];
  }

  it("paints the wire's frame 0 with no substitute", () => {
    expect(drawnRegion(glyphState(), null)).toEqual([0, 0, 48, 48]);
  });

  it("paints frame N's region when one is substituted", () => {
    const state = glyphState();
    const node = state.nodes.get("glyph")!;
    const frame = node.intentFrames!.frames[2];
    const subs = new Map([
      ["glyph", { ...node, textureUrl: frame.url, textureRegion: frame.region, textureMargin: frame.margin }]
    ]);
    expect(drawnRegion(state, subs as never)).toEqual([96, 0, 48, 48]);
  });

  it("leaves the walk's own answers on the WIRE node", () => {
    const state = glyphState();
    const node = state.nodes.get("glyph")!;
    const frame = node.intentFrames!.frames[1];
    const subs = new Map([
      ["glyph", { ...node, textureUrl: frame.url, textureRegion: frame.region, textureMargin: frame.margin }]
    ]);
    const list = createDrawList<string>();
    const withSub = buildDrawList(state, list, { frameSubstitutes: subs as never });
    const without = buildDrawList(state, createDrawList<string>(), {});
    const a = withSub.hitEntries.find((e) => e.nodeId === "glyph")!;
    const b = without.hitEntries.find((e) => e.nodeId === "glyph")!;
    // Same placement, same game pose, same classification: only the source rect moved.
    expect([...a.mGame]).toEqual([...b.mGame]);
    expect([...a.mFinal]).toEqual([...b.mFinal]);
    expect(withSub.stats.canvas).toBe(without.stats.canvas);
  });
});
