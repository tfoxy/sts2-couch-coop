// DON'T REPAINT A PICTURE THAT DID NOT CHANGE (R21 B1).
//
// THE PROBLEM. `canvasRenderer.paint()` is unconditional and total: `executor.execute(list, projection,
// { clear: true })` clears the whole framebuffer and re-issues every command, on every wire delta and on every
// animation frame — including the tier-3 patch frames, which deliberately skip only `runBuild`.
//
// THE COMPOSITOR-SIDE MOTIVATION THIS WAS SCOPED FROM NO LONGER MEASURES — read this before quoting it. The
// scoping capture (Sep-3 Firefox, software WebRender) measured the maximal picture-cache tile count discarded on
// 37 of 44 frames, i.e. the browser re-rasterising the whole screen for a picture identical to the one already
// on it. A controlled ABBA re-measurement on `a525ca9` (Track A, R21), same software-WebRender condition, found
// that gone: the canvas stage invalidates **1** tile with **4** draw calls and composites in 8-15 ms, while the
// DOM stage invalidates 3-5 tiles with ~161 draw calls and composites in 76-144 ms. On current code the canvas
// stage is the CHEAP compositor path, not the expensive one. The likely fix is `a21db1a` (stage canvas out of
// the scaled subtree), which landed between the two measurements; that attribution is inferred, not proven.
//
// So do not sell this lever as fixing a compositor problem. Its honest value is (a) the JS-side paint it avoids
// and (b) not waking the compositor at all on screens that really are static — which the measured skip rates
// below say is a map/shop/rewards win, not a combat one.
//
// WHY SKIPPING WORKS AT ALL — the one fact this module rests on. The stage's WebGL context is created WITHOUT
// `preserveDrawingBuffer`, so the DRAWING BUFFER is cleared after each composite; but the COMPOSITED COPY — what
// the user is looking at — persists until the canvas is drawn into again. That is why a WebGL canvas that draws
// one frame and never again keeps showing that frame, and it is the same fact `canvasSnapshot` documents from the
// other side ("the compositor's own copy is what a headed capture reads; headless has no such copy"). A frame we
// do not paint is a frame the compositor does not re-rasterise, which is the whole win.
//
// SO THE QUESTION THIS MODULE ANSWERS, and it is deliberately narrow: *would re-executing this draw list, right
// now, put exactly the same pixels on the framebuffer as the last execute that really ran?* Not "did the scene
// change" and not "did the state revision move" — those are proxies, and a proxy that is wrong once paints a
// stale frame. Everything `execute` reads is compared for real:
//
//   THE LIST      — command count, kinds, the float and int arenas, the colour-matrix arena, and the TEXTURE
//                   HANDLE per command (the one object side-array; a typed-array compare cannot see it).
//   THE PROJECTION— `toClip`, `toFramebuffer` and the framebuffer size. A design-size change that rounds to the
//                   same backing store moves `toClip` and nothing else, and `resize` returns early without
//                   repainting, so this is not covered by anything upstream.
//   THE EPOCH     — an opaque, caller-supplied number standing for everything that can change the PIXELS BEHIND
//                   AN UNCHANGED HANDLE: an upload into an existing texture, an atlas page region write, a
//                   re-spec, an eviction. See `canvasRenderer.paintPixelEpoch`.
//
// …and anything that cannot be expressed as one of those three is the caller's job to name, by calling
// {@link PaintGuard.invalidate}. There are five such paths and each is listed at its call site.
//
// THE COMPARISON IS EXACT — `===` on every number, never a tolerance. A tolerance here would be a licence to
// leave a moved pixel on screen; the verify arm's 1e-6 gate exists to price float drift between two INDEPENDENT
// computations of the same frame, which is a different question. A false "changed" costs one paint we did not
// need; a false "unchanged" is a stale frame. The asymmetry decides every judgement call in this file.
//
// THE ARENAS ARE COMPARED AT FULL CAPACITY, tail included, rather than at the used length. `DrawList` does not
// publish its write cursor, and the tail is not garbage that can differ on its own: both sides come from the same
// buffer, so an identical prefix implies an identical tail unless the buffer GREW — which is a length change, and
// is answered as "changed". Conservative in the safe direction, and it costs one linear scan of a few hundred
// kilobytes against a paint of several milliseconds.

import type { DrawList, StageProjection } from "@godot-scene-web/canvas";

export interface PaintGuardStats {
  /** Paints skipped because the picture was already on screen. */
  skipped: number;
  /** Frames the guard was ASKED about — `skipped / asked` is the lever's whole value on a screen. */
  asked: number;
  /** Of those, the ones that had no banked picture to compare against (the first paint, and every invalidate). */
  cold: number;
  /** Milliseconds spent comparing, summed. Divided by `asked` this is what the lever COSTS per frame. */
  compareMs: number;
  /** Milliseconds spent banking, summed — paid only on frames that really painted. */
  bankMs: number;
}

export interface PaintGuard<TTexture> {
  readonly stats: PaintGuardStats;
  /**
   * Would executing `list` against `projection` now draw exactly what the banked paint drew?
   *
   * False whenever the answer is not a certainty — including the cold case, a grown arena, and a moved epoch.
   */
  unchanged(list: DrawList<TTexture>, projection: StageProjection, epoch: number): boolean;
  /**
   * Bank what was just drawn. THE CALLER MUST ONLY CALL THIS AFTER AN `execute` THAT RETURNED TRUE: a frame the
   * executor refused (an unlinked program, a lost context) put nothing on screen, and banking it would make the
   * guard skip forever against a picture that was never painted.
   */
  bank(list: DrawList<TTexture>, projection: StageProjection, epoch: number): void;
  /** The framebuffer no longer holds the banked picture (a clear, a context loss, a source we cannot see). */
  invalidate(): void;
}

/** `performance.now`, or a monotonic-enough fallback for a jsdom spec that has no `performance`. */
function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

export function createPaintGuard<TTexture>(): PaintGuard<TTexture> {
  const stats: PaintGuardStats = { skipped: 0, asked: 0, cold: 0, compareMs: 0, bankMs: 0 };

  let valid = false;
  let count = 0;
  let epochAt = 0;
  let floats = new Float32Array(0);
  let ints = new Int32Array(0);
  let matrices = new Float32Array(0);
  let kinds = new Int32Array(0);
  // The ONE object side-array, and the reason a pure typed-array compare is not enough: an atlas re-pack or a
  // texture reload hands the same command a DIFFERENT handle while every number in the arenas stays put.
  let textures: (TTexture | null)[] = [];
  const toClip = new Float32Array(4);
  const toFramebuffer = new Float32Array(6);
  let fbW = 0;
  let fbH = 0;

  function projectionMatches(projection: StageProjection): boolean {
    if (fbW !== projection.framebufferWidth || fbH !== projection.framebufferHeight) {
      return false;
    }
    for (let i = 0; i < 4; i++) {
      if (toClip[i] !== projection.toClip[i]) {
        return false;
      }
    }
    for (let i = 0; i < 6; i++) {
      if (toFramebuffer[i] !== projection.toFramebuffer[i]) {
        return false;
      }
    }
    return true;
  }

  function sameFloats(was: Float32Array, now: Float32Array): boolean {
    if (was.length !== now.length) {
      return false;
    }
    for (let i = 0; i < now.length; i++) {
      if (was[i] !== now[i]) {
        return false;
      }
    }
    return true;
  }

  function sameInts(was: Int32Array, now: Int32Array): boolean {
    if (was.length !== now.length) {
      return false;
    }
    for (let i = 0; i < now.length; i++) {
      if (was[i] !== now[i]) {
        return false;
      }
    }
    return true;
  }

  return {
    stats,

    unchanged(list, projection, epoch) {
      stats.asked++;
      if (!valid) {
        stats.cold++;
        return false;
      }
      const t0 = nowMs();
      // CHEAPEST FIRST, and every one of these is a whole-picture answer: the epoch (one integer compare) covers
      // every texture upload since the last paint, the projection covers every resize, and the count covers the
      // overwhelming majority of real scene changes before a single arena element is read.
      let same = epochAt === epoch && projectionMatches(projection) && count === list.count;
      if (same) {
        for (let i = 0; i < count; i++) {
          if (kinds[i] !== list.kindAt(i) || textures[i] !== list.textureAt(i)) {
            same = false;
            break;
          }
        }
      }
      if (same) {
        same =
          sameFloats(floats, list.floats) &&
          sameInts(ints, list.ints) &&
          sameFloats(matrices, list.colorMatrices);
      }
      stats.compareMs += nowMs() - t0;
      if (same) {
        stats.skipped++;
      }
      return same;
    },

    bank(list, projection, epoch) {
      const t0 = nowMs();
      count = list.count;
      epochAt = epoch;
      if (floats.length !== list.floats.length) {
        floats = new Float32Array(list.floats.length);
      }
      floats.set(list.floats);
      if (ints.length !== list.ints.length) {
        ints = new Int32Array(list.ints.length);
      }
      ints.set(list.ints);
      if (matrices.length !== list.colorMatrices.length) {
        matrices = new Float32Array(list.colorMatrices.length);
      }
      matrices.set(list.colorMatrices);
      if (kinds.length < count) {
        kinds = new Int32Array(Math.max(count, kinds.length * 2));
      }
      if (textures.length < count) {
        textures = new Array<TTexture | null>(Math.max(count, textures.length * 2)).fill(null);
      }
      for (let i = 0; i < count; i++) {
        kinds[i] = list.kindAt(i);
        textures[i] = list.textureAt(i);
      }
      // RELEASE THE TAIL's handles. `textures` is grown by doubling and never shrinks, so a screen that once drew
      // 3000 commands would otherwise hold references to 3000 texture wrappers for the rest of the session — long
      // after the residency clock deleted the GL objects behind them.
      for (let i = count; i < textures.length; i++) {
        textures[i] = null;
      }
      toClip.set(projection.toClip.subarray(0, 4));
      toFramebuffer.set(projection.toFramebuffer.subarray(0, 6));
      fbW = projection.framebufferWidth;
      fbH = projection.framebufferHeight;
      valid = true;
      stats.bankMs += nowMs() - t0;
    },

    invalidate() {
      valid = false;
      // …and drop the handles with it: an invalidate is usually a context loss or a teardown, which is exactly
      // when holding a dead texture wrapper is least welcome.
      textures.fill(null);
    }
  };
}
