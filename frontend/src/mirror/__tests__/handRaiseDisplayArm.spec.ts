// THE HAND-RAISE BUTTON LIVES IN TWO SPACES AT ONCE, and on the `?stageFit=display` arm they are different spaces.
//
// One component renders two elements from the same anchor arithmetic:
//   * `--chrome`, the visible slab, TELEPORTS out into a mirror node (CombatPileContainer). On the display arm
//     that subtree is laid out in DISPLAY px, so the chrome has to convert.
//   * `--target`, the input surface, does NOT teleport. It stays in the component's own slot, which MirrorView
//     wraps in `.mirror-chrome-layer` — a DESIGN-space layer carrying `transform: scale(fit)` of its own.
//
// So the target must NOT convert: its anchors stay design px and it must carry no layout scale, or the scale is
// applied twice (once by the layer, once by itself) and the anchor lands at design x fit inside a box that then
// scales it again. That misplaces the hit area against the slab a player is aiming at — the one defect class the
// touch harness exists to catch, and it cannot be seen on the default arm because both spaces coincide there.
//
// The second spec pins the PRESS PIVOT. The layout conversion and the press/hover animation both want
// `transform-origin`, and an element has only one: the layout scale needs the bottom-right corner (the anchor it
// is pinned by), while the press wants the centre. They are reconciled by expressing the layout scale as
// `translate(...) scale(...)` about the DEFAULT centre origin, which is algebraically identical to scaling about
// the bottom-right corner — see the component. That leaves `transform-origin` at its default, so the individual
// `scale:` property the animation drives keeps pivoting at the centre on both arms.

import { nextTick, shallowRef } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MirrorHandRaiseButton from "@/mirror/MirrorHandRaiseButton.vue";
import { __resetHandRaiseUiForTest, setHandRaiseLayer } from "@/mirror/handRaiseUi";
import type { MirrorRenderer } from "@/mirror/mirrorRenderer";
import { MIRROR_RENDERER_KEY } from "@/mirror/rendererKey";
import { clearStoredMirrorSettings, mirrorSettings } from "@/mirror/mirrorSettings";
import {
  __resetStageFitForTest,
  __setStageFitForTest,
  activateDisplayLayout,
  setLayoutScale
} from "@/mirror/stageFit";

vi.mock("@/mirror/atlasSprite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/atlasSprite")>();
  return {
    ...actual,
    resolveAtlasSprite: vi.fn(async () => ({
      pageUrl: "/res/ui.png",
      region: { x: 10, y: 20, width: 166, height: 121 },
      margin: { x: 2, y: 22, width: 4, height: 27 }
    }))
  };
});

class TestImage {
  decoding = "";
  src = "";
  decode(): Promise<void> { return Promise.resolve(); }
  addEventListener(): void {}
  removeEventListener(): void {}
}

/** A fit that is NOT 1 and not a round number, so an accidental identity or a double application both show. */
const FIT = 0.4;

interface Mounted {
  chrome: HTMLElement;
  target: HTMLElement;
  unmount: () => void;
}

async function mountOn(mode: "design" | "display", fit: number): Promise<Mounted> {
  __setStageFitForTest(mode);
  activateDisplayLayout(mode === "display");
  setLayoutScale(fit);
  const anchor = document.createElement("div");
  document.body.appendChild(anchor);
  setHandRaiseLayer({ present: true, anchorId: "Piles", domTarget: anchor, covered: false, backend: "dom" });
  const wrapper = mount(MirrorHandRaiseButton, {
    attachTo: document.body,
    global: { provide: { [MIRROR_RENDERER_KEY as symbol]: shallowRef({} as MirrorRenderer) } }
  });
  await flushPromises();
  await nextTick();
  return {
    chrome: anchor.querySelector<HTMLElement>("[data-testid=mirror-hand-raise-chrome]")!,
    target: document.querySelector<HTMLElement>("[data-testid=mirror-hand-raise-button]")!,
    unmount: () => wrapper.unmount()
  };
}

const px = (value: string): number => Number.parseFloat(value);

beforeEach(() => {
  document.body.innerHTML = "";
  vi.stubGlobal("Image", TestImage);
  __resetHandRaiseUiForTest();
  clearStoredMirrorSettings();
  mirrorSettings.raiseHandCards = false;
});

afterEach(() => {
  __resetHandRaiseUiForTest();
  clearStoredMirrorSettings();
  __resetStageFitForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("hand-raise button across the two layout spaces", () => {
  it("converts the TELEPORTED chrome into display px", async () => {
    const design = await mountOn("design", 1);
    const designRight = px(design.chrome.style.right);
    const designBottom = px(design.chrome.style.bottom);
    design.unmount();
    document.body.innerHTML = "";

    const display = await mountOn("display", FIT);

    // The slab teleports into a mirror node, which on this arm is laid out in display px — so its anchor converts.
    expect(px(display.chrome.style.right)).toBeCloseTo(designRight * FIT, 6);
    expect(px(display.chrome.style.bottom)).toBeCloseTo(designBottom * FIT, 6);
    display.unmount();
  });

  it("leaves the INPUT TARGET in design px — it rides MirrorView's already-scaled chrome layer", async () => {
    const design = await mountOn("design", 1);
    const designRight = px(design.target.style.right);
    const designBottom = px(design.target.style.bottom);
    const designWidth = px(design.target.style.width);
    design.unmount();
    document.body.innerHTML = "";

    const display = await mountOn("display", FIT);

    // Unchanged, because `.mirror-chrome-layer` is a design-space box that already carries `scale(fit)`.
    expect(px(display.target.style.right)).toBeCloseTo(designRight, 6);
    expect(px(display.target.style.bottom)).toBeCloseTo(designBottom, 6);
    expect(px(display.target.style.width)).toBeCloseTo(designWidth, 6);
    // …and it must not scale itself on top of the layer that is already scaling it.
    expect(display.target.style.transform ?? "").not.toMatch(/scale/);
    display.unmount();
  });

  it("keeps the press pivot at the CENTRE on both arms", async () => {
    // `transform-origin` is shared between `transform` and the individual `scale:` the animation drives. Pointed
    // at the bottom-right corner for the layout scale's benefit, the press would pivot at the corner on the
    // display arm only — a real divergence between the two arms in a control a player touches.
    //
    // Asserted as a LITERAL rather than against the design arm's value: a capture-and-compare here passed while
    // the bug was live, because both sides can be empty for reasons that have nothing to do with the pivot.
    const display = await mountOn("display", FIT);

    expect(display.chrome.style.transformOrigin).toBe("");
    expect(display.chrome.style.scale).toBe("1"); // the press scale, still its own property and still centred
    display.unmount();
    document.body.innerHTML = "";

    const design = await mountOn("design", 1);
    expect(design.chrome.style.transformOrigin).toBe("");
    design.unmount();
  });

  it("pins the anchor corner exactly, despite scaling about the centre", async () => {
    // The layout scale is written as `translate(d) scale(fit)` about the default centre origin. That is identical
    // to `scale(fit)` about the bottom-right corner, which is what keeps the button welded to its HUD anchor while
    // the art shrinks: for a box of width w, scaling about the centre pulls the right edge in by (w/2)(1-fit), so
    // the compensating translate is exactly that.
    const display = await mountOn("display", FIT);
    const w = px(display.chrome.style.width);
    const h = px(display.chrome.style.height);

    const transform = display.chrome.style.transform;
    const translate = /translate\(([^)]+)\)/.exec(transform);
    expect(translate, `expected a translate() in ${transform}`).not.toBeNull();
    const [dx, dy] = translate![1].split(",").map((p) => Number.parseFloat(p.trim()));

    expect(dx).toBeCloseTo((w / 2) * (1 - FIT), 6);
    expect(dy).toBeCloseTo((h / 2) * (1 - FIT), 6);
    expect(transform).toMatch(new RegExp(`scale\\(${FIT}\\)`));
    display.unmount();
  });
});

// --- the stage's stacking context -------------------------------------------------------------------------------
//
// A SOURCE assertion, deliberately, because the failure it guards is invisible to every other kind of test.
// StaticBackground's underlay sits at the most-negative z-index there is. That only keeps it under the stage's own
// background and OVER `.mirror-frame`'s letterbox black while it resolves inside the stage's stacking context —
// and `position: relative` with `z-index: auto` does not create one. On the design arm the stage's
// `transform: scale()` created it as a side effect; removing the transform for the display arm sent the whole
// combat background behind the frame's #000 while every other node still painted, so the DOM was identical, every
// box was identical, the element counts were identical, and 4,600 tests stayed green. Only a rendered frame
// showed it. jsdom cannot evaluate paint order, so the honest guard is that the declaration is still there.
describe("the stage declares its own stacking context", () => {
  it("keeps `isolation: isolate` on .mirror-stage", async () => {
    // Resolved from the project root, not from `import.meta.url` — vitest serves modules over a non-file URL.
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(`${process.cwd()}/src/mirror/MirrorView.vue`, "utf8")
    );
    // Anchored to the start of a line: the file mentions `.mirror-stage` in prose many times, and an unanchored
    // match found one of those comments instead of the rule (and so passed for the wrong reason).
    const rule = /^\.mirror-stage\s*\{[\s\S]*?\}/m.exec(source);
    expect(rule, "expected a .mirror-stage rule in MirrorView.vue").not.toBeNull();
    // COMMENTS STRIPPED FIRST. The rule's own comment explains the fix and therefore contains the literal string
    // `isolation: isolate`, so asserting against the raw text passed with the declaration deleted — the mutation
    // run caught it. Assert on the declaration, not on the prose about it.
    const declarations = rule![0].replace(/\/\*[\s\S]*?\*\//g, "");
    expect(declarations).toMatch(/isolation:\s*isolate\s*;/);
  });
});
