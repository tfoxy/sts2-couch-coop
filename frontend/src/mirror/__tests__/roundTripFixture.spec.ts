import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { applySceneDelta, createMirrorState, parseSceneDelta } from "@/mirror/sceneTree";

// Cross-language round-trip: the C# side (BrowserSceneDeltaMessageTests.RoundTripFixtureMatches) asserts a known
// delta serializes to this exact checked-in file; here we feed those SAME bytes through the client parse/apply and
// assert the reconstructed state field-by-field. A wire-format change on either side breaks a test.

const raw = readFileSync(resolve(process.cwd(), "../tests/fixtures/wire/roundtrip-delta.json"), "utf8");

describe("cross-language round-trip fixture", () => {
  it("parses + applies the C#-serialized delta to the expected client state", () => {
    const delta = parseSceneDelta(JSON.parse(raw));
    expect(delta).not.toBeNull();
    const state = createMirrorState();
    applySceneDelta(state, delta!);

    expect(state.orderedIds).toEqual(["root", "card"]);
    expect(state.nodes.size).toBe(2);

    const root = state.nodes.get("root")!;
    expect(root.name).toBe("Root");
    expect(root.parentId).toBeNull();
    // Omitted defaults refilled by normalizeNode.
    expect(root.visible).toBe(true);
    expect(root.opacity).toBe(1);
    expect(root.scaleX).toBe(1);
    expect(root.transform).toEqual([1, 0, 0, 1, 0, 0]);

    const card = state.nodes.get("card")!;
    expect(card.parentId).toBe("root");
    // Meaningful non-defaults preserved; scaleX omitted (=1), scaleY written (=2).
    expect(card.visible).toBe(false);
    expect(card.opacity).toBe(0.5);
    expect(card.scaleX).toBe(1);
    expect(card.scaleY).toBe(2);
    expect(card.zIndex).toBe(5);
    // Float-cast transform / localRect parsed transparently.
    expect(card.transform).toEqual([1, 0, 0, 1, 960.5, 540]);
    expect(card.localRect).toEqual({ x: 0, y: 0, width: 100, height: 16 });
    // Resource-ref slimmed to path → resolved to the /res/ url.
    expect(card.textureUrl).toBe("/res/images/card.png");
    // Color html-only → channels derived.
    expect(card.modulate!.html).toBe("#ff8040ff");
    expect(card.modulate!.r).toBeCloseTo(1, 6);
    expect(card.modulate!.g).toBeCloseTo(0x80 / 255, 6);
    expect(card.modulate!.b).toBeCloseTo(0x40 / 255, 6);
    // Nested Text: content, derived color html, applied font size, alignment.
    expect(card.text!.text).toBe("HP");
    expect(card.text!.colorHtml).toBe("#ffffffff");
    expect(card.text!.fontSizePx).toBe(24);
    expect(card.text!.halign).toBe("center");
    expect(card.text!.valign).toBe("center");
  });
});
