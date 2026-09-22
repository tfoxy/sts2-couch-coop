import type { GpuInfo } from "@godot-scene-web/html";
import { afterEach, describe, expect, it } from "vitest";

import {
  creatureArtIsUnavailable,
  creaturePlaceholderBox,
  creaturePlaceholderKey,
  creaturePlaceholderKind,
  isCreaturePlaceholderNode
} from "@/mirror/creaturePlaceholder";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";
import { resolveRenderQuality, __setRenderQualityForTest } from "@/render/quality";

// EVERY SHAPE HERE IS TRANSCRIBED FROM A RECORDED WIRE STREAM, not invented: the combat trees come from
// `.sts2/bench/combat-modern-2026-08-06.ndjson` and the shop tree from `.sts2/bench/audit-shop.ndjson`. The box
// algebra is the whole point of the module, so its inputs have to be the numbers the game actually sends —
// including the merchant's (-1122.7, -396.68) spine origin, which is what proves the placeholder is positioned
// from the BOX and not from the node origin.

const UNKNOWN_GPU: GpuInfo = { renderer: "", software: false, unavailable: true };

function xf(x: number, y: number, scale = 1): Record<string, unknown> {
  return { xAxis: { x: scale, y: 0 }, yAxis: { x: 0, y: scale }, origin: { x, y } };
}

function rect(x: number, y: number, w: number, h: number): Record<string, unknown> {
  return { position: { x, y }, size: { x: w, y: h } };
}

function build(nodes: Record<string, unknown>[]): MirrorState {
  const state = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      upserts: nodes,
      orderedIds: nodes.map((n) => n.id as string)
    })!
  );
  return state;
}

/** The index shape both backends hand the module: the retained node map plus a parent → children lookup. */
function indexOf(state: MirrorState): {
  nodes: MirrorState["nodes"];
  childrenOf: (id: string) => readonly string[];
} {
  const kids = new Map<string, string[]>();
  for (const node of state.nodes.values()) {
    if (node.parentId == null) continue;
    const list = kids.get(node.parentId);
    if (list) list.push(node.id);
    else kids.set(node.parentId, [node.id]);
  }
  return { nodes: state.nodes, childrenOf: (id) => kids.get(id) ?? [] };
}

/**
 * A combat creature, exactly as the wire sends one: an `NCreature` root carrying the runtime-sized `Hitbox`, an
 * `NCreatureVisuals` child, and the rig's `Visuals` SpineSprite beside its `Bounds`.
 */
function creatureTree(opts: {
  scene: string;
  spineOrigin: [number, number];
  spineScale: number;
  box: [number, number, number, number];
  omitHitbox?: boolean;
  omitBounds?: boolean;
}): Record<string, unknown>[] {
  const [bx, by, bw, bh] = opts.box;
  const tree: Record<string, unknown>[] = [
    {
      id: "creature",
      parentId: null,
      name: "Creature",
      nodeType: "MegaCrit.Sts2.Core.Nodes.Combat.NCreature",
      sceneFilePath: "res://scenes/combat/creature.tscn",
      transform: xf(-324, 200),
      localRect: rect(0, 0, 0, 0),
      visible: true
    },
    {
      id: "visuals-root",
      parentId: "creature",
      name: "Rig",
      nodeType: "MegaCrit.Sts2.Core.Nodes.Combat.NCreatureVisuals",
      sceneFilePath: opts.scene,
      transform: xf(0, 0),
      visible: true
    },
    {
      id: "spine",
      parentId: "visuals-root",
      name: "Visuals",
      nodeType: "Godot.Node2D",
      transform: xf(opts.spineOrigin[0], opts.spineOrigin[1], opts.spineScale),
      visible: true,
      spine: { sceneResPath: opts.scene, nodePath: "Visuals", animations: ["idle_loop"] },
      spineCurrentAnim: "idle_loop",
      spineTrackTime: 0
    }
  ];
  if (opts.omitHitbox !== true) {
    tree.push({
      id: "hitbox",
      parentId: "creature",
      name: "Hitbox",
      nodeType: "Godot.Control",
      transform: xf(bx, by),
      localRect: rect(0, 0, bw, bh),
      visible: true
    });
  }
  if (opts.omitBounds !== true) {
    tree.push({
      id: "bounds",
      parentId: "visuals-root",
      name: "Bounds",
      nodeType: "Godot.Control",
      transform: xf(bx, by),
      localRect: rect(0, 0, bw, bh),
      visible: true
    });
  }
  return tree;
}

/** The shop's merchant: an `NMerchantButton` with a 270x330 rect and the spine node parked far outside it. */
function merchantTree(): Record<string, unknown>[] {
  return [
    {
      id: "button",
      parentId: null,
      name: "MerchantButton",
      nodeType: "MegaCrit.Sts2.Core.Nodes.Screens.Shops.NMerchantButton",
      transform: xf(1206, 468),
      localRect: rect(0, 0, 270, 330),
      visible: true
    },
    {
      id: "spine",
      parentId: "button",
      name: "MerchantVisual",
      nodeType: "Godot.Node2D",
      transform: xf(-1122.7, -396.68, 0.470095),
      visible: true,
      spine: {
        sceneResPath: "res://scenes/rooms/merchant_room.tscn",
        nodePath: "SceneContainer/MerchantButton/MerchantVisual",
        animations: ["idle_loop"]
      },
      spineCurrentAnim: "idle_loop",
      spineTrackTime: 0
    }
  ];
}

/** A spine node with no creature shape around it — the template for every "stays out" case. */
function looseSpine(scene: string, nodePath: string): Record<string, unknown>[] {
  return [
    {
      id: "spine",
      parentId: null,
      name: nodePath.slice(nodePath.lastIndexOf("/") + 1),
      nodeType: "Godot.Node2D",
      transform: xf(0, 0, 0.5),
      visible: true,
      spine: { sceneResPath: scene, nodePath, animations: ["idle_loop"] },
      spineCurrentAnim: "idle_loop",
      spineTrackTime: 0
    }
  ];
}

afterEach(() => {
  __setRenderQualityForTest(undefined);
  mirrorSettings.spineMode = "static"; // the store is an app-wide singleton — back to the product default
});

describe("creature placeholder — which nodes qualify", () => {
  it("claims a combat creature's main rig node and the shop merchant", () => {
    const creature = build(
      creatureTree({
        scene: "res://scenes/creature_visuals/ironclad.tscn",
        spineOrigin: [5, -19],
        spineScale: 0.28,
        box: [-121, -278, 242, 278]
      })
    );
    expect(creaturePlaceholderKind(creature.nodes.get("spine")!)).toBe("combat-creature");
    expect(creaturePlaceholderKind(build(merchantTree()).nodes.get("spine")!)).toBe("shop-merchant");
  });

  // LIVE-FOUND DRIFT, 2026-09-21. The merchant button was authored inline in the room and is now its own
  // scene, so the SAME node's address went from room-qualified to scene-local. The first cut matched only the
  // old form, and the whole feature silently did nothing in the shop on game v0.111.0 — no error, no warning,
  // just no stand-in. Both addresses are claimed, and this is the case that says so.
  it("claims the merchant at BOTH of its scene addresses — the address moved between game builds", () => {
    const addresses: [string, string][] = [
      // v0.111.0, read off a LIVE scene dump: `merchant_button.tscn` is its own scene, so the node path is
      // scene-local. The directory is `scenes/rooms/` — a first fix guessed `scenes/merchant/` and failed
      // silently all over again, which is why the match is on the file NAME.
      ["res://scenes/rooms/merchant_button.tscn", "MerchantVisual"],
      // …and the same file after a hypothetical re-home, which is the churn this has already seen twice.
      ["res://scenes/merchant/merchant_button.tscn", "MerchantVisual"],
      // Older builds (and `.sts2/bench/audit-shop.ndjson`): authored inline in the room.
      ["res://scenes/rooms/merchant_room.tscn", "SceneContainer/MerchantButton/MerchantVisual"]
    ];
    for (const [scene, path] of addresses) {
      const state = build(looseSpine(scene, path));
      expect(creaturePlaceholderKind(state.nodes.get("spine")!)).toBe("shop-merchant");
    }
  });

  it("accepts a rig whose main node is NESTED (CanvasGroup/Visuals, ShakeNode/Visuals)", () => {
    for (const path of ["CanvasGroup/Visuals", "ShakeNode/Visuals"]) {
      const state = build(looseSpine("res://scenes/creature_visuals/decimillipede.tscn", path));
      expect(creaturePlaceholderKind(state.nodes.get("spine")!)).toBe("combat-creature");
    }
  });

  it("stays out of the room background, the merchant's card fan, and the shop's player characters", () => {
    const cases: [string, string][] = [
      // Scenery — a 200x200 knight stretched over a whole room is a bug, not a placeholder. Lives in the SAME
      // scene as the old merchant address, so only the node's leaf name tells the two apart.
      ["res://scenes/rooms/merchant_room.tscn", "SceneContainer/BgContainer/SpineSprite"],
      // …and the boss map point, which is a spine node in a third scene entirely (path from the live dump).
      ["res://scenes/ui/boss_map_point.tscn", "SpriteContainer/SpineSprite"],
      // Not a creature.
      ["res://scenes/merchant/merchant_inventory.tscn", "MerchantHandContainer"],
      // A bare SpineSprite with no bounds node anywhere — there is nothing to stretch into.
      ["res://scenes/merchant/characters/ironclad_merchant.tscn", "SpineSprite"]
    ];
    for (const [scene, path] of cases) {
      const state = build(looseSpine(scene, path));
      expect(creaturePlaceholderKind(state.nodes.get("spine")!)).toBeNull();
    }
  });

  it("stays out of a rig's SECONDARY spine nodes, so one creature gets one image", () => {
    for (const path of ["WeaponAnim1", "Rock3", "Visuals2"]) {
      const state = build(looseSpine("res://scenes/creature_visuals/decimillipede.tscn", path));
      expect(creaturePlaceholderKind(state.nodes.get("spine")!)).toBeNull();
    }
  });

  it("needs a live animation — a spine node the producer has said nothing about yet is not claimed", () => {
    const state = build([
      {
        id: "spine",
        parentId: null,
        name: "Visuals",
        nodeType: "Godot.Node2D",
        transform: xf(0, 0, 0.28),
        visible: true,
        spine: {
          sceneResPath: "res://scenes/creature_visuals/ironclad.tscn",
          nodePath: "Visuals",
          animations: ["idle_loop"]
        }
      }
    ]);
    expect(creaturePlaceholderKind(state.nodes.get("spine")!)).toBeNull();
  });
});

describe("creature placeholder — the tier and mode gates", () => {
  const ironclad = (): MirrorState =>
    build(
      creatureTree({
        scene: "res://scenes/creature_visuals/ironclad.tscn",
        spineOrigin: [5, -19],
        spineScale: 0.28,
        box: [-121, -278, 242, 278]
      })
    );

  it("is claimed on a spine-rendering tier, where it is only a slow/failed-bake stand-in", () => {
    __setRenderQualityForTest(resolveRenderQuality({ search: "?quality=high", gpu: UNKNOWN_GPU }));
    const node = ironclad().nodes.get("spine")!;
    expect(isCreaturePlaceholderNode(node)).toBe(true);
    // Art IS coming here, so the stand-in is a deadline, not a permanent answer.
    expect(creatureArtIsUnavailable(node)).toBe(false);
  });

  it("is claimed AND permanent on the hard-off tier (?quality=off), which requests no clip at all", () => {
    __setRenderQualityForTest(resolveRenderQuality({ search: "?quality=off", gpu: UNKNOWN_GPU }));
    const node = ironclad().nodes.get("spine")!;
    expect(isCreaturePlaceholderNode(node)).toBe(true);
    expect(creatureArtIsUnavailable(node)).toBe(true);
  });

  it("stays out entirely under the dev `?spineMode=off` override", () => {
    __setRenderQualityForTest(resolveRenderQuality({ search: "?quality=off", gpu: UNKNOWN_GPU }));
    mirrorSettings.spineMode = "off";
    const node = ironclad().nodes.get("spine")!;
    expect(isCreaturePlaceholderNode(node)).toBe(false);
    expect(creatureArtIsUnavailable(node)).toBe(false);
  });
});

describe("creature placeholder — the box, in the spine node's own local space", () => {
  it("re-expresses the Ironclad's 242x278 hitbox through its 0.28 rig scale", () => {
    const state = build(
      creatureTree({
        scene: "res://scenes/creature_visuals/ironclad.tscn",
        spineOrigin: [5, -19],
        spineScale: 0.28,
        box: [-121, -278, 242, 278]
      })
    );
    const { nodes, childrenOf } = indexOf(state);
    const box = creaturePlaceholderBox(nodes, childrenOf, nodes.get("spine")!)!;
    // (-121 - 5) / 0.28 = -450 ; (-278 + 19) / 0.28 = -925 ; 242 / 0.28 = 864.29 ; 278 / 0.28 = 992.86
    expect(box.x).toBeCloseTo(-450, 4);
    expect(box.y).toBeCloseTo(-925, 4);
    expect(box.width).toBeCloseTo(864.2857, 3);
    expect(box.height).toBeCloseTo(992.8571, 3);
  });

  it("gives the Sludge Spinner its OWN smaller box (the game re-sizes it per rig)", () => {
    const state = build(
      creatureTree({
        scene: "res://scenes/creature_visuals/sludge_spinner.tscn",
        spineOrigin: [0, -8],
        spineScale: 0.25,
        box: [-96, -246, 192, 246]
      })
    );
    const { nodes, childrenOf } = indexOf(state);
    const box = creaturePlaceholderBox(nodes, childrenOf, nodes.get("spine")!)!;
    expect(box.x).toBeCloseTo(-384, 4);
    expect(box.y).toBeCloseTo(-952, 4);
    expect(box.width).toBeCloseTo(768, 4);
    expect(box.height).toBeCloseTo(984, 4);
  });

  it("falls back to the rig's own Bounds for the 3 rigs whose creature root states no Hitbox", () => {
    const state = build(
      creatureTree({
        scene: "res://scenes/creature_visuals/kaiser_crab_boss.tscn",
        spineOrigin: [5, -19],
        spineScale: 0.28,
        box: [-121, -278, 242, 278],
        omitHitbox: true
      })
    );
    const { nodes, childrenOf } = indexOf(state);
    const box = creaturePlaceholderBox(nodes, childrenOf, nodes.get("spine")!)!;
    expect(box.x).toBeCloseTo(-450, 4);
    expect(box.width).toBeCloseTo(864.2857, 3);
  });

  it("answers null while the creature root has streamed neither box node yet", () => {
    const state = build(
      creatureTree({
        scene: "res://scenes/creature_visuals/ironclad.tscn",
        spineOrigin: [5, -19],
        spineScale: 0.28,
        box: [-121, -278, 242, 278],
        omitHitbox: true,
        omitBounds: true
      })
    );
    const { nodes, childrenOf } = indexOf(state);
    expect(creaturePlaceholderBox(nodes, childrenOf, nodes.get("spine")!)).toBeNull();
  });

  it("lands the merchant's box on the button, NOT on the spine node's far-away origin", () => {
    const state = build(merchantTree());
    const { nodes, childrenOf } = indexOf(state);
    const spine = nodes.get("spine")!;
    const box = creaturePlaceholderBox(nodes, childrenOf, spine)!;

    // 1122.7 / 0.470095 = 2388.24 ; 396.68 / 0.470095 = 843.83 ; 270 / 0.470095 = 574.35 ; 330 / … = 701.99
    expect(box.x).toBeCloseTo(2388.24, 1);
    expect(box.y).toBeCloseTo(843.83, 1);
    expect(box.width).toBeCloseTo(574.35, 1);
    expect(box.height).toBeCloseTo(701.99, 1);

    // …and the proof that it is the button's box: mapped back through the node's own 0.470095 scale and origin,
    // it is exactly the 270x330 rect at (0,0) in button space.
    const s = 0.470095;
    expect(box.x * s + -1122.7).toBeCloseTo(0, 6);
    expect(box.y * s + -396.68).toBeCloseTo(0, 6);
    expect(box.width * s).toBeCloseTo(270, 6);
    expect(box.height * s).toBeCloseTo(330, 6);
  });

  it("answers null for a node it does not claim, whatever the tree around it looks like", () => {
    const state = build(looseSpine("res://scenes/rooms/merchant_room.tscn", "SceneContainer/BgContainer/SpineSprite"));
    const { nodes, childrenOf } = indexOf(state);
    expect(creaturePlaceholderBox(nodes, childrenOf, nodes.get("spine")!)).toBeNull();
  });
});

describe("creature placeholder — the placement key", () => {
  it("is stable across sub-tenth-pixel drift, so an idling creature rewrites no styles", () => {
    const a = creaturePlaceholderKey({ x: -450, y: -925, width: 864.2857, height: 992.8571 });
    const b = creaturePlaceholderKey({ x: -450.02, y: -925.03, width: 864.2901, height: 992.8544 });
    expect(a).toBe(b);
  });

  it("changes when the box really moves", () => {
    const a = creaturePlaceholderKey({ x: -450, y: -925, width: 864, height: 992 });
    const b = creaturePlaceholderKey({ x: -384, y: -952, width: 768, height: 984 });
    expect(a).not.toBe(b);
  });
});
