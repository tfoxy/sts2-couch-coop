import { describe, expect, it, vi } from "vitest";
import {
  applyRendererComparisonConfig, comparisonUrl, normalizedComparisonConfig, readRendererComparisonConfig,
  rendererBackendForPageLoad,
  rendererComparisonConfig, rendererComparisonViewRevision, rendererRuntimeStatus, setRendererRuntimeStatus,
  RENDERER_COMPARISON_PRESETS, registerRendererComparisonApply
} from "@/mirror/rendererComparison";

describe("renderer comparison URL", () => {
  it("uses explicit developer backends only on a comparison page load", () => {
    expect(rendererBackendForPageLoad("?rendererCompare=1&stage=pixi", "canvas")).toBe("pixi");
    expect(rendererBackendForPageLoad("?rendererCompare=1&stage=rust", "dom")).toBe("rust");
    expect(rendererBackendForPageLoad("?stage=rust", "canvas")).toBe("canvas");
    expect(rendererBackendForPageLoad("?rendererCompare=0&stage=pixi", "dom")).toBe("dom");
    expect(rendererBackendForPageLoad("?rendererCompare=1&stage=canvas", "dom")).toBe("dom");
  });

  it("initializes comparison mode from an explicit developer URL without changing persisted public settings", async () => {
    const priorUrl = window.location.href;
    const storageKey = "couchcoop.mirrorSettings.v1";
    const priorStorage = localStorage.getItem(storageKey);
    try {
      localStorage.setItem(storageKey, JSON.stringify({ stage: "canvas" }));
      window.history.replaceState(null, "", "/?rendererCompare=1&stage=rust");
      vi.resetModules();
      const settings = await import("@/mirror/mirrorSettings");
      const comparison = await import("@/mirror/rendererComparison");
      expect(settings.mirrorSettings.stage).toBe("canvas");
      expect(settings.mirrorSettings.runtimeStage).toBe("canvas");
      expect(comparison.rendererComparisonConfig.backend).toBe("rust");

      window.history.replaceState(null, "", "/?stage=rust");
      vi.resetModules();
      const ordinarySettings = await import("@/mirror/mirrorSettings");
      const ordinaryComparison = await import("@/mirror/rendererComparison");
      expect(ordinarySettings.mirrorSettings.stage).toBe("canvas");
      expect(ordinaryComparison.rendererComparisonConfig.backend).toBe("canvas");
    } finally {
      window.history.replaceState(null, "", priorUrl);
      if (priorStorage === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, priorStorage);
      vi.resetModules();
    }
  });

  it("keeps the Rust/WASM slice behind renderer comparison and normalizes it independently", () => {
    const rust = readRendererComparisonConfig("?rendererCompare=1&stage=rust&cmpIdle=display&pixiText=slug");
    expect(rust).toMatchObject({ backend: "rust", idleCadence: "display", pixiText: "native",
      cpuIncremental: false, gpuCommands: false, textCache: "off", pixels: "direct" });
    expect(readRendererComparisonConfig("?stage=rust").backend).toBe("dom");
    const url = new URL(comparisonUrl("http://localhost/?name=Ann&pixiScene=legacy&pixiText=slug", rust));
    expect(url.searchParams.get("rendererCompare")).toBe("1");
    expect(url.searchParams.get("stage")).toBe("rust");
    expect(url.searchParams.get("cmpIdle")).toBe("display");
    expect(url.searchParams.has("pixiScene")).toBe(false);
    expect(url.searchParams.has("pixiText")).toBe(false);
    expect(url.searchParams.get("name")).toBe("Ann");
    expect(normalizedComparisonConfig({ ...RENDERER_COMPARISON_PRESETS.rust, cpuIncremental: true,
      gpuCommands: true, textCache: "gpu", pixels: "surfaces", structureReuse: true })).toMatchObject({
      backend: "rust", cpuIncremental: false, gpuCommands: false, textCache: "off", pixels: "direct",
      structureReuse: false, idleCadence: "authored"
    });
  });

  it("preserves selectable Pixi text modes through comparison URLs with native as the default", () => {
    for (const pixiScene of ["legacy", "retained"] as const) {
      for (const pixiText of ["native", "slug", "slug-cached"] as const) {
        const parsed = readRendererComparisonConfig(`?rendererCompare=1&stage=pixi&pixiScene=${pixiScene}&pixiText=${pixiText}&cmpIdle=display`);
        expect(parsed).toMatchObject({ pixiText, pixiScene, idleCadence: "display", textCache: "off" });
        const url = new URL(comparisonUrl("http://localhost/?name=001002&seat=two&other=a&other=b#game", parsed));
        expect(readRendererComparisonConfig(url.search)).toEqual(parsed);
        expect(url.searchParams.get("pixiText")).toBe(pixiText);
        expect(url.searchParams.get("name")).toBe("001002");
        expect(url.searchParams.get("seat")).toBe("two");
        expect(url.searchParams.getAll("other")).toEqual(["a", "b"]);
        expect(url.hash).toBe("#game");
      }
    }
    for (const suffix of ["", "&pixiText=unknown", "&pixiText=SLUG"]) {
      expect(readRendererComparisonConfig(`?stage=pixi${suffix}`).pixiText).toBe("native");
    }
    for (const backend of ["canvas", "dom"] as const) {
      const parsed = readRendererComparisonConfig(`?stage=${backend}&pixiText=slug-cached&canvasTextCache=gpu`);
      expect(parsed.pixiText).toBe("native");
      expect(parsed.textCache).toBe(backend === "canvas" ? "gpu" : "off");
      expect(new URL(comparisonUrl("http://localhost/?pixiText=slug", parsed)).searchParams.has("pixiText")).toBe(false);
    }
  });

  it("publishes text fallbacks without dirtying unchanged runtime reports", () => {
    const before = { ...rendererRuntimeStatus };
    try {
      const report = { requested: "slug-cached" as const, actual: "mixed" as const,
        native: 1, slug: 2, slugCached: 10, reasons: { coverage: 1, opacity: 2 } };
      setRendererRuntimeStatus({ pixiText: report });
      const first = rendererRuntimeStatus.pixiText;
      setRendererRuntimeStatus({ pixiText: { ...report, reasons: { opacity: 2, coverage: 1 } } });
      expect(rendererRuntimeStatus.pixiText).toBe(first);
      report.reasons.coverage = 3;
      expect(rendererRuntimeStatus.pixiText?.reasons.coverage).toBe(1);
      setRendererRuntimeStatus({ pixiText: report });
      expect(rendererRuntimeStatus.pixiText).not.toBe(first);
      expect(rendererRuntimeStatus.pixiText?.reasons.coverage).toBe(3);
    } finally { setRendererRuntimeStatus(before); }
  });

  it("applies a text-mode change in place in the document and clears the prior admission report", () => {
    const before = { ...rendererComparisonConfig }, status = { ...rendererRuntimeStatus };
    const revision = rendererComparisonViewRevision.value;
    const replaceState = vi.fn();
    try {
      setRendererRuntimeStatus({ pixiText: { requested: "native", actual: "native", native: 5,
        slug: 0, slugCached: 0, reasons: {} } });
      const next = { ...RENDERER_COMPARISON_PRESETS.pixi, pixiText: "slug-cached" as const };
      applyRendererComparisonConfig(next, { location: { href: "http://localhost/?name=001002&quality=very-low#game" },
        history: { state: { seat: "keep" }, replaceState } });
      expect(rendererComparisonConfig).toEqual(next);
      expect(rendererRuntimeStatus.requested.pixiText).toBe("slug-cached");
      expect(rendererRuntimeStatus.pixiText).toBeNull();
      expect(rendererComparisonViewRevision.value).toBe(revision + 1);
      const url = new URL(replaceState.mock.calls[0][2]);
      expect(url.searchParams.get("name")).toBe("001002");
      expect(url.searchParams.get("quality")).toBe("very-low");
      expect(url.searchParams.get("pixiText")).toBe("slug-cached");
      expect(replaceState.mock.calls[0][0]).toEqual({ seat: "keep" });
    } finally {
      Object.assign(rendererComparisonConfig, before); rendererComparisonViewRevision.value = revision;
      setRendererRuntimeStatus(status);
    }
  });

  it("retains Pixi scene selection and shared cadence without enabling Canvas switches", () => {
    for (const pixiScene of ["legacy", "retained"] as const) {
      const parsed = readRendererComparisonConfig(`?rendererCompare=1&stage=pixi&pixiScene=${pixiScene}&cmpIdle=display&canvasTextCache=gpu&cmpSource=reuse`);
      expect(parsed).toMatchObject({ backend: "pixi", pixiScene, idleCadence: "display", textCache: "off", sourceFrameReuse: false });
      const url = new URL(comparisonUrl("http://localhost/?name=001002&quality=very-low&other=a&other=b#game", parsed));
      expect(readRendererComparisonConfig(url.search)).toEqual(parsed);
      expect(url.searchParams.get("name")).toBe("001002");
      expect(url.searchParams.getAll("other")).toEqual(["a", "b"]);
      expect(url.searchParams.has("canvasTextCache")).toBe(false);
      expect(url.hash).toBe("#game");
    }
  });

  it("defaults missing or unknown Pixi scene choices to the complete retained bundle", () => {
    for (const suffix of ["", "&pixiScene=unknown"]) {
      expect(readRendererComparisonConfig(`?stage=pixi${suffix}`).pixiScene).toBe("retained");
    }
    for (const backend of ["dom", "canvas"] as const) {
      const parsed = readRendererComparisonConfig(`?rendererCompare=1&stage=${backend}&pixiScene=legacy`);
      expect(parsed.pixiScene).toBe("retained");
      expect(new URL(comparisonUrl("http://localhost/?pixiScene=legacy", parsed)).searchParams.has("pixiScene")).toBe(false);
    }
  });

  it("retains the seat, origin, and unrelated viewer settings across a mode reload", () => {
    const before = "http://192.168.1.5:5178/?name=Ann%20Lee&quality=low&shaders=dynamic&sw=off#game";
    const after = new URL(comparisonUrl(before, {
      backend: "canvas", cpuIncremental: false, gpuCommands: true,
      textCache: "gpu", pixels: "layers", idleCadence: "display", structureReuse: true, textPreparationReuse: true, sourceFrameReuse: true, animationReferenceReuse: true, pixiScene: "retained", pixiText: "native"
    }));
    expect(after.origin).toBe("http://192.168.1.5:5178");
    expect(after.searchParams.get("name")).toBe("Ann Lee");
    expect(after.searchParams.get("quality")).toBe("low");
    expect(after.searchParams.get("shaders")).toBe("dynamic");
    expect(after.searchParams.get("sw")).toBe("off");
    expect(after.hash).toBe("#game");
    expect(after.searchParams.has("cmpSource")).toBe(false);
    expect(readRendererComparisonConfig(after.search)).toEqual({
      backend: "canvas", cpuIncremental: false, gpuCommands: true,
      textCache: "gpu", pixels: "layers", idleCadence: "display", structureReuse: true, textPreparationReuse: true, sourceFrameReuse: false, animationReferenceReuse: false, pixiScene: "retained" as const, pixiText: "native" as const
    });
  });

  it("ignores comparison toggles outside the explicit comparison page", () => {
    expect(readRendererComparisonConfig("?stage=canvas&cmpCpu=off&cmpGpu=off&cmpPixels=layers&cmpIdle=display&cmpStructure=reuse&cmpTextCpu=reuse&cmpSource=reuse")).toEqual({
      backend: "canvas", cpuIncremental: true, gpuCommands: true,
      textCache: "off", pixels: "direct", idleCadence: "authored", structureReuse: false, textPreparationReuse: false, sourceFrameReuse: false, animationReferenceReuse: false, pixiScene: "retained" as const, pixiText: "native" as const
    });
  });

  it("normalizes CPU preparation controls off for DOM and Pixi", () => {
    for (const backend of ["dom", "pixi"] as const) {
      const parsed = readRendererComparisonConfig(`?rendererCompare=1&stage=${backend}&cmpStructure=reuse&cmpTextCpu=reuse&cmpSource=reuse`);
      expect(parsed.structureReuse).toBe(false);
      expect(parsed.textPreparationReuse).toBe(false);
      expect(parsed.sourceFrameReuse).toBe(false);
      const url = new URL(comparisonUrl("http://localhost/?name=Ann", { ...RENDERER_COMPARISON_PRESETS.sourceFrame, backend }));
      expect(url.searchParams.has("cmpStructure")).toBe(false);
      expect(url.searchParams.has("cmpTextCpu")).toBe(false);
      expect(url.searchParams.has("cmpSource")).toBe(false);
    }
  });

  it("admits animated-frame reuse only with incremental Canvas CPU updates", () => {
    const oldUrl = readRendererComparisonConfig("?rendererCompare=1&stage=canvas&cmpCpu=on");
    expect(oldUrl.sourceFrameReuse).toBe(false);
    const requested = "?rendererCompare=1&stage=canvas&cmpCpu=off&cmpSource=reuse";
    expect(readRendererComparisonConfig(requested).sourceFrameReuse).toBe(false);
    const url = new URL(comparisonUrl("http://localhost/?name=Ann&cmpSource=reuse", {
      ...RENDERER_COMPARISON_PRESETS.sourceFrame, cpuIncremental: false
    }));
    expect(url.searchParams.has("cmpSource")).toBe(false);
  });

  it("round-trips every preset, including non-Canvas inactive flags", () => {
    for (const preset of Object.values(RENDERER_COMPARISON_PRESETS)) {
      const url = new URL(comparisonUrl("http://192.168.1.5:5178/?name=Ann", preset));
      expect(readRendererComparisonConfig(url.search)).toEqual(preset);
      expect(url.searchParams.get("name")).toBe("Ann");
    }
  });

  it("keeps reference patches off in older presets and admits their switch independently", () => {
    for (const preset of Object.values(RENDERER_COMPARISON_PRESETS)) expect(preset.animationReferenceReuse).toBe(false);
    for (const query of ["?stage=canvas&cmpAnimation=reference", "?rendererCompare=1&stage=canvas",
      "?rendererCompare=1&stage=canvas&cmpCpu=off&cmpAnimation=reference",
      "?rendererCompare=1&stage=dom&cmpAnimation=reference"]) {
      expect(readRendererComparisonConfig(query).animationReferenceReuse).toBe(false);
    }
    const next = { ...RENDERER_COMPARISON_PRESETS.canvas, animationReferenceReuse: true };
    const url = new URL(comparisonUrl("http://localhost/?name=Ann%20Lee&other=a&other=b#game", next));
    expect(readRendererComparisonConfig(url.search)).toEqual(next);
    expect(url.searchParams.get("cmpAnimation")).toBe("reference");
    expect(url.searchParams.get("name")).toBe("Ann Lee");
    expect(url.searchParams.getAll("other")).toEqual(["a", "b"]);
    expect(url.hash).toBe("#game");
  });

  it("retains the view when its active renderer accepts an in-place policy change", () => {
    const before = { ...rendererComparisonConfig }, revision = rendererComparisonViewRevision.value;
    const status = { ...rendererRuntimeStatus };
    const next = { ...RENDERER_COMPARISON_PRESETS.sourceFrame, animationReferenceReuse: true };
    const handler = vi.fn(() => true), replaceState = vi.fn();
    const unregister = registerRendererComparisonApply(handler);
    try {
      applyRendererComparisonConfig(next, { location: { href: "http://localhost/?name=001002&refresh=60" },
        history: { state: null, replaceState } });
      expect(handler).toHaveBeenCalledWith(next);
      expect(rendererComparisonViewRevision.value).toBe(revision);
      expect(rendererRuntimeStatus.phase).toBe("initializing");
      const url = new URL(replaceState.mock.calls[0][2] as string);
      expect(url.searchParams.get("name")).toBe("001002");
      expect(url.searchParams.get("refresh")).toBe("60");
      unregister();
      applyRendererComparisonConfig(next, { location: { href: url.href }, history: { state: null, replaceState } });
      expect(rendererComparisonViewRevision.value).toBe(revision + 1);
    } finally {
      unregister(); Object.assign(rendererComparisonConfig, before);
      rendererComparisonViewRevision.value = revision; setRendererRuntimeStatus(status);
    }
  });

  it("does not let a disposed renderer unregister its replacement", () => {
    const before = { ...rendererComparisonConfig }, revision = rendererComparisonViewRevision.value;
    const status = { ...rendererRuntimeStatus };
    const stale = registerRendererComparisonApply(() => false);
    const current = registerRendererComparisonApply(() => true);
    stale();
    try {
      applyRendererComparisonConfig(RENDERER_COMPARISON_PRESETS.sourceFrame,
        { location: { href: "http://localhost/" }, history: { state: null, replaceState: vi.fn() } });
      expect(rendererComparisonViewRevision.value).toBe(revision);
    } finally {
      current(); Object.assign(rendererComparisonConfig, before);
      rendererComparisonViewRevision.value = revision; setRendererRuntimeStatus(status);
    }
  });

  it("keeps historical presets authored while all GPU idle experiments use cached text and display pacing", () => {
    for (const [id, preset] of Object.entries(RENDERER_COMPARISON_PRESETS)) {
      if (id === "display" || id === "preserved" || id === "copy" || id === "cpuPrep" || id === "sourceFrame" || id === "cpuBest") {
        expect(preset).toMatchObject({ backend: "canvas", cpuIncremental: true,
          gpuCommands: true, textCache: "gpu", idleCadence: "display" });
      } else expect(preset.idleCadence).toBe("authored");
    }
    for (const [id, preset] of Object.entries(RENDERER_COMPARISON_PRESETS)) {
      expect(preset.structureReuse).toBe(id === "cpuPrep" || id === "sourceFrame" || id === "cpuBest");
      expect(preset.textPreparationReuse).toBe(id === "cpuPrep" || id === "sourceFrame" || id === "cpuBest");
      expect(preset.sourceFrameReuse).toBe(id === "sourceFrame" || id === "cpuBest");
    }
    expect(RENDERER_COMPARISON_PRESETS.preserved.pixels).toBe("dirty-preserved");
    expect(RENDERER_COMPARISON_PRESETS.copy.pixels).toBe("dirty-copy");
  });

  it("does not replace reactive actual config for identical paint reports", () => {
    const config = { backend: "canvas" as const, cpuIncremental: true, gpuCommands: true,
      textCache: "off" as const, pixels: "dirty" as const, idleCadence: "authored" as const, structureReuse: false, textPreparationReuse: false, sourceFrameReuse: false, animationReferenceReuse: false, pixiScene: "retained" as const, pixiText: "native" as const };
    setRendererRuntimeStatus({ actualConfig: config });
    const first = rendererRuntimeStatus.actualConfig;
    setRendererRuntimeStatus({ actualConfig: { ...config } });
    expect(rendererRuntimeStatus.actualConfig).toBe(first);
    setRendererRuntimeStatus({ actualConfig: { ...config, sourceFrameReuse: true } });
    expect(rendererRuntimeStatus.actualConfig).not.toBe(first);
    expect(rendererRuntimeStatus.actualConfig?.sourceFrameReuse).toBe(true);
  });

  it("applies a mode in this document while preserving the exact seat URL", () => {
    const before = { ...rendererComparisonConfig };
    const revision = rendererComparisonViewRevision.value;
    const replaceState = vi.fn();
    const location = { href: "http://192.168.1.5:5178/?name=Ann%20Lee&quality=low#game" };
    const next = { ...RENDERER_COMPARISON_PRESETS.layers, textCache: "gpu" as const };
    try {
      applyRendererComparisonConfig(next, { location, history: { state: { keep: true }, replaceState } });
      const url = new URL(replaceState.mock.calls[0][2] as string);
      expect(url.searchParams.get("name")).toBe("Ann Lee");
      expect(url.searchParams.get("quality")).toBe("low");
      expect(url.hash).toBe("#game");
      expect(readRendererComparisonConfig(url.search)).toEqual(next);
      expect(rendererComparisonConfig).toEqual(next);
      expect(rendererComparisonViewRevision.value).toBe(revision + 1);
      expect(rendererRuntimeStatus.phase).toBe("initializing");
      expect(rendererRuntimeStatus.requested).toEqual(next);
      expect(replaceState.mock.calls[0][0]).toEqual({ keep: true });
    } finally {
      Object.assign(rendererComparisonConfig, before);
      rendererComparisonViewRevision.value = revision;
    }
  });

  it("keeps an admitted animated-frame flag and preserves the seat during Apply", () => {
    const before = { ...rendererComparisonConfig };
    const revision = rendererComparisonViewRevision.value;
    const replaceState = vi.fn();
    const location = { href: "http://localhost/?name=Ann&quality=low&animation=off#game" };
    const next = RENDERER_COMPARISON_PRESETS.sourceFrame;
    try {
      applyRendererComparisonConfig(next, { location, history: { state: null, replaceState } });
      const url = new URL(replaceState.mock.calls[0][2] as string);
      expect(url.searchParams.get("cmpSource")).toBe("reuse");
      expect(url.searchParams.get("name")).toBe("Ann");
      expect(url.searchParams.get("animation")).toBe("off");
      expect(readRendererComparisonConfig(url.search)).toEqual(next);
      expect(rendererComparisonViewRevision.value).toBe(revision + 1);
      expect(rendererRuntimeStatus.requested.sourceFrameReuse).toBe(true);
    } finally {
      Object.assign(rendererComparisonConfig, before);
      rendererComparisonViewRevision.value = revision;
    }
  });
});
