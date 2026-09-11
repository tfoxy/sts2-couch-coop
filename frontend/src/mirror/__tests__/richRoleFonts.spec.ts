import { beforeEach, describe, expect, it } from "vitest";

import { createMirrorRenderer, type MirrorRenderer } from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// SYNTHETIC END-TO-END proof for the rich-text per-role fonts (the affirmative test — every recorded stream in
// tests/fixtures predates the wire fields, so the corpus can only prove non-regression).
//
// The bug: Godot never SYNTHESISES bold inside a RichTextLabel. It renders a `[b]` span by swapping the label to
// its `bold_font` THEME ITEM — in STS2 a genuinely different file (res://fonts/kreon_bold.ttf). The wire carried
// one font per node, so the mirror's `<strong class="godot-rich-bold">` inherited the label's single 400-weight
// face and `font-synthesis: none` (deliberate — faux bold looks wrong next to the game) correctly refused to fake
// it. The fix is the producer streaming `richBoldFont`; this spec pins the whole client consumption chain that
// turns it into a real bold glyph: wire → MirrorNode → the `--godot-rich-bold-font-family` variable on the text
// element → an injected `@font-face` the browser can actually load the face from.
//
// jsdom neither loads fonts nor computes inherited custom properties, so the assertions are on the three DOM
// artifacts the real browser then resolves against each other (godot-scene-web owns the `.godot-rich-bold`
// rule that reads the variable, and its own suite covers that rule).

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

// One RichTextLabel with a `[b]…[/b]` span, its own (regular) font, and the streamed bold role font — exactly the
// shape the event-screen title arrives in.
function richLabelWire(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "title",
    parentId: null,
    name: "Title",
    nodeType: "Godot.RichTextLabel",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 100, y: 200 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 600, y: 80 } },
    visible: true,
    richText: true,
    text: {
      text: "The [b]Ancient[/b] shrine",
      textColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffffff" },
      fontSize: 24
    },
    font: { resourcePath: "res://fonts/kreon_regular.ttf" },
    richBoldFont: { resourcePath: "res://fonts/kreon_bold.ttf" },
    ...over
  };
}

function full(state: MirrorState, nodes: Record<string, unknown>[], order: string[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({ type: "scene-delta", full: true, screenType: "event", upserts: nodes, orderedIds: order })!
  );
}

function textDiv(stage: HTMLElement): HTMLElement {
  const el = stage.querySelector<HTMLElement>('[data-node-id="title"] .mirror-text');
  expect(el, "the rich label rendered a .mirror-text element").not.toBeNull();
  return el!;
}

function fontSheet(): string {
  return Array.from(document.head.querySelectorAll("style[data-mirror-fonts]"))
    .map((s) => s.textContent ?? "")
    .join("\n");
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("rich-text role fonts end to end", () => {
  it("renders a [b] span, publishes the bold family variable, and injects the bold @font-face", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [richLabelWire()], ["title"]);

    renderer.reconcile(state);

    // 1. The bbcode really produced the role element godot-scene-web's rule targets.
    const bold = stage.querySelector(".godot-rich-bold");
    expect(bold, "[b]…[/b] rendered a .godot-rich-bold element").not.toBeNull();
    expect(bold!.textContent).toContain("Ancient");

    // 2. The text element carries the family variable that rule reads
    //    (`.godot-rich-bold { font-family: var(--godot-rich-bold-font-family, inherit); }`).
    expect(textDiv(stage).style.getPropertyValue("--godot-rich-bold-font-family")).toBe(
      '"kreon_bold", sans-serif'
    );
    // The label's OWN family is still the regular face — the role variable is additive, not a replacement.
    expect(textDiv(stage).style.fontFamily).toContain("kreon_regular");
    expect(textDiv(stage).style.fontSynthesis).toBe("none");

    // 3. The browser can actually load that family: a real @font-face pointing at the served binary.
    const sheet = fontSheet();
    expect(sheet).toContain('font-family:"kreon_bold"');
    expect(sheet).toContain("kreon_bold.ttf");
    // The role face declares NO weight — the FILE is the role, so a `font-weight:700` declaration would invite the
    // browser to synthesise against it instead of using the face as authored.
    const boldFace = sheet.split("@font-face").find((chunk) => chunk.includes("kreon_bold.ttf")) ?? "";
    expect(boldFace).not.toContain("font-weight");
  });

  it("carries the role font across a volatile-only upsert (mergeNode keep-list)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [richLabelWire()], ["title"]);
    renderer.reconcile(state);

    // A per-tick upsert: no name, no static block — exactly what the producer ships once the node exists.
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "event",
        upserts: [
          {
            id: "title",
            parentId: null,
            transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 100, y: 205 } },
            text: { text: "The [b]Ancient[/b] shrine", fontSize: 24 }
          }
        ]
      })!
    );
    renderer.reconcile(state);

    expect(state.nodes.get("title")!.richBoldFont?.family).toBe("kreon_bold");
    expect(textDiv(stage).style.getPropertyValue("--godot-rich-bold-font-family")).toBe(
      '"kreon_bold", sans-serif'
    );
  });

  it("publishes the streamed role size as a ratio and the glyph spacing in px", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(
      state,
      [richLabelWire({ richBoldFontSizePx: 21, richBoldFontSpacingPx: 1 })],
      ["title"]
    );

    renderer.reconcile(state);

    const style = textDiv(stage).style;
    expect(style.getPropertyValue("--godot-rich-bold-font-size")).toBe("calc(1em * 0.875)");
    expect(style.getPropertyValue("--godot-rich-bold-letter-spacing")).toBe("1px");
  });

  it("publishes nothing extra for a rich label with no role data (pre-fix recordings render as before)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [richLabelWire({ richBoldFont: null })], ["title"]);

    renderer.reconcile(state);

    expect(stage.querySelector(".godot-rich-bold"), "the [b] span still renders").not.toBeNull();
    expect(textDiv(stage).style.getPropertyValue("--godot-rich-bold-font-family")).toBe("");
  });
});
