import { RustAtlasPages } from "@godot-scene-web/canvas/atlas-pages";
import type { RustResourceUpdate } from "@godot-scene-web/canvas/rust-prototype";
import type { MsdfGlyphTile } from "@godot-scene-web/canvas/msdf-generator";
import type { MsdfPlacement } from "./msdf";

const PAGE_SIDE = 1024;
const PAGE_LIMIT = 4;
const UPLOAD_BYTE_LIMIT = 256 * 1024;

type Page = { key: string; x: number; y: number; rowHeight: number };
type Work = { keys: readonly string[]; tiles: readonly MsdfGlyphTile[]; index: number;
  done(reason?: string): void };

/** Owns GPU-ready glyph positions; a tile becomes visible only after its subrect upload succeeds. */
export class MsdfAtlas {
  private residency = new RustAtlasPages(PAGE_LIMIT * PAGE_SIDE * PAGE_SIDE * 4);
  private readonly pages = new Map<string, Page>();
  private readonly glyphs = new Map<string, MsdfPlacement>();
  private readonly failures = new Map<string, string>();
  private readonly work: Work[] = [];
  private nextPage = 0;
  private uploadCalls = 0;
  private uploadBytes = 0;
  private uploadOverruns = 0;
  private allocations = 0;

  placement(key: string): MsdfPlacement | undefined { return this.glyphs.get(key); }
  hasPage(key: string): boolean { return this.pages.has(key); }
  failure(key: string): string | undefined { return this.failures.get(key); }
  hasWork(): boolean { return this.work.length > 0; }
  enqueue(keys: readonly string[], tiles: readonly MsdfGlyphTile[], done: Work["done"]): void {
    if (keys.length !== tiles.length) throw new Error("MSDF tile/key count mismatch");
    this.work.push({ keys, tiles, index: 0, done });
  }

  private fit(page: Page, tile: MsdfGlyphTile): { x: number; y: number; next: Page } | null {
    if (tile.width > PAGE_SIDE || tile.height > PAGE_SIDE) return null;
    const wrapped = page.x + tile.width > PAGE_SIDE;
    const x = wrapped ? 0 : page.x;
    const y = wrapped ? page.y + page.rowHeight : page.y;
    if (y + tile.height > PAGE_SIDE) return null;
    return { x, y, next: { key: page.key, x: x + tile.width, y,
      rowHeight: Math.max(wrapped ? 0 : page.rowHeight, tile.height) } };
  }

  /** One event-driven upload frame. The caller serializes this with scene admission/present. */
  flush(upload: (updates: readonly RustResourceUpdate[]) => void, pinned: Iterable<string>):
    { ready: number; more: boolean; uploadedBytes: number; allocations: number } {
    this.residency.pin(pinned);
    const started = performance.now();
    let frameBytes = 0, frameAllocations = 0, ready = 0;
    while (this.work.length) {
      const item = this.work[0];
      const tile = item.tiles[item.index];
      const key = item.keys[item.index];
      if (!tile || !key) { item.done(); this.work.shift(); continue; }
      if (tile.pixels.byteLength > UPLOAD_BYTE_LIMIT || tile.pixels.byteLength !== tile.width * tile.height * 4) {
        this.reject(item, "invalid-tile"); continue;
      }
      if (frameBytes + tile.pixels.byteLength > UPLOAD_BYTE_LIMIT ||
          (frameBytes > 0 && performance.now() - started >= 1)) break;
      if (!tile.width || !tile.height) {
        this.glyphs.set(key, { glyphId: tile.glyphId, pageKey: "", pageSize: PAGE_SIDE,
          src: [0, 0, 0, 0], left: tile.left, top: tile.top });
        item.index++; ready++; continue;
      }
      let selected: { page: Page; fit: NonNullable<ReturnType<MsdfAtlas["fit"]>> } | null = null;
      for (const page of this.pages.values()) {
        const fit = this.fit(page, tile);
        if (fit) { selected = { page, fit }; break; }
      }
      if (!selected) {
        if (frameAllocations >= 1) break;
        const page: Page = { key: `msdf:atlas:${++this.nextPage}`, x: 0, y: 0, rowHeight: 0 };
        const plan = (() => { try { return this.residency.reserve(page.key, PAGE_SIDE, PAGE_SIDE); }
          catch { return null; } })();
        if (!plan) { this.reject(item, "atlas-full"); continue; }
        try {
          upload([...plan.evicted.map((key): RustResourceUpdate => ({ operation: "release", key })),
            { operation: "allocate", key: page.key, width: PAGE_SIDE, height: PAGE_SIDE, format: "linear" }]);
          this.residency.commit(plan);
          for (const victim of plan.evicted) {
            this.pages.delete(victim);
            for (const [glyphKey, placement] of this.glyphs)
              if (placement.pageKey === victim) this.glyphs.delete(glyphKey);
          }
          this.pages.set(page.key, page);
          this.allocations++; frameAllocations++;
          if (performance.now() - started >= 1) break;
          selected = { page, fit: this.fit(page, tile)! };
        } catch {
          this.residency.cancel(plan);
          this.reject(item, "atlas-upload");
          continue;
        }
      }
      const { page, fit } = selected;
      const before = performance.now();
      try {
        upload([{ operation: "subrect", key: page.key, width: PAGE_SIDE, height: PAGE_SIDE,
          format: "linear", x: fit.x, y: fit.y, regionWidth: tile.width, regionHeight: tile.height,
          pixels: tile.pixels }]);
      } catch { this.reject(item, "atlas-upload"); continue; }
      if (performance.now() - before > 1) this.uploadOverruns++;
      this.uploadCalls++;
      this.uploadBytes += tile.pixels.byteLength;
      frameBytes += tile.pixels.byteLength;
      this.pages.set(page.key, fit.next);
      this.residency.touch(page.key);
      this.glyphs.set(key, { glyphId: tile.glyphId, pageKey: page.key, pageSize: PAGE_SIDE,
        src: [fit.x, fit.y, tile.width, tile.height], left: tile.left, top: tile.top });
      item.index++; ready++;
      if (performance.now() - started >= 1) break;
    }
    return { ready, more: this.hasWork(), uploadedBytes: frameBytes, allocations: frameAllocations };
  }

  private reject(item: Work, reason: string): void {
    for (const key of item.keys.slice(item.index)) this.failures.set(key, reason);
    item.done(reason);
    this.work.shift();
  }
  stats() {
    return { ...this.residency.stats(), glyphs: this.glyphs.size, queuedBatches: this.work.length,
      uploadCalls: this.uploadCalls, uploadBytes: this.uploadBytes, uploadOverruns: this.uploadOverruns,
      allocations: this.allocations };
  }
  /** Called when the renderer's GPU context is recreated; old page keys have no texture behind them. */
  resetResidency(): void {
    for (const item of this.work.splice(0)) item.done("context-recreated");
    this.residency = new RustAtlasPages(PAGE_LIMIT * PAGE_SIDE * PAGE_SIDE * 4);
    this.pages.clear(); this.glyphs.clear(); this.failures.clear();
  }
  dispose(): void {
    for (const item of this.work.splice(0)) item.done("disposed");
    this.pages.clear(); this.glyphs.clear(); this.failures.clear();
  }
}
