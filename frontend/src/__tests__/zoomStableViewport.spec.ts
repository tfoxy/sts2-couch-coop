import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ZOOM_STABLE_HEIGHT_VAR,
  ZOOM_STABLE_WIDTH_VAR,
  installZoomStableViewport,
  type ZoomStableWindow
} from "@/zoomStableViewport";

const styles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
const normalizedStyles = styles.replace(/\s+/g, " ");

interface FakeZoomEnv {
  window: ZoomStableWindow;
  setViewport(clientWidth: number, clientHeight: number, devicePixelRatio: number): void;
  resize(): void;
  scroller: HTMLElement;
}

// The gsw detector (observeBrowserZoom) reads `devicePixelRatio` and the layout
// viewport from this fake; the spec drives zoom by changing both the way a real
// browser does (dpr × z, viewport ÷ z) and firing `resize`.
function createFakeEnv(clientWidth: number, clientHeight: number, devicePixelRatio: number): FakeZoomEnv {
  const state = { clientWidth, clientHeight, devicePixelRatio };
  const resizeListeners = new Set<() => void>();

  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "scrollWidth", {
    configurable: true,
    get: () => state.clientWidth * 2
  });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    get: () => state.clientHeight * 2
  });
  Object.defineProperty(scroller, "clientWidth", { configurable: true, get: () => state.clientWidth });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => state.clientHeight });

  const documentElement = {
    get clientWidth() {
      return state.clientWidth;
    },
    getBoundingClientRect: () =>
      ({ width: state.clientWidth, height: state.clientHeight }) as DOMRect
  };

  const fakeWindow = {
    get devicePixelRatio() {
      return state.devicePixelRatio;
    },
    document: {
      documentElement,
      getElementById: () => scroller
    },
    addEventListener: (type: string, listener: () => void) => {
      if (type === "resize") resizeListeners.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === "resize") resizeListeners.delete(listener);
    },
    matchMedia: undefined
  } as unknown as ZoomStableWindow;

  return {
    window: fakeWindow,
    setViewport(nextWidth, nextHeight, nextDpr) {
      state.clientWidth = nextWidth;
      state.clientHeight = nextHeight;
      state.devicePixelRatio = nextDpr;
    },
    resize() {
      for (const listener of [...resizeListeners]) listener();
    },
    scroller
  };
}

describe("zoom-stable viewport", () => {
  it("wires the CSS chain: #app pans, .game-surface sizes from the zoom vars", () => {
    expect(normalizedStyles).toContain(`width: var(${ZOOM_STABLE_WIDTH_VAR}, 100%)`);
    expect(normalizedStyles).toContain(`height: var(${ZOOM_STABLE_HEIGHT_VAR}, 100%)`);
    expect(normalizedStyles).toMatch(/#app \{[^}]*display: flex;[^}]*overflow: auto;/);
    expect(normalizedStyles).toMatch(/\.game-surface \{[^}]*margin: auto;/);
  });

  it("leaves the vars unset at 100% zoom (legacy `%` layout)", () => {
    const env = createFakeEnv(1280, 720, 1);
    const root = document.createElement("div");
    const installed = installZoomStableViewport(root, env.window);

    expect(root.style.getPropertyValue(ZOOM_STABLE_WIDTH_VAR)).toBe("");
    expect(root.style.getPropertyValue(ZOOM_STABLE_HEIGHT_VAR)).toBe("");

    // A plain resize at 100% stays on the pure-% chain.
    env.setViewport(900, 600, 1);
    env.resize();
    expect(root.style.getPropertyValue(ZOOM_STABLE_WIDTH_VAR)).toBe("");

    installed.dispose();
  });

  it("pins the surface to its 100%-zoom size under browser zoom, in and out", () => {
    const env = createFakeEnv(1280, 720, 1);
    const root = document.createElement("div");
    const installed = installZoomStableViewport(root, env.window);

    // 200%: viewport halves in CSS px, dpr doubles → surface stays 1280×720.
    env.setViewport(640, 360, 2);
    env.resize();
    expect(root.style.getPropertyValue(ZOOM_STABLE_WIDTH_VAR)).toBe("1280px");
    expect(root.style.getPropertyValue(ZOOM_STABLE_HEIGHT_VAR)).toBe("720px");
    // Scroll recentred on the (fake 2×) overflow.
    expect(env.scroller.scrollLeft).toBe(320);
    expect(env.scroller.scrollTop).toBe(180);

    // Back to 100% → vars removed.
    env.setViewport(1280, 720, 1);
    env.resize();
    expect(root.style.getPropertyValue(ZOOM_STABLE_WIDTH_VAR)).toBe("");
    expect(root.style.getPropertyValue(ZOOM_STABLE_HEIGHT_VAR)).toBe("");

    // 50%: viewport doubles, dpr halves → surface still 1280×720 (centered, smaller).
    env.setViewport(2560, 1440, 0.5);
    env.resize();
    expect(root.style.getPropertyValue(ZOOM_STABLE_WIDTH_VAR)).toBe("1280px");
    expect(root.style.getPropertyValue(ZOOM_STABLE_HEIGHT_VAR)).toBe("720px");

    installed.dispose();
  });

  it("re-derives the pinned size when the window resizes while zoomed", () => {
    const env = createFakeEnv(1280, 720, 1);
    const root = document.createElement("div");
    const installed = installZoomStableViewport(root, env.window);

    env.setViewport(640, 360, 2);
    env.resize();
    expect(root.style.getPropertyValue(ZOOM_STABLE_WIDTH_VAR)).toBe("1280px");

    // Still at 200% zoom, the OS window shrinks: same dpr, smaller viewport.
    env.setViewport(500, 300, 2);
    env.resize();
    expect(root.style.getPropertyValue(ZOOM_STABLE_WIDTH_VAR)).toBe("1000px");
    expect(root.style.getPropertyValue(ZOOM_STABLE_HEIGHT_VAR)).toBe("600px");

    installed.dispose();
  });

  it("dispose removes the vars and stops reacting", () => {
    const env = createFakeEnv(1280, 720, 1);
    const root = document.createElement("div");
    const installed = installZoomStableViewport(root, env.window);

    env.setViewport(640, 360, 2);
    env.resize();
    expect(root.style.getPropertyValue(ZOOM_STABLE_WIDTH_VAR)).toBe("1280px");

    installed.dispose();
    expect(root.style.getPropertyValue(ZOOM_STABLE_WIDTH_VAR)).toBe("");

    env.setViewport(320, 180, 4);
    env.resize();
    expect(root.style.getPropertyValue(ZOOM_STABLE_WIDTH_VAR)).toBe("");
  });
});
