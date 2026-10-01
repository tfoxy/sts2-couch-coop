#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { replayDiagnosticClock } from "./lib/active-replay-options.mjs";

assert.equal(replayDiagnosticClock({ activeWindowWitness: "measured", parityCapture: null }), false);
assert.equal(replayDiagnosticClock({ activeVisualReferenceOut: "visual", parityCapture: null }), false);
assert.equal(replayDiagnosticClock({ parityCapture: "parity.json" }), true);
assert.throws(() => replayDiagnosticClock({ activeWindowWitness: "measured",
  parityCapture: "parity.json" }), /cannot use --parity-capture/);
assert.throws(() => replayDiagnosticClock({ activeVisualReferenceOut: "visual",
  parityCapture: "parity.json" }), /cannot use --parity-capture/);
for (const activeFlag of ["--active-window-witness", "--active-visual-reference-out"]) {
  const result = spawnSync(process.execPath, [new URL("./bench-mirror-replay.mjs", import.meta.url).pathname,
    activeFlag, "ignored-receipt", "--parity-capture", "ignored-parity.json"],
  { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 2, `${activeFlag} exits before replay/navigation`);
  assert.match(result.stderr, /active visual\/measured replay cannot use --parity-capture diagnostic clock/);
}
console.log("active replay diagnostic-clock CLI admission tests passed");
