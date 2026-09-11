import { afterEach, describe, expect, it } from "vitest";

import {
  BROWSER_ADVISORY_DISMISSED_STORAGE_KEY,
  computeGenieTransform,
  IOS_INSTALL_DISMISSED_STORAGE_KEY,
  IOS_INSTALL_FORCED_UA,
  iosMajorVersion,
  isRunningStandalone,
  isStandaloneEnv,
  __setIosInstallForceForTest,
  readBrowserAdvisoryEnv,
  readDismissedFlag,
  readDisplayEnv,
  readElementFullscreenSupported,
  readIosInstallOverlayEnv,
  shouldRecommendBrowser,
  shouldShowBrowserAdvisory,
  shouldShowIosInstallHint,
  shouldShowIosInstallOverlay,
  showsOpenAsWebAppToggle,
  writeDismissedFlag
} from "@/join/joinModel";

// The per-DEVICE advice the join screens give (WS1's guided iOS install overlay, WS4's browser advisory) and
// the dismissal plumbing behind both. All pure — the components under test elsewhere only render what these say.
// Kept out of joinModel.spec.ts, which is about the join/roster/URL model proper.

const IPHONE_17_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_26_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const IPAD_26_UA =
  "Mozilla/5.0 (iPad; CPU OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1";
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const SAMSUNG_UA =
  "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36";
const CHROME_ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const FIREFOX_ANDROID_UA = "Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => void map.set(key, value)
  };
}

describe("iOS version sniff", () => {
  it("reads the major version off iPhone and iPad UAs", () => {
    expect(iosMajorVersion(IPHONE_17_UA)).toBe(17);
    expect(iosMajorVersion(IPHONE_26_UA)).toBe(26);
    expect(iosMajorVersion(IPAD_26_UA)).toBe(26);
  });

  // The "Mac OS X" tail every iOS UA carries must not be mistaken for a version: those digits are macOS's, and
  // reading 10 out of an iPhone 26 would silently drop the "Open as Web App" sentence the player needs.
  it("returns null rather than a macOS version when there is no iOS version to read", () => {
    expect(iosMajorVersion(DESKTOP_UA)).toBeNull();
    expect(iosMajorVersion("Mozilla/5.0 (X11; Linux x86_64)")).toBeNull();
    expect(iosMajorVersion(null)).toBeNull();
    expect(iosMajorVersion(undefined)).toBeNull();
  });

  it("mentions the Add sheet's Open-as-Web-App toggle only from iOS 26 up", () => {
    expect(showsOpenAsWebAppToggle(IPHONE_26_UA)).toBe(true);
    expect(showsOpenAsWebAppToggle(IPAD_26_UA)).toBe(true);
    // Below 26 the toggle does not exist; naming it sends the player hunting for a control that isn't there.
    expect(showsOpenAsWebAppToggle(IPHONE_17_UA)).toBe(false);
    expect(showsOpenAsWebAppToggle(DESKTOP_UA)).toBe(false);
    expect(showsOpenAsWebAppToggle(null)).toBe(false);
  });
});

describe("iOS install overlay gate", () => {
  it("shows on iOS Safari in a tab, and never once installed or dismissed", () => {
    expect(shouldShowIosInstallOverlay({ userAgent: IPHONE_17_UA })).toBe(true);
    expect(shouldShowIosInstallOverlay({ userAgent: IPHONE_17_UA, dismissed: true })).toBe(false);
    expect(shouldShowIosInstallOverlay({ userAgent: IPHONE_17_UA, navigatorStandalone: true })).toBe(false);
    expect(shouldShowIosInstallOverlay({ userAgent: IPHONE_17_UA, displayModeStandalone: true })).toBe(false);
    expect(shouldShowIosInstallOverlay({ userAgent: DESKTOP_UA })).toBe(false);
    expect(shouldShowIosInstallOverlay({ userAgent: CHROME_ANDROID_UA })).toBe(false);
  });

  // Our manifest declares `display: "fullscreen"`, so an installed app can report THAT mode rather than
  // `standalone` — checking only `standalone` would nag a player who already did exactly what we asked.
  it("treats the fullscreen display mode as installed too", () => {
    expect(shouldShowIosInstallOverlay({ userAgent: IPHONE_17_UA, displayModeFullscreen: true })).toBe(false);
    expect(shouldShowIosInstallHint({ userAgent: IPHONE_17_UA, displayModeFullscreen: true })).toBe(false);
  });

  it("isStandaloneEnv is true for any one of the three installed-app signals", () => {
    expect(isStandaloneEnv({ userAgent: IPHONE_17_UA })).toBe(false);
    expect(isStandaloneEnv({ userAgent: IPHONE_17_UA, navigatorStandalone: true })).toBe(true);
    expect(isStandaloneEnv({ userAgent: DESKTOP_UA, displayModeStandalone: true })).toBe(true);
    expect(isStandaloneEnv({ userAgent: DESKTOP_UA, displayModeFullscreen: true })).toBe(true);
  });
});

describe("browser advisory", () => {
  it("recommends another browser only on Samsung Internet", () => {
    expect(shouldRecommendBrowser(SAMSUNG_UA)).toBe(true);
    // Chrome on a SAMSUNG PHONE must not match: the advice is about the engine, not the hardware.
    expect(shouldRecommendBrowser(CHROME_ANDROID_UA)).toBe(false);
    expect(shouldRecommendBrowser(FIREFOX_ANDROID_UA)).toBe(false);
    expect(shouldRecommendBrowser(DESKTOP_UA)).toBe(false);
    expect(shouldRecommendBrowser(null)).toBe(false);
    expect(shouldRecommendBrowser(undefined)).toBe(false);
  });

  it("hides once dismissed on this device", () => {
    expect(shouldShowBrowserAdvisory({ userAgent: SAMSUNG_UA })).toBe(true);
    expect(shouldShowBrowserAdvisory({ userAgent: SAMSUNG_UA, dismissed: true })).toBe(false);
    expect(shouldShowBrowserAdvisory({ userAgent: CHROME_ANDROID_UA })).toBe(false);
  });
});

describe("dismissal flags", () => {
  it("round-trips a flag, and the two surfaces keep separate keys", () => {
    const storage = fakeStorage();
    expect(readDismissedFlag(storage, IOS_INSTALL_DISMISSED_STORAGE_KEY)).toBe(false);
    writeDismissedFlag(storage, IOS_INSTALL_DISMISSED_STORAGE_KEY);
    expect(readDismissedFlag(storage, IOS_INSTALL_DISMISSED_STORAGE_KEY)).toBe(true);
    // Dismissing the install overlay must not silence the browser advice, and vice versa.
    expect(readDismissedFlag(storage, BROWSER_ADVISORY_DISMISSED_STORAGE_KEY)).toBe(false);
  });

  // Private mode / a partitioned context can THROW on access, not merely return null. Neither read nor write may
  // propagate that: the worst outcome allowed here is one extra sighting of an overlay.
  it("treats a throwing or missing storage as 'not dismissed' and never throws on write", () => {
    const throwing = {
      getItem: (): string => {
        throw new Error("blocked");
      },
      setItem: (): void => {
        throw new Error("blocked");
      }
    };
    expect(readDismissedFlag(throwing, IOS_INSTALL_DISMISSED_STORAGE_KEY)).toBe(false);
    expect(() => writeDismissedFlag(throwing, IOS_INSTALL_DISMISSED_STORAGE_KEY)).not.toThrow();
    expect(readDismissedFlag(null, IOS_INSTALL_DISMISSED_STORAGE_KEY)).toBe(false);
    expect(() => writeDismissedFlag(null, IOS_INSTALL_DISMISSED_STORAGE_KEY)).not.toThrow();
  });
});

describe("live environment readers", () => {
  const seams = {
    navigator: { userAgent: IPHONE_26_UA, standalone: false },
    window: {
      matchMedia: (query: string) => ({ matches: query.includes("fullscreen") }) as MediaQueryList
    },
    storage: fakeStorage({ [IOS_INSTALL_DISMISSED_STORAGE_KEY]: "1" })
  };

  it("lifts UA + display mode + the matching dismissal key", () => {
    expect(readIosInstallOverlayEnv(seams)).toMatchObject({
      userAgent: IPHONE_26_UA,
      navigatorStandalone: false,
      displayModeStandalone: false,
      displayModeFullscreen: true,
      dismissed: true
    });
    // The advisory reads its OWN key, which this storage does not carry.
    expect(readBrowserAdvisoryEnv(seams)).toEqual({ userAgent: IPHONE_26_UA, dismissed: false });
    expect(isRunningStandalone(seams)).toBe(true);
  });

  it("survives a null navigator/window/storage (non-DOM env) without throwing", () => {
    const empty = { navigator: null, window: null, storage: null };
    expect(readIosInstallOverlayEnv(empty)).toEqual({
      userAgent: null,
      navigatorStandalone: false,
      displayModeStandalone: false,
      displayModeFullscreen: false,
      dismissed: false
    });
    expect(isRunningStandalone(empty)).toBe(false);
  });
});

describe("genie-close geometry", () => {
  it("aligns centers with a translate + a scale clamped to the target/card ratio", () => {
    // A 544×400 card at (0,0) flying to a 44×44 pill centered at (400, 20).
    const result = computeGenieTransform(
      { left: 0, top: 0, width: 544, height: 400 },
      { left: 378, top: -2, width: 44, height: 44 }
    );
    expect(result).not.toBeNull();
    expect(result!.dx).toBeCloseTo(378 + 22 - 272, 5);
    expect(result!.dy).toBeCloseTo(-2 + 22 - 200, 5);
    expect(result!.scale).toBeCloseTo(44 / 544, 5);
  });

  it("clamps the scale into [0.04, 0.5]", () => {
    const tiny = computeGenieTransform(
      { left: 0, top: 0, width: 5000, height: 5000 },
      { left: 0, top: 0, width: 1, height: 1 }
    );
    expect(tiny!.scale).toBeCloseTo(0.04, 5);

    const big = computeGenieTransform(
      { left: 0, top: 0, width: 10, height: 10 },
      { left: 0, top: 0, width: 100, height: 100 }
    );
    expect(big!.scale).toBeCloseTo(0.5, 5);
  });

  it("returns null when either rect has no area — the caller's instant-close signal", () => {
    const zeroCard = { left: 0, top: 0, width: 0, height: 0 };
    const zeroTarget = { left: 0, top: 0, width: 0, height: 0 };
    const realRect = { left: 0, top: 0, width: 44, height: 44 };
    expect(computeGenieTransform(zeroCard, realRect)).toBeNull();
    expect(computeGenieTransform(realRect, zeroTarget)).toBeNull();
    expect(computeGenieTransform(zeroCard, zeroTarget)).toBeNull();
  });
});

describe("?iosInstall=force repro lever", () => {
  afterEach(() => {
    __setIosInstallForceForTest(false);
  });

  it("forces readDisplayEnv to a canonical iPhone-26 tab regardless of the real seams", () => {
    __setIosInstallForceForTest(true);
    const seams = {
      navigator: { userAgent: DESKTOP_UA, standalone: true },
      window: { matchMedia: () => ({ matches: true }) as MediaQueryList }
    };
    expect(readDisplayEnv(seams)).toEqual({
      userAgent: IOS_INSTALL_FORCED_UA,
      navigatorStandalone: false,
      displayModeStandalone: false,
      displayModeFullscreen: false
    });
    expect(shouldShowIosInstallHint(readDisplayEnv(seams))).toBe(true);
  });

  it("leaves readDisplayEnv alone when the lever is off", () => {
    expect(readDisplayEnv({ navigator: { userAgent: DESKTOP_UA } }).userAgent).toBe(DESKTOP_UA);
  });

  it("forces element-fullscreen support off, mirroring iPhone Safari", () => {
    const doc = { fullscreenEnabled: true };
    expect(readElementFullscreenSupported(doc)).toBe(true);
    __setIosInstallForceForTest(true);
    expect(readElementFullscreenSupported(doc)).toBe(false);
  });

  it("readElementFullscreenSupported reflects the real flag when the lever is off", () => {
    expect(readElementFullscreenSupported({ fullscreenEnabled: false })).toBe(false);
    expect(readElementFullscreenSupported({ fullscreenEnabled: true })).toBe(true);
    expect(readElementFullscreenSupported(null)).toBe(false);
  });
});
