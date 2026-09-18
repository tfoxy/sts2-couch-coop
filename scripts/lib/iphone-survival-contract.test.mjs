import assert from "node:assert/strict";
import { validateIphoneSurvival } from "./iphone-survival-contract.mjs";

assert.deepEqual(validateIphoneSurvival({ presentations: 2, acks: 2, hostSocketOpen: true, seatSocketOpen: true, viewError: false, crash: false, animationFrames: 30, responsive: false }), { ok: true, failures: [] });
assert.deepEqual(validateIphoneSurvival({ presentations: 1, acks: 2, hostSocketOpen: true, seatSocketOpen: true, viewError: false, crash: false, animationFrames: 0, responsive: true }).failures, ["second-presentation-missing"]);
assert.equal(validateIphoneSurvival({ presentations: 2, acks: 2, hostSocketOpen: true, seatSocketOpen: true, viewError: false, crash: false, animationFrames: 29, responsive: false }).ok, false);
console.log("iphone-survival-contract: ok");
