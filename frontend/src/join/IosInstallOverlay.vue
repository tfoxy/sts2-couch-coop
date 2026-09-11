<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { translate as t } from "@/i18n";

import {
  computeGenieTransform,
  IOS_INSTALL_DISMISSED_STORAGE_KEY,
  readIosInstallOverlayEnv,
  shouldShowIosInstallHint,
  shouldShowIosInstallOverlay,
  showsOpenAsWebAppToggle,
  writeDismissedFlag,
  type IosInstallOverlayEnv
} from "@/join/joinModel";

// WS1 — the guided "Add to Home Screen" overlay, iPhone/iPad only.
//
// iOS Safari has NO element Fullscreen API, so the home-screen web app is the ONLY chromeless route there — and
// it needs no HTTPS, which is why this works at all on the mod's plain-HTTP LAN origin. What it replaces was a
// single grey line under the seat picker that (per the user) nobody read, competing for attention with the one
// decision that screen actually asks for.
//
// The install path never needs to close this: the Share sheet opens ON TOP of it, so there is exactly one
// legitimate reason to leave — "I don't want fullscreen" — and that is now a deliberate two-step exit (steps →
// confirm), not a single reflex tap. Dismissal is SESSION-ONLY (an in-memory flag, not persisted) unless the
// player explicitly ticks "Don't show this again" on the confirm step, which is the ONLY remaining writer of
// `IOS_INSTALL_DISMISSED_STORAGE_KEY`. The one-way door this used to be is why `@/components/IosInstallButton.vue`
// exists: it fills the slot FullscreenButton leaves empty on iPhone and reopens past both dismissal signals.
const props = defineProps<{
  /** The player has committed to a seat — the moment the payoff of installing is concrete. Rising-edge trigger. */
  armed: boolean;
  /** Manual reopen trigger from IosInstallButton — any change (including on mount, if non-zero) opens the card. */
  openRequest?: number;
  /**
   * Decision inputs. Defaults to the live browser environment; specs pass an explicit env instead of
   * redefining `navigator` / `matchMedia` / `localStorage` globals.
   */
  env?: IosInstallOverlayEnv;
  /** The dismissal jar. Defaults to `localStorage`; null disables persistence (used by specs). */
  storage?: Pick<Storage, "setItem"> | null;
  /** How long the escape link stays absent after an AUTO open. Spec seam; a manual (pill) open ignores this. */
  escapeDelayMs?: number;
}>();

const emit = defineEmits<{ (e: "close"): void }>();

const ESCAPE_DELAY_DEFAULT_MS = 3000;
const GENIE_MS = 400;

type Stage = "closed" | "steps" | "confirm" | "closing";

// Evaluated ONCE per open rather than per render: none of these signals can change within a page load (a UA does
// not change, and a display-mode change means the app was relaunched), and re-reading storage on every render
// would make the overlay flicker the instant the confirm checkbox writes the flag.
const env = computed<IosInstallOverlayEnv>(() => props.env ?? readIosInstallOverlayEnv());

const stage = ref<Stage>("closed");
const escapeShown = ref(false);
const dontShowAgain = ref(false);
// The ONLY thing an ordinary dismissal writes now — in memory, so it lasts exactly one page load. The permanent
// signal is the checkbox, which still goes through `writeDismissedFlag` below.
const sessionDismissed = ref(false);

// iOS 26+ only: the Add sheet grew an "Open as Web App" toggle (on by default) that decides whether the icon
// launches chromeless. Below 26 the toggle does not exist and mentioning it sends the player hunting.
const mentionsWebAppToggle = computed(() => showsOpenAsWebAppToggle(env.value.userAgent));

const card = ref<HTMLElement | null>(null);
const backdrop = ref<HTMLElement | null>(null);
let escapeTimer: ReturnType<typeof setTimeout> | undefined;

function clearEscapeTimer(): void {
  if (escapeTimer !== undefined) {
    clearTimeout(escapeTimer);
    escapeTimer = undefined;
  }
}

function open(kind: "auto" | "manual"): void {
  if (stage.value !== "closed") return; // already open (or mid-genie) — a second trigger is a no-op
  if (kind === "auto") {
    if (sessionDismissed.value || !shouldShowIosInstallOverlay(env.value)) return;
  } else if (!shouldShowIosInstallHint(env.value)) {
    // Manual (pill) opens bypass BOTH dismissal signals — that is the whole point of the pill — but still
    // respect the PLATFORM gate: it cannot show on Android, desktop, or once actually installed.
    return;
  }
  dontShowAgain.value = false;
  stage.value = "steps";
  clearEscapeTimer();
  const delay = props.escapeDelayMs ?? ESCAPE_DELAY_DEFAULT_MS;
  if (kind === "manual" || delay <= 0) {
    escapeShown.value = true;
  } else {
    escapeShown.value = false;
    escapeTimer = setTimeout(() => {
      escapeShown.value = true;
    }, delay);
  }
}

watch(
  () => props.armed,
  (armed) => {
    if (armed) open("auto");
  },
  { immediate: true }
);

// NOT immediate: a parent mounting with a non-zero starting tick must not open on mount — only a CHANGE does.
watch(
  () => props.openRequest,
  (tick, previousTick) => {
    if (tick === undefined || tick === previousTick) return;
    open("manual");
  }
);

/** "Play in the tab anyway" (steps) — the first press only ASKS; it never leaves on its own. */
function requestEscape(): void {
  stage.value = "confirm";
}

/** "Back to the steps" — the escape link stays visible; there is no reason to re-run its delay. */
function backToSteps(): void {
  stage.value = "steps";
}

function safeLocalStorage(): Pick<Storage, "setItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function findGenieTarget(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector('[data-testid="ios-install-button"]');
}

function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
    );
  } catch {
    return false;
  }
}

/** Land-and-settle pulse on the pill, so a player who was not watching still notices where the card went. */
function pulse(target: Element | null): void {
  if (!target || prefersReducedMotion()) return;
  const el = target as HTMLElement;
  if (typeof el.animate !== "function") return;
  el.animate(
    [{ transform: "scale(1)" }, { transform: "scale(1.3)", offset: 0.4 }, { transform: "scale(1)" }],
    { duration: 350, easing: "ease-out" }
  );
}

function settleClose(): void {
  stage.value = "closed";
  emit("close");
}

/** "Play in the tab" (confirm) / Escape while on confirm — the only route that actually leaves. */
function confirmStay(): void {
  if (dontShowAgain.value) {
    const storage = props.storage !== undefined ? props.storage : safeLocalStorage();
    writeDismissedFlag(storage, IOS_INSTALL_DISMISSED_STORAGE_KEY);
  }
  beginClose();
}

function beginClose(): void {
  sessionDismissed.value = true;
  clearEscapeTimer();
  const cardEl = card.value;
  const targetEl = findGenieTarget();
  const geometry =
    cardEl && targetEl
      ? computeGenieTransform(cardEl.getBoundingClientRect(), targetEl.getBoundingClientRect())
      : null;
  // No measurable pill (a screen with none mounted), reduced motion, or no WAAPI (jsdom): skip straight
  // to an instant close rather than animate toward nothing.
  if (!geometry || prefersReducedMotion() || typeof cardEl?.animate !== "function") {
    settleClose();
    return;
  }
  stage.value = "closing";
  const anim = cardEl.animate(
    [
      { transform: "none", opacity: 1 },
      {
        transform: `translate(${geometry.dx}px, ${geometry.dy}px) scale(${geometry.scale})`,
        opacity: 0.15
      }
    ],
    { duration: GENIE_MS, easing: "cubic-bezier(0.5, 0, 0.85, 0.6)", fill: "forwards" }
  );
  if (typeof backdrop.value?.animate === "function") {
    backdrop.value.animate([{ opacity: 1 }, { opacity: 0 }], { duration: GENIE_MS, fill: "forwards" });
  }
  // `oncancel` covers the (rare) case something else clears the animation mid-flight — either path must still
  // settle, or the overlay would stay mounted forever with `pointer-events: none` swallowing the screen.
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    pulse(targetEl);
    settleClose();
  };
  anim.onfinish = settle;
  anim.oncancel = settle;
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  if (stage.value === "steps") {
    event.stopPropagation();
    stage.value = "confirm"; // works even inside the escape-link's delay window — Escape is never gated by it
  } else if (stage.value === "confirm") {
    event.stopPropagation();
    confirmStay();
  }
  // "closing": already leaving, nothing to do.
}

// `flush: "post"` so `card` is populated by the time we reach for focus. Re-runs on every stage change (not just
// closed↔open) so each stage is announced; `addEventListener` with the same fn+capture is idempotent, so
// attaching again on steps↔confirm is harmless.
watch(
  stage,
  (s) => {
    if (typeof document === "undefined") return;
    if (s === "closed") {
      document.removeEventListener("keydown", onKeyDown, true);
    } else {
      document.addEventListener("keydown", onKeyDown, true);
    }
    if (s === "steps" || s === "confirm") card.value?.focus();
  },
  { immediate: true, flush: "post" }
);

onBeforeUnmount(() => {
  clearEscapeTimer();
  if (typeof document !== "undefined") {
    document.removeEventListener("keydown", onKeyDown, true);
  }
});
</script>

<template>
  <div
    v-if="stage !== 'closed'"
    class="ios-install-overlay"
    :class="{ 'ios-install-overlay--closing': stage === 'closing' }"
    data-testid="ios-install-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="ios-install-title"
  >
    <!-- Its own layer so the genie can fade the backdrop independently of the flying card. -->
    <div ref="backdrop" class="ios-install-backdrop" aria-hidden="true"></div>

    <div ref="card" class="ios-install-card" tabindex="-1">
      <template v-if="stage === 'steps'">
        <p class="surface-kicker">{{ t('ios.kicker') }}</p>
        <h1 id="ios-install-title">{{ t('ios.title') }}</h1>
        <p class="ios-install-lede">{{ t('ios.lede') }}</p>

        <ol class="ios-install-steps">
          <li>
            <span class="ios-install-step-num" aria-hidden="true">1</span>
            <span class="ios-install-step-body">
              {{ t('ios.step1Before') }}
              <span class="ios-glyph" data-testid="ios-share-glyph">
                <!-- The real iOS Share glyph: a tray with an arrow leaving through the top. Inline SVG so it is
                     crisp at any size and does not depend on an emoji font the device may not have. -->
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
                  <path d="M12 3v12" />
                  <path d="M8.5 6.5 12 3l3.5 3.5" />
                  <path d="M6 11H4.75A1.75 1.75 0 0 0 3 12.75v6.5C3 20.216 3.784 21 4.75 21h14.5A1.75 1.75 0 0 0 21 19.25v-6.5A1.75 1.75 0 0 0 19.25 11H18" />
                </svg>
              </span>
              <strong>{{ t('ios.step1After') }}</strong>
            </span>
          </li>
          <li>
            <span class="ios-install-step-num" aria-hidden="true">2</span>
            <span class="ios-install-step-body">
              {{ t('ios.step2Before') }}
              <span class="ios-glyph" data-testid="ios-add-glyph">
                <!-- "Add to Home Screen"'s own row glyph: a plus inside a rounded square. Also IosInstallButton's
                     icon — the confirm step's reopen hint points at this exact shape. -->
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
                  <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
                  <path d="M12 8.5v7M8.5 12h7" />
                </svg>
              </span>
              <strong>{{ t('ios.step2After') }}</strong>
            </span>
          </li>
          <li>
            <span class="ios-install-step-num" aria-hidden="true">3</span>
            <span class="ios-install-step-body">
              {{ t('ios.step3Before') }}<strong>{{ t('ios.add') }}</strong>{{ t('ios.step3After') }}
              <span
                v-if="mentionsWebAppToggle"
                class="ios-install-note"
                data-testid="ios-open-as-web-app-note"
              >
                {{ t('ios.webApp') }}
              </span>
            </span>
          </li>
        </ol>

        <div class="ios-install-actions">
          <button
            v-if="escapeShown"
            type="button"
            class="ios-install-stay-link ios-install-stay-link--delayed"
            data-testid="ios-install-stay"
            @click="requestEscape"
          >
            {{ t('ios.stayAnyway') }}
          </button>
        </div>
      </template>

      <template v-else>
        <!-- Confirm AND closing — dismissal only ever leaves FROM here, so this is also what shrinks away. -->
        <p class="surface-kicker">{{ t('ios.kicker') }}</p>
        <h1 id="ios-install-title">{{ t('ios.confirmTitle') }}</h1>
        <p class="ios-install-confirm-body">{{ t('ios.confirmBody') }}</p>
        <p class="ios-install-confirm-hint" data-testid="ios-install-reopen-hint">
          {{ t('ios.reopenBefore') }}
          <span class="ios-glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
              stroke-linecap="round" stroke-linejoin="round" focusable="false">
              <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
              <path d="M12 8.5v7M8.5 12h7" />
            </svg>
          </span>
          {{ t('ios.reopenAfter') }}
        </p>

        <div class="ios-install-actions ios-install-actions--confirm">
          <button type="button" class="ios-install-primary" data-testid="ios-install-back" @click="backToSteps">
            {{ t('common.back') }}
          </button>
          <button
            type="button"
            class="ios-install-stay-link"
            data-testid="ios-install-confirm-stay"
            @click="confirmStay"
          >
            {{ t('common.playInTab') }}
          </button>
        </div>
        <label class="ios-install-dont-show">
          <input v-model="dontShowAgain" type="checkbox" data-testid="ios-install-dont-show" />
          {{ t('ios.dontShow') }}
        </label>
      </template>
    </div>

    <!-- The pointer at the toolbar. STEPS ONLY — it aims at the Share button, which the confirm card is not
         about. It points DOWN because that is where the Safari toolbar (and its Share button) lives by default
         on iPhone — but it is TOP under Safari's Single Tab layout and always top on iPad, and we cannot detect
         which, so the caption names the other case instead of guessing. -->
    <div v-if="stage === 'steps'" class="ios-install-pointer" aria-hidden="true" data-testid="ios-install-pointer">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
        stroke-linecap="round" stroke-linejoin="round" focusable="false">
        <path d="M12 4v14" />
        <path d="M6 13l6 6 6-6" />
      </svg>
    </div>
    <p v-if="stage === 'steps'" class="ios-install-pointer-caption" data-testid="ios-install-pointer-caption">
      The Share button is down here — or at the top of the screen if your address bar is up there.
    </p>
  </div>
</template>

<style scoped>
/* CouchCoop's OWN chrome (a browser-space overlay above the letterboxed stage), never @spirectl/godot-scene-web
   presentation DOM — so styling it here is by design. Fixed + max z so it survives whatever the mirror stage's
   reconciler does to DOM order underneath it. */
.ios-install-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: max(0.75rem, env(safe-area-inset-top)) 1rem
    calc(max(0.75rem, env(safe-area-inset-bottom)) + 3.4rem);
  overscroll-behavior: contain;
}

/* Lets a tap heading for the re-open pill (a sibling of this overlay, one layer down) land while the card is
   mid-flight instead of being eaten by the fading backdrop above it. */
.ios-install-overlay--closing {
  pointer-events: none;
}

.ios-install-backdrop {
  position: absolute;
  inset: 0;
  background: rgb(2 5 8 / 88%);
  -webkit-backdrop-filter: blur(3px);
  backdrop-filter: blur(3px);
}

.ios-install-card {
  /* A POSITIONED sibling (the backdrop, now absolute) paints ABOVE a static one regardless of DOM order — this
     keeps the card in the same stacking context as the backdrop so it lands on top, not under it. */
  position: relative;
  width: min(34rem, 100%);
  max-height: 100%;
  padding: clamp(0.8rem, 3.5vw, 1.4rem);
  overflow-y: auto;
  border: 1px solid rgb(255 255 255 / 14%);
  border-radius: 12px;
  background: rgb(9 13 16 / 96%);
  box-shadow: 0 18px 48px rgb(0 0 0 / 55%);
}

.ios-install-card:focus {
  outline: none;
}

.ios-install-card h1 {
  font-size: clamp(1.05rem, 4.2vw, 1.6rem);
}

.ios-install-lede,
.ios-install-confirm-body {
  margin: 0.5rem 0 0;
  color: #b6c4cf;
  font-size: clamp(0.78rem, 3vw, 0.95rem);
  line-height: 1.35;
}

.ios-install-confirm-hint {
  margin: 0.6rem 0 0;
  color: #8b98a8;
  font-size: 0.86em;
  line-height: 1.35;
}

.ios-install-confirm-hint .ios-glyph {
  color: #7cc7ee;
}

.ios-install-steps {
  display: grid;
  gap: clamp(0.5rem, 2.2vw, 0.8rem);
  margin: clamp(0.75rem, 3vw, 1.1rem) 0 0;
  padding: 0;
  list-style: none;
}

.ios-install-steps li {
  display: grid;
  grid-template-columns: 1.6rem minmax(0, 1fr);
  gap: 0.6rem;
  align-items: start;
}

.ios-install-step-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  height: 1.6rem;
  border-radius: 50%;
  color: #071015;
  background: #7cc7ee;
  font-size: 0.85rem;
  font-weight: 800;
}

.ios-install-step-body {
  font-size: clamp(0.82rem, 3.1vw, 1rem);
  line-height: 1.45;
}

/* The inline iOS glyphs sit on the text baseline at cap height so "tap the [glyph] Share button" reads as one
   sentence rather than as a picture wedged into a line of prose. */
.ios-glyph {
  display: inline-block;
  width: 1.05em;
  height: 1.05em;
  margin: 0 0.12em;
  color: #7cc7ee;
  vertical-align: -0.18em;
}

.ios-glyph svg {
  display: block;
  width: 100%;
  height: 100%;
}

.ios-install-note {
  display: block;
  margin-top: 0.3rem;
  color: #b6c4cf;
  font-size: 0.86em;
  line-height: 1.35;
}

.ios-install-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  /* Reserves the delayed escape link's height so it does not reflow the card when it fades in. */
  min-height: 2.4rem;
  margin-top: clamp(0.8rem, 3vw, 1.2rem);
}

.ios-install-actions--confirm {
  flex-direction: column;
  align-items: stretch;
  min-height: 0;
}

.ios-install-actions--confirm .ios-install-stay-link {
  align-self: center;
}

.ios-install-primary {
  min-height: 2.6rem;
  padding: 0 1rem;
  border: 1px solid rgb(255 255 255 / 14%);
  border-radius: 6px;
  color: #071015;
  background: #7cc7ee;
  font: inherit;
  font-weight: 700;
}

.ios-install-actions--confirm .ios-install-primary {
  width: 100%;
}

/* Deliberately unobtrusive — a text link, not a button — because both places it appears (the steps escape and
   the confirm dismissal) are the "I don't want this" path, and a reflex tap should not find a button-shaped
   target sitting where the primary action usually is. */
.ios-install-stay-link {
  min-height: 2.2rem;
  padding: 0 0.3rem;
  border: 0;
  background: none;
  color: #8b98a8;
  font: inherit;
  font-weight: 500;
  font-size: 0.85rem;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}

.ios-install-stay-link--delayed {
  animation: ios-install-fade-in 250ms ease-out;
}

.ios-install-dont-show {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.9rem;
  color: #b6c4cf;
  font-size: 0.85rem;
}

.ios-install-dont-show input {
  width: 1.15rem;
  height: 1.15rem;
}

.ios-install-primary:focus-visible,
.ios-install-stay-link:focus-visible {
  outline: 3px solid rgb(124 199 238 / 72%);
  outline-offset: 2px;
}

.ios-install-pointer {
  position: absolute;
  bottom: calc(max(0.75rem, env(safe-area-inset-bottom)) + 1.5rem);
  left: 50%;
  width: 2rem;
  height: 2rem;
  color: #7cc7ee;
  transform: translateX(-50%);
  animation: ios-install-nudge 1.6s ease-in-out infinite;
}

.ios-install-pointer svg {
  display: block;
  width: 100%;
  height: 100%;
}

.ios-install-pointer-caption {
  position: absolute;
  bottom: max(0.4rem, env(safe-area-inset-bottom));
  left: 50%;
  width: min(26rem, 92%);
  margin: 0;
  color: #8b98a8;
  font-size: clamp(0.66rem, 2.6vw, 0.78rem);
  line-height: 1.25;
  text-align: center;
  transform: translateX(-50%);
}

@keyframes ios-install-nudge {
  0%,
  100% {
    transform: translate(-50%, 0);
  }

  50% {
    transform: translate(-50%, 25%);
  }
}

@keyframes ios-install-fade-in {
  from {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ios-install-pointer {
    animation: none;
  }

  .ios-install-stay-link--delayed {
    animation: none;
  }
}

/* SHORT VIEWPORT (a phone held landscape — ~390px tall on an iPhone, and the orientation the game wants). The
   card scrolls, but a player who cannot SEE the exits will not go looking for them, so both stages are squeezed
   until they fit: the lede/body goes (the heading already says what this is), the steps tighten, and the
   pointer band gives back the space it was reserving. */
@media (max-height: 560px) {
  .ios-install-overlay {
    padding: max(0.35rem, env(safe-area-inset-top)) 0.75rem
      calc(max(0.35rem, env(safe-area-inset-bottom)) + 3.5rem);
  }

  .ios-install-card {
    padding: 0.6rem 0.9rem;
  }

  .ios-install-card h1 {
    font-size: 1.05rem;
  }

  .ios-install-lede,
  .ios-install-confirm-body {
    display: none;
  }

  .ios-install-confirm-hint {
    margin-top: 0.35rem;
  }

  .ios-install-steps {
    gap: 0.3rem;
    margin-top: 0.55rem;
  }

  .ios-install-step-body {
    font-size: 0.85rem;
    line-height: 1.3;
  }

  .ios-install-actions {
    margin-top: 0.6rem;
  }

  .ios-install-dont-show {
    margin-top: 0.5rem;
  }

  .ios-install-primary {
    min-height: 2.2rem;
  }

  /* The caption wraps to two lines on a wide-but-short screen, so the arrow has to clear both of them. */
  .ios-install-pointer {
    bottom: calc(max(0.3rem, env(safe-area-inset-bottom)) + 2.1rem);
    width: 1.3rem;
    height: 1.3rem;
  }

  .ios-install-pointer-caption {
    bottom: max(0.2rem, env(safe-area-inset-bottom));
    font-size: 0.66rem;
  }
}
</style>
