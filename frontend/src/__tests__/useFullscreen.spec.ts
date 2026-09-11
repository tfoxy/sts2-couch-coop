import { effectScope } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useFullscreen, type FullscreenControls } from "@/composables/useFullscreen";

function setFullscreenEnabled(value: boolean): void {
  Object.defineProperty(document, "fullscreenEnabled", {
    configurable: true,
    value
  });
}

function setFullscreenElement(element: Element | null): void {
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    writable: true,
    value: element
  });
}

// Run the composable inside an effect scope so onScopeDispose fires on scope.stop(),
// and return both the controls and the stopper.
function runInScope(): { api: FullscreenControls; stop: () => void } {
  const scope = effectScope();
  const api = scope.run(() => useFullscreen()) as FullscreenControls;
  return { api, stop: () => scope.stop() };
}

afterEach(() => {
  delete (document as unknown as Record<string, unknown>).fullscreenEnabled;
  delete (document as unknown as Record<string, unknown>).fullscreenElement;
  delete (document.documentElement as unknown as Record<string, unknown>).requestFullscreen;
  delete (document as unknown as Record<string, unknown>).exitFullscreen;
  vi.restoreAllMocks();
});

describe("useFullscreen", () => {
  it("reports supported only when the Fullscreen API is enabled", () => {
    setFullscreenEnabled(true);
    const enabled = runInScope();
    expect(enabled.api.isSupported).toBe(true);
    enabled.stop();

    setFullscreenEnabled(false);
    const disabled = runInScope();
    expect(disabled.api.isSupported).toBe(false);
    disabled.stop();
  });

  it("seeds isFullscreen from the current fullscreenElement", () => {
    setFullscreenEnabled(true);
    setFullscreenElement(document.documentElement);
    const { api, stop } = runInScope();
    expect(api.isFullscreen.value).toBe(true);
    stop();
  });

  it("enter() requests fullscreen on the document element", async () => {
    setFullscreenEnabled(true);
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = requestFullscreen;

    const { api, stop } = runInScope();
    await api.enter();
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    stop();
  });

  it("toggle() enters when not fullscreen and exits when fullscreen", async () => {
    setFullscreenEnabled(true);
    setFullscreenElement(null);
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    const exitFullscreen = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = requestFullscreen;
    document.exitFullscreen = exitFullscreen;

    const { api, stop } = runInScope();

    await api.toggle();
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(exitFullscreen).not.toHaveBeenCalled();

    // Simulate the browser confirming we entered fullscreen.
    setFullscreenElement(document.documentElement);
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(api.isFullscreen.value).toBe(true);

    await api.toggle();
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    stop();
  });

  it("tracks fullscreenchange and stops after scope disposal", () => {
    setFullscreenEnabled(true);
    setFullscreenElement(null);
    const { api, stop } = runInScope();
    expect(api.isFullscreen.value).toBe(false);

    setFullscreenElement(document.documentElement);
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(api.isFullscreen.value).toBe(true);

    stop();

    // After disposal the listener is removed, so further changes are ignored.
    setFullscreenElement(null);
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(api.isFullscreen.value).toBe(true);
  });

  it("swallows a rejected requestFullscreen without throwing", async () => {
    setFullscreenEnabled(true);
    document.documentElement.requestFullscreen = vi
      .fn()
      .mockRejectedValue(new Error("gesture required"));

    const { api, stop } = runInScope();
    await expect(api.enter()).resolves.toBeUndefined();
    stop();
  });
});
