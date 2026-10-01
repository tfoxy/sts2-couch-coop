import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import RendererComparisonPanel from "@/mirror/RendererComparisonPanel.vue";
import { rendererComparisonConfig, rendererComparisonViewRevision, rendererRuntimeStatus,
  RENDERER_COMPARISON_PRESETS, setRendererRuntimeStatus } from "@/mirror/rendererComparison";
import { setComparisonStageBackend } from "@/mirror/rendererFactory";

describe("renderer comparison panel", () => {
  it("distinguishes requested text mode from admitted mixed labels without adding a setting", () => {
    const before = { ...rendererComparisonConfig }, status = { ...rendererRuntimeStatus };
    const config = { ...RENDERER_COMPARISON_PRESETS.pixi, pixiText: "slug-cached" as const };
    Object.assign(rendererComparisonConfig, config);
    setRendererRuntimeStatus({ requested: config, actualConfig: config, actualBackend: "pixi", phase: "active",
      pixiText: { requested: "slug-cached", actual: "mixed", native: 1, slug: 2, slugCached: 10,
        reasons: { coverage: 1, opacity: 2 } } });
    const wrapper = mount(RendererComparisonPanel);
    try {
      const text = wrapper.find(".comparison-status").text();
      expect(text).toContain("PIXI · retained · slug-cached");
      expect(text).toContain("Running: PIXI · retained · mixed");
      expect(wrapper.find('[data-testid="pixi-text-fallbacks"]').text()).toContain("coverage: 1");
      expect(wrapper.find('[data-testid="pixi-text-fallbacks"]').text()).toContain("opacity: 2");
      expect(wrapper.find('select[data-testid="renderer-pixi-text"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="renderer-preset"]').element).toHaveProperty("value", "custom");
    } finally {
      wrapper.unmount(); Object.assign(rendererComparisonConfig, before); setRendererRuntimeStatus(status);
    }
  });

  it("reports the Pixi scene mode and permits its shared cadence without adding scene controls", async () => {
    const before = { ...rendererComparisonConfig }, status = { ...rendererRuntimeStatus };
    const config = { ...RENDERER_COMPARISON_PRESETS.pixi, pixiScene: "legacy" as const };
    Object.assign(rendererComparisonConfig, config);
    setRendererRuntimeStatus({ requested: config, actualConfig: config, actualBackend: "pixi", phase: "active" });
    const wrapper = mount(RendererComparisonPanel);
    try {
      expect(wrapper.find(".comparison-status").text()).toContain("PIXI · legacy");
      expect(wrapper.find('[data-testid="renderer-idle-cadence"]').attributes("disabled")).toBeUndefined();
      expect(wrapper.find('[data-testid="renderer-scene"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="renderer-preset"]').element).toHaveProperty("value", "custom");
      await wrapper.find('[data-testid="renderer-idle-cadence"]').setValue("display");
      expect(rendererComparisonConfig.pixiScene).toBe("legacy");
      expect(rendererComparisonConfig.idleCadence).toBe("authored");
    } finally {
      wrapper.unmount(); Object.assign(rendererComparisonConfig, before); setRendererRuntimeStatus(status);
    }
  });

  it("keeps unaccepted experiments out of CPU best verified", async () => {
    const wrapper = mount(RendererComparisonPanel);
    await wrapper.find('[data-testid="renderer-preset"]').setValue("cpuBest");
    expect((wrapper.find('[data-testid="renderer-preset"]').element as HTMLSelectElement).value).toBe("cpuBest");
    expect(RENDERER_COMPARISON_PRESETS.cpuBest).toEqual(RENDERER_COMPARISON_PRESETS.sourceFrame);
    expect((wrapper.find('[data-testid="renderer-animation-reference-reuse"]').element as HTMLInputElement).checked).toBe(false);
    wrapper.unmount();
  });
  it("offers every pixel strategy, keeps compatible toggles independent, and marks edits Custom", async () => {
    const wrapper = mount(RendererComparisonPanel);
    expect(wrapper.findAll('[data-testid="renderer-pixels"] option').map((option) => option.attributes("value")))
      .toEqual(["direct", "dirty", "dirty-preserved", "dirty-copy", "layers", "surfaces"]);
    await wrapper.find('[data-testid="renderer-preset"]').setValue("layers");
    expect((wrapper.find('[data-testid="renderer-pixels"]').element as HTMLSelectElement).value).toBe("layers");
    const textCache = wrapper.findAll('input[type="checkbox"]')[2];
    expect(textCache.attributes("disabled")).toBeUndefined();
    await textCache.setValue(true);
    expect((wrapper.find('[data-testid="renderer-preset"]').element as HTMLSelectElement).value).toBe("custom");
    expect(wrapper.find('[data-testid="renderer-apply"]').attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("applies a preset by remounting the scene view without navigating the page", async () => {
    const before = { ...rendererComparisonConfig };
    const revision = rendererComparisonViewRevision.value;
    window.history.replaceState(null, "", "/?name=Ann&rendererCompare=1");
    const wrapper = mount(RendererComparisonPanel);
    try {
      await wrapper.find('[data-testid="renderer-preset"]').setValue("layers");
      await wrapper.find('[data-testid="renderer-apply"]').trigger("click");
      expect(rendererComparisonViewRevision.value).toBe(revision + 1);
      expect(rendererComparisonConfig.pixels).toBe("layers");
      expect(new URL(window.location.href).searchParams.get("name")).toBe("Ann");
      expect((wrapper.find('[data-testid="renderer-preset"]').element as HTMLSelectElement).value).toBe("layers");
      expect(wrapper.find('[data-testid="renderer-apply"]').attributes("disabled")).toBeDefined();
      expect(wrapper.text()).toContain("Your seat stays connected");
    } finally {
      wrapper.unmount();
      Object.assign(rendererComparisonConfig, before);
      rendererComparisonViewRevision.value = revision;
      setComparisonStageBackend(before.backend);
      window.history.replaceState(null, "", "/");
    }
  });

  it.each(["canvas", "pixi", "rust"] as const)("retries failed %s without selecting DOM", async (backend) => {
    const before = { ...rendererComparisonConfig }, status = { ...rendererRuntimeStatus };
    const revision = rendererComparisonViewRevision.value;
    const requested = { ...RENDERER_COMPARISON_PRESETS[backend] };
    Object.assign(rendererComparisonConfig, requested);
    setComparisonStageBackend(backend);
    setRendererRuntimeStatus({ requested, actualBackend: backend, actualConfig: null,
      phase: "failed", reason: "context lost" });
    const wrapper = mount(RendererComparisonPanel);
    try {
      await wrapper.find('[data-testid="renderer-recover"]').trigger("click");
      expect(rendererComparisonViewRevision.value).toBe(revision + 1);
      expect(rendererComparisonConfig.backend).toBe(backend);
      expect(rendererRuntimeStatus.requested.backend).toBe(backend);
      expect(rendererRuntimeStatus.phase).toBe("initializing");
    } finally {
      wrapper.unmount();
      Object.assign(rendererComparisonConfig, before);
      rendererComparisonViewRevision.value = revision;
      setComparisonStageBackend(before.backend);
      setRendererRuntimeStatus(status);
      window.history.replaceState(null, "", "/");
    }
  });

  it("offers independent CPU preparation switches and the combined preset", async () => {
    const wrapper = mount(RendererComparisonPanel);
    await wrapper.find('[data-testid="renderer-preset"]').setValue("cpuPrep");
    const structure = wrapper.find('[data-testid="renderer-structure-reuse"]');
    const textPreparation = wrapper.find('[data-testid="renderer-text-preparation-reuse"]');
    expect((structure.element as HTMLInputElement).checked).toBe(true);
    expect((textPreparation.element as HTMLInputElement).checked).toBe(true);
    await textPreparation.setValue(false);
    expect((wrapper.find('[data-testid="renderer-preset"]').element as HTMLSelectElement).value).toBe("custom");
    expect((structure.element as HTMLInputElement).checked).toBe(true);
    wrapper.unmount();
  });

  it("offers animated-frame reuse independently of the other preparation switches", async () => {
    const wrapper = mount(RendererComparisonPanel);
    await wrapper.find('[data-testid="renderer-preset"]').setValue("sourceFrame");
    const source = wrapper.find('[data-testid="renderer-source-frame-reuse"]');
    expect((source.element as HTMLInputElement).checked).toBe(true);
    expect((wrapper.find('[data-testid="renderer-preset"]').element as HTMLSelectElement).value).toBe("sourceFrame");
    await source.setValue(false);
    expect((wrapper.find('[data-testid="renderer-preset"]').element as HTMLSelectElement).value).toBe("cpuPrep");
    await source.setValue(true);
    await wrapper.find('[data-testid="renderer-structure-reuse"]').setValue(false);
    expect((wrapper.find('[data-testid="renderer-preset"]').element as HTMLSelectElement).value).toBe("custom");
    await wrapper.findAll('input[type="checkbox"]')[0].setValue(false);
    expect((source.element as HTMLInputElement).checked).toBe(false);
    expect(source.attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("labels the admitted animated-frame flag in the running mode", () => {
    const before = { ...rendererRuntimeStatus };
    try {
      setRendererRuntimeStatus({ requested: RENDERER_COMPARISON_PRESETS.sourceFrame,
        actualBackend: "canvas", actualConfig: RENDERER_COMPARISON_PRESETS.sourceFrame,
        phase: "active", reason: null });
      const wrapper = mount(RendererComparisonPanel);
      expect(wrapper.find(".comparison-status").text()).toContain("Running: Canvas");
      expect(wrapper.find(".comparison-status").text()).toContain("Reuse animated-frame geometry");
      wrapper.unmount();
    } finally {
      setRendererRuntimeStatus(before);
    }
  });

  it("offers reference animation patches without changing the other controls", async () => {
    const wrapper = mount(RendererComparisonPanel);
    try {
      await wrapper.find('[data-testid="renderer-preset"]').setValue("sourceFrame");
      const reference = wrapper.find('[data-testid="renderer-animation-reference-reuse"]');
      expect((reference.element as HTMLInputElement).checked).toBe(false);
      await reference.setValue(true);
      expect((wrapper.find('[data-testid="renderer-source-frame-reuse"]').element as HTMLInputElement).checked).toBe(true);
      expect((wrapper.find('[data-testid="renderer-preset"]').element as HTMLSelectElement).value).toBe("custom");
      await wrapper.findAll('input[type="checkbox"]')[0].setValue(false);
      expect((reference.element as HTMLInputElement).checked).toBe(false);
      expect(reference.attributes("disabled")).toBeDefined();
    } finally { wrapper.unmount(); }
  });
});
