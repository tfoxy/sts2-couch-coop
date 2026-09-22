import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import BrowserAdvisory from "@/join/BrowserAdvisory.vue";
import GamepadAdvisory from "@/join/GamepadAdvisory.vue";
import IosInstallOverlay from "@/join/IosInstallOverlay.vue";
import { __resetComposerForTest, createBrowserI18n, messages } from "@/i18n";
import {
  BROWSER_ADVISORY_DISMISSED_STORAGE_KEY,
  BROWSER_ADVISORY_MESSAGE,
  GAMEPAD_ADVISORY_DISMISSED_STORAGE_KEY,
  IOS_INSTALL_DISMISSED_STORAGE_KEY,
  type BrowserAdvisoryEnv,
  type GamepadAdvisoryEnv,
  type IosInstallOverlayEnv
} from "@/join/joinModel";

// The two presentational surfaces WS1 and WS4 add. Both take their decision inputs as props (defaulting to the
// live browser) precisely so these specs can drive them without redefining `navigator` / `matchMedia` globals.

const IPHONE_17_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_26_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const SAMSUNG_UA =
  "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36";

function recordingStorage() {
  const writes: string[] = [];
  return { writes, setItem: (key: string) => void writes.push(key) };
}

function mountOverlay(
  armed: boolean,
  env: IosInstallOverlayEnv,
  storage = recordingStorage(),
  extraProps: Record<string, unknown> = {}
) {
  // escapeDelayMs defaults to 0 so ordinary specs never have to think about the delay timer — the specs that
  // test the delay itself override it explicitly.
  const wrapper = mount(IosInstallOverlay, { props: { armed, env, storage, escapeDelayMs: 0, ...extraProps } });
  return { wrapper, storage };
}

/** A `getBoundingClientRect` override — jsdom always returns a 0-area rect, which the geometry math reads as
 *  "unmeasurable" and skips straight to an instant close. Specs that need the genie path stub a real rect. */
function stubRect(el: HTMLElement, rect: Partial<DOMRect>): void {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}), ...rect }) as DOMRect;
}

/** Appends a fake re-open pill to `document.body` — the genie target the overlay looks up by testid. */
function appendFakePill(rect: Partial<DOMRect> = { left: 380, top: 4, width: 44, height: 44 }): HTMLButtonElement {
  const pill = document.createElement("button");
  pill.setAttribute("data-testid", "ios-install-button");
  stubRect(pill, rect);
  document.body.appendChild(pill);
  return pill;
}

describe("IosInstallOverlay", () => {
  afterEach(() => {
    __resetComposerForTest();
  });

  it("stays hidden until the seat tap arms it", async () => {
    const { wrapper } = mountOverlay(false, { userAgent: IPHONE_17_UA });
    expect(wrapper.find('[data-testid="ios-install-overlay"]').exists()).toBe(false);
    await wrapper.setProps({ armed: true });
    expect(wrapper.find('[data-testid="ios-install-overlay"]').exists()).toBe(true);
  });

  it("renders nothing on Android even when armed (no Android overlay by design)", () => {
    const { wrapper } = mountOverlay(true, { userAgent: ANDROID_UA });
    expect(wrapper.find('[data-testid="ios-install-overlay"]').exists()).toBe(false);
  });

  it("renders nothing once the app is already running from the home screen", () => {
    const { wrapper } = mountOverlay(true, { userAgent: IPHONE_17_UA, navigatorStandalone: true });
    expect(wrapper.find('[data-testid="ios-install-overlay"]').exists()).toBe(false);
  });

  it("renders nothing once dismissed on this device", () => {
    const { wrapper } = mountOverlay(true, { userAgent: IPHONE_17_UA, dismissed: true });
    expect(wrapper.find('[data-testid="ios-install-overlay"]').exists()).toBe(false);
  });

  it("draws the three numbered steps with their real iOS glyphs", () => {
    const { wrapper } = mountOverlay(true, { userAgent: IPHONE_17_UA });
    expect(wrapper.findAll(".ios-install-steps li")).toHaveLength(3);
    expect(wrapper.find('[data-testid="ios-share-glyph"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="ios-add-glyph"]').exists()).toBe(true);
    const text = wrapper.text();
    expect(text).toContain("Share");
    expect(text).toContain("Add to Home Screen");
    expect(text).toContain("Tap Add, then open CouchCoop from your Home Screen.");
  });

  it("renders Chinese install prose and keeps its dialog accessible", () => {
    createBrowserI18n("?lang=zh-Hans", { languages: ["en"] });
    const { wrapper } = mountOverlay(true, { userAgent: IPHONE_17_UA });
    const dialog = wrapper.get('[data-testid="ios-install-overlay"]');
    expect(dialog.attributes("role")).toBe("dialog");
    expect(dialog.attributes("aria-labelledby")).toBe("ios-install-title");
    expect(wrapper.text()).toContain("添加到主屏幕");
    expect(wrapper.text()).toContain("点按添加，然后从主屏幕打开 CouchCoop。");
  });

  // The toolbar is at the BOTTOM on a default iPhone, at the TOP under Safari's Single Tab layout, and always at
  // the top on iPad — and nothing in the page can tell which. So the arrow points down and the caption names the
  // other case out loud rather than guessing.
  it("points DOWN at the toolbar and captions the address-bar-on-top case", () => {
    const { wrapper } = mountOverlay(true, { userAgent: IPHONE_17_UA });
    expect(wrapper.find('[data-testid="ios-install-pointer"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="ios-install-pointer-caption"]').text()).toContain(
      "top of the screen if your address bar is up there"
    );
  });

  it("mentions Open as Web App on iOS 26 and omits it below", () => {
    const modern = mountOverlay(true, { userAgent: IPHONE_26_UA });
    expect(modern.wrapper.get('[data-testid="ios-open-as-web-app-note"]').text()).toContain(
      "Open as Web App"
    );
    const older = mountOverlay(true, { userAgent: IPHONE_17_UA });
    expect(older.wrapper.find('[data-testid="ios-open-as-web-app-note"]').exists()).toBe(false);
  });

  // The install path never needs to close the overlay (the Share sheet opens ON TOP of it) — so there is no
  // "Got it" to reflex-tap anymore.
  it("has no 'Got it' — the escape link is the only steps-stage action", () => {
    const { wrapper } = mountOverlay(true, { userAgent: IPHONE_17_UA });
    expect(wrapper.find('[data-testid="ios-install-got-it"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="ios-install-stay"]').exists()).toBe(true);
  });

  // A single tap can never leave anymore — "Play in the tab anyway" only ASKS.
  it("the steps escape link asks first — it does not close or persist anything", async () => {
    const { wrapper, storage } = mountOverlay(true, { userAgent: IPHONE_17_UA });
    await wrapper.get('[data-testid="ios-install-stay"]').trigger("click");
    expect(wrapper.find('[data-testid="ios-install-overlay"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("Stay in the browser tab?");
    expect(wrapper.emitted("close")).toBeUndefined();
    expect(storage.writes).toEqual([]);
  });

  it("'Back to the steps' returns without re-imposing the escape delay", async () => {
    const { wrapper } = mountOverlay(true, { userAgent: IPHONE_17_UA });
    await wrapper.get('[data-testid="ios-install-stay"]').trigger("click");
    await wrapper.get('[data-testid="ios-install-back"]').trigger("click");
    expect(wrapper.text()).toContain("Add CouchCoop to your Home Screen");
    // The link was already revealed once this open — coming back to the steps must not hide it again.
    expect(wrapper.find('[data-testid="ios-install-stay"]').exists()).toBe(true);
  });

  it("'Play in the tab' on the confirm step closes it with NO storage write when unticked", async () => {
    const { wrapper, storage } = mountOverlay(true, { userAgent: IPHONE_17_UA });
    await wrapper.get('[data-testid="ios-install-stay"]').trigger("click");
    await wrapper.get('[data-testid="ios-install-confirm-stay"]').trigger("click");
    expect(wrapper.find('[data-testid="ios-install-overlay"]').exists()).toBe(false);
    expect(wrapper.emitted("close")).toHaveLength(1);
    expect(storage.writes).toEqual([]);
  });

  it("'Don't show this again' is the ONLY remaining writer of the dismissal flag", async () => {
    const { wrapper, storage } = mountOverlay(true, { userAgent: IPHONE_17_UA });
    await wrapper.get('[data-testid="ios-install-stay"]').trigger("click");
    await wrapper.get('[data-testid="ios-install-dont-show"]').setValue(true);
    await wrapper.get('[data-testid="ios-install-confirm-stay"]').trigger("click");
    expect(storage.writes).toEqual([IOS_INSTALL_DISMISSED_STORAGE_KEY]);
  });

  it("Escape steps to confirm first, then a second Escape leaves (unticked, no write)", async () => {
    const { wrapper, storage } = mountOverlay(true, { userAgent: IPHONE_17_UA });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("Stay in the browser tab?");
    expect(wrapper.find('[data-testid="ios-install-overlay"]').exists()).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="ios-install-overlay"]').exists()).toBe(false);
    expect(storage.writes).toEqual([]);
    wrapper.unmount();
  });

  it("session dismissal blocks a re-arm, but the pill's openRequest bypasses it (and the persisted flag)", async () => {
    const { wrapper } = mountOverlay(true, { userAgent: IPHONE_17_UA }, recordingStorage(), { openRequest: 0 });
    await wrapper.get('[data-testid="ios-install-stay"]').trigger("click");
    await wrapper.get('[data-testid="ios-install-confirm-stay"]').trigger("click");
    expect(wrapper.find('[data-testid="ios-install-overlay"]').exists()).toBe(false);

    // Re-arming (a second seat tap) must NOT reopen it — this page load already dismissed it once.
    await wrapper.setProps({ armed: false });
    await wrapper.setProps({ armed: true });
    expect(wrapper.find('[data-testid="ios-install-overlay"]').exists()).toBe(false);

    // The pill's tick reopens regardless — with the escape link shown immediately (no delay on a manual open).
    await wrapper.setProps({ openRequest: 1 });
    expect(wrapper.find('[data-testid="ios-install-overlay"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="ios-install-stay"]').exists()).toBe(true);
  });

  it("openRequest also bypasses an env that reports the PERSISTED flag already set", async () => {
    const { wrapper } = mountOverlay(
      false,
      { userAgent: IPHONE_17_UA, dismissed: true },
      recordingStorage(),
      { openRequest: 0 }
    );
    expect(wrapper.find('[data-testid="ios-install-overlay"]').exists()).toBe(false);
    await wrapper.setProps({ openRequest: 1 });
    expect(wrapper.find('[data-testid="ios-install-overlay"]').exists()).toBe(true);
  });

  describe("escape delay", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("hides the escape link until the delay elapses, then reveals it", async () => {
      vi.useFakeTimers();
      const { wrapper } = mountOverlay(true, { userAgent: IPHONE_17_UA }, recordingStorage(), {
        escapeDelayMs: 3000
      });
      expect(wrapper.find('[data-testid="ios-install-stay"]').exists()).toBe(false);

      vi.advanceTimersByTime(2999);
      await wrapper.vm.$nextTick();
      expect(wrapper.find('[data-testid="ios-install-stay"]').exists()).toBe(false);

      vi.advanceTimersByTime(1);
      await wrapper.vm.$nextTick();
      expect(wrapper.find('[data-testid="ios-install-stay"]').exists()).toBe(true);
    });

    // Escape must never be gated by the same delay that hides the link — a keyboard player is not stuck
    // waiting out a countdown to leave.
    it("Escape reaches the confirm step even inside the delay window", async () => {
      vi.useFakeTimers();
      const { wrapper } = mountOverlay(true, { userAgent: IPHONE_17_UA }, recordingStorage(), {
        escapeDelayMs: 3000
      });
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await wrapper.vm.$nextTick();
      expect(wrapper.text()).toContain("Stay in the browser tab?");
      wrapper.unmount();
    });

    it("a manual (pill) open shows the escape link immediately, ignoring the delay", async () => {
      const { wrapper } = mountOverlay(false, { userAgent: IPHONE_17_UA }, recordingStorage(), {
        escapeDelayMs: 3000,
        openRequest: 0
      });
      await wrapper.setProps({ openRequest: 1 });
      expect(wrapper.find('[data-testid="ios-install-stay"]').exists()).toBe(true);
    });
  });

  describe("genie close animation", () => {
    it("animates the card into the pill and holds the overlay mounted until it settles", async () => {
      const pill = appendFakePill();
      const pillAnimate = vi.fn();
      (pill as unknown as { animate: typeof pill.animate }).animate =
        pillAnimate as unknown as typeof pill.animate;
      try {
        const { wrapper } = mountOverlay(true, { userAgent: IPHONE_17_UA });
        await wrapper.get('[data-testid="ios-install-stay"]').trigger("click");

        const cardEl = wrapper.get(".ios-install-card").element as HTMLElement;
        stubRect(cardEl, { left: 40, top: 100, width: 544, height: 300 });
        const anim: { onfinish?: () => void; oncancel?: () => void } = {};
        const cardAnimate = vi.fn().mockReturnValue(anim);
        cardEl.animate = cardAnimate as unknown as typeof cardEl.animate;

        await wrapper.get('[data-testid="ios-install-confirm-stay"]').trigger("click");

        // Still mounted — the genie is playing, "close" has not fired yet.
        expect(wrapper.find('[data-testid="ios-install-overlay"]').exists()).toBe(true);
        expect(wrapper.emitted("close")).toBeUndefined();
        expect(cardAnimate).toHaveBeenCalledTimes(1);
        const [keyframes] = cardAnimate.mock.calls[0] as [Keyframe[], unknown];
        expect(String(keyframes[1].transform)).toContain("translate(");
        expect(String(keyframes[1].transform)).toContain("scale(");

        anim.onfinish?.();
        await wrapper.vm.$nextTick();

        expect(wrapper.find('[data-testid="ios-install-overlay"]').exists()).toBe(false);
        expect(wrapper.emitted("close")).toHaveLength(1);
        // The pill pulses once the card lands.
        expect(pillAnimate).toHaveBeenCalledTimes(1);
      } finally {
        document.body.removeChild(pill);
      }
    });

    it("skips the animation and closes synchronously under prefers-reduced-motion", async () => {
      const pill = appendFakePill();
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = ((query: string) =>
        ({ matches: query.includes("reduce") }) as MediaQueryList) as typeof window.matchMedia;
      try {
        const { wrapper, storage } = mountOverlay(true, { userAgent: IPHONE_17_UA });
        await wrapper.get('[data-testid="ios-install-stay"]').trigger("click");

        const cardEl = wrapper.get(".ios-install-card").element as HTMLElement;
        stubRect(cardEl, { left: 40, top: 100, width: 544, height: 300 });
        const cardAnimate = vi.fn();
        cardEl.animate = cardAnimate as unknown as typeof cardEl.animate;

        await wrapper.get('[data-testid="ios-install-confirm-stay"]').trigger("click");

        expect(cardAnimate).not.toHaveBeenCalled();
        expect(wrapper.find('[data-testid="ios-install-overlay"]').exists()).toBe(false);
        expect(wrapper.emitted("close")).toHaveLength(1);
        expect(storage.writes).toEqual([]);
      } finally {
        document.body.removeChild(pill);
        if (originalMatchMedia) {
          window.matchMedia = originalMatchMedia;
        } else {
          delete (window as unknown as Record<string, unknown>).matchMedia;
        }
      }
    });

    // No pill mounted — and bare jsdom's 0-area rects — both read as
    // "unmeasurable", so every OTHER exit spec above already proves the instant-close fallback path.
    it("closes instantly with no pill in the document", async () => {
      const { wrapper } = mountOverlay(true, { userAgent: IPHONE_17_UA });
      await wrapper.get('[data-testid="ios-install-stay"]').trigger("click");
      await wrapper.get('[data-testid="ios-install-confirm-stay"]').trigger("click");
      expect(wrapper.find('[data-testid="ios-install-overlay"]').exists()).toBe(false);
      expect(wrapper.emitted("close")).toHaveLength(1);
    });
  });
});

describe("BrowserAdvisory", () => {
  function mountAdvisory(env: BrowserAdvisoryEnv, storage = recordingStorage()) {
    return { wrapper: mount(BrowserAdvisory, { props: { env, storage } }), storage };
  }

  it("shows the recommendation on Samsung Internet only", () => {
    expect(mountAdvisory({ userAgent: SAMSUNG_UA }).wrapper.text()).toContain(BROWSER_ADVISORY_MESSAGE);
    expect(
      mountAdvisory({ userAgent: ANDROID_UA }).wrapper.find('[data-testid="browser-advisory"]').exists()
    ).toBe(false);
  });

  it("dismisses to nothing and records it under its own key", async () => {
    const { wrapper, storage } = mountAdvisory({ userAgent: SAMSUNG_UA });
    await wrapper.get('[data-testid="browser-advisory-dismiss"]').trigger("click");
    expect(wrapper.find('[data-testid="browser-advisory"]').exists()).toBe(false);
    expect(storage.writes).toEqual([BROWSER_ADVISORY_DISMISSED_STORAGE_KEY]);
  });

  it("is inert when already dismissed", () => {
    expect(
      mountAdvisory({ userAgent: SAMSUNG_UA, dismissed: true })
        .wrapper.find('[data-testid="browser-advisory"]')
        .exists()
    ).toBe(false);
  });

  // ADVISORY ONLY: it renders no control that could stand between the player and the seat list. The dismiss
  // button is the sole interactive element, and it only removes the notice.
  it("adds no blocking control — one dismiss button and nothing else", () => {
    const { wrapper } = mountAdvisory({ userAgent: SAMSUNG_UA });
    const buttons = wrapper.findAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].attributes("data-testid")).toBe("browser-advisory-dismiss");
  });
});

describe("GamepadAdvisory", () => {
  // A pad is in play, the page is plain HTTP, and the Gamepad API is therefore absent — the one case worth a line.
  const INSECURE_WITH_PAD: GamepadAdvisoryEnv = {
    secureContext: false,
    gamepadApi: false,
    padExpected: true
  };

  function mountAdvisory(env: GamepadAdvisoryEnv, storage = recordingStorage()) {
    return { wrapper: mount(GamepadAdvisory, { props: { env, storage } }), storage };
  }

  it("tells the player to rejoin over the secure link, and only where that is the fix", () => {
    expect(mountAdvisory(INSECURE_WITH_PAD).wrapper.text()).toContain(messages.en["advisory.gamepad"]);
    for (const env of [
      { ...INSECURE_WITH_PAD, padExpected: false },
      { ...INSECURE_WITH_PAD, secureContext: true },
      { ...INSECURE_WITH_PAD, gamepadApi: true },
      { ...INSECURE_WITH_PAD, dismissed: true }
    ]) {
      expect(mountAdvisory(env).wrapper.find('[data-testid="gamepad-advisory"]').exists()).toBe(false);
    }
  });

  it("dismisses to nothing and records it under its OWN key", async () => {
    const { wrapper, storage } = mountAdvisory(INSECURE_WITH_PAD);
    await wrapper.get('[data-testid="gamepad-advisory-dismiss"]').trigger("click");
    expect(wrapper.find('[data-testid="gamepad-advisory"]').exists()).toBe(false);
    expect(storage.writes).toEqual([GAMEPAD_ADVISORY_DISMISSED_STORAGE_KEY]);
  });

  // NEVER A GATE — same rule as the browser advisory: nothing here may stand between the player and the seat list.
  it("adds no blocking control — one dismiss button and nothing else", () => {
    const buttons = mountAdvisory(INSECURE_WITH_PAD).wrapper.findAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].attributes("data-testid")).toBe("gamepad-advisory-dismiss");
  });
});
