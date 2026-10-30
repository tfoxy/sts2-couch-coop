// "Use new renderer (Beta)" — whether it can run for this viewer, and which renderer runs now.
//
// ONE computed availability (handoff-mirror-new-renderer.md §3 Q3). Its reasons, in precedence order, are what
// the settings panel shows under the checkbox:
//
//   core-build     the core wasm is missing or stale here (dev), or failed to load
//   no-webgl2      this browser gives no WebGL2 context
//   host-view      watching the host's own game (`directView`), which never streams
//   needs-proxy    no descriptor, and this page's origin is not one a loopback stream can serve (LAN / HTTPS)
//   not-streaming  joined, but this seat has no descriptor; it applies when the seat next starts
//   seat-restarting / seat-restart-pending / seat-restart-refused / seat-restart-failed
//                  in place of not-streaming, what the host did with this viewer's mid-session request to restart
//                  their seat as the streaming seat (MIR-4, the host session's `rendererSeat`)
//
// The ENDPOINT comes from the `session` envelope of this viewer's own seat (MIR-3: the host's streaming seat sends
// it to a page origin its hub allows) or, for QA, from `?renderStream=` (source `qa-override`, info only).
//
// The join asks for a streaming seat (`renderer: "stream"`, `joinRendererRequest`) when the viewer chose the new
// renderer and this page could run it. The host launches at most one per host, and only at a seat's start.
// Turning the checkbox on AFTER the seat started asks the host to restart that seat as the streaming seat
// (`{type:"set-renderer"}`, MirrorApp): at once in a lobby, staged until the run ends mid-run (handoff §8).
//
// The live renderer (`runtimeRenderer`) is derived, never chosen: `stream` exactly while the viewer's choice is
// `stream`, the feature is available, and the stream has not stopped this session. A stopped stream falls back to
// the old renderer with a status line, and the saved choice stays `stream` — the canvas stage's
// `stage` / `runtimeStage` / `stageFailure` contract.

import { computed, reactive } from "vue";

import { validateEndpoint, type RenderStreamEndpoint } from "@godot-scene-web/render-stream-client";

import { mirrorSettings, type MirrorSettings } from "@/mirror/mirrorSettings";
import { renderStreamCoreConfig, type RenderStreamCoreProblem } from "@/mirror/renderStreamCore";

/** After this long in a hidden tab the stage disposes its client (its heap, and the hub's carried set for us, are
 * freed); a visible tab then reconnects as a fresh join. */
export const RENDER_STREAM_HIDDEN_DISPOSE_MS = 60_000;

export type RenderStreamUnavailableReason = "core-build" | "no-webgl2" | "host-view" | "needs-proxy" | "not-streaming"
  | "seat-restarting" | "seat-restart-pending" | "seat-restart-refused" | "seat-restart-failed";

/** The host session's `rendererSeat`: what became of this viewer's request to restart their seat as the streaming
 * seat. `reason` is a host code (`another-seat-streaming`, `no-capture`, `capture-not-started`, …); `detail` English
 * evidence for the host's report, shown only when the code is not one this page has a sentence for. */
export interface RenderStreamSeatRestart {
  state: "restarting" | "pending" | "refused" | "failed";
  reason: string | null;
  detail: string | null;
}

const SEAT_RESTART_REASONS: Record<RenderStreamSeatRestart["state"], RenderStreamUnavailableReason> = {
  restarting: "seat-restarting",
  pending: "seat-restart-pending",
  refused: "seat-restart-refused",
  failed: "seat-restart-failed"
};

/** The `rendererSeat` field of a host `session`, or null when absent or not understood. */
export function parseSeatRestart(raw: unknown): RenderStreamSeatRestart | null {
  if (raw === null || typeof raw !== "object") return null;
  const value = raw as { state?: unknown; reason?: unknown; detail?: unknown };
  if (typeof value.state !== "string" || !(value.state in SEAT_RESTART_REASONS)) return null;
  return {
    state: value.state as RenderStreamSeatRestart["state"],
    reason: typeof value.reason === "string" ? value.reason : null,
    detail: typeof value.detail === "string" ? value.detail : null
  };
}
export type RenderStreamEndpointSource = "qa-override" | "session";

export interface RenderStreamAvailabilityInputs {
  coreProblem: RenderStreamCoreProblem | null;
  /** The core was found but failed to load this session (a runtime `core-load-failed`). */
  coreLoadFailed: boolean;
  webgl2: boolean;
  directView: boolean;
  /** The QA endpoint (`?renderStream=`), which outranks the session's. */
  qaEndpoint: RenderStreamEndpoint | null;
  /** The descriptor in this viewer's own seat `session` envelope (MIR-3). */
  sessionEndpoint: RenderStreamEndpoint | null;
  /** Whether this page is on a loopback http origin, the only origin a host-side loopback hub can serve today. */
  pageLoopback: boolean;
  /** What the host did with a mid-session request to restart this viewer's seat as the streaming seat (MIR-4). */
  seatRestart?: RenderStreamSeatRestart | null;
}

export type RenderStreamAvailability =
  | { available: true; reason: null; endpoint: RenderStreamEndpoint; source: RenderStreamEndpointSource }
  | { available: false; reason: RenderStreamUnavailableReason; endpoint: null; source: null };

const unavailable = (reason: RenderStreamUnavailableReason): RenderStreamAvailability =>
  ({ available: false, reason, endpoint: null, source: null });

export function computeRenderStreamAvailability(inputs: RenderStreamAvailabilityInputs): RenderStreamAvailability {
  if (inputs.coreProblem !== null || inputs.coreLoadFailed) return unavailable("core-build");
  if (!inputs.webgl2) return unavailable("no-webgl2");
  if (inputs.directView) return unavailable("host-view");
  if (inputs.qaEndpoint) return { available: true, reason: null, endpoint: inputs.qaEndpoint, source: "qa-override" };
  if (inputs.sessionEndpoint) return { available: true, reason: null, endpoint: inputs.sessionEndpoint, source: "session" };
  if (!inputs.pageLoopback) return unavailable("needs-proxy");
  return unavailable(inputs.seatRestart ? SEAT_RESTART_REASONS[inputs.seatRestart.state] : "not-streaming");
}

/**
 * Whether switching the checkbox ON would ask the host to restart this viewer's seat as the streaming seat: a joined
 * seat (not the host's own game) that does not stream, on a page that could draw the stream, with no restart already
 * running or staged. A refused or failed request may be asked again.
 */
export function canRequestStreamingSeat(availability: RenderStreamAvailability, seatJoined: boolean): boolean {
  return seatJoined && (availability.reason === "not-streaming" || availability.reason === "seat-restart-refused"
    || availability.reason === "seat-restart-failed");
}

/**
 * The `?renderStream=` descriptor: the hub's origin serves the resource GETs, no token (the QA hub runs
 * `GRC_LIVE_AUTH=none` on loopback), the protocol from `?rsProtocol=`, presentation 1920×1080.
 */
export function qaRenderStreamEndpoint(settings: Pick<MirrorSettings, "renderStreamUrl" | "renderStreamProtocol">): RenderStreamEndpoint | null {
  if (!settings.renderStreamUrl) return null;
  try {
    const url = new URL(settings.renderStreamUrl);
    const origin = `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`;
    return validateEndpoint({ url: url.href, resourceBase: origin, token: null, protocol: settings.renderStreamProtocol,
      presentation: [1920, 1080] });
  } catch {
    return null;
  }
}

/** The envelope's `renderStream` field: a valid descriptor, or null (absent or unusable means "not streaming"). */
export function sessionRenderStreamEndpoint(raw: unknown): RenderStreamEndpoint | null {
  if (raw === null || raw === undefined) return null;
  try {
    return validateEndpoint(raw);
  } catch {
    return null;
  }
}

let webgl2Memo: boolean | null = null;
/** Whether this browser gives a WebGL2 context. Probed once, and the probe's context is released at once. */
export function probeWebgl2(): boolean {
  if (webgl2Memo !== null) return webgl2Memo;
  if (typeof document === "undefined" || typeof WebGL2RenderingContext === "undefined") return (webgl2Memo = false);
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    webgl2Memo = gl !== null;
  } catch {
    webgl2Memo = false;
  }
  return webgl2Memo;
}

export function isLoopbackHttpPage(location: Pick<Location, "protocol" | "hostname"> | null =
  typeof window === "undefined" ? null : window.location): boolean {
  if (!location || location.protocol !== "http:") return false;
  return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(location.hostname);
}

/**
 * The facts availability is computed from that are not settings. MirrorApp writes `directView` and
 * `sessionEndpoint`; the stage writes `coreLoadFailed` and `stopped`. `coreProblem` / `webgl2` are read from the
 * probes when left `undefined` (specs pin them).
 */
export const renderStreamContext = reactive({
  directView: false,
  sessionEndpoint: null as RenderStreamEndpoint | null,
  coreLoadFailed: false,
  /** Why the stream stopped this session ("New renderer stopped: {reason}"), or null. */
  stopped: null as string | null,
  coreProblem: undefined as RenderStreamCoreProblem | null | undefined,
  webgl2: undefined as boolean | undefined,
  pageLoopback: undefined as boolean | undefined,
  /** This viewer holds a seat of its own (joined, not the host's view): a restart can be asked for it. */
  seatJoined: false,
  /** The host session's `rendererSeat` (MirrorApp writes it). */
  seatRestart: null as RenderStreamSeatRestart | null
});

export const renderStreamAvailability = computed<RenderStreamAvailability>(() => computeRenderStreamAvailability({
  coreProblem: renderStreamContext.coreProblem === undefined ? renderStreamCoreConfig().problem : renderStreamContext.coreProblem,
  coreLoadFailed: renderStreamContext.coreLoadFailed,
  webgl2: renderStreamContext.webgl2 ?? probeWebgl2(),
  directView: renderStreamContext.directView,
  qaEndpoint: qaRenderStreamEndpoint(mirrorSettings),
  sessionEndpoint: renderStreamContext.sessionEndpoint,
  pageLoopback: renderStreamContext.pageLoopback ?? isLoopbackHttpPage(),
  seatRestart: renderStreamContext.seatRestart
}));

/** `canRequestStreamingSeat` for this page, now. */
export const streamingSeatRequestable = computed(() =>
  canRequestStreamingSeat(renderStreamAvailability.value, renderStreamContext.seatJoined));

/**
 * What a join asks the host for: `"stream"` (launch this viewer's seat as the streaming seat) when the viewer chose
 * the new renderer and THIS page could draw it — the core is here, WebGL2 works and the page is on a loopback http
 * origin a host-side hub can serve. Otherwise nothing, so a seat never pays for a stream nobody can watch. A QA
 * endpoint brings its own hub and asks for nothing either.
 */
export function joinRendererRequest(
  inputs: Pick<RenderStreamAvailabilityInputs, "coreProblem" | "coreLoadFailed" | "webgl2" | "pageLoopback" | "qaEndpoint">
    & { renderer: MirrorSettings["renderer"] }
): "stream" | undefined {
  return inputs.renderer === "stream" && inputs.coreProblem === null && !inputs.coreLoadFailed && inputs.webgl2
    && inputs.pageLoopback && inputs.qaEndpoint === null ? "stream" : undefined;
}

/** `joinRendererRequest` for this page, now. */
export function currentJoinRendererRequest(settings: MirrorSettings = mirrorSettings): "stream" | undefined {
  return joinRendererRequest({
    renderer: settings.renderer,
    coreProblem: renderStreamContext.coreProblem === undefined ? renderStreamCoreConfig().problem : renderStreamContext.coreProblem,
    coreLoadFailed: renderStreamContext.coreLoadFailed,
    webgl2: renderStreamContext.webgl2 ?? probeWebgl2(),
    pageLoopback: renderStreamContext.pageLoopback ?? isLoopbackHttpPage(),
    qaEndpoint: qaRenderStreamEndpoint(settings)
  });
}

/** The rule for the live renderer (see the header). */
export function resolveRuntimeRenderer(
  renderer: MirrorSettings["renderer"], availability: RenderStreamAvailability, stopped: string | null
): MirrorSettings["runtimeRenderer"] {
  return renderer === "stream" && availability.available && stopped === null ? "stream" : "mirror";
}

/** Re-derive `runtimeRenderer` (and the stream's protocol) after any input changed. */
export function syncRuntimeRenderer(settings: MirrorSettings = mirrorSettings): void {
  const availability = renderStreamAvailability.value;
  if (availability.available) settings.renderStreamProtocol = availability.endpoint.protocol;
  const next = resolveRuntimeRenderer(settings.renderer, availability, renderStreamContext.stopped);
  if (settings.runtimeRenderer !== next) settings.runtimeRenderer = next;
}

/** The stream stopped (failed, ended, or its descriptor went away): fall back to the old renderer for this session. */
export function stopRenderStream(reason: string, settings: MirrorSettings = mirrorSettings): void {
  renderStreamContext.stopped = reason;
  if (/^core-load-failed\b/.test(reason)) renderStreamContext.coreLoadFailed = true;
  syncRuntimeRenderer(settings);
}

/** The panel's "Try again": forget this session's stop and re-derive. */
export function retryRenderStream(settings: MirrorSettings = mirrorSettings): void {
  renderStreamContext.stopped = null;
  syncRuntimeRenderer(settings);
}
