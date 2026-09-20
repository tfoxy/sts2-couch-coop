import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeHeapSnapshot, diffHeapSnapshots, HeapDiagnosticsTimeoutError, WEBKIT_HEAP_DIAGNOSTICS_SCHEMA, WebKitHeapDiagnostics } from "./lib/webkit-heap-diagnostics.mjs";

class FakeInspector extends EventEmitter {
  constructor(handler = () => ({})) { super(); this.targetId = "target-a"; this.closed = false; this.calls = []; this.handler = handler; }
  targetCommand(method, params, timeoutMs) { this.calls.push({ method, params, timeoutMs }); return this.handler(method, params, timeoutMs, this); }
}

const out = () => mkdtempSync(join(tmpdir(), "cc-webkit-heap-diagnostics-"));
const unsupported = method => Object.assign(new Error("ignored text"), { code: -32601, method });
const protocolFailure = method => Object.assign(new Error("transport failure"), { code: -32000, method });

test("construction and ordinary baseline are lazy", () => {
  const inspector = new FakeInspector();
  new WebKitHeapDiagnostics({ inspector, outDir: out() });
  assert.deepEqual(inspector.calls, []);
});

test("GC installs listener before command and accepts event before response", async () => {
  const inspector = new FakeInspector((method, _params, _timeout, source) => {
    if (method === "Heap.enable") return {};
    assert.equal(method, "Heap.gc");
    assert.ok(source.listenerCount("target-event"), "GC listener must precede Heap.gc");
    source.emit("target-event", { targetId: "target-a", method: "Heap.garbageCollected", params: { collection: { type: "full", startTime: 1, endTime: 1.25 } } });
    return {};
  });
  const result = await new WebKitHeapDiagnostics({ inspector, outDir: out() }).requestGc({ timeoutMs: 100 });
  assert.equal(result.supported, true); assert.equal(result.event.type, "full"); assert.equal(result.event.durationMs, 250);
  assert.deepEqual(inspector.calls.map(call => call.method), ["Heap.enable", "Heap.gc"]);
});

test("GC requires a full event and times out after partial-only events", async () => {
  const inspector = new FakeInspector((method, _params, _timeout, source) => {
    if (method === "Heap.enable") return {};
    source.emit("target-event", { targetId: "target-a", method: "Heap.garbageCollected", params: { collection: { type: "partial" } } }); return {};
  });
  await assert.rejects(new WebKitHeapDiagnostics({ inspector, outDir: out() }).requestGc({ timeoutMs: 10 }), HeapDiagnosticsTimeoutError);
});

test("structured unsupported errors are capability results for enable, GC, and snapshot", async () => {
  const enableInspector = new FakeInspector(method => { throw unsupported(method); });
  assert.deepEqual(await new WebKitHeapDiagnostics({ inspector: enableInspector, outDir: out() }).requestGc(), {
    schema: WEBKIT_HEAP_DIAGNOSTICS_SCHEMA, supported: false, capability: { method: "Heap.enable", code: -32601 }
  });
  const gcInspector = new FakeInspector(method => method === "Heap.enable" ? {} : Promise.reject(unsupported(method)));
  assert.equal((await new WebKitHeapDiagnostics({ inspector: gcInspector, outDir: out() }).requestGc()).capability.method, "Heap.gc");
  const snapshotInspector = new FakeInspector(method => method === "Heap.enable" ? {} : Promise.reject(unsupported(method)));
  assert.equal((await new WebKitHeapDiagnostics({ inspector: snapshotInspector, outDir: out() }).takeSnapshot()).capability.method, "Heap.snapshot");
});

test("non-capability protocol errors propagate", async () => {
  const failure = protocolFailure("Heap.snapshot");
  const inspector = new FakeInspector(method => method === "Heap.enable" ? {} : Promise.reject(failure));
  await assert.rejects(new WebKitHeapDiagnostics({ inspector, outDir: out() }).takeSnapshot(), error => error === failure);
});

test("GC rejects target loss and replacement", async () => {
  for (const replacement of [false, true]) {
    const inspector = new FakeInspector((method, _params, _timeout, source) => {
      if (method === "Heap.enable") return {};
      setImmediate(() => {
        if (replacement) { source.targetId = "target-b"; source.emit("target", { targetId: "target-b" }); }
        else source.emit("target-destroyed", { targetId: "target-a" });
      });
      return new Promise(() => {});
    });
    await assert.rejects(new WebKitHeapDiagnostics({ inspector, outDir: out() }).requestGc({ timeoutMs: 100 }), /target was (lost|replaced)/);
  }
});

test("snapshot validates, writes private raw data, and reports only metadata", async () => {
  const raw = '{"version":3,"type":"Inspector"}'; const artifactRoot = out();
  const inspector = new FakeInspector(method => method === "Heap.enable" ? {} : { timestamp: 12.5, snapshotData: raw });
  const result = await new WebKitHeapDiagnostics({ inspector, outDir: artifactRoot }).takeSnapshot({ label: "initial / private", index: 7 });
  assert.equal(result.supported, true); assert.equal(result.artifact.path, "heap-007-initial-private.json");
  assert.equal("snapshotData" in JSON.parse(JSON.stringify(result)), false);
  const path = join(artifactRoot, result.artifact.path);
  assert.equal(readFileSync(path, "utf8"), raw); assert.equal(result.artifact.bytes, Buffer.byteLength(raw));
  assert.match(result.artifact.sha256, /^[0-9a-f]{64}$/); assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(statSync(artifactRoot).mode & 0o777, 0o700);
});

test("invalid snapshot response, timeout, and target replacement are fatal", async () => {
  for (const response of [{ timestamp: "bad", snapshotData: "{}" }, { timestamp: 1, snapshotData: null }]) {
    const inspector = new FakeInspector(method => method === "Heap.enable" ? {} : response);
    await assert.rejects(new WebKitHeapDiagnostics({ inspector, outDir: out() }).takeSnapshot(), /invalid timestamp/);
  }
  const hung = new FakeInspector(method => method === "Heap.enable" ? {} : new Promise(() => {}));
  await assert.rejects(new WebKitHeapDiagnostics({ inspector: hung, outDir: out() }).takeSnapshot({ timeoutMs: 10 }), HeapDiagnosticsTimeoutError);
  const replaced = new FakeInspector((method, _params, _timeout, source) => {
    if (method === "Heap.enable") return {};
    source.targetId = "target-b"; return { timestamp: 1, snapshotData: "{}" };
  });
  await assert.rejects(new WebKitHeapDiagnostics({ inspector: replaced, outDir: out() }).takeSnapshot(), /replaced/);
  const lost = new FakeInspector((method, _params, _timeout, source) => {
    if (method === "Heap.enable") return {};
    setImmediate(() => source.emit("target-destroyed", { targetId: "target-a" })); return new Promise(() => {});
  });
  await assert.rejects(new WebKitHeapDiagnostics({ inspector: lost, outDir: out() }).takeSnapshot({ timeoutMs: 100 }), /target was lost/);
});

function snapshot(nodes, edges) { return { version: 3, type: "Inspector", nodes, edges, nodeClassNames: ["Root", "A", "B", "C", "D"], edgeTypes: ["Internal"], edgeNames: [] }; }

test("flat Inspector graph validation rejects unsupported and malformed input", () => {
  assert.throws(() => analyzeHeapSnapshot({ version: 4, type: "Inspector", nodes: [], edges: [], nodeClassNames: [], edgeTypes: [] }), /Unsupported/);
  assert.throws(() => analyzeHeapSnapshot(snapshot([1, 0, 0, 0], [])), /root/);
  assert.throws(() => analyzeHeapSnapshot(snapshot([0, 0, 0, 0], [0, 99, 0, 0])), /invalid edge/);
});

test("analysis calculates class shallow totals and immediate dominators through a cycle", () => {
  // root -> A -> B -> D -> B (cycle), plus root -> C. D remains dominated by B.
  const graph = snapshot(
    [0, 0, 0, 0, 1, 10, 1, 0, 2, 20, 2, 0, 3, 30, 3, 0, 4, 40, 4, 0],
    [0, 1, 0, 0, 0, 3, 0, 0, 1, 2, 0, 0, 2, 4, 0, 0, 4, 2, 0, 0]
  );
  const result = analyzeHeapSnapshot(graph);
  assert.equal(result.totalShallowBytes, 100); assert.equal(result.reachableShallowBytes, 100);
  const byId = new Map(result.topDominators.map(node => [node.id, node]));
  assert.equal(byId.get(2).immediateDominatorId, 1); assert.equal(byId.get(4).immediateDominatorId, 2);
  assert.equal(byId.get(2).retainedBytes, 60); assert.equal(byId.get(1).retainedBytes, 70);
  assert.deepEqual(result.topClasses.map(value => [value.className, value.shallowBytes]), [["D", 40], ["C", 30], ["B", 20], ["A", 10], ["Root", 0]]);
  assert.equal(result.topDominators[0].id, 1);
});

test("persistent-process diff reports new/removed nodes, signed class shallow deltas, and non-double-counted retained total", () => {
  const initial = snapshot([0, 0, 0, 0, 1, 10, 1, 0, 2, 5, 2, 0], [0, 1, 0, 0, 1, 2, 0, 0]);
  const returned = snapshot([0, 0, 0, 0, 1, 12, 1, 0, 3, 20, 3, 0], [0, 1, 0, 0, 1, 3, 0, 0]);
  assert.throws(() => diffHeapSnapshots(initial, returned), /persistentProcess/);
  const diff = diffHeapSnapshots(initial, returned, { persistentProcess: true });
  assert.equal(diff.totalShallowDeltaBytes, 17); assert.equal(diff.rootRetainedDeltaBytes, 17);
  assert.deepEqual(diff.newNodes, { count: 1, shallowBytes: 20 }); assert.deepEqual(diff.removedNodes, { count: 1, shallowBytes: 5 });
  assert.deepEqual(diff.positiveShallowClassDeltas, [{ className: "C", deltaBytes: 20 }, { className: "A", deltaBytes: 2 }]);
  assert.deepEqual(diff.negativeShallowClassDeltas, [{ className: "B", deltaBytes: -5 }]);
  assert.deepEqual(diff.positiveRetainedSizeDeltas, [{ id: 1, className: "A", deltaBytes: 17 }]);
});
