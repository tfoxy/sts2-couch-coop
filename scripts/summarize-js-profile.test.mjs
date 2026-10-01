import assert from "node:assert/strict";
import test from "node:test";
import { summarizeV8Profile } from "./summarize-js-profile.mjs";

// A tiny synthetic CDP Profiler.Profile: root(1) -> a(2) -> b(3, JS hot leaf)
//                                                 -> c(4, wasm leaf)
//                         root(1) -> gc(5)        root(1) -> program(6)   root(1) -> idle(7)
function buildProfile() {
  const nodes = [
    { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 }, children: [2, 4, 5, 6, 7] },
    { id: 2, callFrame: { functionName: "a", url: "app.js", lineNumber: 9 }, children: [3] },
    { id: 3, callFrame: { functionName: "b", url: "app.js", lineNumber: 19 }, children: [] },
    { id: 4, callFrame: { functionName: "wasm_fn", url: "blob:rust_prototype_bg.wasm", lineNumber: 0 }, children: [] },
    { id: 5, callFrame: { functionName: "(garbage collector)", url: "", lineNumber: -1 }, children: [] },
    { id: 6, callFrame: { functionName: "(program)", url: "", lineNumber: -1 }, children: [] },
    { id: 7, callFrame: { functionName: "(idle)", url: "", lineNumber: -1 }, children: [] },
  ];
  // samples: b x3, wasm_fn x2, gc x1, program x1, idle x1, plus one unresolved id (99)
  const samples = [3, 3, 3, 4, 4, 5, 6, 7, 99];
  const timeDeltas = [100, 100, 100, 100, 100, 100, 100, 100, -5];
  return { nodes, samples, timeDeltas, startTime: 0, endTime: 900 };
}

test("summarizeV8Profile counts self and inclusive samples with url:line labels", () => {
  const result = summarizeV8Profile(buildProfile(), { top: 10 });
  assert.equal(result.sampleCount, 9);
  assert.equal(result.unresolvedNodeIds, 1);

  const selfB = result.exclusiveSelfSamplesTop.find((r) => r.label === "b app.js:20");
  assert.ok(selfB, "b's self count present with 1-based line number");
  assert.equal(selfB.count, 3);

  // inclusive: every sample whose stack passes through `a` (id 2) counts once per sample, deduped per sample
  const inclusiveA = result.inclusiveSamplesTop.find((r) => r.label === "a app.js:10");
  assert.ok(inclusiveA);
  assert.equal(inclusiveA.count, 3);

  const inclusiveRoot = result.inclusiveSamplesTop.find((r) => r.label === "(root)");
  assert.equal(inclusiveRoot.count, 8); // every resolved sample passes through root
});

test("summarizeV8Profile splits samples into js / wasm / gc / program / idle by leaf frame", () => {
  const result = summarizeV8Profile(buildProfile(), { top: 10 });
  assert.deepEqual(result.categories, { js: 3, wasm: 2, gc: 1, program: 1, idle: 1 });
});

test("summarizeV8Profile reports timeDeltas validity as a diagnostic only, never as ms", () => {
  const result = summarizeV8Profile(buildProfile(), { top: 10 });
  assert.equal(result.timeDeltasDiagnostic.count, 9);
  assert.equal(result.timeDeltasDiagnostic.nonpositive, 1);
  assert.equal(result.timeDeltasDiagnostic.negative, 1);
  assert.equal(result.timeDeltasDiagnostic.valid, false);
  assert.ok(!("ms" in result.timeDeltasDiagnostic));
});

test("summarizeV8Profile honors --top", () => {
  const result = summarizeV8Profile(buildProfile(), { top: 1 });
  assert.equal(result.exclusiveSelfSamplesTop.length, 1);
  assert.equal(result.exclusiveSelfSamplesTop[0].label, "b app.js:20");
});
