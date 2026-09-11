import assert from "node:assert/strict";
import test from "node:test";

import {
  ALPHA,
  abbaSchedule,
  binomialCdfHalf,
  buildBenchReport,
  buildMetricBlock,
  classifyDisplay,
  comparePairs,
  driftDiagnostic,
  foldRunPhases,
  hostWindowForLeg,
  isGeoclipKey,
  isStillKey,
  medianConfidenceInterval,
  pairLegs,
  signTest,
  spearman,
} from "./geoclip-bench-stats.mjs";

const GEOCLIP_KEY = "spine://ironclad/x.tscn?node=Visuals&anim=idle_loop&codec=webp&fps=15&q=85&geo=1&gv=1";
const STILL_KEY = "spine://ironclad/x.tscn?node=Visuals&anim=idle_loop&codec=webp&fps=15&q=85&still=1&sf=1";

// A run object exactly as SpineBakeMetrics.BuildReport writes it (HostRenderPhases.PhasesJson for `phases`).
function run({ key = GEOCLIP_KEY, phases = { load: { ms: 100, calls: 1, blocking: true }, frameAwait: { ms: 40, calls: 2, blocking: false } }, ...rest } = {}) {
  return { key, kind: "still", route: "spines", bakeMs: 140, outputBytes: 1000, frames: 1, success: true, phases, counters: null, ...rest };
}

// ---------------------------------------------------------------------------------------------------------
// Absent is unmeasured, never zero
// ---------------------------------------------------------------------------------------------------------

test("foldRunPhases splits blocking from parked", () => {
  const split = foldRunPhases(run());
  assert.equal(split.measured, true);
  assert.equal(split.blockingMs, 100);
  assert.equal(split.parkedMs, 40);
  assert.ok(Math.abs(split.blockingShare - 100 / 140) < 1e-9);
});

test("foldRunPhases reports phases:null as UNMEASURED, not as zero", () => {
  const split = foldRunPhases(run({ phases: null }));
  assert.equal(split.measured, false);
  assert.equal(split.blockingMs, null, "a null phase block must never fold to 0 ms");
  assert.equal(split.parkedMs, null);
  assert.equal(split.reason, "phases-null");
});

test("foldRunPhases refuses a non-finite phase rather than dropping it", () => {
  const split = foldRunPhases(run({ phases: { load: { ms: null, calls: 1, blocking: true } } }));
  assert.equal(split.measured, false);
  assert.match(split.reason, /non-finite/);
});

test("foldRunPhases treats an empty phase object as unmeasured", () => {
  assert.equal(foldRunPhases(run({ phases: {} })).measured, false);
});

// ---------------------------------------------------------------------------------------------------------
// Key discrimination and the missing geoclip row
// ---------------------------------------------------------------------------------------------------------

test("geoclip and still keys are told apart, and a geoclip key is never read as a still", () => {
  assert.equal(isGeoclipKey(GEOCLIP_KEY), true);
  assert.equal(isStillKey(GEOCLIP_KEY), false);
  assert.equal(isStillKey(STILL_KEY), true);
  assert.equal(isGeoclipKey(STILL_KEY), false);
});

test("a geoclip leg whose window holds no geoclip row reports hostRow absent, never a zero", () => {
  const window = hostWindowForLeg({ runs: [run({ key: STILL_KEY })] }, "geoclip");
  assert.equal(window.hostRow, "absent");
  assert.equal(window.measured, false);
  assert.equal(window.blockingMs, null);
  assert.equal(window.reason, "no-run-matched-this-lane");
  assert.deepEqual(window.keysInWindow, [STILL_KEY], "the keys that WERE in the window are reported, so the gap is diagnosable");
});

test("an empty window is distinguished from a wrong-lane window", () => {
  assert.equal(hostWindowForLeg({ runs: [] }, "geoclip").reason, "no-runs-in-window");
});

test("a window holding several matching runs reports the count and takes the newest", () => {
  const window = hostWindowForLeg({ runs: [run({ key: GEOCLIP_KEY, bakeMs: 1 }), run({ key: GEOCLIP_KEY, bakeMs: 2 })] }, "geoclip");
  assert.equal(window.matchedRuns, 2, "a contaminated window must be visible, not averaged away");
  assert.equal(window.bakeMs, 2);
});

// ---------------------------------------------------------------------------------------------------------
// Schedule and pairing
// ---------------------------------------------------------------------------------------------------------

test("abbaSchedule lays out ABBA blocks and refuses an odd pair count", () => {
  assert.deepEqual(abbaSchedule(4).map((leg) => leg.lane), ["geoclip", "raster", "raster", "geoclip", "geoclip", "raster", "raster", "geoclip"]);
  assert.deepEqual(abbaSchedule(2).map((leg) => leg.ordinal), [0, 1, 2, 3]);
  assert.throws(() => abbaSchedule(3), /even/);
  assert.throws(() => abbaSchedule(0), /positive/);
});

function leg(overrides) {
  return { block: 0, position: 0, lane: "geoclip", ordinal: 0, ok: true, producerProof: { summary: "perfRow" }, presentedLane: "geoclip", browser: { startToAfterTwoRafMs: 10 }, host: { measured: true, blockingMs: 100, parkedMs: 10 }, ...overrides };
}

test("pairLegs pairs ADJACENT legs inside each ABBA block", () => {
  const legs = abbaSchedule(2).map((entry) => leg({ ...entry, presentedLane: entry.lane }));
  const pairs = pairLegs(legs);
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs.map((pair) => pair.positions), [[0, 1], [3, 2]]);
  assert.ok(pairs.every((pair) => pair.usable));
});

test("a leg that fell back to the other lane invalidates its pair and says so", () => {
  const legs = abbaSchedule(2).map((entry) => leg({ ...entry, presentedLane: entry.lane }));
  legs[0].presentedLane = "raster";
  const pairs = pairLegs(legs);
  assert.equal(pairs[0].usable, false);
  assert.match(pairs[0].reason, /presented-raster/);
  assert.equal(pairs[1].usable, true, "only the affected pair is lost");
});

test("a leg with no producer proof invalidates its pair", () => {
  const legs = abbaSchedule(2).map((entry) => leg({ ...entry, presentedLane: entry.lane }));
  legs[1].producerProof = null;
  const pairs = pairLegs(legs);
  assert.equal(pairs[0].usable, false);
  assert.match(pairs[0].reason, /no-producer-proof/);
});

test("a failed leg invalidates its pair and carries the failure text", () => {
  const legs = abbaSchedule(2).map((entry) => leg({ ...entry, presentedLane: entry.lane }));
  legs[3].ok = false;
  legs[3].failure = "probe exit 1";
  const pairs = pairLegs(legs);
  assert.equal(pairs[1].usable, false);
  assert.match(pairs[1].reason, /probe exit 1/);
});

// ---------------------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------------------

test("binomialCdfHalf matches hand-computed values", () => {
  assert.ok(Math.abs(binomialCdfHalf(0, 8) - 1 / 256) < 1e-12);
  assert.ok(Math.abs(binomialCdfHalf(1, 8) - 9 / 256) < 1e-12);
  assert.ok(Math.abs(binomialCdfHalf(4, 8) - 163 / 256) < 1e-12);
  assert.equal(binomialCdfHalf(8, 8), 1);
  assert.equal(binomialCdfHalf(-1, 8), 0);
  // Large n stays finite and monotone in log space.
  assert.ok(binomialCdfHalf(200, 400) > 0.5 && binomialCdfHalf(200, 400) < 0.55);
});

test("the sign test is exact, two-sided, and excludes ties from n", () => {
  const all = signTest([-5, -4, -3, -2, -1, -6, -7, -8]);
  assert.equal(all.nonTiedPairs, 8);
  assert.equal(all.geoclipWins, 8);
  assert.ok(Math.abs(all.pValue - 2 / 256) < 1e-12);
  assert.equal(all.significant, true);
  assert.equal(all.direction, "geoclip-faster");

  const even = signTest([-1, 1, -1, 1]);
  assert.equal(even.pValue, 1);
  assert.equal(even.significant, false);
  assert.equal(even.direction, "even");

  const tied = signTest([0, 0, -1, -1, -1, -1, -1, -1]);
  assert.equal(tied.ties, 2);
  assert.equal(tied.nonTiedPairs, 6, "ties leave n, per the standard sign-test construction");
  assert.ok(Math.abs(tied.pValue - 2 / 64) < 1e-12);
});

test("the sign test reports raster winning just as loudly as geoclip winning", () => {
  const result = signTest([5, 4, 3, 2, 1, 6, 7, 8]);
  assert.equal(result.direction, "raster-faster");
  assert.equal(result.significant, true);
});

test("an empty comparison yields a null p-value, never a passing one", () => {
  const result = signTest([]);
  assert.equal(result.pValue, null);
  assert.equal(result.significant, false);
  assert.equal(result.direction, null);
});

test("the median CI inverts the sign test and refuses to exist when n is too small", () => {
  // n=8: the narrowest interval with coverage >= 95% is the full range, since 1 - 2*P(X<=0) = 0.992 while
  // 1 - 2*P(X<=1) = 0.930 already falls short. A tighter interval at n=8 would be an overclaim.
  const eight = medianConfidenceInterval([-8, -7, -6, -5, -4, -3, -2, -1]);
  assert.equal(eight.level, 1 - ALPHA);
  assert.equal(eight.low, -8);
  assert.equal(eight.high, -1);
  assert.match(eight.note, /order statistics 1 and 8 of 8/);
  // n=16 can afford to drop the two extremes on each side: 1 - 2*P(X<=3) = 0.979.
  const sixteen = medianConfidenceInterval(Array.from({ length: 16 }, (_, index) => index));
  assert.equal(sixteen.low, 3);
  assert.equal(sixteen.high, 12);
  const tiny = medianConfidenceInterval([-1, -2, -3]);
  assert.equal(tiny.low, null);
  assert.match(tiny.note, /too small/);
});

// ---------------------------------------------------------------------------------------------------------
// A pair with one unmeasured side leaves the comparison; it does not become a zero
// ---------------------------------------------------------------------------------------------------------

test("comparePairs drops a pair whose host row was unmeasured and names it", () => {
  const legs = abbaSchedule(2).map((entry) => leg({
    ...entry,
    presentedLane: entry.lane,
    host: { measured: true, blockingMs: entry.lane === "geoclip" ? 150 : 260, parkedMs: 10 },
  }));
  legs[0].host = { measured: false, blockingMs: null, parkedMs: null, reason: "phases-null" };
  const pairs = pairLegs(legs);
  const metric = comparePairs(pairs, (item) => (item?.host?.measured ? item.host.blockingMs : null), { metric: "host" });
  assert.equal(metric.measuredPairs, 1);
  assert.equal(metric.unmeasuredPairs, 1);
  assert.equal(metric.unmeasuredDetail[0].geoclipReason, "phases-null");
  assert.equal(metric.signTest.nonTiedPairs, 1, "the unmeasured pair contributes no sign, not a tie and not a win");
});

test("buildMetricBlock puts both gate metrics first and labels them as gates", () => {
  const block = buildMetricBlock(pairLegs(abbaSchedule(2).map((entry) => leg({ ...entry, presentedLane: entry.lane }))));
  assert.match(block.hostBlockingMs.metric, /^GATE/);
  assert.match(block.browserFirstFrameMs.metric, /^GATE/);
  assert.match(block.hostParkedMs.metric, /^context/);
  assert.equal(block.transferBytes.unit, "bytes");
});

// ---------------------------------------------------------------------------------------------------------
// Display eligibility
// ---------------------------------------------------------------------------------------------------------

test("Xvfb is refused a cross-lane verdict, with the reason stated", () => {
  const verdict = classifyDisplay({ display: ":99", xServerCommand: "/usr/bin/Xvfb :99 -screen 0 2560x1440x24", glRenderer: "llvmpipe" });
  assert.equal(verdict.xvfbDetected, true);
  assert.equal(verdict.verdictEligible, false);
  assert.ok(verdict.blockers.some((blocker) => blocker.startsWith("xvfb-display")));
  assert.ok(verdict.blockers.some((blocker) => blocker.startsWith("software-gl")));
});

test("a private gamescope compositor on real hardware is eligible", () => {
  const verdict = classifyDisplay({
    display: ":4",
    xServerCommand: "/usr/bin/Xwayland :4 -rootless",
    glRenderer: "NVIDIA GeForce RTX 2060/PCIe/SSE2",
    gamescopeCommand: "gamescope --backend headless -W 1920 -H 1080",
  });
  assert.equal(verdict.verdictEligible, true);
  assert.deepEqual(verdict.blockers, []);
});

test("gamescope's own selected Vulkan device is enough GPU evidence when glxinfo is not installed", () => {
  const verdict = classifyDisplay({
    display: ":2",
    xServerCommand: "/usr/bin/Xwayland :2 -rootless -terminate",
    glRenderer: null,
    vulkanDevice: "NVIDIA GeForce RTX 2060",
    gamescopeCommand: "gamescope --backend headless",
  });
  assert.equal(verdict.verdictEligible, true, "this box has no glxinfo; the compositor's own log is the evidence");
});

test("no renderer evidence at all is a BLOCKER, not a silent pass", () => {
  const verdict = classifyDisplay({
    display: ":2",
    xServerCommand: "/usr/bin/Xwayland :2",
    glRenderer: null,
    vulkanDevice: null,
    gamescopeCommand: "gamescope --backend headless",
  });
  assert.equal(verdict.verdictEligible, false);
  assert.ok(verdict.blockers.some((blocker) => blocker.startsWith("gpu-unverified")));
});

test("an unidentifiable X server is not quietly assumed to be fine", () => {
  const verdict = classifyDisplay({ display: ":0", xServerCommand: null, glRenderer: "NVIDIA GeForce RTX 2060" });
  assert.equal(verdict.verdictEligible, false);
  assert.ok(verdict.blockers.some((blocker) => blocker.startsWith("unidentified-display")));
});

test("every software rasteriser this box can produce is caught, on either evidence channel", () => {
  for (const renderer of ["llvmpipe (LLVM 15)", "SwiftShader Device", "softpipe", "swrast", "lavapipe"]) {
    for (const field of ["glRenderer", "vulkanDevice"]) {
      const verdict = classifyDisplay({ display: ":4", xServerCommand: "Xwayland :4", [field]: renderer, gamescopeCommand: "gamescope" });
      assert.equal(verdict.verdictEligible, false, `${renderer} via ${field} should be refused`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------
// The report's verdict gating
// ---------------------------------------------------------------------------------------------------------

function creatureWith(overrides = {}, pairs = 8) {
  const legs = abbaSchedule(pairs).map((entry, index) => leg({
    ...entry,
    presentedLane: entry.lane,
    // geoclip deliberately faster on both metrics, so a PASS is reachable and a wrongly-suppressed pass is visible.
    browser: { startToAfterTwoRafMs: entry.lane === "geoclip" ? 20 + index * 0.1 : 40 + index * 0.1 },
    host: { measured: true, blockingMs: entry.lane === "geoclip" ? 150 + index : 260 + index, parkedMs: 10 },
    ...overrides,
  }));
  return { id: "ironclad", scene: "res://x.tscn", node: "Visuals", anim: "idle_loop", legs, pairs: pairLegs(legs) };
}

const CLEAN_ENV = { verdictEligible: true, blockers: [] };

test("a clean, significant, eligible run passes both halves of the gate", () => {
  const report = buildBenchReport({ generatedAt: "t", environment: CLEAN_ENV, target: {}, design: {}, overhead: {}, creatures: [creatureWith()] });
  assert.equal(report.verdict.eligible, true);
  assert.equal(report.verdict.hostBlockingGate, "geoclip-faster");
  assert.equal(report.verdict.browserFirstFrameGate, "geoclip-faster");
  assert.equal(report.verdict.overall, "GEOCLIP-PASSES");
});

test("one half losing fails the whole gate", () => {
  const creature = creatureWith();
  for (const item of creature.legs) if (item.lane === "geoclip") item.browser.startToAfterTwoRafMs = 400;
  creature.pairs = pairLegs(creature.legs);
  const report = buildBenchReport({ generatedAt: "t", environment: CLEAN_ENV, target: {}, design: {}, overhead: {}, creatures: [creature] });
  assert.equal(report.verdict.browserFirstFrameGate, "raster-faster");
  assert.equal(report.verdict.overall, "GEOCLIP-FAILS");
});

test("a missing geoclip host row blocks the verdict instead of scoring geoclip as free", () => {
  const creature = creatureWith();
  for (const item of creature.legs) if (item.lane === "geoclip") item.host = { hostRow: "absent", measured: false, blockingMs: null, parkedMs: null, reason: "no-runs-in-window" };
  creature.pairs = pairLegs(creature.legs);
  const report = buildBenchReport({ generatedAt: "t", environment: CLEAN_ENV, target: {}, design: {}, overhead: {}, creatures: [creature] });
  assert.equal(report.verdict.overall, "NOT-DECIDED");
  assert.ok(report.verdict.blockers.some((blocker) => blocker.startsWith("host-row-absent")));
  assert.equal(report.aggregate.metrics.hostBlockingMs.measuredPairs, 0);
  assert.equal(report.aggregate.metrics.hostBlockingMs.unmeasuredPairs, 8);
});

test("an ineligible display blocks the verdict even when both halves look like wins", () => {
  const report = buildBenchReport({
    generatedAt: "t",
    environment: { verdictEligible: false, blockers: ["xvfb-display: ..."] },
    target: {}, design: {}, overhead: {}, creatures: [creatureWith()],
  });
  assert.equal(report.verdict.overall, "NOT-DECIDED");
  assert.equal(report.verdict.hostBlockingGate, "NOT-DECIDED");
});

test("a gate that lost some pairs to unmeasured readings is NOT-DECIDED, not 'no significant difference'", () => {
  const creature = creatureWith();
  // Half the geoclip legs come back with phases:null — the pairs stay usable, but the host number is gone.
  for (const [index, item] of creature.legs.entries()) {
    if (item.lane === "geoclip" && index % 4 === 0) item.host = { measured: false, blockingMs: null, parkedMs: null, reason: "phases-null" };
  }
  creature.pairs = pairLegs(creature.legs);
  const report = buildBenchReport({ generatedAt: "t", environment: CLEAN_ENV, target: {}, design: {}, overhead: {}, creatures: [creature] });
  assert.ok(report.aggregate.metrics.hostBlockingMs.measuredPairs > 0, "some pairs did survive");
  assert.ok(report.aggregate.metrics.hostBlockingMs.unmeasuredPairs > 0, "and some did not");
  const blocker = report.verdict.blockers.find((entry) => entry.startsWith("incomplete-gate-data"));
  assert.ok(blocker, "the loss must block the verdict");
  assert.match(blocker, /phases-null/, "and must name why the readings were missing");
  assert.equal(report.verdict.overall, "NOT-DECIDED");
});

test("too few usable pairs blocks the verdict", () => {
  const report = buildBenchReport({ generatedAt: "t", environment: CLEAN_ENV, target: {}, design: {}, overhead: {}, creatures: [creatureWith({}, 2)] });
  assert.ok(report.verdict.blockers.some((blocker) => blocker.startsWith("insufficient-pairs")));
  assert.equal(report.verdict.overall, "NOT-DECIDED");
});

test("the report always carries its own limits", () => {
  const report = buildBenchReport({ generatedAt: "t", environment: CLEAN_ENV, target: {}, design: {}, overhead: {}, creatures: [creatureWith()] });
  assert.ok(report.limits.length >= 8);
  assert.ok(report.limits.some((limit) => limit.includes("scanout")));
  assert.ok(report.limits.some((limit) => limit.includes("visual correctness")));
});

// ---------------------------------------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------------------------------------

test("spearman finds a monotone drift and ignores a flat series", () => {
  assert.equal(spearman([0, 1, 2, 3], [1, 2, 3, 4]), 1);
  assert.equal(spearman([0, 1, 2, 3], [4, 3, 2, 1]), -1);
  assert.equal(spearman([0, 1, 2, 3], [5, 5, 5, 5]), null);
});

test("driftDiagnostic reports per lane and says when there is too little data", () => {
  const legs = abbaSchedule(4).map((entry, index) => leg({ ...entry, browser: { startToAfterTwoRafMs: 10 + index } }));
  const drift = driftDiagnostic(legs, (item) => item.browser?.startToAfterTwoRafMs ?? null);
  assert.equal(drift.geoclip.n, 4);
  assert.ok(drift.geoclip.spearman > 0);
  assert.equal(driftDiagnostic(legs.slice(0, 2), (item) => item.browser?.startToAfterTwoRafMs ?? null).geoclip.note, "too few points");
});
