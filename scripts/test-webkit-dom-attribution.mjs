import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SerializedDomLayerCapture, bootstrapScript, flattenDocument, joinLayersWithNodes, loadInitAssignments
} from "./lib/webkit-dom-attribution.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test("DOM flattening and LayerTree joins preserve parent and missing-node evidence", () => {
  const nodes = flattenDocument({
    nodeId: 1, nodeName: "HTML", localName: "html", attributes: [],
    children: [{ nodeId: 2, nodeName: "CANVAS", localName: "canvas", attributes: ["data-godot-particle-canvas", "", "width", "10"] }]
  });
  assert.equal(nodes.get(2).parentNodeId, 1);
  assert.deepEqual(nodes.get(2).attributes, { "data-godot-particle-canvas": "", width: "10" });
  const joined = joinLayersWithNodes([
    { layerId: "a", nodeId: 2, memory: 40, bounds: { x: 1, y: 2, width: 3, height: 4 } },
    { layerId: "b", nodeId: 99, memory: 0 }
  ], nodes);
  assert.equal(joined[0].node.nodeId, 2);
  assert.equal(joined[0].memoryBytes, 40);
  assert.equal(joined[1].node, null);
});

test("pre-navigation config retains exact source hash and installs only safe global assignments", () => {
  const root = mkdtempSync(join(tmpdir(), "cc-webkit-init-"));
  const path = join(root, "init.json");
  const source = '{"__mirrorSceneAblationConfig":{"version":1,"mode":"no-groups"}}\n';
  writeFileSync(path, source);
  const loaded = loadInitAssignments({ file: path });
  assert.equal(loaded.sourceKind, "file");
  assert.equal(loaded.bytes, Buffer.byteLength(source));
  assert.match(loaded.sha256, /^[0-9a-f]{64}$/);
  const context = {};
  vm.runInNewContext(bootstrapScript(loaded.assignments), context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.__mirrorSceneAblationConfig)), { version: 1, mode: "no-groups" });
  assert.deepEqual(JSON.parse(JSON.stringify(context.__couchCoopProbeInitReceipt.names)), ["__mirrorSceneAblationConfig"]);
  assert.throws(() => loadInitAssignments({ inline: '{"location":"bad"}' }), /unsafe init global name/);
  assert.throws(() => loadInitAssignments({ inline: "{}", file: path }), /choose only one/);
});

test("serialized DOM/layer captures keep refreshed root ids exclusive", async () => {
  let nextRootId = 0;
  let currentRootId = null;
  const firstLayerRead = deferred();
  const releaseFirstLayerRead = deferred();
  const commands = [];
  const inspector = {
    async targetCommand(method, params) {
      commands.push({ method, params });
      if (method === "LayerTree.enable") return {};
      if (method === "DOM.getDocument") {
        currentRootId = ++nextRootId;
        return { root: { nodeId: currentRootId, nodeName: "HTML", localName: "html", attributes: [] } };
      }
      if (method === "LayerTree.layersForNode") {
        if (params.nodeId === 1) {
          firstLayerRead.resolve();
          await releaseFirstLayerRead.promise;
        }
        assert.equal(params.nodeId, currentRootId, "a newer DOM.getDocument invalidated this transaction's root id");
        return { layers: [] };
      }
      if (method === "DOM.querySelectorAll") {
        assert.equal(params.nodeId, currentRootId, "selectors must use the transaction's current root id");
        return { nodeIds: [] };
      }
      throw new Error(`unexpected command ${method}`);
    }
  };
  const capture = new SerializedDomLayerCapture(inspector, 100);
  const first = capture.capture();
  await firstLayerRead.promise;
  const second = capture.capture();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(commands.filter(command => command.method === "DOM.getDocument").length, 1,
    "the second transaction must not refresh node ids while the first still uses them");
  releaseFirstLayerRead.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual([firstResult.rootNodeId, secondResult.rootNodeId], [1, 2]);
});

test("a failed serialized DOM/layer capture releases its successor", async () => {
  let documentCalls = 0;
  const inspector = {
    async targetCommand(method) {
      if (method === "LayerTree.enable") return {};
      if (method === "DOM.getDocument") return { root: { nodeId: ++documentCalls, attributes: [] } };
      if (method === "LayerTree.layersForNode") {
        if (documentCalls === 1) throw new Error("first capture failed");
        return { layers: [] };
      }
      if (method === "DOM.querySelectorAll") return { nodeIds: [] };
      throw new Error(`unexpected command ${method}`);
    }
  };
  const capture = new SerializedDomLayerCapture(inspector, 100);
  const first = capture.capture();
  const second = capture.capture();
  await assert.rejects(first, /first capture failed/);
  assert.equal((await second).rootNodeId, 2);
});
