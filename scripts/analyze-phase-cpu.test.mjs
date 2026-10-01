import assert from "node:assert/strict";
import test from "node:test";
import { parseMarker, summarizePhaseCpu } from "./analyze-phase-cpu.mjs";
import { ACTIVE_TRACE_WINDOW, IDLE_TRACE_WINDOW } from "./bench-trace-lifecycle.mjs";

test("parseMarker reads cc:couch-exec:<phase>:<id>:<edge> (id last)", () => {
  assert.deepEqual(parseMarker("cc:couch-exec:build:1234:start"),
    { key: "cc:couch-exec:build:1234", phase: "couch-exec:build", id: "1234", edge: "start" });
  assert.deepEqual(parseMarker("cc:couch-exec:composition:7:end"),
    { key: "cc:couch-exec:composition:7", phase: "couch-exec:composition", id: "7", edge: "end" });
});

test("parseMarker reads cc:rust-exec:<id>:<phase>:<edge> (id before phase)", () => {
  assert.deepEqual(parseMarker("cc:rust-exec:1234:upload:start"),
    { key: "cc:rust-exec:1234:upload", phase: "rust-exec:upload", id: "1234", edge: "start" });
});

test("parseMarker falls back generically for an unknown domain with a trailing numeric id", () => {
  assert.deepEqual(parseMarker("cc:something:42:start"),
    { key: "cc:something:42", phase: "something", id: "42", edge: "start" });
});

test("parseMarker folds a multi-segment generic phase name, keeping only the trailing numeric segment as id", () => {
  assert.deepEqual(parseMarker("cc:content:7:3:2:start"),
    { key: "cc:content:7:3:2", phase: "content:7:3", id: "2", edge: "start" });
});

test("parseMarker falls back generically with no id when nothing trails numerically", () => {
  assert.deepEqual(parseMarker("cc:something:start"),
    { key: "cc:something", phase: "something", id: null, edge: "start" });
});

test("parseMarker returns null for non-cc labels and labels without a start/end edge", () => {
  assert.equal(parseMarker("cc-report-start"), null); // window marker, not a phase marker (no "cc:" prefix)
  assert.equal(parseMarker("cc:couch-exec:build:1234"), null); // no trailing edge
  assert.equal(parseMarker("RunTask"), null);
});

function metaEvents(pid, tid) {
  return [{ ph: "M", name: "thread_name", pid, tid, args: { name: "CrRendererMain" } }];
}
function stamp(pid, tid, ts, tts, message) {
  return { ph: "I", name: "TimeStamp", pid, tid, ts, tts, args: { data: { message } } };
}

test("summarizePhaseCpu pairs start/end TimeStamp markers and sums tts/ts deltas per phase", () => {
  const pid = 100, tid = 1;
  const events = [
    ...metaEvents(pid, tid),
    stamp(pid, tid, 1_000, 500, "cc-report-start"),
    stamp(pid, tid, 2_000, 1_000, "cc:rust-exec:1:upload:start"),
    stamp(pid, tid, 4_000, 2_500, "cc:rust-exec:1:upload:end"), // wall 2000us, cpu 1500us
    stamp(pid, tid, 5_000, 2_600, "cc:rust-exec:2:upload:start"),
    stamp(pid, tid, 7_000, 3_600, "cc:rust-exec:2:upload:end"), // wall 2000us, cpu 1000us
    stamp(pid, tid, 8_000, 4_000, "cc:couch-exec:build:9:start"),
    stamp(pid, tid, 9_000, 4_800, "cc:couch-exec:build:9:end"), // wall 1000us, cpu 800us
    stamp(pid, tid, 10_000, 5_000, "cc-report-end"),
    // outside the window: must not be counted
    stamp(pid, tid, 20_000, 9_000, "cc:rust-exec:3:upload:start"),
    stamp(pid, tid, 21_000, 9_500, "cc:rust-exec:3:upload:end"),
    // a different thread: must not be counted even though it is inside the window
    stamp(pid, 2, 3_000, 1_000, "cc:rust-exec:9:upload:start"),
    stamp(pid, 2, 3_500, 1_200, "cc:rust-exec:9:upload:end"),
  ];
  const result = summarizePhaseCpu(events, ACTIVE_TRACE_WINDOW);
  assert.equal(result.error, undefined);
  assert.equal(result.window.windowMs, 9); // (10000-1000) us -> 9ms
  assert.equal(result.window.threadName, "CrRendererMain");

  const upload = result.phases.find((p) => p.phase === "rust-exec:upload");
  assert.equal(upload.calls, 2);
  assert.equal(upload.totalCpuMs, 2.5); // (1500+1000)us -> 2.5ms
  assert.equal(upload.wallMs, 4); // (2000+2000)us -> 4ms
  assert.equal(upload.msPerCall, 1.25);

  const build = result.phases.find((p) => p.phase === "couch-exec:build");
  assert.equal(build.calls, 1);
  assert.equal(build.totalCpuMs, 0.8);
  assert.equal(build.wallMs, 1);

  assert.equal(result.unmatched.starts, 0);
  assert.equal(result.unmatched.ends, 0);
});

test("summarizePhaseCpu counts an unclosed start and a start-less end as unmatched", () => {
  const pid = 1, tid = 1;
  const events = [
    ...metaEvents(pid, tid),
    stamp(pid, tid, 0, 0, "cc-report-start"),
    stamp(pid, tid, 1_000, 500, "cc:rust-exec:1:upload:start"), // never closed
    stamp(pid, tid, 2_000, 900, "cc:rust-exec:2:upload:end"), // no matching start
    stamp(pid, tid, 3_000, 1_000, "cc-report-end"),
  ];
  const result = summarizePhaseCpu(events, ACTIVE_TRACE_WINDOW);
  assert.equal(result.unmatched.starts, 1);
  assert.equal(result.unmatched.ends, 1);
  assert.equal(result.phases.length, 0);
});

test("summarizePhaseCpu reports an error when the window markers are missing", () => {
  const result = summarizePhaseCpu([{ ph: "M", name: "thread_name", pid: 1, tid: 1, args: { name: "CrRendererMain" } }], IDLE_TRACE_WINDOW);
  assert.match(result.error, /cc-idle-start/);
});
