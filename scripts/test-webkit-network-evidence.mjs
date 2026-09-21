import assert from "node:assert/strict";
import test from "node:test";
import { WebKitNetworkEvidence, webSocketFrameReceipt } from "./lib/webkit-network-evidence.mjs";

test("incoming websocket frames retain digest/envelope without duplicating scene payload", () => {
  const payload = JSON.stringify({ type: "scene", revision: 42, nodes: "x".repeat(1000) });
  const receipt = webSocketFrameReceipt("received", { requestId: "ws", timestamp: 1, response: { opcode: 1, payloadData: payload } });
  assert.equal(receipt.bytes, Buffer.byteLength(payload));
  assert.equal(receipt.json.type, "scene");
  assert.equal(receipt.json.revision, 42);
  assert.equal(receipt.payloadOmitted, true);
  assert.equal("payload" in receipt, false);
});

test("outgoing ack/vitals payloads and failed asset requests remain explicit", () => {
  const records = [];
  const evidence = new WebKitNetworkEvidence({ record: (type, value) => records.push({ type, value }) });
  evidence.status = "enabled";
  evidence.accept({ method: "Network.requestWillBeSent", params: { requestId: "r", type: "Image", request: { url: "http://localhost/bg/test", method: "GET" } } });
  evidence.accept({ method: "Network.loadingFailed", params: { requestId: "r", errorText: "decode", canceled: false } });
  const payload = JSON.stringify({ type: "client-vitals", revision: 9 });
  evidence.accept({ method: "Network.webSocketFrameSent", params: { requestId: "ws", response: { opcode: 1, payloadData: payload } } });
  const summary = evidence.summary();
  assert.equal(summary.failedRequests[0].assetKind, "bg");
  assert.equal(summary.frames[0].payload, payload);
  assert.equal(summary.frames[0].json.type, "client-vitals");
  assert.equal(summary.receivedFrameCount, 0);
  assert.ok(records.some(record => record.type === "network-failed"));
});
