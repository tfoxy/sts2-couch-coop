import { describe, expect, it } from "vitest";

import { isIosPlatform } from "@/platform";

// The UA strings two consumers depend on. `pwa/installPrompt` asks this to keep two install affordances from
// overlapping; `render/quality` asks it to seed both effect families off on the engine that is being jetsam-killed
// — so a drift here is a shipped-default drift, not just a hidden button.
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_26_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const IPAD_LEGACY_UA =
  "Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1";
// iPadOS 13+ and a real Mac send THE SAME user agent. Only the touch points separate them.
const MAC_SHAPED_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const MAC_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

describe("isIosPlatform", () => {
  it("names every device whose browser is WebKit by decree", () => {
    for (const ua of [IPHONE_UA, IPHONE_26_UA, IPAD_LEGACY_UA]) {
      expect(isIosPlatform(ua)).toBe(true);
    }
  });

  it("catches an iPadOS 13+ tablet behind its desktop `Macintosh` UA", () => {
    // The ONLY term that can. Miss it and a whole device class silently takes the desktop path.
    expect(isIosPlatform(MAC_SHAPED_UA, 5)).toBe(true);
    expect(isIosPlatform(MAC_SHAPED_UA, 2)).toBe(true);
  });

  it("leaves a real Mac alone — one touch point or none is not a tablet", () => {
    expect(isIosPlatform(MAC_SHAPED_UA, 0)).toBe(false);
    expect(isIosPlatform(MAC_SHAPED_UA, 1)).toBe(false);
    expect(isIosPlatform(MAC_SHAPED_UA)).toBe(false); // the default, for a caller with no touch signal
    expect(isIosPlatform(MAC_CHROME_UA, 0)).toBe(false);
  });

  it("is false for a touch device that is not Apple's, and for an absent UA", () => {
    expect(isIosPlatform(ANDROID_UA, 5)).toBe(false);
    expect(isIosPlatform(null)).toBe(false);
    expect(isIosPlatform(undefined, 5)).toBe(false);
    expect(isIosPlatform("")).toBe(false);
  });
});
