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
  // Relative URL of the host-served native Android client APK ("/couchcoop-client.apk"). Present only when the
  // locally-built APK is deployed on the host; the join screens render an install link from it on Android.
  androidApkUrl?: string | null;
  // The host machine name, stamped on every current session.
  hostName: string;
  // Static background (Stage A): the CURRENT combat room's host-rendered background image — the live bg scene
  // root's res:// path plus a ready-to-fetch /bg/ URL (digest-qualified when the host read the mounted layer
  // variant). Absent/null when unknown: non-combat screens, the host valve off, or no probe yet.
  // StaticBackground.vue displays it while the "Static background" setting is ON; absent ⇒ fail open to the
  // live bg subtree.
  staticBackground?: BrowserStaticBackgroundDescriptor | null;
  // Current hosts always support these semantic actions.
  scrollAction: true;
  rewardAction: true;
}

// The `staticBackground` wire shape (BrowserStaticBackgroundDto server-side).
export interface BrowserStaticBackgroundDescriptor {
  scenePath: string;
  url: string;
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
      staticBackground: normalizeStaticBackground(value.staticBackground),
      scrollAction: requiredTrue(value.scrollAction, "scrollAction"),
      rewardAction: requiredTrue(value.rewardAction, "rewardAction")
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
