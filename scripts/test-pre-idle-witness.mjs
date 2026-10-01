#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { runPreIdleWitness } from "./lib/pre-idle-witness.mjs";

const dir = mkdtempSync(join(tmpdir(), "pre-idle-witness-"));
const browser = { packageName: "com.android.chrome", pid: 12345 };
const state = () => ({ documentNonce: "doc-A", timeOrigin: 1_800_000_000_000,
  url: "http://127.0.0.1:5190/?stage=rust&shaders=off&particles=off",
  visibility: { state: "visible", hidden: false }, viewport: { width: 800, height: 400, dpr: 2 },
  renderer: { backend: "rust", instance: 7, revision: 148, readiness: "ready", ready: true,
    resources: { pending: 0, failed: 0 }, failure: null, lifecycle: { contextReady: 1, presentationValid: 1 },
    effective: { quality: "very-low", shaders: "off", particles: "off", staticBg: 1, spineMode: "static" } },
  contextEvents: { losses: 0, creationErrors: 0, events: [] },
  quality: { choice: "auto", tier: "very-low", source: "auto" },
  savedSettings: null, freshDefaults: { key: "couchcoop.mirrorSettings.v1", cleared: true } });
let next = 0;
function setup({ ackChange = {}, afterChange = {}, navigation = false, noAck = false, failCapture = false } = {}) {
  const prefix = join(dir, `case-${++next}`);
  const controller = new AbortController();
  let captures = 0, markers = 0, time = 0;
  const capture = async () => {
    captures++;
    if (failCapture && captures === 2) throw new Error("capture failed");
    return { ...state(), ...(captures === 2 ? afterChange : {}) };
  };
  const options = { prefix, browser, capture, targetId: async () => "target-A", requireFreshDefaults: true,
    timeoutMs: 150, signal: controller.signal, now: () => time,
    sleep: async (ms) => {
      assert.equal(markers, 0, "idle marker must wait for witness ack and recapture");
      time += ms;
      if (navigation) controller.abort();
      if (!noAck && time === 50) {
        const request = JSON.parse(readFileSync(`${prefix}.request.json`, "utf8"));
        const ack = { schema: "mirror-pre-idle-witness-ack/1", token: request.token,
          documentNonce: request.documentNonce, targetId: request.targetId, browser,
          browserVerified: true, captureOk: true, captures: [{ adbPng: "ignored.png" }], ...ackChange };
        writeFileSync(`${prefix}.ack.json.tmp`, JSON.stringify(ack));
        renameSync(`${prefix}.ack.json.tmp`, `${prefix}.ack.json`);
      }
    } };
  return { prefix, options, marker: () => { markers++; }, markerCount: () => markers };
}

try {
  const valid = setup();
  const verified = await runPreIdleWitness(valid.options);
  valid.marker();
  assert.equal(valid.markerCount(), 1);
  assert.equal(verified.before.documentNonce, verified.after.documentNonce);
  assert.equal(verified.request.browser.pid, 12345);
  assert.equal(verified.request.quality.choice, "auto");
  assert.equal(verified.request.quality.tier, "very-low");
  assert.equal(JSON.parse(readFileSync(`${valid.prefix}.verified.json`, "utf8")).ack.captureOk, true);

  for (const ackChange of [{ token: "stale" }, { documentNonce: "other-doc" }, { targetId: "other-target" },
    { browser: { ...browser, pid: 12346 } }, { captureOk: false }]) {
    const bad = setup({ ackChange });
    await assert.rejects(runPreIdleWitness(bad.options), /identity\/capture mismatch/);
    assert.equal(bad.markerCount(), 0);
  }
  const navigated = setup({ navigation: true });
  await assert.rejects(runPreIdleWitness(navigated.options), /navigated or closed/);
  assert.equal(navigated.markerCount(), 0);
  const timedOut = setup({ noAck: true });
  await assert.rejects(runPreIdleWitness(timedOut.options), /ack timeout/);
  assert.equal(timedOut.markerCount(), 0);
  const captureFailed = setup({ failCapture: true });
  await assert.rejects(runPreIdleWitness(captureFailed.options), /capture failed/);
  assert.equal(captureFailed.markerCount(), 0);
  const unready = setup({ afterChange: { renderer: { ...state().renderer, readiness: "failed" } } });
  await assert.rejects(runPreIdleWitness(unready.options), /not ready/);
  assert.equal(unready.markerCount(), 0);
  const remounted = setup({ afterChange: { renderer: { ...state().renderer, instance: 8 } } });
  await assert.rejects(runPreIdleWitness(remounted.options), /changed before marker/);
  assert.equal(remounted.markerCount(), 0);
  const lostContext = setup({ afterChange: { contextEvents: { ...state().contextEvents, losses: 1 } } });
  await assert.rejects(runPreIdleWitness(lostContext.options), /not ready/);
  assert.equal(lostContext.markerCount(), 0);
  const pendingResource = setup({ afterChange: { renderer: { ...state().renderer,
    resources: { pending: 1, failed: 0 } } } });
  await assert.rejects(runPreIdleWitness(pendingResource.options), /not ready/);
  assert.equal(pendingResource.markerCount(), 0);
  const fallback = setup({ afterChange: { renderer: { ...state().renderer, backend: "canvas" } } });
  await assert.rejects(runPreIdleWitness(fallback.options), /fresh Auto with effects Off/);
  assert.equal(fallback.markerCount(), 0);
  const source = readFileSync(new URL("./bench-mirror-replay.mjs", import.meta.url), "utf8");
  const idle = source.slice(source.indexOf("// ---- idle window (--idle)"));
  assert.ok(idle.indexOf("await runPreIdleWitness(") < idle.indexOf('mark("cc-idle-start")'),
    "handshake remains before the idle marker in the replay flow");
  const markerSource = source.slice(source.indexOf("function idleMarkerWindowInPage(input) {"),
    source.indexOf("\nfunction parseArgs(argv)"));
  const pageState = { ...state(), renderer: { ...state().renderer, instance: 1 } };
  let marks = 0;
  const pageWindow = { __benchDocumentNonce: pageState.documentNonce,
    __mirrorRendererDiagnostics: () => ({ ...pageState.renderer,
      frameIdentity: { revision: pageState.renderer.revision } }),
    __mirrorGlContextEvents: () => pageState.contextEvents };
  const marker = runInNewContext(`(${markerSource})`, {
    window: pageWindow, location: { href: pageState.url },
    document: { visibilityState: "visible", hidden: false, querySelector: () => null },
    innerWidth: 800, innerHeight: 400, devicePixelRatio: 2,
    localStorage: { getItem: () => null }, performance: { now: () => 1,
      mark: () => { marks++; } }, console: { timeStamp: () => {} },
  });
  marker({ label: "cc-idle-start", witness: pageState });
  assert.equal(marks, 1);
  pageWindow.__mirrorRendererDiagnostics = () => ({ ...pageState.renderer, instance: 2,
    frameIdentity: { revision: pageState.renderer.revision } });
  assert.throws(() => marker({ label: "cc-idle-start", witness: pageState }),
    /"field":"renderer.instance","observed":2,"expected":1/);
  assert.equal(marks, 1, "changed numeric renderer instance cannot emit a marker");
  pageWindow.__mirrorRendererDiagnostics = () => ({ ...pageState.renderer, instance: null,
    frameIdentity: { revision: pageState.renderer.revision } });
  assert.throws(() => marker({ label: "cc-idle-start", witness: pageState }),
    /"field":"renderer.instance","observed":null,"expected":1/);
  assert.equal(marks, 1, "missing renderer instance cannot emit a marker");
  pageWindow.__mirrorRendererDiagnostics = () => ({ ...pageState.renderer, readiness: "failed",
    frameIdentity: { revision: pageState.renderer.revision } });
  assert.throws(() => marker({ label: "cc-idle-start", witness: pageState }),
    /"field":"renderer.readiness","observed":"failed","expected":"ready"/);
  assert.equal(marks, 1, "failed readiness cannot emit a marker");
  pageWindow.__mirrorRendererDiagnostics = () => ({ ...pageState.renderer,
    frameIdentity: { revision: pageState.renderer.revision } });
  pageWindow.__mirrorGlContextEvents = () => ({ ...pageState.contextEvents, losses: 1 });
  assert.throws(() => marker({ label: "cc-idle-start", witness: pageState }),
    /"field":"context.losses","observed":1,"expected":0/);
  assert.equal(marks, 1, "context loss cannot emit a marker");
  pageWindow.__mirrorGlContextEvents = () => pageState.contextEvents;
  pageWindow.__benchDocumentNonce = "navigated-document";
  assert.throws(() => marker({ label: "cc-idle-start", witness: pageState }),
    /"field":"documentNonce","observed":"navigated-document","expected":"doc-A"/);
  assert.equal(marks, 1, "navigation cannot emit another idle marker");
  console.log("pre-idle witness lifecycle tests passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
