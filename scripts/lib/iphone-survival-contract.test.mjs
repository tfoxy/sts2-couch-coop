import assert from "node:assert/strict";
import { classifyIphoneFailure, validateIphoneSurvival } from "./iphone-survival-contract.mjs";

assert.deepEqual(validateIphoneSurvival({ presentations: 2, acks: 2, hostSocketOpen: true, seatSocketOpen: true, viewError: false, crash: false, animationFrames: 30, responsive: true }), { ok: true, failures: [] });
assert.deepEqual(validateIphoneSurvival({ presentations: 1, acks: 2, hostSocketOpen: true, seatSocketOpen: true, viewError: false, crash: false, animationFrames: 0, responsive: true }).failures, ["final-presentation-missing", "post-delta-responsiveness-missing"]);
assert.equal(validateIphoneSurvival({ presentations: 2, acks: 2, hostSocketOpen: true, seatSocketOpen: true, viewError: false, crash: false, animationFrames: 29, responsive: false }).ok, false);
assert.equal(validateIphoneSurvival({ presentations: 6, acks: 6, requiredMessages: 6, hostSocketOpen: true, seatSocketOpen: true, viewError: false, crash: false, animationFrames: 30, responsive: true }).ok, true);
assert.deepEqual(classifyIphoneFailure({ presentations: 1, acks: 1, hostSocketClosed: true, missingAcknowledgement: true }), { category: "host-socket-close", phase: "post-first-frame", postFirstFrameBrowserDisappearance: true });
assert.deepEqual(classifyIphoneFailure({ presentations: 1, acks: 1, rendererPageCrash: true, hostSocketClosed: true }), { category: "renderer-page-crash", phase: "post-first-frame", postFirstFrameBrowserDisappearance: true });
for (const [index, category] of ["renderer-page-crash", "unexpected-reload-navigation", "seat-socket-close", "host-socket-close", "client-view-error", "missing-acknowledgement", "render-stall", "script-unresponsive", "simulator-safaridriver-failure"].entries()) {
  const flags = [{ rendererPageCrash: true }, { navigation: true }, { seatSocketClosed: true }, { hostSocketClosed: true }, { clientViewError: true }, { missingAcknowledgement: true }, { renderStall: true }, { scriptUnresponsive: true }, { simulatorSafariDriverFailure: true }];
  assert.equal(classifyIphoneFailure({ presentations: 1, acks: 1, ...Object.assign({}, ...flags.slice(index)) }).category, category);
}
assert.equal(classifyIphoneFailure({ presentations: 0, acks: 0, scriptUnresponsive: true }).phase, "pre-first-frame");
assert.equal(classifyIphoneFailure({ presentations: 2, acks: 2 }).phase, "post-final-delta");
assert.equal(classifyIphoneFailure({ presentations: 3, acks: 3, requiredMessages: 6, renderStall: true }).phase, "post-first-frame");
assert.deepEqual(classifyIphoneFailure({ presentations: 6, acks: 6, requiredMessages: 6, hostSocketClosed: true }), {
  category: "host-socket-close",
  phase: "post-final-delta",
  postFirstFrameBrowserDisappearance: true
});
console.log("iphone-survival-contract: ok");
