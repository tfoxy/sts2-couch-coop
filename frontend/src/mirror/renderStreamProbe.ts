// DEV ONLY — the new renderer's live probe page (render-stream-probe.html). MirrorApp cannot show a scene without a
// game, so this mounts the two pieces MIR-2 adds on their own: the real SettingsPanel (whose checkbox is the
// toggle) and RenderStreamStage, against the `?renderStream=` QA endpoint, with the same renderer rule MirrorApp
// applies. `window.__renderStreamProbe` is the driver's seam: stats, statuses and the live renderer.
import { createApp, defineComponent, h, ref, watch } from "vue";
import type { RenderStreamStats, RenderStreamStatus } from "@godot-scene-web/render-stream-client";

import { createBrowserI18n } from "@/i18n";
import type { MirrorLatency } from "@/mirror/mirrorClient";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import RenderStreamStage from "@/mirror/RenderStreamStage.vue";
import {
  renderStreamAvailability,
  renderStreamContext,
  stopRenderStream,
  syncRuntimeRenderer
} from "@/mirror/renderStreamAvailability";
import { renderStreamCoreConfig } from "@/mirror/renderStreamCore";
import SettingsPanel from "@/mirror/SettingsPanel.vue";

const latency: MirrorLatency = {
  lastMs: null, p50: null, p95: null, count: 0, gameLastMs: null, gameP50: null, gameP95: null, gameCount: 0
};

interface ProbeStatus { t: number; mount: number; status: RenderStreamStatus }

const statuses: ProbeStatus[] = [];
const failures: string[] = [];
let mounts = 0;
const stage = ref<{ stats(): Readonly<RenderStreamStats> } | null>(null);

const Probe = defineComponent({
  setup() {
    const core = renderStreamCoreConfig().core;
    watch(
      [() => mirrorSettings.renderer, renderStreamAvailability, () => renderStreamContext.stopped],
      () => syncRuntimeRenderer(mirrorSettings),
      { immediate: true }
    );
    watch(() => mirrorSettings.runtimeRenderer, (r) => { if (r === "stream") mounts += 1; }, { immediate: true });
    mirrorSettings.panelOpen = true;
    mirrorSettings.panelAnchorTop = 8;
    return () => {
      const availability = renderStreamAvailability.value;
      const streaming = mirrorSettings.runtimeRenderer === "stream" && availability.available && core !== null;
      return h("main", { style: "position: fixed; inset: 0" }, [
        streaming
          ? h(RenderStreamStage, {
            ref: stage,
            endpoint: availability.endpoint,
            core,
            onStatus: (status: RenderStreamStatus) => statuses.push({ t: performance.now(), mount: mounts, status }),
            onFailed: (reason: string) => { failures.push(reason); stopRenderStream(reason, mirrorSettings); }
          })
          : h("p", { "data-testid": "probe-old-renderer", style: "color: #888; font: 14px system-ui; margin: 16px" },
            `old renderer (availability: ${availability.reason ?? "available"})`),
        h(SettingsPanel, { latency })
      ]);
    };
  }
});

(window as unknown as { __renderStreamProbe?: unknown }).__renderStreamProbe = {
  statuses,
  failures,
  mounts: () => mounts,
  runtimeRenderer: () => mirrorSettings.runtimeRenderer,
  availability: () => ({ ...renderStreamAvailability.value, endpoint: undefined }),
  stats: () => (stage.value ? { ...stage.value.stats() } : null)
};

createApp(Probe).use(createBrowserI18n()).mount("#app");
