#!/usr/bin/env node
import assert from "node:assert/strict";
import { test } from "node:test";
import { ABLATION_SCHEMA, LOCAL_MEMORY_BUDGET_BYTES, analyzeAblation, compareReplicates, ablationMarkdown } from "./lib/webkit-ablation-analysis.mjs";

const leg = (id, peak) => ({ id, measured: true, triggerValid: true, workloadKey: "same-recording-and-quality",
  processIdentity: `${id}:start-ticks`, targetReplaced: false, oomEvents: 0, oomKillEvents: 0,
  metrics: { cgroupPeakBytes: peak, pssPeakBytes: peak * 0.8, layerPeakBytes: peak * 0.1, swapPeakBytes: 0 } });
const fixture = () => ({ schema: ABLATION_SCHEMA,
  legs: [leg("a1", 1000), leg("b1", 500), leg("b2", 510), leg("a2", 1020)],
  comparisons: [{ id: "background", group: "background", controlIds: ["a1", "a2"], treatmentIds: ["b1", "b2"], acceptance: true }] });

test("separation must exceed drift, not just have lower treatment means", () => {
  assert.equal(compareReplicates([100, 120], [80, 90]).repeatableReduction, false);
  assert.equal(compareReplicates([100, 105], [70, 75]).repeatableReduction, true);
  assert.equal(compareReplicates([100], [50]).repeatableReduction, false);
});
test("missing metrics never become measured zeroes", () => {
  assert.equal(compareReplicates([100, 110], [null, 0]).measured, false);
  const manifest = fixture();
  delete manifest.legs[1].metrics.pssPeakBytes;
  const result = analyzeAblation(manifest);
  assert.equal(result.comparisons[0].measured, false);
  assert.match(ablationMarkdown(result), /unavailable/);
});
test("valid ABBA accepts repeated savings below the absolute budget", () => {
  const result = analyzeAblation(fixture());
  assert.equal(result.comparisons[0].accepted, true);
  assert.equal(result.rankedGroups[0].group, "background");
});
test("a flat independent ledger does not erase a whole-browser reduction", () => {
  const manifest = fixture();
  for (const value of manifest.legs) value.metrics.layerPeakBytes = 0;
  const row = analyzeAblation(manifest).comparisons[0];
  assert.equal(row.measured, true);
  assert.equal(row.metrics.layerPeakBytes.repeatableReduction, false);
  assert.equal(row.metrics.cgroupPeakBytes.repeatableReduction, true);
  assert.equal(row.accepted, true);
});
test("even large savings cannot pass an over-budget or swapping treatment", () => {
  const manifest = fixture();
  for (const value of manifest.legs) for (const metric of ["cgroupPeakBytes", "pssPeakBytes", "layerPeakBytes"]) value.metrics[metric] *= 3_000_000;
  let row = analyzeAblation(manifest).comparisons[0];
  assert.equal(row.metrics.cgroupPeakBytes.repeatableReduction, true);
  assert.equal(row.accepted, false);
  assert.equal(row.budget.limitBytes, LOCAL_MEMORY_BUDGET_BYTES);
  const swap = fixture();
  swap.legs[0].metrics.swapPeakBytes = 1;
  assert.equal(analyzeAblation(swap).comparisons[0].accepted, false);
});
test("trigger, continuity, workload, process reuse and order invalidate comparisons", () => {
  for (const change of [
    m => { m.legs[1].triggerValid = false; },
    m => { m.legs[1].measured = false; },
    m => { m.legs[1].targetReplaced = true; },
    m => { m.legs[1].workloadKey = "different-recording"; },
    m => { m.legs[1].processIdentity = m.legs[0].processIdentity; },
    m => { m.legs[1].oomKillEvents = 1; },
    m => { m.legs = [m.legs[0], m.legs[3], m.legs[1], m.legs[2]]; }
  ]) {
    const manifest = fixture(); change(manifest);
    assert.equal(analyzeAblation(manifest).comparisons[0].measured, false);
  }
});
test("exploration can rank a lead but cannot claim repeatability or acceptance", () => {
  const manifest = fixture();
  manifest.legs = manifest.legs.slice(0, 2);
  manifest.comparisons[0] = { id: "background", group: "background", controlIds: ["a1"], treatmentIds: ["b1"] };
  const row = analyzeAblation(manifest).comparisons[0];
  assert.equal(row.status, "exploratory");
  assert.equal(row.accepted, null);
});
