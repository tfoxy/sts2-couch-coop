import { describe, expect, it } from "vitest";
import { RUST_FAST_SWITCHES, resolveRustFastFlags } from "./rustFastFlags";

const flags = (query: string, backend: "pixi" | "rust" = "rust") => resolveRustFastFlags(new URLSearchParams(query), backend);
const items = Object.keys(RUST_FAST_SWITCHES) as Array<keyof typeof RUST_FAST_SWITCHES>;

describe("resolveRustFastFlags", () => {
  it("is all on by default for Rust, but never verify", () => {
    for (const query of ["", "rustFast=1"]) {
      const resolved = flags(query);
      for (const key of items) expect(resolved[key]).toBe(true);
      expect(resolved.verify).toBe(false);
    }
  });

  it("turns every item off under rustFast=0", () => {
    const resolved = flags("rustFast=0");
    for (const key of items) expect(resolved[key]).toBe(false);
  });

  it("lets an explicit zero turn one item back off", () => {
    const resolved = flags("rustHiddenMemo=0");
    expect(resolved.hiddenMemo).toBe(false);
    expect(resolved.lazyComposition).toBe(true);
  });

  it("turns the spread-aware hidden memo off on its own, leaving the memo on", () => {
    const resolved = flags("rustHiddenMemoSpread=0");
    expect(resolved.hiddenMemoSpread).toBe(false);
    expect(resolved.hiddenMemo).toBe(true);
    expect(flags("rustFast=0&rustHiddenMemo=1").hiddenMemoSpread).toBe(false);
  });

  it("turns one-build-per-frame coalescing off on its own", () => {
    expect(flags("rustCoalescedBuilds=0").coalescedBuilds).toBe(false);
    expect(flags("rustCoalescedBuilds=0").heldOverridePatch).toBe(true);
    expect(flags("rustFast=0&rustCoalescedBuilds=1").coalescedBuilds).toBe(true);
    expect(flags("rustFast=1", "pixi").coalescedBuilds).toBe(false);
  });

  it("turns the cosmetic-offset patch off on its own", () => {
    expect(flags("rustOffsetPatch=0").offsetPatch).toBe(false);
    expect(flags("rustOffsetPatch=0").coalescedBuilds).toBe(true);
    expect(flags("rustFast=0&rustOffsetPatch=1").offsetPatch).toBe(true);
  });

  it("enables one item without the umbrella", () => {
    const resolved = flags("rustFast=0&rustLazyComposition=1&rustFastVerify=1");
    expect(resolved.lazyComposition).toBe(true);
    expect(resolved.hiddenMemo).toBe(false);
    expect(resolved.verify).toBe(true);
  });

  it("keeps Pixi on its own paint-order switch only", () => {
    expect(flags("rustFast=1", "pixi").paintOrderReuse).toBe(false);
    const pixi = flags("rustFast=1&ccPaintOrderReuse=1&rustLazyComposition=1&rustFastVerify=1", "pixi");
    expect(pixi.paintOrderReuse).toBe(true);
    expect(pixi.lazyComposition).toBe(false);
    expect(pixi.verify).toBe(false);
  });
});
