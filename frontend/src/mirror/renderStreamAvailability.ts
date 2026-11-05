// "Use new renderer (Beta)" — whether it can run for this viewer, and which renderer runs now.
//
// ONE computed availability (handoff-mirror-new-renderer.md §3 Q3). Its reasons, in precedence order, are what
// the settings panel shows under the checkbox:
//
//   core-build     the core wasm is missing, stale or unverifiable in this (dev) build, or failed to load; which one
//                  is `renderStreamCoreCause` (a release always carries a verified core, so there only the load fails)
//   no-webgl2      this browser gives no WebGL2 context
//   host-view      watching the host's own game (`directView`), which never streams
//   lan-off        a page that is not the host's loopback page, on a host whose "Stream the new renderer over the LAN"
//                  setting is off (the host session carries no `renderStreamLan` offer)
//   needs-proxy    no carrier the seat offers can work on this page (`lanCarrierUsable` / `endpointCarrierUsable`):
//                  an https page cannot use plain ws, WebTransport needs a secure context and the API, and a host
//                  with a certificate refuses plain ws from the LAN. A plain-http LAN page runs the client (CAR9:
//                  godot-scene-web's loader hashes the core without `crypto.subtle` there) and streams over ws.
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

export type RenderStreamUnavailableReason = "core-build" | "no-webgl2" | "host-view" | "lan-off" | "needs-proxy"
  | "not-streaming"
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

/** The host session's `renderStreamLan` (CAR7b): what its streaming seat offers a LAN page. Absent: the setting is off. */
export interface RenderStreamLanOffer {
  /** The seat serves WebTransport (self-signed, pinned by hash: any secure-context page). */
  webTransport: boolean;
  /** The seat serves wss with a host certificate that names this page's host. */
  tls: boolean;
  /** The seat serves plain ws to LAN pages: the host has no certificate (with one, the hub refuses LAN plaintext). */
  ws: boolean;
}

/**
 * The `renderStreamLan` field of a host `session`, or null when absent or not understood. A host from before CAR9
 * sends no `ws`; its `tls: false` then meant plain ws.
 */
export function parseLanOffer(raw: unknown): RenderStreamLanOffer | null {
  if (raw === null || typeof raw !== "object") return null;
  const value = raw as { webTransport?: unknown; tls?: unknown; ws?: unknown };
  if (typeof value.webTransport !== "boolean" || typeof value.tls !== "boolean") return null;
  if (value.ws !== undefined && typeof value.ws !== "boolean") return null;
  return { webTransport: value.webTransport, tls: value.tls, ws: value.ws ?? !value.tls };
}

/** What this page can open: the facts the carrier matrix needs. */
export interface RenderStreamPageFacts {
  /** An https page: it cannot open plain ws (mixed content); an http page can open both ws and wss. */
  https: boolean;
  /** `isSecureContext`: https, or http on loopback. WebTransport needs it. */
  secureContext: boolean;
  /** `globalThis.WebTransport` exists. */
  webTransport: boolean;
}

/**
 * Whether a LAN offer has a carrier this page can use: WebTransport on a secure-context page with WebTransport; wss
 * whenever the seat has a certificate naming this page's host (an http page may open wss; whether the device trusts
 * that certificate is not knowable here); plain ws only from an http page, and only when the seat has no certificate
 * (with one it refuses plaintext from the LAN). Any page runs the client, a plain-http one included (CAR9).
 */
export function lanCarrierUsable(offer: RenderStreamLanOffer, page: RenderStreamPageFacts): boolean {
  return (offer.webTransport && page.secureContext && page.webTransport) || offer.tls || (offer.ws && !page.https);
}

/** The same question for a descriptor the seat sent: its WebTransport member, or its socket url's scheme. */
export function endpointCarrierUsable(endpoint: RenderStreamEndpoint, page: RenderStreamPageFacts): boolean {
  if (endpoint.webTransport && page.secureContext && page.webTransport) return true;
  return /^wss:/i.test(endpoint.url) || !page.https;
}

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
  /** Whether this page is on a loopback http origin, which a streaming seat always serves. */
  pageLoopback: boolean;
  /** The host's LAN offer (CAR7b), null while its setting is off. Defaults to null. */
  lanOffer?: RenderStreamLanOffer | null;
  /** What this page can open. Defaults to a loopback http page's facts. */
  page?: RenderStreamPageFacts;
  /** What the host did with a mid-session request to restart this viewer's seat as the streaming seat (MIR-4). */
  seatRestart?: RenderStreamSeatRestart | null;
}

export type RenderStreamAvailability =
  | { available: true; reason: null; endpoint: RenderStreamEndpoint; source: RenderStreamEndpointSource }
  | { available: false; reason: RenderStreamUnavailableReason; endpoint: null; source: null };

/** A loopback http page: a secure context; WebTransport assumed present (the descriptor decides). */
const LOOPBACK_PAGE: RenderStreamPageFacts = { https: false, secureContext: true, webTransport: true };

const unavailable = (reason: RenderStreamUnavailableReason): RenderStreamAvailability =>
  ({ available: false, reason, endpoint: null, source: null });

export function computeRenderStreamAvailability(inputs: RenderStreamAvailabilityInputs): RenderStreamAvailability {
  if (inputs.coreProblem !== null || inputs.coreLoadFailed) return unavailable("core-build");
  if (!inputs.webgl2) return unavailable("no-webgl2");
  if (inputs.directView) return unavailable("host-view");
  if (inputs.qaEndpoint) return { available: true, reason: null, endpoint: inputs.qaEndpoint, source: "qa-override" };
  // A loopback http page is a secure context by definition, whatever a probe (or jsdom) reports.
  const page = inputs.pageLoopback ? { ...(inputs.page ?? LOOPBACK_PAGE), secureContext: true } : inputs.page ?? LOOPBACK_PAGE;
  if (inputs.sessionEndpoint) {
    return endpointCarrierUsable(inputs.sessionEndpoint, page)
      ? { available: true, reason: null, endpoint: inputs.sessionEndpoint, source: "session" }
      : unavailable("needs-proxy");
  }
  if (!inputs.pageLoopback) {
    if (!inputs.lanOffer) return unavailable("lan-off");
    if (!lanCarrierUsable(inputs.lanOffer, page)) return unavailable("needs-proxy");
  }
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

/** This page's carrier facts, read from the browser. */
export function probePageFacts(): RenderStreamPageFacts {
  if (typeof window === "undefined") return LOOPBACK_PAGE;
  return {
    https: window.location.protocol === "https:",
    secureContext: window.isSecureContext === true,
    webTransport: typeof (globalThis as { WebTransport?: unknown }).WebTransport === "function"
  };
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
  seatRestart: null as RenderStreamSeatRestart | null,
  /** The host session's `renderStreamLan` (MirrorApp writes it): null while the host's LAN setting is off. */
  lanOffer: null as RenderStreamLanOffer | null,
  /** This page's carrier facts; read from the browser when left `undefined` (specs pin them). */
  page: undefined as RenderStreamPageFacts | undefined
});

/** Why the reason is `core-build`: the build's problem with the core, or a load that failed this session. */
export type RenderStreamCoreCause = RenderStreamCoreProblem | "load-failed";

/** `core-build`'s cause, or null when the core is usable. The build's own problem outranks a load failure. */
export function coreBuildCause(coreProblem: RenderStreamCoreProblem | null, coreLoadFailed: boolean): RenderStreamCoreCause | null {
  return coreProblem ?? (coreLoadFailed ? "load-failed" : null);
}

/** `coreBuildCause` for this page, now. */
export const renderStreamCoreCause = computed<RenderStreamCoreCause | null>(() => coreBuildCause(
  renderStreamContext.coreProblem === undefined ? renderStreamCoreConfig().problem : renderStreamContext.coreProblem,
  renderStreamContext.coreLoadFailed));

export const renderStreamAvailability = computed<RenderStreamAvailability>(() => computeRenderStreamAvailability({
  coreProblem: renderStreamContext.coreProblem === undefined ? renderStreamCoreConfig().problem : renderStreamContext.coreProblem,
  coreLoadFailed: renderStreamContext.coreLoadFailed,
  webgl2: renderStreamContext.webgl2 ?? probeWebgl2(),
  directView: renderStreamContext.directView,
  qaEndpoint: qaRenderStreamEndpoint(mirrorSettings),
  sessionEndpoint: renderStreamContext.sessionEndpoint,
  pageLoopback: renderStreamContext.pageLoopback ?? isLoopbackHttpPage(),
  seatRestart: renderStreamContext.seatRestart,
  lanOffer: renderStreamContext.lanOffer,
  page: renderStreamContext.page ?? probePageFacts()
}));

/** `canRequestStreamingSeat` for this page, now. */
export const streamingSeatRequestable = computed(() =>
  canRequestStreamingSeat(renderStreamAvailability.value, renderStreamContext.seatJoined));

/**
 * What a join asks the host for: `"stream"` (launch this viewer's seat as the streaming seat) when the viewer chose
 * the new renderer and THIS page could draw it — the core is here, WebGL2 works, and the page is the host's loopback
 * http page or a LAN page with a usable carrier in the host's LAN offer (CAR7b). Otherwise nothing, so a seat never
 * pays for a stream nobody can watch. A QA endpoint brings its own hub and asks for nothing either.
 */
export function joinRendererRequest(
  inputs: Pick<RenderStreamAvailabilityInputs, "coreProblem" | "coreLoadFailed" | "webgl2" | "pageLoopback" | "qaEndpoint"
    | "lanOffer" | "page">
    & { renderer: MirrorSettings["renderer"] }
): "stream" | undefined {
  const page = inputs.page ?? LOOPBACK_PAGE;
  const reachable = inputs.pageLoopback
    || (inputs.lanOffer != null && lanCarrierUsable(inputs.lanOffer, page));
  return inputs.renderer === "stream" && inputs.coreProblem === null && !inputs.coreLoadFailed && inputs.webgl2
    && reachable && inputs.qaEndpoint === null ? "stream" : undefined;
}

/** `joinRendererRequest` for this page, now. */
export function currentJoinRendererRequest(settings: MirrorSettings = mirrorSettings): "stream" | undefined {
  return joinRendererRequest({
    renderer: settings.renderer,
    coreProblem: renderStreamContext.coreProblem === undefined ? renderStreamCoreConfig().problem : renderStreamContext.coreProblem,
    coreLoadFailed: renderStreamContext.coreLoadFailed,
    webgl2: renderStreamContext.webgl2 ?? probeWebgl2(),
    pageLoopback: renderStreamContext.pageLoopback ?? isLoopbackHttpPage(),
    qaEndpoint: qaRenderStreamEndpoint(settings),
    lanOffer: renderStreamContext.lanOffer,
    page: renderStreamContext.page ?? probePageFacts()
  });
}

/** The box whose aspect `streamSeatAspect` reports: width and height in CSS pixels. */
export interface StreamBoxSize { width: number; height: number }

/** The box the stream stage is shown in: the mounted stage's frame, else the window (the stage mounts only once the
 * seat streams, so a request to start streaming usually measures the window). */
export function measureStreamBox(): StreamBoxSize {
  const stage = typeof document === "undefined" ? null : document.querySelector('[data-testid="render-stream-stage"]');
  if (stage) {
    const rect = stage.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return { width: rect.width, height: rect.height };
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * The `aspect` (width / height of the stream box) that rides this page's request for a streaming seat — the join's
 * `renderer: "stream"` and `set-renderer` — so the host launches the seat at that width (PRES-A: the game lays itself
 * out at `presentation:<W>x1080`, W = clamp(round(1080 * aspect), 1920, the host's cap)). Only with Widescreen stretch
 * on; off (or an unmeasurable box) sends none, which is 1920x1080.
 *
 * READ ONCE, when the seat is asked for. A later rotation or resize does NOT restart the seat: the stage letterboxes
 * the stream into the new box until the seat's next start (re-launching on a changed aspect is PRES-R).
 */
export function streamSeatAspect(
  settings: Pick<MirrorSettings, "stretchEnabled"> = mirrorSettings,
  measure: () => StreamBoxSize = measureStreamBox
): number | undefined {
  if (!settings.stretchEnabled) return undefined;
  const { width, height } = measure();
  const aspect = width / height;
  return Number.isFinite(aspect) && aspect > 0 ? aspect : undefined;
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
