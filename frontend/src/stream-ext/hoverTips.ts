// Hover tips under uiScaling: rigid panel scaling only; the stream cannot reproduce the mirror's text reflow.
// Custom metadata is resolved once by capture; the seat publishes the owner synchronously before creation returns.

import type { ExtensionFrame, ItemMeta, ItemQuery, Rect, RenderStreamExtension } from "@godot-scene-web/render-stream-client";

import { computeHoverTipScale, HOVER_TIP_SCALE, resolveTipOwnerKind } from "@/mirror/hoverTipScaleMath";
import { designAabbOf } from "@/mirror/viewScaleLayout";
import { scaleStampAffine } from "@/stream-ext/viewScale";
import { RS_GROUP_HOVER_TIP } from "@/stream-ext/groups";

export const TIP_OWNER_META_KEY = "couchcoop_rs_tip_owner";
export const TIP_OWNER_SIZE_META_KEY = "couchcoop_rs_tip_owner_size";

export interface HoverTipsModule {
  readonly extension: RenderStreamExtension;
  /** The exact anchor owner, never inferred from proximity or hit testing. */
  ownerOf(tipId: number): ItemMeta | null;
}

export function createHoverTipsModule(options: { readonly designWidth: number } = { designWidth: 1920 }): HoverTipsModule {
  const items = new Map<number, ItemMeta>();
  const instances = new Map<string, ItemMeta>();
  const tips = new Set<number>();
  const stamped = new Set<number>();
  let dirty = true;
  let lastSeq: number | null = null;

  function remove(id: number): void {
    const old = items.get(id);
    if (old?.instanceId && instances.get(old.instanceId)?.id === id) instances.delete(old.instanceId);
    items.delete(id);
    tips.delete(id);
  }

  function ownerOf(tipId: number): ItemMeta | null {
    if (!tips.has(tipId)) return null;
    const instance = items.get(tipId)?.meta[TIP_OWNER_META_KEY];
    return instance ? instances.get(instance) ?? null : null;
  }

  function apply(frame: ExtensionFrame, id: number): boolean {
    if (!frame.query.visible(id)) return false;
    const boxes: Rect[] = [];
    for (const child of frame.query.children(id)) {
      if (!frame.query.visible(child)) continue;
      const box = frame.query.rect(child) ?? frame.query.subtreeRect(child);
      if (box && box.w > 0 && box.h > 0) boxes.push(box);
    }
    const owner = ownerOf(id);
    const visual = owner ? visualOwner(owner.id, frame.query, ownerSize(items.get(id)?.meta[TIP_OWNER_SIZE_META_KEY])) : null;
    const raw = visual?.box ?? null;
    const mapped = raw && visual !== null
      ? designAabbOf(frame.overrides.effective(visual.id), { x: raw.x, y: raw.y, width: raw.w, height: raw.h })
      : null;
    const kind = resolveTipOwnerKind(owner?.script?.split("/").pop()?.replace(/\.cs$/, "") ?? null, owner?.scene ?? null);
    const stamp = computeHoverTipScale(boxes, options.designWidth, mapped, kind,
      raw && mapped ? mapped.x + mapped.w / 2 - (raw.x + raw.w / 2) : 0,
      raw && mapped ? mapped.y + mapped.h / 2 - (raw.y + raw.h / 2) : 0);
    if (!stamp) return false;
    frame.overrides.set(id, {
      transform: scaleStampAffine(HOVER_TIP_SCALE, stamp.pivotX, stamp.pivotY, stamp.offsetX, stamp.offsetY)
    });
    return true;
  }

  const extension: RenderStreamExtension = {
    id: "couchcoop.hoverTips",
    wants: {
      fields: ["scene", "path", "script", "instance_id"],
      groups: [RS_GROUP_HOVER_TIP],
      metaKeys: [TIP_OWNER_META_KEY, TIP_OWNER_SIZE_META_KEY]
    },
    onItemMeta(batch) {
      if (batch.form === "full") { items.clear(); instances.clear(); tips.clear(); }
      dirty = true;
      for (const item of batch.items) {
        remove(item.id);
        items.set(item.id, item);
        if (item.instanceId) instances.set(item.instanceId, item);
        if (item.groups.includes(RS_GROUP_HOVER_TIP)) tips.add(item.id);
      }
    },
    onItemsRemoved(ids) { for (const id of ids) remove(id); dirty = true; },
    beforeDraw(frame) {
      // Input modules may move owners on a redraw without a transaction (seq null).
      if (!dirty && frame.seq !== null && frame.seq === lastSeq) return;
      dirty = false;
      lastSeq = frame.seq;
      for (const id of stamped) {
        if (!tips.has(id)) { frame.overrides.clear(id); stamped.delete(id); }
      }
      for (const id of tips) {
        if (apply(frame, id)) stamped.add(id);
        else if (stamped.delete(id)) frame.overrides.clear(id);
      }
    },
    dispose() { items.clear(); instances.clear(); tips.clear(); stamped.clear(); }
  };
  return { extension, ownerOf };
}

interface OwnerSize { width: number; height: number }

function ownerSize(value: string | null | undefined): OwnerSize | null {
  if (!value) return null;
  try {
    const size: unknown = JSON.parse(value);
    if (Array.isArray(size) && size.length === 2 && size.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) {
      return { width: size[0], height: size[1] };
    }
  } catch { /* Missing/malformed metadata falls back to the available draw bounds. */ }
  return null;
}

// A positive-width Control is its own visual owner, including an undrawn hitbox. Only zero-size
// holders fall through to the first visible painting descendant; rect() measures draw commands alone.
function visualOwner(id: number, query: ItemQuery, size: OwnerSize | null = null): { id: number; box: Rect } | null {
  if (!query.visible(id)) return null;
  if (size && size.width > 0) {
    const transform = query.transform(id);
    return transform ? { id, box: designAabbOf(transform, { x: 0, y: 0, ...size }) } : null;
  }
  const box = size === null ? query.rect(id) : null;
  if (box && box.w > 0 && box.h > 0) return { id, box };
  for (const child of query.children(id)) {
    const visual = visualOwner(child, query);
    if (visual !== null) return visual;
  }
  return null;
}
