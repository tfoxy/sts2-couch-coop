#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { inspectRawTrace } from "./validate-gpu-attribution-trace.mjs";
import { profileTimingHealth, alignProfileSamples } from "./lib/profile-timing-health.mjs";
import { classifyProbe } from "./phone-gpu-sampler-probe.mjs";

const dir = mkdtempSync(join(tmpdir(), "cc-gpu-diag-"));
try {
  const path = join(dir, "trace.json.gz");
  const events = [
    { ph: "M", name: "process_name", pid: 1, args: { name: "Renderer" } },
    { ph: "M", name: "process_name", pid: 2, args: { name: "GPU Process" } },
    { ph: "I", name: "TimeStamp", ts: 100, pid: 1, args: { data: { message: "cc-report-start" } } },
    { ph: "X", name: "glDrawElements", ts: 120, dur: 20, pid: 2 },
    { ph: "X", name: "GPUTask", ts: 125, dur: 25, pid: 2 },
    { ph: "X", name: "RunTask", ts: 130, dur: 50, pid: 1 },
    { ph: "I", name: "TimeStamp", ts: 200, pid: 1, args: { data: { message: "cc-report-end" } } },
  ];
  const save = (rows, loss = false) => {
    writeFileSync(path, gzipSync(JSON.stringify(rows)));
    writeFileSync(`${path}.meta.json`, JSON.stringify({ schema: "raw-cdp-trace/1", fullRawEvents: true,
      tracingComplete: true, rawEventCount: rows.length, dataLossOccurred: loss, maxBufferPercent: 0.5,
      categories: ["gpu", "viz", "disabled-by-default-gpu.service", "disabled-by-default-skia.gpu"] }));
  };
  save(events);
  let result = await inspectRawTrace(path);
  assert.equal(result.valid, true, result.failures.join(", "));
  assert.deepEqual(result.glCallNames, ["glDrawElements"]);
  assert.equal(result.perGlCallTracing, "exposed");
  save(events.map(x => x.name === "glDrawElements" ? { ...x, name: "TraceGLAPI::glDrawElements" } : x));
  result = await inspectRawTrace(path);
  assert.equal(result.valid, true);
  assert.deepEqual(result.glCallNames, ["TraceGLAPI::glDrawElements"]);
  assert.equal(result.perGlCallTracing, "exposed");
  save(events);
  writeFileSync(path, gzipSync(JSON.stringify({ traceEvents: events, metadata: { note: "after trace" } })));
  assert.equal((await inspectRawTrace(path)).valid, true);
  save(events.filter(x => x.name !== "glDrawElements"));
  result = await inspectRawTrace(path);
  assert.equal(result.valid, true);
  assert.equal(result.perGlCallTracing, "unavailable");
  save(events.map(x => x.name === "glDrawElements" ? { ...x, pid: 1 } : x));
  result = await inspectRawTrace(path);
  assert.equal(result.valid, true);
  assert.equal(result.perGlCallTracing, "unavailable");
  save(events.map(x => x.name === "glDrawElements" ? { ...x, name: "virtual void GrGLTexture::onRelease()" } : x));
  result = await inspectRawTrace(path);
  assert.equal(result.valid, true);
  assert.equal(result.perGlCallTracing, "unavailable");
  save(events, true);
  result = await inspectRawTrace(path);
  assert.match(result.failures.join("; "), /data-loss status/);
  save(events.slice(0, -1));
  result = await inspectRawTrace(path);
  assert.match(result.failures.join("; "), /markers missing/);
  assert.equal(profileTimingHealth({ samples: [1, 2], timeDeltas: [100, -4], startTime: 1, endTime: 2 }).timingShapeValid, false);
  assert.equal(profileTimingHealth({ samples: [1, 2], timeDeltas: [100, 200], startTime: 1, endTime: 2 }).timingShapeValid, true);
  assert.deepEqual(alignProfileSamples({ samples: [1, 2], timeDeltas: [100, 200], startTime: 1000, endTime: 1400 },
    { start: 1050, end: 1350 }), { valid: true, sampleCount: 2, unit: "unweighted JS samples", markerStartUs: 1050, markerEndUs: 1350 });
  assert.deepEqual(alignProfileSamples({ samples: [1, 2], timeDeltas: [100, -200], startTime: 1100, endTime: 1300 },
    { start: 1000, end: 1400 }), { valid: true, sampleCount: 2, unit: "unweighted JS samples",
      basis: "whole profile contained inside markers", timingValidated: false,
      profileStartUs: 1100, profileEndUs: 1300, markerStartUs: 1000, markerEndUs: 1400 });
  assert.equal(alignProfileSamples({ samples: [1], timeDeltas: [-1], startTime: 1000, endTime: 1400 },
    { start: 1050, end: 1350 }).valid, false);
  const candidate = classifyProbe({ pid: 42, cmdline: "com.android.chrome --type=gpu-process", psLine: "", uid: 2000,
    paranoid: "3", perfetto: true, simpleperf: false });
  assert.equal(candidate.targetValid, true);
  assert.equal(candidate.permissions.paranoidWarning, true);
  assert.equal(candidate.status, "candidate-only");
  assert.equal(classifyProbe({ pid: 42, cmdline: "com.chrome.dev --type=gpu-process", psLine: "", uid: 2000,
    paranoid: "3", perfetto: true, simpleperf: false, packageName: "com.chrome.dev" }).targetValid, true);
  assert.equal(classifyProbe({ pid: 42, cmdline: "com.android.chrome --type=renderer", psLine: "", uid: 0,
    paranoid: "1", perfetto: true, simpleperf: true }).targetValid, false);
  console.log("GPU attribution diagnostics tests passed");
} finally { rmSync(dir, { recursive: true, force: true }); }
