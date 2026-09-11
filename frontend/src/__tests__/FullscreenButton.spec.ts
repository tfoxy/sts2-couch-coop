import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import FullscreenButton from "@/components/FullscreenButton.vue";

function setFullscreenEnabled(value: boolean): void {
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value });
}

function setFullscreenElement(element: Element | null): void {
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    writable: true,
    value: element
  });
}

afterEach(() => {
  delete (document as unknown as Record<string, unknown>).fullscreenEnabled;
  delete (document as unknown as Record<string, unknown>).fullscreenElement;
  delete (document.documentElement as unknown as Record<string, unknown>).requestFullscreen;
  delete (document as unknown as Record<string, unknown>).exitFullscreen;
  vi.restoreAllMocks();
});

describe("FullscreenButton", () => {
  it("renders nothing when fullscreen is unsupported", () => {
    setFullscreenEnabled(false);
    const wrapper = mount(FullscreenButton);
    expect(wrapper.find('[data-testid="fullscreen-button"]').exists()).toBe(false);
  });

  // WS1: an installed / home-screen app has no browser chrome LEFT to hide, so the toggle is an 80×80 hole in
  // an already-chromeless UI. `fullscreenEnabled` does not catch that on its own — an installed Android PWA
  // still reports true — which is why the display-mode signals are checked separately.
  it("renders nothing when the page is already running standalone, even though fullscreen is supported", () => {
    setFullscreenEnabled(true);
    setFullscreenElement(null);
    const wrapper = mount(FullscreenButton, { props: { standalone: true } });
    expect(wrapper.find('[data-testid="fullscreen-button"]').exists()).toBe(false);
  });

  it("renders the enter-fullscreen button when supported", () => {
    setFullscreenEnabled(true);
    setFullscreenElement(null);
    const wrapper = mount(FullscreenButton);
    const button = wrapper.get('[data-testid="fullscreen-button"]');
    expect(button.attributes("title")).toBe("Enter fullscreen");
    expect(button.attributes("aria-pressed")).toBe("false");
    // Four corner brackets for the expand glyph.
    expect(wrapper.findAll("svg path")).toHaveLength(4);
  });

  it("requests fullscreen on click and swaps to the exit glyph on change", async () => {
    setFullscreenEnabled(true);
    setFullscreenElement(null);
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = requestFullscreen;

    const wrapper = mount(FullscreenButton);
    await wrapper.get('[data-testid="fullscreen-button"]').trigger("click");
    expect(requestFullscreen).toHaveBeenCalledTimes(1);

    setFullscreenElement(document.documentElement);
    document.dispatchEvent(new Event("fullscreenchange"));
    await wrapper.vm.$nextTick();

    const button = wrapper.get('[data-testid="fullscreen-button"]');
    expect(button.attributes("title")).toBe("Exit fullscreen");
    expect(button.attributes("aria-pressed")).toBe("true");
  });
});
