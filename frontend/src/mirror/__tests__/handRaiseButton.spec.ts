import { nextTick, shallowRef } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MirrorHandRaiseButton from "@/mirror/MirrorHandRaiseButton.vue";
import { __resetHandRaiseUiForTest, effectiveRaiseHandCards, handRaiseUi, setHandRaiseLayer } from "@/mirror/handRaiseUi";
import { HAND_RAISE_BOX } from "@/mirror/handRaiseChrome";
import type { MirrorRenderer } from "@/mirror/mirrorRenderer";
import { MIRROR_RENDERER_KEY } from "@/mirror/rendererKey";
import { clearStoredMirrorSettings, mirrorSettings, readStoredMirrorSettings } from "@/mirror/mirrorSettings";

vi.mock("@/mirror/atlasSprite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/atlasSprite")>();
  return {
    ...actual,
    resolveAtlasSprite: vi.fn(async () => ({
      pageUrl: "/res/ui.png",
      region: { x: 10, y: 20, width: 166, height: 121 },
      margin: { x: 2, y: 22, width: 4, height: 27 }
    }))
  };
});

class TestImage {
  decoding = "";
  src = "";
  decode(): Promise<void> { return Promise.resolve(); }
  addEventListener(): void {}
  removeEventListener(): void {}
}

function pointer(el: Element, type: string, pointerId: number, pointerType: "touch" | "mouse" = "touch"): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: pointerType },
    isPrimary: { value: true },
    button: { value: 0 }
  });
  el.dispatchEvent(event);
}

describe("MirrorHandRaiseButton", () => {
  let now = 10_000;

  beforeEach(() => {
    now = 10_000;
    document.body.innerHTML = "";
    vi.stubGlobal("Image", TestImage);
    vi.spyOn(performance, "now").mockImplementation(() => now);
    __resetHandRaiseUiForTest();
    clearStoredMirrorSettings();
    mirrorSettings.raiseHandCards = false;
  });

  afterEach(() => {
    __resetHandRaiseUiForTest();
    clearStoredMirrorSettings();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("is teleported into the scene anchor and a short press toggles raise on", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    setHandRaiseLayer({ present: true, anchorId: "Piles", domTarget: target, covered: false, backend: "dom" });
    const renderer = shallowRef({} as MirrorRenderer);
    const wrapper = mount(MirrorHandRaiseButton, {
      attachTo: document.body,
      global: { provide: { [MIRROR_RENDERER_KEY as symbol]: renderer } }
    });
    await flushPromises();
    await nextTick();

    const chrome = target.querySelector<HTMLElement>("[data-testid=mirror-hand-raise-chrome]");
    const button = document.querySelector<HTMLElement>("[data-testid=mirror-hand-raise-button]");
    expect(chrome).not.toBeNull();
    expect(button).not.toBeNull();
    expect(target.contains(button)).toBe(false);
    expect(HAND_RAISE_BOX).toEqual({ width: 109, height: 109, right: 145, bottom: 7 });

    pointer(button!, "pointerdown", 7);
    await nextTick();
    expect(effectiveRaiseHandCards.value).toBe(true);
    expect(mirrorSettings.raiseHandCards).toBe(false);

    pointer(button!, "pointerleave", 7);
    expect(handRaiseUi.pressOverride).toBe(true);

    now += 399;
    pointer(button!, "pointerup", 7);
    await nextTick();
    expect(handRaiseUi.pressOverride).toBeNull();
    expect(effectiveRaiseHandCards.value).toBe(true);
    expect(mirrorSettings.raiseHandCards).toBe(true);
    expect(readStoredMirrorSettings().raiseHandCards).toBe(true);
    wrapper.unmount();
  });

  it("a short press immediately lowers an already-raised hand and toggles the saved setting off", async () => {
    mirrorSettings.raiseHandCards = true;
    const target = document.createElement("div");
    document.body.appendChild(target);
    setHandRaiseLayer({ present: true, anchorId: "Piles", domTarget: target, covered: false, backend: "dom" });
    const wrapper = mount(MirrorHandRaiseButton, {
      attachTo: document.body,
      global: { provide: { [MIRROR_RENDERER_KEY as symbol]: shallowRef({} as MirrorRenderer) } }
    });
    await flushPromises();
    const button = document.querySelector<HTMLElement>("[data-testid=mirror-hand-raise-button]")!;

    pointer(button, "pointerdown", 8);
    await nextTick();
    expect(handRaiseUi.pressOverride).toBe(false);
    expect(effectiveRaiseHandCards.value).toBe(false);
    expect(mirrorSettings.raiseHandCards).toBe(true);

    now += 400;
    pointer(button, "pointerup", 8);
    await nextTick();
    expect(handRaiseUi.pressOverride).toBeNull();
    expect(effectiveRaiseHandCards.value).toBe(false);
    expect(mirrorSettings.raiseHandCards).toBe(false);
    expect(readStoredMirrorSettings().raiseHandCards).toBe(false);
    wrapper.unmount();
  });

  it.each([
    { saved: false, during: true },
    { saved: true, during: false }
  ])("holds the inverse of saved=$saved past 400ms, then restores it without persisting", async ({ saved, during }) => {
    mirrorSettings.raiseHandCards = saved;
    const target = document.createElement("div");
    document.body.appendChild(target);
    setHandRaiseLayer({ present: true, anchorId: "Piles", domTarget: target, covered: false, backend: "dom" });
    const wrapper = mount(MirrorHandRaiseButton, {
      attachTo: document.body,
      global: { provide: { [MIRROR_RENDERER_KEY as symbol]: shallowRef({} as MirrorRenderer) } }
    });
    await flushPromises();
    const button = document.querySelector<HTMLElement>("[data-testid=mirror-hand-raise-button]")!;

    pointer(button, "pointerdown", 20);
    await nextTick();
    expect(effectiveRaiseHandCards.value).toBe(during);
    expect(mirrorSettings.raiseHandCards).toBe(saved);

    now += 401;
    pointer(button, "pointerleave", 20);
    pointer(button, "pointermove", 20);
    expect(effectiveRaiseHandCards.value).toBe(during);

    pointer(button, "pointerup", 20);
    await nextTick();
    expect(handRaiseUi.pressOverride).toBeNull();
    expect(effectiveRaiseHandCards.value).toBe(saved);
    expect(mirrorSettings.raiseHandCards).toBe(saved);
    expect(readStoredMirrorSettings().raiseHandCards).toBeUndefined();
    wrapper.unmount();
  });

  it.each(["dom", "canvas"] as const)("cancels a hold when a %s backstop covers the scene anchor", async (backend) => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const domTarget = backend === "dom" ? target : null;
    setHandRaiseLayer({ present: true, anchorId: "Piles", domTarget, covered: false, backend });
    const wrapper = mount(MirrorHandRaiseButton, {
      attachTo: target,
      global: { provide: { [MIRROR_RENDERER_KEY as symbol]: shallowRef({} as MirrorRenderer) } }
    });
    await flushPromises();
    const button = wrapper.get("[data-testid=mirror-hand-raise-button]").element;
    pointer(button, "pointerdown", 9, "mouse");
    await nextTick();
    expect(handRaiseUi.pressOverride).toBe(true);

    setHandRaiseLayer({ present: true, anchorId: "Piles", domTarget, covered: true, backend });
    await nextTick();
    expect(handRaiseUi.pressOverride).toBeNull();
    expect(mirrorSettings.raiseHandCards).toBe(false);
    expect(readStoredMirrorSettings().raiseHandCards).toBeUndefined();
    expect(wrapper.get("[data-testid=mirror-hand-raise-button]").classes()).toContain("mirror-hand-raise--blocked");
    wrapper.unmount();
  });

  it("clears the transient override on cancel, lost capture, disappearance, and teardown", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const visible = { present: true, anchorId: "Piles", domTarget: target, covered: false, backend: "dom" } as const;
    setHandRaiseLayer(visible);
    const wrapper = mount(MirrorHandRaiseButton, {
      attachTo: document.body,
      global: { provide: { [MIRROR_RENDERER_KEY as symbol]: shallowRef({} as MirrorRenderer) } }
    });
    await flushPromises();

    let button = document.querySelector<HTMLElement>("[data-testid=mirror-hand-raise-button]")!;
    pointer(button, "pointerdown", 11);
    pointer(button, "pointercancel", 11);
    expect(handRaiseUi.pressOverride).toBeNull();

    pointer(button, "pointerdown", 12);
    pointer(button, "lostpointercapture", 12);
    expect(handRaiseUi.pressOverride).toBeNull();

    pointer(button, "pointerdown", 13);
    setHandRaiseLayer({ present: false, anchorId: null, domTarget: null, covered: false, backend: "dom" });
    await nextTick();
    expect(handRaiseUi.pressOverride).toBeNull();
    expect(document.querySelector("[data-testid=mirror-hand-raise-button]")).toBeNull();
    expect(target.querySelector("[data-testid=mirror-hand-raise-chrome]")).toBeNull();

    setHandRaiseLayer(visible);
    await nextTick();
    button = document.querySelector<HTMLElement>("[data-testid=mirror-hand-raise-button]")!;
    pointer(button, "pointerdown", 14);
    expect(handRaiseUi.pressOverride).toBe(true);
    wrapper.unmount();
    expect(handRaiseUi.pressOverride).toBeNull();
    expect(mirrorSettings.raiseHandCards).toBe(false);
    expect(readStoredMirrorSettings().raiseHandCards).toBeUndefined();
  });
});
