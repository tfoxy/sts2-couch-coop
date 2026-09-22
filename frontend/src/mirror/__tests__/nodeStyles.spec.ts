import { afterEach, describe, expect, it, vi } from "vitest";

// Seed texture natural sizes for the degenerate-nine-patch tests (warmImage's real Image() load is a no-op in
// jsdom, so naturalSize would otherwise always be null). Keep every other export real.
vi.mock("@/mirror/textureCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/textureCache")>();
  const sizes = new Map<string, { width: number; height: number }>();
  return {
    ...actual,
    naturalSize: (url: string) => sizes.get(url) ?? null,
    __setSize: (url: string, width: number, height: number) => sizes.set(url, { width, height })
  };
});

import {
  CLIP_AXIS_ANCIENT_CONTENT_OUTSET,
  CLIP_AXIS_CANDIDATE_NAMES,
  CLIP_AXIS_ENTRIES,
  resolveClipAxisOutset
} from "@/mirror/clipAxis";
import {
  atlasCanvasPlacement,
  elementLocalPoint,
  ninePatchAtlasSlices,
  nodePaintsContent,
  nodeStyle,
  paintsAtlasCanvas,
  splitAnimStyle,
  splitSelfStyle,
  textStyle,
  type RenderItem
} from "@/mirror/nodeStyles";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { __setRenderQualityForTest, type RenderQuality } from "@/render/quality";
import type { MirrorNode } from "@/mirror/sceneTree";
import * as textureCache from "@/mirror/textureCache";

const setTextureSize = (textureCache as unknown as { __setSize: (u: string, w: number, h: number) => void })
  .__setSize;

function mkNode(over: Partial<MirrorNode> = {}): MirrorNode {
  return {
    id: "n",
    parentId: null,
    name: "Mask",
    nodeType: "NinePatchRect",
    showBehindParent: false,
    clipChildren: 0,
    clipContents: false,
    ninePatchMargins: null,
    font: null,
    richBoldFont: null,
    richItalicFont: null,
    richBoldItalicFont: null,
    richBoldFontSizePx: null,
    richItalicFontSizePx: null,
    richBoldItalicFontSizePx: null,
    richBoldFontSpacingPx: null,
    richItalicFontSpacingPx: null,
    richBoldItalicFontSpacingPx: null,
    textWrap: null,
    shadow: null,
    richText: false,
    shaderId: null,
    materialRef: null,
    shaderParams: null,
    textureStretchMode: null,
    textureFlipH: false,
    textureFlipV: false,
    particleSpec: null,
    particleEmitting: false,
    particleRestartEpoch: 0,
    spineSceneResPath: null,
    spineNodePath: null,
    spineAnimations: null,
    spineSkelResPath: null,
    sceneFilePath: null,
    mouseFilter: null,
    anchorLeft: null,
    anchorRight: null,
    anchorOwnerId: null,
    containerLayout: null,
    contentKey: null,
    spineCurrentAnim: null,
    spineSkin: null,
    spineMat: null,
    spinePaused: false,
    spineTrackTime: 0,
    spineLooping: true,
    pinnedLoopAnim: null,
    transform: [1, 0, 0, 1, 0, 0],
    localRect: { x: 0, y: 0, width: 250, height: 16 },
    visible: true,
    focused: false,
    opacity: 1,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    pivotX: 0,
    pivotY: 0,
    zIndex: null,
    textureUrl: "/res/images/ui/combat/health_bar.png",
    textureRegion: null,
    textureMargin: null,
    ninePatch: true,
    modulate: null,
    selfModulate: null,
    fillColor: null,
    range: null,
    text: null,
    outline: null,
    ...over
  };
}

function item(node: MirrorNode, parentInv: RenderItem["parentInv"] = null, hasChildren = false): RenderItem {
  return { node, opacity: 1, tintId: null, parentInv, hasChildren };
}

describe("nodeStyle clip_children", () => {
  it("CLIP_ONLY (1) emits overflow + a rounded capsule and paints NO texture", () => {
    // 250x16 box, 6px margins → radius clamps to half-height (8). Degenerate texture masks are avoided.
    const style = nodeStyle(item(mkNode({ clipChildren: 1, ninePatchMargins: { left: 6, top: 6, right: 6, bottom: 6 } })));
    expect(style.overflow).toBe("hidden");
    expect(style.borderRadius).toBe("6px");
    expect(style["-webkit-mask-box-image"]).toBeUndefined();
    // CLIP_ONLY draws nothing — it only clips.
    expect(style.borderImageSource).toBeUndefined();
  });

  it("CLIP_AND_DRAW (2) clips (overflow + radius) AND paints its texture", () => {
    const style = nodeStyle(item(mkNode({ clipChildren: 2, ninePatchMargins: { left: 6, top: 6, right: 6, bottom: 6 } })));
    expect(style.overflow).toBe("hidden");
    expect(style.borderRadius).toBe("6px");
    expect(style.borderImageSource).toContain("/res/images/ui/combat/health_bar.png");
  });

  it("places a nested child relative to its parent element (universal parentInv)", () => {
    // Parent element at global origin (200,100); child global origin (205, 96) → relative (5, -4). The mirror DOM
    // now nests EVERY node inside its parent, so this parentInv path is the universal placement (not just clips).
    const child = mkNode({ transform: [1, 0, 0, 1, 205, 96], localRect: { x: 0, y: 0, width: 100, height: 24 } });
    const style = nodeStyle(item(child, [1, 0, 0, 1, -200, -100]));
    expect(style.transform).toBe("matrix(1, 0, 0, 1, 5, -4)");
    expect(style.left).toBe("0px");
    expect(style.top).toBe("0px");
  });

  it("PLACEMENT IDENTITY: elMatrix ≡ translate(-parentBoxOrigin)·L_child·translate(childLr) (hand-computed)", () => {
    // Hand-compute the universal placement for a non-trivial case:
    //   parent global L_p = [1,0,0,1, 30,40] with local box origin (10, 5) → parent element matrix
    //     M_p = nodeMatrix(L_p, (10,5)) = [1,0,0,1, 40, 45]; parentInv = inverse(M_p) = [1,0,0,1, -40, -45].
    //   child global L_c = [2,0,0,2, 100,80] with local box origin (3, 7) → nodeMatrix(L_c, (3,7)) = [2,0,0,2, 106, 94].
    //   elMatrix = parentInv · nodeMatrix(L_c, childLr) = [2,0,0,2, 66, 49].
    const parentInv: RenderItem["parentInv"] = [1, 0, 0, 1, -40, -45];
    const child = mkNode({ transform: [2, 0, 0, 2, 100, 80], localRect: { x: 3, y: 7, width: 50, height: 20 } });
    const style = nodeStyle(item(child, parentInv));
    expect(style.transform).toBe("matrix(2, 0, 0, 2, 66, 49)");
    expect(style.transformOrigin).toBe("0 0");
    expect(style.width).toBe("50px");
    expect(style.height).toBe("20px");
  });
});

describe("nodeStyle clip_contents", () => {
  // The defect this exists for: the game hides the ancient event's options by PARKING them below their
  // `ContentContainer` and letting `clip_contents` cut them off — no `visible`, no `modulate`. The container paints
  // nothing, so `clipChildren` is 0 on it and the mirror drew every parked option at full opacity.
  it("clips a non-painting container to its own rect (a plain rectangle, no capsule radius)", () => {
    const style = nodeStyle(
      item(
        mkNode({
          nodeType: "Control",
          clipChildren: 0,
          clipContents: true,
          transform: [1, 0, 0, 1, 0, 0],
          localRect: { x: 0, y: 0, width: 900, height: 300 }
        })
      )
    );
    expect(style.overflow).toBe("hidden");
    // No clipper TEXTURE, so no rounding: clip_contents is a rect clip, unlike the clip_children capsule.
    expect(style.borderRadius).toBeUndefined();
  });

  it("does NOT make the node stop painting (clipChildren===1 is the only 'paints nothing' mode)", () => {
    const node = mkNode({
      clipChildren: 0,
      clipContents: true,
      transform: [1, 0, 0, 1, 0, 0],
      localRect: { x: 0, y: 0, width: 250, height: 16 },
      ninePatchMargins: { left: 6, top: 6, right: 6, bottom: 6 }
    });
    expect(nodePaintsContent(node, 1)).toBe(true);
    expect(nodeStyle(item(node)).borderImageSource).toContain("/res/images/ui/combat/health_bar.png");
  });

  it("a clip_children capsule still wins its rounded clip when both flags are set", () => {
    const style = nodeStyle(
      item(mkNode({ clipChildren: 2, clipContents: true, ninePatchMargins: { left: 6, top: 6, right: 6, bottom: 6 } }))
    );
    expect(style.overflow).toBe("hidden");
    expect(style.borderRadius).toBe("6px");
  });

  it("does NOT clip a node with no placement box (an unsized element would clip its subtree to nothing)", () => {
    const style = nodeStyle(
      item(mkNode({ nodeType: "Control", clipChildren: 0, clipContents: true, localRect: null }))
    );
    expect(style.overflow).toBeUndefined();
  });

});

// Ancient event options are cropped on the sides, most noticeably when focused.
// The clipper (ancient_event_layout.tscn :: ContentContainer, 1160x720 at design (380,320) → x 380…1540) is an
// ANCESTOR of a node THIS repo enlarges: viewScale.ts scales ContentContainer/Content/OptionsContainer (1000 wide
// at design x 460…1460) by 1.2 about its bottom-centre (pivot x 960) → 360…1560, i.e. 20px past the clipper on each
// side, and further while an option is focused. The vertical clip hides the parked options while the dialogue
// plays and must survive. Geometry measured from .sts2/bench/audit-mprun.ndjson.
describe("nodeStyle one-axis clip", () => {
  const clipper = (over: Partial<MirrorNode> = {}) =>
    mkNode({
      name: "ContentContainer",
      nodeType: "Control",
      clipChildren: 0,
      clipContents: true,
      textureUrl: null,
      ninePatch: false,
      transform: [1, 0, 0, 1, 380, 320],
      localRect: { x: 0, y: 0, width: 1160, height: 720 },
      ...over
    });

  const withOutset = (node: MirrorNode, outsetX: number | undefined): RenderItem => ({
    ...item(node),
    clipAxisOutsetX: outsetX
  });

  it("the table resolves ONLY the ancient event's ContentContainer", () => {
    expect(resolveClipAxisOutset("res://scenes/events/ancient_event_layout.tscn", "ContentContainer")).toBe(
      CLIP_AXIS_ANCIENT_CONTENT_OUTSET
    );
    // Same node name in a DIFFERENT scene, and a different node in the SAME scene, both resolve neutral.
    expect(resolveClipAxisOutset("res://scenes/events/default_event_layout.tscn", "ContentContainer")).toBeNull();
    expect(
      resolveClipAxisOutset("res://scenes/events/ancient_event_layout.tscn", "ContentContainer/Content")
    ).toBeNull();
    expect(resolveClipAxisOutset(null, null)).toBeNull();
  });

  it("the candidate-name pre-filter is derived from the table (cannot drift)", () => {
    for (const e of CLIP_AXIS_ENTRIES) {
      expect(CLIP_AXIS_CANDIDATE_NAMES.has(e.path.slice(e.path.lastIndexOf("/") + 1))).toBe(true);
    }
    expect(CLIP_AXIS_CANDIDATE_NAMES.size).toBe(new Set(CLIP_AXIS_ENTRIES.map((e) => e.path)).size);
  });

  it("a TABLE-MATCHED clipper clips the vertical axis only (clip-path, never overflow)", () => {
    const style = nodeStyle(withOutset(clipper(), CLIP_AXIS_ANCIENT_CONTENT_OUTSET));
    // Vertical clip kept at the box edge; horizontal outset by 380 → the window is design x 0…1920 (the full stage),
    // which comfortably clears the measured 20px-per-side overflow plus focus growth.
    expect(style.clipPath).toBe("inset(0px -380px)");
    // `overflow: hidden` would clip BOTH axes, and CSS cannot mix hidden/visible per axis (the visible axis computes
    // to `auto` → a scroll container), which is exactly why this is a clip-path.
    expect(style.overflow).toBeUndefined();
  });

  it("the one-axis clip stays on the CONTAINER when an interior node's style is split", () => {
    // ContentContainer is an interior node (it exists to hold Content), so its style is split onto a container +
    // a self-paint layer. A structural clip that landed on the self-layer would bound only the node's own paint.
    const full = nodeStyle({ ...withOutset(clipper(), CLIP_AXIS_ANCIENT_CONTENT_OUTSET), hasChildren: true });
    const { container, selfPaint } = splitSelfStyle(full, 1, 1);
    expect(container.clipPath).toBe("inset(0px -380px)");
    expect(selfPaint.clipPath).toBeUndefined();
  });

  it("an UNMATCHED clipper still clips both axes with overflow: hidden", () => {
    const style = nodeStyle(withOutset(clipper({ name: "SomeOtherPanel" }), undefined));
    expect(style.overflow).toBe("hidden");
    expect(style.clipPath).toBeUndefined();
  });

});

// Godot's RichTextLabel.clip_contents defaults to TRUE and `card.tscn :: CardContainer/DescriptionLabel` does not
// author it, so the mirror must not clip it purely from the class default. The readability rule scales
// `.mirror-text` 1.24x about its centre and says so literally
// ("Overflow beyond the card bg is ACCEPTABLE (cropping is not)" — generated text-scale declarations), so
// the enlarged glyphs are MEANT to spill past the label rect. Same for hover_tip.tscn's Description.
// Native twin: godot-client/src/Scene/TextBuilder.cs ConfigureRich sets `rtl.ClipContents = false`.
describe("nodeStyle never clips RICH TEXT", () => {
  const richLabel = (over: Partial<MirrorNode> = {}) =>
    mkNode({
      name: "DescriptionLabel",
      nodeType: "RichTextLabel",
      clipChildren: 0,
      clipContents: true, // Godot class DEFAULT — nothing in the scene authors it
      richText: true,
      textureUrl: null,
      ninePatch: false,
      transform: [1, 0, 0, 1, 0, 0],
      localRect: { x: 0, y: 0, width: 220, height: 96 },
      ...over
    });

  it("a RichTextLabel carrying clip_contents gets NO clip at all", () => {
    const style = nodeStyle(item(richLabel()));
    expect(style.overflow).toBeUndefined();
    expect(style.clipPath).toBeUndefined();
  });

  it("the hover-tip Description (the second victim) is the same shape and is likewise unclipped", () => {
    const style = nodeStyle(item(richLabel({ name: "Description", localRect: { x: 0, y: 0, width: 420, height: 60 } })));
    expect(style.overflow).toBeUndefined();
    expect(style.clipPath).toBeUndefined();
  });

  it("a ScrollContainer's clip is legitimate and still fires (the exemption is RICH TEXT, not 'all text')", () => {
    const style = nodeStyle(
      item(
        mkNode({
          name: "Scroll",
          nodeType: "ScrollContainer",
          clipChildren: 0,
          clipContents: true,
          richText: false,
          textureUrl: null,
          ninePatch: false,
          transform: [1, 0, 0, 1, 0, 0],
          localRect: { x: 0, y: 0, width: 400, height: 300 }
        })
      )
    );
    expect(style.overflow).toBe("hidden");
  });

  it("a plain Label is unaffected (it defaults to clip_contents = false and never reaches the branch)", () => {
    const style = nodeStyle(
      item(
        mkNode({
          name: "TitleLabel",
          nodeType: "Label",
          clipChildren: 0,
          clipContents: false,
          richText: false,
          textureUrl: null,
          ninePatch: false,
          transform: [1, 0, 0, 1, 0, 0],
          localRect: { x: 0, y: 0, width: 200, height: 40 }
        })
      )
    );
    expect(style.overflow).toBeUndefined();
    expect(style.clipPath).toBeUndefined();
  });

  it("a rich-text node still clips when clip_children is set (that is a texture-shaped clip, not the rect one)", () => {
    const style = nodeStyle(
      item(mkNode({ nodeType: "RichTextLabel", richText: true, clipChildren: 2, clipContents: true }))
    );
    expect(style.overflow).toBe("hidden");
  });
});

describe("nodeStyle mouse_filter does NOT drive pointer-events", () => {
  it("leaves pointer-events unset for every mouse_filter value (cards' Ignore content must stay hittable)", () => {
    // mouse_filter→pointer-events was removed: card content is mouse_filter=Ignore but the card root is boxless,
    // so pe:none would leave a card with nothing hittable. Occlusion is handled structurally in mirrorRenderer
    // (decorative/preview exclusion), not here. Every node keeps the .mirror-node base `auto`.
    for (const mouseFilter of [0, 1, 2, null]) {
      expect(nodeStyle(item(mkNode({ mouseFilter }))).pointerEvents).toBeUndefined();
    }
  });
});

describe("splitSelfStyle (interior node self-paint layer)", () => {
  // An interior node with own paint: 250x16 nine-patch capsule, clip+draw, self_modulate-derived tint.
  const clipNode = (over: Partial<MirrorNode> = {}) =>
    mkNode({ clipChildren: 2, ninePatchMargins: { left: 6, top: 6, right: 6, bottom: 6 }, ...over });
  const clipItem = (node: MirrorNode, tintId: string | null = null): RenderItem => ({
    node,
    opacity: 1,
    tintId,
    parentInv: null,
    hasChildren: true
  });

  it("keeps only placement/structure on the container and moves the texture + own tint to the self-paint layer", () => {
    const { container, selfPaint } = splitSelfStyle(nodeStyle(clipItem(clipNode(), "16_16_16")), 1, 1);
    // Container: placement + the clip, NO own paint and NO cascading tint filter (which would double-apply onto
    // the DOM-nested children).
    expect(container.overflow).toBe("hidden");
    expect(container.borderRadius).toBe("6px");
    expect(container.filter).toBeUndefined();
    expect(container.borderImageSource).toBeUndefined();
    // Self-paint layer: the node's texture and its own tint filter (won't cascade — it's a leaf sibling of the
    // children, not their ancestor).
    expect(selfPaint.borderImageSource).toContain("/res/images/ui/combat/health_bar.png");
    expect(selfPaint.filter).toBe("url(#mtint-16_16_16)");
  });

  it("splits opacity: container gets modulate.a (cascades to children), self-paint gets selfAlpha (own only)", () => {
    const { container, selfPaint } = splitSelfStyle(nodeStyle(clipItem(clipNode())), 0.5, 0.31);
    expect(container.opacity).toBe("0.5");
    expect(selfPaint.opacity).toBe("0.31");
  });

  it("KEEPS the node's own blend mode on the OUTER container (not the self-paint layer)", () => {
    // mix-blend-mode stays outer: the transformed container is already a stacking context, so blending on the
    // self-layer would composite against an empty backdrop instead of the scene behind the node. Blend doesn't
    // inherit in CSS, so keeping it outer doesn't leak onto the children.
    const { container, selfPaint } = splitSelfStyle(nodeStyle(clipItem(clipNode({ canvasBlendMode: 1 }))), 1, 1);
    expect(container.mixBlendMode).toBe("plus-lighter"); // ADD
    expect(selfPaint.mixBlendMode).toBeUndefined();
  });

  it("yields an empty self-paint for a CLIP_ONLY container with no own paint (caller skips the layer)", () => {
    const { selfPaint } = splitSelfStyle(nodeStyle(clipItem(clipNode({ clipChildren: 1 }))), 1, 1);
    expect(Object.keys(selfPaint)).toHaveLength(0);
  });

  it("splits a NON-clip interior node too (a panel with a background + children): bg → self, placement → container", () => {
    // A plain container node (no clip) that has both its own texture AND children now also splits, so the
    // background/filter don't cascade onto the nested children.
    const panel = mkNode({
      nodeType: "TextureRect",
      clipChildren: 0,
      ninePatch: false,
      textureUrl: "/res/images/panel.png",
      localRect: { x: 0, y: 0, width: 200, height: 120 }
    });
    const { container, selfPaint } = splitSelfStyle(nodeStyle(clipItem(panel, "10_10_10")), 1, 1);
    expect(container.overflow).toBeUndefined(); // not a clip → no overflow on the container
    expect(container.transform).toBeDefined(); // placement stays on the container
    expect(container.backgroundImage).toBeUndefined();
    expect(selfPaint.backgroundImage).toContain("/res/images/panel.png");
    expect(selfPaint.filter).toBe("url(#mtint-10_10_10)");
  });
});

describe("nodeStyle degenerate plain nine-patch (event_button middle fill)", () => {
  const EVENT_BUTTON = "/res/images/packed/common_ui/event_button.png";
  const npNode = (over: Partial<MirrorNode> = {}) =>
    mkNode({
      nodeType: "NinePatchRect",
      name: "Image",
      clipChildren: 0,
      ninePatch: true,
      textureUrl: EVENT_BUTTON,
      ninePatchMargins: { left: 192, top: 50, right: 192, bottom: 50 },
      localRect: { x: 0, y: 0, width: 800, height: 100 },
      ...over
    });

  it("paints a stretched full-texture background under the border-image when margins overlap the texture", () => {
    // event_button.png is 284x110: 192+192=384 > 284 → the source middle slices are negative → CSS border-image
    // leaves the middle blank. The stretched background fills it; the border-image caps still draw on top.
    // Box is 800x300 here so ONLY the source-overlap (texture) path is exercised (margins fit the box).
    setTextureSize(EVENT_BUTTON, 284, 110);
    const style = nodeStyle(item(npNode({ localRect: { x: 0, y: 0, width: 800, height: 300 } })));
    expect(style.borderImageSource).toContain("event_button.png");
    expect(style.backgroundImage).toContain("event_button.png");
    expect(style.backgroundSize).toBe("100% 100%");
    expect(style.backgroundRepeat).toBe("no-repeat");
    // Required so 100% spans the full element, not the (border-collapsed) padding box → otherwise zero-height.
    expect(style.backgroundOrigin).toBe("border-box");
  });

  it("does NOT add a background for a non-degenerate plain nine-patch (margins fit the texture)", () => {
    // event_button_sdf.png 512x512, margins 229/251/237/251: source 466<512 & 502<512, and in a box big
    // enough that the margins also fit the destination (466<1100, 502<600) → not degenerate either way.
    const sdf = "/res/images/packed/common_ui/event_button_sdf.png";
    setTextureSize(sdf, 512, 512);
    const style = nodeStyle(
      item(
        npNode({
          textureUrl: sdf,
          ninePatchMargins: { left: 229, top: 251, right: 237, bottom: 251 },
          localRect: { x: 0, y: 0, width: 1100, height: 600 }
        })
      )
    );
    expect(style.borderImageSource).toContain("event_button_sdf.png");
    expect(style.backgroundImage).toBeUndefined();
  });

  it("falls back to caps-only (no background) until the texture size is measured", () => {
    // No seeded size → naturalSize null. With a box big enough that the margins also fit the destination
    // (384 < 800, 100 < 300), NEITHER degenerate check can fire yet → border-image only, exactly as today.
    const style = nodeStyle(
      item(
        npNode({
          textureUrl: "/res/images/packed/common_ui/unmeasured.png",
          localRect: { x: 0, y: 0, width: 800, height: 300 }
        })
      )
    );
    expect(style.borderImageSource).toContain("unmeasured.png");
    expect(style.backgroundImage).toBeUndefined();
  });

  it("detects destination collapse (margins meet/exceed the element box) even with a fitting texture", () => {
    // Valid texture (margins fit it), but the element is only as tall as top+bottom → border content box
    // collapses → border-image fill blank. The destination check fires and fills it.
    const tall = "/res/images/packed/common_ui/tall_caps.png";
    setTextureSize(tall, 600, 400);
    const style = nodeStyle(
      item(
        npNode({
          textureUrl: tall,
          ninePatchMargins: { left: 20, top: 50, right: 20, bottom: 50 },
          localRect: { x: 0, y: 0, width: 800, height: 100 } // 50+50 >= 100 → dst-degenerate vertically
        })
      )
    );
    expect(style.backgroundImage).toContain("tall_caps.png");
  });
});

// R19 6c — the three width-BLIND reads on a nine-patch node. The element is laid out at `renderWidthOverride` on a
// widened stage (nodeStyle's own `style.width`), so every read that asks "how wide is this element on screen" has to
// use that, not the streamed 1920-space localRect.
describe("nodeStyle nine-patch reads the RENDERED width (R19 6c)", () => {
  const DELTA = 600; // the 2520 cap
  const withWidth = (node: MirrorNode, renderWidthOverride?: number): RenderItem => ({
    ...item(node),
    renderWidthOverride
  });

  it("sizes the element to the rendered width (the premise the other two reads must match)", () => {
    const node = mkNode({ localRect: { x: 0, y: 0, width: 640, height: 100 }, transform: [1, 0, 0, 1, 0, 0] });
    expect(nodeStyle(withWidth(node, 640 + DELTA)).width).toBe(`${640 + DELTA}px`);
    expect(nodeStyle(withWidth(node)).width).toBe("640px");
  });

  it("clips with a radius clamped to the RENDERED half-width, not the streamed one", () => {
    // A stretched capsule: margins 400, streamed width 600 (→ the 1920 clamp caps the radius at 300), rendered
    // 1200 (→ the margin itself wins). Height is large enough not to be the binding clamp.
    const capsule = mkNode({
      clipChildren: 1,
      ninePatchMargins: { left: 400, top: 400, right: 400, bottom: 400 },
      localRect: { x: 0, y: 0, width: 600, height: 1000 }
    });
    expect(nodeStyle(withWidth(capsule)).borderRadius).toBe("300px"); // streamed: half of 600
    expect(nodeStyle(withWidth(capsule, 1200)).borderRadius).toBe("400px"); // rendered: the margin
  });

  it("asks the degenerate-margin test about the RENDERED box", () => {
    // Margins fit the texture, and they meet the STREAMED width (300+300 >= 600 → dst-degenerate → the stretched
    // background fallback) but NOT the rendered one (600 < 1200), where border-image renders its middle fine.
    const url = "/res/images/packed/common_ui/wide_caps.png";
    setTextureSize(url, 900, 400);
    const wide = mkNode({
      nodeType: "NinePatchRect",
      name: "Image",
      clipChildren: 0,
      ninePatch: true,
      textureUrl: url,
      ninePatchMargins: { left: 300, top: 50, right: 300, bottom: 50 },
      localRect: { x: 0, y: 0, width: 600, height: 300 }
    });
    expect(nodeStyle(withWidth(wide)).backgroundImage).toContain("wide_caps.png"); // streamed: degenerate
    expect(nodeStyle(withWidth(wide, 1200)).backgroundImage).toBeUndefined(); // rendered: not degenerate
  });

  it("lays the ATLAS slice bands out across the rendered box", () => {
    const url = "/res/images/atlas.png";
    setTextureSize(url, 512, 512);
    const atlasNp = mkNode({
      nodeType: "NinePatchRect",
      clipChildren: 0,
      ninePatch: true,
      textureUrl: url,
      textureRegion: { x: 0, y: 0, width: 64, height: 64 },
      ninePatchMargins: { left: 8, top: 8, right: 8, bottom: 8 },
      localRect: { x: 0, y: 0, width: 640, height: 100 }
    });
    const rightCapLeft = (slices: Array<Record<string, string>>): string =>
      slices.filter((sl) => sl.top === "0px").sort((a, b) => parseFloat(a.left) - parseFloat(b.left)).at(-1)!.left;
    expect(rightCapLeft(ninePatchAtlasSlices(atlasNp))).toBe("632px"); // 640 − 8
    expect(rightCapLeft(ninePatchAtlasSlices(atlasNp, 640 + DELTA))).toBe(`${640 + DELTA - 8}px`);
  });
});

describe("nodeStyle relative z-index", () => {
  it("emits the node's OWN (relative) z-index verbatim — the nested DOM lifts the subtree, no composition needed", () => {
    const style = nodeStyle(item(mkNode({ zIndex: 5 })));
    expect(style.zIndex).toBe("5");
  });

  it("omits z-index at local z 0 (keeps DOM/fan order)", () => {
    const style = nodeStyle(item(mkNode({ zIndex: 0 })));
    expect(style.zIndex).toBeUndefined();
    expect(nodeStyle(item(mkNode({ zIndex: null }))).zIndex).toBeUndefined();
  });
});

describe("nodeStyle particle nodes", () => {
  const particleSpec = { kind: "GPUParticles2D" } as unknown as MirrorNode["particleSpec"];

  it("positions a boxless particle node by its transform (synthetic zero-rect) and paints no CSS texture", () => {
    // A GpuParticles2D has no localRect; it must still be placed at its transform so the self-layer sits at the
    // node origin, and its sprite texture must NOT paint as a CSS background (the gsw canvas paints it).
    const style = nodeStyle(
      item(
        mkNode({
          nodeType: "GPUParticles2D",
          ninePatch: false,
          localRect: null,
          transform: [1, 0, 0, 1, 320, 540],
          textureUrl: "/res/images/vfx/common/common_glow.png",
          particleSpec
        })
      )
    );
    expect(style.transform).toBe("matrix(1, 0, 0, 1, 320, 540)");
    expect(style.width).toBe("0px");
    expect(style.height).toBe("0px");
    expect(style.backgroundImage).toBeUndefined();
    expect(style.borderImageSource).toBeUndefined();
  });
});

describe("nodeStyle WebGL shader base paint", () => {
  it("does NOT paint a WebGL shader node's raw texture in CSS (the self-layer canvas is the paint)", () => {
    // card_ripple Highlight: its raw card_frame_sdf must not show as a gray rectangle under the gsw canvas.
    const style = nodeStyle(
      item(
        mkNode({
          nodeType: "NCardHighlight",
          ninePatch: false,
          shaderId: "res://shaders/card_ripple.gdshader",
          textureUrl: "/res/images/packed/card_template/card_frame_sdf.exr"
        })
      )
    );
    expect(style.backgroundImage).toBeUndefined();
    expect(style.borderImageSource).toBeUndefined();
  });

  it("still paints a plain (non-shader) texture in CSS", () => {
    const style = nodeStyle(item(mkNode({ nodeType: "TextureRect", ninePatch: false, textureUrl: "/res/x.png" })));
    expect(style.backgroundImage).toContain("/res/x.png");
  });

  it("still paints an HSV shader node's texture in CSS (HSV renders via filter, not the canvas)", () => {
    const style = nodeStyle(
      item(mkNode({ nodeType: "TextureRect", ninePatch: false, shaderId: "res://shaders/hsv.gdshader", textureUrl: "/res/orb.png" }))
    );
    expect(style.backgroundImage).toContain("/res/orb.png");
  });

  it("renders an atlas-region sprite via a canvas, NOT a CSS background crop (sizes the box to the region)", () => {
    const node = mkNode({
      nodeType: "TextureRect",
      ninePatch: false,
      shaderId: "res://shaders/relic.gdshader",
      textureUrl: "/res/images/atlases/ui_atlas_0.png",
      textureRegion: { x: 0, y: 0, width: 60, height: 60 }
    });
    const style = nodeStyle(item(node));
    // No more full-atlas background crop (it re-decoded the whole page); mirrorRenderer paints a canvas instead.
    expect(style.backgroundImage).toBeUndefined();
    // The element is still sized to the region (the canvas fills it) and gets the keep-aspect-fit transform.
    expect(style.width).toBe("60px");
    expect(style.height).toBe("60px");
    expect(paintsAtlasCanvas(node)).toBe(true);
  });

  it("INTERIOR atlas node keeps the PURE localRect placement (the fit must not cascade to nested children)", () => {
    // The map-legend regression: a keep-aspect atlas parent baked `scale(fit)` into its element transform and
    // every DOM-nested child inherited it. With hasChildren the container keeps the plain placement.
    const node = mkNode({
      nodeType: "TextureRect",
      ninePatch: false,
      textureUrl: "/res/images/atlases/ui_atlas_0.png",
      textureRegion: { x: 0, y: 0, width: 100, height: 100 },
      textureStretchMode: 5,
      transform: [1, 0, 0, 1, 30, 40],
      localRect: { x: 0, y: 0, width: 50, height: 100 }
    });
    const style = nodeStyle(item(node, null, true));
    expect(style.width).toBe("50px");
    expect(style.height).toBe("100px");
    expect(style.transform).toBe("matrix(1, 0, 0, 1, 30, 40)");
  });

  it("atlasCanvasPlacement carries the keep-aspect fit for an interior node's canvas", () => {
    // fit = min(50/100, 100/100) = 0.5; cx = (50 - 100·0.5)/2 = 0; cy = (100 - 100·0.5)/2 = 25.
    const node = mkNode({
      nodeType: "TextureRect",
      ninePatch: false,
      textureUrl: "/res/images/atlases/ui_atlas_0.png",
      textureRegion: { x: 0, y: 0, width: 100, height: 100 },
      textureStretchMode: 5,
      transform: [1, 0, 0, 1, 30, 40],
      localRect: { x: 0, y: 0, width: 50, height: 100 }
    });
    expect(atlasCanvasPlacement(node)).toEqual({
      width: "100px",
      height: "100px",
      transform: "translate(0px, 25px) scale(0.5)"
    });
  });

  it("atlasCanvasPlacement fill mode stretches anisotropically and honors flips", () => {
    const base = {
      nodeType: "TextureRect",
      ninePatch: false,
      textureUrl: "/res/images/atlases/ui_atlas_0.png",
      textureRegion: { x: 0, y: 0, width: 100, height: 50 },
      textureStretchMode: 0,
      transform: [1, 0, 0, 1, 0, 0] as number[],
      localRect: { x: 0, y: 0, width: 200, height: 50 }
    };
    expect(atlasCanvasPlacement(mkNode(base))?.transform).toBe("translate(0px, 0px) scale(2, 1)");
    // flipH: negative x-scale pulls content left of the origin → origin shifts one content-width right.
    expect(atlasCanvasPlacement(mkNode({ ...base, textureFlipH: true }))?.transform).toBe(
      "translate(200px, 0px) scale(-2, 1)"
    );
  });

  // R10-B2: the inverse of the placement above — a node-local point (an authored `pivot_offset`) expressed in the
  // ELEMENT's own coordinate space, which is what a `transform-origin` on that element (or on a self-layer child
  // filling it) is measured in. A pinned rotation loop rotates the paint about this point.
  it("elementLocalPoint maps a node-local pivot into a LEAF atlas node's region-px space", () => {
    // The real top-bar deck icon: a 72×72 Control painting a 114×98 atlas region, keep-aspect (stretch 5).
    // fit = 72/114; cx = 0, cy = (72 − 98·fit)/2 = 5.0526 ⇒ the authored pivot (36, 34) sits at (57, 45.8333).
    const deckIcon = mkNode({
      nodeType: "TextureRect",
      ninePatch: false,
      textureUrl: "/res/images/atlases/ui_atlas_0.png",
      textureRegion: { x: 1920, y: 423, width: 114, height: 98 },
      textureStretchMode: 5,
      transform: [1, 0, 0, 1, 4, 4],
      localRect: { x: 0, y: 0, width: 72, height: 72 }
    });
    const pivot = elementLocalPoint(deckIcon, false, 36, 34);
    expect(pivot.x).toBeCloseTo(57, 6);
    expect(pivot.y).toBeCloseTo(45.8333, 3);
    // Round-trip: the mapped point, pushed back through the fit, is the pivot again.
    const fit = 72 / 114;
    expect(pivot.x * fit).toBeCloseTo(36, 6);
    expect((72 - 98 * fit) / 2 + pivot.y * fit).toBeCloseTo(34, 6);
  });

  it("elementLocalPoint is a no-op for the normal (non-atlas / interior) element box", () => {
    // A plain node's element IS its localRect, so element-local = node-local (minus the rect origin).
    expect(elementLocalPoint(mkNode({ textureRegion: null }), false, 36, 34)).toEqual({ x: 36, y: 34 });
    expect(
      elementLocalPoint(mkNode({ textureRegion: null, localRect: { x: 5, y: 7, width: 72, height: 72 } }), false, 36, 34)
    ).toEqual({ x: 31, y: 27 });
    // An INTERIOR atlas node keeps the pure localRect placement (its canvas carries the fit), so it maps 1:1 too.
    const interior = mkNode({
      nodeType: "TextureRect",
      ninePatch: false,
      textureUrl: "/res/images/atlases/ui_atlas_0.png",
      textureRegion: { x: 0, y: 0, width: 114, height: 98 },
      textureStretchMode: 5,
      localRect: { x: 0, y: 0, width: 72, height: 72 }
    });
    expect(elementLocalPoint(interior, true, 36, 34)).toEqual({ x: 36, y: 34 });
  });

  it("paintsAtlasCanvas is false for non-atlas, nine-patch-atlas, webgl, and particle nodes", () => {
    expect(paintsAtlasCanvas(mkNode({ textureRegion: null }))).toBe(false); // plain texture
    // nine-patch-over-atlas keeps its 9-slice path
    expect(
      paintsAtlasCanvas(mkNode({ ninePatch: true, ninePatchMargins: { left: 4, top: 4, right: 4, bottom: 4 }, textureRegion: { x: 0, y: 0, width: 60, height: 16 } }))
    ).toBe(false);
  });
});

describe("nodeStyle shader-input paint when shaders are OFF (true floor)", () => {
  const OFF: RenderQuality = {
    tier: "minimum",
    shadersEnabled: false,
    shadersStatic: false,
    particlesEnabled: false,
    spineClipsEnabled: false,
    spineClipFps: 0,
    renderScale: 1,
    shaderFps: 0,
    particleFps: 0,
    maxTextureDim: 2048,
    maxTrailPoints: 32,
    staticShaderScale: 1,
    staticParticleScale: 1,
    source: "query"
  };
  afterEach(() => __setRenderQualityForTest(undefined));

  it("suppresses a shader-INPUT texture (SDF) generically — paints nothing, not a gray blob", () => {
    __setRenderQualityForTest(OFF);
    const style = nodeStyle(
      item(
        mkNode({
          nodeType: "NCardHighlight",
          ninePatch: false,
          shaderId: "res://shaders/card_ripple.gdshader",
          textureUrl: "/res/images/packed/card_template/card_frame_sdf.exr"
        })
      )
    );
    expect(style.backgroundImage).toBeUndefined();
  });

  it("still paints a plain (non-shader) texture in CSS even with shaders off", () => {
    __setRenderQualityForTest(OFF);
    const style = nodeStyle(item(mkNode({ nodeType: "TextureRect", ninePatch: false, textureUrl: "/res/x.png" })));
    expect(style.backgroundImage).toContain("/res/x.png");
  });
});

describe("nodePaintsContent", () => {
  const text = () => ({
    text: "hi",
    colorHtml: null,
    fontSizePx: null,
    halign: null,
    valign: null,
    outlineColorHtml: null,
    outlineSize: 0
  });

  it("is true for a painting texture node (the mkNode default is a nine-patch sprite)", () => {
    expect(nodePaintsContent(mkNode(), 1)).toBe(true);
  });

  it("is true for a text node with no texture", () => {
    expect(nodePaintsContent(mkNode({ textureUrl: null, ninePatch: false, text: text() }), 1)).toBe(true);
  });

  it("is true for a visible fill color and false for a fully-transparent one", () => {
    const fill = (a: number) => ({ r: 1, g: 0, b: 0, a, html: "#ff0000" });
    expect(nodePaintsContent(mkNode({ textureUrl: null, ninePatch: false, fillColor: fill(1) }), 1)).toBe(true);
    expect(nodePaintsContent(mkNode({ textureUrl: null, ninePatch: false, fillColor: fill(0) }), 1)).toBe(false);
  });

  it("is false for a pure container (no texture / text / fill)", () => {
    expect(nodePaintsContent(mkNode({ textureUrl: null, ninePatch: false }), 1)).toBe(false);
  });

  it("is false for a particle-only emitter (its sprite paints via the gsw canvas, not own content)", () => {
    const particleNode = mkNode({
      textureUrl: null,
      ninePatch: false,
      particleSpec: {} as unknown as MirrorNode["particleSpec"]
    });
    expect(nodePaintsContent(particleNode, 1)).toBe(false);
  });

  it("is false for a clip-only (1) node — it clips but paints nothing itself", () => {
    expect(nodePaintsContent(mkNode({ clipChildren: 1 }), 1)).toBe(false);
  });

  it("is false when the node is faded to nothing (effectiveOpacity ≤ ~0.02)", () => {
    expect(nodePaintsContent(mkNode(), 0.01)).toBe(false);
  });
});

describe("textStyle outline", () => {
  const textNode = (over: Partial<MirrorNode["text"] & object> = {}, outline: MirrorNode["outline"] = null) =>
    mkNode({
      nodeType: "Label",
      text: {
        text: "130/130",
        colorHtml: "#ffffff",
        fontSizePx: 24,
        halign: "center",
        valign: "center",
        outlineColorHtml: null,
        outlineSize: 0,
        ...over
      },
      outline
    });

  it("prefers the per-tick text-diagnostics outline (runtime recolor) over the stale top-level outline", () => {
    // HP label while BLOCKING: the game recolors the outline blue; the stale top-level field is still red.
    const style = textStyle(textNode({ outlineColorHtml: "#1b3045", outlineSize: 16 }, { colorHtml: "#900000", size: 16 }));
    expect(style.webkitTextStroke).toContain("#1b3045");
    expect(style.webkitTextStroke).not.toContain("#900000");
    expect(style.paintOrder).toBe("stroke fill");
  });

  it("falls back to node.outline when the text diagnostics carry no outline", () => {
    const style = textStyle(textNode({}, { colorHtml: "#900000", size: 16 }));
    expect(style.webkitTextStroke).toContain("#900000");
  });

  it("emits no stroke when neither source has an outline", () => {
    const style = textStyle(textNode());
    expect(style.webkitTextStroke).toBeUndefined();
  });

  // WS-TEXT v4: the streamed base px is exposed as --godot-font-px so generated declarations can re-derive the scaled
  // size and cap it (End Turn). The primary font-size calc is unchanged (purely additive).
  it("exposes the streamed base px as --godot-font-px for per-label font-size caps", () => {
    const style = textStyle(textNode({ fontSizePx: 30 }));
    expect(style.fontSize).toBe("calc(30px * var(--godot-text-scale, 1))");
    expect(style["--godot-font-px"]).toBe("30px");
  });
});

// Issue #20b — `justify-content` only places the flex ITEM, which does nothing for RICH text (gsw's
// `.godot-rich-stack` is width:100%, so the item fills the box and the glyphs stay left) and nothing for a WRAPPED
// plain label (a stretched item left-packs its lines inside a "centred" block). `textStyle` therefore also emits
// `text-align` from the streamed halign, matching the native client's `HorizontalAlignment = MapHalign(...)`.
describe("textStyle horizontal alignment", () => {
  const alignedNode = (halign: string | null, over: Partial<MirrorNode> = {}) =>
    mkNode({
      nodeType: over.richText ? "RichTextLabel" : "Label",
      text: {
        text: "Waiting for other players...",
        colorHtml: "#ffffff",
        fontSizePx: 24,
        halign,
        valign: "center",
        outlineColorHtml: null,
        outlineSize: 0
      },
      ...over
    });

  it("centers a RICH label the game centers (the char-select waiting text / rest-site description)", () => {
    const style = textStyle(alignedNode("Center", { richText: true }));
    expect(style.textAlign).toBe("center");
    expect(style.justifyContent).toBe("center"); // the flex placement is unchanged
  });

  it("centers a PLAIN label too, so a wrapped one centers per line like Godot", () => {
    const style = textStyle(alignedNode("Center"));
    expect(style.textAlign).toBe("center");
  });

  it("maps Right (and its `end` synonym) to text-align: right", () => {
    expect(textStyle(alignedNode("Right", { richText: true })).textAlign).toBe("right");
    expect(textStyle(alignedNode("end")).textAlign).toBe("right");
  });

  it("maps Godot's Fill alignment to justified text", () => {
    expect(textStyle(alignedNode("Fill", { richText: true })).textAlign).toBe("justify");
  });

  // Left is the rendered default AND the value the per-scene mirrorTextScale rules (End Turn, reward rows) set
  // `text-align` on the node element for — emitting an inline `left` would clobber them on their own labels.
  it("emits NOTHING for Left or an unstreamed alignment", () => {
    expect(textStyle(alignedNode("Left")).textAlign).toBeUndefined();
    expect(textStyle(alignedNode("Left", { richText: true })).textAlign).toBeUndefined();
    expect(textStyle(alignedNode(null)).textAlign).toBeUndefined();
    expect(textStyle(alignedNode("")).textAlign).toBeUndefined();
  });

  it("is case-insensitive about the streamed enum spelling", () => {
    expect(textStyle(alignedNode("center")).textAlign).toBe("center");
    expect(textStyle(alignedNode("CENTER")).textAlign).toBe("center");
  });

  // The vertical alignment has no `text-align` analog — it must not leak into the horizontal one.
  it("ignores the VERTICAL alignment", () => {
    const node = alignedNode(null);
    node.text!.valign = "center";
    expect(textStyle(node).textAlign).toBeUndefined();
  });
});

// Godot renders a `[b]` span by SWAPPING the label to its `bold_font` theme item (a different .ttf), never by
// synthesising — so the producer streams the role's font/size/spacing and textStyle publishes them as the
// `--godot-rich-*` variables godot-scene-web's `.godot-rich-bold` / `-italic` / `-bold-italic` rules read.
describe("textStyle rich-text per-role font variables", () => {
  const richNode = (over: Partial<MirrorNode> = {}, fontSizePx: number | null = 24) =>
    mkNode({
      nodeType: "RichTextLabel",
      richText: true,
      text: {
        text: "[b]Ancient[/b] shrine",
        colorHtml: "#ffffff",
        fontSizePx,
        halign: "left",
        valign: "top",
        outlineColorHtml: null,
        outlineSize: 0
      },
      ...over
    });

  const font = (family: string) => ({ family, url: `/res/fonts/${family}.ttf`, weight: null, style: null });

  it("publishes the role FAMILY variable for every streamed role font", () => {
    const style = textStyle(
      richNode({
        richBoldFont: font("kreon_bold"),
        richItalicFont: font("kreon_italic"),
        richBoldItalicFont: font("kreon_bold_italic")
      })
    );
    expect(style["--godot-rich-bold-font-family"]).toBe('"kreon_bold", sans-serif');
    expect(style["--godot-rich-italic-font-family"]).toBe('"kreon_italic", sans-serif');
    expect(style["--godot-rich-bold-italic-font-family"]).toBe('"kreon_bold_italic", sans-serif');
  });

  it("publishes the role SIZE as a ratio of the node's own streamed size (never absolute px)", () => {
    // The producer streams 21px for the bold role on a 24px label → 0.875em, so the span still rides
    // --godot-text-scale through the element's own font-size instead of pinning itself at 21 CSS px.
    const style = textStyle(richNode({ richBoldFontSizePx: 21 }, 24));
    expect(style["--godot-rich-bold-font-size"]).toBe("calc(1em * 0.875)");
    expect(style["--godot-rich-bold-font-size"]).not.toContain("px");
  });

  it("publishes the role glyph SPACING in px", () => {
    const style = textStyle(
      richNode({ richBoldFontSpacingPx: 1, richItalicFontSpacingPx: 2, richBoldItalicFontSpacingPx: 3 })
    );
    expect(style["--godot-rich-bold-letter-spacing"]).toBe("1px");
    expect(style["--godot-rich-italic-letter-spacing"]).toBe("2px");
    expect(style["--godot-rich-bold-italic-letter-spacing"]).toBe("3px");
  });

  it("emits ONLY the variables the producer actually streamed", () => {
    // Bold face but no bold size/spacing (the common case: same size, unspaced variation).
    const style = textStyle(richNode({ richBoldFont: font("kreon_bold") }));
    expect(style["--godot-rich-bold-font-family"]).toBe('"kreon_bold", sans-serif');
    expect(style["--godot-rich-bold-font-size"]).toBeUndefined();
    expect(style["--godot-rich-bold-letter-spacing"]).toBeUndefined();
    expect(style["--godot-rich-italic-font-family"]).toBeUndefined();
    expect(style["--godot-rich-bold-italic-font-family"]).toBeUndefined();
  });

  it("emits nothing for a rich label the producer streamed no role data for (old recordings)", () => {
    const style = textStyle(richNode());
    for (const key of Object.keys(style)) {
      expect(key.startsWith("--godot-rich-bold")).toBe(false);
      expect(key.startsWith("--godot-rich-italic")).toBe(false);
    }
  });

  it("skips the ratio when the node has no streamed font size to divide by", () => {
    const style = textStyle(richNode({ richBoldFontSizePx: 21 }, null));
    expect(style["--godot-rich-bold-font-size"]).toBeUndefined();
  });

  it("emits no role variables on a PLAIN (non-rich) label", () => {
    const style = textStyle(richNode({ richText: false, richBoldFont: font("kreon_bold") }));
    expect(style["--godot-rich-bold-font-family"]).toBeUndefined();
  });
});

describe("splitAnimStyle", () => {
  it("routes the texture PAINT to the child and keeps positioning/tint/blend on the parent", () => {
    // A frozen energy-orb layer's computed style: baked matrix + a plain texture background + a tint filter.
    const full: Record<string, string> = {
      left: "0px",
      top: "0px",
      width: "128px",
      height: "128px",
      transform: "matrix(0.999, 0.041, -0.041, 0.999, 101, 825)",
      transformOrigin: "0px 0px",
      opacity: "1",
      zIndex: "3",
      filter: "url(#mtint-1)",
      mixBlendMode: "plus-lighter",
      backgroundImage: 'url("/res/images/ui/combat/energy_orb.png")',
      backgroundColor: "rgba(0, 0, 0, 0)",
      backgroundSize: "100% 100%"
    };
    const { container, paint } = splitAnimStyle(full);

    // The child (which spins) carries only the paint, so the CSS rotation rotates the texture.
    expect(paint).toEqual({
      backgroundImage: 'url("/res/images/ui/combat/energy_orb.png")',
      backgroundColor: "rgba(0, 0, 0, 0)",
      backgroundSize: "100% 100%"
    });
    // The parent keeps positioning (so el still places it via the baked matrix) + the cascading tint/blend.
    expect(container.transform).toBe("matrix(0.999, 0.041, -0.041, 0.999, 101, 825)");
    expect(container.filter).toBe("url(#mtint-1)");
    expect(container.mixBlendMode).toBe("plus-lighter");
    expect(container.width).toBe("128px");
    // Paint keys must NOT leak back onto the parent (else the frozen texture double-paints, static, under the spin).
    expect(container.backgroundImage).toBeUndefined();
  });
});

// THE SHADERS-OFF STAND-IN. A card highlight's own texture is shader INPUT (the card SDF), so nodeStyle
// deliberately paints NOTHING for it — and with shaders off there is no canvas either, which is the gap the baked
// still fills. See bakedEffects.ts; the still's own selection rules are pinned by bakedEffects.spec.ts.
describe("nodeStyle baked effect stills", () => {
  const RIPPLE_SHADER = "res://shaders/card_ripple.gdshader";

  function highlight(width: number): MirrorNode {
    return mkNode({
      nodeType: "MegaCrit.Sts2.Core.Nodes.Cards.NCardHighlight",
      shaderId: RIPPLE_SHADER,
      shaderParams: [{ name: "width", kind: "number", number: width }] as MirrorNode["shaderParams"],
      textureUrl: "/res/images/packed/card_template/card_frame_sdf.exr",
      textureStretchMode: 5,
      ninePatch: false,
      ninePatchMargins: null,
      localRect: { x: 0, y: 0, width: 759, height: 951 }
    });
  }

  afterEach(() => {
    mirrorSettings.shaderMode = "static";
  });

  it("paints the still, additively, and never the raw SDF", () => {
    mirrorSettings.shaderMode = "off";
    const style = nodeStyle(item(highlight(0.075)));

    expect(style.backgroundImage).toMatch(/card-ripple/);
    expect(style.backgroundSize).toBe("100% 100%");
    // `blend_add` in the game, and the shader — not a material — is what declares it, so nothing streams it.
    expect(style.mixBlendMode).toBe("plus-lighter");
    // The SDF must never appear: it is a meaningless grey blob without its shader.
    expect(style.backgroundImage).not.toContain("card_frame_sdf");
  });

  it("leaves the node's own tint filter alone, because that filter IS the glow's colour", () => {
    // The still is baked NEUTRAL; the mirror's existing per-node modulate multiply turns it cyan / gold / red.
    // A second tint here would square the colour.
    mirrorSettings.shaderMode = "off";
    const style = nodeStyle({ ...item(highlight(0.075)), tintId: "0_243_251" });

    expect(style.filter).toBe("url(#mtint-0_243_251)");
  });

  it("paints nothing at all while the game has the ripple hidden", () => {
    mirrorSettings.shaderMode = "off";
    const style = nodeStyle(item(highlight(0)));

    expect(style.backgroundImage).toBeUndefined();
  });

  it("paints nothing while a mode that renders the real shader is selected", () => {
    mirrorSettings.shaderMode = "static";
    expect(nodeStyle(item(highlight(0.075))).backgroundImage).toBeUndefined();
  });
});
