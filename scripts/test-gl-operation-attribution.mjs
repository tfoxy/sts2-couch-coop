#!/usr/bin/env node
import assert from "node:assert/strict";
import { analyzeGlOperationAttribution } from "./lib/gl-operation-attribution.mjs";

const base = [
  { ph: "M", name: "process_name", pid: 44, args: { name: "GPU Process" } },
  { ph: "M", name: "thread_name", pid: 44, tid: 9, args: { name: "CrGpuMain" } },
  { ph: "M", name: "thread_name", pid: 44, tid: 10, args: { name: "CompositorGpuThread" } },
  { ph: "I", ts: 100, args: { data: { message: "cc-report-start" } } },
  { ph: "X", ts: 110, dur: 50, tdur: 20, pid: 44, tid: 9, name: "TraceGLAPI::glDrawArrays" },
  { ph: "X", ts: 130, dur: 40, tdur: 10, pid: 44, tid: 9, name: "TraceGLAPI::glDrawArrays" },
  { ph: "X", ts: 180, dur: 10, pid: 44, tid: 10, name: "TraceGLAPI::glBindTexture" },
  { ph: "X", ts: 195, dur: 10, tdur: 8, pid: 44, tid: 10, name: "TraceEGLAPI::eglFenceSync" },
  { ph: "X", ts: 190, dur: 10, tdur: 5, pid: 90, name: "TraceGLAPI::glClear" },
  { ph: "I", ts: 200, args: { data: { message: "cc-report-end" } } }
];
const meta = { schema: "raw-cdp-trace/1", fullRawEvents: true, tracingComplete: true, dataLossOccurred: false, rawEventCount: base.length };
const report = analyzeGlOperationAttribution(base, meta, { gpuPid: 44 });
assert.equal(report.valid, true, report.failures.join(", "));
assert.equal(report.calls.eventCount, 4);
assert.equal("overlapPresent" in report.calls, false, "no overlap inference or claim");
assert.equal(report.families.find(x => x.family === "GL").eventCount, 3);
assert.equal(report.families.find(x => x.family === "EGL").eventCount, 1);
assert.equal(report.families.find(x => x.family === "EGL").tdurKnownSumUs, 0);
const draw = report.operations.find(x => x.call === "glDrawArrays");
assert.equal(draw.eventCount, 2);
assert.equal(draw.spanUs, 90);
assert.equal(draw.tdurCompleteSumUs, 30);
const bind = report.operations.find(x => x.call === "glBindTexture");
assert.equal(bind.tdurCompleteSumUs, null, "missing tdur remains unavailable");
assert.equal(bind.tdurStatus, "tdur-unavailable");
const fence = report.operations.find(x => x.call === "eglFenceSync");
assert.equal(fence.spanUs, 5, "windowed call count/span uses only the in-window portion");
assert.equal(fence.tdurCompleteSumUs, null, "clipped event tdur is unavailable; no proportional estimate");
assert.equal(report.calls.eventCount, 4, "renderer GL event excluded by verified GPU PID");
const mainThread = report.threads.find(x => x.threadName === "CrGpuMain");
assert.equal(mainThread.tid, 9);
assert.equal(mainThread.eventCount, 2);
assert.equal(mainThread.tdurKnown, 2);
assert.equal(mainThread.tdurMissing, 0);
assert.equal(mainThread.tdurKnownSumUs, 30);
assert.deepEqual(mainThread.byFamily, [{ family: "GL", eventCount: 2, tdurKnown: 2, tdurMissing: 0,
  tdurKnownSumUs: 30, tdurCompleteSumUs: 30, tdurStatus: "tdur-complete" }]);
const compositorThread = report.threads.find(x => x.threadName === "CompositorGpuThread");
assert.equal(compositorThread.eventCount, 2);
assert.equal(compositorThread.tdurKnown, 0);
assert.equal(compositorThread.tdurMissing, 2);
assert.equal(compositorThread.tdurCompleteSumUs, null);
assert.deepEqual(compositorThread.byFamily.map(x => x.family), ["EGL", "GL"]);

const badIdentity = analyzeGlOperationAttribution(base, meta, { gpuPid: 90 });
assert.equal(badIdentity.valid, false);
assert.ok(badIdentity.failures.some(x => x.includes("does not match GPU Process")));
const lost = analyzeGlOperationAttribution(base, { ...meta, dataLossOccurred: true }, { gpuPid: 44 });
assert.equal(lost.valid, false);
assert.ok(lost.failures.some(x => x.includes("data loss")));
console.log("GL operation attribution tests passed");
