#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActiveWindowWitnessError, activeWindowRejectedRepeats, runActiveWindowWitness,
  validateActiveVisualReference } from "./lib/active-window-witness.mjs";

const dir = mkdtempSync(join(tmpdir(), "active-window-witness-"));
const browser = { packageName: "com.android.chrome", pid: 32567 };
const sourceSha256 = "a".repeat(64), recordingSha256 = "b".repeat(64);
const url = "http://127.0.0.1:5190/?stage=rust&shaders=off&particles=off";
const page = (nonce = "measured") => ({ documentNonce: nonce, timeOrigin: nonce === "measured" ? 2000 : 1000,
  url, visibility: { state: "visible", hidden: false }, viewport: { width: 800, height: 400, dpr: 2 },
  renderer: { backend: "rust", instance: 1, revision: 148, readiness: "ready", ready: true,
    resources: { pending: 0, failed: 0 }, failure: null,
    lifecycle: { contextReady: 1, presentationValid: 1 },
    effective: { quality: "very-low", shaders: "off", particles: "off",
      staticBg: 1, spineMode: "static", backingWidth: 1600, backingHeight: 800, dpr: 2 } },
  contextEvents: { losses: 0, creationErrors: 0, events: [] },
  quality: { choice: "auto", tier: "very-low", source: "auto" },
  savedSettings: null, freshDefaults: { cleared: true } });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ledger = `PID RSS NAME\n32567 100000 com.android.chrome\n32704 120000 com.android.chrome:privileged_process0\n7037 90000 com.android.chrome:sandboxed_process0:x\n`;
let serial = 0;
function fixture({ noAck = false, ackChange = {}, afterChange = {}, abort = false,
  badBoundary = false, badVisual = false, target = "measured-target",
  visualEffectiveChange = {}, measuredEffectiveChange = {}, viewportChange = {} } = {}) {
  const prefix = join(dir, `case-${++serial}`);
  const videoPath = `${prefix}.mp4`;
  writeFileSync(videoPath, "independent-android-video");
  const visualReference = { schema: "mirror-active-visual-reference/1", sourceSha256,
    recordingSha256, browser, targetId: "visual-target", page: page("visual"),
    boundary: { start: { boundMs: 2500, atEpochMs: 1200 }, end: { boundMs: 6500, atEpochMs: 1800 } },
    video: { path: videoPath, sha256: sha(readFileSync(videoPath)), clockDomain: "host",
      clockSamples: ["start", "end"].flatMap((phase) => [0, 1, 2].map((n) => ({ phase,
        hostBeforeEpochMs: (phase === "start" ? 2050 : 2850) + n * 10,
        deviceEpochMs: (phase === "start" ? 1100 : 1900) + n * 10,
        hostAfterEpochMs: (phase === "start" ? 2052 : 2852) + n * 10 }))),
      startedEpochMs: 2000, endedEpochMs: 3000 } };
  if (badVisual) visualReference.page.documentNonce = "measured";
  visualReference.page.renderer.effective = { ...visualReference.page.renderer.effective, ...visualEffectiveChange };
  visualReference.page.viewport = { ...visualReference.page.viewport, ...viewportChange };
  const rows = [0, 1].map((index) => {
    const physicalPath = `${prefix}.physical-${index}.png`, pagePath = `${prefix}.page-${index}.png`;
    writeFileSync(physicalPath, `physical-${index}`);
    writeFileSync(pagePath, `page-${index}`);
    return { physicalPath, physicalSha256: sha(readFileSync(physicalPath)),
      physicalEpochMs: 1010 + index * 20, pagePath, pageSha256: sha(readFileSync(pagePath)),
      pageEpochMs: 1020 + index * 20 };
  });
  const ledgerPath = `${prefix}.procs`;
  writeFileSync(ledgerPath, ledger);
  const controller = new AbortController();
  let time = 1000, captures = 0, targets = 0;
  const boundary = { accepted: !badBoundary, failures: badBoundary ? [{ name: "start.ready" }] : [],
    start: { documentNonce: "measured", timeOrigin: 2000, url, renderer: { instance: 1 } },
    end: { documentNonce: "measured", timeOrigin: 2000, url, renderer: { instance: 1 } } };
  const options = { prefix, boundary, visualReference, sourceSha256, recordingSha256, browser,
    targetId: async () => { targets++; return target; },
    capture: async () => { captures++;
      const current = page();
      current.renderer.effective = { ...current.renderer.effective, ...measuredEffectiveChange };
      return { ...current, ...(captures === 2 ? afterChange : {}) };
    },
    signal: controller.signal, timeoutMs: 150, now: () => time,
    sleep: async (ms) => {
      time += ms;
      if (abort) controller.abort();
      if (noAck || time !== 1050) return;
      const ready = JSON.parse(readFileSync(`${prefix}.post-active-ready.json`, "utf8"));
      const ack = { schema: "mirror-post-active-ack/1", token: ready.token,
        documentNonce: ready.documentNonce, targetId: ready.targetId, browser,
        captureOk: true, captures: rows,
        processLedger: { path: ledgerPath, capturedEpochMs: 1050 }, ...ackChange };
      writeFileSync(`${prefix}.post-active-ack.json`, JSON.stringify(ack));
    } };
  return { prefix, options, rows, videoPath, counts: () => ({ captures, targets }) };
}
async function rejects(f, code) {
  await assert.rejects(runActiveWindowWitness(f.options), (error) =>
    error instanceof ActiveWindowWitnessError && error.code === code);
  assert.equal(JSON.parse(readFileSync(`${f.prefix}.post-active-rejected.json`, "utf8")).failure.code, code);
}
try {
  const valid = fixture();
  assert.equal(validateActiveVisualReference(valid.options.visualReference,
    { sourceSha256, recordingSha256, browser }).accepted, true);
  assert.deepEqual(validateActiveVisualReference(valid.options.visualReference,
    { sourceSha256, recordingSha256, browser }).clockAlignment.start,
  { lower: 950, upper: 952 });
  const result = await runActiveWindowWitness(valid.options);
  assert.equal(result.visualClockAlignment.start.lower, 950);
  assert.equal(result.motionCaptures.length, 2);
  assert.equal(result.processLedger.processRows, 3);
  assert.deepEqual(valid.counts(), { captures: 2, targets: 2 });
  const accepted = { activeWindowWitness: { verified: true,
    receiptPath: `${valid.prefix}.post-active-verified.json`, processLedger: result.processLedger } };
  assert.deepEqual(activeWindowRejectedRepeats([accepted], true), []);
  assert.deepEqual(activeWindowRejectedRepeats([{ crashReason: "report failure" }], false), []);
  assert.equal(activeWindowRejectedRepeats([{ crashReason: "report failure" }], true)[0].code,
    "missingActiveWindowWitness");
  const physicalPath = result.motionCaptures[0].physicalPath;
  writeFileSync(physicalPath, "mutated");
  assert.equal(activeWindowRejectedRepeats([accepted], true)[0].code, "missingActiveWindowWitness");
  writeFileSync(physicalPath, "physical-0");
  writeFileSync(valid.videoPath, "mutated");
  assert.equal(activeWindowRejectedRepeats([accepted], true)[0].code, "missingActiveWindowWitness");
  await rejects(fixture({ noAck: true }), "timeout");
  await rejects(fixture({ ackChange: { token: "stale" } }), "ackIdentityMismatch");
  await rejects(fixture({ abort: true }), "navigationOrClose");
  await rejects(fixture({ ackChange: { captureOk: false } }), "motionCaptureFailure");
  await rejects(fixture({ afterChange: { documentNonce: "new-doc" } }), "identityChanged");
  await rejects(fixture({ badVisual: true }), "visualMeasuredMismatch");
  const unalignedVideo = fixture();
  unalignedVideo.options.visualReference.video.startedEpochMs = 2200;
  await rejects(unalignedVideo, "visualReferenceInvalid");
  const missingClock = fixture();
  missingClock.options.visualReference.video.clockSamples = [];
  await rejects(missingClock, "visualReferenceInvalid");
  const reversedClock = fixture();
  reversedClock.options.visualReference.video.clockSamples.reverse();
  await rejects(reversedClock, "visualReferenceInvalid");
  const staleStartClock = fixture();
  staleStartClock.options.visualReference.video.startedEpochMs = 1000;
  await rejects(staleStartClock, "visualReferenceInvalid");
  const staleEndClock = fixture();
  staleEndClock.options.visualReference.video.endedEpochMs = 4000;
  await rejects(staleEndClock, "visualReferenceInvalid");
  const samplesAfterBoundary = fixture();
  for (const sample of samplesAfterBoundary.options.visualReference.video.clockSamples.slice(0, 3)) {
    sample.hostBeforeEpochMs += 200;
    sample.hostAfterEpochMs += 200;
    sample.deviceEpochMs += 200;
  }
  await rejects(samplesAfterBoundary, "visualReferenceInvalid");
  await rejects(fixture({ target: "visual-target" }), "visualMeasuredMismatch");
  await rejects(fixture({ visualEffectiveChange: { staticBg: 0 } }), "visualMeasuredMismatch");
  await rejects(fixture({ visualEffectiveChange: { spineMode: "dynamic" } }), "visualMeasuredMismatch");
  await rejects(fixture({ visualEffectiveChange: { backingWidth: 1599 } }), "visualMeasuredMismatch");
  await rejects(fixture({ visualEffectiveChange: { backingHeight: 799 } }), "visualMeasuredMismatch");
  await rejects(fixture({ visualEffectiveChange: { dpr: 1.999 } }), "visualMeasuredMismatch");
  await rejects(fixture({ visualEffectiveChange: { backingWidth: null } }), "visualReferenceInvalid");
  await rejects(fixture({ measuredEffectiveChange: { backingWidth: null } }), "visualMeasuredMismatch");
  await rejects(fixture({ measuredEffectiveChange: { backingHeight: null } }), "visualMeasuredMismatch");
  await rejects(fixture({ measuredEffectiveChange: { dpr: null } }), "visualMeasuredMismatch");
  await rejects(fixture({ viewportChange: { height: 3 } }), "visualMeasuredMismatch");
  const onePixelBar = fixture({ viewportChange: { height: 401 } });
  assert.ok((await runActiveWindowWitness(onePixelBar.options)).visualMeasuredComparison.viewportDelta.height === -1);
  await rejects(fixture({ badBoundary: true }), "boundaryInvalid");
  const source = readFileSync(new URL("./bench-mirror-replay.mjs", import.meta.url), "utf8");
  assert.ok(source.indexOf("await markerTrace.start()") < source.indexOf("await waitAbortably(() => page.goto(pageUrl"));
  assert.ok(source.indexOf("await markerTrace.stop({ bridgeWindow") < source.indexOf("await runActiveWindowWitness({"));
  assert.match(source, /rejectedActiveRepeats: activeWindowRejectedRepeats\(runs, !!args\.activeWindowWitness\)/);
  console.log("active-window visual, post-capture, and result tests passed");
} finally { rmSync(dir, { recursive: true, force: true }); }
