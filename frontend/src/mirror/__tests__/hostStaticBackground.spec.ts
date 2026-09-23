import { describe, expect, it } from "vitest";

import {
  admitHostStaticBackground,
  sameStaticBackground,
  type HostStaticBackgroundLatch
} from "@/mirror/hostStaticBackground";

// A SEAT VIEWER SHOWS THE HOST'S STATIC BACKGROUND. The seat's descriptor only says which scene is mounted; the
// host's supplies the picture, admitted while it names that scene. These pin the admission rule and its latch.

const NEOW = "res://scenes/events/background_scenes/neow.tscn";
const UNDERDOCKS = "res://scenes/backgrounds/underdocks/underdocks_background.tscn";
const SHOP = "res://scenes/rooms/merchant_room.tscn";

const seat = (scenePath: string) => ({ scenePath, url: `/bg/seat?frame=seat&p=${scenePath}` });
const host = (scenePath: string, frame = "host") => ({ scenePath, url: `/bg/host?frame=${frame}&p=${scenePath}` });

describe("admitHostStaticBackground", () => {
  it("admits the host's descriptor — never the seat's — when both name the same scene", () => {
    for (const scenePath of [NEOW, UNDERDOCKS, SHOP]) {
      const h = host(scenePath);
      const out = admitHostStaticBackground(seat(scenePath), h, null);
      expect(out.descriptor).toBe(h);
      expect(out.latch).toEqual({ scenePath, descriptor: h });
    }
  });

  it("shows nothing when the seat has mounted a scene the host has not described (seat ahead)", () => {
    expect(admitHostStaticBackground(seat(UNDERDOCKS), host(NEOW), null)).toEqual({ descriptor: null, latch: null });
    expect(admitHostStaticBackground(seat(UNDERDOCKS), null, null)).toEqual({ descriptor: null, latch: null });
  });

  it("shows nothing when the seat names no scene, whatever the host has", () => {
    const latch: HostStaticBackgroundLatch = { scenePath: NEOW, descriptor: host(NEOW) };
    expect(admitHostStaticBackground(null, host(NEOW), latch)).toEqual({ descriptor: null, latch: null });
    expect(admitHostStaticBackground(undefined, undefined, null)).toEqual({ descriptor: null, latch: null });
  });

  it("keeps the last admitted host descriptor while the seat stays on that scene (host ahead)", () => {
    const first = admitHostStaticBackground(seat(NEOW), host(NEOW), null);
    // The host has moved on to the next room; the seat has not.
    const ahead = admitHostStaticBackground(seat(NEOW), host(UNDERDOCKS), first.latch);
    expect(ahead.descriptor).toBe(first.descriptor);
    expect(ahead.latch).toBe(first.latch);
    // …or briefly describes nothing at all.
    expect(admitHostStaticBackground(seat(NEOW), null, first.latch).descriptor).toBe(first.descriptor);
    // The seat catches up: the host's descriptor for the new scene is admitted and replaces the latch.
    const caughtUp = admitHostStaticBackground(seat(UNDERDOCKS), host(UNDERDOCKS), ahead.latch);
    expect(caughtUp.descriptor).toEqual(host(UNDERDOCKS));
    expect(caughtUp.latch?.scenePath).toBe(UNDERDOCKS);
  });

  it("drops the latch the moment the seat moves to another scene", () => {
    const first = admitHostStaticBackground(seat(NEOW), host(NEOW), null);
    expect(admitHostStaticBackground(seat(SHOP), host(NEOW), first.latch)).toEqual({ descriptor: null, latch: null });
  });

  it("takes a newer host descriptor for the same scene (a re-publish under a new frame)", () => {
    const first = admitHostStaticBackground(seat(SHOP), host(SHOP, "a"), null);
    const second = admitHostStaticBackground(seat(SHOP), host(SHOP, "b"), first.latch);
    expect(second.descriptor?.url).toContain("frame=b");
  });
});

describe("sameStaticBackground", () => {
  it("compares by scene and url, not identity", () => {
    expect(sameStaticBackground(host(NEOW), host(NEOW))).toBe(true);
    expect(sameStaticBackground(host(NEOW, "a"), host(NEOW, "b"))).toBe(false);
    expect(sameStaticBackground(null, null)).toBe(true);
    expect(sameStaticBackground(host(NEOW), null)).toBe(false);
  });
});
