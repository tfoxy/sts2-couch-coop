import { describe, expect, it } from "vitest";
import type { RustResourceUpdate } from "@godot-scene-web/canvas/rust-prototype";
import { MsdfAtlas } from "./msdfAtlas";

const tile = (glyphId: number, side = 16) => ({ glyphId, width: side, height: side,
  left: 0, top: 0, advance: side, pixels: new Uint8Array(side * side * 4) });

describe("MSDF atlas admission", () => {
  it("keeps glyphs on Bitmap until allocate and subrect both upload, with zero allocation payload", () => {
    const atlas = new MsdfAtlas();
    const updates: RustResourceUpdate[][] = [];
    let finished = false;
    atlas.enqueue(["a"], [tile(4)], () => { finished = true; });
    expect(atlas.placement("a")).toBeUndefined();
    const first = atlas.flush((batch) => { updates.push([...batch]); }, []);
    expect(first.allocations).toBe(1);
    expect(updates[0]).toMatchObject([{ operation: "allocate", format: "linear", width: 1024, height: 1024 }]);
    expect("pixels" in updates[0][0]).toBe(false);
    if (atlas.hasWork()) atlas.flush((batch) => { updates.push([...batch]); }, []);
    expect(atlas.placement("a")?.src).toEqual([0, 0, 16, 16]);
    expect(updates.at(-1)?.[0]).toMatchObject({ operation: "subrect", format: "linear", regionWidth: 16 });
    if (!finished) atlas.flush(() => {}, []);
    expect(finished).toBe(true);
    atlas.dispose();
  });

  it("does not publish a tile after an upload failure", () => {
    const atlas = new MsdfAtlas();
    let reason: string | undefined;
    atlas.enqueue(["a"], [tile(4)], (value) => { reason = value; });
    atlas.flush(() => { throw new Error("GPU refused"); }, []);
    expect(atlas.placement("a")).toBeUndefined();
    expect(atlas.stats()).toMatchObject({ pages: 0, pending: 0 });
    expect(reason).toBe("atlas-upload");
  });

  it("does not publish a glyph when its subrect upload fails after allocation", () => {
    const atlas = new MsdfAtlas();
    const operations: string[] = [];
    let reason: string | undefined;
    atlas.enqueue(["a"], [tile(4)], (value) => { reason = value; });
    while (atlas.hasWork()) atlas.flush((batch) => {
      operations.push(batch[0].operation);
      if (batch[0].operation === "subrect") throw new Error("GPU refused subrect");
    }, []);
    expect(operations).toEqual(["allocate", "subrect"]);
    expect(atlas.placement("a")).toBeUndefined();
    expect(atlas.stats()).toMatchObject({ pages: 1, glyphs: 0 });
    expect(reason).toBe("atlas-upload");
  });

  it("pins the committed page while processing later work", () => {
    const atlas = new MsdfAtlas();
    atlas.enqueue(["a"], [tile(4)], () => {});
    while (atlas.hasWork()) atlas.flush(() => {}, []);
    const page = atlas.placement("a")!.pageKey;
    atlas.enqueue(["b"], [tile(5)], () => {});
    while (atlas.hasWork()) atlas.flush(() => {}, [page]);
    expect(atlas.placement("a")?.pageKey).toBe(page);
    expect(atlas.placement("b")?.pageKey).toBe(page);
    expect(atlas.stats()).toMatchObject({ pages: 1, pinned: 1 });
    atlas.dispose();
  });

  it("caps four 1024 pages, refuses a pinned fifth, then releases an unpinned page and its glyphs", () => {
    const atlas = new MsdfAtlas();
    const pinned = new Set<string>();
    const uploads: RustResourceUpdate[][] = [];
    const upload = (batch: readonly RustResourceUpdate[]) => { uploads.push([...batch]); };
    const drain = () => {
      for (let attempts = 0; atlas.hasWork() && attempts < 8; attempts++) atlas.flush(upload, pinned);
      expect(atlas.hasWork()).toBe(false);
    };
    for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
      for (let tileIndex = 0; tileIndex < 16; tileIndex++) {
        const key = `${pageIndex}:${tileIndex}`;
        atlas.enqueue([key], [tile(1 + pageIndex * 16 + tileIndex, 256)], () => {});
        drain();
        expect(atlas.placement(key)).toBeDefined();
      }
      pinned.add(atlas.placement(`${pageIndex}:0`)!.pageKey);
    }
    atlas.flush(upload, pinned);
    expect(atlas.stats()).toMatchObject({ pages: 4, pinned: 4, bytes: 4 * 1024 * 1024 * 4 });
    let refused: string | undefined;
    atlas.enqueue(["fifth"], [tile(100, 256)], (reason) => { refused = reason; });
    drain();
    expect(refused).toBe("atlas-full");
    expect(atlas.placement("fifth")).toBeUndefined();
    expect(uploads.filter((batch) => batch.some((update) => update.operation === "allocate"))).toHaveLength(4);
    const victim = atlas.placement("1:0")!.pageKey;
    pinned.delete(victim);
    atlas.enqueue(["replacement"], [tile(101, 256)], () => {});
    drain();
    expect(uploads.at(-2)).toMatchObject([{ operation: "release", key: victim }, { operation: "allocate" }]);
    expect(atlas.placement("1:0")).toBeUndefined();
    expect(atlas.placement("replacement")).toBeDefined();
    expect(atlas.stats()).toMatchObject({ pages: 4 });
    expect(uploads.every((batch) => batch.filter((update) => update.operation === "allocate").length <= 1)).toBe(true);
    expect(uploads.every((batch) => batch.filter((update) => update.operation === "subrect")
      .reduce((bytes, update) => bytes + ("pixels" in update ? update.pixels.byteLength : 0), 0) <= 256 * 1024)).toBe(true);
    atlas.dispose();
  });

  it("invalidates ready glyphs on context recreation and reuploads under a new page key", () => {
    const atlas = new MsdfAtlas();
    const operations: RustResourceUpdate[][] = [];
    const upload = (batch: readonly RustResourceUpdate[]) => { operations.push([...batch]); };
    atlas.enqueue(["a"], [tile(4)], () => {});
    while (atlas.hasWork()) atlas.flush(upload, []);
    const oldPage = atlas.placement("a")!.pageKey;
    atlas.resetResidency();
    expect(atlas.placement("a")).toBeUndefined();
    expect(atlas.stats()).toMatchObject({ pages: 0, bytes: 0 });
    atlas.enqueue(["a"], [tile(4)], () => {});
    while (atlas.hasWork()) atlas.flush(upload, []);
    expect(atlas.placement("a")?.pageKey).not.toBe(oldPage);
    expect(operations.filter((batch) => batch[0].operation === "allocate")).toHaveLength(2);
    expect(operations.filter((batch) => batch[0].operation === "subrect")).toHaveLength(2);
    atlas.dispose();
  });
});
