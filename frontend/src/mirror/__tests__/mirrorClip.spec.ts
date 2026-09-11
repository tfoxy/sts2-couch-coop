import { mount } from "@vue/test-utils";
import { beforeAll, describe, expect, it } from "vitest";

import MirrorView from "@/mirror/MirrorView.vue";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// jsdom has no ResizeObserver (MirrorView observes its frame for scale-to-fit).
beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

function rawNode(id: string, parentId: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "NinePatchRect",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 16 } },
    visible: true,
    ...over
  };
}

function stateWith(nodes: Record<string, unknown>[], order: string[]): MirrorState {
  const state = createMirrorState();
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: nodes, orderedIds: order })!);
  return state;
}

describe("MirrorView clip groups", () => {
  it("nests a clip_children node's descendants inside the clipper element", () => {
    const state = stateWith(
      [
        rawNode("flat", null),
        rawNode("clipper", null, {
          clipChildren: 1,
          texture: { resourcePath: "res://images/ui/combat/health_bar.png", resourceType: "Texture2D" },
          ninePatchMargins: { left: 6, top: 6, right: 6, bottom: 6 }
        }),
        rawNode("fill", "clipper")
      ],
      ["flat", "clipper", "fill"]
    );

    const wrapper = mount(MirrorView, { props: { state, revision: 1 } });
    const clipper = wrapper.find('[data-node-id="clipper"]');
    expect(clipper.exists()).toBe(true);
    // The clip child renders INSIDE the clipper (so the CSS clip/mask applies); not as a flat sibling.
    expect(clipper.find('[data-node-id="fill"]').exists()).toBe(true);
    expect(clipper.attributes("style")).toContain("overflow: hidden");
    // A non-clipped sibling is NOT nested under the clipper.
    expect(clipper.find('[data-node-id="flat"]').exists()).toBe(false);
    expect(wrapper.find('[data-node-id="flat"]').exists()).toBe(true);
  });
});

// R20 — the two `clip_contents` regressions from R19 WP-4, proved through the REAL walk (the clip-axis table is
// keyed on scene identity, which only `computeSceneInfo` can resolve, so a nodeStyle-level test cannot cover the
// plumbing).
describe("MirrorView clip_contents exceptions (R20)", () => {
  it("clips the ancient event's ContentContainer on the VERTICAL axis only", () => {
    // The real shape (measured from .sts2/bench/audit-mprun.ndjson): the layout root carries the scene file, and
    // ContentContainer is a 1160x720 plain child at design (380,320) whose subtree this repo enlarges by 1.2.
    const state = stateWith(
      [
        rawNode("root", null, {
          name: "AncientEventLayout",
          nodeType: "Godot.Control",
          sceneFilePath: "res://scenes/events/ancient_event_layout.tscn",
          localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } }
        }),
        rawNode("content", "root", {
          name: "ContentContainer",
          nodeType: "Godot.Control",
          clipContents: true,
          transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 380, y: 320 } },
          localRect: { position: { x: 0, y: 0 }, size: { x: 1160, y: 720 } }
        }),
        rawNode("options", "content", {
          name: "Content",
          localRect: { position: { x: 0, y: 0 }, size: { x: 1000, y: 388 } }
        })
      ],
      ["root", "content", "options"]
    );

    const wrapper = mount(MirrorView, { props: { state, revision: 1 } });
    const el = wrapper.find('[data-node-id="content"]');
    expect(el.exists()).toBe(true);
    const style = el.attributes("style") ?? "";
    // Vertical clip kept (it is what hides the parked options mid-dialogue — the R19 WP-4 fix); horizontal outset
    // to the full design stage, so the 1.2x-enlarged 1000px option rows are no longer cut 20px on each side.
    expect(style).toContain("clip-path: inset(0px -380px)");
    expect(style).not.toContain("overflow: hidden");
  });

  it("clips a same-named container in ANOTHER scene on both axes (the table is scene-keyed, not name-keyed)", () => {
    const state = stateWith(
      [
        rawNode("root", null, {
          name: "DefaultEventLayout",
          nodeType: "Godot.Control",
          sceneFilePath: "res://scenes/events/default_event_layout.tscn",
          localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } }
        }),
        rawNode("content", "root", {
          name: "ContentContainer",
          nodeType: "Godot.Control",
          clipContents: true,
          localRect: { position: { x: 0, y: 0 }, size: { x: 1160, y: 720 } }
        })
      ],
      ["root", "content"]
    );

    const wrapper = mount(MirrorView, { props: { state, revision: 1 } });
    const style = wrapper.find('[data-node-id="content"]').attributes("style") ?? "";
    expect(style).toContain("overflow: hidden");
    expect(style).not.toContain("clip-path");
  });

  it("never clips a card's rich-text description (Godot's RichTextLabel clip_contents default)", () => {
    const state = stateWith(
      [
        rawNode("card", null, {
          name: "Card",
          nodeType: "MegaCrit.Sts2.Core.Nodes.Cards.NCard",
          sceneFilePath: "res://scenes/cards/card.tscn",
          localRect: { position: { x: 0, y: 0 }, size: { x: 220, y: 300 } }
        }),
        rawNode("desc", "card", {
          name: "DescriptionLabel",
          nodeType: "Godot.RichTextLabel",
          richText: true,
          clipContents: true, // the CLASS default — card.tscn authors nothing
          text: { text: "Deal 6 damage." },
          localRect: { position: { x: 0, y: 0 }, size: { x: 180, y: 80 } }
        })
      ],
      ["card", "desc"]
    );

    const wrapper = mount(MirrorView, { props: { state, revision: 1 } });
    const style = wrapper.find('[data-node-id="desc"]').attributes("style") ?? "";
    expect(style).not.toContain("overflow: hidden");
    expect(style).not.toContain("clip-path");
  });
});

describe("MirrorView z_index (relative, lifted by the nested DOM)", () => {
  it("emits a raised node's z_index VERBATIM and nests its subtree inside it (so the whole card lifts)", () => {
    // A focused card: its root is raised via z_index; its visual children carry their own (0) local z. The mirror
    // DOM now NESTS the child inside the raised card element, so the card's z-index stacking context lifts the
    // whole subtree above z=0 siblings automatically — the child needs NO composed z of its own.
    const state = stateWith(
      [
        rawNode("sibling", null, { zIndex: 0 }),
        rawNode("focusedCard", null, { zIndex: 5 }),
        rawNode("focusedFrame", "focusedCard", { zIndex: 0 })
      ],
      ["sibling", "focusedCard", "focusedFrame"]
    );

    const wrapper = mount(MirrorView, { props: { state, revision: 1 } });
    const card = wrapper.find('[data-node-id="focusedCard"]');
    // The raised card carries its OWN relative z; its child is a DOM DESCENDANT (nested), so no z-index is emitted
    // on the child — the card's stacking context already lifts it.
    expect(card.attributes("style")).toContain("z-index: 5");
    const frame = card.find('[data-node-id="focusedFrame"]');
    expect(frame.exists()).toBe(true); // nested inside the raised card
    expect(frame.attributes("style") ?? "").not.toContain("z-index");
    // An unfocused sibling stays at z=0 — no z-index emitted, so it keeps normal DOM (fan) order.
    expect(wrapper.find('[data-node-id="sibling"]').attributes("style")).not.toContain("z-index");
  });
});
