// The client-vitals census: what it reads, what it refuses to let through, and what it does when the page it is
// censusing is already falling apart. That last group is the point of the module — it runs on a browser we
// suspect is about to be killed, so "the document threw" has to produce a partial census rather than an
// exception that costs us the whole reading.

import { beforeEach, describe, expect, it } from "vitest";

import { collectClientVitals, type ClientVitalsSources } from "@/mirror/clientVitals";
import { __resetImagePrefetchStatsForTest } from "@/mirror/imagePrefetch";

function sources(overrides: Partial<ClientVitalsSources> = {}): ClientVitalsSources {
  return {
    requestedStage: () => "dom",
    activeStage: () => "dom",
    canvasResidency: () => null,
    atlasResidency: () => ({ bytes: 0, pages: 0, cap: 0 }),
    effectModes: () => ({ shaderMode: "static", particleMode: "static" }),
    doc: () => null,
    view: () => null,
    ...overrides
  };
}

/** A minimal stand-in document: only the two reads the census makes. */
function fakeDoc(canvases: { width: number; height: number }[], frameElements = 0): Document {
  const collection = {
    length: canvases.length,
    item: (i: number) => (canvases[i] ?? null) as unknown as HTMLCanvasElement
  };
  return {
    getElementsByTagName: () => collection,
    querySelectorAll: (selector: string) => ({ length: selector === ".mirror-frame *" ? frameElements : 0 })
  } as unknown as Document;
}

function fakeView(overrides: Record<string, unknown> = {}): Window {
  return { devicePixelRatio: 2, innerWidth: 390, innerHeight: 844, ...overrides } as unknown as Window;
}

beforeEach(() => {
  __resetImagePrefetchStatsForTest();
});

describe("collectClientVitals", () => {
  it("reports both stage backends so a silent canvas fallback is visible", () => {
    // The pair differing is the ONLY report of a hard fallback: `?stage=canvas` is a request, and a phone whose
    // WebGL2 context cannot be created gets the DOM backend with nothing above rendererFactory told about it.
    const vitals = collectClientVitals(sources({ requestedStage: () => "canvas", activeStage: () => "dom" }));

    expect(vitals.stageRequested).toBe("canvas");
    expect(vitals.stageActive).toBe("dom");
  });

  it("totals canvas backing-store pixels, not just the canvas count", () => {
    // WebKit budgets canvas memory per page against the pixels, so two 2048x2048 canvases are a different fact
    // from twenty 64x64 ones even though a count cannot tell them apart.
    const vitals = collectClientVitals(sources({
      doc: () => fakeDoc([{ width: 2048, height: 2048 }, { width: 64, height: 64 }])
    }));

    expect(vitals.canvases).toBe(2);
    expect(vitals.canvasPx).toBe(2048 * 2048 + 64 * 64);
  });

  it("counts elements under the mirror frame", () => {
    const vitals = collectClientVitals(sources({ doc: () => fakeDoc([], 1204) }));

    expect(vitals.els).toBe(1204);
  });

  it("rounds the device pixel ratio to two places", () => {
    const vitals = collectClientVitals(sources({ view: () => fakeView({ devicePixelRatio: 3.4876 }) }));

    expect(vitals.dpr).toBe(3.49);
  });

  it("reports the canvas residency caps only while the canvas backend is active", () => {
    const off = collectClientVitals(sources({ canvasResidency: () => null }));
    const on = collectClientVitals(sources({ canvasResidency: () => ({ textureBytes: 192, fxBytes: 48 }) }));

    // Zero on the DOM backend is the measurement, not a gap: these two bound the CANVAS backend's own textures.
    expect(off.texBytes).toBe(0);
    expect(off.fxBytes).toBe(0);
    expect(on.texBytes).toBe(192);
    expect(on.fxBytes).toBe(48);
  });

  it("reports atlas residency as a LIVE reading, and its cap, on the DOM backend too", () => {
    // The iPhone report's whole gap: it carried a large byte figure with `texCap=0 fxCap=0` beside it, and there
    // was no field that could say whether the page holding those bytes was bounded. `atlasCap` is that field, and
    // unlike the two canvas caps it is non-zero on the backend every player actually gets.
    const vitals = collectClientVitals(sources({
      activeStage: () => "dom",
      canvasResidency: () => null,
      atlasResidency: () => ({ bytes: 62_600_000, pages: 1, cap: 96 * 1024 * 1024 })
    }));

    expect(vitals.decodedBytes).toBe(62_600_000);
    expect(vitals.decodedPages).toBe(1);
    expect(vitals.atlasCap).toBe(96 * 1024 * 1024);
    expect(vitals.texBytes).toBe(0);
  });

  it("reports a cap of zero when the budget is switched off, without losing the live bytes", () => {
    // `?atlasResident=0` is the device A/B's off-arm, so its report has to be readable as "unbounded, and this is
    // what unbounded came to" rather than as a census that failed to take a reading.
    const vitals = collectClientVitals(sources({
      atlasResidency: () => ({ bytes: 205_000_000, pages: 11, cap: 0 })
    }));

    expect(vitals.decodedBytes).toBe(205_000_000);
    expect(vitals.decodedPages).toBe(11);
    expect(vitals.atlasCap).toBe(0);
  });

  it("survives an atlas reading that throws, like every other source", () => {
    const vitals = collectClientVitals(sources({
      atlasResidency: () => { throw new Error("detached"); },
      view: () => fakeView()
    }));

    expect(vitals.decodedBytes).toBe(0);
    expect(vitals.decodedPages).toBe(0);
    expect(vitals.atlasCap).toBe(0);
    expect(vitals.vw).toBe(390);
  });

  it("reports a browser with no performance.memory as zero rather than omitting the field", () => {
    // WebKit — the platform this census exists for — does not offer it. A missing key would read as a schema
    // change to the host; 0 reads as "this browser declined to say", which is the true statement.
    const vitals = collectClientVitals(sources({ view: () => fakeView() }));

    expect(vitals.jsHeapBytes).toBe(0);
  });

  it("reads performance.memory where the browser offers it", () => {
    const vitals = collectClientVitals(sources({
      view: () => fakeView({ performance: { memory: { usedJSHeapSize: 123_456 } } })
    }));

    expect(vitals.jsHeapBytes).toBe(123_456);
  });

  it("never emits a negative, fractional or non-finite count", () => {
    const vitals = collectClientVitals(sources({
      doc: () => fakeDoc([{ width: -8, height: 16 }, { width: Number.NaN, height: 4 }]),
      view: () => fakeView({ innerWidth: -1, innerHeight: Number.POSITIVE_INFINITY, devicePixelRatio: Number.NaN })
    }));

    expect(vitals.canvasPx).toBe(0);
    expect(vitals.vw).toBe(0);
    expect(vitals.vh).toBe(0);
    expect(vitals.dpr).toBe(0);
  });

  it("still produces a census when individual readings throw", () => {
    // THE CASE THIS MODULE EXISTS FOR. A page under memory pressure can refuse a reading; a census that
    // propagated that would lose the other fifteen fields at exactly the moment they matter.
    const vitals = collectClientVitals(sources({
      doc: () => { throw new Error("detached"); },
      view: () => fakeView({ innerWidth: 390 }),
      activeStage: () => { throw new Error("no renderer"); }
    }));

    expect(vitals.vw).toBe(390);
    expect(vitals.els).toBe(0);
    expect(vitals.canvases).toBe(0);
    expect(vitals.stageActive).toBe("dom");
  });

  it("carries no identifying value — numbers and two closed enums only", () => {
    // A structural guard, not a spot check: this payload is quoted into a report a player pastes in public, so a
    // future field carrying a URL, a name or a user agent has to fail here rather than in the field.
    const vitals = collectClientVitals(sources({
      doc: () => fakeDoc([{ width: 8, height: 8 }], 3),
      view: () => fakeView()
    }));

    const enums = ["stageRequested", "stageActive", "shaderMode", "particleMode"];
    for (const [key, value] of Object.entries(vitals)) {
      if (enums.includes(key)) {
        expect(typeof value, key).toBe("string");
      } else {
        expect(typeof value, key).toBe("number");
        expect(Number.isFinite(value as number), key).toBe(true);
      }
    }
  });
});
