// Bench-only response witness. Neither an unrelated scene update nor a ping is an input response.
export function responseMatches(message, targetId) {
  return message?.type === "scene-delta" &&
    message.upserts?.some(node => node.id === targetId && node.zIndex === 1) === true;
}

export function percentiles(values) {
  if (!values.length || values.some(v => !Number.isFinite(v) || v < 0)) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { count: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), worst: sorted.at(-1) };
}

// A CDP browser may have an empty default context plus one context per joined seat.
// Refuse an ambiguous URL so a multi-seat run cannot quietly measure a different player.
export function selectCdpPage(contexts, url, pageIndex = null) {
  const matches = contexts.flatMap(context => context.pages()
    .filter(page => page.url().startsWith(url))
    .map(page => ({ context, page })));
  if (pageIndex !== null && (!Number.isInteger(pageIndex) || pageIndex < 0))
    throw new Error("--page-index must be a nonnegative integer");
  if (matches.length === 0) throw new Error("no owned page matches COUCHCOOP_VALIDATE_URL");
  if (pageIndex === null && matches.length !== 1)
    throw new Error(`${matches.length} pages match COUCHCOOP_VALIDATE_URL; set --page-index`);
  if (pageIndex !== null && pageIndex >= matches.length)
    throw new Error(`--page-index ${pageIndex} is outside ${matches.length} matching pages`);
  return matches[pageIndex ?? 0];
}

export const POINTER_TRACE_PREFIX = "couchcoop-input-pointer:";
export const RESPONSE_TRACE_PREFIX = "couchcoop-response-paint:";
export const USER_IDLE_BOUNDARY_MS = 1500;

export function pointerTraceName(id) {
  return `${POINTER_TRACE_PREFIX}${id}`;
}

export function responseTraceName(id) {
  return `${RESPONSE_TRACE_PREFIX}${id}`;
}

// A 32-bit barcode in a tiny bench-only overlay identifies the response in the actual screencast PNG.
// Eight sync bits, sixteen sample bits, eight check bits. No clocks/DOM mutations are used as pixels.
export function markerWord(id) {
  if (!Number.isInteger(id) || id < 1 || id > 65535) throw new Error("invalid witness id");
  return (0xa5000000 | id << 8 | ((id >>> 8) ^ (id & 255) ^ 0x5a)) >>> 0;
}

export function readMarker({ width, height, pixels }) {
  if (width < 128 || height < 8) return null;
  let word = 0;
  for (let bit = 0; bit < 32; bit++) {
    const offset = (4 * width + bit * 4 + 2) * 4;
    const [r, g, b] = pixels.subarray(offset, offset + 3);
    const light = r > 245 && g > 245 && b > 245;
    const dark = r < 10 && g < 10 && b < 10;
    if (!light && !dark) return null;
    word = (word * 2 + Number(light)) >>> 0;
  }
  const id = (word >>> 8) & 65535;
  return id && word === markerWord(id) ? id : null;
}

export function qualifyCausalChain(sample, frame) {
  const { pointerAt, pointerHandlerAt, pointerEventTimestampMs, pointerEventTimeOriginMs,
    sentAt, responseAt, drawnAt, requestId, targetId, inputCount,
    inputSocketId, inputSocketUrl, responseSocketId, responseSocketUrl } = sample;
  const times = [pointerAt, pointerHandlerAt, sentAt, responseAt, drawnAt, frame?.timestampMs];
  if (!requestId || !targetId || inputCount !== 1 || frame?.id !== sample.id ||
      !Number.isInteger(inputSocketId) || inputSocketId < 1 || inputSocketId !== responseSocketId ||
      typeof inputSocketUrl !== "string" || inputSocketUrl !== responseSocketUrl ||
      !Number.isFinite(pointerEventTimestampMs) || pointerEventTimestampMs < 0 ||
      !Number.isFinite(pointerEventTimeOriginMs) ||
      pointerAt !== pointerEventTimeOriginMs + pointerEventTimestampMs ||
      times.some(t => !Number.isFinite(t)) || times.some((t, i) => i > 0 && t < times[i - 1])) {
    return { valid: false, reason: "missing, ambiguous, or out-of-order causal evidence" };
  }
  if (!["dom-style-mutation", "canvas-webgl-submit"].includes(sample.witnessSource)) {
    return { valid: false, reason: "response was not witnessed at a backend pre-paint boundary" };
  }
  const population = sample.firstReturn ? "first-after-return" :
    sample.id === 1 ? "first-input" : sample.idleMs > 0 ? "first-after-idle" : "active";
  const previousSeatInputAt = sample.previousSeatInputAt;
  const observedUserIdleGapMs = Number.isFinite(previousSeatInputAt) ?
    pointerAt - previousSeatInputAt : null;
  if (population === "active" || population === "first-after-idle") {
    const resolution = sample.clockResolutionMs;
    const clockErrorMs = Number.isFinite(resolution) ? 2 * (3 * resolution + .001) : NaN;
    if (!Number.isFinite(observedUserIdleGapMs) || observedUserIdleGapMs < 0 ||
        !Number.isFinite(clockErrorMs) ||
        (population === "active" && observedUserIdleGapMs + clockErrorMs >= USER_IDLE_BOUNDARY_MS) ||
        (population === "first-after-idle" &&
          (!Number.isFinite(sample.idleMs) || observedUserIdleGapMs - clockErrorMs < sample.idleMs))) {
      return { valid: false, reason: "observed measured-seat input gap does not qualify the planned active/idle population" };
    }
  }
  return { valid: true, population, observedUserIdleGapMs,
    userIdleBoundaryMs: USER_IDLE_BOUNDARY_MS,
    eventQueueDelayMs: pointerHandlerAt - pointerAt,
    inputToResponseMs: responseAt - pointerAt,
    inputToDrawnMs: drawnAt - pointerAt, inputToPngConsumerMs: frame.timestampMs - pointerAt };
}

function traceMessage(event) {
  return event?.args?.data?.message ?? event?.args?.data?.name ?? null;
}

function sameTraceLane(a, b) {
  return a.pid === b.pid && a.tid === b.tid && a.id2?.local === b.id2?.local;
}

// A response marker at the renderer pre-paint boundary is nested in one AnimationFrame interval.
// Chrome's matching Presentation event carries compositor feedback for that frame. Screencast's
// metadata timestamp is a later video-consumer clock in Chrome 147, so its barcode only proves
// persistence; it cannot calibrate or identify the first presented frame.
export function associateFirstPresentation(sample, frame, events) {
  const clockResolutionMs = sample.clockResolutionMs;
  if (![0.1, 0.005].includes(clockResolutionMs))
    return { valid: false, reason: "unknown browser performance clock resolution" };
  // Chrome 147 clamps both the monotonic time and origin for performance.now/event.timeStamp,
  // and separately clamps performance.timeOrigin. Each epoch-valued JS clock reading can
  // therefore differ from the underlying time by up to 3 resolution quanta.
  const epochClockErrorMs = 3 * clockResolutionMs + .001;
  const bracket = (before, after) => Number.isFinite(before) && Number.isFinite(after) &&
    before <= after && after - before <= 2;
  if (!bracket(sample.pointerMarkBeforeMs, sample.pointerMarkAfterMs) ||
      !bracket(sample.responseMarkBeforeMs, sample.responseMarkAfterMs)) {
    return { valid: false, reason: "missing or wide trace marker clock bracket" };
  }
  const one = (name) => events.filter(event => event.name === "TimeStamp" && traceMessage(event) === name);
  const pointers = one(pointerTraceName(sample.id));
  const responses = one(responseTraceName(sample.id));
  if (pointers.length !== 1 || responses.length !== 1) {
    return { valid: false, reason: "missing or duplicate trace marker" };
  }
  const pointer = pointers[0], response = responses[0];
  if (!Number.isFinite(pointer.ts) || !Number.isFinite(response.ts) ||
      pointer.pid !== response.pid || pointer.tid !== response.tid || pointer.ts > response.ts) {
    return { valid: false, reason: "trace markers are on different lanes or out of order" };
  }
  const markerDeltaMs = (response.ts - pointer.ts) / 1000;
  const markerDeltaLowerMs = sample.responseMarkBeforeMs - sample.pointerMarkAfterMs;
  const markerDeltaUpperMs = sample.responseMarkAfterMs - sample.pointerMarkBeforeMs;
  if (markerDeltaMs < markerDeltaLowerMs - 2 * epochClockErrorMs ||
      markerDeltaMs > markerDeltaUpperMs + 2 * epochClockErrorMs) {
    return { valid: false, reason: "performance and trace clocks disagree across markers" };
  }

  const timeline = events
    .filter(event => event.name === "AnimationFrame" && event.pid === response.pid && event.tid === response.tid)
    .sort((a, b) => a.ts - b.ts);
  const stack = [];
  const intervals = [];
  for (const event of timeline) {
    if (event.ph === "b") {
      stack.push(event);
    } else if (event.ph === "e") {
      const index = stack.findLastIndex(begin => sameTraceLane(begin, event));
      if (index < 0) continue;
      const begin = stack.splice(index, 1)[0];
      if (Number.isFinite(begin.ts) && Number.isFinite(event.ts) &&
          begin.ts <= response.ts && response.ts <= event.ts) intervals.push({ begin, end: event });
    }
  }
  if (intervals.length !== 1 || typeof intervals[0].begin.args?.id !== "string") {
    return { valid: false, reason: "response marker does not identify exactly one animation frame" };
  }
  const interval = intervals[0];
  const presentations = events.filter(event =>
    event.name === "AnimationFrame::Presentation" && event.pid === response.pid &&
    event.tid === response.tid && event.args?.id === interval.begin.args.id && event.ts >= response.ts);
  if (presentations.length !== 1) {
    return { valid: false, reason: "response animation frame has no unique presentation" };
  }
  const presentation = presentations[0];
  const beginFrame = interval.begin.args?.animation_frame_timing_info?.begin_frame_id;
  const presentedFrame = presentation.args?.begin_frame_id;
  const frameIdIsReal = id => Number.isSafeInteger(id?.source_id) && id.source_id > 0 &&
    Number.isSafeInteger(id?.sequence_number) && id.sequence_number > 0;
  if (!Number.isFinite(presentation.ts) || presentation.ts <= response.ts ||
      !frameIdIsReal(beginFrame) || !frameIdIsReal(presentedFrame) ||
      beginFrame.source_id !== presentedFrame.source_id ||
      presentedFrame.sequence_number < beginFrame.sequence_number) {
    return { valid: false, reason: "response frame lacks real ordered presentation feedback" };
  }
  const deltaMs = (presentation.ts - response.ts) / 1000;
  const lower = sample.responseMarkBeforeMs + deltaMs - sample.pointerAt - 2 * epochClockErrorMs;
  const upper = sample.responseMarkAfterMs + deltaMs - sample.pointerAt + 2 * epochClockErrorMs;
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower < 0 || upper < lower) {
    return { valid: false, reason: "presentation clock bounds are invalid" };
  }
  return {
    valid: true,
    presentationTraceTsUs: presentation.ts,
    responseTraceTsUs: response.ts,
    traceFrameId: interval.begin.args.id,
    traceBeginFrameId: beginFrame,
    tracePresentedFrameId: presentedFrame,
    inputToPresentedLowerMs: lower,
    inputToPresentedUpperMs: upper,
    presentationClockUncertaintyMs: upper - lower,
    performanceClockResolutionMs: clockResolutionMs,
    performanceEpochClockErrorBoundMs: epochClockErrorMs,
    pngConsumerOffsetFromPresentationMs: frame.timestampMs -
      (sample.responseMarkAfterMs + deltaMs),
  };
}

export function qualifySample(sample, frame, events) {
  const causal = qualifyCausalChain(sample, frame);
  if (!causal.valid) return causal;
  const presented = associateFirstPresentation(sample, frame, events);
  if (!presented.valid) return presented;
  return { ...causal, ...presented, valid: true,
    inputToPresentedMs: (presented.inputToPresentedLowerMs + presented.inputToPresentedUpperMs) / 2 };
}
