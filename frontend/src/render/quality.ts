// Render-quality tier: decides how much of the (GPU-bound) live WebGL effect pipeline runs on THIS
// device. Profiling an older
// laptop showed the pipeline is GPU-bound — the shader + particle WebGL canvases + their per-frame blits
// saturate a weak GPU (~86% busy, frame loop throttled to ~20fps), while the CPU sits >50% idle. This
// module picks a tier so low-end devices stay playable:
//
// THE LADDER, most expensive first. The five rungs are a single monotone scale, so the id, the `?quality=`
// value and the label the settings panel shows a player are all the same word:
//
//   high → full fidelity: full internal resolution (renderScale 1) with the per-frame effect loops
//          capped at 30fps (shaders, particles, spine clip playback). The caps are NOT a fidelity
//          cut — a phone trace showed the gsw shader/particle/spine loops re-rendering every rAF on
//          screens where nothing visibly changes, which is a pure idle tax (the effects are slow,
//          soft glows/drifts; 30fps of them is indistinguishable from 60). Resolution stays the
//          fidelity lever; fps is the idle lever. Override with `?shaderFps=0` / `?spineClipFps=0`
//          for uncapped (0 = uncapped) when debugging.
//   medium → keep the effects but cheap: half internal resolution (~4× less GPU fill + blit) + capped
//          shader/particle FPS. The big lever that preserves visuals; fine on most weak laptops.
//   low  → even cheaper, effects STILL on: one-eighth resolution (~64× less fill than high) but fps kept HIGH
//          (the empirical lever is renderScale, not fps — see tierConfig). For phones a GPU trace showed are
//          WebGL-fill-bound on `medium` — the step to try before dropping to `very-low`.
//   very-low → shaders render as a single FROZEN frame (the gsw runtime's staticShaders mode): the REAL shader,
//          run once at a pinned TIME, so cards/glows/transitions look correct (additive blends still glow) at
//          ~zero ongoing GPU cost. Particles off. Replaces a per-shader CSS approximation; the normal low-end
//          path on a weak phone GPU.
//   minimum → no live WebGL shaders or particles at all; nodes render via their CSS/SVG/texture fallback (a
//          shader-INPUT texture, e.g. an SDF, paints nothing rather than a gray blob — see nodeStyles). The floor
//          for WebGL-unavailable / software-WebGL-on-mobile / `?debug`. HSV feColorMatrix unaffected.
//
// RENAMED (the ladder above used to be high/low/min/static/off, which is not a ladder and puts the word "off" in
// front of a player as a quality level). `parseOverride` still accepts the three old spellings that map cleanly —
// `min`→low, `static`→very-low, `off`→minimum — so older links and bench invocations keep meaning what they meant.
// The one that cannot be aliased is `low`, which now names the rung below the one it used to.
//
// Tier comes from (in priority order): the `?debug` QA flag (always `minimum` — a headless/automated browser runs
// WebGL on the CPU), an explicit `?quality=high|medium|low|very-low|minimum` query override, THIS VIEWER'S SAVED
// PANEL CHOICE (mirrorSettings' `quality`, which is why auto-detection stops once a player picks a rung), or
// auto-detection from device signals. Auto-detection spans the full ladder: a DESKTOP only ever lands
// high/medium (a weak laptop stays medium, never silently low/minimum), but a MOBILE device can step down to
// low/very-low/minimum (phones are fill/thermal-limited under the CSS mirror) — see autoTier.
//
// WHAT A TIER STILL DECIDES (mirror): the per-effect fields below are a SEED, not a verdict. The mirror's
// settings panel owns the live effect mode per viewer (mirrorSettings' shaderMode/particleMode), and a given mode
// must behave identically on every device — so a `very-low`/`low` phone gets real particles the moment its viewer
// picks a particle mode, at the same fps cap and the same backing-store scale a desktop uses. The tier keeps the
// levers a panel mode does NOT express (spine clips, texture-upload cap, screen-texture capture) and the one
// clamp the panel cannot lift: the `minimum` lane (see shadersHardOff/particlesHardOff).
//
// Any resolved tier can be hand-tuned with query overrides (applied ON TOP of the tier), so a device's
// exact smooth point can be found live without a rebuild — e.g. on the phone:
//   ?renderScale=0.2   ?shaderFps=12   ?particleFps=8   ?shaders=off   ?particles=off
// (renderScale clamps to 0.05..1; an fps of 0 = uncapped; bools accept on/off/1/0/true/false.)

import { describeGpu, type GpuInfo } from "@godot-scene-web/html";

import { defaultSettingsStorage, readSettingsRecord } from "@/mirror/settingsStorage";

/** The quality ladder, most expensive first. See the header — one vocabulary for the id, `?quality=` and the
 *  label the settings panel shows. */
export type RenderQualityTier = "high" | "medium" | "low" | "very-low" | "minimum";

export const RENDER_QUALITY_TIERS: readonly RenderQualityTier[] = [
  "high",
  "medium",
  "low",
  "very-low",
  "minimum"
] as const;

export interface RenderQuality {
  tier: RenderQualityTier;
  /** tier !== "minimum" — when false, shader nodes fall back to CSS/texture and the runtime isn't created. */
  shadersEnabled: boolean;
  /** tier === "very-low" — shaders render as a single FROZEN frame (no per-frame loop). Below "low", above
   *  "minimum": correct stills for any shader at ~zero ongoing GPU cost (the gsw runtime's staticShaders mode). */
  shadersStatic: boolean;
  /** tier !== "minimum" — when false, particle nodes render nothing (no static preview in the mirror). */
  particlesEnabled: boolean;
  /** Whether THIS device fetches + plays Spine animation clips. A SpineSprite's clip is a multi-MB download
   *  (decode-heavy too), so weak/mobile tiers default OFF: the client degrades by NOT requesting the clip
   *  (the character renders nothing rather than the device hammering wifi). The whole fleet still gets ONE
   *  server-side clip encoding — this only gates the per-client FETCH, never the clip's size. Override with
   *  `?spineClips=on/off`. */
  spineClipsEnabled: boolean;
  /** Playback advance cap (fps) for clip frames between track-time syncs (0 = uncapped; the clip's own sample
   *  fps caps it anyway). A lever for weak devices that play clips but shouldn't repaint every rAF. */
  spineClipFps: number;
  /** Backing-store resolution multiplier handed to both gsw runtimes (0.5 on medium → ~4× cheaper fill). */
  renderScale: number;
  /** gsw shaderFps cap (0 = uncapped). */
  shaderFps: number;
  /** gsw particleFps cap. */
  particleFps: number;
  /** Cap (longest edge, px) for GL texture uploads — a bigger image (a full-screen background) is downscaled
   *  before texImage2D so it doesn't cost a ~250ms main-thread upload spike on load. Cards/small textures are
   *  well under it, so unaffected. */
  maxTextureDim: number;
  /** R14a — BUDGET (not a cap) on a synthesized CARD TRAIL's point list (0 = unbudgeted). The ribbon is rebuilt
   *  from every point on every sample, so its cost is linear in the list length — but since R14a the surplus is
   *  removed from the trail's INTERIOR (cardTrail.decimateTrailPoints) rather than off its tail, so a budgeted
   *  device gets the game's full arc drawn with fewer points instead of a comet cut short. Override with
   *  `?maxTrailPoints=`. */
  maxTrailPoints: number;
  /** Backing-store scale for the STATIC (frozen-frame) SHADER mode — see STATIC_SHADER_SCALE_MOBILE. */
  staticShaderScale: number;
  /** Backing-store scale for the STATIC (frozen-frame) PARTICLE mode — see STATIC_PARTICLE_SCALE_MOBILE. */
  staticParticleScale: number;
  /** Where the tier came from, for diagnostics. `stored` is this viewer's own panel choice, which — like
   *  `query` — takes the device out of auto-detection (see isAdaptiveEligible). */
  source: "debug" | "query" | "stored" | "auto" | "default";
}

// THE STATIC BACKING-STORE SCALES — the one place a phone still renders an effect smaller than a desktop does.
//
// `very-low` is a FROZEN frame, so it has no per-frame loop… but the producer streams scene-deltas continuously and a
// shader node whose uniforms jitter per delta misses the static-frame cache and RE-renders its one frame. At scale 1
// on a phone that is a full-resolution fragment pass per delta: an Aug-11 Mali-G57 trace of the MAP screen measured
// StartDrawToSwapStart p50 = 126ms (19× the 6.5ms of the previous build, which rendered the same frozen shaders at
// the `very-low` tier's 0.25) with 74% of frames dropped. Fill is quadratic in the scale, so 0.5 is ~4× cheaper and
// 0.25 ~16×; the visible cost is a slightly softer glow on a frozen backdrop.
//
// Desktops keep 1 (they were never fill-bound and a frozen frame is free there), so a mode still means the same
// THING everywhere — real shader, rendered once — it just doesn't insist on painting a phone's frozen backdrop at a
// resolution that phone cannot afford. "Phone" is the SAME mobile seam the tier ladder already uses
// (RenderQualitySignals.mobile — UA-CH `mobile`, else the UA regex), not a new sniff.
//
// A/B them live without a rebuild: `?staticScale=` (both families) or `?staticShaderScale=` / `?staticParticleScale=`
// (one each, and they win over `?staticScale=`). All clamp to 0.05..1, like `?renderScale=`.
// The card-trail POINT BUDGETS. Since R14a a budget bounds the point COUNT without shortening the trail — the
// surplus is decimated out of the ribbon's interior, so both tiers draw the game's whole arc and differ only in
// how finely it is sampled (measured on a full-length flight arc: 32 points track the true curve within ~1px, 48
// within ~0.5px). 32 is what a weak device can rebuild per sample; the high tier takes 48, which covers the
// longest arc a flight actually lays (36-49 points) while still bounding the pathological case.
export const TRAIL_POINT_BUDGET_WEAK = 32;
export const TRAIL_POINT_BUDGET_HIGH = 48;

export const STATIC_SCALE_DESKTOP = 1;
export const STATIC_SHADER_SCALE_MOBILE = 0.5;
export const STATIC_PARTICLE_SCALE_MOBILE = 0.25;

/** The tier-derived fields (everything except where the tier came from and the device-derived static scales). */
type TierConfig = Omit<RenderQuality, "tier" | "source" | "staticShaderScale" | "staticParticleScale">;

// GPU renderer substrings that indicate an integrated / mobile / old GPU likely to be fill-bound by
// full-screen fragment shaders. Deliberately conservative (a single match is one signal, not a verdict)
// and only consulted when the browser exposes an unmasked renderer string — masked/"" never matches.
const WEAK_GPU_RE =
  /\b(hd|uhd|iris)\s*graphics\b|\bgma\b|\bmali-[gt]\d|\badreno\b[^\d]*[2-5]\d\d\b|\bpowervr\b|\bvivante\b|\bllvmpipe\b|\bswiftshader\b/i;

export interface RenderQualitySignals {
  search: string;
  gpu: GpuInfo;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  /** Phone/tablet (UA-CH `mobile` or UA regex). Mobile GPUs are fill/thermal-limited under the CSS mirror, so
   *  the SAME weakness signals step FURTHER down the ladder than on desktop — this is what lets auto reach the
   *  bottom three rungs. */
  mobile?: boolean;
  /** This viewer's SAVED panel choice (mirrorSettings' `quality`), verbatim from storage — a tier name, "auto",
   *  or anything at all from a hand-edited blob, so it is validated here. Beaten by `?debug` and `?quality=`,
   *  beats auto-detection: a player who has picked a rung has taken this device out of detection. */
  storedQuality?: unknown;
}

function tierConfig(tier: RenderQualityTier): TierConfig {
  switch (tier) {
    case "minimum":
      return {
        shadersEnabled: false,
        shadersStatic: false,
        particlesEnabled: false,
        spineClipsEnabled: false,
        spineClipFps: 0,
        renderScale: 1,
        shaderFps: 0,
        particleFps: 0,
        maxTextureDim: 2048,
        maxTrailPoints: TRAIL_POINT_BUDGET_WEAK,
      };
    case "very-low":
      // Shaders ON but FROZEN (rendered once at a pinned TIME via the gsw runtime's staticShaders mode), so
      // there's no per-frame loop. But the producer streams scene-deltas continuously, and a shader node whose
      // uniforms jitter per delta misses the static-frame cache and RE-renders its one frame each time — so on a
      // weak GPU (Moto G86 / Mali-G57) renderScale still matters. Empirically 0.5 is playable there and 0.25 is
      // the safe floor (a blurrier glow, fine for the frozen background fidelity). Particles seed off here (a GPU
      // one-shot particle frame isn't meaningful as a SEED) — but see the hard-off note below: in the mirror the
      // settings panel can still turn them on, so the fps caps must be the shared 30 rather than the "irrelevant,
      // nothing runs" 0 this tier used to carry (0 means UNCAPPED, which would have made a phone that picked
      // Dynamic here run FASTER than a desktop). The cheapest tier that still shows real shaders.
      return {
        shadersEnabled: true,
        shadersStatic: true,
        particlesEnabled: false,
        spineClipsEnabled: false,
        spineClipFps: 0,
        renderScale: 0.25,
        shaderFps: 30,
        particleFps: 30,
        maxTextureDim: 2048,
        maxTrailPoints: TRAIL_POINT_BUDGET_WEAK,
      };
    case "medium":
      return {
        shadersEnabled: true,
        shadersStatic: false,
        particlesEnabled: true,
        spineClipsEnabled: true,
        spineClipFps: 30,
        renderScale: 0.5,
        shaderFps: 30,
        // 30 everywhere (was 25 here and on `low`). The effect fps caps are no longer a per-tier lever: the
        // mirror's panel picks the effect mode and the same mode must look the same on every device, so a
        // phone-only 25 was a hidden mobile/desktop divergence. RESOLUTION stays the per-device lever
        // (renderScale below, and the panel's ½/¼ modes); `?particleFps=`/`?shaderFps=` still override.
        particleFps: 30,
        maxTextureDim: 2048,
        maxTrailPoints: TRAIL_POINT_BUDGET_WEAK,
      };
    case "low":
      // Effects still ON, pushed as low as they go before disabling. Empirically (phone testing) the GPU lever
      // is RESOLUTION, not FPS: renderScale has a big GPU impact but is barely visible (blurrier glow), while
      // fps caps cost little GPU but choppiness is very visible — so drop renderScale hard (0.125 = ~64× less
      // fill than high) and keep fps high (25, a smooth floor). Tuned to a Moto-G86-class phone.
      return {
        shadersEnabled: true,
        shadersStatic: false,
        particlesEnabled: true,
        spineClipsEnabled: false,
        spineClipFps: 0,
        renderScale: 0.125,
        // 30, like every other live tier — see the `medium` note: same effect mode ⇒ same pacing on every device.
        shaderFps: 30,
        particleFps: 30,
        maxTextureDim: 2048,
        maxTrailPoints: TRAIL_POINT_BUDGET_WEAK,
      };
    default: // high — full resolution, effect loops capped at 30fps (see the module header).
      // The 30fps shader/spine caps replace the previous UNCAPPED (0) values. Uncapped meant every
      // TIME-reading shader and every spine clip re-rendered on every rAF forever, even on an idle
      // screen — a fixed per-frame cost a phone trace attributed to the gsw effect runtimes. The
      // effects themselves are slow (drifting glows, ambient loops), so 30fps looks the same while
      // halving that idle tax. Particles were already capped at 30. `?shaderFps=`/`?spineClipFps=`
      // still override, and 0 still means uncapped.
      return {
        shadersEnabled: true,
        shadersStatic: false,
        particlesEnabled: true,
        spineClipsEnabled: true,
        spineClipFps: 30,
        renderScale: 1,
        shaderFps: 30,
        particleFps: 30,
        maxTextureDim: 4096,
        maxTrailPoints: TRAIL_POINT_BUDGET_HIGH,
      };
  }
}

// THE HARD-OFF LANE — the one effect clamp a settings panel cannot lift.
//
// Everywhere else the tier only SEEDS what a viewer sees: the mirror's panel picks the live effect mode and the
// same mode must behave identically on every device (a phone that resolved to `very-low`/`low` gets working
// particles the moment its viewer asks for them). The exception is the `minimum` tier — `?debug`, an explicit
// `?quality=minimum`, and a software-WebGL phone — where there is no usable GPU path at all: creating the
// runtimes there would peg the CPU (SwiftShader) for nothing, so those effects stay dead however the panel is set.
//
// An EXPLICIT per-effect override still wins even there (`?quality=minimum&shaders=dynamic` re-enables shaders),
// because `applyOverrides` has already set the matching enable flag — which is exactly what these two read.
export function shadersHardOff(quality: RenderQuality): boolean {
  return quality.tier === "minimum" && !quality.shadersEnabled;
}

export function particlesHardOff(quality: RenderQuality): boolean {
  return quality.tier === "minimum" && !quality.particlesEnabled;
}

// The pre-rename spellings of three rungs, still accepted so a bookmarked QA link, a recorded bench cell or an
// older round note keeps selecting the SAME configuration it used to. There is deliberately no entry for the old
// `low`: that word is now the rung below the one it named, and an alias cannot say both things at once.
const LEGACY_TIER_NAMES: Record<string, RenderQualityTier> = {
  min: "low",
  static: "very-low",
  off: "minimum"
};

/** A tier name (or one of the legacy spellings above), or null for anything else. */
export function parseRenderQualityTier(raw: string | null | undefined): RenderQualityTier | null {
  const value = raw?.toLowerCase() ?? "";
  if ((RENDER_QUALITY_TIERS as readonly string[]).includes(value)) {
    return value as RenderQualityTier;
  }
  return LEGACY_TIER_NAMES[value] ?? null;
}

// Parse an explicit tier override. `?quality=high|medium|low|very-low|minimum`.
function parseOverride(search: string): RenderQualityTier | null {
  return parseRenderQualityTier(new URLSearchParams(search).get("quality"));
}

// A finite-number query param, or null when absent/unparseable.
function numParam(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key);
  if (raw === null) {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// A `?shaders=` / `?particles=` effect-mode override. The canonical values are the per-viewer effect modes:
// Dynamic / Static / Off plus the two web-only reduced-resolution dynamic variants. Returns null when the param
// is absent or unrecognized (leaves the tier default untouched). Kept as a local string union (not an import from
// `@/mirror/mirrorSettings`) to avoid a render↔mirror import cycle.
export type EffectModeParam = "dynamic" | "dynamic-half" | "dynamic-quarter" | "static" | "off";

/**
 * The EXPLICIT `?shaders=`/`?particles=` mode in a query string, or null when the param is absent/unparseable.
 *
 * Exposed because the tier fields alone can no longer reconstruct the viewer's request: particles seed `static`
 * from any tier that renders them (mirrorSettings.createMirrorSettings), so `?particles=dynamic` — which only ever
 * set `particlesEnabled` — would otherwise be indistinguishable from no param at all and could not win.
 */
export function effectModeOverride(search: string, key: string): EffectModeParam | null {
  return effectModeParam(new URLSearchParams(search), key);
}

function effectModeParam(params: URLSearchParams, key: string): EffectModeParam | null {
  if (!params.has(key)) {
    return null;
  }
  const raw = params.get(key)?.toLowerCase() ?? "";
  if (raw === "dynamic") {
    return "dynamic";
  }
  if (raw === "off") {
    return "off";
  }
  if (raw === "dynamic-half") {
    return "dynamic-half";
  }
  if (raw === "dynamic-quarter") {
    return "dynamic-quarter";
  }
  if (raw === "static") {
    return "static";
  }
  return null;
}

// A boolean query param (on/off/1/0/true/false; a bare `?key` = true), or null when absent/unparseable.
function boolParam(params: URLSearchParams, key: string): boolean | null {
  if (!params.has(key)) {
    return null;
  }
  const raw = params.get(key)?.toLowerCase();
  if (raw === null || raw === "" || raw === "1" || raw === "true" || raw === "on" || raw === "yes") {
    return true;
  }
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") {
    return false;
  }
  return null;
}

// Apply per-field query overrides on top of a resolved tier config, so a device's exact smooth point can be
// dialed in live (e.g. `?renderScale=0.2&particleFps=8&shaders=off`) without a rebuild. Each override is
// independent and only applied when present; renderScale clamps to a sane 0.05..1.
function applyOverrides(config: TierConfig, search: string): TierConfig {
  const params = new URLSearchParams(search);
  const out = { ...config };
  const renderScale = numParam(params, "renderScale");
  if (renderScale !== null) {
    out.renderScale = Math.min(1, Math.max(0.05, renderScale));
  }
  const shaderFps = numParam(params, "shaderFps");
  if (shaderFps !== null) {
    out.shaderFps = Math.max(0, shaderFps);
  }
  const particleFps = numParam(params, "particleFps");
  if (particleFps !== null) {
    out.particleFps = Math.max(0, particleFps);
  }
  const maxTextureDim = numParam(params, "maxTextureDim");
  if (maxTextureDim !== null) {
    out.maxTextureDim = Math.max(0, maxTextureDim); // 0 = upload at native size
  }
  const maxTrailPoints = numParam(params, "maxTrailPoints");
  if (maxTrailPoints !== null) {
    out.maxTrailPoints = Math.max(0, maxTrailPoints); // 0 = unbudgeted (every point the flight laid)
  }
  // `?shaders=` / `?particles=` map an effect MODE onto the tier's per-effect fields (which then seed the
  // per-viewer panel mode in mirrorSettings). off ⇒ disabled; static ⇒ frozen (shaders only); the reduced-
  // resolution variants set the SHARED renderScale (½/¼) — plain `dynamic` leaves renderScale at the tier's
  // value. Since renderScale is shared by both runtimes, `?shaders=dynamic-half` also
  // lowers particle resolution (and vice-versa); use `?renderScale=` for a precise combined value.
  const shaderMode = effectModeParam(params, "shaders");
  if (shaderMode !== null) {
    out.shadersEnabled = shaderMode !== "off";
    out.shadersStatic = shaderMode === "static";
    if (shaderMode === "dynamic-half") {
      out.renderScale = 0.5;
    } else if (shaderMode === "dynamic-quarter") {
      out.renderScale = 0.25;
    }
  }
  const particleMode = effectModeParam(params, "particles");
  if (particleMode !== null) {
    out.particlesEnabled = particleMode !== "off";
    if (particleMode === "dynamic-half") {
      out.renderScale = 0.5;
    } else if (particleMode === "dynamic-quarter") {
      out.renderScale = 0.25;
    }
  }
  const spineClips = boolParam(params, "spineClips");
  if (spineClips !== null) {
    out.spineClipsEnabled = spineClips;
  }
  const spineClipFps = numParam(params, "spineClipFps");
  if (spineClipFps !== null) {
    out.spineClipFps = Math.max(0, spineClipFps);
  }
  return out;
}

// Auto-detect a tier from device signals across the FULL ladder (high → medium → low → very-low → minimum). Few
// cores or little memory count as one weakness point each; a weak GPU string is a strong signal.
//
// DESKTOP path is unchanged from before: a weak GPU (+2) or two weak signals → medium, else high (never the
// bottom three — a desktop on a heuristic should keep effects; a laptop that's fine on medium stays medium).
//
// MOBILE phones/tablets are GPU-fill + thermally limited under the per-node CSS mirror, so the same signals step
// further down: a weak mobile GPU → very-low (frozen effects — e.g. a Mali/Adreno mid-ranger), other weakness →
// low, an otherwise-capable phone → medium. This is what makes auto reach the bottom rungs (a phone trace showed
// `medium` was still fill-bound while frozen effects were smooth). They remain desktop-opt-in.
function autoTier(signals: RenderQualitySignals): RenderQualityTier {
  const { gpu, hardwareConcurrency, deviceMemory, mobile } = signals;
  // Software WebGL (SwiftShader/llvmpipe): the GPU path runs on the CPU. On a phone that pegs the CPU for no
  // gain → `minimum` (CSS/texture fallback); on desktop keep the effects but cheap (`medium`).
  if (gpu.software) {
    return mobile ? "minimum" : "medium";
  }
  const weakGpu = Boolean(gpu.renderer && WEAK_GPU_RE.test(gpu.renderer));
  let score = 0;
  if (typeof hardwareConcurrency === "number" && hardwareConcurrency > 0 && hardwareConcurrency <= 4) {
    score += 1;
  }
  if (typeof deviceMemory === "number" && deviceMemory > 0 && deviceMemory <= 4) {
    score += 1;
  }
  if (mobile) {
    if (weakGpu) {
      // Positively-weak mobile GPU (Mali/Adreno mid-range, …): an animated per-frame loop is too costly, but a
      // single FROZEN shader frame is cheap and still shows the real effect → `very-low` (not `minimum`).
      return "very-low";
    }
    // Mobile browsers often MASK the renderer string (no `gpu.renderer`): we can't confirm the phone is
    // capable, so default to low (effects reduced, still on) rather than medium. Only a phone that POSITIVELY
    // reports a non-weak GPU with ample cores/mem earns medium.
    if (!gpu.renderer || score >= 1) {
      return "low";
    }
    return "medium";
  }
  if (weakGpu) {
    score += 2;
  }
  return score >= 2 ? "medium" : "high";
}

// Clamp a backing-store scale to the same sane band `?renderScale=` uses. Null stays null (absent param).
function clampScale(value: number | null): number | null {
  return value === null ? null : Math.min(1, Math.max(0.05, value));
}

// The two STATIC-mode backing-store scales for THIS device (see the constants above): mobile → 0.5 shaders /
// 0.25 particles, desktop → 1. `?staticShaderScale=`/`?staticParticleScale=` win over `?staticScale=`, which wins
// over the device default — the A/B valve, no rebuild needed.
function staticScales(signals: RenderQualitySignals): Pick<
  RenderQuality,
  "staticShaderScale" | "staticParticleScale"
> {
  const params = new URLSearchParams(signals.search);
  const shared = clampScale(numParam(params, "staticScale"));
  const mobile = signals.mobile === true;
  return {
    staticShaderScale:
      clampScale(numParam(params, "staticShaderScale")) ??
      shared ??
      (mobile ? STATIC_SHADER_SCALE_MOBILE : STATIC_SCALE_DESKTOP),
    staticParticleScale:
      clampScale(numParam(params, "staticParticleScale")) ??
      shared ??
      (mobile ? STATIC_PARTICLE_SCALE_MOBILE : STATIC_SCALE_DESKTOP)
  };
}

// Pure resolver (testable): given the device signals, produce the quality. Tier comes from debug > query >
// the viewer's saved panel choice > auto; per-field query overrides (renderScale/shaderFps/particleFps/
// shaders/particles) are then applied on top.
export function resolveRenderQuality(signals: RenderQualitySignals): RenderQuality {
  const { tier, source } = resolveTier(signals);
  return { tier, source, ...applyOverrides(tierConfig(tier), signals.search), ...staticScales(signals) };
}

// The per-field query keys that, when present, PIN a value the user dialed in — any of them disables the
// adaptive controller (don't fight an explicit override). `quality`/`debug` pin the whole tier.
const ADAPTIVE_PINNING_KEYS = [
  "renderScale",
  "staticScale",
  "staticShaderScale",
  "staticParticleScale",
  "shaderFps",
  "particleFps",
  "shaders",
  "particles",
  "quality",
  "debug",
];

// Whether the live adaptive controller may run for this resolved quality. Only in PURE auto mode (the tier came
// from auto-detect — not an explicit `?quality`/`?debug`, and not this viewer's own saved panel choice, which is
// what "auto-detection stops once a player picks a rung" means), with effects actually on (not the `minimum`
// tier), and with NO per-field override pinned. A pinned value is the user's measured point — leave it alone.
export function isAdaptiveEligible(quality: RenderQuality, search: string): boolean {
  if (quality.source !== "auto" && quality.source !== "default") {
    return false;
  }
  if (!quality.shadersEnabled && !quality.particlesEnabled) {
    return false;
  }
  // The frozen-effect tier has no per-frame loop to measure or downgrade — it's already a floor rung.
  if (quality.shadersStatic) {
    return false;
  }
  const params = new URLSearchParams(search);
  return !ADAPTIVE_PINNING_KEYS.some((key) => params.has(key));
}

function resolveTier(signals: RenderQualitySignals): { tier: RenderQualityTier; source: RenderQuality["source"] } {
  // `?debug` (the QA lever for a headless/software-GL browser) keeps WebGL off — SwiftShader pegs the CPU.
  if (new URLSearchParams(signals.search).has("debug")) {
    return { tier: "minimum", source: "debug" };
  }
  const override = parseOverride(signals.search);
  if (override) {
    return { tier: override, source: "query" };
  }
  // The viewer's own panel choice, saved on this device. "auto" (and an absent/garbled value) falls through to
  // detection; a rung takes the device OUT of detection, here and in isAdaptiveEligible above.
  const stored = typeof signals.storedQuality === "string" ? parseRenderQualityTier(signals.storedQuality) : null;
  if (stored) {
    return { tier: stored, source: "stored" };
  }
  const tier = autoTier(signals);
  return { tier, source: tier === "high" ? "default" : "auto" };
}

function readSignals(): RenderQualitySignals {
  const nav: Navigator & {
    deviceMemory?: number;
    userAgentData?: { mobile?: boolean };
  } = typeof navigator !== "undefined" ? navigator : ({} as Navigator);
  // Prefer UA-Client-Hints `mobile` (accurate, where available); fall back to a UA-string sniff.
  const mobile =
    typeof nav.userAgentData?.mobile === "boolean"
      ? nav.userAgentData.mobile
      : /Mobi|Android|iPhone|iPad|iPod/i.test(nav.userAgent ?? "");
  return {
    search: typeof window !== "undefined" ? window.location.search : "",
    gpu: describeGpu(),
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory,
    mobile,
    // The panel's saved `quality`, read straight out of the mirror-settings blob. Deliberately NOT an import of
    // `@/mirror/mirrorSettings` (that module imports this one): `settingsStorage` is a leaf with no imports of
    // its own, so there is no cycle and no load-order question about which module builds first.
    storedQuality: readSettingsRecord(defaultSettingsStorage())?.quality,
  };
}

let cached: RenderQuality | undefined;

// The resolved tier for this session (memoized — device signals don't change mid-session, and a tier
// switch means a reload). Logged once so a low-end device's tier is visible in the console for support.
export function renderQuality(): RenderQuality {
  if (cached) {
    return cached;
  }
  cached = resolveRenderQuality(readSignals());
  // gsw's shared WebGL context (godot-scene-web/.../webgl/shared-gl.ts) has its OWN, independent
  // software-renderer gate that refuses to create a GL context at all on SwiftShader/llvmpipe —
  // unless told otherwise via its documented `globalThis.__gswForceWebglShaders` escape hatch. That
  // gate would otherwise silently veto a tier we already decided should run effects (e.g. desktop +
  // software GL resolves to "medium", not "minimum" — see autoTier). Forward our decision so the two agree;
  // only when this tier actually wants shaders/particles, so a "minimum" tier doesn't force GL context
  // creation gsw would never use. Must run before any consumer creates a runtime (getShared latches
  // its result on first call) — renderQuality() is memoized and called first by every consumer.
  if (cached.shadersEnabled || cached.particlesEnabled) {
    (globalThis as Record<string, unknown>).__gswForceWebglShaders = true;
  }
  if (typeof console !== "undefined") {
    const q = cached;
    // Print the EFFECTIVE settings (tier + any overrides) for any non-default config, so the phone's console
    // shows exactly what's running when dialing in `?renderScale=…` etc.
    const detail =
      q.tier !== "high" || q.staticShaderScale !== 1 || q.staticParticleScale !== 1
        ? ` — renderScale ${q.renderScale}, shaderFps ${q.shaderFps || "∞"}, particleFps ${q.particleFps}` +
          `, shaders ${q.shadersEnabled ? (q.shadersStatic ? "static" : "on") : "off"}` +
          `, particles ${q.particlesEnabled ? "on" : "off"}` +
          `, staticScale ${q.staticShaderScale}/${q.staticParticleScale}`
        : "";
    console.info(`[render] quality: ${q.tier} (${q.source})${detail}`);
  }
  return cached;
}

/** TEST-ONLY: force a resolved quality (or clear it) so a test can exercise a specific tier. */
export function __setRenderQualityForTest(quality: RenderQuality | undefined): void {
  cached = quality;
}

let cachedDetected: RenderQualityTier | undefined;

/**
 * What AUTO-DETECTION makes of this device, ignoring `?debug`, `?quality=` and the viewer's saved choice.
 *
 * The settings panel labels its Auto entry with this ("Auto (Medium)"), which is the whole point: a player who
 * has not chosen a rung can still see which one the device was judged to be, and a player who HAS chosen one can
 * see what they are overriding. Memoized like `renderQuality()` — the device signals don't change mid-session.
 */
export function detectedRenderQualityTier(): RenderQualityTier {
  cachedDetected ??= autoTier(readSignals());
  return cachedDetected;
}

/** TEST-ONLY: forget the memoized auto-detection above. */
export function __resetDetectedTierForTest(): void {
  cachedDetected = undefined;
}

/**
 * The device pixel ratio the STAGE (the scene itself — text, card art, the whole readable surface) is rasterized
 * at. Deliberately `window.devicePixelRatio`, and deliberately INDEPENDENT of the quality tier above.
 *
 * THE RULE: a quality tier may scale an EFFECT's offscreen target (that is exactly what `renderScale` /
 * `staticShaderScale` / `staticParticleScale` are — a shader's or a particle system's own render target, blitted
 * back at full size, where a lower resolution costs a soft glow some sharpness nobody can name), but it may NEVER
 * scale the stage. Those are different pixels answering different questions, and only one of them is text.
 *
 * WHY IT IS SPELLED OUT INSTEAD OF ASSUMED: the (paused) godot client shipped a "Half-res stage" quality lever and
 * it blurred every glyph on the screen — the whole readable surface, in exchange for fill-rate the effect targets
 * were already the right place to buy. Keeping the stage's backing store on this ONE function, with no tier
 * argument to reach for, excludes that class of bug by construction: there is nowhere for a tier to enter.
 *
 * Falls back to 1 where `window` / the ratio is absent or nonsensical (SSR, jsdom, a hostile 0).
 */
export function stagePixelRatio(): number {
  const ratio = typeof window === "undefined" ? Number.NaN : window.devicePixelRatio;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}
