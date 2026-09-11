// CARD TRAILS ON THE CANVAS STAGE — the retained half of the comet.
//
// WHAT THIS IS FOR. A card trail is the one thing the mirror draws that is not on the wire: `cardTrail.ts` explains
// why (the producer's stroke-geometry unit drops the four things — taper, ramp, texture, additive material — that
// make a trail read as a comet instead of a bar, and a reshuffle would re-ship two growing point arrays per card
// per tick). Both backends therefore INTEGRATE the ribbon client-side from the card's own motion, and this module
// is the canvas backend's integrator: it owns the point histories, feeds them, ages them, and answers the draw-list
// build with a {@link TrailStrip} per stroke.
//
// It owns NO pixels and no elements. `buildDrawList` asks `stripFor`, `paintSpec.emitTrailQuads` turns the answer
// into quads at the stroke's own paint index, and everything about WHERE those quads land is the walk's.
//
// TWO SAMPLERS, because there are two completely different sources of "where is the card right now", and the DOM
// backend has exactly the same pair:
//
//   * THE FLIGHT SAMPLER (`noteFlightHeads`) — while a card flight owns a comet, the producer has STOPPED streaming
//     the card and the two strokes (see `MirrorCardFlightHint`), so the only live pose is the one the tween loop
//     integrates. That pose lands in the renderer's `transformOverrides` every frame; this reads it there, adds the
//     card's own wide-screen shift, and pushes it as the head.
//   * THE DELTA SAMPLER (`noteDelta`) — a comet the producer is placing itself (a trail that spawned without a
//     flight hint, or one whose flight has retired). The head is the stroke's PARENT's origin, read OVERRIDE-BLIND
//     for the same reason the DOM walk reads the streamed pose there: the parent is what the producer is moving,
//     and an override on it would be this module's own latch reflected back at it.
//
// A stroke a flight owns is skipped by the delta sampler outright. Sampling both would interleave two different
// answers to "where is the card" into one history — and the producer's answer is FROZEN for the flight's duration,
// so it would pin the ribbon to the discard pile while the card flew away from it.
//
// POINTS ARE STORED STROKE-LOCAL, and that is what makes the wide-screen spread and the view scale free: the walk
// composes the stroke's own placement onto every quad, so a ribbon laid down in the node's local space is re-placed
// by exactly the machinery that re-places the node. The conversion INTO that space is `trailInv` below.
//
// The frame latch makes a point history a record of motion: every
// point in it was converted into some space at the instant it was taken and then left there for up to 800 ms. So
// the space a stroke RENDERS in is not free to change while that list is alive — change it and every stored point
// silently moves, which draws a self-crossing polygon across the stage instead of a comet. The canvas twin of the
// DOM's `trailFrame` is the transform-override channel: the first sample latches the stroke's current global and
// publishes it through {@link CardTrailState.latchedFrames}, the renderer merges that into the build's overrides,
// and the walk then reproduces the latched space instead of establishing a new one. It is released only when the
// history itself has drained.
//
// THREE GUARDS ON THE LATCH, all of them about not fighting another writer:
//   1. a stroke the TWEEN LOOP owns is never latched (and never sampled) — the loop's own pose is authoritative
//      there, and two writers on one override key is the exact race the DOM side spent a round on;
//   2. `reset()` drops every latch on a wire keyframe, because every history describes a tree that no longer
//      exists;
//   3. `release(id)` drops one when its node leaves the scene.

import { affineInverse, type Affine } from "@/mirror/affine";
import {
  buildTrailStrip,
  createTrailPoints,
  expireTrailPoints,
  isCardTrailNode,
  nextTrailExpiryMs,
  pushTrailPoint,
  trailPhaseProbe,
  trailProfile,
  type TrailPhase,
  type TrailPoints,
  type TrailProfile,
  type TrailStrip
} from "@/mirror/cardTrail";
import type { MirrorCardFlightHint, MirrorNode } from "@/mirror/sceneTree";

/** How deep under a comet root the stroke scan goes. The trail scene nests them one group down; two is slack. */
const STROKE_SCAN_DEPTH = 2;

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/**
 * The diet state one sample runs under — "what is in force RIGHT NOW", resolved by the caller once per frame.
 *
 * The adaptive diets resolve this once per frame.
 */
export interface TrailDietState {
  /** Point lifetime (`cardTrail.expireTrailPoints`). */
  lifeMs: number;
  /** Point budget; 0 = unbudgeted. */
  budget: number;
  /** Truncate the band stack, widest first; undefined = the authored stack. */
  maxBands?: number;
  /** A flat multiplier over every band's alpha, clamped at 1. */
  alphaScale: number;
  /** The blend the quads are drawn with: 1 = ADD (the authored additive pair), 0 = MIX (the `noblend` rung). */
  blend: 0 | 1;
  /**
   * Let the authored page carry the cross-section (one full-width cell per segment) instead of the
   * band staircase that stands in for it. WANTED, not guaranteed: a stroke whose page has not decoded yet draws
   * the bands instead, per stroke per build (see `stripFor`).
   */
  textured: boolean;
  /**
   * Draw one stroke carrying both trails' light instead of two. The survivor is the outer; the
   * other publishes no strip at all, which on this backend means it pushes no commands rather than blanking an
   * element's geometry.
   */
  single: boolean;
}

/** The authored look: the full stack, additive, the game's own lifetime, the real page, watertight joints. */
export const AUTHORED_TRAIL_DIET: TrailDietState = Object.freeze({
  lifeMs: 800,
  budget: 0,
  alphaScale: 1,
  blend: 1,
  single: false,
  textured: true,
});

/** Everything this module cannot work out for itself, supplied by the renderer that owns the scene. */
export interface CardTrailStateEnv {
  /** The node, or undefined when it is not (or no longer) in the map. */
  nodeOf(id: string): MirrorNode | undefined;
  /** A node's child ids, from the renderer's own index. */
  childIdsOf(id: string): readonly string[] | undefined;
  /** The node's STREAMED global (override-blind), written into `out`. False when it cannot be composed. */
  streamedGlobalInto(id: string, out: number[]): boolean;
  /** The node's live animation override — the absolute `gRaw` channel the flight pose lands in. */
  overrideOf(id: string): readonly number[] | null;
  /** The ABSOLUTE wide-screen shift the last build applied to a node (0 at 16:9). */
  spreadDxOf(id: string): number;
  /** Does the tween loop own this node's transform right now? See guard 1 in the header. */
  loopOwnsTransform(id: string): boolean;
  /**
   * The page size of a texture url, or null until it is READY — the texture bridge's own `sizeOf`, and the two
   * things it answers here are both load-bearing. It says whether a textured ribbon is drawable AT ALL (a quad
   * whose page has not uploaded is pushed INVISIBLE, so guessing would blank the comet), and asking WARMS the
   * load, which is how a trail page that nothing else references ever gets fetched in the first place.
   */
  textureSizeOf(url: string): { width: number; height: number } | null;
  /** The diet in force this frame. */
  diet(): TrailDietState;
}

/** A ready page a textured ribbon samples: the url the bridge resolves, and the WHOLE-PAGE source rect. */
export interface TrailTexture {
  url: string;
  width: number;
  height: number;
}

/** The census block. Every counter answers a question a settled screen's last build cannot. */
export interface TrailStateStats {
  /** Strokes with at least one unexpired point right now. */
  strokes: number;
  /** …and the high-water mark, because a census is post-settle and a landed comet has drained. */
  strokesPeak: number;
  /** Head samples taken, split by which sampler took them. */
  flightSamples: number;
  deltaSamples: number;
  /** Frame latches taken and released — these two must converge, or a stroke is pinned forever. */
  latches: number;
  latchReleases: number;
  /** Live latches right now. */
  latched: number;
  /** The discontinuity cut and point budget's interior decimation. */
  teleportCuts: number;
  decimations: number;
  /** Strips rebuilt (a sample that changed the geometry), and strips served from the last build's answer. */
  builds: number;
  reuses: number;
  /**
   * How those `builds` split between the authored TEXTURED ribbon and the BANDED fallback (T-DR1). Without this
   * split a run can measure the fallback — a page that never decoded, `--res-root` forgotten — and report it as
   * the feature: the two shapes both draw a comet, and the difference is a soft edge against a 3-step one.
   * `bandedStrokes` above zero on a settled replay means the texture path is not what was measured.
   */
  texturedStrokes: number;
  bandedStrokes: number;
  /** The worst build's trail-quad count. A settled screen draws zero; only this says the wiring ever worked. */
  quadPeak: number;
}

/** One stroke's retained state. */
interface Stroke {
  id: string;
  points: TrailPoints;
  profile: TrailProfile;
  /** The latched space, on stage — what a head global is converted THROUGH. Null before the first sample. */
  inv: Affine | null;
  /** …and the latched global itself, which the walk is told to PLACE the stroke at. */
  frame: number[] | null;
  /** The strip the last geometry change produced, or null for a history too short to draw. */
  strip: TrailStrip | null;
  /** Does `strip` still describe `points`? */
  stripFresh: boolean;
  /** The diet the cached strip was built under, so an arm edge rebuilds it (A5). */
  stripDiet: TrailDietState | null;
  /**
   * The page the cached strip was built AGAINST, or null when it is the banded fallback. Compared per build, so
   * the ribbon re-shapes on the frame the page finally decodes rather than staying banded for the flight.
   */
  stripTexture: TrailTexture | null;
  /** The last head this stroke was sampled with, in its latched space. NaN before the first. */
  lastX: number;
  lastY: number;
}

export interface CardTrailState {
  /**
   * Arm the strokes a batch of card flights owns.
   *
   * MUST RUN BEFORE THE HINTS ARE CONSUMED — the renderer drains `pendingCardFlights` into the tween loop and then
   * empties the array, so this is the last moment `trailId` is readable.
   */
  noteFlights(hints: readonly MirrorCardFlightHint[], at: number): void;
  /**
   * Register whatever trail strokes this delta introduced, then sample every stroke the WIRE is driving.
   *
   * `changedIds` is the registration signal only: a comet's strokes appear in it when they arrive (and a keyframe
   * puts the whole scene in it), which is enough to find every stroke exactly once. The SAMPLING then covers the
   * whole registry, because the producer moves a comet by moving its ROOT and the stroke node itself may not be in
   * the delta at all.
   */
  noteDelta(changedIds: Iterable<string>, at: number): void;
  /** Sample every flight-owned stroke from this frame's integrated card pose. */
  noteFlightHeads(at: number): void;
  /** Age every live history, drop the drained ones, and retire flights whose window has closed. */
  tick(at: number): void;
  /** The strip for one stroke, or null when it has nothing to draw. The draw-list build's question. */
  stripFor(nodeId: string): TrailStrip | null;
  /**
   * The page the strip `stripFor` just answered with samples, or null for the banded fallback.
   *
   * MUST BE ASKED AFTER `stripFor` FOR THE SAME NODE, in the same build: `stripFor` is what resolves the
   * decision (and re-resolves it when a page decodes mid-flight), and this hands back what it decided. Asking
   * first would answer for the previous build.
   */
  textureFor(nodeId: string): TrailTexture | null;
  /** The blend one stroke's quads are drawn with. */
  blendFor(nodeId: string): 0 | 1;
  /** The globals the walk must PLACE latched strokes at — merged into the build's transform overrides. */
  latchedFrames(): ReadonlyMap<string, readonly number[]>;
  /** When the oldest live point dies (a REAL wall-clock timestamp), or Infinity when nothing is alive. */
  nextDeadline(at: number): number;
  /** Forget one node — it left the scene. */
  release(nodeId: string): void;
  /** A wire keyframe: every history describes a tree that no longer exists. */
  reset(): void;
  /** Count a build's trail quads (the peak the census reports). */
  noteQuads(quads: number): void;
  /**
   * The comet's phase right now — how far into its own decay every live ribbon is.
   *
   * The harness's cross-arm gate reads this before it is allowed to compare a single pixel: a ribbon is a
   * decaying record of motion, so two clients stopped at the same recorded millisecond are not showing the same
   * picture unless their histories are also the same age.
   */
  probe(nowMs: number): TrailPhase;
  stats(): TrailStateStats;
}

export function createCardTrailState(env: CardTrailStateEnv): CardTrailState {
  const strokes = new Map<string, Stroke>();
  /** Stroke id -> the flying card whose pose feeds it. */
  const flightOwner = new Map<string, string>();
  /** Card id -> when its flight window closes, so an abandoned ownership cannot outlive the flight. */
  const flightUntil = new Map<string, number>();
  const frames = new Map<string, readonly number[]>();

  const scratch: number[] = [1, 0, 0, 1, 0, 0];
  const stats: TrailStateStats = {
    strokes: 0,
    strokesPeak: 0,
    flightSamples: 0,
    deltaSamples: 0,
    latches: 0,
    latchReleases: 0,
    latched: 0,
    teleportCuts: 0,
    decimations: 0,
    builds: 0,
    reuses: 0,
    texturedStrokes: 0,
    bandedStrokes: 0,
    quadPeak: 0
  };

  function strokeFor(id: string): Stroke | null {
    const existing = strokes.get(id);
    if (existing) {
      return existing;
    }
    const node = env.nodeOf(id);
    if (!node || !isCardTrailNode(node)) {
      return null;
    }
    const stroke: Stroke = {
      id,
      points: createTrailPoints(),
      // Keyed by NAME, exactly as the DOM path keys it: the five per-character trail scenes differ only in
      // `modulate` and the texture, both of which stream.
      profile: trailProfile(node.name),
      inv: null,
      frame: null,
      strip: null,
      stripFresh: false,
      stripDiet: null,
      stripTexture: null,
      lastX: NaN,
      lastY: NaN
    };
    strokes.set(id, stroke);
    // WARM THE PAGE THE MOMENT THE STROKE EXISTS, not when it first has a ribbon to draw.
    //
    // MEASURED, and it is the difference between the feature working and not. `stripFor` asks for the page too
    // (it has to — the answer decides the shape), but the first `stripFor` is already mid-flight: on the r13
    // discard recording the whole comet is spawned, flown and drained inside 1.4 s, and a load started at the
    // first strip was still pending when the ribbon had gone. Registration happens on the delta that introduces
    // the comet, which is the earliest this client can possibly know the url — and because the same comet is
    // re-used for the next card off the pile, it is also what makes every later flight textured.
    // A banded fallback must not fetch a missing page: its own authored geometry is already drawable.
    const url = node.textureUrl;
    if (url && env.diet().textured) {
      env.textureSizeOf(url);
    }
    return stroke;
  }

  /** The strokes under a comet root, bounded to the trail scene's own depth (see `STROKE_SCAN_DEPTH`). */
  function collectStrokes(rootId: string, depth: number, out: string[]): void {
    const children = env.childIdsOf(rootId);
    if (!children) {
      return;
    }
    for (const childId of children) {
      const node = env.nodeOf(childId);
      if (node && isCardTrailNode(node)) {
        out.push(childId);
      } else if (depth < STROKE_SCAN_DEPTH) {
        collectStrokes(childId, depth + 1, out);
      }
    }
  }

  /**
   * Take (or reproduce) this stroke's latched space.
   *
   * Returns the inverse to convert a head global through, or null when the stroke must not be sampled at all —
   * which is guard 1: a stroke the tween loop is placing has a writer already, and a latch on the same override
   * key would be a second one.
   */
  function latchFor(stroke: Stroke): Affine | null {
    if (stroke.inv !== null) {
      return stroke.inv;
    }
    if (env.loopOwnsTransform(stroke.id)) {
      return null;
    }
    if (!env.streamedGlobalInto(stroke.id, scratch)) {
      return null;
    }
    const frame = scratch.slice();
    // The frame ON STAGE — the wide-screen shift the build applies to this node folded into its translation, which
    // is the space a head global (also on stage) has to be measured in. At 16:9 every shift is 0 and this is the
    // streamed global verbatim.
    const onStage: Affine = [frame[0], frame[1], frame[2], frame[3], frame[4] + env.spreadDxOf(stroke.id), frame[5]];
    stroke.frame = frame;
    stroke.inv = affineInverse(onStage) ?? IDENTITY;
    frames.set(stroke.id, frame);
    stats.latches++;
    return stroke.inv;
  }

  function releaseLatch(stroke: Stroke): void {
    if (stroke.frame === null) {
      return;
    }
    stroke.frame = null;
    stroke.inv = null;
    frames.delete(stroke.id);
    stats.latchReleases++;
  }

  /** Age one stroke's history in place, with no head to add. */
  function age(stroke: Stroke, at: number, lifeMs: number): void {
    if (stroke.points.spawnMs.length > 0 && expireTrailPoints(stroke.points, at, lifeMs)) {
      stroke.stripFresh = false;
    }
  }

  /** One head, in STAGE space, pushed into one stroke's history. */
  function push(stroke: Stroke, gx: number, gy: number, at: number): void {
    const diet = env.diet();
    // A HEAD THAT HAS NOT MOVED AT ALL IS NOT A SAMPLE, and this is load-bearing rather than an optimisation.
    //
    // The flight sampler runs once per stroke per FRAME, and a landed flight keeps publishing the same parked
    // pose for the rest of the producer's suppression window (up to 3.6 s). Without this, every frame in which
    // the history happened to be empty would RE-SEED it with a single point at the discard pile: the live-stroke
    // count never falls to zero, the fourth demand source never answers Infinity, and the stage wakes every
    // 800 ms to age one invisible point out and put it straight back. A comet is a record of MOTION; a card that
    // is not moving lays no trail. The ribbon still AGES here, so a landed one keeps collapsing tail-first.
    //
    // Compared in STAGE space, deliberately, so the test survives a re-latch: "has the card moved" is a question
    // about the card, and answering it in a space that is itself allowed to change would make a stroke that
    // merely re-latched look like a stroke that moved. `noteFlights` clears it, because a NEW flight is a new
    // journey even if it starts exactly where the last one ended.
    if (stroke.lastX === gx && stroke.lastY === gy) {
      age(stroke, at, diet.lifeMs);
      return;
    }
    const inv = latchFor(stroke);
    if (inv === null) {
      return; // the loop owns this stroke — no latch, no sample, and nothing recorded as sampled
    }
    const x = inv[0] * gx + inv[2] * gy + inv[4];
    const y = inv[1] * gx + inv[3] * gy + inv[5];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }
    stroke.lastX = gx;
    stroke.lastY = gy;
    const result = pushTrailPoint(stroke.points, x, y, at, {
      lifeMs: diet.lifeMs,
      budget: diet.budget
    });
    if (result.teleported) {
      stats.teleportCuts++;
    }
    if (result.decimated) {
      stats.decimations++;
    }
    if (result.changed) {
      stroke.stripFresh = false;
    }
  }

  /**
   * The page this stroke would sample RIGHT NOW, or null for the banded fallback — the diet refusing it, a node
   * that streams no texture, or a page that has not decoded yet (see `CardTrailStateEnv.textureSizeOf`).
   *
   * The url is read off the NODE rather than cached on the stroke: the five per-character trail scenes differ in
   * exactly two things and the texture is one of them, so a comet re-used for the next card off the same pile
   * can legitimately change pages under a registered stroke.
   */
  function textureWanted(stroke: Stroke, diet: TrailDietState): TrailTexture | null {
    if (!diet.textured) {
      return null;
    }
    const url = env.nodeOf(stroke.id)?.textureUrl ?? null;
    if (url === null) {
      return null;
    }
    const size = env.textureSizeOf(url);
    return size === null ? null : { url, width: size.width, height: size.height };
  }

  function sameTexture(a: TrailTexture | null, b: TrailTexture | null): boolean {
    if (a === null || b === null) {
      return a === b;
    }
    return a.url === b.url && a.width === b.width && a.height === b.height;
  }

  function noteLive(): void {
    let live = 0;
    let latched = 0;
    for (const stroke of strokes.values()) {
      if (stroke.points.spawnMs.length > 0) {
        live++;
      }
      if (stroke.frame !== null) {
        latched++;
      }
    }
    stats.strokes = live;
    stats.latched = latched;
    if (live > stats.strokesPeak) {
      stats.strokesPeak = live;
    }
  }

  return {
    noteFlights(hints, at) {
      for (const hint of hints) {
        if (hint.trailId == null) {
          continue;
        }
        const found: string[] = [];
        collectStrokes(hint.trailId, 0, found);
        for (const id of found) {
          const stroke = strokeFor(id);
          if (stroke !== null) {
            flightOwner.set(id, hint.targetId);
            // A NEW FLIGHT IS A NEW JOURNEY, even one that starts exactly where the last one ended (the same
            // comet is reused for every card off a pile). Clearing the moved-head memory is what lets the first
            // frame of it lay a point down; see `push`.
            stroke.lastX = NaN;
            stroke.lastY = NaN;
          }
        }
        // The pin lasts exactly as long as the producer's suppression window, for the reason the DOM's does: until
        // it closes, the streamed pose is still the frozen pre-flight one, so handing the ribbon back to the delta
        // sampler early would yank its head to the source pile for a frame.
        flightUntil.set(hint.targetId, at + hint.windowMs);
      }
    },

    noteDelta(changedIds, at) {
      // REGISTRATION. A comet's strokes appear in the delta when they arrive; a keyframe puts the whole scene
      // through here, which is what picks up a trail that was already on screen when this backend mounted.
      for (const id of changedIds) {
        const node = env.nodeOf(id);
        if (node === undefined) {
          const gone = strokes.get(id);
          if (gone) {
            releaseLatch(gone);
            strokes.delete(id);
            flightOwner.delete(id);
          }
          continue;
        }
        if (isCardTrailNode(node)) {
          strokeFor(id);
        }
      }
      // SAMPLING covers the whole registry, not just the delta: the producer moves a comet by moving its ROOT, so
      // a stroke that is being carried across the stage need not appear in `changedIds` at all.
      for (const stroke of strokes.values()) {
        if (flightOwner.has(stroke.id)) {
          continue; // the flight is the sole sampler while it owns this ribbon — see the header
        }
        const node = env.nodeOf(stroke.id);
        const parentId = node?.parentId ?? null;
        if (parentId == null || !env.streamedGlobalInto(parentId, scratch)) {
          continue;
        }
        // `NCardTrail` pins its Line2D at the world origin and appends its PARENT's global position, so the head
        // is the parent's origin — on stage, i.e. with the shift the build gave the parent.
        push(stroke, scratch[4] + env.spreadDxOf(parentId), scratch[5], at);
        stats.deltaSamples++;
      }
      noteLive();
    },

    noteFlightHeads(at) {
      if (flightOwner.size === 0) {
        return;
      }
      for (const [strokeId, cardId] of flightOwner) {
        const stroke = strokes.get(strokeId);
        if (!stroke) {
          flightOwner.delete(strokeId);
          continue;
        }
        // THE INTEGRATED POSE, from the channel the tween loop just swept it into. No override means the loop has
        // not sampled this flight yet (or has already released it); either way there is no head to take, and the
        // window clock below is what ends the ownership.
        const pose = env.overrideOf(cardId);
        if (pose === null || pose.length !== 6) {
          continue;
        }
        push(stroke, pose[4] + env.spreadDxOf(cardId), pose[5], at);
        stats.flightSamples++;
      }
      noteLive();
    },

    tick(at) {
      // RETIRE CLOSED FLIGHTS FIRST, so a ribbon whose card has landed goes back to the delta sampler in the same
      // frame the window closes rather than a frame later.
      if (flightUntil.size > 0) {
        for (const [cardId, until] of flightUntil) {
          if (at < until) {
            continue;
          }
          flightUntil.delete(cardId);
          for (const [strokeId, owner] of flightOwner) {
            if (owner === cardId) {
              flightOwner.delete(strokeId);
            }
          }
        }
      }
      const diet = env.diet();
      for (const stroke of strokes.values()) {
        // The ageing half of the sample, with no head to add. Expiry alone can empty a history, which is what
        // collapses a landed card's comet tail-first instead of leaving a streak on the discard pile.
        age(stroke, at, diet.lifeMs);
        // …and the SETTLE runs whether or not the expiry above is what emptied the list: a head sample ages the
        // history too (`push`), so a ribbon can perfectly well drain between ticks. Skipping an already-empty
        // stroke here is what used to leave its latch standing after that.
        if (stroke.points.spawnMs.length === 0 && stroke.frame !== null) {
          // THE ONLY PLACE A LIVE RIBBON RELEASES ITS FRAME. There is no stored sample left for a new space to
          // move, so the stroke tracks the stream again from the next build on.
          releaseLatch(stroke);
          stroke.strip = null;
          stroke.stripFresh = true;
          // A stroke with no live points AND no node left is genuinely finished. One with a node stays registered:
          // the same comet is re-used for the next card off the same pile.
          if (env.nodeOf(stroke.id) === undefined) {
            strokes.delete(stroke.id);
            flightOwner.delete(stroke.id);
          }
        }
      }
      noteLive();
    },

    stripFor(nodeId) {
      const stroke = strokes.get(nodeId);
      if (!stroke) {
        return null;
      }
      const diet = env.diet();
      if (diet.single && stroke.profile === trailProfile("InnerTrail")) {
        return null; // its light is being carried by the sibling — see `TrailDietState`
      }
      // THE TEXTURE DECISION, RE-TAKEN EVERY BUILD (T-DR1). A ribbon can only be textured against a page that is
      // READY — an unready url is pushed as an invisible quad, so a strip built in hope would blank the comet
      // for as long as the load takes. Re-asking per build is also what makes the answer arrive: `textureSizeOf`
      // warms the load, and the frame the page lands is the frame the shape changes.
      const texture = textureWanted(stroke, diet);
      if (stroke.stripFresh && stroke.stripDiet === diet && sameTexture(stroke.stripTexture, texture)) {
        stats.reuses++;
        return stroke.strip;
      }
      stroke.strip = buildTrailStrip(stroke.points, stroke.profile, {
        maxBands: diet.maxBands,
        alphaScale: diet.alphaScale,
        textured: texture !== null
      });
      stroke.stripFresh = true;
      stroke.stripDiet = diet;
      stroke.stripTexture = texture;
      stats.builds++;
      if (stroke.strip !== null) {
        // Counted on the strips that actually DREW something, so a run's split describes ribbons on screen and
        // not the null answers a two-point history produces.
        if (texture !== null) {
          stats.texturedStrokes++;
        } else {
          stats.bandedStrokes++;
        }
      }
      return stroke.strip;
    },

    textureFor(nodeId) {
      return strokes.get(nodeId)?.stripTexture ?? null;
    },

    blendFor(_nodeId) {
      return env.diet().blend;
    },

    latchedFrames() {
      return frames;
    },

    nextDeadline(_at) {
      const lifeMs = env.diet().lifeMs;
      let due = Infinity;
      for (const stroke of strokes.values()) {
        const next = nextTrailExpiryMs(stroke.points, lifeMs);
        if (next < due) {
          due = next;
        }
      }
      return due;
    },

    release(nodeId) {
      const stroke = strokes.get(nodeId);
      if (!stroke) {
        return;
      }
      releaseLatch(stroke);
      strokes.delete(nodeId);
      flightOwner.delete(nodeId);
      noteLive();
    },

    reset() {
      for (const stroke of strokes.values()) {
        releaseLatch(stroke);
      }
      strokes.clear();
      flightOwner.clear();
      flightUntil.clear();
      frames.clear();
      noteLive();
    },

    noteQuads(quads) {
      if (quads > stats.quadPeak) {
        stats.quadPeak = quads;
      }
    },

    probe(nowMs) {
      return trailPhaseProbe(strokes.values(), nowMs);
    },

    stats() {
      return { ...stats };
    }
  };
}
