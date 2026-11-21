import type {
  Affine2D, ItemMeta, ItemQuery, RenderStreamExtension
} from "@godot-scene-web/render-stream-client";

import { flameFlickerPose, flamePhaseMs, nodeAnimBinding, spinDurationMs } from "@/mirror/animAttributes";

type Binding = { kind: "ring"; period: number } | { kind: "flame" };

/** Only the seat-frozen animators. The gate also requires the seat's effective freeze report. */
export function createDecorExtension(): RenderStreamExtension & { resetClocks(): void } {
  const metadata = new Map<number, ItemMeta>();
  const bindings = new Map<number, Binding>();
  const starts = new Map<number, number>();
  const written = new Set<number>();
  const removed = new Set<number>();

  function forget(id: number) {
    metadata.delete(id);
    bindings.delete(id);
    starts.delete(id);
    if (written.delete(id)) removed.add(id);
  }

  function fireRoot(id: number, query: ItemQuery): number | null {
    for (let parent = query.parent(id); parent !== null; parent = query.parent(parent)) {
      if (metadata.get(parent)?.script?.endsWith("/NRestSiteFireVfx.cs")) return parent;
    }
    return null;
  }

  return {
    id: "couchcoop.decor",
    wants: { fields: ["path", "scene", "script"] },
    resetClocks() { starts.clear(); },
    onSession() {
      metadata.clear(); bindings.clear(); starts.clear(); written.clear(); removed.clear();
    },
    onItemMeta(batch) {
      if (batch.form === "full") {
        const keep = new Set(batch.items.map((item) => item.id));
        for (const id of metadata.keys()) if (!keep.has(id)) forget(id);
      }
      for (const item of batch.items) {
        const old = metadata.get(item.id);
        if (old && (old.path !== item.path || old.scene !== item.scene || old.script !== item.script)) forget(item.id);
        metadata.set(item.id, item);
        const path = item.path ?? "";
        const period = spinDurationMs(path);
        // Stars and intents keep their native motion. A matching leaf name alone is insufficient.
        if (item.node && item.scene?.endsWith("_energy_counter.tscn") && /(?:^|\/)Layers\/RotationLayers\/Layer\d+$/.test(path) && period !== null) {
          bindings.set(item.id, { kind: "ring", period });
        } else if (item.node && nodeAnimBinding(path, null)?.kind === "flameFlicker") {
          bindings.set(item.id, { kind: "flame" });
        }
      }
    },
    onItemsRemoved(ids) { for (const id of ids) forget(id); },
    beforeDraw(frame) {
      for (const id of removed) frame.overrides.clear(id);
      removed.clear();
      let visible = false;
      for (const [id, binding] of bindings) {
        if (!frame.query.visible(id)) continue;
        const rect = frame.query.rect(id);
        if (!rect || rect.w <= 0 || rect.h <= 0) continue;
        const root = binding.kind === "flame" ? fireRoot(id, frame.query) : id;
        if (root === null) continue;
        let start = starts.get(root);
        if (start === undefined) starts.set(root, start = frame.now);
        const elapsed = frame.now - start;
        let a: number, b: number, c: number, d: number;
        const x = rect.x + rect.w / 2;
        const y = binding.kind === "ring" ? rect.y + rect.h / 2 : rect.y + rect.h;
        if (binding.kind === "ring") {
          const angle = 2 * Math.PI * elapsed / binding.period;
          a = d = Math.cos(angle); b = Math.sin(angle); c = -b;
        } else {
          const phase = flamePhaseMs(String(root));
          const initial = flameFlickerPose(0, phase);
          const pose = flameFlickerPose(elapsed, phase);
          a = 1; b = 0; d = pose.scaleY / initial.scaleY;
          c = Math.tan(pose.skew - initial.skew) * d;
        }
        // A delta over the captured pose: identity at the first frame, with the item's own pivot fixed.
        const transform: Affine2D = [a, b, c, d, x - a * x - c * y, y - b * x - d * y];
        frame.overrides.set(id, { transform });
        written.add(id);
        visible = true;
      }
      if (visible) frame.requestRedraw();
    },
    dispose() { metadata.clear(); bindings.clear(); starts.clear(); written.clear(); removed.clear(); }
  };
}
