<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, type WritableComputedRef } from "vue";
import { translate as t } from "@/i18n";

import { REPRO_UI_ENABLED } from "@/mirror/buildFlags";
import type { MirrorLatency } from "@/mirror/mirrorClient";
import SettingsHelpTip from "@/mirror/SettingsHelpTip.vue";
import {
  EFFECT_MODES,
  mirrorSettings,
  persistMirrorSetting,
  REFRESH_RATE_MAX,
  REFRESH_RATE_MIN,
  type EffectMode,
  type MirrorSettings,
  type PersistedSettingKey
} from "@/mirror/mirrorSettings";

// Panel labels for the per-viewer effect modes (Dynamic / ½ / ¼ / Static / Off), in EFFECT_MODES order.
const EFFECT_MODE_LABELS: Record<EffectMode, "settings.dynamic" | "settings.dynamicHalf" | "settings.dynamicQuarter" | "settings.static" | "settings.off"> = {
  dynamic: "settings.dynamic",
  "dynamic-half": "settings.dynamicHalf",
  "dynamic-quarter": "settings.dynamicQuarter",
  static: "settings.static",
  off: "settings.off"
};

// The mirror's OWN chrome (NOT a game-scene element): the settings DROPDOWN, hanging from the gear button at the
// top centre (@/components/SettingsGearButton, mounted by MirrorApp — in-game inside the scaled stage so it lands
// in the game's TopBar, on the picker as browser-space chrome). The panel itself is always browser-space fixed
// (outside the scaled 1920x1080 stage) so its text never scales with the game; it hangs from the pressed button's
// measured bottom edge (`panelAnchorTop`) and scrolls within whatever height is left below it.
//
// Splits into CLIENT render toggles (applied purely here) and SERVER settings (sent to the game instance this
// viewer's connection is served by, via the `settings` channel — MirrorApp watches the store and forwards them).
// The latency readout shows both the network RTT and the game end-to-end RTT (measured only while this panel is
// open).
//
// EVERY row explains itself through a "?" tip (SettingsHelpTip) instead of the permanent note paragraphs this
// panel used to carry: those covered fewer than half the rows and were a large share of the panel's HEIGHT, which
// on a phone pushed the bottom of the dropdown off the screen. One always-on note survives — the "Host
// performance" one — because what those three checkboxes DO changes with `directView`, and a viewer must not have
// to open a tip to discover they are freezing the host's own screen.
//
// `directView` = this viewer has no per-seat headless instance; they are watching the HOST's own game in place (a
// singleplayer run, or the [Host] row). Defaults false so a bare `mount(SettingsPanel)` (and any caller that
// predates the prop) reads as the headless case.
const props = withDefaults(
  defineProps<{
    latency: MirrorLatency;
    directView?: boolean;
  }>(),
  {
    directView: false
  }
);

const settings = mirrorSettings;

// A two-way binding for a SAVED field: writes the store (as v-model always did) and remembers the new value for
// the next page load. Deliberately a computed SETTER rather than a `@change` handler or a watch on the store: the
// setter runs only when a control in THIS panel is operated, which is exactly the "explicit user change" rule the
// storage layer wants. A store mutation from anywhere else — the host's reported refresh rate, a URL override,
// the per-connection freeze seeding — must never be mistaken for a preference.
function bind<K extends PersistedSettingKey>(key: K): WritableComputedRef<MirrorSettings[K]> {
  return computed({
    get: () => settings[key],
    set: (value) => {
      settings[key] = value;
      persistMirrorSetting(key, value);
    }
  });
}

const shaderMode = bind("shaderMode");
const particleMode = bind("particleMode");
const staticBgEnabled = bind("staticBgEnabled");
const stretchEnabled = bind("stretchEnabled");
const raiseHeldCard = bind("raiseHeldCard");
const unfocusOnRelease = bind("unfocusOnRelease");
const tapToFocus = bind("tapToFocus");
const confirmTap = bind("confirmTap");
const raiseHandCards = bind("raiseHandCards");
const uiScaling = bind("uiScaling");
const backstopOcclusion = bind("backstopOcclusion");
const refreshRate = bind("refreshRate");
const tweenReplay = bind("tweenReplay");
const latencyOverlay = bind("latencyOverlay");
const reproRecorder = bind("reproRecorder");

// Whether THIS BUILD ships the repro recorder's row at all (buildFlags). A published build sets
// `VITE_REPRO_UI=off` and the row below — and its help tip — are compiled out, because a developer tool in an end
// user's settings panel is a support question waiting to happen. The flag is a module constant, so the `v-if` is
// a constant branch a production build can fold away.
const reproUiEnabled = REPRO_UI_ENABLED;

// Hang the dropdown off the gear that was pressed, and let it use the rest of the viewport (scrolling inside).
const panelStyle = computed(() => ({
  top: `${settings.panelAnchorTop}px`,
  maxHeight: `calc(100vh - ${settings.panelAnchorTop + 12}px)`
}));

const TARGET_MS = 50;

function fmt(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}ms`;
}

// Quick-pick refresh rates: the headless DEFAULT (24 — never changed on load) plus the smoother steps, up to the
// slider's 60 ceiling (the host applies it verbatim as Engine.MaxFps; the native panel's presets already match).
// The slider still covers the full 4..60 range for fine tuning; these are the one-tap common points (an opt-in
// lever — nothing here alters the default until the viewer taps).
const REFRESH_PRESETS = [24, 30, 40, 60] as const;

const networkOk = computed(() => props.latency.p95 !== null && props.latency.p95 <= TARGET_MS);
const hasGame = computed(() => props.latency.gameCount > 0);

// The "Host performance" section acts on whichever game serves this connection, and that changes what the freezes
// MEAN: on a per-seat headless instance nobody is looking at the frozen animation (the browser re-runs it), while
// under direct view the frozen game is the one on the host's TV.
const hostPerfNote = computed(() =>
  props.directView
    ? t("settings.hostOwn") : t("settings.hostHeadless")
);

// ---------------------------------------------------------------------------------------------------------
// Row help ("?" tips)
// ---------------------------------------------------------------------------------------------------------

type HelpId =
  | "shaders"
  | "particles"
  | "staticBg"
  | "stretch"
  | "raiseCard"
  | "unfocus"
  | "tapFocus"
  | "confirmTap"
  | "raiseHand"
  | "uiScaling"
  | "backstop"
  | "repro"
  | "refreshRate"
  | "tweenReplay"
  | "freezeParticles"
  | "freezeSpines"
  | "freezeDecor"
  | "networkRtt"
  | "gameRtt"
  | "latencyOverlay";

// One description per row: what it does, and what it trades (performance vs fidelity). Kept in ONE object so a
// row added without help text is obvious at review time.
const HELP_KEYS: Record<HelpId, import("@/i18n").MessageKey> = {
  shaders: "settings.help.shaders", particles: "settings.help.particles", staticBg: "settings.help.staticBg",
  stretch: "settings.help.stretch", raiseCard: "settings.help.raiseCard", unfocus: "settings.help.unfocus",
  tapFocus: "settings.help.tapFocus", confirmTap: "settings.help.confirmTap", raiseHand: "settings.help.raiseHand",
  uiScaling: "settings.help.uiScaling", backstop: "settings.help.backstop", repro: "settings.help.repro",
  refreshRate: "settings.help.refreshRate", tweenReplay: "settings.help.tweenReplay",
  freezeParticles: "settings.help.freezeParticles", freezeSpines: "settings.help.freezeSpines",
  freezeDecor: "settings.help.freezeDecor", networkRtt: "settings.help.networkRtt",
  gameRtt: "settings.help.gameRtt", latencyOverlay: "settings.help.latencyOverlay"
};

// ONE tip open at a time — the panel owns the state, the tip component is controlled.
const openHelp = ref<HelpId | null>(null);

function toggleHelp(id: HelpId): void {
  openHelp.value = openHelp.value === id ? null : id;
}

function closeHelp(): void {
  openHelp.value = null;
}

// The props for one row's tip, including its toggle handler. A template of 15 rows × 5 attributes is a worse
// place to hide a typo than one helper. `placement` flips the bubble upward for the bottom-most group, whose
// downward bubble the panel's own scroll box would clip.
function help(id: HelpId, label: string, placement: "below" | "above" = "below") {
  return {
    tipId: id,
    label,
    text: t(HELP_KEYS[id]),
    open: openHelp.value === id,
    placement,
    onToggle: () => toggleHelp(id)
  };
}

// A press anywhere that is not part of the help UI closes the open tip — including a press on the very control
// the tip explains, because reading the tip and then flipping the switch is one gesture, not two.
// `data-settings-help` marks the tip's own button + bubble, so pressing ANOTHER row's icon swaps tips rather than
// closing first and re-opening on the next tap.
function onDocumentPointerDown(event: Event): void {
  const target = event.target;
  if (target instanceof Element && target.closest("[data-settings-help]")) {
    return;
  }
  closeHelp();
}

// Listeners exist only while a tip is open (no idle cost for a panel nobody is reading). Scroll is captured at the
// window so the panel's OWN scroll container counts too: a bubble is anchored to its row, so a scroll would leave
// it pointing at a different one.
function setHelpListeners(on: boolean): void {
  if (typeof document === "undefined") {
    return;
  }
  if (on) {
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    window.addEventListener("scroll", closeHelp, true);
  } else {
    document.removeEventListener("pointerdown", onDocumentPointerDown, true);
    window.removeEventListener("scroll", closeHelp, true);
  }
}

watch(openHelp, (id) => setHelpListeners(id !== null));

// Closing the panel closes the tip with it — re-opening to find a stale bubble hovering over a row is exactly the
// kind of ghost that makes chrome feel broken, and the gear that closes the panel is outside this component's DOM
// (so the outside-press rule above never sees it).
watch(
  () => settings.panelOpen,
  (open) => {
    if (!open) {
      closeHelp();
    }
  }
);

onBeforeUnmount(() => setHelpListeners(false));
</script>

<template>
  <div class="settings-chrome" data-testid="mirror-settings">
    <section
      v-if="settings.panelOpen"
      class="settings-panel"
      :style="panelStyle"
      data-testid="mirror-settings-panel"
      @scroll="closeHelp"
    >
      <h2 class="settings-heading">{{ t('app.mirror') }} {{ t('common.settings') }}</h2>

      <div class="settings-group">
        <p class="settings-group-label">{{ t('settings.thisDevice') }}</p>
        <div class="settings-item">
          <label class="settings-row settings-row-select">
            <span>{{ t('settings.shaders') }}</span>
            <select v-model="shaderMode" data-testid="mirror-shader-mode">
              <option v-for="mode in EFFECT_MODES" :key="mode" :value="mode">{{ t(EFFECT_MODE_LABELS[mode]) }}</option>
            </select>
          </label>
          <SettingsHelpTip v-bind="help('shaders', t('settings.shaders'))" />
        </div>
        <div class="settings-item">
          <label class="settings-row settings-row-select">
            <span>{{ t('settings.particles') }}</span>
            <select v-model="particleMode" data-testid="mirror-particle-mode">
              <option v-for="mode in EFFECT_MODES" :key="mode" :value="mode">{{ t(EFFECT_MODE_LABELS[mode]) }}</option>
            </select>
          </label>
          <SettingsHelpTip v-bind="help('particles', t('settings.particles'))" />
        </div>
        <div class="settings-item">
          <label class="settings-row">
            <input type="checkbox" v-model="staticBgEnabled" data-testid="mirror-static-bg" />
            <span>{{ t('settings.staticBg') }}</span>
          </label>
          <SettingsHelpTip v-bind="help('staticBg', t('settings.staticBg'))" />
        </div>
        <div class="settings-item">
          <label class="settings-row">
            <input type="checkbox" v-model="stretchEnabled" />
            <span>{{ t('settings.stretch') }}</span>
          </label>
          <SettingsHelpTip v-bind="help('stretch', t('settings.stretch'))" />
        </div>
        <div class="settings-item">
          <label class="settings-row">
            <input type="checkbox" v-model="raiseHeldCard" />
            <span>{{ t('settings.raiseCard') }}</span>
          </label>
          <SettingsHelpTip v-bind="help('raiseCard', t('settings.raiseCard'))" />
        </div>
        <div class="settings-item">
          <label class="settings-row">
            <input type="checkbox" v-model="unfocusOnRelease" />
            <span>{{ t('settings.unfocus') }}</span>
          </label>
          <SettingsHelpTip v-bind="help('unfocus', t('settings.unfocus'))" />
        </div>
        <div class="settings-item">
          <label class="settings-row">
            <input type="checkbox" v-model="tapToFocus" />
            <span>{{ t('settings.tapFocus') }}</span>
          </label>
          <SettingsHelpTip v-bind="help('tapFocus', t('settings.tapFocus'))" />
        </div>
        <div class="settings-item">
          <label class="settings-row">
            <input type="checkbox" v-model="confirmTap" data-testid="mirror-confirm-tap" />
            <span>{{ t('settings.confirmTap') }}</span>
          </label>
          <SettingsHelpTip v-bind="help('confirmTap', t('settings.confirmTap'))" />
        </div>
        <div class="settings-item">
          <label class="settings-row">
            <input type="checkbox" v-model="raiseHandCards" data-testid="mirror-raise-hand" />
            <span>{{ t('settings.raiseHand') }}</span>
          </label>
          <SettingsHelpTip v-bind="help('raiseHand', t('settings.raiseHand'))" />
        </div>
        <div class="settings-item">
          <label class="settings-row">
            <input type="checkbox" v-model="uiScaling" data-testid="mirror-ui-scaling" />
            <span>{{ t('settings.uiScaling') }}</span>
          </label>
          <SettingsHelpTip v-bind="help('uiScaling', t('settings.uiScaling'))" />
        </div>
        <div class="settings-item">
          <label class="settings-row">
            <input
              type="checkbox"
              v-model="backstopOcclusion"
              data-testid="mirror-backstop-occlusion"
            />
            <span>{{ t('settings.backstop') }}</span>
          </label>
          <SettingsHelpTip v-bind="help('backstop', t('settings.backstop'))" />
        </div>
        <!-- DIAGNOSTIC, and last in the group on purpose: it is not a preference about how the game looks. The
             whole row (and its tip) is compiled out of a build with VITE_REPRO_UI=off — see `reproUiEnabled`. -->
        <div v-if="reproUiEnabled" class="settings-item">
          <label class="settings-row">
            <input type="checkbox" v-model="reproRecorder" data-testid="mirror-repro-recorder" />
            <span>{{ t('settings.repro') }}</span>
          </label>
          <SettingsHelpTip v-bind="help('repro', t('settings.repro'))" />
        </div>
      </div>

      <div class="settings-group">
        <p class="settings-group-label">{{ t('settings.streamThisPlayer') }}</p>
        <div class="settings-item settings-item-top">
          <label class="settings-row settings-row-slider">
            <span>{{ t('settings.refreshRate') }}</span>
            <input
              type="range"
              :min="REFRESH_RATE_MIN"
              :max="REFRESH_RATE_MAX"
              step="1"
              v-model.number="refreshRate"
            />
            <span class="settings-value">{{ settings.refreshRate }} fps</span>
          </label>
          <SettingsHelpTip v-bind="help('refreshRate', t('settings.refreshRate'))" />
        </div>
        <!-- Quick presets alongside the slider so the common choices are one tap on a phone. Lowering the rate
             slows scene UPDATES (less phone + host CPU) while card motion stays smooth via CSS tween replay —
             the lever to reach for on a weak device; 30/40 are smoother if the device can spare it. -->
        <div class="settings-presets" role="group" :aria-label="t('settings.refreshPresets')">
          <button
            v-for="preset in REFRESH_PRESETS"
            :key="preset"
            type="button"
            class="settings-preset"
            :class="{ 'settings-preset-active': settings.refreshRate === preset }"
            :aria-pressed="settings.refreshRate === preset"
            @click="refreshRate = preset"
          >
            {{ preset }}
          </button>
        </div>
        <div class="settings-item">
          <label class="settings-row">
            <input type="checkbox" v-model="tweenReplay" data-testid="mirror-tween-replay" />
            <span>{{ t('settings.tweenReplay') }}</span>
          </label>
          <SettingsHelpTip v-bind="help('tweenReplay', t('settings.tweenReplay'))" />
        </div>
      </div>

      <div class="settings-group">
        <p class="settings-group-label">{{ t('settings.hostPerformance') }}</p>
        <!-- The one surviving always-on note: `directView` changes what these three checkboxes do (they freeze
             the host's own screen), which is not something a viewer should have to open a tip to discover. -->
        <p class="settings-group-note" data-testid="mirror-host-perf-note">{{ hostPerfNote }}</p>
        <div class="settings-item">
          <label class="settings-row">
            <input type="checkbox" v-model="settings.freezeParticles" data-testid="mirror-freeze-particles" />
            <span>{{ t('settings.freezeParticles') }}</span>
          </label>
          <SettingsHelpTip v-bind="help('freezeParticles', t('settings.freezeParticles'))" />
        </div>
        <div class="settings-item">
          <label class="settings-row">
            <input type="checkbox" v-model="settings.freezeSpines" data-testid="mirror-freeze-spines" />
            <span>{{ t('settings.freezeSpines') }}</span>
          </label>
          <SettingsHelpTip v-bind="help('freezeSpines', t('settings.freezeSpines'))" />
        </div>
        <div class="settings-item">
          <label class="settings-row settings-row-advanced">
            <input type="checkbox" v-model="settings.freezeDecor" data-testid="mirror-freeze-decor" />
            <span>{{ t('settings.freezeDecor') }} <em>{{ t('settings.advancedSuffix') }}</em></span>
          </label>
          <SettingsHelpTip v-bind="help('freezeDecor', t('settings.freezeDecor'))" />
        </div>
      </div>

      <div class="settings-group settings-latency" data-testid="mirror-settings-latency">
        <p class="settings-group-label">{{ t('settings.latency') }}</p>
        <div class="settings-item">
          <div class="settings-latency-row" :class="{ 'latency-ok': networkOk, 'latency-bad': !networkOk }">
            <span class="settings-latency-name">{{ t('settings.networkRtt') }}</span>
            <span class="settings-latency-stat">p50 {{ fmt(latency.p50) }}</span>
            <span class="settings-latency-stat">p95 {{ fmt(latency.p95) }}</span>
          </div>
          <SettingsHelpTip v-bind="help('networkRtt', t('settings.networkRtt'), 'above')" />
        </div>
        <div class="settings-item">
          <div class="settings-latency-row">
            <span class="settings-latency-name">{{ t('settings.gameEndToEnd') }}</span>
            <template v-if="hasGame">
              <span class="settings-latency-stat">p50 {{ fmt(latency.gameP50) }}</span>
              <span class="settings-latency-stat">p95 {{ fmt(latency.gameP95) }}</span>
            </template>
            <span v-else class="settings-latency-stat">—</span>
          </div>
          <SettingsHelpTip v-bind="help('gameRtt', t('settings.gameRtt'), 'above')" />
        </div>
        <!-- The same numbers as a floating on-screen overlay that stays up with this panel CLOSED (native parity:
             the client's own overlay checkbox). MirrorApp keeps the ping probe running while it's on. -->
        <div class="settings-item">
          <label class="settings-row">
            <input type="checkbox" v-model="latencyOverlay" data-testid="mirror-latency-overlay" />
            <span>{{ t('settings.latencyOverlay') }}</span>
          </label>
          <SettingsHelpTip v-bind="help('latencyOverlay', t('settings.latencyOverlay'), 'above')" />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* A pass-through wrapper: the wrapper itself never eats game input; only the panel is interactive. */
.settings-chrome {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  pointer-events: none;
}

/* DROPDOWN: hangs from the gear button at the top centre. `top`/`max-height` are set inline from the button's
   measured bottom edge (see panelStyle) — the in-game gear rides the scaled stage, so its on-screen bottom moves
   with the display and a hardcoded offset would cover the button itself. */
.settings-panel {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  width: 244px;
  overflow-y: auto;
  /* Momentum scrolling on iOS for the capped-height dropdown. */
  -webkit-overflow-scrolling: touch;
  pointer-events: auto;
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(14, 17, 23, 0.92);
  color: #eee;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14), 0 8px 24px rgba(0, 0, 0, 0.5);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 13px;
  line-height: 1.3;
  user-select: none;
}

.settings-heading {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.settings-group {
  padding: 8px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.settings-group-label {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.6;
}

.settings-group-note {
  margin: -2px 0 6px;
  font-size: 11px;
  line-height: 1.25;
  opacity: 0.55;
}

/* One ROW = its control plus the "?" that explains it. `relative` is what the tip's bubble hangs from, so an open
   tip overlays the rows below instead of re-flowing the panel (opening one must never move the control the
   viewer's thumb is already on). */
.settings-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* Multi-line rows (the refresh slider) keep the "?" on the LABEL's line rather than centred on the whole block. */
.settings-item-top {
  align-items: flex-start;
}

.settings-item > .settings-row,
.settings-item > .settings-latency-row {
  flex: 1 1 auto;
  min-width: 0;
}

.settings-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  cursor: pointer;
}

.settings-row input[type="checkbox"] {
  cursor: pointer;
}

/* Effect-mode rows: label on the left, the segmented <select> filling the rest. */
.settings-row-select {
  justify-content: space-between;
}

.settings-row-select select {
  flex: 0 0 auto;
  min-width: 108px;
  padding: 3px 6px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 6px;
  background: rgba(20, 24, 32, 0.9);
  color: #eee;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.settings-row-slider {
  flex-wrap: wrap;
}

.settings-row-slider input[type="range"] {
  flex: 1 1 100%;
  cursor: pointer;
}

/* Refresh-rate quick-pick chips under the slider. */
.settings-presets {
  display: flex;
  gap: 6px;
  padding: 4px 0 2px;
}

.settings-preset {
  flex: 1 1 auto;
  padding: 3px 0;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
  color: #ddd;
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}

.settings-preset:hover {
  background: rgba(255, 255, 255, 0.1);
}

.settings-preset-active {
  background: rgba(90, 150, 240, 0.32);
  border-color: rgba(120, 175, 255, 0.7);
  color: #fff;
}

.settings-value {
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
}

.settings-row-advanced {
  opacity: 0.78;
}

.settings-row-advanced em {
  font-style: normal;
  opacity: 0.6;
  font-size: 11px;
}

.settings-latency-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 2px 0;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px;
}

.settings-latency-name {
  flex: 1 1 auto;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  opacity: 0.75;
}

.settings-latency-stat {
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
}

.settings-latency-row.latency-ok .settings-latency-stat {
  color: #2ecc71;
}

.settings-latency-row.latency-bad .settings-latency-stat {
  color: #e74c3c;
}
</style>
