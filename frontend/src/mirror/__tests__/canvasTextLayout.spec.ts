import { describe, expect, it } from "vitest";

import {
  LINE_PITCH_RATIO,
  RASTER_SCALE_MAX,
  RASTER_SCALE_MIN,
  RASTER_SCALE_STEP,
  RASTER_SCALE_STEP_REST,
  baselineOf,
  breakOpportunities,
  layoutText,
  rasterScaleFor,
  resolveTextSpec,
  textDigest,
  type TextSpec
} from "@/mirror/canvas/textLayout";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorNode } from "@/mirror/sceneTree";
import { resolveTextScaleDecls } from "@/mirror/textScaleClasses";
import { fnv1a32 } from "@/mirror/textWrap";

// M4's PURE half: the raster descriptor and the line breaker. Nothing here needs a canvas, which is the point of
// separating them — the rules are the part that can be wrong in a way a screenshot cannot show you.
//
// The measurement callback is a STUB with a known metric (every character is `CH` wide), so a wrap assertion is
// about the breaker's decisions and not about a font. Two specs use a proportional stub instead, where the point
// IS that width differs per character.

const CH = 10;
const measureFixed = (s: string) => s.length * CH;

/** Real `MirrorNode`s through the real parser — `resolveTextSpec` reads wire-shaped fields. */
function nodeOf(over: Record<string, unknown>): MirrorNode {
  const state = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      orderedIds: ["n"],
      upserts: [
        {
          id: "n",
          parentId: null,
          name: "n",
          nodeType: "Godot.Label",
          transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
          localRect: { position: { x: 0, y: 0 }, size: { x: 200, y: 60 } },
          visible: true,
          font: { resourcePath: "res://fonts/kreon_regular.ttf" },
          ...over
        }
      ]
    })!
  );
  return state.nodes.get("n")!;
}

const NO_DECLS = { self: {}, text: {} };

function specOf(over: Record<string, unknown>, decls = NO_DECLS): TextSpec {
  const spec = resolveTextSpec(nodeOf(over), decls);
  expect(spec, "resolveTextSpec returned null for a node that carries text").not.toBeNull();
  return spec!;
}

function textWire(text: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { text: { text, fontSize: 20, textColor: { html: "#ffffffff" }, ...over } };
}

describe("resolveTextSpec — the raster descriptor", () => {
  it("returns null for a node with no text at all", () => {
    expect(resolveTextSpec(nodeOf({}), NO_DECLS)).toBeNull();
  });

  it("builds the canvas2D font shorthand from the streamed face and size", () => {
    const spec = specOf(textWire("hi"));
    expect(spec.fontPx).toBe(20);
    expect(spec.cssFont).toBe('20px "kreon_regular"');
    expect(spec.family).toBe("kreon_regular");
  });

  it("appends NO sans-serif fallback — a raster taken before the face loads would bake the wrong glyphs", () => {
    // The DOM path carries `, sans-serif` because an element re-renders for free once the face arrives. A texture
    // does not: it would be uploaded once, in the fallback, and reused until the label's text changed.
    expect(specOf(textWire("hi")).cssFont).not.toContain("sans-serif");
  });

  it("multiplies the streamed size by the resolved --godot-text-scale", () => {
    const spec = specOf(textWire("hi"), { self: { "--godot-text-scale": "1.42" }, text: {} });
    expect(spec.fontPx).toBeCloseTo(28.4, 5);
  });

  it("honours the End-Turn !important font-size CAP over the scaled size", () => {
    // `!important` in an author stylesheet beats a non-important inline style, which is exactly why that rule
    // carries it — so 40 x 1.54 does NOT win here.
    const decls = {
      self: { "--godot-text-scale": "1.54" },
      text: { "font-size": "min(calc(var(--godot-font-px, 0px) * var(--godot-text-scale, 1)), 34px) !important" }
    };
    expect(specOf(textWire("END TURN", { fontSize: 40 }), decls).fontPx).toBe(34);
  });

  it("leaves a size UNDER the cap alone", () => {
    const decls = {
      self: {},
      text: { "font-size": "min(calc(var(--godot-font-px, 0px) * var(--godot-text-scale, 1)), 34px) !important" }
    };
    expect(specOf(textWire("hi", { fontSize: 20 }), decls).fontPx).toBe(20);
  });

  it("scales the outline by OUTLINE_SCALE — a centred stroke straddles the glyph edge", () => {
    const spec = specOf(textWire("45/45", { outlineColor: { html: "#000000ff" }, outlineSize: 10 }));
    expect(spec.outlinePx).toBe(5);
    expect(spec.outlineColor).toBe("#000000ff");
  });

  it("prefers the VOLATILE outline colour over the stale top-level one", () => {
    // The HP label's outline turns blue while the player is blocking, and that is a different raster.
    const node = nodeOf({
      ...textWire("45/45", { outlineColor: { html: "#0000ffff" }, outlineSize: 8 }),
      outlineColor: { html: "#000000ff" },
      outlineSize: 10
    });
    const spec = resolveTextSpec(node, NO_DECLS)!;
    expect(spec.outlineColor).toBe("#0000ffff");
    expect(spec.outlinePx).toBe(4);
  });

  it("treats an outline colour at size 0 as no outline", () => {
    expect(specOf(textWire("hi", { outlineColor: { html: "#000000ff" }, outlineSize: 0 })).outlinePx).toBe(0);
  });

  it("carries the shadow offset and colour", () => {
    const spec = specOf({ ...textWire("hi"), shadow: { color: { html: "#000000aa" }, offset: { x: 2, y: 3 } } });
    expect(spec.shadow).toEqual({ dx: 2, dy: 3, color: "#000000aa" });
  });

  it("derives the line pitch as an ABSOLUTE 1.1x the font size", () => {
    expect(specOf(textWire("hi", { fontSize: 20 })).pitchPx).toBeCloseTo(20 * LINE_PITCH_RATIO, 5);
  });

  it("lets the table override the pitch with calc(<n>em + <m>px)", () => {
    const spec = specOf(textWire("hi", { fontSize: 20 }), { self: {}, text: { "line-height": "calc(0.79em + 1px)" } });
    expect(spec.pitchPx).toBeCloseTo(0.79 * 20 + 1, 5);
  });

  // --- THE CARD-DESCRIPTION SPACING, which is the second half of the reported defect -------------------------
  //
  // `mirrorTextScale.css` gives every card description `--godot-rich-line-height: calc(0.88em + 1px)` and
  // `--godot-rich-paragraph-spacing: 0.14em`, and its own comment says those are kept in lockstep with the
  // native `TextScale.CardDescLineHeight` / `CardDescParagraphExtra` — i.e. the DOM value IS the game's value.
  // The canvas read NEITHER and fell through to 1.1x, so at the live font size of 21 it set 23.1px where the
  // game sets 19.5px, on the most-read text in the game. These pin both properties and their precedence.

  it("takes the card rule's --godot-rich-line-height, which the canvas used to ignore entirely", () => {
    const decls = { self: { "--godot-rich-line-height": "calc(0.88em + 1px)" }, text: {} };
    expect(specOf(textWire("hi", { fontSize: 20 }), decls).pitchPx).toBeCloseTo(0.88 * 20 + 1, 5);
    // …and the miss it replaces, stated as the number: 1.1 x 20 is 22 against the game's 18.6.
    expect(0.88 * 20 + 1).toBeLessThan(20 * LINE_PITCH_RATIO);
  });

  it("lets a plain `line-height` outrank the custom property — an ordinary declaration wins", () => {
    // The two reach a label by different routes: `line-height` applies to the label's own line boxes, while the
    // custom property inherits into gsw's `.godot-rich-paragraph` blocks. A rule setting both means the plain
    // one, and asserting the precedence is what stops a future rule from silently changing which wins.
    const decls = {
      self: { "--godot-rich-line-height": "calc(0.88em + 1px)" },
      text: { "line-height": "calc(0.79em + 1px)" }
    };
    expect(specOf(textWire("hi", { fontSize: 20 }), decls).pitchPx).toBeCloseTo(0.79 * 20 + 1, 5);
  });

  it("reads --godot-rich-paragraph-spacing as a font-relative length, and 0 when there is none", () => {
    const decls = { self: { "--godot-rich-paragraph-spacing": "0.14em" }, text: {} };
    expect(specOf(textWire("hi", { fontSize: 20 }), decls).paragraphGapPx).toBeCloseTo(2.8, 5);
    expect(specOf(textWire("hi", { fontSize: 20 })).paragraphGapPx).toBe(0);
  });

  it("keeps a card's 1.24 block scale OUT of the font size — the matrix carries it", () => {
    // Folding it into the size would re-shape the text and could move a line break; on both backends this is a
    // post-layout visual scale, so the raster is built at the true size and the quad scales it.
    const spec = specOf(textWire("Strike"), { self: {}, text: { transform: "scale(1.24)" } });
    expect(spec.blockScale).toBe(1.24);
    expect(spec.fontPx).toBe(20);
  });

  it("narrows the wrap width by the reward rows' padding-right percentage", () => {
    const spec = specOf(textWire("Add a card"), { self: { "padding-right": "10%" }, text: {} });
    expect(spec.boxW).toBe(200);
    expect(spec.contentW).toBeCloseTo(180, 5);
  });

  it("takes the INLINE text-align when the wire streams one", () => {
    // `textStyle` writes an inline `text-align` for center/right/fill, and inline beats an inherited rule.
    const decls = { self: { "text-align": "center" }, text: {} };
    expect(specOf(textWire("hi", { layout: { horizontalAlignment: "Right" } }), decls).align).toBe("right");
  });

  it("falls back to the TABLE's text-align when the wire streams Left", () => {
    // Left deliberately emits no inline rule, which is what lets the End-Turn centring reach the label.
    const decls = { self: { "text-align": "center" }, text: {} };
    expect(specOf(textWire("hi", { layout: { horizontalAlignment: "Left" } }), decls).align).toBe("center");
  });

  it("maps the streamed halign/valign to the block's two placements", () => {
    const spec = specOf(textWire("hi", { layout: { horizontalAlignment: "Center", verticalAlignment: "Bottom" } }));
    expect(spec.blockAlign).toBe("center");
    expect(spec.blockAlignY).toBe("end");
  });
});

describe("resolveTextSpec — the four refusals", () => {
  it("refuses RICH text: a [b] span is a different font FILE and [img] is a real image", () => {
    expect(specOf({ ...textWire("The [b]Ancient[/b] shrine"), richText: true }).refusal).toBe("rich");
  });

  it("refuses `text-wrap: balance` rather than guessing a different wrap algorithm", () => {
    const decls = { self: { "text-wrap": "balance" }, text: {} };
    expect(specOf(textWire("Add a card to your deck"), decls).refusal).toBe("balance");
  });

  it("refuses a script a space-breaking wrapper cannot break", () => {
    // Zero of these across the recorded set — a guard, not a feature. Wrapping them wrong would overflow silently.
    expect(specOf(textWire("回復")).refusal).toBe("unbreakable");
    expect(specOf(textWire("ダメージ")).refusal).toBe("unbreakable");
  });

  it("refuses a label with no streamed face — there is nothing to ask the browser for", () => {
    const state = createMirrorState();
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: true,
        screenType: "run",
        orderedIds: ["n"],
        upserts: [
          {
            id: "n",
            parentId: null,
            name: "n",
            nodeType: "Godot.Label",
            transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
            localRect: { position: { x: 0, y: 0 }, size: { x: 200, y: 60 } },
            visible: true,
            ...textWire("hi")
          }
        ]
      })!
    );
    expect(resolveTextSpec(state.nodes.get("n")!, NO_DECLS)!.refusal).toBe("no-font");
  });

  it("does NOT refuse an ordinary Latin label", () => {
    expect(specOf(textWire("END TURN")).refusal).toBeNull();
  });
});

describe("resolveTextScaleDecls — the cascade, resolved as values", () => {
  it("resolves a single matching rule's declarations", () => {
    const decls = resolveTextScaleDecls("res://scenes/combat/end_turn_button.tscn", "Visuals/Label");
    expect(decls.self["--godot-text-scale"]).toBe("1.54");
    expect(decls.text["line-height"]).toBe("calc(0.79em + 1px)");
  });

  it("lets the 3-attribute multiplayer override beat the generic health-bar suffix", () => {
    // Both rules match this node. The browser resolves it by specificity, and so must this — the generic rule's
    // 1.42 must NOT be the answer.
    const decls = resolveTextScaleDecls(
      "res://scenes/run.tscn",
      "MultiplayerPlayerContainer/P2/HealthBar/HpBarContainer/HpLabel"
    );
    expect(decls.self["--godot-text-scale"]).toBe("1.32");
  });

  it("returns empty declarations for a node matching nothing", () => {
    const decls = resolveTextScaleDecls("res://scenes/run.tscn", "Nothing/Matches/Here");
    expect(decls.self).toEqual({});
    expect(decls.text).toEqual({});
  });
});

describe("breakOpportunities", () => {
  it("breaks after a run of spaces, once", () => {
    expect(breakOpportunities("a b")).toEqual([2]);
    expect(breakOpportunities("a   b")).toEqual([4]);
  });

  it("does not offer a break at the very end of the line", () => {
    expect(breakOpportunities("a ")).toEqual([]);
  });

  it("breaks AFTER a hyphen", () => {
    expect(breakOpportunities("re-play")).toEqual([3]);
  });

  it("never breaks inside a word", () => {
    expect(breakOpportunities("Immolate")).toEqual([]);
  });
});

describe("layoutText — greedy wrapping", () => {
  it("leaves a line that fits alone", () => {
    const spec = specOf(textWire("abcd")); // 4 chars = 40px, box 200
    const out = layoutText(spec, measureFixed);
    expect(out.lines.map((l) => l.text)).toEqual(["abcd"]);
    expect(out.wrapped).toBe(false);
  });

  it("wraps at the last break that fits, never inside a word", () => {
    // contentW 200 = 20 chars. "aaaaa bbbbb ccccc ddddd" is 23.
    const spec = specOf(textWire("aaaaa bbbbb ccccc ddddd"));
    const out = layoutText(spec, measureFixed);
    expect(out.lines.map((l) => l.text)).toEqual(["aaaaa bbbbb ccccc", "ddddd"]);
    expect(out.wrapped).toBe(true);
  });

  it("does not count TRAILING spaces toward a line's width — they hang at the break", () => {
    // Exactly 20 chars of ink plus a trailing space. Counting the space would wrap it; CSS does not.
    const spec = specOf(textWire("aaaaaaaaa bbbbbbbbbb ccc"));
    const out = layoutText(spec, measureFixed);
    expect(out.lines[0].text).toBe("aaaaaaaaa bbbbbbbbbb");
    expect(out.lines[0].width).toBe(200);
  });

  it("lets a single word wider than the box OVERFLOW, exactly as the DOM does", () => {
    const spec = specOf(textWire("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")); // 30 chars in a 20-char box
    const out = layoutText(spec, measureFixed);
    expect(out.lines.map((l) => l.text)).toEqual(["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
  });

  it("keeps going after an overflowing word instead of dropping the rest", () => {
    const spec = specOf(textWire("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bb"));
    const out = layoutText(spec, measureFixed);
    expect(out.lines.map((l) => l.text)).toEqual(["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bb"]);
  });

  it("honours a HARD newline whatever the width", () => {
    const spec = specOf(textWire("ab\ncd"));
    expect(layoutText(spec, measureFixed).lines.map((l) => l.text)).toEqual(["ab", "cd"]);
  });

  it("never wraps under `white-space: pre`", () => {
    const spec = specOf(textWire("aaaaa bbbbb ccccc ddddd"), { self: {}, text: { "white-space": "pre" } });
    const out = layoutText(spec, measureFixed);
    expect(out.lines).toHaveLength(1);
    expect(out.wrapped).toBe(false);
  });

  it("collapses whitespace under `white-space: normal`", () => {
    // The End-Turn rule's value: runs of whitespace, newlines included, become one space.
    const spec = specOf(textWire("END\n  TURN"), { self: {}, text: { "white-space": "normal" } });
    expect(layoutText(spec, measureFixed).lines.map((l) => l.text)).toEqual(["END TURN"]);
  });

  it("breaks a hyphenated word after the hyphen", () => {
    const spec = specOf(textWire("aaaaaaaaaa-bbbbbbbbbbbb"));
    expect(layoutText(spec, measureFixed).lines.map((l) => l.text)).toEqual(["aaaaaaaaaa-", "bbbbbbbbbbbb"]);
  });

  it("measures with the caller's metric — a proportional font wraps differently", () => {
    const proportional = (s: string) => [...s].reduce((w, c) => w + (c === "i" ? 4 : 14), 0);
    const spec = specOf(textWire("iiiiiiiiii wwww"));
    // 10 narrow chars (40) + space (14) + 4 wide (56) = 110 < 200: no wrap, where the fixed metric would give 150.
    expect(layoutText(spec, proportional).wrapped).toBe(false);
  });
});

describe("layoutText — the two-stage box", () => {
  it("shrink-to-fits an unwrapped LEFT-aligned block, then places it by justify-content", () => {
    // One 40px line in a 200px box: the BLOCK is 40 wide and, left-aligned, sits at 0.
    const spec = specOf(textWire("abcd", { layout: { horizontalAlignment: "Left" } }));
    const out = layoutText(spec, measureFixed);
    expect(out.blockW).toBe(40);
    expect(out.lines[0].x).toBe(0);
  });

  it("places a CENTRED single line identically whether the block stretched or not", () => {
    // The equivalence the stretch rests on. The block is now the full 200 rather than the line's 40, and the
    // line lands at exactly the same 80 — because the distance moves from `justify-content` into `text-align`.
    // If this ever disagrees with the line above, the two stages have started double-counting.
    const spec = specOf(textWire("abcd", { layout: { horizontalAlignment: "Center" } }));
    const out = layoutText(spec, measureFixed);
    expect(out.blockW).toBe(200);
    expect(out.lines[0].x).toBe(80);
  });

  it("STRETCHES for a centred line whose block alignment disagrees — the reported defect", () => {
    // A card description: the streamed halign is `Left` (so the BLOCK is start-aligned) while `[center]` in the
    // bbcode sets the LINE alignment. Shrink-to-fit would put the block at x=0 and then centre the line inside
    // its own width — a no-op — and a short description sat hard against the left edge of the card. Measured on
    // the live game the DOM centres it across the whole content width instead.
    const spec = { ...specOf(textWire("abcd", { layout: { horizontalAlignment: "Left" } })), align: "center" as const };
    const out = layoutText(spec, measureFixed);
    expect(out.blockW).toBe(200);
    expect(out.lines[0].x).toBe(80);
  });

  it("STRETCHES the block to the content width once anything wrapped, even if every line came out short", () => {
    // This is the case a naive `min(maxLine, boxW)` gets wrong. After wrapping, the flex item was stretched, so
    // the block is the full content width and `text-align` places lines inside THAT — not inside the longest line.
    const spec = specOf(textWire("aaaaa bbbbb ccccc ddddd", { layout: { horizontalAlignment: "Left" } }));
    const out = layoutText(spec, measureFixed);
    expect(out.wrapped).toBe(true);
    expect(out.blockW).toBe(200);
  });

  it("aligns each LINE inside the stretched block", () => {
    const spec = specOf(
      textWire("aaaaa bbbbb ccccc ddddd", { layout: { horizontalAlignment: "Center" } })
    );
    const out = layoutText(spec, measureFixed);
    // Block is the full 200; the short second line (50px) centres inside it.
    expect(out.lines[0].x).toBeCloseTo((200 - 170) / 2, 5);
    expect(out.lines[1].x).toBeCloseTo((200 - 50) / 2, 5);
  });

  it("centres a multi-line UNWRAPPED block's lines across the content width", () => {
    // Two hard lines, neither wrapped. The placement is what it always was — 80 and 90 — and the block behind it
    // is now the content width rather than the longest line. Both numbers are asserted so a future change to the
    // stretch rule has to move the LINES to fail this, not just the bookkeeping.
    const spec = specOf(textWire("abcd\nab", { layout: { horizontalAlignment: "Center" } }));
    const out = layoutText(spec, measureFixed);
    expect(out.blockW).toBe(200);
    expect(out.lines[0].x).toBe(80);
    expect(out.lines[1].x).toBe(90);
  });

  it("stacks lines at the absolute pitch and places the block vertically", () => {
    const spec = specOf(textWire("ab\ncd", { fontSize: 20, layout: { verticalAlignment: "Center" } }));
    const out = layoutText(spec, measureFixed);
    const pitch = 20 * LINE_PITCH_RATIO;
    expect(out.blockH).toBeCloseTo(2 * pitch, 5);
    // Box is 60 tall, block 44: centred at 8.
    expect(out.lines[0].y).toBeCloseTo((60 - 2 * pitch) / 2, 5);
    expect(out.lines[1].y).toBeCloseTo((60 - 2 * pitch) / 2 + pitch, 5);
  });

  it("right-aligns to the block's right edge", () => {
    const spec = specOf(textWire("ab", { layout: { horizontalAlignment: "Right" } }));
    expect(layoutText(spec, measureFixed).lines[0].x).toBe(180);
  });

  // --- THE PARAGRAPH GAP -------------------------------------------------------------------------------------
  //
  // A WRAPPED line and a NEW PARAGRAPH are different distances in this game, and the DOM stage renders the
  // difference for free (gsw emits one `.godot-rich-paragraph` per Godot paragraph, and the gap is the blocks'
  // spacing). A single pitch here was a canvas-only flattening of that, and because `blockH` feeds `blockY` it
  // came out as the block sitting at the wrong HEIGHT — the vertical half of "descriptions are not centered".

  const GAP_DECLS = { self: { "--godot-rich-paragraph-spacing": "0.14em" }, text: {} };

  it("adds the gap at an explicit \\n and nowhere else", () => {
    const spec = specOf(textWire("ab\ncd", { fontSize: 20 }), GAP_DECLS);
    const out = layoutText(spec, measureFixed);
    const pitch = 20 * LINE_PITCH_RATIO;
    const gap = 0.14 * 20;
    expect(out.lines[0].y).toBeCloseTo(out.lines[1].y - pitch - gap, 5);
    expect(out.blockH).toBeCloseTo(2 * pitch + gap, 5);
  });

  it("does NOT add it between two WRAPPED lines of one paragraph", () => {
    // The distinction the whole field exists for. `contentW` is 200 and every character is 10 wide, so this
    // breaks into two lines with no newline anywhere in the source.
    const spec = specOf(textWire("aaaaaaaaaa bbbbbbbbbb ccccc", { fontSize: 20 }), GAP_DECLS);
    const out = layoutText(spec, measureFixed);
    expect(out.lines.length).toBeGreaterThan(1);
    expect(out.lines[1].y - out.lines[0].y).toBeCloseTo(20 * LINE_PITCH_RATIO, 5);
  });

  it("re-centres the block on its TRUE height, gaps included", () => {
    // The defect this closes: `blockH` fed `blockY`, so a two-paragraph description was centred as though its
    // two paragraphs were two wrapped lines — and sat low in its box by half the gap.
    const spec = specOf(textWire("ab\ncd", { fontSize: 20, layout: { verticalAlignment: "Center" } }), GAP_DECLS);
    const out = layoutText(spec, measureFixed);
    const blockH = 2 * (20 * LINE_PITCH_RATIO) + 0.14 * 20;
    expect(out.lines[0].y).toBeCloseTo((60 - blockH) / 2, 5);
    // …and the whole block still ends inside the box it was centred in.
    expect(out.lines[0].y + blockH).toBeCloseTo(60 - out.lines[0].y, 5);
  });

  it("changes nothing at all with no gap declared — every label but a card description", () => {
    const withNone = layoutText(specOf(textWire("ab\ncd", { fontSize: 20 })), measureFixed);
    const pitch = 20 * LINE_PITCH_RATIO;
    expect(withNone.blockH).toBeCloseTo(2 * pitch, 5);
    expect(withNone.lines[1].y - withNone.lines[0].y).toBeCloseTo(pitch, 5);
  });
});

describe("rasterScaleFor", () => {
  const scaled = (s: number, perDesignPx = 1) => rasterScaleFor([s, 0, 0, s, 0, 0], perDesignPx);

  it("is 1 at identity", () => {
    expect(scaled(1)).toBe(1);
  });

  // --- THE MINIFICATION DEFECT, which is what this function got wrong for the whole of M4 ------------------
  //
  // The old contract was "never below 1", written for the magnify case and assuming a label is never drawn
  // SMALLER than its design size. On the live combat frame 46 of 56 text quads were, sitting at an on-screen
  // scale of 0.80-0.87 while the floor forced a 1.0 raster — a permanent 15-25% shrink through the executor's
  // LINEAR filter, on every label. These pin the fix by its NUMBERS rather than by its name.

  it("FOLLOWS a shrunk label down — the floor that blurred every minified label is gone", () => {
    expect(scaled(0.25)).toBe(0.25);
    expect(scaled(0.5)).toBe(0.5);
  });

  it("lands within one step of the two scales the live frame actually measured", () => {
    // 0.80 and 0.87 were the two clusters in the resample histogram, and 1/0.8 = 1.25 and 1/0.87 = 1.1494 were
    // exactly the S/T peaks the floor produced. Post-fix the residual is the quantization and nothing else.
    expect(scaled(0.8)).toBeCloseTo(0.8125, 10);
    expect(scaled(0.87)).toBeCloseTo(0.875, 10);
    // RETRACTED READING. Round 9 read the next two lines as "the resample is now invisible: under 2%, against
    // the 25% it replaces", and shipped on it. They do not say that and cannot: the executor's sampler has a
    // cliff at EXACTLY 1 and is flat either side of it, so 1.02 is not meaningfully better than 1.25 — measured,
    // the bright share of ink is 0.115 at ratio 1.02 against 0.145 at 1.25, i.e. slightly WORSE. What these two
    // lines actually pin is the quantization residual of the MOVING tier, which is all they ever pinned.
    expect(scaled(0.8) / 0.8).toBeLessThan(1.02);
    expect(scaled(0.87) / 0.87).toBeLessThan(1.02);
  });

  // --- THE TWO TIERS (round 10) ------------------------------------------------------------------------------
  //
  // Once the quad is sized from the texture (`exactBlitSize`), this number stops setting SHARPNESS and starts
  // setting SIZE: the ink is drawn at exactly `scale` device px per design px, so the step's round-up becomes a
  // systematic size error of `STEP / scale` — 3.5% at the ~0.9 the live labels sit at, which per-label RMSE
  // against the DOM reads as "the canvas text is bigger". The fine step is affordable only at rest, because the
  // stepped value is the raster KEY.

  it("steps eight times finer for a label at REST", () => {
    expect(scaled(0.8)).toBe(0.8125);
    expect(rasterScaleFor([0.8, 0, 0, 0.8, 0, 0], 1, true)).toBe(0.80078125);
    expect(RASTER_SCALE_STEP_REST).toBe(RASTER_SCALE_STEP / 8);
  });

  it("cuts the WORST-CASE size error to under half a percent at rest, from three and a half", () => {
    // The error is `step / scale` at its worst, which is a scale that has just missed a step boundary — 0.876
    // rounds all the way up to 29/32. Picking a scale that happens to sit NEAR a step (0.9 is 0.7% off 29/32)
    // would measure the step's luck rather than its size, which is the mistake this line was written with.
    const wanted = 0.876;
    expect(scaled(wanted) / wanted).toBeGreaterThan(1.034);
    expect(rasterScaleFor([wanted, 0, 0, wanted, 0, 0], 1, true) / wanted).toBeLessThan(1.005);
  });

  it("still steps EXACTLY at rest — the fine step is a power of two for the same key reason", () => {
    expect(String(rasterScaleFor([0.8, 0, 0, 0.8, 0, 0], 1, true))).toBe("0.80078125");
  });

  it("defaults to the COARSE tier, so every caller that does not ask keeps today's churn", () => {
    expect(rasterScaleFor([0.8, 0, 0, 0.8, 0, 0], 1)).toBe(rasterScaleFor([0.8, 0, 0, 0.8, 0, 0], 1, false));
  });

  it("keeps both tiers inside the same floor and ceiling", () => {
    expect(rasterScaleFor([0, 0, 0, 0, 0, 0], 1, true)).toBe(RASTER_SCALE_MIN);
    expect(rasterScaleFor([8, 0, 0, 8, 0, 0], 2, true)).toBe(RASTER_SCALE_MAX);
  });

  it("keeps a floor of one STEP, so a degenerate matrix cannot ask for a zero-pixel texture", () => {
    expect(scaled(0)).toBe(RASTER_SCALE_MIN);
    expect(scaled(0.0001)).toBe(RASTER_SCALE_MIN);
    expect(RASTER_SCALE_MIN).toBe(RASTER_SCALE_STEP);
  });

  it("quantizes to 1/32 steps so a zoom does not mint a texture per pixel", () => {
    expect(scaled(1.1)).toBeCloseTo(1.125, 10);
    expect(scaled(1.6)).toBeCloseTo(1.625, 10);
    // Rounding is UP, always: the residual error is toward slightly too much detail rather than too little.
    expect(scaled(1.0001)).toBeGreaterThan(1);
  });

  it("steps EXACTLY, because the step is a power of two", () => {
    // Not pedantry: the raster key carries this number as a string, so 0.8125 and 0.8125000000000001 would be
    // two textures for one scale — a cache that misses forever on every label.
    expect(scaled(0.8)).toBe(0.8125);
    expect(String(scaled(0.8))).toBe("0.8125");
  });

  it("clamps at 3 — beyond it the texture cost stops buying sharpness", () => {
    expect(rasterScaleFor([8, 0, 0, 8, 0, 0], 2)).toBe(RASTER_SCALE_MAX);
  });

  it("folds the whole design-to-device factor in, not just the ratio", () => {
    expect(scaled(1, 2)).toBe(2);
    // A phone: the stage fits 1920 design px into ~400 CSS px at dpr 3, so `perDesignPx` is ~0.63 — and a label
    // at 0.8 of its own size wants HALF a device pixel per design pixel. Rastering that at 1.0 (which is what
    // passing only the DPR did) is a 2x minification of the smallest text on the smallest screen.
    expect(scaled(0.8, 0.63)).toBeLessThan(0.55);
  });

  it("takes the MEAN axis of a non-uniform scale, not the larger one", () => {
    // One raster cannot satisfy both axes; the mean splits the error instead of over-allocating for the larger.
    expect(rasterScaleFor([1, 0, 0, 3, 0, 0], 1)).toBe(2);
  });

  it("reads a ROTATED matrix's true axis lengths", () => {
    // 90 degrees at scale 2: the cells are [0,2,-2,0], whose hypotenuses are both 2.
    expect(rasterScaleFor([0, 2, -2, 0, 0, 0], 1)).toBe(2);
  });
});

describe("textDigest", () => {
  it("gives two identical labels the same key — one raster, one upload", () => {
    const a = specOf(textWire("80"));
    const b = specOf(textWire("80"));
    expect(textDigest(a, 1)).toBe(textDigest(b, 1));
  });

  it("separates fields so no two specs can collide by concatenation", () => {
    expect(textDigest(specOf(textWire("ab")), 1)).not.toBe(textDigest(specOf(textWire("a b")), 1));
  });

  it("keys on the raster scale — the same words at two zooms are two textures", () => {
    const spec = specOf(textWire("80"));
    expect(textDigest(spec, 1)).not.toBe(textDigest(spec, 2));
  });

  it("keys on the wrap width, rounded to a whole pixel", () => {
    const wide = specOf(textWire("hi"));
    const narrow = resolveTextSpec(nodeOf(textWire("hi")), { self: { "padding-right": "10%" }, text: {} })!;
    expect(textDigest(wide, 1)).not.toBe(textDigest(narrow, 1));
  });

  it("ignores a sub-pixel box wobble, so an animating width does not mint a texture per frame", () => {
    const a = specOf(textWire("hi"));
    const b = { ...a, contentW: a.contentW + 0.2 };
    expect(textDigest(a, 1)).toBe(textDigest(b, 1));
  });

  it("does NOT key on the block scale, the box height or the vertical alignment — all three are the matrix", () => {
    const base = specOf(textWire("hi"));
    expect(textDigest({ ...base, blockScale: 1.24 }, 1)).toBe(textDigest(base, 1));
    expect(textDigest({ ...base, boxH: 999 }, 1)).toBe(textDigest(base, 1));
    expect(textDigest({ ...base, blockAlignY: "end" }, 1)).toBe(textDigest(base, 1));
  });

  it("DOES key on the outline and the shadow — they are ink", () => {
    const plain = specOf(textWire("45/45"));
    const outlined = specOf(textWire("45/45", { outlineColor: { html: "#000000ff" }, outlineSize: 10 }));
    expect(textDigest(plain, 1)).not.toBe(textDigest(outlined, 1));
  });
});

// --- the RUNS model (simple-rich's structural half) --------------------------------------------------------------
//
// `layoutText` gained an optional third argument: colour spans over the spec's string. Everything about these specs
// is aimed at one claim — that adding it changed NOTHING for the caller that does not pass it — and then at the
// arithmetic of the runs themselves, of which exactly one part is non-obvious (see the cumulative-prefix spec).

describe("layoutText — runs are absent unless spans reach the line", () => {
  it("produces byte-identical layout when no spans are passed", () => {
    // THE GUARANTEE, asserted rather than argued: the whole plain path is unchanged, so a JSON compare of the two
    // call shapes is the strongest form this can take.
    const spec = specOf({ text: { text: "one two three four", fontSize: 20 } });
    const withoutArg = layoutText(spec, measureFixed);
    const withEmpty = layoutText(spec, measureFixed, []);
    expect(JSON.stringify(withEmpty)).toBe(JSON.stringify(withoutArg));
    for (const line of withoutArg.lines) {
      expect(Object.prototype.hasOwnProperty.call(line, "runs")).toBe(false);
    }
  });

  it("leaves runs absent on a line no span reaches", () => {
    const spec = specOf({ text: { text: "alpha\nbeta", fontSize: 20 }, localRect: { position: { x: 0, y: 0 }, size: { x: 500, y: 60 } } });
    // A span over "alpha" only — the second line must stay a plain line.
    const out = layoutText(spec, measureFixed, [{ start: 0, end: 5, color: "#ff0000" }]);
    expect(out.lines[0].runs).toBeDefined();
    expect(out.lines[1].runs).toBeUndefined();
  });

  it("splits a line into coloured and uncoloured runs, in order, covering it exactly", () => {
    const spec = specOf({ text: { text: "abcdef", fontSize: 20 }, localRect: { position: { x: 0, y: 0 }, size: { x: 500, y: 60 } } });
    const out = layoutText(spec, measureFixed, [{ start: 2, end: 4, color: "#00ff00" }]);
    const runs = out.lines[0].runs!;
    expect(runs.map((r) => r.text)).toEqual(["ab", "cd", "ef"]);
    expect(runs.map((r) => r.color)).toEqual([null, "#00ff00", null]);
    // The runs reassemble the line, and their widths sum to it.
    expect(runs.map((r) => r.text).join("")).toBe(out.lines[0].text);
    expect(runs.reduce((s, r) => s + r.width, 0)).toBeCloseTo(out.lines[0].width, 6);
  });

  it("takes each run's x from a CUMULATIVE PREFIX measure, not from summed piece widths", () => {
    // The one non-obvious part. A font's advance for a pair is not the sum of its parts (kerning), so a stub whose
    // measurement is deliberately NON-additive is what distinguishes the two implementations: measuring prefixes
    // gives 0 / 100 / 300, while summing piece widths would give 0 / 100 / 200.
    const jumpy = (s: string) => (s.length === 0 ? 0 : s.length === 2 ? 100 : s.length === 4 ? 300 : s.length * 50);
    const spec = specOf({ text: { text: "abcdef", fontSize: 20 }, localRect: { position: { x: 0, y: 0 }, size: { x: 5000, y: 60 } } });
    const out = layoutText(spec, measureFixed, [{ start: 2, end: 4, color: "#00ff00" }]);
    const withJumpy = layoutText({ ...spec, contentW: 5000 }, jumpy, [{ start: 2, end: 4, color: "#00ff00" }]);
    const runs = withJumpy.lines[0].runs!;
    expect(runs.map((r) => r.x)).toEqual([0, 100, 300]);
    expect(runs[1].width).toBe(200);
    expect(out.lines[0].runs!.length).toBe(3);
  });

  it("offsets a run's x by the line's own alignment offset", () => {
    const spec = specOf({
      ...textWire("abcdef", { layout: { horizontalAlignment: "Center" } }),
      localRect: { position: { x: 0, y: 0 }, size: { x: 200, y: 60 } }
    });
    const out = layoutText(spec, measureFixed, [{ start: 0, end: 2, color: "#00ff00" }]);
    const line = out.lines[0];
    expect(line.x).toBeGreaterThan(0);
    expect(line.runs![0].x).toBe(line.x);
  });

  it("keeps span indices addressing the SOURCE across a wrap", () => {
    // "one two" wraps to two lines; a span over "two" (source 4..7) must colour the second line, not the first.
    const spec = specOf({ text: { text: "one two", fontSize: 20 }, localRect: { position: { x: 0, y: 0 }, size: { x: 40, y: 60 } } });
    const out = layoutText(spec, measureFixed, [{ start: 4, end: 7, color: "#0000ff" }]);
    expect(out.lines.map((l) => l.text)).toEqual(["one", "two"]);
    expect(out.lines[0].runs).toBeUndefined();
    expect(out.lines[1].runs!.map((r) => [r.text, r.color])).toEqual([["two", "#0000ff"]]);
  });

  it("moves span indices across a white-space:normal collapse", () => {
    // Collapsing re-indexes the string: "a   b" becomes "a b", so a span at source 4..5 ("b") must land at 2..3.
    const spec = specOf(
      { text: { text: "a   b", fontSize: 20 }, localRect: { position: { x: 0, y: 0 }, size: { x: 500, y: 60 } } },
      { self: {}, text: { "white-space": "normal" } }
    );
    expect(spec.whiteSpace).toBe("normal");
    const out = layoutText(spec, measureFixed, [{ start: 4, end: 5, color: "#0000ff" }]);
    expect(out.lines[0].text).toBe("a b");
    expect(out.lines[0].runs!.map((r) => [r.text, r.color])).toEqual([
      ["a ", null],
      ["b", "#0000ff"]
    ]);
  });

  it("does not let trimmed trailing spaces shift a following span", () => {
    // The reason a piece records where it was CUT as well as what it says: the trimmed spaces are still source
    // characters, so a span after them must not be pulled backwards by the trim.
    const spec = specOf({ text: { text: "aa bb", fontSize: 20 }, localRect: { position: { x: 0, y: 0 }, size: { x: 25, y: 60 } } });
    const out = layoutText(spec, measureFixed, [{ start: 3, end: 5, color: "#ff00ff" }]);
    expect(out.lines.map((l) => l.text)).toEqual(["aa", "bb"]);
    expect(out.lines[1].runs!.map((r) => [r.text, r.color])).toEqual([["bb", "#ff00ff"]]);
  });
});

// --- W3: GODOT'S OWN LINE BREAKING, END TO END -------------------------------------------------------------
//
// The mirror replicates Godot, not CSS. Until now the canvas path derived its wrap with a greedy space breaker
// written to match the DOM stage's `pre-wrap`, and had to REFUSE every label whose wrap that breaker could not
// reproduce — each refusal being a label that stays on the DOM overlay and keeps painting above the whole stage.
// With the engine's own break offsets on the wire, the breaker stops being consulted.
//
// These go through the REAL parser (`nodeOf` builds wire JSON), so they cover `normalizeTextWrap`'s validation,
// `resolveTextSpec`'s refusal rewiring and `layoutText`'s replay as one path — which is where the bugs would be.
describe("layoutText replays Godot's own line breaks", () => {
  const BODY = "Damage ALL other enemies equal to the damage dealt.";
  /** How many NUL-separated fields a digest carries — the counting argument's own instrument. */
  const nuls = (s: string) => s.split(" ").length - 1;

  /** The wire fields the producer streams for a measured wrap. */
  function wrapWire(source: string, ranges: [number, number][]): Record<string, unknown> {
    return {
      textLineRanges: ranges.flat(),
      textLineBasis: "text",
      textLineSourceLength: source.length,
      textLineSourceHash: fnv1a32(source)
    };
  }

  it("places the engine's lines instead of the ones the breaker would have chosen", () => {
    // The greedy breaker produces THREE lines at this box width (see the fallback test below). Two lines, broken
    // in different places, can only have come from the wire — which is what makes this a test of the replay
    // rather than of the breaker.
    const spec = specOf({ ...textWire(BODY), ...wrapWire(BODY, [[0, 24], [25, 51]]) });
    expect(spec.godotLines).not.toBeNull();
    const out = layoutText(spec, measureFixed);
    expect(out.lines.map((l) => l.text)).toEqual(["Damage ALL other enemies", "equal to the damage dealt."]);
  });

  it("falls back to its own breaker when the wrap was measured against different words", () => {
    // Same length, different content — the stale-wrap case. The fallback is the whole safety argument: a wrap
    // that cannot be verified is not used, and the label renders exactly as it did before the channel existed.
    const stale = BODY.replace("Damage ALL", "Damage TWO");
    const spec = specOf({ ...textWire(BODY), ...wrapWire(stale, [[0, 24], [25, 51]]) });
    expect(spec.godotLines).toBeNull();
    // The greedy breaker's OWN answer at this box width (200px / CH 10 = 20 chars), which is what this label
    // rendered before the channel existed and must go on rendering when the wrap cannot be trusted.
    expect(layoutText(spec, measureFixed).lines.map((l) => l.text)).toEqual([
      "Damage ALL other",
      "enemies equal to the",
      "damage dealt."
    ]);
  });

  it("retires the `balance` refusal, because Godot has no such mode to reproduce", () => {
    const decls = { self: { "text-wrap": "balance" }, text: {} };
    // Without a wrap the reward row is still refused, exactly as before.
    expect(specOf(textWire(BODY), decls).refusal).toBe("balance");
    // With one there is nothing left to guess: `text-wrap: balance` is a CSS-side artefact of the DOM stage.
    expect(specOf({ ...textWire(BODY), ...wrapWire(BODY, [[0, 24], [25, 51]]) }, decls).refusal).toBeNull();
  });

  it("retires the `unbreakable` refusal, because the engine broke the script we cannot", () => {
    const cjk = "回避と防御を得る効果です";
    expect(specOf(textWire(cjk)).refusal).toBe("unbreakable");
    const spec = specOf({ ...textWire(cjk), ...wrapWire(cjk, [[0, 6], [6, 12]]) });
    expect(spec.refusal).toBeNull();
    expect(layoutText(spec, measureFixed).lines.map((l) => l.text)).toEqual(["回避と防御を", "得る効果です"]);
  });

  it("still refuses a label with no face — a wrap says where, not what to draw with", () => {
    const spec = resolveTextSpec(
      nodeOf({ ...textWire(BODY), ...wrapWire(BODY, [[0, 51]]), font: null }),
      NO_DECLS
    )!;
    expect(spec.refusal).toBe("no-font");
  });

  it("refuses a malformed range set at the parser rather than at the raster", () => {
    // Descending, overlapping or out-of-bounds offsets reach a slicer as WRONG WORDS, so they are refused once
    // on parse instead of on every raster. The label falls back to its own breaker.
    expect(specOf({ ...textWire(BODY), ...wrapWire(BODY, [[25, 51], [0, 24]]) }).godotLines).toBeNull();
    expect(specOf({ ...textWire(BODY), ...wrapWire(BODY, [[0, 999]]) }).godotLines).toBeNull();
  });

  it("keys the raster on the wrap, so a late-arriving one is not masked by the first raster", () => {
    // The wrap rides the producer's STATIC path and can land a build or two after the label's first raster. If
    // it were absent from the digest that raster would be reused forever and the wrap would never be seen.
    const without = specOf(textWire(BODY));
    const with1 = specOf({ ...textWire(BODY), ...wrapWire(BODY, [[0, 24], [25, 51]]) });
    const with2 = specOf({ ...textWire(BODY), ...wrapWire(BODY, [[0, 30], [31, 51]]) });
    expect(textDigest(with1, 1)).not.toBe(textDigest(without, 1));
    expect(textDigest(with1, 1)).not.toBe(textDigest(with2, 1));
  });

  it("keeps the four digest shapes at four distinct NUL counts", () => {
    // The collision argument is by COUNTING, not by luck — so the counts have to actually be DISTINCT, and a
    // wrapless label's digest has to carry no wrap suffix at all. The absolute numbers are not the invariant:
    // they each rose by one when the paragraph gap joined the base, which shifts all four together.
    const plain = specOf(textWire(BODY));
    const wrapped = specOf({ ...textWire(BODY), ...wrapWire(BODY, [[0, 24], [25, 51]]) });
    const spans = [{ start: 0, end: 6, color: "#00ff00" }];
    expect([
      nuls(textDigest(plain, 1)),
      nuls(textDigest(plain, 1, spans)),
      nuls(textDigest(wrapped, 1)),
      nuls(textDigest(wrapped, 1, spans))
    ]).toEqual([11, 12, 13, 14]);
  });
});

// --- baselineOf — the one expression both text backends place a line with ---------------------------------------
//
// It is shared code rather than a shared convention because it was a convention once, and the copies drifted: the
// glyph path could not reach a 2D context, so it substituted `0.8 * fontPx` for the ascent and `0.2 * fontPx` for
// the descent and drew every label most of a pixel above the raster path's. These specs pin the arithmetic and,
// more importantly, pin WHY the metrics have to be the face's own.

describe("baselineOf", () => {
  it("centres the face's content box in the line's pitch and drops one ascent", () => {
    // A 24px pitch around a 20/5 face: 25 of content leaves -0.5 of half-leading (the ink correctly overflows a
    // pitch tighter than the content, which is what the End-Turn rule's `calc(0.79em + 1px)` does on purpose).
    expect(baselineOf(0, 24, { ascent: 20, descent: 5 })).toBeCloseTo(19.5, 10);
    expect(baselineOf(100, 24, { ascent: 20, descent: 5 })).toBeCloseTo(119.5, 10);
    // …and a roomier pitch pushes the whole content box down by half the slack, not all of it.
    expect(baselineOf(0, 35, { ascent: 20, descent: 5 })).toBeCloseTo(25, 10);
  });

  it("moves when the metrics are guessed — the error the glyph path used to draw", () => {
    // Chrome's own numbers for this game's `kreon_regular`, which reports WHOLE pixels and therefore a ratio that
    // is not constant down the size ladder: 12/3 at 12px, 19/6 at 20px. Against the 0.8/0.2 guess the baseline
    // lands 0.9px and 0.5px high respectively — always high, always by an amount that depends on the size and the
    // face, which is why no single fudge factor could have fixed it.
    const pitch = (px: number) => px * LINE_PITCH_RATIO;
    const guess = (px: number) => ({ ascent: px * 0.8, descent: px * 0.2 });
    expect(baselineOf(0, pitch(12), { ascent: 12, descent: 3 }) - baselineOf(0, pitch(12), guess(12))).toBeCloseTo(0.9, 10);
    expect(baselineOf(0, pitch(20), { ascent: 19, descent: 6 }) - baselineOf(0, pitch(20), guess(20))).toBeCloseTo(0.5, 10);
    // A face whose ascent and descent are BOTH bigger cancels — the term is `((a - d) - 0.6 * px) / 2`, so it is
    // the difference that moves the baseline, not the height. `spectral_bold` at 20px (21/9) is such a face.
    expect(baselineOf(0, pitch(20), { ascent: 21, descent: 9 }) - baselineOf(0, pitch(20), guess(20))).toBeCloseTo(0, 10);
  });

  it("does not depend on the pitch for the OFFSET between two metrics", () => {
    // The pitch cancels in a difference, which is what makes the error above a property of the FACE alone: a card
    // description with a `--godot-rich-line-height` override is off by exactly as much as a plain label is.
    const real = { ascent: 19, descent: 6 };
    const guess = { ascent: 16, descent: 4 };
    const at = (pitch: number) => baselineOf(0, pitch, real) - baselineOf(0, pitch, guess);
    expect(at(22)).toBeCloseTo(at(30), 10);
    expect(at(22)).toBeCloseTo(0.5, 10);
  });
});
