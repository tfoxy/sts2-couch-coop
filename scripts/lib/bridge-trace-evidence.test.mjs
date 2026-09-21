import assert from "node:assert/strict";
import test from "node:test";
import { traceDecodeEvidenceError } from "./bridge-trace-evidence.mjs";
import { canvasTextureBridgeWindow } from "./perf-report-envelope.mjs";

const names = ["SoftwareImageDecodeCache::DecodeImageIfNecessary", "Decode Image"];
test("zero trace decodes are fatal for DOM but accepted only with a validated bridge window", () => {
  assert.match(traceDecodeEvidenceError(0, "unknown", names), /UNMEASURED/);
  const bridge = canvasTextureBridgeWindow(
    { instance: { id: 7 }, sampledAtMs: 1, pageDecodes: 0, pageDecodeFailed: 0, pageDecodeMs: 0, pageOwnedUploads: 0, pageElementUploads: 0, uploads: 0, uploadMs: 0 },
    { instance: { id: 7 }, sampledAtMs: 2, pageDecodes: 0, pageDecodeFailed: 0, pageDecodeMs: 0, pageOwnedUploads: 0, pageElementUploads: 0, uploads: 0, uploadMs: 0 },
  );
  assert.ok(bridge);
  assert.equal(traceDecodeEvidenceError(0, "unknown", names, bridge), null);
  assert.equal(traceDecodeEvidenceError(1, "software", names), null);
});
