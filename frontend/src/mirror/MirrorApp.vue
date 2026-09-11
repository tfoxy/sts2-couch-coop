<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { translate as t } from "@/i18n";

import FullscreenButton from "@/components/FullscreenButton.vue";
import IosInstallButton from "@/components/IosInstallButton.vue";
import PortraitNagOverlay from "@/components/PortraitNagOverlay.vue";
import SettingsGearButton from "@/components/SettingsGearButton.vue";
import { useFullscreen } from "@/composables/useFullscreen";
import { shouldUseFixedChrome, usePortraitViewport } from "@/composables/usePortraitViewport";
import BrowserAdvisory from "@/join/BrowserAdvisory.vue";
import IosInstallOverlay from "@/join/IosInstallOverlay.vue";
import { REPRO_UI_ENABLED } from "@/mirror/buildFlags";
import { reproRecorder } from "@/mirror/reproRecorder";
import LatencyOverlay from "@/mirror/LatencyOverlay.vue";
import ReproBadge from "@/mirror/ReproBadge.vue";
import SettingsPanel from "@/mirror/SettingsPanel.vue";
import MirrorConfirmButton from "@/mirror/MirrorConfirmButton.vue";
import MirrorHandRaiseButton from "@/mirror/MirrorHandRaiseButton.vue";
import MirrorView from "@/mirror/MirrorView.vue";
import StaticBackground from "@/mirror/StaticBackground.vue";
import {
  buildHeadlessMirrorWebSocketUrl,
  connectMirrorClient,
  emptyMirrorLatency,
  SCROLL_ELEMENT_ID_ARG,
  SCROLL_OFFSET_ARG,
  SET_SCROLL_OFFSET_ACTION_ID,
  type MirrorClient,
  type MirrorClientStatus,
  type MirrorInputMessage,
  type MirrorLatency,
  type MirrorScrollAck
} from "@/mirror/mirrorClient";
import type { MirrorActionMessage } from "@/mirror/mapNodeTap";
import {
  hasStoredMirrorSetting,
  mirrorSettings,
  seedServerSettingsFromSession,
  serverSettingsPayload,
  staticBgWireValue,
  SERVER_SETTING_KEYS
} from "@/mirror/mirrorSettings";
import {
  findAutoRejoinSeat,
  nextReconnectDelayMs,
  reconnectStateAfterDrop,
  reconnectStateAfterReconnect,
  reconnectStateAfterViewRestored,
  rejoinSeatIsBlocked,
  steadyReconnectState,
  RECONNECT_BASE_DELAY_MS,
  type RejoinTarget
} from "@/mirror/reconnectPolicy";
import { computeMirrorLoadingState, mirrorLoadingLabel } from "@/mirror/loadingState";
import { prefetchMirrorImages } from "@/mirror/imagePrefetch";
import { createMirrorState } from "@/mirror/sceneTree";
import type { BrowserSessionEnvelope } from "@/protocol/browserEnvelope";
import MirrorJoinPicker from "@/mirror/MirrorJoinPicker.vue";
import MirrorHostWaiting from "@/mirror/MirrorHostWaiting.vue";
import {
  computeMirrorJoinMode,
  hasNameParam,
  isIosInstallForced,
  isMultiplayerMirrorMode,
  isNonJoinableMirrorMode,
  joinInfoFromSession,
  mirrorRosterFor,
  readStoredName,
  readUrlName,
  readUrlNameState,
  rememberJoinedName,
  shouldReloadForUrlNameChange,
  shouldWatchHostStream,
  trimName,
  urlNameStateFor,
  writeUrlNameParam,
  type UrlNameState
} from "@/join/joinModel";

// The ONLY prop, and it exists for testability: a page reload can't be stubbed in jsdom (`location.reload` is
// [LegacyUnforgeable], so neither `vi.spyOn` nor `defineProperty` can touch it), and the back-navigation rule
// below is defined by *when* it reloads. Same seam shape as mirrorClient's `reloadOnServerReload`.
const props = defineProps<{ reloadPage?: () => void }>();
const forceReload = (): void => {
  if (props.reloadPage) {
    props.reloadPage();
    return;
  }
  globalThis.location?.reload();
};

// Maps a server `joinRejection` code to the message the picker shows. The default is the "wrong name" copy the
// product spec calls for (covers a bad `?name=` and a mid-run newcomer picking a non-session player).
const JOIN_REJECTION_MESSAGES: Record<string, "join.notSession" | "join.noFreeInstance" | "join.spawnFailed" | "join.seatUnavailable" | "join.failed"> = {
  "not-a-session-player": "join.notSession",
  "no-free-instance": "join.noFreeInstance",
  "spawn-failed": "join.spawnFailed",
  // The picked seat's server-derived seatStatus is not "ready". The picker disables those rows, so this only
  // surfaces when the roster was stale at the moment of the tap.
  "seat-unavailable": "join.seatUnavailable",
  // The host's join handler THREW. Unlike every code above it, this one says nothing about what to do — the
  // reason is a server fault the viewer can't have caused — so the host's own text rides along in
  // `joinRejectionDetail` and is rendered under this line.
  "join-failed": "join.failed"
};
const rejectionMessage = (code: string): string =>
  JOIN_REJECTION_MESSAGES[code] ? t(JOIN_REJECTION_MESSAGES[code]) : code;
// The client-side ceiling on a join: how long "Joining…" may run with the host saying NOTHING at all before we
// give the viewer their form back. Deliberately well clear of the host's own 60s spawn deadline
// (HeadlessClientManager.WaitForReadyAsync) — a cold seat that is merely slow answers within that and must never
// be failed here. This only catches a host that never answers, which is the one shape neither the rejection
// channel nor the action-result backstop can see.
const JOIN_TIMEOUT_MS = 90_000;

// Self-contained mirror app: owns its own `/ws` connection (the standalone mirror client) and renders the
// live tree from the retained delta map. The PRE-JOIN screen (per-seat buttons, a name field where a new
// player may be added, name memory + `?name=` auto-join) is driven by the `session` envelope the mirror
// connection receives — never by the scene.
//
// The client mutates its retained Map in place and bumps `state.revision`; we mirror that into a `revision`
// ref (and `status`/`session`) so Vue recomputes. On a co-op join, the host spawns a headless game instance
// and replies with `headlessMirrorPort`; the app reconnects there so the player sees their own game view —
// `activeClient` is replaced and `mirrorState` updated.

prefetchMirrorImages();

// `?latency=1` turns on the ping→pong RTT probe + the on-screen readout (off by default, zero overhead).
const latencyEnabled =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("latency");

// ---- REPRO RECORDER (reproRecorder.ts) -------------------------------------------------------------------
//
// The arming point. Everything else about the recorder is already wired at the two places the data flows
// through — the wire taps inside `connectMirrorClient`, the stage listeners inside MirrorView — so this file
// owns only three things: WHEN it runs, WHAT the file's meta says about this session, and the console seam.
//
// PLACED ABOVE THE FIRST `makeClient()` ON PURPOSE. Setup runs top to bottom, so arming further down means the
// first socket is constructed before the recorder exists and its `ctor` line — and, on a fast connect, the
// connect-time keyframe — never reach the file. A bug that only happens on a reload has to have the reload in it.
//
// `?reproBufMb=` resizes the ring for this session only (never persisted): the default 32 MB is ~1–6 minutes of
// combat hindsight, and a phone hunting a rare bug may want more, while a memory-tight device wants less.
const reproParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
const reproBufMb = Number(reproParams?.get("reproBufMb"));
if (Number.isFinite(reproBufMb) && reproBufMb > 0) {
  reproRecorder.setBufferCapBytes(reproBufMb * 1024 * 1024);
}

// The badge is UI, so it obeys the build flag — EXCEPT on the explicit URL path. An excluded build that a
// support session armed with `?repro=on` still has to give the player a SAVE button, or the recording it is
// making can never leave the device. Same tri-state reading as the setting's own layering (present and not
// "off" ⇒ armed), so the two can't disagree about what the URL said.
const reproArmedByUrl = reproParams !== null && reproParams.has("repro") && reproParams.get("repro") !== "off";
const showReproBadge = computed(() => mirrorSettings.reproRecorder && (REPRO_UI_ENABLED || reproArmedByUrl));

// This is the URL of the module the browser actually executed, not a Git revision inferred by the person
// reading the recording. It catches the useful distinction when a device had an old emitted chunk or a dev server
// from another worktree: a repro tells us which bundle supplied the client behaviour before we replay it.
const moduleBundle = import.meta.url;

// The app-side half of the file's meta. The recorder itself records nothing about the mirror (it has no mirror
// imports by design), so the facts an offline tool needs to interpret a recording — which settings were in
// force, and what geometry the recorded client coordinates were taken against — are supplied from here, read
// fresh at save time.
reproRecorder.setMetaSupplier(() => {
  const stage = typeof document !== "undefined" ? document.querySelector<HTMLElement>(".mirror-stage") : null;
  const rect = stage?.getBoundingClientRect() ?? null;
  return {
    moduleBundle,
    // A plain copy of the reactive store: every field is a primitive, so this is the whole panel state.
    settings: { ...mirrorSettings },
    // The stage's DESIGN width (1920, or the widened value under widescreen stretch) and its on-screen box.
    // Together these are the transform a recorded clientX/clientY was taken through — without them a replay on
    // a differently-shaped window cannot know whether it is reproducing the bug or a different geometry.
    designWidth: stage ? Number.parseFloat(stage.style.width) || null : null,
    stageRect: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null
  };
});

// Arm/disarm from the setting, `immediate` so a saved (or `?repro=on`) choice is recording before the first
// frame rather than after the first change. The setting is the ONLY arming path: the URL param and the build
// flag both act by deciding what that setting is (see mirrorSettings' layering).
watch(
  () => mirrorSettings.reproRecorder,
  (on) => (on ? reproRecorder.start() : reproRecorder.stop()),
  { immediate: true }
);

// Console/harness seam, same function-per-call idiom as `__mirrorSendInput` and `__mirrorShaderStats`: a desktop
// session can drive the whole recorder from devtools without the badge, and the offline replayer reads
// `stats()` to confirm a page really is (or is NOT) recording.
if (typeof window !== "undefined") {
  (window as unknown as { __mirrorRepro?: unknown }).__mirrorRepro = {
    start: () => reproRecorder.start(),
    stop: () => reproRecorder.stop(),
    marker: (note?: string) => reproRecorder.marker(note),
    save: () => reproRecorder.save(),
    stats: () => reproRecorder.stats()
  };
}

const status = ref<MirrorClientStatus>("connecting");
const revision = ref(-1);
const latency = ref<MirrorLatency>(emptyMirrorLatency());
const mirrorState = shallowRef(createMirrorState()); // replaced with activeClient.state immediately below
// The latest `session` from the HOST connection — feeds the shared join screen (roster + screen kind).
const joinSession = shallowRef<BrowserSessionEnvelope | null>(null);
// True only after the host assigns us a headless game instance and we've reconnected to it.
// Prevents the host's scene stream from showing before the player has joined.
const joined = ref(false);
// Direct-view (watch the HOST's own stream in place, no redirect): set by the server's `directView` directive
// for a singleplayer run or a host/watch-only selection. Kept SEPARATE from `joined` because the two differ
// everywhere else (no redirect, no `?name=` stamp, a SHARED host socket) — the server-settings channel is the one
// thing they share, and here it addresses the host's OWN game, which the panel says out loud (`directView` is
// passed to SettingsPanel for exactly that).
const directView = ref(false);
// Rejection message shown on the picker when a join name isn't servable (wrong `?name=`, mid-run newcomer, …).
const joinMessage = ref<string | null>(null);
// The host's own fault text under that message — only ever set for a server-side failure ("join-failed" or the
// action-result backstop). Cleared in lockstep with `joinMessage` everywhere.
const joinDetail = ref<string | null>(null);

// Name memory + `?name=` auto-join. `urlName` (if present) auto-joins on
// connect; `prefillName` only pre-fills the form. `pendingName` is the in-flight join target (null = idle).
const urlName = readUrlName();
const prefillName = ref(urlName ?? readStoredName(globalThis.sessionStorage) ?? "");
const pendingName = ref<string | null>(null);
let autoJoinSent = false;
// An EMPTY `?name=` (present, no value) is the HOST player's own browser: the marker this app stamps when it
// enters a multiplayer direct view. `readUrlName` trims it to null, so it can never be mistaken for a seat —
// the two are told apart by `hasNameParam`, and only here.
const urlWantsHostView = hasNameParam() && urlName === null;
// One attempt per connection, exactly like `autoJoinSent` (and re-armed by the same reconnect rule).
let hostViewRequested = false;
// What the page URL SHOULD say for the join state this page currently holds — the yardstick every `popstate` is
// judged against. Seeded from the URL we LOADED with (that URL is what the auto-join / auto-host-view below act
// on, so they agree by construction) and updated at every stamp. Nothing else writes `?name=`.
let expectedUrlName: UrlNameState = readUrlNameState();
// F3 — the seat this page's URL names RIGHT NOW, or null for "no seat" (no param at all, or the empty host
// marker). Reactive, and deliberately not the load-time `urlName` constant, because the answer MOVES within one
// page life: a viewer that joins from the picker stamps a seat name it never loaded with, and one that presses
// "Control host" replaces a seat name with the marker.
const urlSeatName = ref(expectedUrlName.name);
// …and the predicate the F3 rules actually read: "this browser is a PLAYER waiting for a game, not a spectator of
// the host's screen." It pulls no scene bytes on a screen it cannot join (the stream gate's 6th argument), shows
// the waiting screen instead of the picker, and never asks for a singleplayer direct view. Derived rather than
// stored, so it cannot disagree with the name it is supposed to describe.
const urlSeatIntent = computed(() => urlSeatName.value !== null);

// The ONE place the two facts above are updated, so they cannot drift apart. Drift is not cosmetic:
// `expectedUrlName` alone decides whether a popstate reloads, `urlSeatName` alone decides whether the host's
// stream is pulled — so a stamp that moved one without the other would leave a viewer who dropped out of their
// seat silently watching the host's game from a URL that says otherwise.
function rememberUrlName(value: string | null): void {
  expectedUrlName = urlNameStateFor(value);
  urlSeatName.value = expectedUrlName.name;
}

// Stamp `?name=` and remember what we stamped. `push` (the join / host-view stamps) makes the change a real
// navigation the Back button can reverse; `replace` is only for silently dropping a marker nobody navigated to.
function setUrlNameParam(value: string | null, mode: "push" | "replace"): void {
  writeUrlNameParam(value, mode);
  rememberUrlName(value);
}

// BACK / FORWARD. The URL moved under us; if it no longer describes the join state we hold, reload. A reload is
// the only reset that is guaranteed consistent with every module's lazy `window.location` read (several parse
// the search string once, on first access) — and the page it lands on re-runs the whole join dance from the new
// URL: the picker (no param), an auto-join (`?name=Ann`) or an auto host-view (`?name=`). Hot-unwinding a joined
// socket instead would leave the headless instance, the stream gate and the settings channel to be undone by
// hand, which is exactly the sort of half-reset this app has been bitten by before.
function handlePopState(): void {
  if (!shouldReloadForUrlNameChange(expectedUrlName, readUrlNameState())) {
    return; // same effective state (a hash change or repeat event) — never reload on a no-op
  }
  forceReload();
}
if (typeof window !== "undefined") {
  window.addEventListener("popstate", handlePopState);
}
// A singleplayer run (and host-watch) can't be joined through a form — the server grants `directView` only in
// REPLY to a join. Without one, a solo-run watcher stays an unassigned observer whose Settings-panel server
// controls (refresh rate / freezes / tween replay) forward NOWHERE. We proactively send one empty-name join per
// SP-run entry so the server replies `directView` and the settings channel activates. Reset when we leave the
// SP-run screen so a later run re-requests.
let directViewRequested = false;
// The panel's Refresh-rate label seeds from a hardcoded default (24); the host reports its REAL baseline on the
// `session` envelope. Seed the store from it ONCE (first session carrying it) so the label is truthful AND the
// on-connect settings push echoes the host's own value (idempotent → connecting never throttles the host).
//
// …UNLESS this viewer has a SAVED refresh rate. Then the envelope seed is skipped and the store keeps the saved
// value, which the one-shot push then carries TO the host — the same seed-then-push order as the freezes, with the
// authority the other way round. That is the whole point of persisting a server-tied field: a phone that chose 12
// fps last night must not be silently put back on the host's baseline every time it reconnects. (`freeze*` stays
// host-truth and is never persisted; see mirrorSettings.)
let refreshRateSeeded = false;

// All clients ever created — closed together on unmount. We keep the HOST connection open
// after redirect (don't close it immediately) so the host doesn't call Release() and kill the
// headless process before the browser has time to establish the new WS connection.
const allClients: MirrorClient[] = [];

// DROP → RECONNECT → REJOIN (parity with the native ConnectionCoordinator; rules in @/mirror/reconnectPolicy).
// A viewer's game view is served by a disposable HEADLESS instance: it EXITS when its connection to the host game
// is permanently gone (host process died, or the run dropped it), which used to leave the browser frozen on its
// last frame forever. Now any drop of the ACTIVE connection falls back to the ORIGINAL host address (the page's
// own origin), reconnects with exponential backoff, and re-runs the join dance — so the seat comes back on its
// own once the host reloads the saved run.
// The seat to reclaim, remembered across the drop (null = nothing to auto-rejoin: never joined, or a rejoin was
// refused). `lastJoinAttempt` holds the in-flight one until the host confirms it with a redirect.
let rejoinTarget: RejoinTarget | null = null;
let lastJoinAttempt: RejoinTarget | null = null;
let reconnectDelayMs = RECONNECT_BASE_DELAY_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
// Armed while a join is in flight (see the `pendingName` watcher); the last line of defence against a
// never-ending "Joining…".
let joinTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
// The drop PHASE + attempt counter (reconnectPolicy owns the rules; this is the reactive cell they live in, so
// the screen can tell a 1s blip — "Reconnecting…", spinner, no copy — from a host that is genuinely gone or a
// seat the host refuses. Deliberately reactive,
// unlike the ladder state above it: the previous version kept everything here non-reactive and therefore had no
// way to say anything but "set the scary message immediately, forever" (that message is gone now — see
// joinNotice — but the phase it was derived from is real and still drives the "Reconnecting…" spinner).
const reconnectState = ref(steadyReconnectState());

// Forward-declared so callbacks can check whether they belong to the current client.
let activeClient: MirrorClient;

// The latency probe runs only while something is actually SHOWING the numbers: the settings panel is open (start on
// open, stop on close), the viewer turned on the floating overlay (which stays up with the panel closed — native
// parity with UiRoot's SettingsPanelOpen || OverlayEnabled), or the legacy `?latency=1` harness path, which keeps it
// on for the whole session. 250ms cadence; 0 = off.
const PROBE_INTERVAL_MS = 250;
const desiredPingIntervalMs = () =>
  mirrorSettings.panelOpen || mirrorSettings.latencyOverlay || latencyEnabled ? PROBE_INTERVAL_MS : 0;

// The joined (headless) connections that have already received the initial settings push (once each, on connect).
const settingsPushed = new WeakSet<MirrorClient>();
// The connections whose reported "Host performance" truth has already been adopted (once each, on their first
// `session`). Per CONNECTION, because the host socket and a redirected headless socket are different games with
// different answers — see seedServerSettingsFromSession.
const hostPerfSeeded = new WeakSet<MirrorClient>();

// ORDER CONTRACT for the server-side settings, in one place because getting it wrong is invisible until a host
// silently un-freezes:
//   1. SEED — the first `session` a connection delivers reports what THAT instance actually has frozen; adopt it
//      into the store (once per connection). This is what makes the checkboxes truthful the moment a viewer joins,
//      including a direct-view/host-watch viewer, whose game has nothing frozen at all.
//   2. PUSH — the one-shot push, when the connection becomes this viewer's settings channel (joined, or direct
//      view), then echoes the SEEDED values back. Same values in, same values out: a no-op on the instance instead
//      of the stale client defaults it used to stomp them with.
//   3. CHANGE — from there the store is the authority: the SERVER_SETTING_KEYS watch forwards viewer edits.
// Step 1 must precede step 2 on every path, which it does structurally: both call sites below seed first, and the
// session parse in mirrorClient sets `client.session` before it notifies (so `c.session` is the envelope that
// triggered this callback, never the previous one).
function seedHostPerf(c: MirrorClient): void {
  if (hostPerfSeeded.has(c)) return;
  // Only a reported state counts as seeded; an unavailable measurement leaves the local defaults in place and stays
  // eligible, so a later reported state still wins.
  if (seedServerSettingsFromSession(mirrorSettings, c.session)) {
    hostPerfSeeded.add(c);
  }
}

// The last server-settings payload each connection was actually sent, so an unchanged one is never re-sent. This is
// what keeps the seed from producing a second message: seeding mutates the store, which wakes the change watch
// below, whose payload is by construction identical to the one-shot push that just went out. (Also idempotent for
// any other repeat — the host applies each field verbatim, so a duplicate is only wire noise, but a duplicate
// arriving while the game is mid-freeze-walk is noise worth not making.)
const lastSettingsSent = new WeakMap<MirrorClient, string>();
function pushServerSettings(c: MirrorClient): void {
  const payload = serverSettingsPayload(mirrorSettings);
  const encoded = JSON.stringify(payload);
  if (lastSettingsSent.get(c) === encoded) return;
  lastSettingsSent.set(c, encoded);
  c.sendSettings(payload);
}

function makeClient(url?: string, watchStream = false): MirrorClient {
  const c = connectMirrorClient({
    url,
    // WS-B stream gate. The HOST connection opens GATED: we do not yet know which screen the host is on, and the
    // host ships a full keyframe on connect — so the only way to avoid pulling (and rendering) a multiplayer
    // host's game behind the picker is to start with the stream off. The first `session` arrives immediately and
    // `applyWatchGate` turns it on within one round trip when the host isn't on a multiplayer screen. The
    // redirected (own headless) connection opens UNGATED — it is ours to watch by definition.
    watch: watchStream,
    // Stage-B walk skip: declare the static-background state on the connect URL (`staticBg=1` only when the
    // setting is ON and the image is not in its fail-open state), so the host counts this connection correctly
    // from the first byte. Later flips (panel toggle, fetch fail-open) ride the `settings` push below. Ignored
    // when an explicit `url` was passed — the headless redirect builds its own query with the same value.
    staticBg: staticBgWireValue(mirrorSettings),
    // R14 trail drive: declare this build's trail-root capability on the connect URL from the first byte.
    // Same "ignored when an explicit `url` was passed" caveat as staticBg — the redirect builds its own query.
    trailDrive: mirrorSettings.trailDriveCapable,
    pingIntervalMs: desiredPingIntervalMs(),
    onChange() {
      if (activeClient !== c) return; // stale callback from a superseded client
      status.value = c.status;
      revision.value = c.state.revision;
      joinSession.value = c.session;
      // A healthy connection resets the backoff ladder; a dead one starts the fallback (which replaces
      // `activeClient`, so nothing below this line applies to a connection that just went away).
      if (c.status === "connected") {
        reconnectDelayMs = RECONNECT_BASE_DELAY_MS;
      } else if (c.status === "disconnected") {
        handleActiveClientDrop();
        return;
      }
      // Seed the panel's Refresh-rate from the host's REAL baseline (once) BEFORE the settings push below, so the
      // label is truthful and the push echoes the host's own value (idempotent — a fresh watch never throttles the
      // host to the old hardcoded 24). Clamp to the slider's 4..60; a 0/unlimited or out-of-range host maps to 60.
      if (!refreshRateSeeded && typeof c.session?.refreshRate === "number") {
        refreshRateSeeded = true;
        // A saved preference outranks the host's baseline (see the note on `refreshRateSeeded`); the question is
        // marked answered either way so a later envelope can't re-open it mid-session.
        if (!hasStoredMirrorSetting("refreshRate")) {
          const r = c.session.refreshRate;
          mirrorSettings.refreshRate = r >= 4 && r <= 60 ? r : 60;
        }
      }
      // Step 1 of the order contract above: adopt THIS connection's reported freeze state before anything is
      // pushed back to it. The host connection seeds the host's own game (a windowed host: nothing frozen); after a
      // redirect the headless connection re-seeds from the seat's own instance (its env defaults).
      seedHostPerf(c);
      // Push current SERVER settings to the observed connection ONCE, the first time it's connected AND has told us
      // what it is running. This is the joined (headless) socket, OR — for a direct-view / host-watch viewer — the
      // shared HOST socket (they have no own headless instance, so the only observable settings channel IS the
      // host). Subsequent changes go through the store watch. See the shared-host caveat below.
      // WAITING FOR `c.session` is load-bearing, not defensive: a redirected connection is already `joined`, so
      // without it the push fired on OPEN — before the instance's own state had arrived — and shipped the previous
      // connection's values. That briefly un-froze every freshly spawned headless seat (the host socket's
      // "nothing frozen" landing on an instance that freezes by default) until the seeded re-push corrected it.
      if ((joined.value || directView.value) && c.status === "connected" && c.session && !settingsPushed.has(c)) {
        settingsPushed.add(c);
        pushServerSettings(c);
      }
      // ESCALATION RULE (b): the reconnect SUCCEEDED (live socket + a fresh roster) but the host still refuses the
      // seat we're reclaiming (`offline` mid-run / `stuck`). No number of further attempts can fix that — the host
      // has to reload the saved run — so say so now instead of retrying silently.
      if (c.status === "connected" && reconnectState.value.phase !== "steady") {
        reconnectState.value = reconnectStateAfterReconnect(
          reconnectState.value,
          rejoinSeatIsBlocked(c.session?.players ?? [], rejoinTarget)
        );
      }
      // Seat-targeted rejoin FIRST: it carries the exact playerId, so it must win over a `?name=` auto-join
      // (which only knows a label) when both are armed after a reconnect.
      maybeAutoRejoin();
      maybeAutoJoin();
      maybeAutoHostView();
      maybeRequestDirectView();
    },
    onLatency() {
      if (activeClient !== c) return;
      latency.value = { ...c.latency };
    },
    onHeadlessRedirect(port) {
      if (activeClient !== c) return; // prevent double-redirect
      // The host accepted the join: persist the name (storage + a PUSHED `?name=`) so a reload auto-joins
      // straight in and Back leaves the seat. `rememberJoinedName`'s equality guard means the auto-join case
      // (which read that very name out of the URL) adds no second entry.
      if (pendingName.value) {
        rememberJoinedName(pendingName.value);
        // Through the SAME helper `setUrlNameParam` uses (`rememberJoinedName` did the writing, so only the
        // bookkeeping is left): this is the stamp that makes a seat viewer's `urlSeatIntent` true for the rest of
        // the session, which is what puts them on the waiting screen — not back on the host's stream — if the run
        // later ends under them.
        rememberUrlName(pendingName.value);
      }
      // The host CONFIRMED this seat, so it is the one to reclaim if the view later drops. Recorded here (not at
      // submit time) so a refused join never arms an auto-rejoin loop.
      rejoinTarget = lastJoinAttempt ?? (pendingName.value ? { name: pendingName.value } : rejoinTarget);
      joined.value = true;
      // The join is DONE — the wait from here is the headless streaming its first frame ("Loading…"), not the
      // host resolving a request ("Joining…"). Leaving `pendingName` set (which it used to be, forever) meant the
      // in-flight state never ended, and — because it also feeds the stream gate and the join-mode computation —
      // that a redirected viewer stayed "mid-join" for the rest of the session.
      pendingName.value = null;
      // A view was restored: clear the drop phase (and with it any escalated notice) + a stale rejection. This is
      // the leak the old code had — nothing but a fresh submit ever cleared the message, so a reconnect that
      // worked perfectly left "the host must reload the saved run" on screen behind the live game.
      reconnectState.value = reconnectStateAfterViewRestored();
      joinMessage.value = null;
      joinDetail.value = null;
      // Gate the source-host socket off. It must stay OPEN (closing it triggers the server's Release(), killing the
      // headless before the redirect lands) but it has no reason to keep receiving bytes — and dropping its
      // streaming registration is what lets a host whose viewers have all redirected away stop its producer.
      c.sendWatch(false);
      activeClient = makeClient(
        buildHeadlessMirrorWebSocketUrl(
          port,
          undefined,
          staticBgWireValue(mirrorSettings),
          mirrorSettings.trailDriveCapable
        ),
        true
      );
      mirrorState.value = activeClient.state;
      status.value = activeClient.status;
      revision.value = activeClient.state.revision;
      if (latencyEnabled && typeof window !== "undefined") {
        (window as unknown as { __mirrorLatency?: () => MirrorLatency }).__mirrorLatency =
          () => ({ ...activeClient.latency });
      }
      // Do NOT call c.close() here. Closing the host WS triggers Release() on the server,
      // which kills the headless process — before the browser has established the new WS.
      // The host connection is closed on unmount (via allClients) instead.
    },
    onDirectView() {
      if (activeClient !== c) return;
      // Watch the host's own stream in place: no redirect, stay on THIS (host) socket. `directView` unlocks
      // showScene. Never `rememberJoinedName` here — this viewer holds no seat and no name, so the seat form of
      // `?name=` would be a lie (and would auto-join a seat on the next reload).
      pendingName.value = null;
      joinMessage.value = null;
      joinDetail.value = null;
      // …but a direct view granted on a MULTIPLAYER screen (lobby / saved-game lobby / mp run) IS a state worth
      // returning to: it is the host player's own browser, or a viewer that picked the [Host] row. Stamp the
      // marker form — `?name=` with NO value — so a reload re-picks the host row instead of dumping the player
      // back on the picker, and Back still leaves. Empty is deliberate: the server never reads the param, so an
      // empty one is invisible to it and inert for every existing reader, while still being a state the next
      // load can see. A singleplayer run / main-menu direct view stamps nothing (unchanged behavior) — there is
      // no seat there to return to, and no picker the viewer chose it from.
      //
      // A param that is ALREADY there is left exactly as it is, value and all. It reloads to this same view (a
      // `?name=<host player>` auto-join is answered with this very directive) and it may be a link somebody
      // typed or shared — rewriting it to the canonical marker would destroy that for no behavioral gain. The
      // marker's job is only to give a view that was chosen by TAPPING a URL of its own.
      const mode = c.session?.screen?.mirrorMode ?? joinSession.value?.screen?.mirrorMode ?? null;
      if (isMultiplayerMirrorMode(mode) && !hasNameParam()) {
        setUrlNameParam("", "push");
      }
      // Same restoration as the redirect path: a granted direct-view IS the view coming back, so the drop phase
      // (and any escalated notice) ends here too.
      reconnectState.value = reconnectStateAfterViewRestored();
      directView.value = true;
      // Apply current settings to the observed (host) socket now, so a direct-view viewer's toggles take effect
      // immediately — mirroring the joined push. Caveats, both documented in the panel copy: (a) the levers act on
      // the HOST's OWN game here, so a freeze is VISIBLE on the host's screen (the panel drops its "doesn't change
      // what you see" note for a direct-view viewer); (b) for multi-viewer host-watch the host socket is SHARED, so
      // server settings apply to the one watched game for everyone. Both are fully reversible.
      // Seed first (step 1 of the order contract) so this push echoes the host's own state instead of stomping it —
      // this is the path where the stale hardcoded defaults used to claim three freezes the host does not have.
      seedHostPerf(c);
      if (c.status === "connected" && !settingsPushed.has(c)) {
        settingsPushed.add(c);
        pushServerSettings(c);
      }
    },
    onJoinRejected(reason, detail) {
      if (activeClient !== c) return;
      // Name isn't servable → drop the pending join (recomputes back to the picker) and surface the message.
      pendingName.value = null;
      joinMessage.value = rejectionMessage(reason);
      // Only a server FAULT carries detail; every other code is self-describing, and a stale detail under a
      // fresh unrelated rejection would misattribute the cause.
      joinDetail.value = detail ?? null;
      // DISARM the auto-rejoin. A refused seat that still reads "ready" on the next session would otherwise be
      // retried on every envelope — a silent request storm. From here the viewer taps the row themselves.
      rejoinTarget = null;
      lastJoinAttempt = null;
    },
    onActionError(message) {
      if (activeClient !== c) return;
      // The backstop (see mirrorClient.onActionError): the host faulted on our join and answered on the channel
      // this client otherwise ignores. Treated exactly like a "join-failed" rejection — the difference is only
      // which envelope carried it, and the viewer should not have to care.
      pendingName.value = null;
      joinMessage.value = rejectionMessage("join-failed");
      joinDetail.value = message || null;
      rejoinTarget = null;
      lastJoinAttempt = null;
    },
    onScrollAck(ack) {
      if (activeClient !== c) return; // a superseded connection's answer is about a game we are no longer watching
      scrollAck.value = ack;
    },
    onHostGone() {
      if (activeClient !== c) return;
      // The headless serving our view is EXITING (its host game connection is gone for good). Same fallback as a
      // bare socket drop — the `handleActiveClientDrop` guard makes the two arriving together harmless.
      handleActiveClientDrop();
    }
  });
  allClients.push(c);
  return c;
}

activeClient = makeClient();
mirrorState.value = activeClient.state;
status.value = activeClient.status;
revision.value = activeClient.state.revision;

// The recorder's keyframe request (reproRecorder.ReproResyncRequester). Installed here rather than beside the
// meta supplier because it is the one recorder wiring that needs a CLIENT; the recorder holds the want until
// this lands, so arming above still gets served. The closure reads `activeClient` at call time, so a reconnect
// or a headless redirect re-points it with no re-install.
reproRecorder.setResyncRequester(() => {
  // Only a connection that is ALREADY streaming may be re-seeded. Toggling the gate on a viewer who is
  // deliberately not watching (sitting on the join picker, where `wantsHostStream` is false) would start pulling
  // a multiplayer host's game in the background — the exact thing the gate exists to prevent — and there are no
  // deltas in the file for a keyframe to make replayable anyway.
  if (status.value !== "connected" || !activeClient.watching) {
    return false;
  }
  activeClient.sendWatch(false);
  activeClient.sendWatch(true);
  return true;
});

const hasScene = () => mirrorState.value.orderedIds.length > 0;

// Shared join-screen inputs derived from the host session (+ connection status).
const joinInfo = computed(() => joinInfoFromSession(joinSession.value, status.value));
// The server's mirror screen discriminator drives the picker mode (name field only in MP character-select).
const mirrorScreen = computed(() => joinSession.value?.screen?.mirrorMode ?? null);
// A device that already HAS a view never shows a roster: in the first-frame gap ("Loading…") the picker would
// offer a second join of the seat we are already holding. That used to be true only by accident — `pendingName`
// was never cleared after a redirect, so the mode stayed title-only — so now that the join state ends properly,
// the real reason is stated here.
const joinMode = computed(() =>
  joined.value || directView.value
    ? "title-only"
    : computeMirrorJoinMode(joinInfo.value, pendingName.value, mirrorScreen.value)
);

// Render the live scene whenever one is available AND we're either joined (our own headless stream) OR the
// screen isn't actionable to join ("title-only": main menu / loading / waiting). In the title-only case we
// fall through to the HOST connection's scene stream so the mirror shows the REAL current screen (e.g. the
// main menu) instead of the raw `screens/<x>` placeholder title. The actionable join modes (lobby-join /
// run-picker) still show the picker so the viewer can join — and we deliberately DON'T show the host's stream
// there, since a run/lobby view is per-player-divergent before the viewer gets their own headless instance.
// `revision` in the expression makes this recompute as the retained scene map fills in. Pre-join we only fall
// through when actually connected and idle (no pending join) so the transient "Joining…"/"Disconnected"
// placeholders still show their feedback instead of a stale host frame.
// WS-B: the render rule above, factored out — because it is ALSO the wire rule. The stream gate sends this exact
// answer to the host (`watch`), so the bytes we receive and the frames we show can never disagree: a viewer the
// picker is up for pulls nothing, and a viewer that would render the host stream asks for it.
const wantsHostStream = computed(() =>
  shouldWatchHostStream(
    joinInfo.value,
    pendingName.value,
    mirrorScreen.value,
    joined.value,
    directView.value,
    // F3: a URL that names a seat is an intent to PLAY. Until that seat is actually granted this viewer pulls
    // nothing at all — not even the host's main menu, which the gate would otherwise hand it as "title-only".
    urlSeatIntent.value
  )
);
const showScene = computed(() => revision.value >= 0 && hasScene() && wantsHostStream.value);

// DROP THE SURFACE GRADIENT WHILE IT IS COVERED (see `.game-surface.surface-covered` in @/styles.css for the
// mechanism and the measurement). `showScene` is the whole condition on purpose: it is the SAME expression that
// mounts MirrorView, whose root `.mirror-frame` is the opaque `#000` full-bleed fill doing the covering, so the
// class and the cover it depends on can never be one render apart. Nothing here is backend-specific — the DOM arm
// is covered by that same frame.
//
const surfaceCovered = computed(() => showScene.value);

// ---- WHERE THE BROWSER CHROME LIVES (R19 WP-2) ----------------------------------------------------------------
//
// Two placements for the SAME pair of controls (settings gear + fullscreen):
//   * FIXED browser-space chrome — 44px, `position: fixed`, top centre. Never moves, never scales.
//   * IN-STAGE — 80x80 DESIGN px inside the letterboxed, scaled `.mirror-stage`, so it sits in the game's own
//     TopBar and scales with it.
//
// In LANDSCAPE the in-stage placement is right: the stage fills the screen, the buttons land beside the game's
// own top-bar icons and read as part of the UI. In PORTRAIT it is wrong twice over — the stage is letterboxed to
// a strip, so an 80px design button shrinks to a fraction of a finger and MOVES with the letterbox every time the
// viewport changes. The fullscreen button is the worst case, because pressing it is also what rotates the phone:
// the control that gets you out of portrait must not itself be hard to hit in portrait.
//
// So in portrait the pair keeps EXACTLY the pre-game screen's placement — same fixed 44px chrome, same spot —
// and a player who joins from the picker watches nothing move.
const { isPortrait: isPortraitViewport } = usePortraitViewport();
// The fixed pair renders pre-join (as it always has) and, with the game up, whenever the viewport is portrait.
// The truth table itself is `shouldUseFixedChrome`, so it can be tested without mounting a whole scene.
const showFixedChrome = computed(() =>
  shouldUseFixedChrome(showScene.value, isPortraitViewport.value)
);
// …and the in-stage pair is exactly the complement, so the two can never both render (two gears, two panels
// fighting over one `panelAnchorTop`) nor both vanish.
const showStageChrome = computed(() => showScene.value && !showFixedChrome.value);

// Push the gate to the ACTIVE connection whenever the answer moves. `immediate` so the very first evaluation
// (right after the first session lands) opens the stream on a non-multiplayer host without waiting for a second
// change. The client no-ops when the socket isn't open yet and flushes on open.
watch(wantsHostStream, (on) => activeClient.sendWatch(on), { immediate: true });
// The pre-game LIFECYCLE state (rules + copy in @/mirror/loadingState): "Connecting…" / "Reconnecting…" /
// "Joining…" / "Loading…", or null when the screen is steady. Non-null also means the picker shows a spinner,
// lets the placeholder outrank a (by then stale) screen title, and hides the steady-state APK hint.
const loadingState = computed(() =>
  computeMirrorLoadingState({
    status: status.value,
    reconnectPhase: reconnectState.value.phase,
    pendingName: pendingName.value,
    hasView: joined.value || directView.value,
    sceneShowing: showScene.value
  })
);

// The heading text: a transient word when something is in flight, otherwise the idle fallback (the picker prefers
// the game's own screen title over this one — see MirrorJoinPicker.titleText).
const joinPlaceholder = computed(
  () =>
    mirrorLoadingLabel(loadingState.value, t) ??
    // Unreachable in practice (every drop schedules a reconnect, which makes the phase non-steady) — kept as an
    // honest fallback for a socket that is down with no recovery armed.
    (status.value === "disconnected" ? t("picker.disconnected") : t("picker.waiting"))
);

// The notice under the heading: a join REJECTION only. A drop contributes nothing at any phase — the escalated
// "the host must reload the saved run" guidance used to live here and was removed, because it was usually a lie:
// the great majority of escalations healed on their own (a slow headless respawn, a wifi roam, a host frame
// hitch) with no host action at all, so the copy told the viewer to go interrupt a game that was fine. A `lost`
// phase now reads exactly like a `reconnecting` one — the spinner and "Reconnecting…" (see loadingState) — which
// is the honest report: we are still trying. The server-authored per-seat reasons in the picker's roster rows
// (seatStatusReason) are untouched; those ARE authoritative about a specific seat.
const joinNotice = computed(() => joinMessage.value);
// The second line under it, for a server fault only. Gated on `joinNotice` so a detail can never outlive the
// message it explains (the two are cleared together everywhere, but this makes the ordering unconditional).
const joinNoticeDetail = computed(() => (joinMessage.value ? joinDetail.value : null));

// F3 — THE WAITING SCREEN. A viewer whose URL names a seat (`?name=Ann`), sitting on a host screen that has no
// seat to give: the main menu, a singleplayer character select, a singleplayer run. It replaces the picker, which
// would be a lie there (there is nothing on it to pick), and pairs with the closed stream gate above — no scene
// bytes, no join attempt, just "waiting for the host to start a game" and a way out.
//
// Every clause earns its place:
//   * `urlSeatIntent` — this is the seat-viewer's screen only. A viewer with no `?name=` (the picker) or the empty
//     host marker (which streams the host's screen) is never here.
//   * `!joined && !directView` — a granted view outranks everything, exactly as it does in the gate.
//   * `!pendingName` and `status === "connected"` — the transient lifecycle words ("Connecting…", "Joining…") own
//     the screen while they last; replacing them with a steady "waiting for the host" would hide the fact that
//     something IS happening. Note this also keeps a DISCONNECTED viewer on the picker's "Reconnecting…", which
//     is the truthful report: we do not know what screen the host is on any more.
//   * `isNonJoinableMirrorMode` — the host has SAID there is no seat here. A null mode is only the pre-session
//     state, not that statement.
const showHostWaiting = computed(
  () =>
    urlSeatIntent.value &&
    !joined.value &&
    !directView.value &&
    !pendingName.value &&
    status.value === "connected" &&
    isNonJoinableMirrorMode(mirrorScreen.value)
);

// "Control host" — the waiting screen's one control, and the ONLY writer of the empty host marker on a
// non-multiplayer screen (`onDirectView` still stamps it MP-only). It converts `?name=Ann` into `?name=`: from
// "I am a player waiting for a seat" to "I am the browser controlling the host", which is precisely the state
// whose stream gate is open on these screens.
//
// A RELOAD, not an in-place unwind. Half this app's setup is URL-keyed and read exactly once (the load-time
// `urlName`, `urlWantsHostView`, the one-shot latches, every module that parses `location.search` on first
// access), so re-deriving that state by hand here would be the same partial reset the popstate rule already
// refuses to do. The reload lands on the new URL and re-runs the whole join dance from it; Back then restores
// `?name=Ann`, popstate reloads again, and the viewer is on the waiting screen once more — self-consistent in
// both directions. `forceReload` is the injectable seam (jsdom cannot stub `location.reload`).
function onControlHost(): void {
  setUrlNameParam("", "push");
  forceReload();
}

// Stable proxies so MirrorView's props don't change reference on client redirect.
const sendInput = (msg: MirrorInputMessage) => activeClient.sendInput(msg);
// R11 WS-M: the semantic-action channel, same stable-proxy treatment — it must follow the redirect to the seat's own
// headless connection, since that is the game process whose map the viewer is tapping.
const sendAction = (msg: MirrorActionMessage) => {
  activeClient.sendAction(msg);
};
const sendSceneAck = () => activeClient.sendSceneAck();

// R19 WP5 — SCROLL AUTHORITY. Same stable-proxy rule, and for the same reason as the action channel: the surface
// being scrolled belongs to whichever game process this viewer is currently watching. Returns the requestId so the
// eager engine can tell its own latest send's answer from a stale one.
const sendScroll = (elementId: string, offsetY: number): string | null =>
  activeClient.sendAction({
    semanticActionId: SET_SCROLL_OFFSET_ACTION_ID,
    args: { [SCROLL_ELEMENT_ID_ARG]: elementId, [SCROLL_OFFSET_ARG]: offsetY }
  });
// The latest ack, republished as a fresh object so MirrorView's identity watch sees every one (two acks carrying
// the same clamped offset are two different facts — the second says the game re-confirmed a later send).
const scrollAck = shallowRef<MirrorScrollAck | null>(null);
// Drive the latency probe on the CURRENT connection to match the panel state (open → probe on, closed → off).
function applyPingInterval(): void {
  activeClient.setPingInterval(desiredPingIntervalMs());
}

// Panel open/close — and the overlay toggle, which outlives the panel — drive the probe (network + game RTT)
// without reconnecting.
watch(
  () => mirrorSettings.panelOpen || mirrorSettings.latencyOverlay,
  () => applyPingInterval()
);

// Forward SERVER-side settings changes to the observed connection: the JOINED (headless) socket, or the shared
// HOST socket for a direct-view / host-watch viewer (their only settings channel — see the onDirectView caveat).
// Watching the value list fires exactly when one of the fields changes; the client no-ops if the socket isn't
// open yet (values are held; the on-connect push in makeClient carries them once connected).
watch(
  () => SERVER_SETTING_KEYS.map((key) => mirrorSettings[key]),
  () => {
    if (joined.value || directView.value) {
      pushServerSettings(activeClient);
    }
  }
);

// ---- the chromeless path (WS1/WS2/WS5) ----------------------------------------------------------------------
//
// Everything below hangs off ONE event: the player tapping their seat. That tap is the only user activation this
// app is guaranteed to get, and `requestFullscreen()` will not run without one — so it is where Android goes
// full-bleed (and, via useFullscreen, gets its landscape lock), and where the iPhone install overlay is armed,
// its payoff finally being concrete. The auto-join paths below (`?name=`, auto-rejoin, direct view) deliberately
// do NOT go through here: no gesture, so fullscreen would just be refused, and an overlay would appear over a
// screen the player never asked for.
const { autoEnter: enterFullscreen, isOrientationLocked } = useFullscreen();
// `?iosInstall=force` arms the overlay on load (there is no seat tap to wait for on a desktop repro) — see
// @/join/joinModel's `isIosInstallForced`. The `?name=` auto-join path below is untouched by this.
const iosInstallArmed = ref(isIosInstallForced());
// Bumped by the re-open pill (@/components/IosInstallButton.vue); the overlay treats any CHANGE as "open now",
// bypassing both the session-only and the persisted dismissal.
const iosInstallOpenTick = ref(0);

function onSeatChosen(name: string, playerId?: string): void {
  void enterFullscreen();
  iosInstallArmed.value = true;
  submitJoin(name, playerId);
}

// `playerId` is the picked SEAT's state player id ("p:1003"), present only for a roster BUTTON tap. It is passed
// straight through so the host resolves the seat's netId exactly rather than matching the display label — which
// matters because a saved seat the host has no remembered name for is labelled with a synthesized "Player 1003".
function submitJoin(name: string, playerId?: string): void {
  const trimmed = trimName(name);
  if (!trimmed || pendingName.value) return;
  joinMessage.value = null; // clear a prior rejection on a fresh attempt
  joinDetail.value = null;
  pendingName.value = trimmed;
  prefillName.value = trimmed;
  // Held until the host confirms with a redirect, which promotes it to the auto-rejoin target.
  lastJoinAttempt = playerId ? { name: trimmed, playerId } : { name: trimmed };
  activeClient.sendJoin(trimmed, playerId);
}

// ONE place that owns the join timeout, keyed off the in-flight marker itself rather than off each of the six
// call sites that set or clear it (submit, redirect, direct view, rejection, backstop, socket drop). Every
// resolution path already writes `pendingName`, so arming here is automatically disarmed by all of them — which
// is the property that stops this from becoming its own stale-timer bug.
watch(pendingName, (name) => {
  if (joinTimeoutTimer !== null) {
    clearTimeout(joinTimeoutTimer);
    joinTimeoutTimer = null;
  }
  if (!name) return;
  joinTimeoutTimer = setTimeout(() => {
    joinTimeoutTimer = null;
    // Re-check: a resolution racing the timer would already have cleared `pendingName`, and failing a join the
    // host actually granted would drop a viewer out of a seat they hold.
    if (!pendingName.value) return;
    pendingName.value = null;
    joinMessage.value = t("join.hostNoAnswer");
    joinDetail.value = null;
    // Same disarm as a rejection: whatever we were reaching for is not answering, so stop reaching for it
    // automatically. The viewer taps the row again themselves.
    rejoinTarget = null;
    lastJoinAttempt = null;
  }, JOIN_TIMEOUT_MS);
});

// The ACTIVE connection went away (socket closed/errored, or a headless told us it is exiting). Fall back to the
// picker on the original host and start reconnecting. Guarded by `reconnectTimer` so the several signals a single
// drop produces (last-gasp envelope, then `close`, then `error`) schedule exactly one attempt.
function handleActiveClientDrop(): void {
  if (reconnectTimer !== null) return;
  // TRANSIENT BY DEFAULT. A drop only advances the phase (reconnectPolicy decides when enough attempts have failed
  // to escalate); the screen shows a brief "Reconnecting…" + spinner meanwhile. The old behavior — the full "the
  // host must reload the saved run" guidance on EVERY drop, including a 1s singleplayer blip that healed itself —
  // told the viewer to go fix something that wasn't broken, and then never took it back.
  reconnectState.value = reconnectStateAfterDrop(reconnectState.value, joined.value || directView.value);
  // A rejection message is about a join dance we are restarting from scratch below; keep the surface for the
  // escalated notice only (which is derived from the phase, never written here).
  joinMessage.value = null;
  joinDetail.value = null;
  // Reset the whole join dance, exactly like the native TeardownAndReconnect: the roster/screen we remember is
  // from a game that is gone, and re-running the dance from scratch is what makes the fallback self-healing.
  joined.value = false;
  directView.value = false;
  directViewRequested = false;
  pendingName.value = null;
  joinSession.value = null;
  reconnectTimer = setTimeout(reconnectToHost, reconnectDelayMs);
  // Grow the ladder for the NEXT attempt; a successful open resets it (see onChange).
  reconnectDelayMs = nextReconnectDelayMs(reconnectDelayMs);
}

// Re-open a fresh HOST connection (no `url` → the page's own origin, i.e. the address the viewer loaded from) and
// hand the app over to it. Every previous client is closed first: keeping the source-host socket open exists
// only to protect the redirect handoff, and by now there is no headless left to protect.
function reconnectToHost(): void {
  reconnectTimer = null;
  allClients.forEach((c) => c.close());
  allClients.length = 0;
  // A remembered seat supersedes the `?name=` auto-join (it carries the exact playerId); with no seat to reclaim
  // the `?name=` path re-arms so a URL-driven viewer still lands straight back in. The empty-`?name=` host view
  // re-arms on the same rule: a direct view never records a `rejoinTarget` (there is no seat), so a host viewer
  // whose socket dropped re-takes the host row by itself once the new connection has a roster.
  autoJoinSent = rejoinTarget !== null;
  hostViewRequested = rejoinTarget !== null;
  activeClient = makeClient();
  mirrorState.value = activeClient.state;
  status.value = activeClient.status;
  revision.value = activeClient.state.revision;
  if (latencyEnabled && typeof window !== "undefined") {
    (window as unknown as { __mirrorLatency?: () => MirrorLatency }).__mirrorLatency =
      () => ({ ...activeClient.latency });
  }
}

// Reclaim the seat this device was granted before the drop, the moment the host offers it again (i.e. once the
// host has reloaded the saved run — mid-run the row reads `offline` and this stays null). No tap required, which
// is the whole point: the viewer's instruction was "wait for the host to reload the run".
function maybeAutoRejoin(): void {
  if (!rejoinTarget || joined.value || directView.value || pendingName.value) return;
  if (status.value !== "connected") return;
  const seat = findAutoRejoinSeat(joinSession.value?.players ?? [], rejoinTarget);
  if (!seat) return;
  submitJoin(seat.name, seat.playerId);
}

// `?name=` in the page URL is an auto-join: once connected (and not already joined/pending), join straight in.
function maybeAutoJoin(): void {
  if (joined.value || pendingName.value || !urlName) return;
  if (status.value !== "connected") return;
  // F3 — NOT on a screen the host says nobody can join (main menu, singleplayer character select, singleplayer
  // run, unclassifiable). Sending the join anyway is not merely useless: the host answers `not-a-session-player`,
  // which paints a red "that name is not from a session player" banner over a viewer who did nothing wrong and
  // whose seat may exist five seconds later.
  //
  // WAITING FOR A SESSION AT ALL is half of that guard, and it is a real change: this used to fire the moment the
  // SOCKET opened, i.e. before anything was known about the host's screen, so the screen test alone would never
  // have run. The first `session` arrives immediately on connect (the whole join screen is built from it, and the
  // stream gate refuses to open without one for exactly the same reason), so this costs one envelope, not a
  // round of user-visible waiting.
  //
  // Read from the RAW session, never the `mirrorScreen` computed — an early synchronous `onChange` runs before
  // that computed exists (the same TDZ hazard maybeRequestDirectView documents).
  //
  // Deliberately ABOVE the one-shot latch: the guard is a "not yet", not a "never", so the auto-join must still
  // be armed to fire the moment the host reaches a multiplayer screen. Latching here instead would spend the
  // single attempt on the main menu and strand the viewer on the waiting screen for the rest of the session.
  const session = joinSession.value;
  if (!session) return;
  if (isNonJoinableMirrorMode(session.screen?.mirrorMode ?? null)) return;
  if (autoJoinSent) return;
  autoJoinSent = true;
  submitJoin(urlName);
}

// The auto-join's twin for the EMPTY `?name=` marker: this browser was on the host's own view when it was last
// stamped (or reloaded/reconnected out of it), so re-take it the moment a multiplayer roster arrives — same path
// as tapping the [Host] row, so the server answers with the same `directView` directive.
//
// Waits for a MULTIPLAYER screen on purpose: the marker only means anything against an mp roster, and a host that
// is still on the main menu (or mid-load) will produce one shortly.
//
// F3 — A MULTIPLAYER ROSTER WITH NO HOST ROW LEAVES THE MARKER ALONE, and leaves this unlatched so the next
// session tries again. It used to drop the marker and fall back to the picker, on the theory that the session had
// changed under a stale URL. That reads one roster as final, and the empty marker is not that kind of state: it is
// the durable "I am the machine controlling the host" — the answer to "which browser is the TV's own?" — and the
// host-row gap it was deleting itself on is usually a transient one (a session mid-rebuild, a roster that has not
// caught up with a lobby the host just entered). Deleting it there cost the host player their own view for the
// rest of the session, recoverable only by knowing to press "Control host". Nothing is lost by waiting: on a
// non-multiplayer screen the empty marker already streams the host's screen (it is no seat intent, so the gate
// falls through to title-only), which is exactly what the marker is for.
function maybeAutoHostView(): void {
  if (!urlWantsHostView || hostViewRequested) return;
  if (joined.value || directView.value || pendingName.value) return;
  if (status.value !== "connected") return;
  const session = joinSession.value;
  if (!session || !isMultiplayerMirrorMode(session.screen?.mirrorMode ?? null)) return;
  const host = mirrorRosterFor(session.players ?? []).find((player) => player.isHost);
  if (!host) return; // keep the marker, stay unlatched — a later session may well carry the host row
  hostViewRequested = true;
  submitJoin(host.name, host.playerId);
}

// Activate direct-view for a singleplayer run: send ONE empty-name join so the server (which checks
// `IsSingleplayerRun` before the name) replies `directView` — no spawn, no lobby seat, no `?name=` stamp. This is
// what turns the Settings panel's server controls live for a solo-run watcher; without it they're cosmetic. Not
// used for the actionable picker modes (mp-run / character-select / load-game) — those join through the picker — nor
// for main-menu (nothing per-viewer to configure). Reset off the SP-run screen so a fresh run re-arms.
function maybeRequestDirectView(): void {
  // Read the raw session (not the `mirrorScreen` computed) so an early synchronous onChange can't hit its TDZ.
  if (joinSession.value?.screen?.mirrorMode !== "singleplayer-run") {
    directViewRequested = false;
    return;
  }
  // F3 — NOT for a viewer whose URL names a seat. This request is answered with a `directView` grant, and that
  // grant is the FIRST branch of the stream gate: it would hand a waiting player the host's singleplayer run,
  // which is precisely the screen the `?name=` rules exist to keep them off. A solo-run watcher is a viewer with
  // no seat intent (no param, or the empty host marker), and they still get the settings channel this activates.
  if (urlSeatIntent.value) return;
  if (directViewRequested || joined.value || directView.value || pendingName.value) return;
  if (status.value !== "connected") return;
  directViewRequested = true;
  activeClient.sendJoin(""); // empty name → SP-run direct-view (see the server's join gating)
}

// Expose a latency snapshot for the measurement harness (scripts/measure-latency.mjs) to poll.
if (latencyEnabled && typeof window !== "undefined") {
  (window as unknown as { __mirrorLatency?: () => MirrorLatency }).__mirrorLatency = () => ({
    ...activeClient.latency
  });
}

// Expose a send-input hook for automated tests and browser-console debugging.
// Sends an input message to the currently active mirror client (host until redirect, headless after).
if (typeof window !== "undefined") {
  (window as unknown as { __mirrorSendInput?: (msg: MirrorInputMessage) => void }).__mirrorSendInput =
    (msg: MirrorInputMessage) => activeClient.sendInput(msg);
}

onBeforeUnmount(() => {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (joinTimeoutTimer !== null) {
    clearTimeout(joinTimeoutTimer);
    joinTimeoutTimer = null;
  }
  if (typeof window !== "undefined") {
    window.removeEventListener("popstate", handlePopState);
    // The seam is a closure over THIS app instance; leaving it installed would let a console call reach a
    // recorder configured by a component that no longer exists (same rule as MirrorView's probe seams).
    delete (window as unknown as { __mirrorRepro?: unknown }).__mirrorRepro;
  }
  // Stop the recording with the app: the supplier closes over this instance's DOM, and a torn-down app has no
  // stage to hear anyway. The buffer survives (see reproRecorder.stop) so nothing already captured is lost.
  reproRecorder.setMetaSupplier(null);
  reproRecorder.setResyncRequester(null);
  reproRecorder.stop();
  allClients.forEach((c) => c.close());
});
</script>

<template>
  <main
    class="game-surface mirror-surface"
    :class="{ 'surface-covered': surfaceCovered }"
    data-testid="mirror-surface"
  >
    <MirrorView
      v-if="showScene"
      :state="mirrorState"
      :revision="revision"
      :send-input="sendInput"
      :send-action="sendAction"
      :send-scroll="sendScroll"
      :scroll-ack="scrollAck"
      :on-scene-rendered="sendSceneAck"
    >
      <!-- STAGE-A "Static background": the host-rendered combat bg image. Beneath everything via its own
           most-negative z-index (slot DOM order is NOT stable — the reconciler's full-walk reorder moves the
           mirror roots ahead of all foreign stage children, e.g. on a resize/fullscreen toggle).
           Descriptor = the SERVING connection's latest session envelope (after a redirect that is the seat's own
           headless instance, whose server publishes its own tracker state).
           IN THE `underlay` SLOT, which is the one piece of stage content that has to paint UNDER the game rather
           than over it: on the canvas arm MirrorView renders that slot in its own design-space layer below the
           stage canvas, and on the DOM arm it renders it in the stage exactly where it has always been. -->
      <template #underlay>
        <StaticBackground
          :descriptor="joinSession?.staticBackground ?? null"
          :state="mirrorState"
          :revision="revision"
        />
      </template>
      <!-- Browser-client controls injected into the design-space stage so they scale with the game and sit
           inside the game's own TopBar. The GEAR owns the exact horizontal centre; fullscreen is offset to its
           right (see `.mirror-topbar-gear` / `.mirror-topbar-fullscreen`) — deliberately NOT centred as a pair,
           so the settings button lands on the same spot on every screen.
           LANDSCAPE ONLY: in portrait the same pair renders as fixed browser chrome below (see showFixedChrome),
           because an 80px design button inside a letterboxed portrait stage is both tiny and mobile.
           Stop pointer events here so inputCapture.onPointerDown (which calls preventDefault,
           killing the click event) never sees presses on these buttons. -->
      <div
        v-if="showStageChrome"
        class="mirror-topbar-btn mirror-topbar-gear"
        @pointermove.stop
        @pointerdown.stop
        @pointerup.stop
        @pointercancel.stop
      >
        <SettingsGearButton />
      </div>
      <div
        v-if="showStageChrome"
        class="mirror-topbar-btn mirror-topbar-fullscreen"
        @pointermove.stop
        @pointerdown.stop
        @pointerup.stop
        @pointercancel.stop
      >
        <!-- Mutually exclusive by construction (one needs element fullscreen, the other its absence) — never
             both at once, so sharing this slot never doubles up. -->
        <FullscreenButton />
        <IosInstallButton @open="iosInstallOpenTick++" />
      </div>
      <!-- CONFIRM TAP: the client-side confirm button for choices a tap cannot take back (see confirmTap.ts). In
           the design-space stage like the chrome above, because it has to land on the game's own authored slot and
           scale with it — but unlike the chrome it decides its own stacking, since it must sit UNDER the game's
           modal overlays. Renders nothing at all unless a tap has focused one of those choices. -->
      <MirrorConfirmButton />
      <!-- READABLE-HAND MODE: the client-side toggle that raises the whole hand so every card can be read at a
           glance (see mirrorRenderer's hand-raise pass). In the design-space stage like the chrome above, because
           it sits on the game's own bottom-right HUD grid and has to scale and re-anchor with it. Renders only
           while a combat hand is on screen. -->
      <MirrorHandRaiseButton />
    </MirrorView>
    <!-- Pre-join screen: mirror player picker (host badged [Host]) + a name field only in MP
         character-select. The stack (not the picker itself) is the centered grid item of `.game-surface`, so
         the WS4 browser advisory can sit directly ABOVE the seat list without the two competing for the same
         grid cell — and, being 100% wide, it leaves the panel's own `min(46rem, 76%)` resolving against exactly
         the same containing block as before. -->
    <div v-else class="mirror-join-stack">
      <!-- Sized by the wrapper, not by a class on the component: a child's root carries both scope ids at equal
           specificity, so styling it from here would be a stylesheet-order coin toss. The wrapper contributes
           exactly zero height on every browser we have no report against (no gap on the stack, no margin here —
           the advisory owns its own). -->
      <div class="mirror-join-advisory">
        <BrowserAdvisory />
      </div>
      <!-- F3 — the seat viewer's WAITING screen, in the picker's place. `?name=Ann` on a host screen with no seat
           to give (main menu / singleplayer character select / singleplayer run): there is nothing to pick, no
           scene is being pulled (the stream gate is shut for the same reason), and the only choice left is to stop
           being a player and control the host instead. Carries `mirror-status` exactly as the picker does — the
           diag/e2e scripts wait on that testid to disappear, and a viewer that is still waiting has not joined. -->
      <MirrorHostWaiting
        v-if="showHostWaiting"
        data-testid="mirror-status"
        :seat-name="urlSeatName"
        :message="joinNotice"
        :detail="joinNoticeDetail"
        @control-host="onControlHost"
      />
      <MirrorJoinPicker
        v-else
        data-testid="mirror-status"
        :mode="joinMode"
        :screen-title="joinInfo.screenTitle"
        :players="joinInfo.players"
        :pending-join-name="pendingName"
        :prefill-name="prefillName"
        :kicker="t('app.mirror')"
        :placeholder="joinPlaceholder"
        :transient="loadingState !== null"
        :message="joinNotice"
        :detail="joinNoticeDetail"
        @join="onSeatChosen"
      />
    </div>
    <!-- FIXED browser-space chrome. The picker has no game UI to scale with, so the SAME gear renders here at
         the top centre — one settings control, one place to look for it, joined or not. Fullscreen rides beside
         it exactly as it does in game (gear on the centre line, fullscreen to its right), so a phone can go
         full-bleed BEFORE joining rather than watching the picker under the browser chrome. FullscreenButton
         renders nothing at all where the Fullscreen API is unavailable/forbidden.
         R19 WP-2: in PORTRAIT this placement is kept once the game is up too, so the pair never jumps or shrinks
         at the moment the scene appears (see showFixedChrome). No pointer-event guard is needed here, unlike the
         in-stage wrappers: this chrome is a SIBLING of the letterboxed stage, and inputCapture's listeners are
         attached to the stage element itself, so a tap on these buttons is never seen by the mirror input path. -->
    <div v-if="showFixedChrome" class="mirror-chrome-gear">
      <SettingsGearButton compact />
    </div>
    <div v-if="showFixedChrome" class="mirror-chrome-fullscreen">
      <FullscreenButton compact />
      <IosInstallButton compact @open="iosInstallOpenTick++" />
    </div>
    <!-- Floating latency readout: the `?latency=1` harness path forces it on for the whole session; the settings
         panel's "Show overlay" checkbox is the viewer-facing switch (and keeps working with the panel closed). -->
    <LatencyOverlay v-if="latencyEnabled || mirrorSettings.latencyOverlay" :latency="latency" />
    <!-- REPRO RECORDER's REC pill: fixed browser-space chrome at the top LEFT, a sibling of the letterboxed
         stage so a press on MARKER/SAVE is never seen by inputCapture and never enters the recording. Rendered
         only while the recorder is armed, and only in a build that ships the tool (or a session that asked for
         it by URL — the support escape hatch). -->
    <ReproBadge v-if="showReproBadge" />
    <!-- Browser-only chrome: settings panel + dual (network / game) latency readout. Fixed in browser space
         (a sibling of the letterboxed stage), visible regardless of join state. -->
    <SettingsPanel :latency="latency" :direct-view="directView" />
    <!-- WS1: armed by the seat tap, and self-gating on "iOS Safari, not already a home-screen app, not already
         dismissed" — so it renders nothing at all on Android, on desktop, and in the installed app.
         `openRequest` is the re-open pill's manual channel (@/components/IosInstallButton.vue), which lives in
         the fullscreen slot above. -->
    <IosInstallOverlay
      :armed="iosInstallArmed"
      :open-request="iosInstallOpenTick"
      @close="iosInstallArmed = false"
    />
    <!-- WS3: only over the LIVE GAME (a portrait picker reads fine), and never when WS2's landscape lock was
         granted — the browser is holding the phone for us then. -->
    <PortraitNagOverlay :active="showScene" :suppressed="isOrientationLocked" />
  </main>
</template>

<style scoped>
.mirror-surface {
  position: relative;
}

/* The pre-join column: the WS4 advisory stacked directly above the picker panel, the pair centered as ONE grid
   item of `.game-surface`. 100% wide on purpose — the panel inside sizes itself `min(46rem, 76%)` against its
   containing block, so anything narrower here would silently shrink the picker that shipped before this. */
.mirror-join-stack {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  min-width: 0;
}

/* Match the panel's own width (styles.css `.assignment-panel`, including its 720px breakpoint) so the advisory
   reads as part of the same card stack rather than as a page banner. CouchCoop's OWN join chrome, not
   @spirectl/godot-scene-web presentation DOM. */
.mirror-join-advisory {
  width: min(46rem, 76%);
}

@media (max-width: 720px) {
  .mirror-join-advisory {
    width: 84%;
  }
}

/* Positions the browser-client buttons in the design-space top bar of the mirror stage (1920px wide). The
   stage's scale transform carries them to the correct on-screen size and position. z-index:10 keeps them above
   game nodes. The game's TopBar keeps its natural layout (no shift). */
.mirror-topbar-btn {
  position: absolute;
  top: 0;
  z-index: 10;
}

/* The GEAR is the anchor: its 80px box is centred on the stage's exact horizontal middle. */
.mirror-topbar-gear {
  left: 50%;
  transform: translateX(-50%);
}

/* Fullscreen sits to the gear's RIGHT with a 12px design-px gap — the pair is intentionally NOT centred as a
   group, so widening the row (or dropping a button) never moves the settings gear off the middle.
   50% + half the gear (40px) + the gap (12px). */
.mirror-topbar-fullscreen {
  left: calc(50% + 52px);
}

/* Browser-space (FIXED) placement: same gear, top centre, unscaled. Used pre-join — where there is no game UI to
   scale with — and, once the game is up, in PORTRAIT, where the letterboxed stage would shrink and move it. Above
   the picker panel but below the settings dropdown's own chrome layer. */
.mirror-chrome-gear {
  position: fixed;
  top: 6px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483645;
}

/* Fullscreen to the gear's RIGHT, the same not-centred-as-a-pair idiom as the in-stage row: the gear keeps the
   exact centre line on every screen, joined or not. 50% + half the compact gear (22px) + a 6px gap. NO
   translateX — that is the gear's centring, and applying it here would slide this button back over it. */
.mirror-chrome-fullscreen {
  position: fixed;
  top: 6px;
  left: calc(50% + 28px);
  z-index: 2147483645;
}
</style>
