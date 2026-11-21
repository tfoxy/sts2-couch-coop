// Open the horizontal clip around enlarged options, using the same identity table as the mirror.

import type { RenderStreamExtension } from "@godot-scene-web/render-stream-client";

import { resolveClipAxisOutset } from "@/mirror/clipAxis";

export function createClipAxisExtension(): RenderStreamExtension {
  const desired = new Map<number, number>();
  const applied = new Set<number>();
  let dirty = true;

  return {
    id: "couchcoop.clipAxis",
    wants: { fields: ["scene", "path"] },
    onItemMeta(batch) {
      if (batch.form === "full") desired.clear();
      for (const item of batch.items) {
        const path = item.path === "." ? "" : (item.path ?? null);
        const outset = resolveClipAxisOutset(item.scene ?? null, path);
        if (outset === null) desired.delete(item.id);
        else desired.set(item.id, outset);
      }
      dirty = true;
    },
    onItemsRemoved(ids) {
      for (const id of ids) desired.delete(id);
      dirty = true;
    },
    beforeDraw(frame) {
      if (!dirty) return;
      dirty = false;
      for (const id of applied) {
        if (!desired.has(id)) {
          frame.overrides.clear(id);
          applied.delete(id);
        }
      }
      for (const [id, outset] of desired) {
        frame.overrides.set(id, { clipOutset: [outset, 0, outset, 0] });
        applied.add(id);
      }
    },
    dispose() {
      desired.clear();
      applied.clear();
      dirty = false;
    }
  };
}
