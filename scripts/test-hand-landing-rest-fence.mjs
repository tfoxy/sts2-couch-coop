import assert from "node:assert/strict";
import { classifyRestCommit } from "./lib/handLandingRestFence.mjs";

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
assert.equal(classifyRestCommit(first, { ...first, live: true, presentEpoch: 109 }).status, "fail");
assert.equal(classifyRestCommit(first, { ...first, gameStable: false, presentEpoch: 109 }).status, "fail");
// No later committed frame is not a pass; the caller's deadline makes that an explicit failure.
assert.equal(classifyRestCommit(first, { ...first, presentEpoch: 108, mismatchPx: 0 }).status, "wait");
assert.equal(classifyRestCommit(first, { ...first, presentEpoch: 108, deadlinePassed: true }).status, "fail");
console.log("hand landing rest fence: 11 passed");
