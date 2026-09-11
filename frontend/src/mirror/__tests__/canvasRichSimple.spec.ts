import { describe, expect, it } from "vitest";

import { createColorValidator, parseSimpleRich, type ColorValidator } from "@/mirror/canvas/richSimple";

// A validator that accepts what a browser would and normalizes the two forms the corpus actually uses, without
// needing a 2D context. The real one is `createColorValidator`, which is exercised separately below.
const accept: ColorValidator = (v) => {
  const raw = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(raw)) return raw;
  if (raw === "red" || raw === "blue") return raw;
  return null;
};

const parse = (raw: string, tags?: Record<string, unknown>) =>
  parseSimpleRich(raw, { color: accept, ...(tags ? { tags } : {}) });

/** The parsed text with its colour runs rendered inline, so a whole expectation reads as one string. */
function annotate(raw: string): string {
  const r = parse(raw);
  if (!r.ok) return `REFUSE:${r.refusal}`;
  let out = "";
  let at = 0;
  for (const s of r.value.spans) {
    out += r.value.text.slice(at, s.start);
    out += `<${s.color}>${r.value.text.slice(s.start, s.end)}</>`;
    at = s.end;
  }
  return out + r.value.text.slice(at);
}

describe("parseSimpleRich — what it accepts", () => {
  it("passes a markup-free string through unchanged, with no spans", () => {
    const r = parse("Gain 5 Block.");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.text).toBe("Gain 5 Block.");
    expect(r.value.spans).toEqual([]);
    expect(r.value.align).toBeNull();
  });

  it("reads a custom colour alias off the imported table", () => {
    // `gold` is an STS2 alias, not a gsw built-in — it resolves through DEFAULT_BBCODE_TAGS.
    expect(annotate("Gain 5 [gold]Block[/gold].")).toBe("Gain 5 <#efc851>Block</>.");
  });

  it("reads [color=] and its [fgcolor=] alias", () => {
    expect(annotate("[color=#ff0000]hot[/color]")).toBe("<#ff0000>hot</>");
    expect(annotate("[fgcolor=#00ff00]cool[/fgcolor]")).toBe("<#00ff00>cool</>");
  });

  it("keeps built-in color arguments ahead of an accidentally supplied custom descriptor", () => {
    const r = parse("[color=#ff0000]hot[/color]", { color: { kind: "color", value: "#00ff00" } });
    expect(r.ok && r.value.spans).toEqual([{ start: 0, end: 3, color: "#ff0000" }]);
  });

  it("takes whole-string alignment off the string and reports it separately", () => {
    const r = parse("[center]Gain 5 Block.[/center]");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.text).toBe("Gain 5 Block.");
    expect(r.value.align).toBe("center");
  });

  it("maps Godot's `fill` onto CSS's `justify`", () => {
    const r = parse("[fill]wide[/fill]");
    expect(r.ok && r.value.align).toBe("justify");
  });

  it("accepts [p align=right] as well as the shorthand", () => {
    const r = parse("[p align=right]x[/p]");
    expect(r.ok && r.value.align).toBe("right");
  });

  it("is the U1 label: alignment plus a colour run", () => {
    // The DescriptionLabel photographed escaping over the TopBar — the exact string, from the wire.
    const r = parse("[center]Gain 5 [gold]Block[/gold].[/center]");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.text).toBe("Gain 5 Block.");
    expect(r.value.align).toBe("center");
    expect(r.value.spans).toEqual([{ start: 7, end: 12, color: "#efc851" }]);
  });

  it("passes an STS2 effect tag through as INERT, because its css block is empty", () => {
    // The whole six-tag argument in one assertion: cc feeds gsw the DEFAULT table, whose effect names are
    // `{kind:"style", css:{}}` — a span with no declarations. Contributing nothing is exactly right.
    expect(annotate("[thinky_dots]...[/thinky_dots]")).toBe("...");
  });

  it("refuses a style descriptor that carries an ACTUAL declaration", () => {
    // The same code path as the inert case, proving the emptiness is checked rather than the tag name trusted.
    const r = parse("[loud]x[/loud]", { loud: { kind: "style", css: { "font-weight": "700" } } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toBe("style");
    expect(r.detail).toContain("font-weight");
  });

  it("nests colours innermost-wins, and leaves no overlapping spans", () => {
    const r = parse("[color=#ff0000]a[color=#00ff00]b[/color]c[/color]");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.text).toBe("abc");
    const sorted = [...r.value.spans].sort((x, y) => x.start - y.start);
    expect(sorted).toEqual([
      { start: 0, end: 1, color: "#ff0000" },
      { start: 1, end: 2, color: "#00ff00" },
      { start: 2, end: 3, color: "#ff0000" }
    ]);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].start).toBeGreaterThanOrEqual(sorted[i - 1].end);
    }
  });

  it("styles to the end of the string when a tag is left open, as gsw does", () => {
    expect(annotate("a[color=#ff0000]bc")).toBe("a<#ff0000>bc</>");
  });
});

describe("parseSimpleRich — what it refuses, and by which class", () => {
  const cases: Array<[string, string]> = [
    ["[b]Exhaust[/b]", "font-swap"],
    ["[i]slanted[/i]", "font-swap"],
    ["Gain [img]res://x.png[/img] energy", "img"],
    ["[wave]woo[/wave]", "effect"],
    ["[font_size=30]big[/font_size]", "style"],
    ["[bgcolor=#000]x[/bgcolor]", "style"],
    ["[outline_color=#000]x[/outline_color]", "style"],
    ["[url=x]link[/url]", "style"],
    ["[nonesuch]x[/nonesuch]", "unknown"],
    ["[center]a[/center][center]b[/center]", "nested-align"],
    ["lead [center]x[/center]", "non-wrapping-align"],
    ["[color=#ff0000]x[/gold]", "unbalanced"],
    ["[/color]", "unbalanced"],
    ["[color=nonsense]x[/color]", "bad-color"]
  ];
  for (const [input, refusal] of cases) {
    it(`refuses ${JSON.stringify(input)} as ${refusal}`, () => {
      const r = parse(input);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.refusal).toBe(refusal);
      expect(r.detail.length).toBeGreaterThan(0);
    });
  }

  it("refuses an unknown tag rather than swallowing it, because gsw would render it literally", () => {
    // The wrong-WORDS case. Either behaviour is a divergence; refusing keeps the label on the overlay, where it
    // renders exactly as it does today.
    const r = parse("[shimmer]x[/shimmer]");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toBe("unknown");
  });

  it("allows whitespace either side of a whole-string alignment", () => {
    expect(parse("  [center]x[/center]\n").ok).toBe(true);
  });
});

describe("createColorValidator", () => {
  it("answers null for a value the context rejects, which is CSS dropping the declaration", () => {
    // A stub context with the property's real semantics: an invalid assignment is a NO-OP.
    let value = "#000000";
    const ctx = {
      get fillStyle() {
        return value;
      },
      set fillStyle(next: string) {
        if (/^#[0-9a-f]{6}$/i.test(next)) value = next.toLowerCase();
      }
    } as unknown as CanvasRenderingContext2D;
    const validate = createColorValidator(ctx);
    expect(validate("#AABBCC")).toBe("#aabbcc");
    expect(validate("definitely-not-a-colour")).toBeNull();
  });

  it("does not mistake a candidate that equals a sentinel for a rejection", () => {
    // The reason there are two sentinels: with one, assigning that exact colour reads as "unchanged".
    let value = "#000000";
    const ctx = {
      get fillStyle() {
        return value;
      },
      set fillStyle(next: string) {
        if (/^#[0-9a-f]{6}$/i.test(next)) value = next.toLowerCase();
      }
    } as unknown as CanvasRenderingContext2D;
    const validate = createColorValidator(ctx);
    expect(validate("#010203")).toBe("#010203");
  });

  it("accepts the value as written when there is no context to ask", () => {
    expect(createColorValidator(null)("#123456")).toBe("#123456");
    expect(createColorValidator(null)("   ")).toBeNull();
  });
});
