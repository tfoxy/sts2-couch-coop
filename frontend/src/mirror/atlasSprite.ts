// Resolving ONE of the game's AtlasTexture resources into something CouchCoop's own chrome can paint with.
//
// The mirror draws a couple of client-only widgets — the confirm-tap button, the readable-hand toggle — out of the
// game's own art so they read as part of the HUD rather than as a web overlay stuck on top of it. Each needs the
// same two facts about a `res://…/*.tres` AtlasTexture: which page image it lives on, and which sub-rect of that
// page to show. Both are RESOLVED at runtime from the .tres rather than hardcoded, because a repack moves them.
//
// The `/res/` route serves resource documents as RAW Godot text (Godot-native-first), which is exactly what gsw's
// parser reads — no `?format=json` here.

import { asRect2, asResourceRef, type GodotVariant } from "@godot-scene-web/core";
import { regionBackgroundStyle } from "@godot-scene-web/html";
import { parseGodotResource } from "@godot-scene-web/tscn-parser";

import { hostUrl } from "@/join/hostBase";
import { resourceRoute } from "@/protocol/browserResources";

export interface AtlasSpriteRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One resolved AtlasTexture: the atlas PAGE url plus the sub-rect (and Godot margin) to draw out of it. */
export interface AtlasSprite {
  pageUrl: string;
  region: AtlasSpriteRect;
  margin: AtlasSpriteRect;
}

const ZERO_RECT: AtlasSpriteRect = { x: 0, y: 0, width: 0, height: 0 };

/** Fetch one AtlasTexture `.tres` and pull out its page + rects. Rejects when the route or the document fails. */
export async function resolveAtlasSprite(resourcePath: string): Promise<AtlasSprite> {
  const response = await fetch(hostUrl(resourceRoute(resourcePath)), {
    headers: { accept: "text/plain" }
  });
  if (!response.ok) {
    throw new Error(`atlas sprite ${resourcePath}: HTTP ${response.status}`);
  }
  const doc = parseGodotResource(await response.text());
  const region = asRect2(doc.properties.region);
  if (!region) {
    throw new Error(`atlas sprite ${resourcePath}: no region`);
  }
  const pagePath = extResourcePath(doc.extResources, doc.properties.atlas);
  if (!pagePath) {
    throw new Error(`atlas sprite ${resourcePath}: no atlas page`);
  }
  return {
    pageUrl: hostUrl(resourceRoute(pagePath)),
    region,
    margin: asRect2(doc.properties.margin) ?? ZERO_RECT
  };
}

/** Godot `TextureRect.StretchMode` — the two CouchCoop's own sprite-built widgets use. */
export const STRETCH_SCALE = 0;
export const STRETCH_KEEP_ASPECT_CENTERED = 5;

/**
 * The crop numbers that make the sprite's REGION exactly fill an element of `size` — no margin, so the element and
 * the drawn texture are the same rect and nothing outside the region can be sampled (see atlasSpriteLayout).
 */
export function atlasRegionBackground(
  sprite: AtlasSprite,
  size: { width: number; height: number },
  atlasSize?: { width: number; height: number }
): { backgroundPosition: string; backgroundSize: string } {
  return regionBackgroundStyle(sprite.region, { atlasSize, box: size, stretchMode: STRETCH_SCALE });
}

/** Where a sprite's REGION lands inside a box, and how to paint exactly that rect and nothing else. */
export interface AtlasSpriteLayout {
  left: number;
  top: number;
  width: number;
  height: number;
  backgroundPosition: string;
  backgroundSize: string;
}

/**
 * Lay one sprite out inside `box` the way Godot's TextureRect would, as a rect to paint the region into.
 *
 * WHY IT IS A RECT AND NOT JUST A BACKGROUND. A Godot AtlasTexture is `region` drawn at `margin.position` inside a
 * logical texture of `region.size + margin.size` — the margin is TRANSPARENT padding the atlas packer trimmed off
 * a sprite that did not fill its own box. A CSS background-image, though, is the whole atlas PAGE: the margin band
 * has no transparency of its own there, it has the NEIGHBOURING sprite's pixels. So mapping the logical texture
 * onto the element (what `regionBackgroundStyle` does, correctly, for a real TextureRect) paints the neighbours in
 * the margin bands — and a CSS background cannot be clipped to a sub-rect to stop it.
 *
 * The fix is not a clip but a smaller element: size the paint element to the REGION's own destination rect and map
 * the region alone (no margin) onto it. What Godot leaves transparent, we simply do not paint. `regionBackground-
 * Style` still does all the crop maths.
 *
 * `atlasSize` is the PAGE's natural size. Undefined until the image loads, in which case gsw falls back to native
 * atlas pixels — the rect is still right, so the layer only mis-crops until the page's size is known.
 */
export function atlasSpriteLayout(
  sprite: AtlasSprite,
  box: { width: number; height: number },
  stretchMode: number,
  atlasSize?: { width: number; height: number }
): AtlasSpriteLayout {
  const texWidth = sprite.region.width + sprite.margin.width;
  const texHeight = sprite.region.height + sprite.margin.height;
  const paint = (left: number, top: number, width: number, height: number): AtlasSpriteLayout => ({
    left,
    top,
    width,
    height,
    ...atlasRegionBackground(sprite, { width, height }, atlasSize)
  });
  if (texWidth <= 0 || texHeight <= 0 || box.width <= 0 || box.height <= 0) {
    return paint(0, 0, box.width, box.height);
  }
  if (stretchMode === STRETCH_KEEP_ASPECT_CENTERED) {
    const scale = Math.min(box.width / texWidth, box.height / texHeight);
    return paint(
      (box.width - texWidth * scale) / 2 + sprite.margin.x * scale,
      (box.height - texHeight * scale) / 2 + sprite.margin.y * scale,
      sprite.region.width * scale,
      sprite.region.height * scale
    );
  }
  // StretchMode.Scale: the logical texture fills the box, independently per axis.
  const scaleX = box.width / texWidth;
  const scaleY = box.height / texHeight;
  return paint(
    sprite.margin.x * scaleX,
    sprite.margin.y * scaleY,
    sprite.region.width * scaleX,
    sprite.region.height * scaleY
  );
}

// An `ExtResource("n")` property → the res:// path it names. The parser gives the ref (id and/or path) and the
// document's own ext-resource table; a .tres written with an inline path needs no lookup.
function extResourcePath(
  extResources: readonly { id: string; path?: string }[],
  value: GodotVariant | undefined
): string | null {
  const ref = asResourceRef(value);
  if (!ref) {
    return null;
  }
  if (ref.path) {
    return ref.path;
  }
  const entry = extResources.find((res) => res.id === ref.id);
  return entry?.path ?? null;
}
