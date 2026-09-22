import { hostUrl } from "@/join/hostBase";

export type BrowserEnvelopeType = "session" | "action-result" | "error" | "server-reload";

export type BrowserConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "unsupported";

export type BrowserNoticeSeverity = "info" | "warning" | "error";

export interface BrowserViewerIdentity {
  name?: string | null;
  playerId?: string | null;
}

export interface BrowserConnectionState {
  status: BrowserConnectionStatus;
  connectionCount?: number;
  webSocketPath?: "/ws";
}

export interface BrowserSessionAssignment {
  name: string | null;
  status: "joined" | "unassigned" | string;
  joined: boolean;
  playerId: string | null;
  connectionCount: number;
}

// Server-derived joinability of a couch-coop MIRROR SEAT (C# twin: MirrorSeatStatuses). The host derives it
// per-SCREEN, because what the game will accept differs between a lobby and a live run.
//   "ready"   — tappable. A seat whose headless instance is up and game-connected (in a run that includes the
//               DETACHED reconnect case: instance alive, browser gone), and — on a lobby screen only — a seat with
//               no instance at all, since tapping spawns one bound to that seat's netId (that IS the rejoin).
//   "stuck"   — not tappable, lobby only. The seat's instance is up but has no live connection to the host's game:
//               a zombie that can neither play nor be rejoined. The host reaps it; until then the row is disabled.
//   "offline" — not tappable, mid-run only. No game-connected instance while a run is in progress, so the game
//               refuses to admit it (NetError.RunInProgress). Nothing is broken — the run just can't be joined.
// Both non-ready values render as a genuinely DISABLED row (never merely dimmed): the server refuses such a join
// too.
export type MirrorSeatStatus = "ready" | "stuck" | "offline";

export interface BrowserPlayerOption {
  playerId: string;
  name: string;
  isHost: boolean;
  isRunPlayer: boolean;
  connectionCount: number;
  disconnected: boolean;
  // True when this player belongs to THIS device (per-connection stamp from the host). The picker's roster filter does NOT use
  // it — see joinModel.mirrorRosterFor for why locality is the wrong key for a seat a device is returning to.
  isLocal: boolean;
  // The ENet netId behind this option, from the "p:{netId}" player id. null for the host's synthetic lobby-only
  // options (their id is the raw display name).
  netId: number | null;
  // True when this row is a couch-coop seat the host can instance — the rows the MIRROR roster filter
  // (joinModel.mirrorRosterFor) keeps alongside the host.
  isMirrorSeat: boolean;
  seatStatus: MirrorSeatStatus;
  // Human-readable WHY for a non-ready seat, rendered on the disabled row. null when seatStatus is "ready".
  seatStatusReason: string | null;
  // R19 WP-2 — the character this seat is playing, as the model id the host already publishes elsewhere
  // (BrowserLobbyPlayerDto.characterId). The mirror picker renders it as the `/models/characters/<id>/icon`
  // PNG left of the name, which is how a player tells four "Player 100x" rows apart in a save lobby. null on a
  // lobby seat nobody has picked a character for, or on any seat the host cannot resolve one
  // for — all three render NO image rather than a broken one.
  characterId: string | null;
}

// Mirror-view screen discriminator (server-derived, only meaningful to the mirror). Distinguishes the cases
// the mirror join UI / gating needs but `kind` can't express.
// The two character-select kinds share one `kind: "lobby"` screen and differ only in whether that lobby is
// joinable: `sp-character-select` is a SINGLEPLAYER lobby, so there is no seat to claim and the mirror just
// watches (no name form, stream gate open) — the same treatment `singleplayer-run` gets.
// C# twin: SessionEnvelope.MirrorScreenKinds; producer: BrowserAssignmentClassifier.MirrorModeFor.
export type MirrorScreenKind =
  | "singleplayer-run"
  | "mp-run"
  | "mp-character-select"
  | "sp-character-select"
  | "mp-load-game"
  | "main-menu"
  | "unsupported";

export interface BrowserScreenSummary {
  kind: "lobby" | "run" | "unsupported" | "singleplayerUnsupported" | string;
  type: string | null;
  title: string | null;
  mirrorMode: MirrorScreenKind;
}

export interface BrowserNotice {
  code: string;
  severity: BrowserNoticeSeverity;
  message?: string | null;
  capabilityId?: string | null;
  supported?: boolean;
  provisional?: boolean;
  unsupportedReason?: string | null;
}

export interface BrowserEnvelopeBase {
  type: BrowserEnvelopeType;
  requestId?: string;
  revision?: number | null;
  viewer?: BrowserViewerIdentity | null;
  viewerId?: string | null;
  connection?: BrowserConnectionState | null;
  capabilities?: unknown;
  notices?: BrowserNotice[];
  session?: BrowserSessionAssignment | null;
  players?: BrowserPlayerOption[];
  screen?: BrowserScreenSummary | null;
  assignmentNotices?: BrowserNotice[];
}

// The one-time per-client `session` message: identity + capabilities/notices + the lobby/run assignment.
// The mirror-directive fields (below) ride the join reply.
export interface BrowserSessionEnvelope extends BrowserEnvelopeBase {
  type: "session";
  session: BrowserSessionAssignment;
  players: BrowserPlayerOption[];
  screen: BrowserScreenSummary;
  // Redirect target: this viewer's own per-player headless game view. The mirror reconnects its socket here.
  headlessMirrorPort?: number | null;
  // Server-issued join generation on the original host socket; never a child control credential.
  connectionAttemptId?: string | null;
  // true → watch the HOST's own stream in place (no redirect). Set for a singleplayer run / host selection.
  directView?: boolean;
  // Rejection code when the requested name isn't servable (mirror shows the picker + a mapped message):
  // "not-a-session-player" | "no-free-instance" | "spawn-failed" | "seat-unavailable" (the picked seat's
  // seatStatus is not "ready" — the picker already disables those rows, so this only surfaces on a stale roster)
  // | "join-failed" (the host's join handler threw; the reason is in joinRejectionDetail).
  joinRejection?: string | null;
  // Server-authored fault text, sent ONLY with joinRejection === "join-failed". Shown verbatim under the friendly
  // line so a viewer can report — or a developer can read — what actually broke, instead of a spinner that never
  // ends. Absent from every rejection code that is self-describing.
  joinRejectionDetail?: string | null;
  // The host's real active frame-rate baseline (the mirror "refresh rate"), so the Settings panel seeds a truthful
  // label instead of the hardcoded 24. null/absent → unlimited/vsync or no measured baseline.
  refreshRate?: number | null;
  // The three "Host performance" freezes as the instance SERVING THIS CONNECTION actually applies them, so the
  // Settings panel seeds its checkboxes from the game it is about to control rather than assuming the headless
  // defaults. A per-viewer headless seat reports its env defaults (normally all true); the host's OWN windowed game
  // reports all false — the mod installs the visual suspender only for a windowless instance, so nothing is frozen
  // there until a viewer turns it on. null/absent = UNKNOWN (for example, no probing result yet) — the client keeps
  // its own defaults.
  freezeParticles?: boolean | null;
  freezeSpines?: boolean | null;
  freezeDecor?: boolean | null;
  // The GAME's own Settings → Text Effects preference on the instance serving this connection, so the mirror's
  // animated rich text (the wavy and bouncing tags) obeys the switch the player at the keyboard set. It has to be
  // told: the game leaves the effect markup in the label's string and skips the per-character transform instead,
  // so identical BBCode reaches the browser whichever way the setting is set. null/absent = UNKNOWN (a Godot-less
  // host, an older one) ⇒ the client keeps its own default of ENABLED, which is the game's default too.
  textEffects?: boolean | null;
  // Relative URL of the host-served native Android client APK ("/couchcoop-client.apk"). Present only when the
  // locally-built APK is deployed on the host; the join screens render an install link from it on Android.
  androidApkUrl?: string | null;
  // The host machine name, stamped on every current session.
  hostName: string;
  // The host's asset-cache identity: it changes exactly when the bytes behind a given /res/ url can have
  // changed (its game build, or a cache generation on either side of the seam). Forwarded to the service
  // worker, which drops its durable /res/ store when it moves — the one signal that covers a game update with
  // no frontend rebuild, and a phone that joins a stable host and then a beta one. Absent on an older host,
  // which simply means the worker keeps relying on the bundle hash alone.
  assetCacheToken?: string | null;
  // Static background (Stage A): the CURRENT combat room's host-rendered background image — the live bg scene
  // root's res:// path plus a ready-to-fetch /bg/ URL (digest-qualified when the host read the mounted layer
  // variant). Absent/null when unknown: non-combat screens, the host valve off, or no probe yet.
  // StaticBackground.vue displays it while the "Static background" setting is ON; absent ⇒ fail open to the
  // live bg subtree.
  staticBackground?: BrowserStaticBackgroundDescriptor | null;
  // The atlas PAGES this host's game build actually ships, enumerated once on the host from res://images/atlases/.
  // The idle prefetch (@/mirror/imagePrefetch) intersects its compiled-in wish-list with this, which is what stops
  // a client asking a repacked build for a page it no longer has. Absent on an older host and on any host that
  // could not enumerate — the prefetch then walks its own list unchanged, exactly as it always did.
  atlasManifest?: BrowserAtlasManifestDescriptor | null;
  // Current hosts always accept an absolute scroll offset (`set-scroll-offset`).
  scrollAction: true;
}

// The `staticBackground` wire shape (BrowserStaticBackgroundDto server-side).
export interface BrowserStaticBackgroundDescriptor {
  scenePath: string;
  url: string;
}

// The `atlasManifest` wire shape (BrowserAtlasManifestDto server-side). `directory` says what the page list
// COVERS, so "not in `pages`" can only ever mean "this build does not ship it" and never "this manifest was not
// talking about it" — see the C# record's comment for why that distinction is the point.
export interface BrowserAtlasManifestDescriptor {
  directory: string;
  pages: readonly string[];
}

export interface BrowserActionResultEnvelope extends BrowserEnvelopeBase {
  type: "action-result";
  code?: string | null;
  message?: string | null;
  result?: unknown;
  actionRefId?: string | null;
  snapshotId?: string | null;
  semanticActionId?: string | null;
  screenType?: string | null;
}

export interface BrowserErrorEnvelope extends BrowserEnvelopeBase {
  type: "error";
  code: string;
  message: string;
}

export interface BrowserServerReloadEnvelope {
  type: "server-reload";
  requestId?: string;
  reason?: string;
}

/**
 * `server-reload` reason meaning "this server is a HEADLESS mirror instance that is exiting because its connection
 * to the host game is permanently gone" (the host process died, or dropped it mid-run). The default reason means
 * "the server is coming back — reload the page"; this one must NOT reload, because the port it would reload
 * against is going away. The viewer drops back to the ORIGINAL host's picker and reconnects there instead, so the
 * seat is re-claimed automatically once the host reloads the saved run.
 *
 * C# twin: `BrowserServerReloadReasons.HeadlessHostDisconnected` (CouchCoop.MirrorProtocol) — keep in lockstep.
 */
export const HEADLESS_HOST_DISCONNECTED_REASON = "headless-host-disconnected";

export type BrowserEnvelope =
  | BrowserSessionEnvelope
  | BrowserActionResultEnvelope
  | BrowserErrorEnvelope
  | BrowserServerReloadEnvelope;

/**
 * `join-progress` — what the host is DOING about a join that has not answered yet.
 *
 * A cold seat spawn legitimately takes 20-60s and the host awaits it inline, so between the `join` and its reply
 * the screen used to show a bare "Joining…" spinner — the same screen a join that had already died showed for the
 * full 75s deadline. This envelope is the host reading its own connection registry out loud, about once a second
 * and only while something changes.
 *
 * Deliberately NOT part of `BrowserEnvelope` / `parseBrowserEnvelopeValue`: that union is the request/reply
 * surface every client branches on, and this is a one-way progress notification the mirror client picks off the
 * socket itself (`parseJoinProgress` below). Keeping it out means an older client's "unknown type → drop" path is
 * still exactly what happens, and nothing that consumes `BrowserEnvelope` has to learn a new case.
 *
 * C# twin: `BrowserJoinProgressEnvelope` (CouchCoop.MirrorProtocol).
 */
export interface BrowserJoinProgress {
  /** The `join` request this describes. A progress for any other request is about a join we have given up on. */
  requestId: string;
  stage: JoinProgressStage;
  /** Which of `stepTotal` steps the attempt is on, so the viewer sees movement inside one long stage. */
  step: number;
  stepTotal: number;
  /** Milliseconds since the attempt began, as the HOST measures it — the client runs no timer of its own. */
  elapsedMs: number;
}

/**
 * The closed stage vocabulary. Stable wire tokens for the host's own connection stages — the raw enum names are
 * internal bookkeeping and never reach a player's screen; the client maps these to localized copy.
 * C# twin: `BrowserJoinProgressStages` (CouchCoop.MirrorProtocol).
 */
export type JoinProgressStage =
  | "connecting"
  | "choosing"
  | "initializing"
  | "joining"
  | "loading-view"
  | "complete"
  | "failed";

const JOIN_PROGRESS_STAGES: readonly JoinProgressStage[] = [
  "connecting",
  "choosing",
  "initializing",
  "joining",
  "loading-view",
  "complete",
  "failed"
];

function isJoinProgressStage(value: unknown): value is JoinProgressStage {
  return typeof value === "string" && (JOIN_PROGRESS_STAGES as readonly string[]).includes(value);
}

/** A non-negative whole number, or null. Same refusal rule as the scroll ack: a coerced 0 is a real-looking lie. */
function joinProgressCount(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : null;
}

/**
 * Read one incoming frame as a join-progress notification, or null when it is not one (or not a usable one).
 *
 * Every field is required, because a half-formed progress is worse than none: the line it renders is a claim
 * about what the host is doing right now, and a missing stage or elapsed would show the viewer a confident
 * sentence built out of defaults. An unknown `stage` refuses for the same reason — a future host stage this build
 * has no words for must fall back to the plain spinner, not to a made-up description.
 */
export function parseJoinProgress(raw: unknown): BrowserJoinProgress | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  if (value.type !== "join-progress" || typeof value.requestId !== "string" || value.requestId.length === 0) {
    return null;
  }
  if (!isJoinProgressStage(value.stage)) {
    return null;
  }
  const step = joinProgressCount(value.step);
  const stepTotal = joinProgressCount(value.stepTotal);
  const elapsedMs = joinProgressCount(value.elapsedMs);
  if (step === null || stepTotal === null || elapsedMs === null) {
    return null;
  }
  return { requestId: value.requestId, stage: value.stage, step, stepTotal, elapsedMs };
}

/**
 * `seat-notice` — the host's own named verdict about why THIS viewer's seat is not serving them.
 *
 * The one failure a player is most likely to hit is the one nothing could tell them about. With the path from
 * this device to its seat port blocked (a device-scoped firewall rule, guest/AP isolation, a router that
 * separates clients), the host's own loopback probe of that seat SUCCEEDS — so the join is answered as a success,
 * the app is redirected to a port it cannot open, and the screen sits on "Loading…" for ever while the host
 * names the cause precisely four times a second and tells only itself.
 *
 * It arrives on the HOST socket, which a redirected viewer deliberately keeps open (closing it triggers the
 * server's Release() and kills the seat), so it is the only channel left in exactly the case it exists for.
 *
 * Deliberately NOT part of `BrowserEnvelope` / `parseBrowserEnvelopeValue`, for the same reason `join-progress`
 * is not: that union is the request/reply surface every client branches on, and this is a one-way notification
 * the mirror client picks off the socket itself. C# twin: `BrowserSeatNoticeEnvelope` (CouchCoop.MirrorProtocol).
 */
export interface BrowserSeatNotice {
  cause: SeatNoticeCause;
  /**
   * The host's English technical line — the same sentence its connection panel shows in grey and its copyable
   * report quotes verbatim. Rendered under the localized copy, never instead of it, and null on a withdrawal.
   */
  detail: string | null;
}

/**
 * The closed cause vocabulary. Stable wire tokens for the host's own readiness causes — the raw enum names are
 * internal bookkeeping and never reach a player's screen; the client maps these to localized copy.
 *
 * `none` is the WITHDRAWAL: the named cause stopped being true (the device got through, a browser attached), so
 * take the message off the screen rather than leaving a wrong accusation on it. There is no token for the host's
 * fourth cause, "still starting" — that is the normal state of every healthy join for its whole 20-60 seconds and
 * is never announced. C# twin: `BrowserSeatNoticeCauses` (CouchCoop.MirrorProtocol).
 */
export type SeatNoticeCause = "none" | "port-conflict" | "host-local-block" | "network-path";

const SEAT_NOTICE_CAUSES: readonly SeatNoticeCause[] = ["none", "port-conflict", "host-local-block", "network-path"];

function isSeatNoticeCause(value: unknown): value is SeatNoticeCause {
  return typeof value === "string" && (SEAT_NOTICE_CAUSES as readonly string[]).includes(value);
}

/**
 * Read one incoming frame as a seat notice, or null when it is not one (or not a usable one).
 *
 * An unknown `cause` refuses outright rather than degrading to "something is wrong": this message tells a player
 * which of several unrelated things to go and fix, and a build with no copy for a future cause would be guessing
 * at which. Silence is the honest fallback there — the same one this screen had before the envelope existed.
 *
 * `detail` is optional (a withdrawal carries none, and the host omits nulls), and a non-string one is dropped
 * rather than refusing the frame: the cause is what the player acts on, and losing the grey technical line is a
 * far smaller loss than losing the message it explains.
 */
export function parseSeatNotice(raw: unknown): BrowserSeatNotice | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  if (value.type !== "seat-notice" || !isSeatNoticeCause(value.cause)) {
    return null;
  }
  return {
    cause: value.cause,
    detail: typeof value.detail === "string" && value.detail.length > 0 ? value.detail : null
  };
}

export interface BrowserActionRequestEnvelope {
  type: "action";
  requestId: string;
  semanticActionId?: string;
  actionRefId?: string;
  snapshotId?: string;
  viewerId?: string;
  viewerPlayerId?: string;
  screenType?: string;
  // CEL-resolved action arguments (camelCase keys, e.g. { characterId }). The host maps these onto
  // the EmbeddableActionRequest's named fields + Values dict so arg-bearing actions resolve.
  args?: Record<string, unknown>;
}

export interface BrowserJoinRequestEnvelope {
  type: "join";
  requestId: string;
  name: string;
  // The SEAT the viewer picked, as that roster option's state player id ("p:1003"). Sent when a roster BUTTON was
  // tapped; omitted for a free-text name submit. Seat-accurate where a name is not: a saved seat the host has no
  // remembered name for is labelled with a synthesized "Player 1003", so matching that label back to a netId is
  // ambiguous. The host binds the spawned headless to the netId parsed out of this.
  playerId?: string;
}

export interface BrowserValidationErrorEnvelope {
  type: "error";
  requestId: string;
  code: "empty-player-name" | string;
  message: string;
}

// The `staticBackground` descriptor: accepted only when BOTH fields are non-empty strings — a half-formed
// descriptor must read as "unknown" (the client fails open to the live bg subtree), never as a fetchable URL.
function normalizeStaticBackground(raw: unknown): BrowserStaticBackgroundDescriptor | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const value = raw as { scenePath?: unknown; url?: unknown };
  return typeof value.scenePath === "string" && value.scenePath.length > 0
    && typeof value.url === "string" && value.url.length > 0
    // The host describes the picture with a route it serves; `hostUrl` points that at the game machine
    // when the page came from the public origin, and is a no-op otherwise. Applied at the single point
    // the descriptor enters the app, so StaticBackground.vue's url equality never compares two spellings
    // of the same picture.
    ? { scenePath: value.scenePath, url: hostUrl(value.url) }
    : null;
}

// The `atlasManifest` descriptor: accepted only when the directory is a non-empty string AND at least one page
// survives. A manifest that normalized to zero pages would tell the prefetch "this build ships no atlases at
// all", which is never true of a real host — so a half-formed one reads as "unknown" and the prefetch keeps its
// own list, the same fail-open rule `staticBackground` above uses. Non-string entries are dropped individually
// rather than voiding the manifest: one junk element should not cost the client the other eleven real answers.
// NOT passed through `hostUrl` — these are `res://` resource paths the prefetch maps itself, not routes.
function normalizeAtlasManifest(raw: unknown): BrowserAtlasManifestDescriptor | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const value = raw as { directory?: unknown; pages?: unknown };
  if (typeof value.directory !== "string" || value.directory.length === 0 || !Array.isArray(value.pages)) {
    return null;
  }
  const pages = value.pages.filter((page): page is string => typeof page === "string" && page.length > 0);
  return pages.length > 0 ? { directory: value.directory, pages } : null;
}

export function parseBrowserEnvelope(json: string): BrowserEnvelope {
  return parseBrowserEnvelopeValue(JSON.parse(json));
}

/**
 * The same parse, minus the `JSON.parse` — for a caller that has ALREADY parsed the frame.
 *
 * The mirror client dispatches on `raw.type` off its own parse of every incoming message and then used to hand the
 * ORIGINAL STRING back to `parseBrowserEnvelope`, so a `session` frame was parsed twice (a phone trace put the
 * message handler's own String+JSON.parse at 70-130ms per 12s of combat). Same object-taking shape as
 * `parseSceneDelta(raw)` in the mirror's own wire module.
 *
 * Deliberately typed `unknown` and cast exactly as the string entry point always did, so the non-object cases
 * behave identically on both paths: `null` throws a TypeError on the `.type` read, and any other non-envelope
 * value throws "Unsupported browser envelope type."
 */
export function parseBrowserEnvelopeValue(raw: unknown): BrowserEnvelope {
  const value = raw as Partial<BrowserEnvelope> & Record<string, unknown>;
  if (
    value.type !== "session"
    && value.type !== "action-result"
    && value.type !== "error"
    && value.type !== "server-reload"
  ) {
    throw new Error("Unsupported browser envelope type.");
  }

  if (value.type === "server-reload") {
    return {
      type: "server-reload",
      requestId: typeof value.requestId === "string" ? value.requestId : undefined,
      reason: typeof value.reason === "string" ? value.reason : undefined
    };
  }

  if (value.type === "session") {
    const session = normalizeSession(value.session);
    const players = normalizePlayers(value.players);
    return {
      ...value,
      type: "session",
      notices: normalizeNotices(value.notices),
      assignmentNotices: normalizeNotices(value.assignmentNotices),
      session,
      players,
      screen: normalizeScreen(value.screen),
      headlessMirrorPort: typeof value.headlessMirrorPort === "number" ? value.headlessMirrorPort : null,
      connectionAttemptId: typeof value.connectionAttemptId === "string" && value.connectionAttemptId.length <= 128
        ? value.connectionAttemptId : null,
      directView: value.directView === true,
      joinRejection: typeof value.joinRejection === "string" ? value.joinRejection : null,
      joinRejectionDetail:
        typeof value.joinRejectionDetail === "string" ? value.joinRejectionDetail : null,
      refreshRate: typeof value.refreshRate === "number" ? value.refreshRate : null,
      // Tri-state on purpose: true/false are the instance's real freeze state; null means it is unavailable.
      // Only a real boolean may seed the panel — coercing an absent field to false would invent a windowed state.
      freezeParticles: typeof value.freezeParticles === "boolean" ? value.freezeParticles : null,
      freezeSpines: typeof value.freezeSpines === "boolean" ? value.freezeSpines : null,
      freezeDecor: typeof value.freezeDecor === "boolean" ? value.freezeDecor : null,
      androidApkUrl: typeof value.androidApkUrl === "string" ? value.androidApkUrl : null,
      hostName: requiredString(value.hostName, "hostName"),
      assetCacheToken: typeof value.assetCacheToken === "string" ? value.assetCacheToken : null,
      staticBackground: normalizeStaticBackground(value.staticBackground),
      atlasManifest: normalizeAtlasManifest(value.atlasManifest),
      scrollAction: requiredTrue(value.scrollAction, "scrollAction")
    };
  }

  if (value.type === "action-result") {
    return {
      ...value,
      type: "action-result",
      notices: normalizeNotices(value.notices)
    };
  }

  return {
    ...value,
    type: "error",
    code: String(value["code"] ?? "browser-envelope-error"),
    message: String(value["message"] ?? "Browser envelope error."),
    notices: normalizeNotices(value.notices)
  };
}

export function buildBrowserActionRequest(input: {
  requestId: string;
  semanticActionId?: string;
  actionRefId?: string;
  snapshotId?: string;
  viewerId?: string | null;
  viewerPlayerId?: string | null;
  screenType?: string | null;
  args?: Record<string, unknown>;
}): BrowserActionRequestEnvelope {
  return {
    type: "action",
    requestId: input.requestId,
    ...(input.semanticActionId ? { semanticActionId: input.semanticActionId } : {}),
    ...(input.actionRefId ? { actionRefId: input.actionRefId } : {}),
    ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
    ...(input.viewerId ? { viewerId: input.viewerId } : {}),
    ...(input.viewerPlayerId ? { viewerPlayerId: input.viewerPlayerId } : {}),
    ...(input.screenType ? { screenType: input.screenType } : {}),
    ...(input.args && Object.keys(input.args).length ? { args: input.args } : {})
  };
}

export function buildBrowserJoinRequest(input: {
  requestId: string;
  name: string;
  playerId?: string | null;
}): BrowserJoinRequestEnvelope {
  return {
    type: "join",
    requestId: input.requestId,
    name: input.name.trim(),
    // Omitted entirely (not sent as null) when there is no picked seat, so a free-text join remains compact.
    ...(input.playerId ? { playerId: input.playerId } : {})
  };
}

export function buildBrowserValidationError(input: {
  requestId: string;
  code: string;
  message: string;
}): BrowserValidationErrorEnvelope {
  return {
    type: "error",
    requestId: input.requestId,
    code: input.code,
    message: input.message
  };
}

function normalizeSession(session: unknown): BrowserSessionAssignment {
  if (!session || typeof session !== "object") {
    throw new Error("Invalid current session assignment.");
  }

  const record = session as Record<string, unknown>;
  if (
    !hasNullableString(record, "name")
    || typeof record.status !== "string"
    || typeof record.joined !== "boolean"
    || !hasNullableString(record, "playerId")
    || typeof record.connectionCount !== "number"
    || !Number.isFinite(record.connectionCount)
  ) {
    throw new Error("Invalid current session assignment.");
  }
  return {
    name: typeof record.name === "string" ? record.name : null,
    status: record.status,
    joined: record.joined,
    playerId: typeof record.playerId === "string" ? record.playerId : null,
    connectionCount: record.connectionCount
  };
}

function normalizePlayers(players: unknown): BrowserPlayerOption[] {
  if (!Array.isArray(players)) {
    throw new Error("Invalid current session roster.");
  }

  return players.map((player) => {
    if (!player || typeof player !== "object") {
      throw new Error("Invalid current session roster entry.");
    }
    const record = player as Record<string, unknown>;
    if (
      typeof record.playerId !== "string"
      || typeof record.name !== "string"
      || typeof record.isHost !== "boolean"
      || typeof record.isRunPlayer !== "boolean"
      || typeof record.connectionCount !== "number"
      || !Number.isFinite(record.connectionCount)
      || typeof record.disconnected !== "boolean"
      || typeof record.isLocal !== "boolean"
      || typeof record.isMirrorSeat !== "boolean"
      || !isSeatStatus(record.seatStatus)
      || !hasNullableString(record, "seatStatusReason")
      || !hasNullableString(record, "characterId")
      || !(record.netId === null || (typeof record.netId === "number" && Number.isFinite(record.netId)))
    ) {
      throw new Error("Invalid current session roster entry.");
    }
    return {
      playerId: record.playerId,
      name: record.name,
      isHost: record.isHost,
      isRunPlayer: record.isRunPlayer,
      connectionCount: record.connectionCount,
      disconnected: record.disconnected,
      isLocal: record.isLocal,
      netId: typeof record.netId === "number" ? record.netId : null,
      isMirrorSeat: record.isMirrorSeat,
      seatStatus: record.seatStatus,
      seatStatusReason:
        typeof record.seatStatusReason === "string" ? record.seatStatusReason : null,
      // A blank string is normalized to null here rather than at the render site: "" would otherwise build a
      // `/models/characters//icon` request that can only 404, and the picker's "no id ⇒ no <img>" rule is much
      // easier to keep honest with one canonical empty value.
      characterId:
        typeof record.characterId === "string" && record.characterId.trim() !== ""
          ? record.characterId
          : null
    } satisfies BrowserPlayerOption;
  });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Invalid current session ${field}.`);
  return value;
}

function requiredTrue(value: unknown, field: string): true {
  if (value !== true) throw new Error(`Invalid current session ${field}.`);
  return true;
}

function hasNullableString(record: Record<string, unknown>, field: string): boolean {
  return Object.hasOwn(record, field)
    && (record[field] === null || typeof record[field] === "string");
}

function isSeatStatus(value: unknown): value is "ready" | "stuck" | "offline" {
  return value === "ready" || value === "stuck" || value === "offline";
}

function normalizeScreen(screen: unknown): BrowserScreenSummary {
  if (!screen || typeof screen !== "object") {
    throw new Error("Invalid current session screen.");
  }

  const record = screen as Record<string, unknown>;
  if (
    typeof record.kind !== "string"
    || !hasNullableString(record, "type")
    || !hasNullableString(record, "title")
    || !isMirrorScreenKind(record.mirrorMode)
  ) {
    throw new Error("Invalid current session screen.");
  }
  return {
    kind: record.kind,
    type: typeof record.type === "string" ? record.type : null,
    title: typeof record.title === "string" ? record.title : null,
    mirrorMode: record.mirrorMode
  };
}

const MIRROR_SCREEN_KINDS: readonly MirrorScreenKind[] = [
  "singleplayer-run",
  "mp-run",
  "mp-character-select",
  "sp-character-select",
  "mp-load-game",
  "main-menu",
  "unsupported"
];

function isMirrorScreenKind(value: unknown): value is MirrorScreenKind {
  return typeof value === "string" && (MIRROR_SCREEN_KINDS as readonly string[]).includes(value);
}

function normalizeNotices(notices: unknown): BrowserNotice[] {
  if (!Array.isArray(notices)) {
    return [];
  }

  return notices.map((notice) => {
    const record = notice && typeof notice === "object"
      ? notice as Record<string, unknown>
      : {};
    const unsupportedReason = record.unsupportedReason;
    const message = record.message ?? unsupportedReason ?? null;
    const code = record.code === undefined
      ? (record.supported === false ? "unsupported_capability" : "notice")
      : record.code;

    return {
      code: String(code),
      severity: normalizeSeverity(record.severity),
      message: message === null ? null : String(message),
      capabilityId: record.capabilityId === undefined ? null : String(record.capabilityId),
      supported: typeof record.supported === "boolean" ? record.supported : undefined,
      provisional: typeof record.provisional === "boolean" ? record.provisional : undefined,
      unsupportedReason: unsupportedReason === undefined ? null : String(unsupportedReason)
    };
  });
}

function normalizeSeverity(severity: unknown): BrowserNoticeSeverity {
  return severity === "info" || severity === "warning" || severity === "error"
    ? severity
    : "warning";
}
