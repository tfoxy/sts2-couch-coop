import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { NulJsonFramer, ProtocolTimeoutError, WEBKIT_MEMORY_SCHEMA, WebKitInspector, isMeasuredMemoryCapture, summarizeMemoryWindow } from "./lib/webkit-memory-probe.mjs";

test("NUL framer accepts split and combined JSON frames", () => {
  const framer = new NulJsonFramer();
  assert.deepEqual(framer.push(Buffer.from('{"a":')), []);
  assert.deepEqual(framer.push(Buffer.from('1}\0{"b":2}\0')), [{ a: 1 }, { b: 2 }]);
  assert.doesNotThrow(() => framer.finish());
});

function harness() {
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
  const inspector = new WebKitInspector({ stdin, stdout, stderr });
  const sent = []; stdin.on("data", chunk => sent.push(...new NulJsonFramer().push(chunk)));
  return { stdin, stdout, inspector, sent };
}

test("nested target responses use distinct inner routing", async () => {
  const h = harness(); h.inspector.pageProxyId = "page"; h.inspector.targetId = "target";
  const pending = h.inspector.targetCommand("Memory.enable", {}, 100);
  const outer = h.sent.at(-1);
  h.stdout.write(`${JSON.stringify({ id: outer.id, pageProxyId: "page", result: {} })}\0`);
  const inner = JSON.parse(outer.params.message);
  h.stdout.write(`${JSON.stringify({ pageProxyId: "page", method: "Target.dispatchMessageFromTarget", params: { targetId: "target", message: JSON.stringify({ id: inner.id, result: { enabled: true } }) } })}\0`);
  assert.deepEqual(await pending, { enabled: true });
});

test("new non-provisional target replaces the active target", () => {
  const h = harness();
  h.stdout.write(`${JSON.stringify({ method: "Target.targetCreated", params: { targetInfo: { type: "page", targetId: "one", isProvisional: false } } })}\0`);
  h.stdout.write(`${JSON.stringify({ method: "Target.targetCreated", params: { targetInfo: { type: "page", targetId: "two", isProvisional: false } } })}\0`);
  assert.equal(h.inspector.targetId, "two");
});

test("destroying a target rejects its pending nested command", async () => {
  const h = harness(); h.inspector.pageProxyId = "page"; h.inspector.targetId = "target";
  const pending = h.inspector.targetCommand("Memory.enable", {}, 100);
  h.stdout.write(`${JSON.stringify({ method: "Target.targetDestroyed", params: { targetId: "target" }, pageProxyId: "page" })}\0`);
  await assert.rejects(pending, /target was destroyed/);
});

test("provisional commit replaces the target and rejects old-target work", async () => {
  const h = harness(); h.inspector.pageProxyId = "page"; h.inspector.targetId = "old"; h.inspector.boundTargetId = "old";
  const pending = h.inspector.targetCommand("Runtime.evaluate", {}, 100);
  h.stdout.write(`${JSON.stringify({ method: "Target.didCommitProvisionalTarget", params: { oldTargetId: "old", newTargetId: "new" }, pageProxyId: "page" })}\0`);
  await assert.rejects(pending, /provisional target committed/);
  assert.equal(h.inspector.targetId, "new");
  assert.equal(h.inspector.boundTargetId, null);
});

test("request timeout and zero update conditions are observable failures", async () => {
  const h = harness();
  await assert.rejects(h.inspector.outer("Never.replies", {}, 5), ProtocolTimeoutError);
  assert.equal(h.inspector.closed, false);
  h.stdout.end();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.inspector.closed, true);
});

test("explicit close does not report a pipe ending before its response as an inspector error", async () => {
  const h = harness();
  const closing = h.inspector.close(100);
  h.stdout.end();
  await closing;
  assert.equal(h.inspector.closed, true);
  assert.deepEqual(h.inspector.errors, []);
});

test("zero-only, missing-update, and incomplete lifecycle captures are unmeasured", () => {
  const lifecycle = { started: true, completed: true };
  assert.equal(isMeasuredMemoryCapture({ inspectorClosed: false, lifecycle, samples: [] }), false);
  assert.equal(isMeasuredMemoryCapture({ inspectorClosed: false, lifecycle, samples: [{ categories: { other: 0 } }] }), false);
  assert.equal(isMeasuredMemoryCapture({ inspectorClosed: false, lifecycle, samples: [{ categories: { other: 1 } }, { categories: { other: 2 } }] }), true);
  assert.equal(isMeasuredMemoryCapture({ inspectorClosed: false, lifecycle: { started: true, completed: false }, samples: [{ categories: { other: 1 } }, { categories: { other: 2 } }] }), false);
});

test("journey windows report only samples since begin", () => {
  const samples = [{ categories: { javascript: 1 } }, { categories: { javascript: 4 } }, { categories: { javascript: 2, other: 9 } }];
  assert.deepEqual(summarizeMemoryWindow(samples, 1), {
    sampleRange: [1, 3], sampleCount: 2, latestCategories: { javascript: 2, other: 9 }, peakCategories: { javascript: 4, other: 9 }
  });
});

function runProbe(arguments_, stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/probe-webkit-memory.mjs", ...arguments_], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject); child.once("exit", code => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function runJourneyProbe(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/probe-webkit-memory.mjs", "--journey", "--url", url, "--out", mkdtempSync(join(tmpdir(), "cc-webkit-probe-journey-"))], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    let scheduled = false;
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (!scheduled && stdout.includes('"command":"begin"')) {
        scheduled = true;
        setTimeout(() => child.stdin.end('{"command":"snapshot","label":"window"}\n{"command":"stop"}\n'), 1_600);
      }
    }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject); child.once("exit", code => resolve({ code, stdout, stderr }));
    child.stdin.write('{"command":"begin","label":"window"}\n');
  });
}

test("self-test writes a screenshot and reaps its exact WebKit process group", { timeout: 30_000 }, async () => {
  const out = mkdtempSync(join(tmpdir(), "cc-webkit-probe-test-"));
  const result = await runProbe(["--self-test", "--duration-ms", "1100", "--out", out]);
  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
  assert.equal(summary.measured, true);
  assert.equal(summary.schema, WEBKIT_MEMORY_SCHEMA);
  assert.deepEqual(JSON.parse(readFileSync(join(out, "raw.ndjson"), "utf8").split(/\r?\n/)[0]).schema, WEBKIT_MEMORY_SCHEMA);
  assert.equal(summary.inspectorErrors.includes("WebKit process exited"), false);
  assert.ok(existsSync(summary.marks[0].screenshot), "self-test should retain a screenshot");
  assert.deepEqual(summary.cleanup.orphanedPids, []);
  assert.equal(existsSync(`/proc/${summary.browserPid}`), false, "the launched process must not survive its probe");
});

test("journey URL navigates once and snapshot summarizes only its begin window", { timeout: 30_000 }, async () => {
  const result = await runJourneyProbe(pathToFileURL(join(process.cwd(), "scripts/fixtures/webkit-memory-selftest.html")).href);
  assert.equal(result.code, 0, result.stderr);
  const snapshotLine = result.stdout.trim().split(/\r?\n/).find(line => JSON.parse(line).command === "snapshot");
  const mark = JSON.parse(snapshotLine).mark;
  assert.equal(mark.label, "window");
  assert.ok(mark.memory.sampleCount > 0);
  assert.ok(mark.page.url.endsWith("webkit-memory-selftest.html"));
  assert.equal(mark.page.readyState, "complete");
});

test("failed URL journey still writes unmeasured raw, summary, and stderr artifacts", { timeout: 30_000 }, async () => {
  const out = mkdtempSync(join(tmpdir(), "cc-webkit-probe-failure-"));
  const result = await runProbe(["--journey", "--url", "http://192.0.2.1:9/", "--timeout-ms", "500", "--out", out], '{"command":"stop"}\n');
  assert.notEqual(result.code, 0);
  const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
  assert.equal(summary.measured, false);
  assert.equal(JSON.parse(readFileSync(join(out, "raw.ndjson"), "utf8").split(/\r?\n/)[0]).schema, WEBKIT_MEMORY_SCHEMA);
  for (const name of ["raw.ndjson", "stderr.log", "summary.json"]) assert.equal(existsSync(join(out, name)), true, `${name} missing`);
});
