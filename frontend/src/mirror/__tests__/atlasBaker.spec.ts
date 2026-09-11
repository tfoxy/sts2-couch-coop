import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetAtlasCacheForTest, drawAtlasRegion, preloadAtlas } from "@/mirror/atlasBaker";

// A controllable fake Image: capture instances so a test can fire load when it wants.
let images: FakeImage[] = [];
class FakeImage {
  onloadHandlers: Array<() => void> = [];
  onerrorHandlers: Array<() => void> = [];
  decoding = "";
  crossOrigin = "";
  private _src = "";
  constructor() {
    images.push(this);
  }
  addEventListener(type: string, cb: () => void): void {
    if (type === "load") this.onloadHandlers.push(cb);
    if (type === "error") this.onerrorHandlers.push(cb);
  }
  // The real Image detaches both handlers once the page settles (no per-session listener per atlas) — a fake
  // without this would throw the moment the production code cleans up.
  removeEventListener(type: string, cb: () => void): void {
    const list = type === "load" ? this.onloadHandlers : this.onerrorHandlers;
    const i = list.indexOf(cb);
    if (i >= 0) list.splice(i, 1);
  }
  set src(v: string) {
    this._src = v;
  }
  get src(): string {
    return this._src;
  }
  fireLoad(): void {
    for (const cb of this.onloadHandlers) cb();
  }
}

function fakeCtx(): { ctx: CanvasRenderingContext2D; draws: unknown[][] } {
  const draws: unknown[][] = [];
  const ctx = { drawImage: (...args: unknown[]) => draws.push(args) } as unknown as CanvasRenderingContext2D;
  return { ctx, draws };
}

beforeEach(() => {
  __resetAtlasCacheForTest();
  images = [];
  vi.stubGlobal("Image", FakeImage as unknown as typeof Image);
  // No createImageBitmap → the baker falls back to the HTMLImageElement source (simpler to assert).
  vi.stubGlobal("createImageBitmap", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const region = { x: 10, y: 20, width: 30, height: 40 };

describe("drawAtlasRegion", () => {
  it("preloadAtlas starts the same load later used by drawAtlasRegion", () => {
    preloadAtlas("/atlas.png");

    expect(images.length).toBe(1);
    expect(images[0].src).toBe("/atlas.png");

    images[0].fireLoad();

    const { ctx, draws } = fakeCtx();
    expect(drawAtlasRegion(ctx, "/atlas.png", region, () => {})).toBe(true);
    expect(images.length).toBe(1);
    expect(draws[0].slice(1)).toEqual([10, 20, 30, 40, 0, 0, 30, 40]);
  });

  it("defers the draw until the atlas loads, then draws the region (and calls onReady once)", () => {
    const { ctx, draws } = fakeCtx();
    let ready = 0;
    const drawn = drawAtlasRegion(ctx, "/atlas.png", region, () => (ready += 1));
    expect(drawn).toBe(false); // atlas not decoded yet
    expect(draws.length).toBe(0);
    expect(images.length).toBe(1); // one load kicked off

    images[0].fireLoad();
    expect(ready).toBe(1); // onReady fired so the caller can redraw
  });

  it("draws synchronously once the atlas is loaded (no new load, region mapped to 0,0)", () => {
    drawAtlasRegion(fakeCtx().ctx, "/atlas.png", region, () => {});
    images[0].fireLoad();

    const { ctx, draws } = fakeCtx();
    const drawn = drawAtlasRegion(ctx, "/atlas.png", region, () => {});
    expect(drawn).toBe(true);
    expect(images.length).toBe(1); // atlas fetched ONCE (no second Image)
    // drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh)
    expect(draws[0].slice(1)).toEqual([10, 20, 30, 40, 0, 0, 30, 40]);
  });

  it("an animated icon (different region, same atlas) draws synchronously with new source coords", () => {
    drawAtlasRegion(fakeCtx().ctx, "/atlas.png", region, () => {});
    images[0].fireLoad();

    const { ctx, draws } = fakeCtx();
    const frame2 = { x: 100, y: 0, width: 30, height: 40 };
    expect(drawAtlasRegion(ctx, "/atlas.png", frame2, () => {})).toBe(true);
    expect(images.length).toBe(1); // STILL one atlas — no re-fetch/re-decode for the new frame
    expect(draws[0].slice(1, 5)).toEqual([100, 0, 30, 40]);
  });
});
