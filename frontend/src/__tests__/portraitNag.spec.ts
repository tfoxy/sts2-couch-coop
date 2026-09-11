import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PortraitNagOverlay from "@/components/PortraitNagOverlay.vue";
import { __resetComposerForTest, createBrowserI18n } from "@/i18n";
import {
  PORTRAIT_NAG_ANDROID_HINT,
  PORTRAIT_NAG_DELAY_MS,
  PORTRAIT_NAG_GENERIC_HINT,
  PORTRAIT_NAG_HINT_DELAY_MS,
  PORTRAIT_NAG_IOS_HINT,
  portraitNagState,
  portraitRotationHint,
  type MediaQuerySeam
} from "@/composables/usePortraitNag";

// WS3 — inferring "your phone is rotation-locked" from time spent portrait, because no API reports it.

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const AFTER_NAG = PORTRAIT_NAG_DELAY_MS;
const AFTER_HINT = PORTRAIT_NAG_DELAY_MS + PORTRAIT_NAG_HINT_DELAY_MS;

function base(over: Partial<Parameters<typeof portraitNagState>[0]> = {}) {
  return {
    active: true,
    suppressed: false,
    portrait: true,
    dismissed: false,
    elapsedMs: AFTER_NAG,
    ...over
  };
}

describe("portraitNagState", () => {
  it("says nothing before the delay is up — a phone mid-rotation is not a stuck phone", () => {
    expect(portraitNagState(base({ elapsedMs: 0 }))).toEqual({ visible: false, showHint: false });
    expect(portraitNagState(base({ elapsedMs: PORTRAIT_NAG_DELAY_MS - 1 }))).toEqual({
      visible: false,
      showHint: false
    });
  });

  it("shows the nag at the delay and holds the platform line back until later", () => {
    expect(portraitNagState(base({ elapsedMs: AFTER_NAG }))).toEqual({ visible: true, showHint: false });
    expect(portraitNagState(base({ elapsedMs: AFTER_HINT - 1 }))).toEqual({
      visible: true,
      showHint: false
    });
    expect(portraitNagState(base({ elapsedMs: AFTER_HINT }))).toEqual({ visible: true, showHint: true });
  });

  it("never fires outside the game view, in landscape, once dismissed, or when WS2 locked the orientation", () => {
    expect(portraitNagState(base({ active: false })).visible).toBe(false);
    expect(portraitNagState(base({ portrait: false })).visible).toBe(false);
    expect(portraitNagState(base({ dismissed: true })).visible).toBe(false);
    // The one that matters most: with a granted landscape lock, portrait is not a state the player is stuck in.
    expect(portraitNagState(base({ suppressed: true })).visible).toBe(false);
  });
});

describe("portraitRotationHint", () => {
  it("names the right gesture per platform, and stays generic when it cannot tell", () => {
    expect(portraitRotationHint(IPHONE_UA)).toBe(PORTRAIT_NAG_IOS_HINT);
    expect(portraitRotationHint(ANDROID_UA)).toBe(PORTRAIT_NAG_ANDROID_HINT);
    expect(portraitRotationHint(DESKTOP_UA)).toBe(PORTRAIT_NAG_GENERIC_HINT);
    expect(portraitRotationHint(null)).toBe(PORTRAIT_NAG_GENERIC_HINT);
  });
});

describe("PortraitNagOverlay", () => {
  // A controllable media query: jsdom's own never changes, so the orientation flip has to be driven by hand.
  function fakeQuery(matches: boolean) {
    const listeners: ((event: { matches: boolean }) => void)[] = [];
    const query = {
      matches,
      addEventListener: (_type: "change", listener: (event: { matches: boolean }) => void) =>
        void listeners.push(listener),
      removeEventListener: (_type: "change", listener: (event: { matches: boolean }) => void) => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      }
    } satisfies MediaQuerySeam;
    return {
      query,
      listenerCount: () => listeners.length,
      flip(next: boolean) {
        query.matches = next;
        listeners.forEach((listener) => listener({ matches: next }));
      }
    };
  }

  function mountNag(over: { active?: boolean; suppressed?: boolean; portrait?: boolean; userAgent?: string } = {}) {
    const media = fakeQuery(over.portrait ?? true);
    const wrapper = mount(PortraitNagOverlay, {
      props: {
        active: over.active ?? true,
        suppressed: over.suppressed ?? false,
        seams: { matchMedia: () => media.query, userAgent: over.userAgent ?? ANDROID_UA }
      }
    });
    return { wrapper, media };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetComposerForTest();
  });

  it("appears only after the delay, then grows the platform line", async () => {
    const { wrapper } = mountNag();
    expect(wrapper.find('[data-testid="portrait-nag"]').exists()).toBe(false);

    vi.advanceTimersByTime(PORTRAIT_NAG_DELAY_MS);
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-testid="portrait-nag"]').text()).toContain("Turn your phone sideways");
    expect(wrapper.find('[data-testid="portrait-nag-hint"]').exists()).toBe(false);

    vi.advanceTimersByTime(PORTRAIT_NAG_HINT_DELAY_MS);
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-testid="portrait-nag-hint"]').text()).toBe(PORTRAIT_NAG_ANDROID_HINT);
    wrapper.unmount();
  });

  it("uses the active Chinese composition locale for orientation guidance", async () => {
    createBrowserI18n("?lang=zh-Hans", { languages: ["en"] });
    const { wrapper } = mountNag();
    vi.advanceTimersByTime(AFTER_HINT);
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-testid="portrait-nag"]').text()).toContain("请将手机横过来");
    expect(wrapper.get('[data-testid="portrait-nag-hint"]').text()).toContain("自动旋转");
    wrapper.unmount();
  });

  it("auto-dismisses the moment the phone is turned", async () => {
    const { wrapper, media } = mountNag();
    vi.advanceTimersByTime(AFTER_HINT);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="portrait-nag"]').exists()).toBe(true);

    media.flip(false);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="portrait-nag"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("never appears when WS2's landscape lock was granted", async () => {
    const { wrapper } = mountNag({ suppressed: true });
    vi.advanceTimersByTime(AFTER_HINT);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="portrait-nag"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("says nothing over the join picker (which reads fine in portrait)", async () => {
    const { wrapper } = mountNag({ active: false });
    vi.advanceTimersByTime(AFTER_HINT);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="portrait-nag"]').exists()).toBe(false);

    // …and starts its clock when the game view actually comes up.
    await wrapper.setProps({ active: true });
    vi.advanceTimersByTime(PORTRAIT_NAG_DELAY_MS);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="portrait-nag"]').exists()).toBe(true);
    wrapper.unmount();
  });

  // Reachable-past: nothing we draw over the game may trap a player who wants to keep playing in portrait.
  it("has a Got-it exit that stays gone", async () => {
    const { wrapper } = mountNag();
    vi.advanceTimersByTime(AFTER_HINT);
    await wrapper.vm.$nextTick();
    await wrapper.get('[data-testid="portrait-nag-dismiss"]').trigger("click");
    expect(wrapper.find('[data-testid="portrait-nag"]').exists()).toBe(false);

    vi.advanceTimersByTime(AFTER_HINT * 2);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="portrait-nag"]').exists()).toBe(false);
    wrapper.unmount();
  });

  // R19 WP-2b. Entering fullscreen is ALSO what asks for the landscape lock (useFullscreen hangs the lock off
  // `fullscreenchange`, not off the caller), so the overlay that tells you to turn the phone can just turn it.
  it("offers fullscreen as the primary action, and entering it is what rotates the phone", async () => {
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = requestFullscreen;

    const { wrapper } = mountNag();
    vi.advanceTimersByTime(AFTER_HINT);
    await wrapper.vm.$nextTick();

    await wrapper.get('[data-testid="portrait-nag-fullscreen"]').trigger("click");
    expect(requestFullscreen).toHaveBeenCalledTimes(1);

    // The nag is NOT dismissed by the click. It goes away because the phone actually rotated and the media
    // query flipped -- so a fullscreen request that fails to rotate correctly leaves the advice on screen.
    delete (document.documentElement as unknown as Record<string, unknown>).requestFullscreen;
    delete (document as unknown as Record<string, unknown>).fullscreenEnabled;
    wrapper.unmount();
  });

  it("dismisses itself when the phone actually turns", async () => {
    const { wrapper, media } = mountNag();
    vi.advanceTimersByTime(AFTER_HINT);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="portrait-nag"]').exists()).toBe(true);

    media.flip(false);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="portrait-nag"]').exists()).toBe(false);
    wrapper.unmount();
  });

  // The button renders behind FullscreenButton's own gate, so it is absent exactly where it would do nothing:
  // iOS Safari on iPhone (no element Fullscreen API) and an already-installed PWA.
  it("hides the fullscreen action where the API is unavailable, keeping Got it", async () => {
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: false });
    const { wrapper } = mountNag();
    vi.advanceTimersByTime(AFTER_HINT);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="portrait-nag-fullscreen"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="portrait-nag-dismiss"]').exists()).toBe(true);
    delete (document as unknown as Record<string, unknown>).fullscreenEnabled;
    wrapper.unmount();
  });

  it("drops its media listener on unmount", () => {
    const { wrapper, media } = mountNag();
    expect(media.listenerCount()).toBe(1);
    wrapper.unmount();
    expect(media.listenerCount()).toBe(0);
  });
});
