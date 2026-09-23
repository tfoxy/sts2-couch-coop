import test from "node:test";
import assert from "node:assert/strict";
import {
  associateFirstPresentation,
  markerWord,
  percentiles,
  pointerTraceName,
  qualifyCausalChain,
  qualifySample,
  readMarker,
  responseMatches,
  responseTraceName,
  selectCdpPage,
} from "./input-response-latency.mjs";

test("CDP page selection finds joined seats across contexts and refuses ambiguity", () => {
  const makePage = url => ({ url: () => url });
  const empty = { pages: () => [] };
  const seat1 = makePage("http://127.0.0.1:13357/");
  const seat2 = makePage("http://127.0.0.1:13357/");
  const first = { pages: () => [seat1] };
  const second = { pages: () => [seat2] };
  assert.deepEqual(selectCdpPage([empty, first], "http://127.0.0.1:13357/"), { context: first, page: seat1 });
  assert.throws(() => selectCdpPage([empty, first, second], "http://127.0.0.1:13357/"), /2 pages match/);
  assert.deepEqual(selectCdpPage([empty, first, second], "http://127.0.0.1:13357/", 1),
    { context: second, page: seat2 });
  assert.throws(() => selectCdpPage([empty, first], "http://127.0.0.1:13357/", 1), /outside/);
  assert.throws(() => selectCdpPage([empty], "http://127.0.0.1:13357/"), /no owned page/);
});

function traceFor(id = 1) {
  return [
    { name: "TimeStamp", ph: "I", pid: 7, tid: 8, ts: 100_000, args: { data: { message: pointerTraceName(id) } } },
    { name: "AnimationFrame", ph: "b", pid: 7, tid: 8, ts: 105_000, id2: { local: "0x2" },
      args: { id: "frame-a", animation_frame_timing_info: { begin_frame_id: { source_id: 9, sequence_number: 40 } } } },
    { name: "TimeStamp", ph: "I", pid: 7, tid: 8, ts: 110_000, args: { data: { message: responseTraceName(id) } } },
    { name: "AnimationFrame", ph: "e", pid: 7, tid: 8, ts: 112_000, id2: { local: "0x2" }, args: {} },
    { name: "AnimationFrame::Presentation", ph: "n", pid: 7, tid: 8, ts: 116_000,
      id2: { local: "0x2" }, args: { id: "frame-a", begin_frame_id: { source_id: 9, sequence_number: 42 } } },
  ];
}

test("only the expected authoritative node change qualifies", () => {
  for (const message of [{ type: "pong" }, { type: "scene-delta", upserts: [{ id: "other", zIndex: 1 }] },
    { type: "scene-delta", upserts: [{ id: "target", transform: [1, 0, 0, 1, 2, 3] }] }]) {
    assert.equal(responseMatches(message, "target"), false);
  }
  assert.equal(responseMatches({ type: "scene-delta", upserts: [{ id: "target", zIndex: 1 }] }, "target"), true);
});

test("presented witness is decoded from pixels with sync and check bits", () => {
  const pixels = new Uint8Array(128 * 8 * 4);
  for (const id of [1, 255, 256, 65535]) {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 128; x++) {
      const value = (markerWord(id) >>> (31 - Math.floor(x / 4))) & 1 ? 255 : 0;
      pixels.set([value, value, value, 255], (y * 128 + x) * 4);
    }
    assert.equal(readMarker({ width: 128, height: 8, pixels }), id);
    pixels[4 * (4 * 128 + 126)] = 100;
    assert.equal(readMarker({ width: 128, height: 8, pixels }), null);
  }
});

test("missing frame, early frame, duplicate input, and stale witness cannot pass", () => {
  const sample = { id: 1, targetId: "node", requestId: "input:3", inputCount: 1,
    pointerAt: 100, pointerHandlerAt: 100.5, pointerEventTimestampMs: 10,
    pointerEventTimeOriginMs: 90, sentAt: 101, responseAt: 110, drawnAt: 112, witnessSource: "dom-style-mutation",
    inputSocketId: 2, responseSocketId: 2, inputSocketUrl: "ws://seat/ws", responseSocketUrl: "ws://seat/ws",
    clockResolutionMs: .1,
    pointerMarkBeforeMs: 99.9, pointerMarkAfterMs: 100.1,
    responseMarkBeforeMs: 109.9, responseMarkAfterMs: 110.1 };
  const qualified = qualifySample(sample, { id: 1, timestampMs: 140 }, traceFor());
  assert.equal(qualified.inputToPresentedMs, 16);
  assert.ok(qualified.inputToPresentedLowerMs <= 16 && qualified.inputToPresentedUpperMs >= 16);
  assert.equal(qualified.eventQueueDelayMs, .5);
  for (const frame of [null, { id: 2, timestampMs: 116 }, { id: 1, timestampMs: 111 }])
    assert.equal(qualifyCausalChain(sample, frame).valid, false);
  assert.equal(qualifyCausalChain({ ...sample, inputCount: 2 }, { id: 1, timestampMs: 116 }).valid, false);
  assert.equal(qualifyCausalChain({ ...sample, responseAt: undefined }, { id: 1, timestampMs: 116 }).valid, false);
  assert.equal(qualifyCausalChain({ ...sample, pointerEventTimestampMs: 1e12 }, { id: 1, timestampMs: 116 }).valid, false);
  assert.equal(qualifyCausalChain({ ...sample, pointerHandlerAt: 99 }, { id: 1, timestampMs: 116 }).valid, false);
  assert.equal(qualifyCausalChain({ ...sample, responseSocketId: 1 }, { id: 1, timestampMs: 116 }).valid, false);
});

test("observed seat-input gaps, not requested waits, define active and idle populations", () => {
  const sample = { id: 2, targetId: "node", requestId: "input:4", inputCount: 1,
    pointerAt: 2000, pointerHandlerAt: 2001, pointerEventTimestampMs: 10,
    pointerEventTimeOriginMs: 1990, sentAt: 2002, responseAt: 2010, drawnAt: 2012,
    witnessSource: "dom-style-mutation", inputSocketId: 2, responseSocketId: 2,
    inputSocketUrl: "ws://seat/ws", responseSocketUrl: "ws://seat/ws", clockResolutionMs: .1,
    previousSeatInputAt: 499, idleMs: 1500 };
  const frame = { id: 2, timestampMs: 2016 };
  const idle = qualifyCausalChain(sample, frame);
  assert.equal(idle.population, "first-after-idle");
  assert.equal(idle.observedUserIdleGapMs, 1501);
  assert.equal(qualifyCausalChain({ ...sample, previousSeatInputAt: 500 }, frame).valid, false);
  const active = { ...sample, id: 3, idleMs: 0, previousSeatInputAt: 501 };
  assert.equal(qualifyCausalChain(active, { ...frame, id: 3 }).population, "active");
  assert.equal(qualifyCausalChain({ ...active, previousSeatInputAt: 500 },
    { ...frame, id: 3 }).valid, false);
  assert.equal(qualifyCausalChain({ ...sample, id: 1, idleMs: 0, previousSeatInputAt: null },
    { ...frame, id: 1 }).population, "first-input");
  assert.equal(qualifyCausalChain({ ...sample, id: 1, idleMs: 0, firstReturn: true,
    previousSeatInputAt: null }, { ...frame, id: 1 }).population, "first-after-return");
});

test("trace flow identifies real presentation despite later screencast capture", () => {
  const sample = { id: 1, pointerAt: 100, clockResolutionMs: .1,
    pointerMarkBeforeMs: 99.9, pointerMarkAfterMs: 100.1,
    responseMarkBeforeMs: 109.9, responseMarkAfterMs: 110.1 };
  const exact = associateFirstPresentation(sample, { id: 1, timestampMs: 140 }, traceFor());
  const immediateCapture = associateFirstPresentation(sample, { id: 1, timestampMs: 116 }, traceFor());
  assert.equal(exact.valid, true);
  assert.equal(immediateCapture.valid, true);
  assert.equal(exact.inputToPresentedLowerMs, immediateCapture.inputToPresentedLowerMs);
  assert.equal(exact.inputToPresentedUpperMs, immediateCapture.inputToPresentedUpperMs);
  assert.equal(exact.traceBeginFrameId.sequence_number, 40);
  assert.equal(exact.tracePresentedFrameId.sequence_number, 42);
  assert.ok(Math.abs(exact.pngConsumerOffsetFromPresentationMs - 23.9) < 1e-9);
  assert.ok(exact.inputToPresentedLowerMs <= 16 && exact.inputToPresentedUpperMs >= 16);
  assert.ok(exact.presentationClockUncertaintyMs >= 1.2);
  assert.equal(associateFirstPresentation(sample, { id: 1, timestampMs: 140 },
    traceFor().filter(e => e.name !== "AnimationFrame::Presentation")).valid, false);
  const failedSwap = traceFor();
  failedSwap[4].args.begin_frame_id = { source_id: 0, sequence_number: 0 };
  assert.equal(associateFirstPresentation(sample, { id: 1, timestampMs: 140 }, failedSwap).valid, false);
  const wrongSource = traceFor();
  wrongSource[4].args.begin_frame_id.source_id = 10;
  assert.equal(associateFirstPresentation(sample, { id: 1, timestampMs: 140 }, wrongSource).valid, false);
});

test("malformed trace clocks and marker brackets fail closed", () => {
  const sample = { id: 1, pointerAt: 100, clockResolutionMs: .1,
    pointerMarkBeforeMs: 99.9, pointerMarkAfterMs: 100.1,
    responseMarkBeforeMs: 109.9, responseMarkAfterMs: 110.1 };
  for (const malformed of [
    { ...sample, responseMarkBeforeMs: Number.NaN },
    { ...sample, responseMarkAfterMs: Number.POSITIVE_INFINITY },
    { ...sample, responseMarkBeforeMs: 111 },
  ]) assert.equal(associateFirstPresentation(malformed, { id: 1, timestampMs: 116 }, traceFor()).valid, false);
  assert.equal(associateFirstPresentation({ ...sample, pointerMarkAfterMs: 103 },
    { id: 1, timestampMs: 116 }, traceFor()).valid, false);
  assert.equal(associateFirstPresentation({ ...sample, clockResolutionMs: null },
    { id: 1, timestampMs: 116 }, traceFor()).valid, false);
  for (const index of [0, 2, 4]) {
    const events = traceFor();
    events[index] = { ...events[index], ts: Number.NaN };
    assert.equal(associateFirstPresentation(sample, { id: 1, timestampMs: 116 }, events).valid, false);
  }
});

test("tail statistics retain the worst sample and reject absent measurements", () => {
  assert.deepEqual(percentiles([4, 2, 100, 1]), { count: 4, p50: 2, p95: 100, p99: 100, worst: 100 });
  assert.equal(percentiles([]), null);
  assert.equal(percentiles([NaN]), null);
});
