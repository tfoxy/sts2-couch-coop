#!/usr/bin/env node
import assert from "node:assert/strict";
import { markerThreadCpu } from "./lib/marker-thread-cpu.mjs";

const mark = (message, ts, tts, pid = 7, tid = 9) => ({ name: "TimeStamp", pid, tid, ts, tts, args: { data: { message } } });
const meta = (pid = 7, tid = 9, name = "CrRendererMain") => ({ ph: "M", name: "thread_name", pid, tid, args: { name } });
const cpu = markerThreadCpu([meta(), mark("cc-report-start", 1_000, 100), mark("cc-report-end", 2_000, 450)], "active");
assert.deepEqual(cpu, {
  source: "chrome-trace-marker-thread-ticks", thread: { pid: 7, tid: 9, name: "CrRendererMain" },
  start: { tsUs: 1_000, ttsUs: 100 }, end: { tsUs: 2_000, ttsUs: 450 }, wallMs: 1, cpuMs: 0.35, cpuPct: 35
});
assert.throws(() => markerThreadCpu([meta(), mark("cc-report-start", 1, 1), mark("cc-report-end", 2, 2, 7, 10)], "active"), /identity/);
assert.throws(() => markerThreadCpu([meta(), mark("cc-report-start", 1, 10), mark("cc-report-end", 2, 10)], "active"), /non-monotonic/);
assert.throws(() => markerThreadCpu([meta(), mark("cc-report-start", 1, 1), mark("cc-report-start", 2, 2), mark("cc-report-end", 3, 3)], "active"), /ambiguous/);
assert.throws(() => markerThreadCpu([meta(), mark("cc-report-start", 1, undefined), mark("cc-report-end", 2, 2)], "active"), /timestamps/);
assert.throws(() => markerThreadCpu([meta(7, 9, "Compositor"), mark("cc-report-start", 1, 1), mark("cc-report-end", 2, 2)], "active"), /CrRendererMain/);
assert.throws(() => markerThreadCpu([meta(), mark("cc-report-start", 1, 1), mark("cc-report-end", 2, 4)], "active"), /exceeds wall/);
console.log("marker thread CPU tests passed");
