import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_BBCODE_TAGS, RICH_TEXT_EFFECTS_ATTRIBUTE } from "@spirectl/presentation/render";
import { godotBbcodeTagKind } from "@godot-scene-web/html";

import { createMirrorRenderer, type MirrorRenderer } from "@/mirror/mirrorRenderer";
import {
  adoptGameTextEffects,
  createMirrorSettings,
  seedServerSettingsFromSession
} from "@/mirror/mirrorSettings";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// THE ANIMATED RICH TEXT, from the wire to the elements the CSS keys on.
//
// The game's own wavy / shaky / bouncing bbcode tags reach the browser verbatim — a census of `.sts2/bench/`
// finds [jitter] all over combat and [sine] all over events — and the mirror used to render every one of them
// flat, because @spirectl/presentation declared them as style descriptors with an empty css block. They are
// effect descriptors now, which is what makes godot-scene-web split their content into the per-character spans
// the keyframes stagger.
//
// WHAT IS ASSERTED HERE is the chain this repo owns: the wire string produces the classed, indexed elements, and
// the game's Text Effects preference reaches the stage attribute that gates them. The rules themselves are
// @spirectl/presentation's and are covered by its own suite — jsdom does not run animations, so asserting motion
// here would be asserting nothing.

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function richLabelWire(text: string): Record<string, unknown> {
  return {
    id: "body",
    parentId: null,
    name: "Description",
    nodeType: "Godot.RichTextLabel",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 600, y: 200 } },
    visible: true,
    richText: true,
    text: {
      text,
      textColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffffff" },
      fontSize: 21
    },
    font: { resourcePath: "res://fonts/kreon_regular.ttf" }
  };
}

function render(text: string): HTMLElement {
  const { stage, renderer } = harness();
  const state: MirrorState = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "event",
      upserts: [richLabelWire(text)],
      orderedIds: ["body"]
    })!
  );
  renderer.reconcile(state);
  return stage;
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("animated rich text", () => {
  it("classifies the three looping STS2 tags as effects in the table the mirror feeds gsw", () => {
    for (const name of ["sine", "jitter", "thinky_dots"]) {
      expect(godotBbcodeTagKind(name, DEFAULT_BBCODE_TAGS), `[${name}]`).toBe("effect");
    }
  });

  it("splits a [sine] run into indexed per-character spans under the effect class", () => {
    // The real string shape: an event paragraph with one wavy phrase inside ordinary prose.
    const stage = render("the world is [sine]warping[/sine] around you");
    const effect = stage.querySelector<HTMLElement>("[data-godot-bbcode-effect='sine']");
    expect(effect, "the [sine] region produced an effect element").not.toBeNull();
    expect(effect!.className).toContain("spirectl-rich-fx-sine");

    const chars = effect!.querySelectorAll<HTMLElement>(".godot-rich-char");
    expect(chars, "one span per character of 'warping'").toHaveLength(7);
    // `--i` is what staggers the wave; it must start at 0 for this region regardless of the prose before it.
    expect(chars[0]!.getAttribute("style")).toContain("--i: 0");
    expect(chars[6]!.getAttribute("style")).toContain("--i: 6");

    // The prose AROUND the effect is untouched — no per-character splitting where nothing animates.
    expect(stage.querySelectorAll(".godot-rich-char")).toHaveLength(7 * 4); // one per layer of gsw's stack
    expect(stage.textContent).toContain("the world is warping around you");
  });

  it("injects the effect stylesheet once, when the first rich label is built", () => {
    expect(document.getElementById("spirectl-presentation-rich-text-effects")).toBeNull();
    render("[jitter]mountain of bones[/jitter]");
    expect(document.querySelectorAll("#spirectl-presentation-rich-text-effects")).toHaveLength(1);
    render("[thinky_dots]...[/thinky_dots]");
    expect(document.querySelectorAll("#spirectl-presentation-rich-text-effects")).toHaveLength(1);
  });

  it("leaves a one-shot reveal tag consumed but unsplit", () => {
    const stage = render("a[fade_in]b[/fade_in]c");
    expect(stage.textContent).toContain("abc");
    expect(stage.textContent).not.toContain("fade_in");
    expect(stage.querySelectorAll(".godot-rich-char")).toHaveLength(0);
  });
});

describe("the game's Text Effects preference", () => {
  it("defaults to enabled, so a host that cannot report one still animates", () => {
    expect(createMirrorSettings(undefined, "").textEffects).toBe(true);
  });

  it("is adopted from the session envelope, and an absent field leaves it alone", () => {
    const settings = createMirrorSettings(undefined, "");
    expect(adoptGameTextEffects(settings, { textEffects: false })).toBe(true);
    expect(settings.textEffects).toBe(false);

    // An older host reports nothing; the client must not read that as "off".
    expect(adoptGameTextEffects(settings, { freezeDecor: true })).toBe(false);
    expect(settings.textEffects, "an unreported preference is not a preference of false").toBe(false);
  });

  it("is re-read on EVERY envelope, which is what makes a mid-run toggle land", () => {
    // The freezes are seeded once per connection on purpose (the viewer owns them in the panel afterwards, and a
    // re-seed would stomp their edit). This one is pure game truth with no panel control, so the opposite rule
    // applies — and it has to, or turning Text Effects off mid-run would never reach a phone already watching.
    const settings = createMirrorSettings(undefined, "");
    adoptGameTextEffects(settings, { textEffects: false });
    adoptGameTextEffects(settings, { textEffects: true });
    expect(settings.textEffects).toBe(true);
    adoptGameTextEffects(settings, { textEffects: false });
    expect(settings.textEffects).toBe(false);

    // And it is NOT carried by the once-per-connection freeze seed, which would have frozen it at connect time.
    seedServerSettingsFromSession(settings, { textEffects: true, freezeDecor: true });
    expect(settings.textEffects, "the freeze seed does not touch it").toBe(false);
  });

  it("is never persisted — it describes the GAME, not this viewer", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k)
    };
    const settings = createMirrorSettings(undefined, "", { storage });
    adoptGameTextEffects(settings, { textEffects: false });
    // Nothing writes it, and a hand-forged stored value cannot revive it either.
    storage.setItem("couchcoop.mirrorSettings.v1", JSON.stringify({ textEffects: false }));
    expect(createMirrorSettings(undefined, "", { storage }).textEffects).toBe(true);
  });

  it("names the attribute the presentation rules read", () => {
    expect(RICH_TEXT_EFFECTS_ATTRIBUTE).toBe("data-spirectl-text-effects");
  });
});
