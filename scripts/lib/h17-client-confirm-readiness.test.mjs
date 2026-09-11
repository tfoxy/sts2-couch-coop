import assert from "node:assert/strict";
import test from "node:test";

import { assessClientConfirm, selectMirrorModuleBundle } from "./h17-client-confirm-readiness.mjs";

const stage = { x: 0, y: 0, width: 2400, height: 1080 };
const viewport = { width: 2400, height: 1080 };

test("an entering Confirm with a nonzero offscreen rectangle is visible but not tappable", () => {
  const confirm = assessClientConfirm({
    present: true,
    display: "block",
    visibility: "visible",
    box: { x: 2420, y: 726, width: 200, height: 110 },
    stage,
    viewport,
    hitTestMatches: false
  });

  assert.equal(confirm.visible, true);
  assert.equal(confirm.tappable, false);
  assert.equal(confirm.inViewport, false);
});

test("a resting Confirm needs its intended point to win elementFromPoint", () => {
  const raw = {
    present: true,
    display: "block",
    visibility: "visible",
    box: { x: 2200, y: 726, width: 200, height: 110 },
    stage,
    viewport
  };
  assert.equal(assessClientConfirm({ ...raw, hitTestMatches: false }).tappable, false);
  const ready = assessClientConfirm({ ...raw, hitTestMatches: true });
  assert.equal(ready.tappable, true);
  assert.deepEqual(ready.tapPoint, { x: 2300, y: 781 });
});

test("logical teardown remains distinct from physical hit testing", () => {
  const hidden = assessClientConfirm({ present: false, display: "none", visibility: "hidden", box: null, stage, viewport });
  assert.equal(hidden.visible, false);
  assert.equal(hidden.tappable, false);
});

test("freshness names the direct MirrorApp module on Vite and the real page entry in production", () => {
  const vite = selectMirrorModuleBundle({
    scriptSrcs: ["http://host/@vite/client", "http://host/src/main.ts"],
    resourceUrls: ["http://host/@vite/client", "http://host/src/main.ts", "http://host/src/mirror/MirrorApp.vue?t=123"]
  });
  assert.deepEqual(vite, { kind: "mirror-app-module", url: "http://host/src/mirror/MirrorApp.vue?t=123" });

  const production = selectMirrorModuleBundle({
    scriptSrcs: ["https://host/assets/index-abcd.js"],
    resourceUrls: ["https://host/assets/index-abcd.js"]
  });
  assert.deepEqual(production, { kind: "page-module-entry", url: "https://host/assets/index-abcd.js" });
});
