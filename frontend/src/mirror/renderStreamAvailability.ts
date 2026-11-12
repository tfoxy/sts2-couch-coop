// "Use new renderer (Beta)" — whether it can run for this viewer, and which renderer runs now.
//
// ONE computed availability. Its reasons, in precedence order, are what
// the settings panel shows under the checkbox:
//
//   core-build     the core wasm is missing, stale or unverifiable in this (dev) build, or failed to load; which one
//                  is `renderStreamCoreCause` (a release always carries a verified core, so there only the load fails)
//   no-webgl2      this browser gives no WebGL2 context
//   host-view      watching the host's own game (`directView`), which never streams
//   needs-proxy    no carrier the seat offers can work on this page (`lanCarrierUsable` / `endpointCarrierUsable`):
//                  an https page cannot use plain ws, and WebTransport needs a secure context and the API. A
//                  plain-http LAN page runs the client (CAR9: godot-scene-web's loader hashes the core without
//                  `crypto.subtle` there) and streams over plain ws, which the seat always serves to LAN pages.
//   not-streaming  no seat descriptor: before a join, or while a joined seat is not streaming
//
// The ENDPOINT comes from the `session` envelope of this viewer's own seat (MIR-3: the host's streaming seat sends
// it to a page origin its hub allows) or, for QA, from `?renderStream=` (source `qa-override`, info only).
//
// The saved choice is requested on this viewer's seat socket after its first session, and again when changed.
// Requests use the same device and carrier checks as the checkbox (`renderStreamChoosable`). A QA endpoint
// brings its own hub and never asks the seat to stream.
//
// The live renderer (`runtimeRenderer`) is derived, never chosen: `stream` exactly while this page chooses it,
// the seat streams (or a QA endpoint is provided), the feature is available, and the stream
// has not stopped this session. A stopped stream falls back to the old renderer with a status line, and the saved
// choice stays — the canvas stage's `stage` / `runtimeStage` / `stageFailure` contract.

import { computed, reactive } from "vue";

import { validateEndpoint, type RenderStreamEndpoint } from "@godot-scene-web/render-stream-client";

import type { BrowserRendererState } from "@/protocol/browserEnvelope";

import { mirrorDesignSize } from "@/mirror/mirrorDesign";
import { mirrorSettings, type MirrorSettings } from "@/mirror/mirrorSettings";
import { renderStreamCoreConfig, type RenderStreamCoreProblem } from "@/mirror/renderStreamCore";

/** After this long in a hidden tab the stage disposes its client (its heap, and the hub's carried set for us, are
 * freed); a visible tab then reconnects as a fresh join. */
export const RENDER_STREAM_HIDDEN_DISPOSE_MS = 60_000;

/** How long the stage's JS chunk may take before the page falls back to the old renderer. One chunk from the host's
 * own server over phone Wi-Fi: 15 s covers a very slow link and still leaves about half of the host's 30 s
 * slow-view window (ConnectionRegistry.NoticeSlowView) for the fallback's first frame. */
export const RENDER_STREAM_STAGE_LOAD_TIMEOUT_MS = 15_000;

export type RenderStreamUnavailableReason = "core-build" | "no-webgl2" | "host-view" | "needs-proxy"
  | "not-streaming";

export type RenderStreamEndpointSource = "qa-override" | "session";

/** The host session's `renderStreamLan` (CAR7b): what its streaming seat offers a LAN page. Absent: the host has no
 * capture, so no seat of it streams. */
export interface RenderStreamLanOffer {
  /** The seat serves WebTransport (self-signed, pinned by hash: any secure-context page). */
  webTransport: boolean;
  /** The seat serves wss with a host certificate that names this page's host. */
  tls: boolean;
  /** The seat serves plain ws to LAN pages (always, beside wss when the host has a certificate). */
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
  /** The core was found but failed to load this session (a runtime `core-load-failed`, except a timeout). */
  coreLoadFailed: boolean;
  webgl2: boolean;
  directView: boolean;
  /** The QA endpoint (`?renderStream=`), which outranks the session's. */
  qaEndpoint: RenderStreamEndpoint | null;
  /** The descriptor in this viewer's own seat `session` envelope (MIR-3). */
  sessionEndpoint: RenderStreamEndpoint | null;
  /** Whether this page is on a loopback http origin, which a streaming seat always serves. */
  pageLoopback: boolean;
  /** The host's LAN offer (CAR7b), null when the host has no capture. Defaults to null. */
  lanOffer?: RenderStreamLanOffer | null;
  /** What this page can open. Defaults to a loopback http page's facts. */
  page?: RenderStreamPageFacts;
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
  if (!inputs.pageLoopback && inputs.lanOffer && !lanCarrierUsable(inputs.lanOffer, page)) return unavailable("needs-proxy");
  return unavailable("not-streaming");
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
  rendererState: null as BrowserRendererState | null,
  firstFrame: false,
  /** An explicit switch off takes effect while the seat withdraws its descriptor. */
  returningToMirror: false,
  retryRequest: 0,
  coreLoadFailed: false,
  /** Why the stream stopped this session ("New renderer stopped: {reason}"), or null. */
  stopped: null as string | null,
  coreProblem: undefined as RenderStreamCoreProblem | null | undefined,
  webgl2: undefined as boolean | undefined,
  pageLoopback: undefined as boolean | undefined,
  /** This viewer holds a seat of its own (joined, not the host's view): the page follows that seat's renderer. */
  seatJoined: false,
  /** The host session's `renderStreamLan` (MirrorApp writes it): null when the host has no capture. */
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
  lanOffer: renderStreamContext.lanOffer,
  page: renderStreamContext.page ?? probePageFacts()
}));

/**
 * What this page asks its seat for: `"stream"` when the viewer chose the new renderer and THIS page could draw it —
 * the core is here, WebGL2 works, and the page is the host's loopback http page or a LAN page with a usable carrier
 * in the host's LAN offer. Otherwise nothing, so a seat never
 * pays for a stream nobody can watch. A QA endpoint brings its own hub and asks for nothing either.
 */
export function seatRendererRequest(
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

/** `seatRendererRequest` for this page, now. */
export function currentSeatRendererRequest(settings: MirrorSettings = mirrorSettings): "stream" | undefined {
  return currentSeatRendererRequestFor(settings.renderer, settings);
}

/** Check an explicit renderer request against this page's capabilities, independently of its saved choice. */
export function currentSeatRendererRequestFor(renderer: MirrorSettings["renderer"],
  settings: Pick<MirrorSettings, "renderStreamUrl" | "renderStreamProtocol">): "stream" | undefined {
  return seatRendererRequest({
    renderer,
    coreProblem: renderStreamContext.coreProblem === undefined ? renderStreamCoreConfig().problem : renderStreamContext.coreProblem,
    coreLoadFailed: renderStreamContext.coreLoadFailed,
    webgl2: renderStreamContext.webgl2 ?? probeWebgl2(),
    pageLoopback: renderStreamContext.pageLoopback ?? isLoopbackHttpPage(),
    qaEndpoint: qaRenderStreamEndpoint(settings),
    lanOffer: renderStreamContext.lanOffer,
    page: renderStreamContext.page ?? probePageFacts()
  });
}

/**
 * Whether the checkbox can be switched ON for this page: the seat request would then ask for the stream
 * (`seatRendererRequest` with the choice on), or a QA endpoint brings its own. Not on the host's own view.
 */
export const renderStreamChoosable = computed(() => !renderStreamContext.directView
  && (renderStreamAvailability.value.source === "qa-override"
    || currentSeatRendererRequestFor("stream", mirrorSettings) === "stream"));

/** The mirror frame's width and height in CSS pixels. */
export interface StreamBoxSize { width: number; height: number }

/** Measure the mirror's containing surface even before either renderer mounts. Its padding resolves the same
 * safe-area variables used as the mirror frame's insets, independently of the current padding preference. */
export function measureStreamBox(
  settings: Pick<MirrorSettings, "safeAreaPaddingEnabled"> = mirrorSettings
): StreamBoxSize {
  const surface = typeof document === "undefined" ? null : document.querySelector(".mirror-surface");
  if (surface) {
    const { width, height } = surface.getBoundingClientRect();
    if (width > 0 && height > 0) {
      if (!settings.safeAreaPaddingEnabled) return { width, height };
      const style = window.getComputedStyle(surface);
      const px = (value: string) => Number.parseFloat(value) || 0;
      return {
        width: width - px(style.paddingLeft) - px(style.paddingRight),
        height: height - px(style.paddingTop) - px(style.paddingBottom)
      };
    }
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Ask for the mirror's design aspect, using its current frame and stretch rule. Stretch off (or an unmeasurable
 * frame) sends none, which is 1920x1080. A later rotation or resize letterboxes the seat's fixed presentation
 * into the new frame until the stream's next start.
 */
export function streamSeatAspect(
  settings: Pick<MirrorSettings, "stretchEnabled" | "safeAreaPaddingEnabled"> = mirrorSettings,
  measure: () => StreamBoxSize = () => measureStreamBox(settings)
): number | undefined {
  if (!settings.stretchEnabled) return undefined;
  const { width, height } = measure();
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  const design = mirrorDesignSize(width, height, settings.stretchEnabled);
  return design.w / design.h;
}

/** A shared seat's descriptor supplies an endpoint; this page's saved choice decides whether to use it. */
export function resolveRuntimeRenderer(
  renderer: MirrorSettings["renderer"], availability: RenderStreamAvailability, stopped: string | null
): MirrorSettings["runtimeRenderer"] {
  return renderer === "stream" && availability.available && stopped === null ? "stream" : "mirror";
}

/** Re-derive `runtimeRenderer` (and the stream's protocol) after any input changed. */
export function syncRuntimeRenderer(settings: MirrorSettings = mirrorSettings): void {
  const availability = renderStreamAvailability.value;
  if (availability.available) settings.renderStreamProtocol = availability.endpoint.protocol;
  const next = renderStreamContext.returningToMirror ? "mirror"
    : resolveRuntimeRenderer(settings.renderer, availability, renderStreamContext.stopped);
  if (settings.runtimeRenderer !== next) settings.runtimeRenderer = next;
}

/** The stream stopped (failed, ended, or its descriptor went away): fall back to the old renderer for this session. */
export function stopRenderStream(reason: string, settings: MirrorSettings = mirrorSettings): void {
  renderStreamContext.stopped = reason;
  // A load that timed out (`core-load-failed: timeout after <ms> ms in <steps>`) only stops this attempt: a slow
  // phone loads the core in about a second, so the 30 s deadline means a passing network or server stall, and
  // "Try again" should load it again. Any other load failure (a stale core, say) holds for the session.
  if (/^core-load-failed\b(?!: timeout\b)/.test(reason)) renderStreamContext.coreLoadFailed = true;
  syncRuntimeRenderer(settings);
}

/** The panel's "Try again": clear the stop, request the seat again, and re-derive. */
export function retryRenderStream(settings: MirrorSettings = mirrorSettings): void {
  if (settings.renderer !== "stream") return;
  renderStreamContext.stopped = null;
  if (renderStreamContext.rendererState?.state === "failed") renderStreamContext.rendererState = null;
  renderStreamContext.retryRequest += 1;
  syncRuntimeRenderer(settings);
}
