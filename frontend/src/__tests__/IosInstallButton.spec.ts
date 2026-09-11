import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import IosInstallButton from "@/components/IosInstallButton.vue";
import { __setIosInstallForceForTest } from "@/join/joinModel";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

afterEach(() => {
  __setIosInstallForceForTest(false);
});

// The re-open pill lives in FullscreenButton's slot, so its gate is the mirror image of
// FullscreenButton.spec.ts's: shown exactly where element fullscreen is UNAVAILABLE, on iOS Safari, not
// already standalone.
describe("IosInstallButton", () => {
  it("shows on an iPhone tab when element fullscreen is unsupported", () => {
    const wrapper = mount(IosInstallButton, {
      props: { env: { userAgent: IPHONE_UA }, fullscreenSupported: false }
    });
    expect(wrapper.find('[data-testid="ios-install-button"]').exists()).toBe(true);
  });

  it("hides on Android/desktop regardless of fullscreen support", () => {
    for (const userAgent of [ANDROID_UA, DESKTOP_UA]) {
      const wrapper = mount(IosInstallButton, { props: { env: { userAgent }, fullscreenSupported: false } });
      expect(wrapper.find('[data-testid="ios-install-button"]').exists()).toBe(false);
    }
  });

  it("hides once the page is already running standalone", () => {
    const wrapper = mount(IosInstallButton, {
      props: { env: { userAgent: IPHONE_UA, navigatorStandalone: true }, fullscreenSupported: false }
    });
    expect(wrapper.find('[data-testid="ios-install-button"]').exists()).toBe(false);
  });

  // The mutual-exclusion contract with FullscreenButton: whichever one reports fullscreen SUPPORTED wins that
  // slot, and this button stands down even on an iPhone UA (a spoofed/atypical UA reporting support).
  it("hides when fullscreen IS supported, even on an iPhone UA", () => {
    const wrapper = mount(IosInstallButton, {
      props: { env: { userAgent: IPHONE_UA }, fullscreenSupported: true }
    });
    expect(wrapper.find('[data-testid="ios-install-button"]').exists()).toBe(false);
  });

  it("emits open on click", async () => {
    const wrapper = mount(IosInstallButton, {
      props: { env: { userAgent: IPHONE_UA }, fullscreenSupported: false }
    });
    await wrapper.get('[data-testid="ios-install-button"]').trigger("click");
    expect(wrapper.emitted("open")).toHaveLength(1);
  });

  it("applies the compact class when requested", () => {
    const wrapper = mount(IosInstallButton, {
      props: { env: { userAgent: IPHONE_UA }, fullscreenSupported: false, compact: true }
    });
    expect(wrapper.get('[data-testid="ios-install-button"]').classes()).toContain("ios-install-button--compact");
  });

  it("shows under the ?iosInstall=force lever with no props at all", () => {
    __setIosInstallForceForTest(true);
    const wrapper = mount(IosInstallButton);
    expect(wrapper.find('[data-testid="ios-install-button"]').exists()).toBe(true);
  });
});
