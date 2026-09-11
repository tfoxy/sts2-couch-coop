// The join/lobby model: the data shape and the decisions behind the join screen — per-seat buttons in a
// picker, a name field where a new player may be added, plus name memory and `?name=` auto-join. It is kept
// out of the components so the rules are written once, unit-testable, and so the C# twins in
// src/CouchCoop.MirrorProtocol/Join/JoinModel.cs (which the native client renders from) have something to be
// in lockstep WITH. Everything here reads off the `session` envelope alone — the join screen never needs the
// scene.

import type {
  BrowserPlayerOption,
  BrowserSessionEnvelope,
  MirrorScreenKind
} from "@/protocol/browserEnvelope";
import { modelAssetRoute } from "@/protocol/browserResources";

// Persisted across reloads so the form prefills the last name (sessionStorage, per-tab).
export const LAST_PLAYER_NAME_STORAGE_KEY = "couchCoop:lastPlayerName";

export type JoinStatus = "connecting" | "connected" | "disconnected" | "unsupported";

// The minimal join-screen inputs, lifted from a `session` envelope. Everything the form needs — roster,
// run-vs-lobby, and whether THIS viewer has joined — without the full game state.
export interface JoinInfo {
  status: JoinStatus;
  players: BrowserPlayerOption[];
  screenKind: string | null;
  screenTitle: string | null;
  joined: boolean;
  /** `session.joined === false` (explicitly unassigned) — the viewer is present but not assigned. */
  unaffiliated: boolean;
  /** Host-served native Android APK URL ("/couchcoop-client.apk"), or null when none is deployed. */
  androidApkUrl: string | null;
}

export function joinInfoFromSession(
  session: BrowserSessionEnvelope | null,
  status: JoinStatus
): JoinInfo {
  const screen = session?.screen ?? null;
  return {
    status,
    players: session?.players ?? [],
    screenKind: screen?.kind ?? null,
    screenTitle: screen?.title ?? null,
    joined: session?.session?.joined === true,
    unaffiliated: session?.session?.joined === false,
    androidApkUrl: session?.androidApkUrl ?? null
  };
}

// Whether the viewer may currently choose an assignment: connected, not already joined, and no join in
// flight. A pending join must collapse the form so the browser never sits in a half-joined loop while the
// host is still resolving the request.
export function canChooseAssignment(info: JoinInfo, pendingJoinName: string | null): boolean {
  return (
    !info.joined &&
    info.status !== "connecting" &&
    info.status !== "disconnected" &&
    !pendingJoinName
  );
}

// The MIRROR view's pre-join sub-modes, driven by the server's `screen.mirrorMode` rather than `screen.kind`.
// "picker-with-name" = MP character-select (a player picker PLUS a name field to add a new remote player);
// "picker" = MP load-saved-game / MP run (picker only, no name field); "title-only" = everything else
// (singleplayer run and host selection are handled by the server's `directView` directive, not a form).
export type MirrorJoinMode = "picker-with-name" | "picker" | "title-only";

// The pre-join sub-mode for a given session. `mirrorMode` is the server's screen discriminator. A kind this
// function does not name is title-only (the mirror then just watches the host stream / shows the waiting heading).
// That default is what makes `sp-character-select` — the host's SINGLEPLAYER lobby, which has
// no seat to claim — correct here WITHOUT a branch of its own: a screen nobody can join must not show a join
// form. Only add a case below for a kind that needs a FORM.
export function computeMirrorJoinMode(
  info: JoinInfo,
  pendingJoinName: string | null,
  mirrorMode: MirrorScreenKind | null
): MirrorJoinMode {
  if (!canChooseAssignment(info, pendingJoinName)) {
    return "title-only";
  }
  if (mirrorMode === "mp-character-select") {
    return "picker-with-name";
  }
  if (mirrorMode === "mp-load-game" || mirrorMode === "mp-run") {
    return "picker";
  }
  return "title-only";
}

/**
 * Whether the host is on a MULTIPLAYER screen — the lobby, the saved-game lobby, or a multiplayer run. Exactly
 * the set of modes `computeMirrorJoinMode` answers "picker-with-name" / "picker" for, minus that function's
 * transient gates (`canChooseAssignment` reports title-only while a join is in flight or after one succeeded,
 * which says nothing about the host's screen). Callers that must know "is this a multiplayer context?" — the
 * empty-`?name=` host marker is only stamped in one, since a singleplayer/watch-only direct view is not a seat
 * anybody can return to — must use THIS, not the join mode.
 *
 * The list is an ALLOWLIST of `mp-*` kinds, so `sp-character-select` (the host's singleplayer lobby) answers
 * false by default and needs no case: it is a character select nobody can join, which is exactly the watch-only
 * shape this predicate excludes. TS-only — there is no C# twin, the native client has no `?name=` marker.
 */
export function isMultiplayerMirrorMode(mirrorMode: MirrorScreenKind | null): boolean {
  return (
    mirrorMode === "mp-character-select" || mirrorMode === "mp-load-game" || mirrorMode === "mp-run"
  );
}

/**
 * Whether the host has told us it is on a screen NOBODY CAN JOIN: the main menu, the SINGLEPLAYER character
 * select, a singleplayer run, or a screen it could not classify (`unsupported`). This is the predicate the
 * `?name=<seat>` rules key off — a viewer whose URL names a seat waits quietly on such a screen rather than
 * mirroring a game it is not part of, and never fires an auto-join the host could only refuse.
 *
 * It is NOT the negation of {@link isMultiplayerMirrorMode}: `null` is only the gap before the first session,
 * not a statement that no seat exists. Read this as "the host has said there is no seat here".
 *
 * TS-only, like `isMultiplayerMirrorMode`: what it feeds — the `?name=` waiting screen and the seat-intent arm of
 * the stream gate — is the browser's `?name=` state machine, which the native client does not have.
 */
export function isNonJoinableMirrorMode(mirrorMode: MirrorScreenKind | null): boolean {
  return (
    mirrorMode === "main-menu" ||
    mirrorMode === "sp-character-select" ||
    mirrorMode === "singleplayer-run" ||
    mirrorMode === "unsupported"
  );
}

// ---- R19 WP-2: what the multiplayer join picker actually SAYS -------------------------------------------------
//
// The picker used to open with a "Mirror" kicker and the game's own screen name as an <h1> ("Run", "Character
// Select"), above an unlabelled name field called "Add a player" and an unlabelled list of rows. Three headings,
// none of which told a player which control does what — and on a landscape phone with the keyboard up, the two
// decorative lines are exactly what pushes the form off screen.
//
// Now: no kicker and no screen title on a STEADY picker, and each control says what it is for. The lifecycle
// words are untouched (see `shouldShowMirrorPickerTitle`) — they are the only feedback a waiting player gets.
//
// These are pure predicates so the copy rules live beside the mode they key off, and the component stays a thin
// renderer (the same split as the install/rotate guidance components).

/** The label over the "type a name" form (MP character select only). */
export const PICKER_NAME_FORM_LABEL = "Join as new player";
/** The heading over the roster rows when they are the ONLY way in (MP load-game / MP run). */
export const PICKER_ROSTER_HEADING = "Join as any of the following players";
/** …and when the name form is shown above them, so the two read as one choice with two branches. */
export const PICKER_ROSTER_HEADING_WITH_NAME = "Or join as any of the following players";

export interface MirrorPickerTitleInput {
  mode: MirrorJoinMode;
  /** The heading is a live lifecycle word ("Joining…"/"Loading…"/…) rather than an idle fallback. */
  transient: boolean;
  /** The game's own screen name, when the host has told us one. */
  screenTitle: string | null;
}

/**
 * Whether the picker renders its kicker + `<h1>`.
 *
 * Suppressed for exactly ONE case: a steady picker whose heading would be the game's own screen name. Everything
 * else keeps it, and deliberately:
 *   * `title-only` IS the heading — there is nothing else on that screen;
 *   * a TRANSIENT state ("Connecting…", "Reconnecting…", "Joining…", "Loading…") is the only sign the app is
 *     doing anything at all, and it carries the spinner;
 *   * a steady picker with NO screen title falls back to a real status line ("Waiting for the game…",
 *     "Disconnected"), which is feedback, not decoration.
 */
export function shouldShowMirrorPickerTitle(input: MirrorPickerTitleInput): boolean {
  if (input.mode !== "picker" && input.mode !== "picker-with-name") return true;
  if (input.transient) return true;
  return !input.screenTitle;
}

/** The name-form label for the current mode (only ever rendered in "picker-with-name"). */
export function mirrorPickerNameLabel(): string { return PICKER_NAME_FORM_LABEL; }

/**
 * The roster heading, or null when the picker should render none. "Or …" whenever the name field is above it
 * (MP character select), the bare form when the rows are the only way in (MP load-game / MP run).
 */
export function mirrorPickerRosterHeading(mode: MirrorJoinMode): string | null {
  if (mode === "picker-with-name") return PICKER_ROSTER_HEADING_WITH_NAME;
  if (mode === "picker") return PICKER_ROSTER_HEADING;
  return null;
}

// ---- R19 WP-2: the character icon beside each seat ------------------------------------------------------------
//
// Names alone do not tell players apart — least of all in the multiplayer SAVE lobby, where several seats can be
// an anonymous "Player 1003" until somebody claims them. The roster wire carries the seat's character id, and the
// host already rasterises `model://` keys to PNG on `/models/...`, so the icon is one <img> with no new route.
//
// A missing / blank id renders NO element at all (see the picker) — a broken-image box beside a name is worse
// than a name on its own, and an absent <img> also costs no layout.
export function seatCharacterIconUrl(player: Pick<BrowserPlayerOption, "characterId">): string | null {
  const id = player.characterId;
  if (typeof id !== "string" || id.trim() === "") return null;
  return modelAssetRoute(`model://characters/${id.trim()}/icon`);
}

/**
 * WS-B STREAM GATE — whether this viewer may have the host's live game streamed to it right now.
 *
 * The product rule, in one place: **never render (nor even pull) a multiplayer host's game behind the join
 * picker.** The host is streamed only when this device has been granted its own view — `joined` (its own headless
 * instance) or `directView` (the host handed over its own stream) — or when the host is NOT on a multiplayer
 * screen at all, which `computeMirrorJoinMode` already expresses as "title-only" (main menu / singleplayer run).
 *
 * The two extra conditions are why this can't just be `mode === "title-only"`: that mode is ALSO returned while a
 * join is in flight or the socket isn't connected (via `canChooseAssignment`), which are transient states owned by
 * a placeholder, not permission to stream.
 *
 * `seatIntent` — "this page's URL names a SEAT" (`?name=Ann`) — is the F3 rule, and it is REQUIRED rather than
 * optional so neither client can forget it. Such a viewer is a player waiting for a game, not a spectator: on a
 * screen it cannot join it must pull NO scene bytes at all and sit on the waiting screen instead. Because the
 * server never reads `?name=`, this client-side answer IS the enforcement point — it is what rides the `watch`
 * wire. Its position is deliberate: BELOW `joined || directView`, so an explicit grant (the seat was served, or
 * the host handed over its own view) always outranks a mere URL marker; ABOVE everything else, so a title-only
 * host screen no longer opens the gate for a viewer that named a seat.
 *
 * The web and native clients use this same predicate to decide whether to show the scene AND what to put on the
 * `watch` wire, so bytes and pixels can never disagree. C# twin: `JoinModel.ShouldWatchHostStream` — keep them in
 * lockstep (the native client has no `?name=`, so it passes `seatIntent: false`).
 */
export function shouldWatchHostStream(
  info: JoinInfo,
  pendingJoinName: string | null,
  mirrorMode: MirrorScreenKind | null,
  joined: boolean,
  directView: boolean,
  seatIntent: boolean
): boolean {
  if (joined || directView) {
    return true;
  }
  if (seatIntent) {
    return false;
  }
  if (pendingJoinName || info.status !== "connected") {
    return false;
  }
  // No session yet (`screenKind` is populated on every real one) ⇒ we do not know which screen the host is on, and
  // "unknown" must read as "do not stream". Without this the gate opens for the few ms between the socket opening
  // and the first `session` landing — long enough for the host to build and ship a multi-MB keyframe of a game we
  // are about to hide again.
  if (info.screenKind === null) {
    return false;
  }
  // Every established session carries the server's screen discriminator. A missing value is incomplete input,
  // not permission to render a host stream behind the picker.
  if (mirrorMode === null) {
    return false;
  }
  return computeMirrorJoinMode(info, pendingJoinName, mirrorMode) === "title-only";
}

// ---- roster filter -----------------------------------------------------------------------------------------
//
// The picker once filtered on "host + local", and a user report exposed the structural defect: `isLocal` is
// stamped from the connection's ALREADY-ASSIGNED name, so a device that has not joined YET has no local player —
// and the filter therefore degraded to host-only exactly when it mattered most, offering a player who dropped out
// of a live run (or who reloaded a saved multiplayer game) nothing but "Watch host" instead of their own seat.
//
// C# twin: JoinModel.MirrorRosterFor. Keep them in lockstep so the native and web clients render identical
// rosters.

/**
 * The picker's roster: host + every MIRROR SEAT, regardless of which device (if any) currently holds the
 * seat. That is what makes a rejoin possible — a returning device sees the seat it must reclaim before it has any
 * identity of its own. Genuine remote (non-couch-coop) players are never listed: the host cannot instance a mirror
 * for them, so offering the row would only produce a rejected join. The host is always kept — offered in every
 * mode, badged [Host] and never highlighted (picking it HANDLES the host player, which the host machine drives).
 */
export function mirrorRosterFor(players: BrowserPlayerOption[]): BrowserPlayerOption[] {
  return players.filter((player) => player.isHost || player.isMirrorSeat);
}

// ---- roster row presentation -------------------------------------------------------------------------------
//
// The per-row emphasis + secondary line every picker renders. Lifted out of the two Vue templates so the rules
// are written ONCE and the native JoinPanel can share them through the C# twins in
// src/CouchCoop.MirrorProtocol/Join/JoinModel.cs (SeatIsUnavailable / SeatIsClaimable /
// ShouldShowConnectionCount / ConnectionCountLabel) — keep the two sides in lockstep.

/**
 * A seat the host has declared un-joinable on THIS screen: a lobby zombie ("stuck" — a live instance with no game
 * connection, awaiting its reap) or a mid-run seat with no game-connected instance ("offline" — the game refuses
 * to admit it). Both render truly disabled with the server's reason, because the server refuses such a join too.
 * The HOST row is never unavailable: a seat status on it is meaningless (the host machine drives that player).
 */
export function seatIsUnavailable(
  player: Pick<BrowserPlayerOption, "isHost" | "seatStatus">
): boolean {
  return !player.isHost && player.seatStatus !== "ready";
}

/**
 * The rows to HIGHLIGHT: a ready seat with nobody on it — what this viewer is here to claim. The host is never
 * highlighted (the host machine already drives that player).
 */
export function seatIsClaimable(
  player: Pick<BrowserPlayerOption, "isHost" | "seatStatus" | "connectionCount">
): boolean {
  return !player.isHost && !seatIsUnavailable(player) && player.connectionCount === 0;
}

/** The controller count is only worth words from here up (see {@link shouldShowConnectionCount}). */
export const MIN_SHOWN_CONNECTION_COUNT = 2;

/**
 * Whether a roster row shows its controller count at all. ONLY when 2+ devices are on the seat — the unusual
 * case worth explaining. "0 controllers" / "1 controller" are pure noise on a picker: the *claimable* highlight
 * already says "nobody is on this seat" and one controller is simply the normal state. Users read the zero as a
 * fault ("is this seat broken?"), which is exactly the inverted signal the emphasis rules removed elsewhere.
 */
export function shouldShowConnectionCount(connectionCount: number): boolean {
  return connectionCount >= MIN_SHOWN_CONNECTION_COUNT;
}

/** "N controllers" (the singular is unreachable through the gate above, but kept correct for direct callers). */
export function connectionCountLabel(connectionCount: number): string {
  return `${connectionCount} ${connectionCount === 1 ? "controller" : "controllers"}`;
}

export function trimName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  return trimmed ? trimmed : null;
}

// iPhone Safari has NO element Fullscreen API (video-only), so the ONLY chromeless path there is the
// home-screen PWA (Add to Home Screen → standalone/fullscreen display mode). We show a one-line install
// tip on the join screen for iOS Safari users who haven't done that yet. Pure + injectable so it's unit
// testable without a DOM. Deliberately UA-based (there's no feature test that isolates "iOS Safari"); the
// hint is unobtrusive so a rare misdetection is harmless.

/** Whether the user agent looks like iOS Safari (iPhone/iPad/iPod). Best-effort UA sniff. */
export function isIosSafari(userAgent: string | null | undefined): boolean {
  return typeof userAgent === "string" && /iPad|iPhone|iPod/.test(userAgent);
}

/** The environment inputs the install hint decides from, read off window/navigator. */
export interface IosInstallHintEnv {
  userAgent: string | null | undefined;
  /** `navigator.standalone` (iOS-only; true once launched from the home screen). */
  navigatorStandalone?: boolean;
  /** `window.matchMedia('(display-mode: standalone)').matches` (true when running as an installed PWA). */
  displayModeStandalone?: boolean;
  /**
   * `window.matchMedia('(display-mode: fullscreen)').matches`. Our manifest declares `display: "fullscreen"`,
   * so a browser that honours that value reports THIS mode rather than `standalone` for the installed app —
   * checking only `standalone` would leave the overlay/button believing an installed app is still a tab.
   */
  displayModeFullscreen?: boolean;
}

// Show the "Add to Home Screen" tip only on iOS Safari that is NOT already running standalone. A viewer
// launched from the home screen (any standalone signal true) is already fullscreen, so the hint would be
// noise; Android/desktop never match the iOS UA and never see it.
export function shouldShowIosInstallHint(env: IosInstallHintEnv): boolean {
  if (!isIosSafari(env.userAgent)) {
    return false;
  }
  return !isStandaloneEnv(env);
}

/** Whether ANY of the three "we are already an installed/chromeless app" signals is set. */
export function isStandaloneEnv(env: IosInstallHintEnv): boolean {
  return (
    env.navigatorStandalone === true ||
    env.displayModeStandalone === true ||
    env.displayModeFullscreen === true
  );
}

// ---- WS1: the guided Add-to-Home-Screen overlay -------------------------------------------------------------
//
// The one-line grey hint this replaces sat under the seat picker and was, by the user's own report, never read.
// The overlay instead fires on the SEAT TAP: at that moment the payoff is concrete ("this is the screen you are
// about to play on") and it is no longer competing with the only decision the join screen asks for. Everything
// below stays pure so the gate, the copy variant and the dismissal are unit-testable without a DOM; the
// component (join/IosInstallOverlay.vue) only renders what these answer.

/**
 * The iOS/iPadOS MAJOR version read off the UA ("CPU iPhone OS 26_0 like Mac OS X" / iPad's "CPU OS 26_0 …"),
 * or null when it cannot be read. Used for exactly ONE sentence of overlay copy, so a miss degrades to the
 * shorter instructions that are true on every version rather than to wrong ones.
 *
 * The `Mac OS X` tail in every iOS UA cannot match: the pattern requires a DIGIT right after `OS `.
 */
export function iosMajorVersion(userAgent: string | null | undefined): number | null {
  if (typeof userAgent !== "string") {
    return null;
  }
  const match = /\bOS (\d+)(?:[_.]\d+)*/.exec(userAgent);
  if (!match) {
    return null;
  }
  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) ? major : null;
}

/**
 * iOS 26 reworked the Add-to-Home-Screen sheet: it carries an "Open as Web App" toggle (ON by default) that
 * decides whether the icon launches chromeless or just opens a Safari tab. Mentioning it below 26 would send
 * the player hunting for a control that is not there, which is worse than saying nothing — so the sentence is
 * version-gated, and an unreadable version omits it.
 */
export const IOS_OPEN_AS_WEB_APP_MIN_VERSION = 26;

export function showsOpenAsWebAppToggle(userAgent: string | null | undefined): boolean {
  const major = iosMajorVersion(userAgent);
  return major !== null && major >= IOS_OPEN_AS_WEB_APP_MIN_VERSION;
}

// ---- one-per-device dismissals ------------------------------------------------------------------------------
//
// `localStorage`, not the `sessionStorage` the name memory uses: "I already know how to install this" / "I know
// this browser is imperfect" must survive a reload and a tab close, and neither flag is per-tab identity.
//
// CAVEAT, and the reason the standalone checks above are the REAL suppressor: an iOS home-screen web app gets
// its own storage jar, so a flag written in the Safari tab is invisible to the installed app and vice versa. The
// flag therefore only has to stop the overlay nagging a player who deliberately stayed in the tab; the player
// who actually installed is suppressed by `isStandaloneEnv`, which needs no storage at all.

export const IOS_INSTALL_DISMISSED_STORAGE_KEY = "couchCoop:iosInstallDismissed";
export const BROWSER_ADVISORY_DISMISSED_STORAGE_KEY = "couchCoop:browserAdvisoryDismissed";

/** A persisted dismissal flag. Any storage failure (private mode, minimal env) reads as "not dismissed". */
export function readDismissedFlag(
  storage: Pick<Storage, "getItem"> | null | undefined,
  key: string
): boolean {
  try {
    return storage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** Persist a dismissal. Best-effort: a storage failure only costs the player one more sighting. */
export function writeDismissedFlag(
  storage: Pick<Storage, "setItem"> | null | undefined,
  key: string
): void {
  try {
    storage?.setItem(key, "1");
  } catch {
    // No storage — the overlay simply shows again next load. Never a reason to break the join.
  }
}

/** The install overlay's inputs: the hint's environment plus this device's persisted dismissal. */
export interface IosInstallOverlayEnv extends IosInstallHintEnv {
  dismissed?: boolean;
}

/**
 * Whether the guided overlay may show AT ALL for this device (the seat tap is the separate arming step, owned by
 * the app). Same platform gate as the old hint — iOS Safari, not already chromeless — plus the dismissal.
 */
export function shouldShowIosInstallOverlay(env: IosInstallOverlayEnv): boolean {
  return env.dismissed !== true && shouldShowIosInstallHint(env);
}

// ---- ?iosInstall=force repro lever ---------------------------------------------------------------------------
//
// There is no iPhone in this project's test fleet. This lever lets the whole flow (steps → delayed escape →
// confirm → genie → pill → reopen) be driven and screenshotted on any desktop/Android Chrome: it forces the
// PLATFORM gates open (an iPhone-iOS-26 tab, element fullscreen unavailable) but leaves dismissal storage REAL,
// so the persistence behavior under test is the actual behavior, not a fake.

function readIosInstallForce(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("iosInstall") === "force";
  } catch {
    return false;
  }
}

let iosInstallForce = readIosInstallForce();

export function isIosInstallForced(): boolean {
  return iosInstallForce;
}

export function __setIosInstallForceForTest(forced: boolean): void {
  iosInstallForce = forced;
}

/** The env the force lever pretends to be — iOS 26 so the "Open as Web App" copy variant renders too. */
export const IOS_INSTALL_FORCED_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

/**
 * Element-fullscreen availability as FullscreenButton/IosInstallButton see it: real `document.fullscreenEnabled`,
 * except forced OFF under the lever — iPhone Safari has no element Fullscreen API, so this is what keeps the two
 * buttons mutually exclusive under `?iosInstall=force` exactly as they are on a real device.
 */
export function readElementFullscreenSupported(
  doc: Pick<Document, "fullscreenEnabled"> | null = typeof document === "undefined" ? null : document
): boolean {
  if (isIosInstallForced()) return false;
  return doc?.fullscreenEnabled === true;
}

// ---- genie-close geometry -------------------------------------------------------------------------------------
//
// Pure center-to-center math so the "shrink into the pill" animation is unit-testable without a DOM. The overlay
// only measures rects and applies the result.

export interface GenieRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GenieTransform {
  dx: number;
  dy: number;
  scale: number;
}

/**
 * The translate+scale that flies `card` onto `target`, keeping both centers aligned throughout (default
 * transform-origin is the element's own center, so translate-then-scale lands exactly on target regardless of
 * scale). Null when either rect has no area — a detached/unmounted element, or jsdom (which never lays out) —
 * which the overlay reads as "skip the animation, close instantly."
 */
export function computeGenieTransform(card: GenieRect, target: GenieRect): GenieTransform | null {
  if (card.width <= 0 || card.height <= 0 || target.width <= 0 || target.height <= 0) {
    return null;
  }
  return {
    dx: target.left + target.width / 2 - (card.left + card.width / 2),
    dy: target.top + target.height / 2 - (card.top + card.height / 2),
    scale: Math.min(Math.max(target.width / card.width, 0.04), 0.5)
  };
}

// ---- WS4: browser advisory ----------------------------------------------------------------------------------

/**
 * Samsung Internet mis-renders some in-game text (2026-08 user report on a real device). UA-based and injectable
 * exactly like {@link isIosSafari} — there is no feature test for "this engine lays my glyphs out wrong", and
 * the consequence of a misfire is one dismissible line of advice, never a blocked join.
 *
 * Matches the `SamsungBrowser/<version>` token Samsung Internet appends to an otherwise Chrome-shaped UA. Chrome
 * on a Samsung phone does NOT carry it, which is the whole point: the advice is about the browser, not the phone.
 */
export function shouldRecommendBrowser(userAgent: string | null | undefined): boolean {
  return typeof userAgent === "string" && /SamsungBrowser/i.test(userAgent);
}

export const BROWSER_ADVISORY_MESSAGE =
  "Some text may not render correctly in this browser — Chrome or Firefox is recommended.";

export interface BrowserAdvisoryEnv {
  userAgent: string | null | undefined;
  dismissed?: boolean;
}

/** ADVISORY ONLY. Nothing downstream may gate joining on this — it decides whether a notice renders, no more. */
export function shouldShowBrowserAdvisory(env: BrowserAdvisoryEnv): boolean {
  return env.dismissed !== true && shouldRecommendBrowser(env.userAgent);
}

// ---- reading the live browser environment --------------------------------------------------------------------
//
// The ONE place that touches `navigator` / `window.matchMedia` / `localStorage` for the gates above, so the gates
// themselves stay pure and every consumer asks the same questions the same way. Every seam is injectable, which
// is how the components are mounted in unit tests without redefining globals. Guarded for non-DOM environments.

export interface LiveEnvSeams {
  navigator?: (Pick<Navigator, "userAgent"> & { standalone?: boolean }) | null;
  window?: Pick<Window, "matchMedia"> | null;
  /** The DISMISSAL jar (`localStorage`), separate from the name memory's `sessionStorage`. */
  storage?: Pick<Storage, "getItem"> | null;
}

function liveNavigator(seams: LiveEnvSeams): LiveEnvSeams["navigator"] {
  if (seams.navigator !== undefined) return seams.navigator;
  return typeof navigator === "undefined" ? null : navigator;
}

function liveWindow(seams: LiveEnvSeams): LiveEnvSeams["window"] {
  if (seams.window !== undefined) return seams.window;
  return typeof window === "undefined" ? null : window;
}

function liveStorage(seams: LiveEnvSeams): LiveEnvSeams["storage"] {
  if (seams.storage !== undefined) return seams.storage;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Storage access can THROW (not just return null) in a partitioned/blocked context.
    return null;
  }
}

function matchesDisplayMode(win: LiveEnvSeams["window"], mode: string): boolean {
  try {
    return typeof win?.matchMedia === "function" && win.matchMedia(`(display-mode: ${mode})`).matches;
  } catch {
    return false;
  }
}

/** The live standalone/fullscreen-display signals, as the pure gates want them. */
export function readDisplayEnv(seams: LiveEnvSeams = {}): IosInstallHintEnv {
  // ?iosInstall=force: pretend to be an iPhone tab regardless of the real UA/display-mode, so the whole flow is
  // reproducible on desktop/Android. Short-circuits BEFORE the seams so a forced load is never accidentally
  // "real" because a caller happened to pass one.
  if (isIosInstallForced()) {
    return {
      userAgent: IOS_INSTALL_FORCED_UA,
      navigatorStandalone: false,
      displayModeStandalone: false,
      displayModeFullscreen: false
    };
  }
  const nav = liveNavigator(seams);
  const win = liveWindow(seams);
  return {
    userAgent: nav?.userAgent ?? null,
    navigatorStandalone: nav?.standalone === true,
    displayModeStandalone: matchesDisplayMode(win, "standalone"),
    displayModeFullscreen: matchesDisplayMode(win, "fullscreen")
  };
}

/**
 * Whether this page is running as an installed / chromeless app right now. Used by FullscreenButton: a
 * standalone app has no browser chrome left to hide, so the control is an 80×80 hole that does nothing
 * visible — `fullscreenEnabled` alone does NOT catch that case (an installed Android PWA still reports true).
 */
export function isRunningStandalone(seams: LiveEnvSeams = {}): boolean {
  return isStandaloneEnv(readDisplayEnv(seams));
}

export function readIosInstallOverlayEnv(seams: LiveEnvSeams = {}): IosInstallOverlayEnv {
  return {
    ...readDisplayEnv(seams),
    dismissed: readDismissedFlag(liveStorage(seams), IOS_INSTALL_DISMISSED_STORAGE_KEY)
  };
}

export function readBrowserAdvisoryEnv(seams: LiveEnvSeams = {}): BrowserAdvisoryEnv {
  return {
    userAgent: liveNavigator(seams)?.userAgent ?? null,
    dismissed: readDismissedFlag(liveStorage(seams), BROWSER_ADVISORY_DISMISSED_STORAGE_KEY)
  };
}

// NO ANDROID HINT. The join screens used to offer "Android: install the native app for smoother play" (gated by an
// `isAndroid` UA sniff + an `androidInstallUrl` helper). Both are gone: the native Godot client is paused, so
// advertising it sends phones to an app nobody is maintaining. The HOST-side plumbing is deliberately kept —
// `androidApkUrl` still rides the session envelope and the mod still serves the route — so a dev build can be
// side-loaded by URL and the hint can come back as pure UI if the native client ever resumes.

// ---- the `?name=` page-URL param ---------------------------------------------------------------------------
//
// The param is written ONLY by the browser (the host never reads it) and carries THREE distinguishable states,
// which is what lets a reload land the viewer back where they were:
//
//   absent (`/`)          → nothing chosen: show the picker.
//   empty  (`/?name=`)    → the HOST player's own browser (a multiplayer direct view): re-pick the [Host] row.
//   value  (`/?name=Ann`) → that seat: auto-join it.
//
// `trimName` collapses the empty form to null, so `readUrlName` alone cannot tell "absent" from "empty" — every
// caller that cares must go through `hasNameParam` / `readUrlNameState`.

// The `?name=` page-URL param (an auto-join target), or null. NOTE: null for BOTH "absent" and "empty" — an
// empty param is the host marker, not a seat name (see readUrlNameState).
export function readUrlName(location: Pick<Location, "href"> = window.location): string | null {
  try {
    return trimName(new URL(location.href).searchParams.get("name"));
  } catch {
    return null;
  }
}

/**
 * Whether the page URL carries a `name` param AT ALL — `?name=` (empty) included. This is the distinction
 * `readUrlName` cannot make, and the whole reason the host marker can be an empty value: it is invisible to the
 * server (which never reads the param) and inert for every existing reader, while still being a state the
 * browser can see on the next load.
 */
export function hasNameParam(location: Pick<Location, "href"> = window.location): boolean {
  try {
    return new URL(location.href).searchParams.has("name");
  } catch {
    return false;
  }
}

/** The three states of the param, as a comparable value. `name` is set only for `kind: "seat"`. */
export type UrlNameKind = "absent" | "host" | "seat";
export interface UrlNameState {
  kind: UrlNameKind;
  name: string | null;
}

/** The state a written param value stands for: null → absent, "" → the host marker, a name → that seat. */
export function urlNameStateFor(value: string | null): UrlNameState {
  if (value === null) return { kind: "absent", name: null };
  const trimmed = trimName(value);
  return trimmed ? { kind: "seat", name: trimmed } : { kind: "host", name: null };
}

/** The param state of a page URL. */
export function readUrlNameState(location: Pick<Location, "href"> = window.location): UrlNameState {
  if (!hasNameParam(location)) return { kind: "absent", name: null };
  return urlNameStateFor(readUrlName(location) ?? "");
}

/** Two param states describe the same join intent (same kind, and for a seat the same name). */
export function urlNameStatesMatch(a: UrlNameState, b: UrlNameState): boolean {
  return a.kind === b.kind && (a.kind !== "seat" || a.name === b.name);
}

/**
 * The popstate decision. `expected` is what the URL should say for the join state THIS page currently holds
 * (updated at every stamp); `actual` is what the URL says after the user navigated. A difference means the
 * in-memory state no longer matches the address bar — Back off a joined seat, Forward back into one, or a jump
 * between two different seats — and the only reset that is consistent with every module's lazy URL read is a
 * full page reload. Equal states are a no-op, which is also the reload-loop guard: a reload re-derives
 * `expected` from the URL it landed on, so it can never disagree with itself.
 */
export function shouldReloadForUrlNameChange(expected: UrlNameState, actual: UrlNameState): boolean {
  return !urlNameStatesMatch(expected, actual);
}

/** The history seam the URL writers need. Injectable so the writers are unit-testable without a DOM. */
export type UrlHistory = Pick<History, "pushState" | "replaceState">;

/**
 * Write (or clear) the `?name=` param on the page URL.
 *
 * `value`: a seat name, `""` for the host marker (present-but-empty), or `null` to remove the param entirely.
 * `mode`: `"push"` adds a history entry, so the browser's Back button returns to the previous join state (this
 * is the point — a phone player must be able to get back to the picker); `"replace"` rewrites silently and is
 * only for cleaning up a stale marker nobody navigated to.
 *
 * Returns true when the URL actually changed. The equality guard is load-bearing: the auto-join path re-stamps
 * the very name it read out of the URL, and pushing that would bury the picker one extra Back press deep on
 * every reload.
 */
export function writeUrlNameParam(
  value: string | null,
  mode: "push" | "replace",
  opts: {
    history?: UrlHistory;
    location?: Pick<Location, "href">;
  } = {}
): boolean {
  const history = opts.history ?? globalThis.history;
  const location = opts.location ?? (typeof window !== "undefined" ? window.location : undefined);
  try {
    if (!location || !history) {
      return false;
    }
    const url = new URL(location.href);
    const current = url.searchParams.has("name") ? url.searchParams.get("name") ?? "" : null;
    // A padded param (`?name=%20Ann%20`) already IS this seat — rewriting it would only cost a history entry.
    if (current === value || (value !== null && value !== "" && trimName(current) === value)) {
      return false;
    }
    if (value === null) {
      url.searchParams.delete("name");
    } else {
      url.searchParams.set("name", value);
    }
    const next = url.toString();
    if (mode === "push") {
      history.pushState(null, "", next);
    } else {
      history.replaceState(null, "", next);
    }
    return true;
  } catch {
    // No usable URL/history (a minimal test location, a sandboxed frame) — callers treat this as best-effort.
    return false;
  }
}

// The last joined name saved in storage (form prefill only — never auto-joins on its own).
export function readStoredName(storage: Pick<Storage, "getItem">): string | null {
  try {
    return trimName(storage.getItem(LAST_PLAYER_NAME_STORAGE_KEY));
  } catch {
    return null;
  }
}

// Persist the joined name for later prefill and PUSH `?name=` into the page URL so the NEXT reload auto-joins
// straight in — and, because it is a push and not a replace, so the browser's own Back button takes the player
// out of the seat and back to the picker (the mirror turns that navigation into a reload; see
// shouldReloadForUrlNameChange). Best-effort: no-ops where storage/URL/history are unavailable.
export function rememberJoinedName(
  name: string,
  opts: {
    storage?: Pick<Storage, "setItem">;
    history?: UrlHistory;
    location?: Pick<Location, "href">;
  } = {}
): void {
  const trimmed = trimName(name);
  if (!trimmed) {
    return;
  }
  const storage = opts.storage ?? globalThis.sessionStorage;
  try {
    storage?.setItem(LAST_PLAYER_NAME_STORAGE_KEY, trimmed);
  } catch {
    // No storage (private mode / minimal env) — URL sync below still enables reload auto-join.
  }
  writeUrlNameParam(trimmed, "push", { history: opts.history, location: opts.location });
}
