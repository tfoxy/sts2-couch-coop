import { describe, expect, it } from "vitest";
import { RUST_FAST_SWITCHES, resolveRustFastFlags, resolveRustPresentMode } from "./rustFastFlags";

const flags = (query: string, backend: "pixi" | "rust" = "rust") => resolveRustFastFlags(new URLSearchParams(query), backend);
const items = Object.keys(RUST_FAST_SWITCHES) as Array<keyof typeof RUST_FAST_SWITCHES>;
const presentMode = (query: string, backend: "pixi" | "rust" = "rust") => resolveRustPresentMode(new URLSearchParams(query), backend);

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

  it("turns the spread-aware wire patch off on its own", () => {
    expect(flags("rustWireSpreadPatch=0").wireSpreadPatch).toBe(false);
    expect(flags("rustWireSpreadPatch=0").offsetPatch).toBe(true);
    expect(flags("rustFast=0&rustWireSpreadPatch=1").wireSpreadPatch).toBe(true);
    expect(flags("rustFast=1", "pixi").wireSpreadPatch).toBe(false);
  });

  it("turns the damage present off on its own", () => {
    expect(flags("rustDamagePresent=0").damagePresent).toBe(false);
    expect(flags("rustDamagePresent=0").tweenRootPatch).toBe(true);
    expect(flags("rustFast=0&rustDamagePresent=1").damagePresent).toBe(true);
    expect(flags("rustFast=1", "pixi").damagePresent).toBe(false);
  });

  it("turns the tween-root patch off on its own", () => {
    expect(flags("rustTweenRootPatch=0").tweenRootPatch).toBe(false);
    expect(flags("rustTweenRootPatch=0").heldOverridePatch).toBe(true);
    expect(flags("rustFast=0&rustTweenRootPatch=1").tweenRootPatch).toBe(true);
    expect(flags("rustFast=1", "pixi").tweenRootPatch).toBe(false);
  });

  it("turns the bounded Bitmap text cache off on its own", () => {
    expect(flags("rustTextEvict=0").textEvict).toBe(false);
    expect(flags("rustTextEvict=0").tweenRootPatch).toBe(true);
    expect(flags("rustFast=0&rustTextEvict=1").textEvict).toBe(true);
    expect(flags("rustFast=1", "pixi").textEvict).toBe(false);
  });

  it("turns the text-only patch off on its own", () => {
    expect(flags("").textPatch).toBe(true);
    expect(flags("rustTextPatch=0").textPatch).toBe(false);
    expect(flags("rustTextPatch=0").textEvict).toBe(true);
    expect(flags("rustFast=0").textPatch).toBe(false);
    expect(flags("rustFast=0&rustTextPatch=1").textPatch).toBe(true);
    expect(flags("rustFast=1", "pixi").textPatch).toBe(false);
  });

  it("turns the idle scheduler off on its own", () => {
    expect(flags("").idleScheduler).toBe(true);
    expect(flags("rustIdleScheduler=0").idleScheduler).toBe(false);
    expect(flags("rustIdleScheduler=0").coalescedBuilds).toBe(true);
    expect(flags("rustFast=0").idleScheduler).toBe(false);
    expect(flags("rustFast=0&rustIdleScheduler=1").idleScheduler).toBe(true);
    expect(flags("rustFast=1", "pixi").idleScheduler).toBe(false);
  });

  it("turns the due-frame idle wake off on its own", () => {
    expect(flags("").idleDueFrame).toBe(true);
    expect(flags("rustIdleDueFrame=0").idleDueFrame).toBe(false);
    expect(flags("rustIdleDueFrame=0").idleScheduler).toBe(true);
    expect(flags("rustFast=0").idleDueFrame).toBe(false);
    expect(flags("rustFast=0&rustIdleDueFrame=1").idleDueFrame).toBe(true);
    expect(flags("rustFast=1", "pixi").idleDueFrame).toBe(false);
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

describe("resolveRustPresentMode", () => {
  it("defaults to preserved-desync and is unaffected by the rustFast umbrella", () => {
    expect(presentMode("")).toBe("preserved-desync");
    expect(presentMode("rustFast=1")).toBe("preserved-desync");
    expect(presentMode("rustFast=0")).toBe("preserved-desync");
  });

  it("resolves each recognized mode for the Rust backend", () => {
    for (const mode of ["surface", "direct", "preserved", "preserved-desync"]) expect(presentMode(`rustPresent=${mode}`)).toBe(mode);
  });

  it("falls back to preserved-desync on an unrecognized value", () => {
    expect(presentMode("rustPresent=bogus")).toBe("preserved-desync");
  });

  it("stays surface for Pixi regardless of the query", () => {
    expect(presentMode("rustPresent=direct", "pixi")).toBe("surface");
  });

  it("reads independently of rustFast=0, unlike the umbrella items", () => {
    expect(presentMode("rustFast=0&rustPresent=preserved")).toBe("preserved");
  });
});
