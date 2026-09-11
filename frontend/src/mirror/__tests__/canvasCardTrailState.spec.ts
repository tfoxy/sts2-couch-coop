import { describe, expect, it } from "vitest";

import {
  AUTHORED_TRAIL_DIET,
  createCardTrailState,
  type CardTrailStateEnv,
  type TrailDietState
} from "@/mirror/canvas/cardTrailState";
import type { MirrorCardFlightHint, MirrorNode } from "@/mirror/sceneTree";

// M3 WS-C A3 — the canvas backend's trail INTEGRATOR, on its own, with no renderer around it.
//
// What the module owns is the retained half of a comet: whose motion feeds which point history, which space that
// history is measured in, and when it drains. The strip geometry is `cardTrail.spec`'s; the quads are the build's.
// These specs pin the three things a second backend gets wrong on its own — the two samplers not fighting over one
// ribbon, the frame latch holding a space for the life of a history, and the park contract (`nextDeadline` going
// back to Infinity once the last point dies).

interface FakeNode {
  id: string;
  parentId: string | null;
  nodeType: string;
  name: string;
  textureUrl: string | null;
  global: number[];
}

/**
 * A scene of exactly the nodes a comet has: a card, a comet root, and two strokes under it.
 *
 * `pages` STARTS EMPTY on purpose — it is the texture bridge's "this url is ready" answer, and an empty one is
 * the state every ribbon is born in (the page has been asked for and has not decoded yet). So the default arm
 * here is the BANDED fallback, which is also the pre-R5 shape every spec below the T-DR1 block was written
 * against. The texture specs populate it explicitly.
 */
function scene(): {
  env: CardTrailStateEnv;
  nodes: Map<string, FakeNode>;
  overrides: Map<string, number[]>;
  loopOwned: Set<string>;
  spreadDx: Map<string, number>;
  diet: { value: TrailDietState };
  pages: Map<string, { width: number; height: number }>;
  sizeAsks: string[];
  moveRoot(x: number, y: number): void;
} {
  const nodes = new Map<string, FakeNode>();
  const add = (
    id: string,
    parentId: string | null,
    nodeType: string,
    name: string,
    x = 0,
    y = 0,
    textureUrl: string | null = null
  ) => {
    nodes.set(id, { id, parentId, nodeType, name, textureUrl, global: [1, 0, 0, 1, x, y] });
  };
  add("card", null, "NCardFlyShuffleVfx", "Card", 100, 900);
  add("comet", null, "NCardTrailVfx", "CardTrail", 100, 900);
  add("trails", "comet", "Node2D", "Trails", 100, 900);
  // The two strokes are pinned at the world origin by the game (see cardTrail.ts) — the identity global that makes
  // trail-local space design space. Each carries the page the game textures it with; both stream on the wire.
  add("outer", "trails", "NCardTrail", "OuterTrail", 0, 0, "/res/trail.png");
  add("inner", "trails", "NCardTrail", "InnerTrail", 0, 0, "/res/trail2.png");

  const overrides = new Map<string, number[]>();
  const loopOwned = new Set<string>();
  const spreadDx = new Map<string, number>();
  const diet = { value: AUTHORED_TRAIL_DIET };
  const pages = new Map<string, { width: number; height: number }>();
  const sizeAsks: string[] = [];

  const children = (id: string): string[] => [...nodes.values()].filter((n) => n.parentId === id).map((n) => n.id);

  const env: CardTrailStateEnv = {
    nodeOf: (id) => nodes.get(id) as unknown as MirrorNode | undefined,
    childIdsOf: (id) => children(id),
    streamedGlobalInto: (id, out) => {
      const node = nodes.get(id);
      if (!node) {
        return false;
      }
      for (let i = 0; i < 6; i++) {
        out[i] = node.global[i];
      }
      return true;
    },
    overrideOf: (id) => overrides.get(id) ?? null,
    spreadDxOf: (id) => spreadDx.get(id) ?? 0,
    loopOwnsTransform: (id) => loopOwned.has(id),
    textureSizeOf: (url) => {
      sizeAsks.push(url);
      return pages.get(url) ?? null;
    },
    diet: () => diet.value
  };

  return {
    env,
    nodes,
    overrides,
    loopOwned,
    spreadDx,
    diet,
    pages,
    sizeAsks,
    moveRoot(x, y) {
      for (const id of ["comet", "trails"]) {
        const node = nodes.get(id)!;
        node.global[4] = x;
        node.global[5] = y;
      }
    }
  };
}

const flight = (over: Partial<MirrorCardFlightHint> = {}): MirrorCardFlightHint =>
  ({
    targetId: "card",
    trailId: "comet",
    windowMs: 2000,
    ...over
  }) as MirrorCardFlightHint;

describe("cardTrailState — registration and the delta sampler", () => {
  it("finds the strokes under a comet root, through the group they hang in", () => {
    const s = scene();
    const trails = createCardTrailState(s.env);
    trails.noteFlights([flight()], 0);
    // The scan is depth-bounded and type-driven, so a scene that nests the strokes one group down still resolves
    // both of them — and nothing else.
    s.overrides.set("card", [1, 0, 0, 1, 100, 900]);
    trails.noteFlightHeads(0);
    expect(trails.stats().flightSamples).toBe(2);
  });

  it("takes the head from the stroke's PARENT origin, in the stroke's own space", () => {
    const s = scene();
    const trails = createCardTrailState(s.env);
    s.moveRoot(400, 300);
    trails.noteDelta(["outer"], 0);
    // The stroke's global is the identity, so trail-local IS design space and the head is the parent origin.
    const strip = trails.stripFor("outer");
    expect(strip, "one point is not a ribbon yet").toBeNull();
    s.moveRoot(400, 100);
    trails.noteDelta([], 16);
    const second = trails.stripFor("outer")!;
    expect(second.x1).toBeCloseTo(400, 6);
    expect(second.y1).toBeCloseTo(300, 6);
    expect(second.x2).toBeCloseTo(400, 6);
    expect(second.y2).toBeCloseTo(100, 6);
  });

  it("samples the whole registry, not just the delta — a comet moves by its ROOT", () => {
    const s = scene();
    const trails = createCardTrailState(s.env);
    trails.noteDelta(["outer", "inner"], 0);
    s.moveRoot(400, 600);
    // Nothing about the strokes changed on the wire; the root moved. Both must still take a sample.
    trails.noteDelta([], 16);
    expect(trails.stats().deltaSamples).toBe(4);
    expect(trails.stripFor("outer")).not.toBeNull();
  });

  it("forgets a stroke whose node left the scene", () => {
    const s = scene();
    const trails = createCardTrailState(s.env);
    trails.noteDelta(["outer"], 0);
    s.moveRoot(0, 400);
    trails.noteDelta([], 16);
    expect(trails.stats().strokes).toBe(1);
    s.nodes.delete("outer");
    trails.noteDelta(["outer"], 32);
    expect(trails.stats().strokes).toBe(0);
    expect(trails.latchedFrames().size).toBe(0);
  });
});

describe("cardTrailState — the flight sampler owns the ribbon", () => {
  it("reads the integrated pose out of the override channel, plus the card's own shift", () => {
    const s = scene();
    const trails = createCardTrailState(s.env);
    trails.noteFlights([flight()], 0);
    s.spreadDx.set("card", 120);
    s.overrides.set("card", [1, 0, 0, 1, 500, 700]);
    trails.noteFlightHeads(0);
    s.overrides.set("card", [1, 0, 0, 1, 900, 300]);
    trails.noteFlightHeads(16);
    const strip = trails.stripFor("outer")!;
    // A card on the squeeze field is DRAWN at its own dx, so the ribbon has to be laid down there too — at 16:9
    // every dx is 0 and this is the raw pose.
    expect(strip.x1).toBeCloseTo(620, 6);
    expect(strip.x2).toBeCloseTo(1020, 6);
  });

  it("locks the delta sampler out while the flight owns the stroke", () => {
    const s = scene();
    const trails = createCardTrailState(s.env);
    trails.noteFlights([flight()], 0);
    s.overrides.set("card", [1, 0, 0, 1, 500, 700]);
    trails.noteFlightHeads(0);
    // The producer's pose for this comet is FROZEN at the source pile for the flight's whole window; sampling it
    // as well would interleave two journeys into one history.
    s.moveRoot(100, 900);
    trails.noteDelta([], 16);
    expect(trails.stats().deltaSamples).toBe(0);
  });

  it("hands the ribbon back once the producer's suppression window closes", () => {
    const s = scene();
    const trails = createCardTrailState(s.env);
    trails.noteFlights([flight({ windowMs: 100 })], 0);
    s.overrides.set("card", [1, 0, 0, 1, 500, 700]);
    trails.noteFlightHeads(0);
    trails.tick(50);
    trails.noteDelta([], 50);
    expect(trails.stats().deltaSamples, "still the flight's while the window is open").toBe(0);
    trails.tick(100);
    trails.noteDelta([], 100);
    expect(trails.stats().deltaSamples).toBeGreaterThan(0);
  });

  it("takes no head at all when the loop has not sampled the flight yet", () => {
    const s = scene();
    const trails = createCardTrailState(s.env);
    trails.noteFlights([flight()], 0);
    trails.noteFlightHeads(0); // no override written
    expect(trails.stats().flightSamples).toBe(0);
    expect(trails.latchedFrames().size, "and nothing was latched for a sample that never happened").toBe(0);
  });
});

describe("cardTrailState — the frame latch", () => {
  it("pins the space for the life of the history, even as the stream moves the node", () => {
    const s = scene();
    const trails = createCardTrailState(s.env);
    trails.noteDelta(["outer"], 0);
    s.moveRoot(0, 400);
    trails.noteDelta([], 16);
    const before = trails.stripFor("outer")!;
    const frame = trails.latchedFrames().get("outer")!;
    expect(frame).toEqual([1, 0, 0, 1, 0, 0]);

    // The producer now re-poses the STROKE itself (the two-writer case the DOM's R14f round was about). The
    // history must not be re-interpreted: the walk is told to keep placing the stroke at the latched frame, so
    // the stored points still mean what they meant.
    s.nodes.get("outer")!.global = [1, 0, 0, 1, 640, 480];
    s.moveRoot(0, 200);
    trails.noteDelta([], 32);
    const after = trails.stripFor("outer")!;
    expect(after.x1).toBeCloseTo(before.x1, 6);
    expect(after.y1).toBeCloseTo(before.y1, 6);
    expect(trails.latchedFrames().get("outer")).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("never latches (or samples) a stroke the tween loop owns", () => {
    const s = scene();
    const trails = createCardTrailState(s.env);
    s.loopOwned.add("outer");
    trails.noteDelta(["outer", "inner"], 0);
    s.moveRoot(0, 400);
    trails.noteDelta([], 16);
    expect(trails.latchedFrames().has("outer")).toBe(false);
    expect(trails.latchedFrames().has("inner")).toBe(true);
    expect(trails.stripFor("outer")).toBeNull();
  });

  it("folds the stroke's own wide-screen shift into the latched inverse", () => {
    const s = scene();
    const trails = createCardTrailState(s.env);
    s.spreadDx.set("outer", 60);
    s.spreadDx.set("trails", 60);
    s.moveRoot(400, 900);
    trails.noteDelta(["outer"], 0);
    s.moveRoot(400, 500);
    trails.noteDelta([], 16);
    // Head on stage is 400 + 60; the stroke's own frame on stage is 0 + 60; so trail-local x is 400 again — the
    // shift cancels, which is exactly what "the ribbon lands under the card at every stage width" means.
    const strip = trails.stripFor("outer")!;
    expect(strip.x1).toBeCloseTo(400, 6);
  });

  it("releases the latch only once the history has drained, and takes it again after", () => {
    const s = scene();
    const trails = createCardTrailState(s.env);
    trails.noteDelta(["outer"], 0);
    s.moveRoot(0, 400);
    trails.noteDelta([], 16);
    expect(trails.latchedFrames().has("outer")).toBe(true);
    trails.tick(16 + AUTHORED_TRAIL_DIET.lifeMs);
    expect(trails.latchedFrames().has("outer"), "the last point died").toBe(false);
    expect(trails.stats().latchReleases).toBe(1);
    // …and the stroke is still registered, so the next card off the same pile re-latches wherever it now is.
    s.nodes.get("outer")!.global = [1, 0, 0, 1, 25, 25];
    s.moveRoot(0, 800);
    trails.noteDelta([], 2000);
    expect(trails.latchedFrames().get("outer")).toEqual([1, 0, 0, 1, 25, 25]);
    expect(trails.stats().latches).toBe(2);
  });

  it("drops every latch on a wire keyframe", () => {
    const s = scene();
    const trails = createCardTrailState(s.env);
    trails.noteDelta(["outer", "inner"], 0);
    s.moveRoot(0, 400);
    trails.noteDelta([], 16);
    expect(trails.latchedFrames().size).toBe(2);
    trails.reset();
    expect(trails.latchedFrames().size).toBe(0);
    expect(trails.stats().strokes).toBe(0);
    expect(trails.nextDeadline(16)).toBe(Infinity);
  });

  it("release() forgets one stroke and its latch", () => {
    const s = scene();
    const trails = createCardTrailState(s.env);
    trails.noteDelta(["outer", "inner"], 0);
    s.moveRoot(0, 400);
    trails.noteDelta([], 16);
    trails.release("outer");
    expect(trails.latchedFrames().has("outer")).toBe(false);
    expect(trails.latchedFrames().has("inner")).toBe(true);
    expect(trails.stripFor("outer")).toBeNull();
  });
});

describe("cardTrailState — the park contract", () => {
  it("publishes a REAL timestamp while points are alive and Infinity once they are gone", () => {
    const s = scene();
    const trails = createCardTrailState(s.env);
    expect(trails.nextDeadline(0), "nothing registered").toBe(Infinity);
    trails.noteDelta(["outer"], 1000);
    expect(trails.nextDeadline(1000)).toBe(1000 + AUTHORED_TRAIL_DIET.lifeMs);
    s.moveRoot(0, 400);
    trails.noteDelta([], 1016);
    // The OLDEST point's expiry, not the newest — the tail is what collapses first.
    expect(trails.nextDeadline(1016)).toBe(1000 + AUTHORED_TRAIL_DIET.lifeMs);
    trails.tick(1016 + AUTHORED_TRAIL_DIET.lifeMs);
    expect(trails.nextDeadline(9999), "a drained history must not hold the stage awake").toBe(Infinity);
    expect(trails.stats().strokes).toBe(0);
  });
});

describe("cardTrailState — the strip", () => {
  it("rebuilds only when the geometry changed", () => {
    const s = scene();
    const trails = createCardTrailState(s.env);
    trails.noteDelta(["outer"], 0);
    s.moveRoot(0, 400);
    trails.noteDelta([], 16);
    trails.stripFor("outer");
    const built = trails.stats().builds;
    trails.stripFor("outer");
    trails.stripFor("outer");
    expect(trails.stats().builds, "a build per frame must not be a rebuild per frame").toBe(built);
    expect(trails.stats().reuses).toBe(2);
    s.moveRoot(0, 200);
    trails.noteDelta([], 32);
    trails.stripFor("outer");
    expect(trails.stats().builds).toBe(built + 1);
  });

  it("answers the diet's blend, and suppresses the inner stroke under `single`", () => {
    const s = scene();
    const trails = createCardTrailState(s.env);
    trails.noteDelta(["outer", "inner"], 0);
    s.moveRoot(0, 400);
    trails.noteDelta([], 16);
    expect(trails.blendFor("outer"), "the authored pair is additive").toBe(1);
    expect(trails.stripFor("inner")).not.toBeNull();

    s.diet.value = { ...AUTHORED_TRAIL_DIET, single: true, blend: 0 };
    expect(trails.blendFor("outer")).toBe(0);
    expect(trails.stripFor("inner"), "its light is carried by the survivor").toBeNull();
    expect(trails.stripFor("outer")).not.toBeNull();
  });

  it("rebuilds across an arm edge", () => {
    const s = scene();
    const trails = createCardTrailState(s.env);
    trails.noteDelta(["outer"], 0);
    s.moveRoot(0, 400);
    trails.noteDelta([], 16);
    const full = trails.stripFor("outer")!;
    s.diet.value = { ...AUTHORED_TRAIL_DIET, maxBands: 2 };
    const collapsed = trails.stripFor("outer")!;
    expect(full.bands).toBe(3);
    expect(collapsed.bands).toBe(2);
  });

  it("keeps a quad high-water mark for the census", () => {
    const s = scene();
    const trails = createCardTrailState(s.env);
    trails.noteQuads(0);
    trails.noteQuads(174);
    trails.noteQuads(12);
    expect(trails.stats().quadPeak).toBe(174);
  });
});

// --- R5 T-DR1: the texture decision, and the fallback that makes it safe ----------------------------------------
//
// A textured ribbon is only drawable against a page the bridge has READY: an unready url is pushed as an
// invisible quad, so a strip built in hope would blank the comet for as long as the load takes. These pin the
// per-stroke, per-build decision, the counters that stop a run measuring the fallback and calling it the feature,
// and the warm-the-load side effect that is the only reason a trail page is ever fetched on this backend.
describe("cardTrailState — the textured cross-section (T-DR1)", () => {
  /** A stroke with two real points, so `stripFor` has a ribbon to answer with. */
  function litRibbon(s: ReturnType<typeof scene>) {
    const trails = createCardTrailState(s.env);
    trails.noteDelta(["outer", "inner"], 0);
    s.moveRoot(0, 400);
    trails.noteDelta([], 16);
    return trails;
  }

  it("falls back to the bands while the page is still loading, and SAYS which it drew", () => {
    const s = scene();
    const trails = litRibbon(s);
    const strip = trails.stripFor("outer")!;
    expect(strip.textured, "no ready page ⇒ no textured ribbon").toBe(false);
    expect(strip.bands).toBe(3);
    expect(trails.textureFor("outer")).toBeNull();
    expect(trails.stats().bandedStrokes).toBe(1);
    expect(trails.stats().texturedStrokes).toBe(0);
  });

  it("ASKS for the page even when it cannot use it — nothing else on this backend warms a trail url", () => {
    const s = scene();
    const trails = litRibbon(s);
    trails.stripFor("outer");
    trails.stripFor("inner");
    // The stroke node is an overlay record and never emits a plain quad, so if this module did not ask, the
    // bridge would never hear the url and the ribbon would be banded forever.
    expect(s.sizeAsks).toContain("/res/trail.png");
    expect(s.sizeAsks).toContain("/res/trail2.png");
  });

  it("re-shapes on the frame the page decodes, mid-flight, without a geometry change", () => {
    const s = scene();
    const trails = litRibbon(s);
    expect(trails.stripFor("outer")!.textured).toBe(false);

    // The load lands. Nothing about the point history changed — the cache must still refuse to serve the
    // banded strip, or the comet stays a staircase for the rest of the flight.
    s.pages.set("/res/trail.png", { width: 32, height: 32 });
    const after = trails.stripFor("outer")!;
    expect(after.textured).toBe(true);
    expect(after.bands).toBe(1);
    expect(trails.textureFor("outer")).toEqual({ url: "/res/trail.png", width: 32, height: 32 });
    expect(trails.stats().texturedStrokes).toBe(1);
  });

  it("caches the textured strip too — a ready page is not a rebuild per build", () => {
    const s = scene();
    s.pages.set("/res/trail.png", { width: 32, height: 32 });
    const trails = litRibbon(s);
    trails.stripFor("outer");
    const built = trails.stats().builds;
    trails.stripFor("outer");
    trails.stripFor("outer");
    expect(trails.stats().builds).toBe(built);
    expect(trails.stats().reuses).toBe(2);
  });

  it("each stroke resolves its OWN page — the two are different images", () => {
    const s = scene();
    s.pages.set("/res/trail2.png", { width: 64, height: 64 });
    const trails = litRibbon(s);
    expect(trails.stripFor("outer")!.textured, "the outer page has not landed").toBe(false);
    expect(trails.stripFor("inner")!.textured).toBe(true);
    expect(trails.textureFor("inner")).toEqual({ url: "/res/trail2.png", width: 64, height: 64 });
    expect(trails.stats()).toMatchObject({ texturedStrokes: 1, bandedStrokes: 1 });
  });

  it("a stroke with no streamed texture is banded, not blank", () => {
    const s = scene();
    s.nodes.get("outer")!.textureUrl = null;
    s.pages.set("/res/trail.png", { width: 32, height: 32 });
    const trails = litRibbon(s);
    expect(trails.stripFor("outer")!.textured).toBe(false);
    expect(trails.stripFor("outer")).not.toBeNull();
  });
});
