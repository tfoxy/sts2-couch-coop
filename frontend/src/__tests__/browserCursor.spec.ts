import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  coarseOnlyPointer,
  computeCursorCrop,
  GAME_CURSOR_DEFAULT_URL,
  GAME_CURSOR_MAX_SIZE,
  GAME_CURSOR_PRESSED_URL,
  GAME_CURSOR_ROOT_CLASS,
  GAME_CURSOR_STYLE_ID,
  installBrowserCursor,
  type ProcessCursorImage
} from "@/browserCursor";

const styles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
const normalizedStyles = styles.replace(/\s+/g, " ");
const indexHtml = readFileSync(join(process.cwd(), "index.html"), "utf8");

afterEach(() => {
  document.documentElement.classList.remove(GAME_CURSOR_ROOT_CLASS);
  document.getElementById(GAME_CURSOR_STYLE_ID)?.remove();
});

const flushMicrotasks = () => Promise.resolve();

/** Build an RGBA buffer with a fully-opaque rectangle on a transparent field. */
function makeRgbaWithBox(
  width: number,
  height: number,
  box: { x: number; y: number; w: number; h: number }
): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      data[(y * width + x) * 4 + 3] = 255;
    }
  }
  return { data, width, height };
}

const fakeProcess: ProcessCursorImage = (url) =>
  Promise.resolve({ dataUrl: `data:fake,${url}`, hotspotX: 3, hotspotY: 2 });

describe("computeCursorCrop", () => {
  it("trims to the non-transparent bbox and shifts the hotspot when no scaling is needed", () => {
    const img = makeRgbaWithBox(40, 40, { x: 10, y: 6, w: 16, h: 12 });

    const crop = computeCursorCrop(img, 14, 9);

    expect(crop).not.toBeNull();
    expect({ sx: crop!.sx, sy: crop!.sy, sw: crop!.sw, sh: crop!.sh }).toEqual({ sx: 10, sy: 6, sw: 16, sh: 12 });
    expect(crop!.scale).toBe(1);
    expect({ dw: crop!.dw, dh: crop!.dh }).toEqual({ dw: 16, dh: 12 });
    // Hotspot shifts by the bbox origin only.
    expect({ x: crop!.hotspotX, y: crop!.hotspotY }).toEqual({ x: 4, y: 3 });
  });

  it("downscales bboxes larger than the max size and scales the hotspot", () => {
    const img = makeRgbaWithBox(80, 80, { x: 4, y: 4, w: 50, h: 40 });

    const crop = computeCursorCrop(img, 14, 24);

    const scale = GAME_CURSOR_MAX_SIZE / 50;
    expect(crop!.scale).toBe(scale);
    expect(crop!.dw).toBe(Math.ceil(50 * scale));
    expect(crop!.dh).toBe(Math.ceil(40 * scale));
    expect(crop!.hotspotX).toBe(Math.round((14 - 4) * scale));
    expect(crop!.hotspotY).toBe(Math.round((24 - 4) * scale));
    expect(crop!.dw).toBeLessThanOrEqual(GAME_CURSOR_MAX_SIZE);
    expect(crop!.dh).toBeLessThanOrEqual(GAME_CURSOR_MAX_SIZE);
  });

  it("returns null for a fully transparent bitmap", () => {
    const img = { data: new Uint8ClampedArray(8 * 8 * 4), width: 8, height: 8 };

    expect(computeCursorCrop(img, 0, 0)).toBeNull();
  });

  it("clamps a hotspot that falls outside the trimmed bbox into the output bitmap", () => {
    const img = makeRgbaWithBox(40, 40, { x: 20, y: 20, w: 8, h: 8 });

    // Hotspot (0,0) is in the trimmed-away padding above/left of the bbox.
    const crop = computeCursorCrop(img, 0, 0);

    expect(crop!.hotspotX).toBe(0);
    expect(crop!.hotspotY).toBe(0);
    expect(crop!.hotspotX).toBeLessThanOrEqual(crop!.dw - 1);
    expect(crop!.hotspotY).toBeLessThanOrEqual(crop!.dh - 1);
  });
});

describe("browser cursor assets", () => {
  it("links the game favicon and preloads both game cursor resources", () => {
    expect(indexHtml).toContain('<link rel="icon" href="/favicon.ico" />');
    expect(indexHtml).toContain(`href="${GAME_CURSOR_DEFAULT_URL}"`);
    expect(indexHtml).toContain(`href="${GAME_CURSOR_PRESSED_URL}"`);
  });

  it("leaves the game cursor styling to the injected stylesheet, not styles.css", () => {
    expect(normalizedStyles).not.toContain("cursor: url(");
    expect(normalizedStyles).not.toContain("game-cursor-overlay");
    expect(normalizedStyles).not.toContain("cursor: none");
  });

  // The pressed cursor is applied to the ELEMENT UNDER THE POINTER, never to the document root: a root-level
  // toggle (with the `.game-cursor *` rules) invalidated every element's style twice per tap — ~594ms on the
  // mirror's 3,667-element map screen. These assertions are the regression guard for that.
  it("presses the element under the pointer, follows it while held, and never touches the root class", async () => {
    const target = document.createElement("div");
    const other = document.createElement("div");
    document.body.append(target, other);
    const installed = installBrowserCursor(document.documentElement, window, { processImage: fakeProcess });
    await flushMicrotasks(); // the pressed art has to have resolved before it can be worn

    expect(document.documentElement.classList.contains(GAME_CURSOR_ROOT_CLASS)).toBe(true);

    const press = (el: Element) => el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    const move = (el: Element) => el.dispatchEvent(new Event("pointermove", { bubbles: true }));
    const release = (type: string) => window.dispatchEvent(new Event(type));

    press(target);
    expect(target.style.cursor).toContain(`url(data:fake,${GAME_CURSOR_PRESSED_URL}) 3 2`);
    expect(target.style.getPropertyPriority("cursor")).toBe("important");
    // The document root is NOT the mechanism any more — that is the whole point.
    expect(document.documentElement.className).toBe(GAME_CURSOR_ROOT_CLASS);
    expect(document.documentElement.style.cursor).toBe("");

    // Dragging under the held button moves the pressed art with the pointer — exactly one element wears it.
    move(other);
    expect(target.style.cursor).toBe("");
    expect(other.style.cursor).toContain(`url(data:fake,${GAME_CURSOR_PRESSED_URL})`);

    release("pointerup");
    expect(other.style.cursor).toBe("");

    press(target);
    release("pointercancel");
    expect(target.style.cursor).toBe("");

    press(target);
    release("blur");
    expect(target.style.cursor).toBe("");

    // …and a move AFTER the release is not tracked at all (the listener only exists while held).
    move(other);
    expect(other.style.cursor).toBe("");

    installed.dispose();
    expect(document.documentElement.classList.contains(GAME_CURSOR_ROOT_CLASS)).toBe(false);
    target.remove();
    other.remove();
  });

  it("clears a held press on dispose", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const installed = installBrowserCursor(document.documentElement, window, { processImage: fakeProcess });
    await flushMicrotasks();

    target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(target.style.cursor).not.toBe("");

    installed.dispose();
    expect(target.style.cursor).toBe("");
    target.remove();
  });

  it("does not install on a coarse-pointer-only device (a phone has no cursor to decorate)", () => {
    const phoneWindow = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      matchMedia: ((query: string) => ({ matches: query.includes("coarse") })) as unknown as typeof window.matchMedia
    };

    const installed = installBrowserCursor(document.documentElement, phoneWindow, { processImage: fakeProcess });

    expect(installed.installed).toBe(false);
    expect(phoneWindow.addEventListener).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains(GAME_CURSOR_ROOT_CLASS)).toBe(false);
    expect(coarseOnlyPointer(phoneWindow)).toBe(true);

    // The test seam can still cover installation independently of pointer capability.
    const forced = installBrowserCursor(document.documentElement, phoneWindow, {
      processImage: fakeProcess,
      force: true
    });
    expect(forced.installed).toBe(true);
    expect(document.documentElement.classList.contains(GAME_CURSOR_ROOT_CLASS)).toBe(true);
    forced.dispose();
  });

  it("installs on a device that reports a fine pointer, and on one that reports nothing", () => {
    const laptop = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      // A touchscreen laptop: BOTH pointers. It has a real cursor, so it keeps the game one.
      matchMedia: ((query: string) => ({ matches: query.includes("fine") || query.includes("coarse") })) as unknown as typeof window.matchMedia
    };
    expect(coarseOnlyPointer(laptop)).toBe(false);
    const onLaptop = installBrowserCursor(document.documentElement, laptop, { processImage: fakeProcess });
    expect(onLaptop.installed).toBe(true);
    onLaptop.dispose();

    // No matchMedia at all (an old browser / a test shell) is NOT a phone — install, as before.
    const bare = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    expect(coarseOnlyPointer(bare)).toBe(false);
    const onBare = installBrowserCursor(document.documentElement, bare, { processImage: fakeProcess });
    expect(onBare.installed).toBe(true);
    onBare.dispose();
  });

  it("injects a native cursor stylesheet carrying the processed DEFAULT cursor only", async () => {
    const installed = installBrowserCursor(document.documentElement, window, { processImage: fakeProcess });

    expect(document.getElementById(GAME_CURSOR_STYLE_ID)).toBeNull();

    await flushMicrotasks();

    const style = document.getElementById(GAME_CURSOR_STYLE_ID);
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain(
      `.game-cursor, .game-cursor body, .game-cursor #app, .game-cursor * { cursor: url(data:fake,${GAME_CURSOR_DEFAULT_URL}) 3 2, auto !important; }`
    );
    // The PRESSED art is never a document-wide rule any more (it rides one element's inline style), so the
    // stylesheet is written once and then never mutated — a sheet mutation is itself a full-document recalc.
    expect(style?.textContent).not.toContain(GAME_CURSOR_PRESSED_URL);
    expect(style?.textContent).not.toContain("game-cursor-pressed");

    installed.dispose();
    expect(document.getElementById(GAME_CURSOR_STYLE_ID)).toBeNull();
  });

  it("does not inject the stylesheet when disposed before processing resolves", async () => {
    const installed = installBrowserCursor(document.documentElement, window, { processImage: fakeProcess });
    installed.dispose();

    await flushMicrotasks();

    expect(document.getElementById(GAME_CURSOR_STYLE_ID)).toBeNull();
  });
});
