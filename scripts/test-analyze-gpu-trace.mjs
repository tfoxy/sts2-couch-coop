#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "gpu-trace-window-"));
try {
const trace = join(root, "trace.json");
const result = join(root, "result.json");
const meta = join(root, "meta.json");
const out = join(root, "metrics.json");
const events = [
  // This raw event is intentionally discarded by analyze-gpu-trace. It used to
  // shift the cell's relative marker window away from retained X/I events.
  { ph: "B", ts: 1_000, pid: 1, tid: 1, name: "discarded-async" },
  { ph: "M", cat: "__metadata", pid: 7, tid: 9, name: "process_name", args: { name: "GPU Process" } },
  { ph: "M", cat: "__metadata", pid: 7, tid: 9, name: "thread_name", args: { name: "CrGpuMain" } },
  { ph: "I", ts: 10_000, pid: 1, tid: 1, name: "TimeStamp", args: { data: { message: "cc-report-start" } } },
  { ph: "X", ts: 10_000, dur: 1_000, tdur: 1_000, pid: 7, tid: 9, name: "GpuWork" },
  { ph: "I", ts: 11_000, pid: 1, tid: 1, name: "TimeStamp", args: { data: { message: "cc-report-end" } } },
  { ph: "X", ts: 20_000, dur: 1_000, tdur: 700, pid: 7, tid: 9, name: "outside-window" }
];
writeFileSync(trace, JSON.stringify({ traceEvents: events }));
writeFileSync(result, JSON.stringify({ medians: {} }));
writeFileSync(meta, JSON.stringify({ artifacts: { trace } }));

const script = join(process.cwd(), "scripts", "analyze-phone-canvas-cell.mjs");
execFileSync(process.execPath, [script, "--trace", trace, "--result", result, "--meta", meta, "--phase", "active", "--out", out], { stdio: "pipe" });
const metrics = JSON.parse(readFileSync(out, "utf8"));
assert.equal(metrics.traceWindow.startUs, 10_000);
assert.equal(metrics.traceWindow.endUs, 11_000);
assert.equal(metrics.cpu.gpuProcessCpuMs, null, "gated GPU CPU requires Perfetto sched evidence");
assert.equal(metrics.cpu.gpuProcessRunTaskCpuMs, 1, "diagnostic trace CPU uses absolute marker bounds despite an earlier discarded event");

const analyzer = join(process.cwd(), "scripts", "analyze-gpu-trace.mjs");
assert.throws(() => execFileSync(process.execPath, [analyzer, trace, "--from", "1", "--to-us", "11000"], { stdio: "pipe" }), /Command failed/);
const missingCpu = join(root, "missing-cpu.json");
writeFileSync(missingCpu, JSON.stringify([
  { ph: "M", cat: "__metadata", pid: 7, tid: 9, name: "process_name", args: { name: "GPU Process" } },
  { ph: "M", cat: "__metadata", pid: 7, tid: 9, name: "thread_name", args: { name: "CrGpuMain" } },
  { ph: "M", cat: "__metadata", pid: 8, tid: 10, name: "process_name", args: { name: "WebView" } },
  { ph: "M", cat: "__metadata", pid: 8, tid: 10, name: "thread_name", args: { name: "Chrome_InProcGpuThread" } },
  { ph: "X", ts: 10, dur: 100, tdur: 100, pid: 7, tid: 9, name: "known-tdur" },
  { ph: "X", ts: 110, dur: 100, pid: 7, tid: 9, name: "missing-tdur" },
  { ph: "X", ts: 10, dur: 100, tdur: 100, pid: 8, tid: 10, name: "webview-known-tdur" },
  { ph: "X", ts: 110, dur: 100, pid: 8, tid: 10, name: "webview-missing-tdur" }
]));
const gpuOut = execFileSync(process.execPath, [analyzer, missingCpu, "--json"], { encoding: "utf8" });
const gpuResult = JSON.parse(gpuOut.split("\n").find((line) => line.startsWith("ANALYSIS_RESULT ")).slice(16));
assert.equal(gpuResult.gpuProcess.cpuMs, null, "missing tdur is unavailable, not zero CPU");
assert.equal(gpuResult.gpuProcess.cpuCoverage, 0.5);
assert.equal(gpuResult.webviewGpuThreads.cpuMs, null, "partial WebView GPU tdur is unavailable too");
assert.equal(gpuResult.webviewGpuThreads.cpuCoverage, 0.5);
assert.match(gpuOut, /cpu unavailable \(tdur coverage\)/);
assert.equal(gpuResult.actualPresents, null);
assert.equal(gpuResult.submitted, null);
console.log("GPU trace window and coverage tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
