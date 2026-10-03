import assert from "node:assert/strict";
import { classifyProducerCatchup, classifyRestCommit } from "./lib/handLandingRestFence.mjs";

const first = { stage: "canvas", presentEpoch: 108, rendererInstance: 7, gameStable: true, live: false, mismatchPx: 170 };
assert.equal(classifyRestCommit(first, { ...first }).status, "wait");
assert.deepEqual(classifyRestCommit(first, { ...first, presentEpoch: 109, mismatchPx: 0 }),
  { status: "score", first, committed: { ...first, presentEpoch: 109, mismatchPx: 0 } });
// The very next committed picture is scored even if a later picture would pass.
assert.equal(classifyRestCommit(first, { ...first, presentEpoch: 109, mismatchPx: 75 }).status, "score");
assert.equal(classifyRestCommit(first, { ...first, presentEpoch: null }).status, "fail");
assert.equal(classifyRestCommit(first, { ...first, stage: "dom", presentEpoch: 109 }).status, "fail");
assert.equal(classifyRestCommit(first, { ...first, rendererInstance: 8, presentEpoch: 109 }).status, "fail");
assert.equal(classifyRestCommit(first, { ...first, presentEpoch: 110, mismatchPx: 0 }).status, "fail");
// A skipped first commit cannot hide a mismatch still visible in the later committed picture.
assert.deepEqual(classifyRestCommit(first, { ...first, presentEpoch: 110, mismatchPx: 169.36 }),
  { status: "score", first, committed: { ...first, presentEpoch: 110, mismatchPx: 169.36 } });
assert.equal(classifyRestCommit(first, { ...first, live: true, presentEpoch: 109 }).status, "fail");
assert.equal(classifyRestCommit(first, { ...first, gameStable: false, presentEpoch: 109 }).status, "fail");
// No later committed frame is not a pass; the caller's deadline makes that an explicit failure.
assert.equal(classifyRestCommit(first, { ...first, presentEpoch: 108, mismatchPx: 0 }).status, "wait");
assert.equal(classifyRestCommit(first, { ...first, presentEpoch: 108, deadlinePassed: true }).status, "fail");

// h11-fixed-full-a/focus: the client had already drawn the shifted neighbours; the producer spoke later.
const focus = { stage: "canvas", rendererInstance: 1, presentEpoch: 178, live: false,
  spreadFactor: 1.25, mismatchPx: 93.75, rows: [
    { id: "bash", inFan: true, zIndex: 0, fieldMode: 1, gameX: 880, gameY: 1030,
      drawnX: 1006.3, drawnY: 911, raiseDy: -119, distPx: 93.75 },
    { id: "neighbour", inFan: true, zIndex: 0, fieldMode: 1, gameX: 1191, gameY: 1041,
      drawnX: 1582.5, drawnY: 922, raiseDy: -119, distPx: 93.75 }
  ] };
const caught = { ...focus, presentEpoch: 180, mismatchPx: 0.05, rows: [
  { ...focus.rows[0], gameX: 805, distPx: 0.05 },
  { ...focus.rows[1], gameX: 1266, distPx: 0 }
] };
assert.equal(classifyProducerCatchup(focus, caught).status, "adopt");
assert.equal(classifyProducerCatchup(focus, { ...caught, rows: [
  { ...caught.rows[0], drawnX: 1100 }, caught.rows[1] ] }).status, "stop");
assert.equal(classifyProducerCatchup(focus, { ...caught, rows: [
  { ...caught.rows[0], zIndex: 1 }, caught.rows[1] ] }).status, "stop");
assert.equal(classifyProducerCatchup(focus, { ...focus, presentEpoch: 179 }).status, "wait");
console.log("hand landing rest fence: 16 passed");
