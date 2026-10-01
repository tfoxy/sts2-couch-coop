#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { PostIdleWitnessError, postIdleRejectedRepeats, runPostIdleWitness } from "./lib/post-idle-witness.mjs";

const dir = mkdtempSync(join(tmpdir(), "post-idle-witness-"));
const browser = { packageName: "com.android.chrome", pid: 32567 };
const state = () => ({ documentNonce: "doc-A", timeOrigin: 1_800_000_000_000,
  url: "http://127.0.0.1:5190/?stage=rust&shaders=off&particles=off",
  visibility: { state: "visible", hidden: false }, viewport: { width: 800, height: 400, dpr: 2 },
  renderer: { backend: "rust", instance: 1, revision: 148, readiness: "ready", ready: true,
    resources: { pending: 0, failed: 0 }, failure: null,
    lifecycle: { contextReady: 1, presentationValid: 1 },
    effective: { quality: "very-low", shaders: "off", particles: "off", staticBg: 1, spineMode: "static" } },
  contextEvents: { losses: 0, creationErrors: 0, events: [] },
  quality: { choice: "auto", tier: "very-low", source: "auto" },
  savedSettings: null, freshDefaults: { cleared: true } });
const preVerified = { request: { token: "cell-token", documentNonce: "doc-A", targetId: "protocol-target",
  browser, url: state().url }, after: state() };
const ledgerText = `PID RSS NAME\n32567 100000 com.android.chrome\n32704 120000 com.android.chrome:privileged_process0\n7037 90000 com.android.chrome:sandboxed_process0:org.chromium.content.app.SandboxedProcessService0\n`;
let next = 0;
function fixture({ ackChange = {}, noAck = false, navigation = false, failCapture = false,
  afterChange = {}, targetAfter = "protocol-target", ledgerTextOverride = ledgerText,
  latePhysical = false } = {}) {
  const prefix = join(dir, `case-${++next}`);
  const ledgerPath = `${prefix}.procs`;
  writeFileSync(ledgerPath, ledgerTextOverride);
  const captures = [0, 1].map((index) => {
    const physicalPath = `${prefix}-physical-${index}.png`;
    const pagePath = `${prefix}-page-${index}.png`;
    const physical = Buffer.from(`physical-png-${index}`);
    const page = Buffer.from(`page-png-${index}`);
    writeFileSync(physicalPath, physical);
    writeFileSync(pagePath, page);
    return { physicalPath, physicalSha256: createHash("sha256").update(physical).digest("hex"),
      physicalEpochMs: latePhysical && index === 1 ? 1060 : 1010 + index * 20,
      pagePath, pageSha256: createHash("sha256").update(page).digest("hex"),
      pageEpochMs: 1020 + index * 20 };
  });
  const controller = new AbortController();
  let time = 1_000, reads = 0, targetReads = 0, markers = 2;
  const capture = async () => {
    reads++;
    if (failCapture && reads === 2) throw new Error("post capture failed");
    return { ...state(), ...(reads === 2 ? afterChange : {}) };
  };
  const options = { prefix, preVerified, idleMarkers: { startAtMs: 10, endAtMs: 5010 }, capture,
    targetId: async () => (++targetReads === 2 ? targetAfter : "protocol-target"),
    timeoutMs: 150, signal: controller.signal, now: () => time,
    sleep: async (ms) => {
      assert.equal(markers, 2, "post witness starts after both idle markers");
      time += ms;
      if (navigation) controller.abort();
      if (!noAck && time === 1050) {
        const ready = JSON.parse(readFileSync(`${prefix}.post-idle-ready.json`, "utf8"));
        const ack = { schema: "mirror-post-idle-ack/1", token: ready.token,
          cellToken: ready.cellToken, documentNonce: ready.documentNonce,
          targetId: ready.targetId, browser, captureOk: true,
          captures,
          processLedger: { path: ledgerPath, capturedEpochMs: time }, ...ackChange };
        writeFileSync(`${prefix}.post-idle-ack.json.tmp`, JSON.stringify(ack));
        renameSync(`${prefix}.post-idle-ack.json.tmp`, `${prefix}.post-idle-ack.json`);
      }
    } };
  return { prefix, options, counts: () => ({ reads, targetReads, markers }) };
}
async function rejected(fixtureValue, code) {
  await assert.rejects(runPostIdleWitness(fixtureValue.options), (error) =>
    error instanceof PostIdleWitnessError && error.code === code);
  const receipt = JSON.parse(readFileSync(`${fixtureValue.prefix}.post-idle-rejected.json`, "utf8"));
  assert.equal(receipt.failure.code, code);
  return receipt;
}

try {
  const valid = fixture();
  const receipt = await runPostIdleWitness(valid.options);
  assert.equal(receipt.processLedger.processRows, 3);
  assert.equal(receipt.motionCaptures.length, 2);
  assert.match(receipt.processLedger.sha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.ready.cellToken, "cell-token");
  assert.equal(receipt.ready.timeOrigin, state().timeOrigin);
  assert.equal(valid.counts().reads, 2);
  assert.equal(JSON.parse(readFileSync(`${valid.prefix}.post-idle-verified.json`, "utf8")).failure, null);
  const acceptedRun = { idle: { postIdleWitness: { verified: true,
    receiptPath: `${valid.prefix}.post-idle-verified.json`, processLedger: receipt.processLedger } } };
  assert.deepEqual(postIdleRejectedRepeats([acceptedRun], true), []);
  assert.deepEqual(postIdleRejectedRepeats([{ crashReason: "calibration failed" }], false), [],
    "ordinary replay is unaffected");
  assert.deepEqual(postIdleRejectedRepeats([{ crashReason: "calibration failed" }], true),
    [{ repeat: 1, code: "missingPostIdleWitness", reason: "calibration failed", receiptPath: null }]);
  assert.deepEqual(postIdleRejectedRepeats([{}], true),
    [{ repeat: 1, code: "missingPostIdleWitness",
      reason: "verified post-idle witness or ledger is absent", receiptPath: null }]);
  const badReceipt = { idle: { postIdleWitness: { verified: true, receiptPath: "missing.json",
    processLedger: receipt.processLedger } } };
  assert.equal(postIdleRejectedRepeats([badReceipt], true)[0].code, "missingPostIdleWitness");
  const missingLedger = { idle: { postIdleWitness: { verified: true,
    receiptPath: `${valid.prefix}.post-idle-verified.json`,
    processLedger: { ...receipt.processLedger, path: `${valid.prefix}.missing-procs` } } } };
  assert.equal(postIdleRejectedRepeats([missingLedger], true)[0].code, "missingPostIdleWitness");
  const physicalPath = receipt.motionCaptures[0].physicalPath;
  const originalPhysical = readFileSync(physicalPath);
  unlinkSync(physicalPath);
  assert.equal(postIdleRejectedRepeats([acceptedRun], true)[0].code, "missingPostIdleWitness",
    "deleted physical capture rejects the completed cell");
  writeFileSync(physicalPath, originalPhysical);
  const pagePath = receipt.motionCaptures[1].pagePath;
  const originalPage = readFileSync(pagePath);
  writeFileSync(pagePath, Buffer.from("mutated-page-capture"));
  assert.equal(postIdleRejectedRepeats([acceptedRun], true)[0].code, "missingPostIdleWitness",
    "mutated page capture rejects the completed cell");
  writeFileSync(pagePath, originalPage);
  assert.deepEqual(postIdleRejectedRepeats([acceptedRun], true), [],
    "restored captures recover the verified result");

  await rejected(fixture({ noAck: true }), "timeout");
  const staleAck = await rejected(fixture({ ackChange: { token: "stale" } }), "ackIdentityMismatch");
  assert.equal(staleAck.processLedger.processRows, 3, "rejected stale ack retains available ledger");
  await rejected(fixture({ navigation: true }), "navigationOrClose");
  const captureFailed = await rejected(fixture({ ackChange: { captureOk: false } }), "captureFailure");
  assert.equal(captureFailed.processLedger.processRows, 3, "failure receipt retains completed ledger");
  await rejected(fixture({ failCapture: true }), "captureFailure");
  await rejected(fixture({ afterChange: { timeOrigin: 1_800_000_000_001 } }), "identityChanged");
  await rejected(fixture({ afterChange: { renderer: { ...state().renderer, readiness: "failed" } } }), "readinessFailure");
  await rejected(fixture({ targetAfter: "other-target" }), "targetChanged");
  await rejected(fixture({ ledgerTextOverride: "PID RSS NAME\n32567 100000 com.android.chrome\n" }), "ledgerFailure");
  await rejected(fixture({ latePhysical: true }), "ledgerFailure");

  const source = readFileSync(new URL("./bench-mirror-replay.mjs", import.meta.url), "utf8");
  const idle = source.slice(source.indexOf("// ---- idle window (--idle)"));
  assert.ok(idle.indexOf('mark("cc-idle-end")') < idle.indexOf("await runPostIdleWitness("),
    "post witness remains after the end marker");
  assert.ok(idle.indexOf("await markerTrace.stop(") < idle.indexOf("await runPostIdleWitness("),
    "post witness remains outside trace collection");
  const recordSource = source.slice(source.indexOf("const crashedRunRecord = (reason, witnessFailure = null) => ("),
    source.indexOf("\nconst runs = [];"));
  const makeRecord = runInNewContext(recordSource.replace(/^const crashedRunRecord =/, "const crashedRunRecord =") +
    "\ncrashedRunRecord;", {});
  const failedRecord = makeRecord("post-idle witness rejected: timeout",
    { code: "timeout", receiptPath: "post-idle-rejected.json", reason: "timeout" });
  assert.equal(failedRecord.pageCrashed, false);
  assert.equal(failedRecord.witnessFailure.code, "timeout");
  assert.equal(failedRecord.report, null);
  assert.deepEqual(postIdleRejectedRepeats([failedRecord], true),
    [{ repeat: 1, code: "timeout", reason: "timeout", receiptPath: "post-idle-rejected.json" }]);
  assert.match(source, /postIdleWitness: args\.postIdleWitness/);
  assert.match(source, /rejectedRepeats: postIdleRejectedRepeats\(runs, args\.postIdleWitness\)/);
  assert.match(source, /if \(witnessFailed && args\.report && !args\.reportTraceOnly\)/);
  assert.match(source, /process\.exit\(flightLivenessFailed \|\| discardGateFailed \|\| witnessFailed \? 1 : 0\)/);
  console.log("post-idle witness lifecycle and result tests passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
