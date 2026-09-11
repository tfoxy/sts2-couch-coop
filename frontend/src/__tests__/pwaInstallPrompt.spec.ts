import { beforeEach, describe, expect, it } from "vitest";

import {
  createInstallPromptController,
  isInstallOfferAllowed,
  isIosPlatform,
  isRunningInstalled,
  type BeforeInstallPromptEventLike,
  type InstallPromptEnv
} from "@/pwa/installPrompt";

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPADOS_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

class FakeWindow {
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    const bucket = this.listeners.get(type) ?? [];
    const at = bucket.indexOf(listener);
    if (at >= 0) bucket.splice(at, 1);
  }

  emit(type: string, event?: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  count(type: string): number {
    return (this.listeners.get(type) ?? []).length;
  }
}

function fakePromptEvent(outcome: "accepted" | "dismissed" = "accepted"): BeforeInstallPromptEventLike & {
  prevented: number;
  prompted: number;
} {
  const event = {
    prevented: 0,
    prompted: 0,
    preventDefault() {
      event.prevented += 1;
    },
    async prompt() {
      event.prompted += 1;
    },
    userChoice: Promise.resolve({ outcome })
  };
  return event;
}

function memoryStorage(seed: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> & {
  data: Record<string, string>;
} {
  const data = { ...seed };
  return {
    data,
    getItem: (key: string) => (key in data ? data[key] : null),
    setItem: (key: string, value: string) => {
      data[key] = value;
    }
  };
}

function env(overrides: Partial<InstallPromptEnv> = {}): InstallPromptEnv & { window: FakeWindow } {
  const win = new FakeWindow();
  return {
    window: win,
    userAgent: ANDROID_UA,
    maxTouchPoints: 5,
    matchMedia: () => ({ matches: false }),
    storage: memoryStorage(),
    now: () => 1_000_000,
    ...overrides,
    // `window` must stay the FakeWindow instance we can emit on, even if a caller overrode other keys.
    ...(overrides.window ? { window: overrides.window } : {})
  } as InstallPromptEnv & { window: FakeWindow };
}

describe("install prompt: platform gates", () => {
  it("detects iOS, including iPadOS masquerading as a Mac", () => {
    expect(isIosPlatform(IPHONE_UA)).toBe(true);
    expect(isIosPlatform(IPADOS_UA, 5)).toBe(true);
    // A real Mac reports no touch points.
    expect(isIosPlatform(IPADOS_UA, 0)).toBe(false);
    expect(isIosPlatform(ANDROID_UA, 5)).toBe(false);
    expect(isIosPlatform(null)).toBe(false);
  });

  it("treats fullscreen display-mode as installed, not just standalone", () => {
    // Load-bearing: the manifest declares `"display": "fullscreen"`, so an installed Android PWA of THIS
    // app never reports `display-mode: standalone`.
    const fullscreen = (query: string) => ({ matches: query.includes("fullscreen") });
    expect(isRunningInstalled({ matchMedia: fullscreen })).toBe(true);
    expect(isRunningInstalled({ matchMedia: () => ({ matches: false }) })).toBe(false);
    expect(isRunningInstalled({ navigatorStandalone: true })).toBe(true);
    expect(isRunningInstalled({})).toBe(false);
  });

  it("never offers on iOS or when already installed", () => {
    expect(isInstallOfferAllowed(env())).toBe(true);
    expect(isInstallOfferAllowed(env({ userAgent: IPHONE_UA }))).toBe(false);
    expect(isInstallOfferAllowed(env({ matchMedia: () => ({ matches: true }) }))).toBe(false);
  });

  it("respects a recent decline, and forgets it once it has expired", () => {
    const key = "couchcoop.installPrompt.snoozedUntil";
    expect(isInstallOfferAllowed(env({ storage: memoryStorage({ [key]: "2000000" }) }))).toBe(false);
    expect(isInstallOfferAllowed(env({ storage: memoryStorage({ [key]: "500000" }) }))).toBe(true);
    expect(isInstallOfferAllowed(env({ storage: memoryStorage({ [key]: "not a number" }) }))).toBe(true);
    expect(isInstallOfferAllowed(env({ storage: undefined }))).toBe(true);
  });
});

describe("install prompt controller", () => {
  let e: InstallPromptEnv & { window: FakeWindow };
  beforeEach(() => {
    e = env();
  });

  it("stays hidden until Chrome offers an event", () => {
    const controller = createInstallPromptController(e);
    expect(controller.visible.value).toBe(false);
    controller.dispose();
  });

  it("captures beforeinstallprompt, suppresses the browser UI and shows the button", () => {
    const controller = createInstallPromptController(e);
    const event = fakePromptEvent();
    e.window.emit("beforeinstallprompt", event);

    expect(event.prevented).toBe(1);
    expect(controller.visible.value).toBe(true);
    controller.dispose();
  });

  it("never shows on iOS even if the event somehow fires", () => {
    const ios = env({ userAgent: IPHONE_UA });
    const controller = createInstallPromptController(ios);
    ios.window.emit("beforeinstallprompt", fakePromptEvent());
    expect(controller.visible.value).toBe(false);
    controller.dispose();
  });

  it("prompts once and hides, whatever the outcome", async () => {
    const controller = createInstallPromptController(e);
    const event = fakePromptEvent("accepted");
    e.window.emit("beforeinstallprompt", event);

    expect(await controller.promptInstall()).toBe("accepted");
    expect(event.prompted).toBe(1);
    expect(controller.visible.value).toBe(false);

    // A BeforeInstallPromptEvent is single use — a second tap must not call prompt() again (it throws).
    expect(await controller.promptInstall()).toBe("unavailable");
    expect(event.prompted).toBe(1);
    controller.dispose();
  });

  it("snoozes the button after the player declines", async () => {
    const storage = memoryStorage();
    const declined = env({ storage });
    const controller = createInstallPromptController(declined);
    declined.window.emit("beforeinstallprompt", fakePromptEvent("dismissed"));

    expect(await controller.promptInstall()).toBe("dismissed");
    expect(Number(storage.data["couchcoop.installPrompt.snoozedUntil"])).toBeGreaterThan(1_000_000);
    // A later load with the same clock will not offer again.
    expect(isInstallOfferAllowed(env({ storage }))).toBe(false);
    controller.dispose();
  });

  it("hides on appinstalled", () => {
    const controller = createInstallPromptController(e);
    e.window.emit("beforeinstallprompt", fakePromptEvent());
    expect(controller.visible.value).toBe(true);

    e.window.emit("appinstalled");
    expect(controller.visible.value).toBe(false);
    controller.dispose();
  });

  it("hides when the page flips into an installed display mode", () => {
    let installed = false;
    const changeListeners: (() => void)[] = [];
    const live = env({
      matchMedia: (query: string) => ({
        get matches() {
          return installed && query.includes("fullscreen");
        },
        addEventListener: (_type: "change", listener: () => void) => changeListeners.push(listener),
        removeEventListener: () => {}
      })
    });

    const controller = createInstallPromptController(live);
    live.window.emit("beforeinstallprompt", fakePromptEvent());
    expect(controller.visible.value).toBe(true);

    // Installed from the browser's own ⋮ menu while our button was up.
    installed = true;
    for (const listener of changeListeners) listener();
    expect(controller.visible.value).toBe(false);
    controller.dispose();
  });

  it("unhooks every listener on dispose", () => {
    const controller = createInstallPromptController(e);
    controller.dispose();
    expect(e.window.count("beforeinstallprompt")).toBe(0);
    expect(e.window.count("appinstalled")).toBe(0);
  });
});
