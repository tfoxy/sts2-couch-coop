import { describe, expect, it } from "vitest";

import type { MirrorNode } from "@/mirror/sceneTree";
import { translatedSpanRefusal, type TranslatedSpanBuild, type TranslatedSpanContext } from "./translatedSpan";

// A hand: `hand` > `holderA`, `holderB`, each with a card under it; `hand` sits under a `screen` group.
const IDS = ["screen", "hand", "holderA", "cardA", "holderB", "cardB"];
const PARENT: Record<string, string | null> = { screen: null, hand: "screen", holderA: "hand", cardA: "holderA",
  holderB: "hand", cardB: "holderB" };
const SPAN: Record<string, [number, number]> = { screen: [0, 6], hand: [1, 6], holderA: [2, 4], cardA: [3, 4],
  holderB: [4, 6], cardB: [5, 6] };

function context(over: { candidates?: string[]; stamps?: string[]; clips?: string[]; spreadFactor?: number;
  modes?: Record<string, number>; types?: Record<string, string>; clipsMovable?: boolean; shifted?: string[] } = {}): TranslatedSpanContext {
  const entries = new Map(IDS.map((id, order) => [id, { order, spanStart: SPAN[id][0], spanEnd: SPAN[id][1] }]));
  const build = {
    order: { ids: IDS, entries },
    viewScaleCandidates: new Set(over.candidates ?? []),
    viewScaleStamps: new Map((over.stamps ?? []).map((id) => [id, {}])),
    clipRanges: new Map((over.clips ?? []).map((id) => [id, { push: 0, pop: 1 }])),
  } as unknown as TranslatedSpanBuild;
  const nodes = new Map(IDS.map((id) => [id, { id, parentId: PARENT[id], nodeType: over.types?.[id] ?? "Control" } as MirrorNode]));
  return { build, nodes, spreadFactor: over.spreadFactor ?? 1, fieldModes: new Map(Object.entries(over.modes ?? {})),
    shifted: new Set(over.shifted ?? []), clipsMovable: over.clipsMovable ?? false };
}

const MOVE = [1, 0, 0, 1, 12, 5];

describe("translatedSpanRefusal", () => {
  it("admits a plain span", () => {
    expect(translatedSpanRefusal("hand", MOVE, context())).toBeNull();
  });

  it("refuses a view-scale stamp or candidate in the span or above the root", () => {
    expect(translatedSpanRefusal("hand", MOVE, context({ stamps: ["cardB"] }))).toBe("wire-view-scale");
    expect(translatedSpanRefusal("hand", MOVE, context({ candidates: ["holderA"] }))).toBe("wire-view-scale");
    expect(translatedSpanRefusal("hand", MOVE, context({ candidates: ["screen"] }))).toBe("wire-view-scale");
    // A sibling's stamp is outside both the span and the ancestry.
    expect(translatedSpanRefusal("holderA", MOVE, context({ stamps: ["cardB"] }))).toBeNull();
  });

  it("refuses a clipper in the span unless the executor can move its clip", () => {
    expect(translatedSpanRefusal("hand", MOVE, context({ clips: ["holderB"] }))).toBe("wire-clip");
    expect(translatedSpanRefusal("hand", MOVE, context({ clips: ["holderB"], clipsMovable: true }))).toBeNull();
    expect(translatedSpanRefusal("holderA", MOVE, context({ clips: ["holderB"] }))).toBeNull();
  });

  it("refuses a field claim or a remote follower in the span only on a widened stage", () => {
    expect(translatedSpanRefusal("hand", MOVE, context({ spreadFactor: 1.3, modes: { holderA: 1 } }))).toBe("wire-spread");
    expect(translatedSpanRefusal("hand", MOVE, context({ spreadFactor: 1.3, modes: { cardB: 2 } }))).toBe("wire-spread");
    expect(translatedSpanRefusal("hand", MOVE, context({ spreadFactor: 1.3, types: { cardA: "Game.NRemoteMouseCursor" } })))
      .toBe("wire-spread");
    // Rides only: every shift comes from an ancestor outside the span.
    expect(translatedSpanRefusal("hand", MOVE, context({ spreadFactor: 1.3, modes: { holderA: 0, screen: 1 } }))).toBeNull();
    expect(translatedSpanRefusal("hand", MOVE, context({ spreadFactor: 1, modes: { holderA: 1 } }))).toBeNull();
  });

  it("lets a translation that leaves game X alone keep every field claim, but not a remote follower", () => {
    const wide = { spreadFactor: 1.3, modes: { holderA: 1, cardB: 2 } };
    expect(translatedSpanRefusal("hand", [1, 0, 0, 1, 0, 7], context(wide))).toBeNull();
    expect(translatedSpanRefusal("hand", [1, 0, 0, 1, 0, 0], context(wide))).toBeNull();
    expect(translatedSpanRefusal("hand", [1, 0, 0, 1, 0, 7], context({ spreadFactor: 1.3, types: { cardA: "Game.NRemoteMouseCursor" } })))
      .toBe("wire-spread");
  });

  it("refuses a non-translation delta over a spread-shifted node on a widened stage only", () => {
    const scaled = [1.1, 0, 0, 1.1, 0, 0];
    expect(translatedSpanRefusal("hand", scaled, context({ spreadFactor: 1.3, shifted: ["cardA"] }))).toBe("wire-spread");
    expect(translatedSpanRefusal("hand", scaled, context({ spreadFactor: 1.3 }))).toBeNull();
    expect(translatedSpanRefusal("hand", scaled, context({ spreadFactor: 1, shifted: ["cardA"] }))).toBeNull();
    // A pure translation commutes with the shift.
    expect(translatedSpanRefusal("hand", [1, 0, 0, 1, 0, 3], context({ spreadFactor: 1.3, shifted: ["cardA"] }))).toBeNull();
  });

  it("refuses nothing for a delta that moves nothing", () => {
    expect(translatedSpanRefusal("hand", [1, 0, 0, 1, 0, 0], context({ stamps: ["cardB"], clips: ["holderB"] }))).toBeNull();
  });
});
