// The mirror's live settings store — a plain `reactive()` bag the settings panel binds to, split into three
// concerns, plus the small localStorage layer that makes a viewer's choices survive a reload.
//
//   CLIENT render — applied purely in THIS browser (per-viewer), never sent to the game. MirrorView watches
//     these to create/dispose the WebGL shader + particle runtimes live.
//   SERVER settings — sent to the game instance this viewer's connection is served by (their own headless seat,
//     or — under direct view — the HOST's own game) over the `settings` control channel. The freeze literals here
//     are a local default while the serving instance has not reported its state; the real seed is the `session` envelope's
//     freeze* fields, applied by `seedServerSettingsFromSession` before the first push (MirrorApp).
//   UI — panel open/closed + the latency overlay toggle (both gate the latency probe's cadence; see MirrorApp).
//
// LAYERING (lowest to highest), applied once per page load in `createMirrorSettings`:
//   1. built-in defaults — the product defaults below (shaders Static, particles Static, …). The SAME values
//      on every device: a setting must mean the same thing on a phone and on a desktop (see quality.ts — the one
//      device-dependent part of a static mode is the backing-store scale it renders its single frame at).
//   2. device tier seed — now only the hard-off floor (`?debug` / `?quality=off` / a software-WebGL phone has no
//      usable GPU path, so both effect modes read `off` there and the panel says so honestly). Everything the
//      tier used to seed per-device is a shared product default now.
//   3. localStorage — what this viewer last chose IN THE PANEL (`couchcoop.mirrorSettings.v1`). Only fields the
//      viewer can actually set are stored, and only the field they touched is written (see persistMirrorSetting).
//   4. URL query — always wins FOR THE SESSION (`?shaders=dynamic`, `?stretch=off`, …) and never writes back: a
//      shared debug link must not silently redefine the phone's saved preference. Change the setting in the panel
//      afterwards and THAT is saved, as always.
//
// NEVER PERSISTED (see NEVER_PERSISTED_SETTING_KEYS): the three `freeze*` fields are HOST truth, re-seeded per
// connection from the serving instance; `panelOpen`/`panelAnchorTop` are momentary UI; `effectModePinned` is a
// per-session adaptive-controller flag; `spineMode` is a dev-only `?spineMode=` override with no panel control,
// so it has nothing viewer-set to save.

import { reactive } from "vue";

import { REPRO_UI_ENABLED } from "@/mirror/buildFlags";
import {
  effectModeOverride,
  particlesHardOff,
  renderQuality,
  shadersHardOff,
  type RenderQuality
} from "@/render/quality";
import type { MirrorSettingsPayload } from "@/mirror/mirrorClient";

// The game's headless defaults. The panel starts here and only diverges
// once the viewer flips something.
export const DEFAULT_REFRESH_RATE = 24;

// The refresh-rate slider's range (the host applies the value verbatim as Engine.MaxFps). Exported so the panel's
// slider and the stored-value validator can't drift apart.
export const REFRESH_RATE_MIN = 4;
export const REFRESH_RATE_MAX = 60;

// Per-viewer effect mode for the two live WebGL effect families (shaders + particles). A tri-state
// Dynamic / Static / Off, PLUS two web-only reduced-resolution DYNAMIC variants (½-res, ¼-res) that trade
// effect sharpness for GPU fill on a weak phone. "static" = render the effect's art FROZEN (a representative
// single frame, ZERO per-frame cost) — distinct from the SERVER-side "Freeze particles/spines" host CPU savers.
export type EffectMode = "dynamic" | "dynamic-half" | "dynamic-quarter" | "static" | "off";

export const EFFECT_MODES: readonly EffectMode[] = [
  "dynamic",
  "dynamic-half",
  "dynamic-quarter",
  "static",
  "off",
] as const;

// THE PRODUCT DEFAULTS for the two effect families — deliberately device-INDEPENDENT (the tier no longer seeds a
// mode; see the layering note above and quality.ts' "what a tier still decides").
//
// BOTH families default to STATIC everywhere, desktop included: the real effect, rendered once at a pinned time, so
// cards/glows/transitions look correct at ~zero ongoing GPU cost. Animated effects are the opt-in (the panel's
// Dynamic / Dynamic ½ / Dynamic ¼).
//
// Particles briefly defaulted to DYNAMIC ¼ — live simulation reads as motion nobody wants frozen — but a live
// simulation is a per-frame GPU pass on every device that shows one, and on a phone that pass lands on top of the
// per-delta shader re-renders (see quality.ts' static-scale note). Static is the product default now, on every
// device; ¼-res dynamic remains one tap away in the panel for anyone who wants the motion back.
//
// What a static mode does NOT decide is the backing-store RESOLUTION it renders that one frame at — that stays a
// device question (quality.ts: staticShaderScale / staticParticleScale, ½ / ¼ on a phone, full on a desktop).
export const DEFAULT_SHADER_MODE: EffectMode = "static";
export const DEFAULT_PARTICLE_MODE: EffectMode = "static";

// SpineSprite clip playback mode. **The product default is `static`** — every spine renders as a single
// server-baked still frame, on every device. Animated spine clips are multi-MB per node and were the mirror's
// single largest wire + decode cost for a benefit almost nobody could see on a phone, so the panel no longer
// offers the choice at all; the four values survive only as a DEV override (`?spineMode=`) and as the vocabulary
// the two gates in spineAttributes.ts speak:
//   auto    : the tier decides (desktop fetches the animated clip, a weak tier one still, the `off` floor nothing).
//   dynamic : always fetch + play the full animated clip, on any tier — the dev escape hatch.
//   static  : fetch a single STILL frame (&still=1) and paint it once — no rAF advance, no multi-MB clip. THE
//             DEFAULT. Still honours the `off` floor tier (WebGL-unavailable / the ?debug auto-player), which
//             renders no spines at all — exactly what `auto` did there before this became the default.
//   off     : don't render spines at all (the node is not a spine-clip node, so it also leaves NO zero-box element —
//             see nodeStyles' shared isSpineClipNode gate).
export type SpineMode = "auto" | "dynamic" | "static" | "off";

export const SPINE_MODES: readonly SpineMode[] = ["auto", "dynamic", "static", "off"] as const;

// Parse the DEV-only `?spineMode=` override (auto|dynamic|static|off, case-insensitive). Anything else — including
// an absent param, i.e. every ordinary viewer — → "static".
export function parseSpineMode(raw: string | null): SpineMode {
  const value = raw?.toLowerCase() ?? "";
  return (SPINE_MODES as readonly string[]).includes(value) ? (value as SpineMode) : "static";
}

// Canvas text uses the glyph path for labels it can shape. Missing faces or metrics and unsupported shaping fall
// back to raster text, which preserves browser fallback coverage. The fidelity-floor census is observational;
// it reports low-ppem glyph runs without changing the selected text path.

export interface MirrorSettings {
  // CLIENT render (browser-only) — the per-viewer effect mode for each family (product defaults above; the tier
  // only floors them to `off` in the hard-off lane). MirrorView watches these to create/dispose + retune the WebGL
  // shader + particle runtimes live (static ⇒ setStaticShaders/setStaticParticles, ½/¼ ⇒ setRenderScale,
  // off ⇒ dispose).
  shaderMode: EffectMode;
  particleMode: EffectMode;
  // CLIENT render (browser-only) — set true the moment the viewer picks an effect mode in the panel, so the
  // auto adaptive-quality controller stops fighting a deliberate panel selection (see adaptiveQuality/MirrorView).
  effectModePinned: boolean;
  // CLIENT layout (browser-only) — the wider-than-16:9 stage widening + proportional re-layout (see MirrorView's
  // `design`). Off = classic letterboxed 16:9. Seeded from `?stretch` (on unless the param says otherwise).
  stretchEnabled: boolean;
  // CLIENT layout (browser-only) — cosmetically raise a touch-dragged card above the fingertip (mirrorRenderer's
  // setHeldCard); the coordinate sent to the game never changes. Seeded ON unless `?raiseCard=off`.
  raiseHeldCard: boolean;
  // CLIENT layout (browser-only) — a long-press on a card focuses+raises it (a "peek"); on release, un-focus by
  // hovering up off the hand so the card returns (never a play). Seeded ON unless `?unfocus=off`. Requires
  // raiseHeldCard (the master switch for the held-card feature).
  unfocusOnRelease: boolean;
  // CLIENT input (browser-only) — the two-step touch tap (first tap focuses/arms, re-tap plays). Off ⇒ a single
  // tap plays immediately. Seeded ON unless `?tapFocus=off`.
  tapToFocus: boolean;
  // CLIENT input (browser-only) — on the screens where a tap CONSUMES a run reward (card rewards, event options
  // incl. ancients, shop purchases, multiplayer treasure relics, rest-site choices) a tap only ever FOCUSES, and a
  // client-side confirm button commits (see confirmTap.ts). Takes priority over `tapToFocus` on exactly those
  // widgets — the second tap of the two-step can't consume a reward there — and leaves every other widget to it.
  // Seeded ON unless `?confirmTap=off`.
  confirmTap: boolean;
  // CLIENT layout (browser-only) — READABLE-HAND MODE. The resting hand fan parks the centre card so its bottom
  // hangs below the viewport floor, which is exactly where a card's rules text sits, so on a touch device you can
  // only read a hand one focused card at a time. On, the mirror cosmetically raises every hand card by that
  // overhang and moves each creature's HP bar + powers above its target reticle (intents pushed up to clear them),
  // so a whole hand is readable at a glance. Purely client-side CSS on the mirror's own DOM — the game is never
  // told and no sent coordinate changes (mirrorRenderer's hand-raise pass + raiseInverse.ts).
  //
  // Off by default on every device. `?raiseHand=on` / `?raiseHand=off` forces either way; the panel checkbox and
  // the in-game HUD button both write the same saved field.
  raiseHandCards: boolean;
  // CLIENT layout (browser-only) — READABILITY SCALING, the master switch over every place the mirror draws the
  // game BIGGER than the game does so it reads and taps on a phone. Four families, one checkbox:
  //   * the view-scale table (viewScale.ts) — the rewards panel, the card-reward screen, the shop carpet, event
  //     options, map points / legend / drawing tools, the combat piles, the treasure relic, the "View upgrades" rows;
  //   * the HoverTip 1.2x enlargement (hoverTipScaleMath.ts);
  //   * the per-label generated text-scale table (textScaleClasses.ts);
  //   * the clip-axis outset (clipAxis.ts), which exists ONLY to stop a clipper cropping the enlargements above —
  //     with them gone, the mirror should clip exactly where the game does.
  // OFF is the closest the mirror gets to the game's own geometry, which is what makes it the parity-checking
  // switch AND the escape hatch when an enlargement misplaces something.
  //
  // Seeded ON unless `?uiScale=off`. The tip scale, text scaling, and clip-axis exception follow this product
  // setting directly.
  // Purely client-side on BOTH stage backends — nothing is sent to the game, and the DOM hit boxes / the
  // canvas `mGame` never move (only the view-scale INPUT registry, which is empty with the switch off).
  uiScaling: boolean;
  // CLIENT render (browser-only) — the spine playback mode (see SpineMode). Seeded from the DEV-only
  // `?spineMode=`, default "static" (server-baked stills everywhere; no panel control, never persisted).
  // Consulted at the two spine gates in spineAttributes.ts; MirrorView forces a full re-walk on change so live
  // canvases tear down / remount.
  spineMode: SpineMode;
  // CLIENT render (browser-only) — occlusion gating under the game's OWN full-screen overlay backstops (the map,
  // the deck / card-grid capstone screens, the reward overlays). ONE feature, two effects, both inside
  // mirrorRenderer's occlusion pass:
  //   1. those named backstops qualify as a "cover" at a composed alpha of 0.70 instead of the generic 0.75, so
  //      the LIVE game's `#000000d9` scrim under a `d9` modulate (0.724) engages tier 2 at all;
  //   2. while a tier-2 cover holds, the (now static) <canvas> paint under it is swapped for a still <img> of the
  //      same pixels, which drops its composited layer without changing a pixel through the translucent scrim.
  // The backstop stays TRANSLUCENT either way — nothing is hidden, only de-animated + de-composited. Seeded ON
  // unless `?backstopOcclude=off`; MirrorView forces a full re-walk on change (the cover PRE-FILTER runs in the
  // walk, so a flip has to re-visit every node before the pass can see the new candidate set).
  backstopOcclusion: boolean;
  // CLIENT render (browser-only) — "Static background": show the host-rendered 2520x1080 PNG of the combat
  // background scene (the session envelope's `staticBackground` descriptor → StaticBackground.vue) and hide the
  // live bg subtree (mirrorRenderer's staticBgSuppressedRootIds, engaged only once the image is CONFIRMED shown —
  // load+decode — so there is never a hole). Combat scenery is one of the most expensive things a phone draws;
  // this is the single biggest GPU win. Seeded ON unless `?staticBg=off`.
  staticBgEnabled: boolean;
  // CLIENT render state (browser-only, NEVER persisted) — the static-background image could not be fetched or
  // decoded for the current target AND that target's family FAILS OPEN. While true the live subtree is showing
  // despite the setting being ON, so the wire value pushed to the host (`staticBg`, see staticBgWireValue) reports
  // false and a host that was skipping the bg subtree from its producer walk re-admits it for this instance.
  // Cleared by the next successful decode (a later room's image), which re-arms the skip. Written ONLY on real
  // transitions by StaticBackground.vue, so the SERVER_SETTING_KEYS watch fires exactly once per failure/recovery.
  //
  // "FAILS OPEN" is now a per-family question, which is why this is no longer named `staticBgFailed`: a failed
  // COMBAT still does NOT set this. Combat holds unconditionally — the viewer gets the digest-less still, the
  // previous still for the same room, or a blank stage, never the live scenery — so the host must KEEP skipping
  // that subtree, and a latch here would tell it the opposite. Event backdrops and the shop keep the old
  // behaviour and are the only writers. A combat failure is still counted (staticBgReport.ts); it just does not
  // move this flag. Read by the two render backends' hold arms and by staticBgWireValue.
  staticBgFailedOpen: boolean;
  // CLIENT diagnostics (browser-only) — the REPRO RECORDER (reproRecorder.ts). While on, this browser keeps a
  // rolling in-memory recording of BOTH halves of what drives the mirror (the incoming scene stream and the
  // viewer's own pointer/wheel/key events) so a bug can be saved as a replayable file instead of described. Off
  // by default and never sent to the game — it costs the page a ring buffer and a set of capture-phase input
  // listeners, both of which exist only while it is on.
  //
  // Seeded `?repro=on` / `?repro=off` (tri-state) over the saved choice. The saved choice is IGNORED when this
  // build excluded the recorder's UI (`VITE_REPRO_UI=off`, see buildFlags): a viewer with no switch to find must
  // not be left recording by a value they set on a previous build. The URL param is still honoured there — it is
  // the support escape hatch, and the badge renders on that path so there is a SAVE button to press.
  reproRecorder: boolean;
  // CLIENT ui (browser-only) — the on-screen latency readout (LatencyOverlay). Seeded from the `?latency` harness
  // param so the checkbox reads truthfully on load. NOTE the render gate is `?latency` OR this: the harness path
  // (scripts/measure-latency.mjs + window.__mirrorLatency) can never be switched off by a stray tap in the panel.
  latencyOverlay: boolean;
  // SERVER (game) — sent over the `settings` channel on change. The three freezes are RECONCILED with the serving
  // instance's own reported state before the first push (see seedServerSettingsFromSession): a headless seat
  // freezes by default, the host's own windowed game freezes nothing until asked, and the panel must show whichever
  // one it is actually talking to. `refreshRate`/`tweenReplay` are the two SERVER fields a viewer's SAVED
  // preference does survive into (see MirrorApp's seed-then-push order contract).
  refreshRate: number;
  freezeParticles: boolean;
  freezeSpines: boolean;
  freezeDecor: boolean;
  tweenReplay: boolean;
  // SERVER (game) — this client's TRAIL-DRIVE CAPABILITY: it places the card-flight trail root from the
  // declarative flight hint. Not a preference and not a panel control: the current client declares this capability.
  // Never persisted — a capability is a
  // fact about the build that is running, so a saved copy could only ever be a stale claim on the next build.
  //
  // Rides the connect URL and the `settings` payload's `trailDrive` field.
  trailDriveCapable: boolean;
  // UI.
  panelOpen: boolean;
  // UI — the viewport-space Y the settings dropdown hangs from, written by the gear button from its OWN measured
  // bottom edge when it is pressed. The in-game gear rides the scaled stage (its on-screen height and letterbox
  // offset both move with the display), so a hardcoded dropdown offset would sit on top of the button on a large
  // screen and eat the press that closes it again. Seeded to a sane browser-space default for a panel that is
  // opened without a click (tests, `?` harnesses).
  panelAnchorTop: number;
}

// The server-side keys, in payload order. Watching this list is what triggers a `settings` send; iterating it
// keeps `serverSettingsPayload` and any change-watch in lockstep with the payload shape. Two exceptions to the
// key-name identity, both documented at their fields: the staticBg* PAIR folds into the single wire field
// `staticBg` (staticBgWireValue), so a panel toggle AND a fail-open transition both wake the watch and ride the
// same field; and `trailDriveCapable` is sent as `trailDrive` (the host's vocabulary for the same capability).
export const SERVER_SETTING_KEYS = [
  "refreshRate",
  "freezeParticles",
  "freezeSpines",
  "freezeDecor",
  "tweenReplay",
  "staticBgEnabled",
  "staticBgFailedOpen",
  "trailDriveCapable"
] as const;

// ---------------------------------------------------------------------------------------------------------
// Web-storage layer
// ---------------------------------------------------------------------------------------------------------

// VERSIONED on purpose: a future schema change bumps the suffix, which resets every viewer to the new defaults
// instead of trying to migrate values whose meaning moved. Old keys are simply orphaned (a few bytes).
export const MIRROR_SETTINGS_STORAGE_KEY = "couchcoop.mirrorSettings.v1";

/** The web-storage seam (injectable so tests can fake it; `null` means "this build has no storage"). */
export interface MirrorSettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** Fields a viewer can set IN THE PANEL — exactly the fields that are saved. */
export type PersistedSettingKey =
  | "shaderMode"
  | "particleMode"
  | "stretchEnabled"
  | "raiseHeldCard"
  | "unfocusOnRelease"
  | "tapToFocus"
  | "confirmTap"
  | "raiseHandCards"
  | "uiScaling"
  | "backstopOcclusion"
  | "staticBgEnabled"
  | "reproRecorder"
  | "latencyOverlay"
  | "refreshRate"
  | "tweenReplay";

export const PERSISTED_SETTING_KEYS: readonly PersistedSettingKey[] = [
  "shaderMode",
  "particleMode",
  "stretchEnabled",
  "raiseHeldCard",
  "unfocusOnRelease",
  "tapToFocus",
  "confirmTap",
  "raiseHandCards",
  "uiScaling",
  "backstopOcclusion",
  "staticBgEnabled",
  // PERSISTED on purpose, even though it is a diagnostic: recording a bug means playing until it happens, which
  // spans reloads and reconnects, and a switch that forgot itself every page load would be useless for exactly
  // the intermittent bugs it exists to catch. The build flag is what takes it away again (see the field).
  "reproRecorder",
  "latencyOverlay",
  "refreshRate",
  "tweenReplay"
] as const;

// The DENYLIST, stated as data so a new field can't quietly join the saved set by accident (a spec asserts the
// two lists together cover every key of MirrorSettings):
//   freeze*          — HOST truth. The serving instance reports what IT has frozen and the panel adopts that per
//                      connection; a saved copy would push a stale answer onto a different game.
//   panelOpen/Anchor — momentary UI (and the anchor is a measured pixel of a layout that no longer exists).
//   effectModePinned — a per-session flag for the adaptive controller, not a preference.
//   spineMode        — dev-only `?spineMode=` override; no panel control, so nothing user-set to save.
export const NEVER_PERSISTED_SETTING_KEYS = [
  "effectModePinned",
  "spineMode",
  "freezeParticles",
  "freezeSpines",
  "freezeDecor",
  // staticBgFailedOpen — a per-session fetch/decode failure latch (fail-open state), not a preference; a reload
  // retries the image from scratch, so saving it would only pin a stale failure.
  "staticBgFailedOpen",
  // trailDriveCapable — a CAPABILITY of the build that is running, not a viewer choice. Saving it would let an old
  // stored `true` speak for a build that can no longer drive the trail root (and a stored `false` would silently
  // hold the host's lever off for every viewer on this device, forever, with no panel control to clear it).
  "trailDriveCapable",
  "panelOpen",
  "panelAnchorTop"
] as const;

export type StoredMirrorSettings = Partial<Pick<MirrorSettings, PersistedSettingKey>>;

// localStorage where it exists. Access itself can THROW (Safari private mode, a sandboxed frame), so it is
// wrapped — a browser without storage degrades to the RAM-only behavior this store used to have.
function defaultStorage(): MirrorSettingsStorage | null {
  try {
    return (globalThis as { localStorage?: MirrorSettingsStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

function boolValue(raw: unknown): boolean | undefined {
  return typeof raw === "boolean" ? raw : undefined;
}

function effectModeValue(raw: unknown): EffectMode | undefined {
  return typeof raw === "string" && (EFFECT_MODES as readonly string[]).includes(raw)
    ? (raw as EffectMode)
    : undefined;
}

function refreshRateValue(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  // Out of the slider's range is not a value this panel could have produced — treat it as corrupt rather than
  // clamping it into something the viewer never chose.
  return raw >= REFRESH_RATE_MIN && raw <= REFRESH_RATE_MAX ? raw : undefined;
}

// Per-key validation, so a hand-edited / half-written / older-schema blob can only ever DROP fields — never feed
// the store a mode string the renderer doesn't know or an fps the host would refuse.
const STORED_VALIDATORS: { [K in PersistedSettingKey]: (raw: unknown) => MirrorSettings[K] | undefined } = {
  shaderMode: effectModeValue,
  particleMode: effectModeValue,
  stretchEnabled: boolValue,
  raiseHeldCard: boolValue,
  unfocusOnRelease: boolValue,
  tapToFocus: boolValue,
  confirmTap: boolValue,
  raiseHandCards: boolValue,
  uiScaling: boolValue,
  backstopOcclusion: boolValue,
  staticBgEnabled: boolValue,
  reproRecorder: boolValue,
  latencyOverlay: boolValue,
  refreshRate: refreshRateValue,
  tweenReplay: boolValue
};

function readRecord(storage: MirrorSettingsStorage | null): Record<string, unknown> | null {
  if (!storage) {
    return null;
  }
  let text: string | null = null;
  try {
    text = storage.getItem(MIRROR_SETTINGS_STORAGE_KEY);
  } catch {
    return null; // storage exists but reading threw (private mode / disabled cookies)
  }
  if (!text) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null; // not JSON at all — ignore it; the next panel change overwrites it
  }
}

/** The viewer's saved panel choices: only known keys, only values that pass validation. Never throws. */
export function readStoredMirrorSettings(
  storage: MirrorSettingsStorage | null = defaultStorage()
): StoredMirrorSettings {
  const record = readRecord(storage);
  const out: StoredMirrorSettings = {};
  if (!record) {
    return out;
  }
  for (const key of PERSISTED_SETTING_KEYS) {
    const value = STORED_VALIDATORS[key](record[key]);
    if (value !== undefined) {
      // Each validator returns exactly MirrorSettings[key]; the per-key typing is lost by the loop.
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

/** Whether this viewer has a SAVED value for one field (MirrorApp asks about `refreshRate` — see its seed rule). */
export function hasStoredMirrorSetting(
  key: PersistedSettingKey,
  storage: MirrorSettingsStorage | null = defaultStorage()
): boolean {
  return readStoredMirrorSettings(storage)[key] !== undefined;
}

/**
 * Save ONE field the viewer just changed in the panel.
 *
 * Per-field on purpose: the whole store is never written, so a value that came from a URL override (or from the
 * host's own reported state) can't ride along into the saved set behind a change the viewer made to something
 * else. Re-reads + re-validates first, so a foreign/corrupt blob is pruned rather than grown. Best-effort: a
 * browser that refuses storage just doesn't remember.
 */
export function persistMirrorSetting<K extends PersistedSettingKey>(
  key: K,
  value: MirrorSettings[K],
  storage: MirrorSettingsStorage | null = defaultStorage()
): void {
  if (!storage) {
    return;
  }
  const next: StoredMirrorSettings = { ...readStoredMirrorSettings(storage), [key]: value };
  try {
    storage.setItem(MIRROR_SETTINGS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota / private mode — the session keeps the value in RAM, it just won't survive a reload.
  }
}

/** Forget every saved choice (tests, and a future "reset to defaults" affordance). */
export function clearStoredMirrorSettings(storage: MirrorSettingsStorage | null = defaultStorage()): void {
  if (!storage) {
    return;
  }
  try {
    if (storage.removeItem) {
      storage.removeItem(MIRROR_SETTINGS_STORAGE_KEY);
    } else {
      storage.setItem(MIRROR_SETTINGS_STORAGE_KEY, "{}");
    }
  } catch {
    // Nothing to do — a storage that refuses removal also refused the write that created this.
  }
}

// ---------------------------------------------------------------------------------------------------------

// The freeze truth a `session` envelope reports for the instance serving that connection. Tri-state per field: a
// boolean is that instance's real state; null/undefined means the state is unavailable — and an unknown field must
// leave the store alone rather than seed a guess.
export interface ReportedHostFreezes {
  freezeParticles?: boolean | null;
  freezeSpines?: boolean | null;
  freezeDecor?: boolean | null;
}

// Reconcile the "Host performance" checkboxes with what the serving instance actually has frozen. Called ONCE per
// connection, BEFORE that connection's one-shot settings push (MirrorApp), which is what makes the ordering
// deterministic: the panel adopts the instance's truth first, so the push that follows echoes the instance's own
// values back to it (a no-op) instead of stomping them with the client's stale defaults. Everything after that is
// viewer-driven and flows the other way (store → `settings`).
//
// Why per CONNECTION and not once per session: the host socket and a redirected headless socket are DIFFERENT games
// with different answers (windowed host: nothing frozen; headless seat: all three frozen). Seeding only from the
// first envelope ever seen would push the host's "nothing frozen" onto the headless instance the viewer then joins,
// silently un-freezing it. Returns true when at least one field was seeded (i.e. the host reported).
//
// Note the asymmetry with `refreshRate`/`tweenReplay`, the other two SERVER fields: those ARE the viewer's to
// remember (preferences about their own stream, not truths about the instance), so a saved value wins over the
// envelope and is pushed to the host — see MirrorApp. The freezes are never persisted for exactly this reason.
export function seedServerSettingsFromSession(
  settings: MirrorSettings,
  reported: ReportedHostFreezes | null | undefined
): boolean {
  if (!reported) {
    return false;
  }
  let seeded = false;
  if (typeof reported.freezeParticles === "boolean") {
    settings.freezeParticles = reported.freezeParticles;
    seeded = true;
  }
  if (typeof reported.freezeSpines === "boolean") {
    settings.freezeSpines = reported.freezeSpines;
    seeded = true;
  }
  if (typeof reported.freezeDecor === "boolean") {
    settings.freezeDecor = reported.freezeDecor;
    seeded = true;
  }
  return seeded;
}

// The `staticBg` wire value is the viewer's setting folded with the FAIL-OPEN latch. It answers exactly one
// question for the host: is this viewer still covering the background subtree, so the producer walk may keep
// skipping it? This is what rides the connect URL (`?staticBg=1` when true — see mirrorClient's URL builders)
// and the `settings` payload below.
//
// It folds `staticBgFailedOpen`, NOT "did anything fail": a failed COMBAT still leaves this viewer covering the
// subtree (it shows a fallback still or nothing at all, never the live scenery), so the host must keep skipping
// it. Folding a combat failure here is in fact what made the permanent-404 self-sustaining — the fold pushed
// `staticBg:false`, which re-armed a deferred probe that could publish a different digest and strand the next
// URL too. Event backdrops and the shop still fail open, and there this correctly reports false.
export function staticBgWireValue(settings: MirrorSettings): boolean {
  return settings.staticBgEnabled && !settings.staticBgFailedOpen;
}

// Extract just the SERVER-side fields as a `settings` payload (drops the client-only render toggles + UI state).
// Two entries' payload keys differ from their store keys, and only these two:
// `staticBgEnabled`/`staticBgFailedOpen` fold into the ONE wire field `staticBg` (see staticBgWireValue), and
// `trailDriveCapable` is sent as `trailDrive`.
export function serverSettingsPayload(settings: MirrorSettings): MirrorSettingsPayload {
  return {
    refreshRate: settings.refreshRate,
    freezeParticles: settings.freezeParticles,
    freezeSpines: settings.freezeSpines,
    freezeDecor: settings.freezeDecor,
    tweenReplay: settings.tweenReplay,
    staticBg: staticBgWireValue(settings),
    trailDrive: settings.trailDriveCapable
  };
}

// A "default-ON, `?flag=off` disables it" query switch, as a TRI-state: null when the param is absent at all.
// The absent case is what the storage layer needs — the old `get(x) !== "off"` idiom couldn't tell "the viewer
// asked for it" from "nobody said anything", so a URL that says nothing would have overwritten a saved choice.
function urlOffFlag(params: URLSearchParams, key: string): boolean | null {
  if (!params.has(key)) {
    return null;
  }
  return params.get(key) !== "off";
}

// The twin of `urlOffFlag` for a setting whose default is not a fixed `true`: `?key=off` disables, anything else
// (`?key`, `?key=on`, `?key=1`) enables. Same tri-state contract — null when the param is absent, so a URL that
// says nothing still can't overwrite a saved choice.
function urlOnOffFlag(params: URLSearchParams, key: string): boolean | null {
  return urlOffFlag(params, key);
}

export interface CreateMirrorSettingsOptions {
  /** Injectable web-storage seam. Omit for localStorage; pass `null` for a store that reads/writes nothing. */
  storage?: MirrorSettingsStorage | null;
  /**
   * Whether THIS BUILD compiled in the repro recorder's UI (buildFlags' `REPRO_UI_ENABLED`). Injectable so a
   * test can exercise the excluded build without a second bundle. See `reproRecorder`'s layering below.
   */
  reproUiEnabled?: boolean;
}

// Build a fresh reactive store, layering defaults < tier floor < saved choices < URL query (see the module
// header). `search` and `options.storage` are injectable for tests.
export function createMirrorSettings(
  quality: RenderQuality = renderQuality(),
  search: string = typeof window !== "undefined" ? window.location.search : "",
  options: CreateMirrorSettingsOptions = {}
): MirrorSettings {
  const params = new URLSearchParams(search);
  const saved = readStoredMirrorSettings(options.storage === undefined ? defaultStorage() : options.storage);
  const reproUiEnabled = options.reproUiEnabled ?? REPRO_UI_ENABLED;
  return reactive<MirrorSettings>({
    // `?shaders=` / `?particles=` win for the session (the documented way to A/B an effect from a link); then the
    // viewer's saved choice; then the shared product default. The tier contributes ONE thing: the hard-off lane,
    // applied as a floor so the panel never offers a mode that physically cannot run.
    shaderMode: shadersHardOff(quality)
      ? "off"
      : (effectModeOverride(search, "shaders") ?? saved.shaderMode ?? DEFAULT_SHADER_MODE),
    particleMode: particlesHardOff(quality)
      ? "off"
      : (effectModeOverride(search, "particles") ?? saved.particleMode ?? DEFAULT_PARTICLE_MODE),
    effectModePinned: false,
    stretchEnabled: urlOffFlag(params, "stretch") ?? saved.stretchEnabled ?? true,
    raiseHeldCard: urlOffFlag(params, "raiseCard") ?? saved.raiseHeldCard ?? true,
    unfocusOnRelease: urlOffFlag(params, "unfocus") ?? saved.unfocusOnRelease ?? true,
    tapToFocus: urlOffFlag(params, "tapFocus") ?? saved.tapToFocus ?? true,
    confirmTap: urlOffFlag(params, "confirmTap") ?? saved.confirmTap ?? true,
    // READABLE-HAND MODE. Query wins for the session, then the viewer's saved choice, then the product default:
    // off everywhere until the viewer deliberately enables it.
    raiseHandCards: urlOnOffFlag(params, "raiseHand") ?? saved.raiseHandCards ?? false,
    // READABILITY SCALING (see the field): ON everywhere by default — the enlargements are what make the mirror
    // playable on a phone, and a desktop viewer comparing against the game turns them off deliberately.
    uiScaling: urlOffFlag(params, "uiScale") ?? saved.uiScaling ?? true,
    spineMode: parseSpineMode(params.get("spineMode")),
    backstopOcclusion: urlOffFlag(params, "backstopOcclude") ?? saved.backstopOcclusion ?? true,
    staticBgEnabled: urlOffFlag(params, "staticBg") ?? saved.staticBgEnabled ?? true,
    // Fail-open latch, always fresh per page load (a reload retries the image from scratch).
    staticBgFailedOpen: false,
    // REPRO RECORDER. `?repro=on|off` wins for the session; otherwise the viewer's saved choice — but ONLY in a
    // build that still shows the switch. In an excluded build the saved value is dropped rather than layered, so
    // a `true` left behind by a previous build cannot arm a recorder the viewer has no way to see or stop. Note
    // the order: the URL param is read either way, which is what keeps the support escape hatch working there.
    reproRecorder: urlOnOffFlag(params, "repro") ?? (reproUiEnabled ? (saved.reproRecorder ?? false) : false),
    // `?latency` is a harness switch that only ever turns the overlay ON, so it can't be a tri-state flag; a saved
    // choice decides when the param is absent.
    latencyOverlay: params.has("latency") || (saved.latencyOverlay ?? false),
    // A saved refresh rate is this viewer's preference and outranks the host's reported baseline — MirrorApp skips
    // its session seed when one exists, so the on-connect push carries the saved value to the game.
    refreshRate: saved.refreshRate ?? DEFAULT_REFRESH_RATE,
    // Local defaults while no session measurement is available. A reported state overwrites these per connection
    // via seedServerSettingsFromSession before the first push.
    // Never persisted — they describe the instance, not the viewer.
    freezeParticles: true,
    freezeSpines: true,
    freezeDecor: true,
    tweenReplay: saved.tweenReplay ?? true,
    // Capability, declared by the build rather than chosen by the viewer: the current browser always drives
    // the trail root. Deliberately NOT layered over a saved value — see the denylist entry.
    trailDriveCapable: true,
    panelOpen: false,
    panelAnchorTop: 56
  });
}

// The app-wide singleton the panel + MirrorView + MirrorApp all share.
export const mirrorSettings = createMirrorSettings();
