// One-shot image loads must not leave a listener behind.
//
// A census of a live phone mirror session counted 381 live JS event listeners where the app's own wiring is ~30.
// The rest were `load`/`error` handlers on the throwaway `Image`s the two texture caches use to measure a natural
// size / decode an atlas page: one (or two) per DISTINCT texture url, registered for the life of the session, each
// keeping its Image alive with it. The load itself is a single event, so both handlers come off once it settles.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetAtlasCacheForTest, preloadAtlas } from "@/mirror/atlasBaker";
import { warmImage } from "@/mirror/textureCache";

let images: FakeImage[] = [];

class FakeImage {
  handlers: Record<string, Array<() => void>> = {};
  decoding = "";
  crossOrigin = "";
  src = "";
  naturalWidth = 64;
  naturalHeight = 32;
  constructor() {
    images.push(this);
  }
  addEventListener(type: string, cb: () => void): void {
    (this.handlers[type] ??= []).push(cb);
  }
  removeEventListener(type: string, cb: () => void): void {
    const list = this.handlers[type] ?? [];
    const i = list.indexOf(cb);
    if (i >= 0) list.splice(i, 1);
  }
  fire(type: string): void {
    for (const cb of [...(this.handlers[type] ?? [])]) cb();
  }
  /** Every handler still registered, across all event types. */
  liveListeners(): number {
    return Object.values(this.handlers).reduce((a, l) => a + l.length, 0);
  }
}

beforeEach(() => {
  images = [];
  __resetAtlasCacheForTest();
  vi.stubGlobal("Image", FakeImage as unknown as typeof Image);
  vi.stubGlobal("createImageBitmap", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetAtlasCacheForTest();
});

describe("image listener hygiene", () => {
  it("textureCache.warmImage detaches both handlers once the load settles", () => {
    warmImage("/res/images/probe-hygiene-a.png");
    expect(images.length).toBe(1);
    expect(images[0].liveListeners()).toBe(2); // load + error, while it is in flight

    images[0].fire("load");
    expect(images[0].liveListeners()).toBe(0);
  });

  it("…and after a FAILED load too (a 404 sprite must not pin a listener for the session)", () => {
    warmImage("/res/images/probe-hygiene-b.png");
    images[0].fire("error");
    expect(images[0].liveListeners()).toBe(0);
  });

  it("atlasBaker's page load detaches both handlers on success and on failure", () => {
    preloadAtlas("/atlas-hygiene-a.png");
    expect(images[0].liveListeners()).toBe(2);
    images[0].fire("load");
    expect(images[0].liveListeners()).toBe(0);

    preloadAtlas("/atlas-hygiene-b.png");
    expect(images[1].liveListeners()).toBe(2);
    images[1].fire("error");
    expect(images[1].liveListeners()).toBe(0);
  });
});
