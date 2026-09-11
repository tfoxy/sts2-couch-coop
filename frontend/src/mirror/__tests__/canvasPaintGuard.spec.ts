// THE EQUALITY TEST ITSELF — `paintGuard.ts`, in isolation (R21 B1).
//
// This module decides whether a frame gets painted, so the only interesting question about it is what it lets
// through. A false "changed" costs one paint nobody needed; a false "unchanged" leaves a STALE PICTURE on screen
// and there is no later frame that fixes it — the next delta whose list also matches is skipped too. Every case
// below is therefore written as "here is one thing that moved; the guard must NOT say unchanged", and the one
// happy-path case is deliberately outnumbered.
//
// The cases that a naive implementation gets wrong, and which no amount of arena comparison would catch:
//   * the TEXTURE HANDLE — the draw list's one object side-array. Same floats, same ints, different pixels.
//   * the KIND — a `clipPop` at the end of a list writes no payload at all, so a list that ends in one and a list
//     that does not can have byte-identical arenas.
//   * the PROJECTION — a design-size change that rounds to the same backing store moves `toClip` and nothing else,
//     and `canvasRenderer.resize` returns early without repainting on exactly that case.
//   * the EPOCH — an upload into a texture the list already names.
//
// `canvasPaintSkip.spec` owns the other half: that the renderer really hands this module those four things, and
// that a skipped paint still acks.

import { describe, expect, it } from "vitest";
import {
  createDrawList,
  createQuadView,
  type DrawList,
  type StageProjection
} from "@godot-scene-web/canvas";

import { createPaintGuard } from "@/mirror/canvas/paintGuard";

/** A stand-in for `ExecutorTexture`: the guard only ever compares handles by identity. */
type Handle = { id: string };

function projection(over: Partial<{ clipX: number; fbW: number; fbH: number; toFbX: number }> = {}): StageProjection {
  const toClip = new Float32Array([over.clipX ?? 2 / 1920, -2 / 1080, -1, 1]);
  const toFramebuffer = new Float32Array([over.toFbX ?? 1, 0, 0, 1, 0, 0]);
  return {
    designWidth: 1920,
    designHeight: 1080,
    toClip,
    toFramebuffer,
    framebufferWidth: over.fbW ?? 1920,
    framebufferHeight: over.fbH ?? 1080
  };
}

interface QuadSpec {
  x?: number;
  y?: number;
  a?: number;
  texture?: Handle | null;
}

/** Refill `list` from scratch — the shape `runBuild` produces: `reset()` then push, into the same buffers. */
function fill(list: DrawList<Handle | null>, quads: readonly QuadSpec[], opts: { trailingClip?: boolean } = {}): void {
  list.reset();
  const view = createQuadView();
  for (const spec of quads) {
    view.m[0] = 1;
    view.m[1] = 0;
    view.m[2] = 0;
    view.m[3] = 1;
    view.m[4] = spec.x ?? 0;
    view.m[5] = spec.y ?? 0;
    view.w = 100;
    view.h = 40;
    view.srcX = 0;
    view.srcY = 0;
    view.srcW = 1;
    view.srcH = 1;
    view.r = 1;
    view.g = 1;
    view.b = 1;
    view.a = spec.a ?? 1;
    list.pushQuad(view, spec.texture ?? null);
  }
  if (opts.trailingClip) {
    // A clip PUSH then POP: the pop writes no payload of its own, which is the whole point of the kind case.
    list.pushClipRect({ x: 0, y: 0, w: 10, h: 10, cornerRadius: 0, outsetX: 0 });
    list.popClip();
  }
}

const RED: Handle = { id: "red" };
const BLUE: Handle = { id: "blue" };

/** A guard with one frame already on screen, plus the list it was banked from. */
function banked(quads: readonly QuadSpec[] = [{ x: 10, texture: RED }, { x: 20, texture: BLUE }], epoch = 7) {
  const guard = createPaintGuard<Handle | null>();
  const list = createDrawList<Handle | null>();
  fill(list, quads);
  const proj = projection();
  guard.bank(list, proj, epoch);
  return { guard, list, proj, epoch };
}

describe("the paint guard's equality test", () => {
  it("is COLD before anything is banked — the first paint of a session always runs", () => {
    const guard = createPaintGuard<Handle | null>();
    const list = createDrawList<Handle | null>();
    fill(list, [{ x: 10, texture: RED }]);
    expect(guard.unchanged(list, projection(), 0)).toBe(false);
    expect(guard.stats.cold).toBe(1);
    expect(guard.stats.skipped).toBe(0);
  });

  it("says UNCHANGED when the list is rebuilt to the same thing", () => {
    const { guard, list, proj, epoch } = banked();
    // REBUILT, not merely re-read: `reset()` rewinds the cursors and the same buffers are refilled, which is what
    // a real `runBuild` does to an idle screen. If the guard were comparing buffer identity rather than content
    // this would pass for the wrong reason, so the refill is the point.
    fill(list, [{ x: 10, texture: RED }, { x: 20, texture: BLUE }]);
    expect(guard.unchanged(list, proj, epoch)).toBe(true);
    expect(guard.stats.skipped).toBe(1);
  });

  it("says CHANGED when a float moved — one pixel of translation", () => {
    const { guard, list, proj, epoch } = banked();
    fill(list, [{ x: 11, texture: RED }, { x: 20, texture: BLUE }]);
    expect(guard.unchanged(list, proj, epoch)).toBe(false);
  });

  it("says CHANGED when only an ALPHA moved — the tier-3 patch frame's whole vocabulary", () => {
    const { guard, list, proj, epoch } = banked();
    fill(list, [{ x: 10, a: 0.5, texture: RED }, { x: 20, texture: BLUE }]);
    expect(guard.unchanged(list, proj, epoch)).toBe(false);
  });

  it("says CHANGED when a command was added or removed", () => {
    const { guard, list, proj, epoch } = banked();
    fill(list, [{ x: 10, texture: RED }]);
    expect(guard.unchanged(list, proj, epoch)).toBe(false);
  });

  it("says CHANGED when only the TEXTURE HANDLE moved — the case a typed-array compare cannot see", () => {
    const { guard, list, proj, epoch } = banked();
    // Every number is identical; an atlas re-pack handed the same quad a different page. Painting this list now
    // draws different pixels, and nothing in `floats`/`ints` says so.
    fill(list, [{ x: 10, texture: BLUE }, { x: 20, texture: BLUE }]);
    expect(guard.unchanged(list, proj, epoch)).toBe(false);
  });

  it("says CHANGED when a command KIND moved", () => {
    const { guard, list, proj, epoch } = banked();
    fill(list, [{ x: 10, texture: RED }, { x: 20, texture: BLUE }], { trailingClip: true });
    expect(guard.unchanged(list, proj, epoch)).toBe(false);
  });

  it("says CHANGED when the projection moved, even at an unchanged framebuffer size", () => {
    const { guard, list, proj, epoch } = banked();
    fill(list, [{ x: 10, texture: RED }, { x: 20, texture: BLUE }]);
    expect(guard.unchanged(list, proj, epoch)).toBe(true); // control: it is the projection that decides below
    // The design box changed but rounded to the same backing store — `resize` returns early and does NOT repaint,
    // so a guard that only watched `framebufferWidth/Height` would leave the old scale on screen.
    expect(guard.unchanged(list, projection({ clipX: 2 / 1900 }), epoch)).toBe(false);
    expect(guard.unchanged(list, projection({ fbW: 1280 }), epoch)).toBe(false);
    expect(guard.unchanged(list, projection({ toFbX: 0.75 }), epoch)).toBe(false);
  });

  it("says CHANGED when the pixel epoch moved — an upload into a texture the list already names", () => {
    const { guard, list, proj, epoch } = banked();
    fill(list, [{ x: 10, texture: RED }, { x: 20, texture: BLUE }]);
    expect(guard.unchanged(list, proj, epoch + 1)).toBe(false);
  });

  it("goes cold on `invalidate` — a clear, a lost context, a source we cannot see", () => {
    const { guard, list, proj, epoch } = banked();
    fill(list, [{ x: 10, texture: RED }, { x: 20, texture: BLUE }]);
    guard.invalidate();
    expect(guard.unchanged(list, proj, epoch)).toBe(false);
    // …and it stays honest afterwards: banking again re-arms it.
    guard.bank(list, proj, epoch);
    expect(guard.unchanged(list, proj, epoch)).toBe(true);
  });

  it("does not go stale across a GROWN arena — a longer list then the original again", () => {
    const { guard, list, proj, epoch } = banked();
    // Grow past the initial capacity so `list.floats` is REALLOCATED, then come back to the two-quad list. The
    // banked copy is now shorter than the live arena; the tail of the live one still holds the long list's
    // numbers. A guard that compared only a prefix would call this unchanged and leave 200 quads on screen.
    const many: QuadSpec[] = [];
    for (let i = 0; i < 200; i++) {
      many.push({ x: i, texture: RED });
    }
    fill(list, many);
    expect(guard.unchanged(list, proj, epoch)).toBe(false);
    guard.bank(list, proj, epoch);

    fill(list, [{ x: 10, texture: RED }, { x: 20, texture: BLUE }]);
    expect(guard.unchanged(list, proj, epoch)).toBe(false);
  });

  it("counts what it did — `asked`, `cold` and `skipped` are three different facts", () => {
    const guard = createPaintGuard<Handle | null>();
    const list = createDrawList<Handle | null>();
    const proj = projection();
    fill(list, [{ x: 1, texture: RED }]);

    expect(guard.unchanged(list, proj, 0)).toBe(false); // cold
    guard.bank(list, proj, 0);
    expect(guard.unchanged(list, proj, 0)).toBe(true); // skipped
    fill(list, [{ x: 2, texture: RED }]);
    expect(guard.unchanged(list, proj, 0)).toBe(false); // compared and differed

    expect(guard.stats.asked).toBe(3);
    expect(guard.stats.cold).toBe(1);
    expect(guard.stats.skipped).toBe(1);
  });
});
