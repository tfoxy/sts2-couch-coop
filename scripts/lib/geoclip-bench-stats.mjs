// PURE half of the KNIGHTS_ELITE geoclip-vs-raster gate (scripts/bench-geoclip-knights.mjs).
//
// Everything here is a total function over plain data: no fs, no network, no clock. That is deliberate — the
// round is graded on this verdict, so the arithmetic that produces it has to be checkable offline against
// fixtures, including the fixtures for every way the measurement can be WRONG. See
// geoclip-bench-stats.test.mjs, which covers the four documented failure modes (missing host row, phases:null,
// an Xvfb display, a leg that never reached the producer) alongside the happy path.
//
// THREE RULES THIS FILE ENFORCES, because each has already cost this project a round:
//
//  1. ABSENT IS UNMEASURED, NEVER ZERO. A run object with `phases: null` (qa-recipes §"Render phase breakdown")
//     means the lane was not recording. It is returned as `{ measured: false, blockingMs: null }` and it
//     REMOVES its pair from the host comparison; it never contributes a 0 ms that would flatter geoclip.
//  2. A RESPONSE IS NOT A PRODUCE. A leg carries `producerProof`; a leg without one is excluded and named.
//     A generic 404 from an unresolvable cache root and a real refusal look identical on the wire.
//  3. AN XVFB NUMBER IS NOT A CROSS-LANE VERDICT. Xvfb prices an awaited engine frame ~20x, and the two lanes
//     await different numbers of frames, so the comparison is formally invalid there (qa-recipes §2.x). The
//     report still prints, stamped NON-VERDICT.

/** Improvement direction for every metric in this bench: lower is better, so geoclip wins when delta < 0. */
export const LOWER_IS_BETTER = "lower-is-better";

/** The alpha the gate is decided at. Two-sided, because geoclip losing is as reportable as geoclip winning. */
export const ALPHA = 0.05;

/**
 * The round's design floor, per creature, straight from the approved plan.
 *
 * Worth knowing while reading a result: at n=8 the sign test still requires UNANIMITY. 8-0 gives p = 0.0078,
 * but 7-1 gives 0.0703, which does not clear 0.05. The first n with any headroom is 10 (9-1 gives 0.0215). So a
 * creature that loses one leg to noise at n=8 lands on "no significant difference", not on a weak win — raise
 * --pairs if a lane is expected to be close.
 */
export const MINIMUM_PAIRS_PER_CREATURE = 8;

// ---------------------------------------------------------------------------------------------------------
// Host side: one /perf/spine.json window per leg
// ---------------------------------------------------------------------------------------------------------

/**
 * The blocking / parked split of ONE recorded bake, from its `runs[]` entry.
 *
 * `run.phases` is `{ <phase>: { ms, calls, blocking } }` or null (HostRenderPhases.PhasesJson). Blocking is the
 * Godot main thread held — the stall the player on the TV sees; parked is a frame await, the extraction gate or
 * disk, which costs the requesting client only. Returns `measured: false` rather than zeros when the lane was
 * not recording, which is the entire point of this function.
 */
export function foldRunPhases(run) {
  if (!run || typeof run !== "object") {
    return { measured: false, blockingMs: null, parkedMs: null, blockingShare: null, reason: "no-run" };
  }
  const phases = run.phases;
  if (phases === null || phases === undefined) {
    return { measured: false, blockingMs: null, parkedMs: null, blockingShare: null, reason: "phases-null" };
  }
  if (typeof phases !== "object" || Array.isArray(phases)) {
    return { measured: false, blockingMs: null, parkedMs: null, blockingShare: null, reason: "phases-malformed" };
  }
  let blockingMs = 0;
  let parkedMs = 0;
  let counted = 0;
  for (const [name, cost] of Object.entries(phases)) {
    const ms = cost?.ms;
    if (typeof ms !== "number" || !Number.isFinite(ms)) {
      return { measured: false, blockingMs: null, parkedMs: null, blockingShare: null, reason: `phase-${name}-non-finite` };
    }
    if (cost.blocking === true) blockingMs += ms;
    else parkedMs += ms;
    counted += 1;
  }
  if (counted === 0) {
    return { measured: false, blockingMs: null, parkedMs: null, blockingShare: null, reason: "phases-empty" };
  }
  const attributed = blockingMs + parkedMs;
  return {
    measured: true,
    blockingMs,
    parkedMs,
    blockingShare: attributed > 0 ? blockingMs / attributed : null,
    phaseCount: counted,
    reason: null,
  };
}

/** Does a recorded bake key address the geoclip artifact for an identity, rather than its raster clip/still? */
export function isGeoclipKey(key) {
  return typeof key === "string" && key.includes("&geo=1");
}

/** Does a recorded bake key address a single-frame STILL (the shipped raster baseline)? */
export function isStillKey(key) {
  return typeof key === "string" && key.includes("&still=") && !isGeoclipKey(key);
}

/**
 * Reduce one drained `/perf/spine.json` report to the single bake this leg was supposed to cause.
 *
 * The window is drained with `reset=1` immediately before and after the leg, so in a quiet host it holds exactly
 * one run. More than one means something else baked concurrently: reported, not averaged away.
 *
 * `lane` selects the key predicate. A geoclip leg whose window holds no geoclip row is the WS-B instrumentation
 * gap: `hostRow: "absent"`, which is a hard error upstream — never a zero.
 */
export function hostWindowForLeg(report, lane) {
  const runs = Array.isArray(report?.runs) ? report.runs : [];
  const predicate = lane === "geoclip" ? isGeoclipKey : isStillKey;
  const matched = runs.filter((run) => predicate(run?.key));
  if (matched.length === 0) {
    return {
      hostRow: "absent",
      runsInWindow: runs.length,
      keysInWindow: runs.map((run) => run?.key ?? null),
      matchedRuns: 0,
      measured: false,
      blockingMs: null,
      parkedMs: null,
      bakeMs: null,
      success: null,
      reason: runs.length === 0 ? "no-runs-in-window" : "no-run-matched-this-lane",
    };
  }
  // Deliberately the LAST matching run: if a window somehow holds two, the one this leg caused is the newest.
  const run = matched[matched.length - 1];
  const split = foldRunPhases(run);
  return {
    hostRow: "present",
    runsInWindow: runs.length,
    keysInWindow: runs.map((r) => r?.key ?? null),
    matchedRuns: matched.length,
    key: run.key ?? null,
    kind: run.kind ?? null,
    route: run.route ?? null,
    success: run.success === true,
    bakeMs: typeof run.bakeMs === "number" ? run.bakeMs : null,
    outputBytes: typeof run.outputBytes === "number" ? run.outputBytes : null,
    measured: split.measured,
    blockingMs: split.blockingMs,
    parkedMs: split.parkedMs,
    blockingShare: split.blockingShare,
    reason: split.reason,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Schedule and pairing
// ---------------------------------------------------------------------------------------------------------

/**
 * The ABBA leg order for one creature. `pairs` pairs per lane; each ABBA block contributes two.
 *
 * ABBA rather than alternating AB: a monotone drift (thermal, cache growth, the host's own memory) biases every
 * A-then-B pair in the same direction, while an A B B A block cancels a linear trend to first order. The pairing
 * rule below relies on this layout, so the two must be read together.
 */
export function abbaSchedule(pairs, lanes = ["geoclip", "raster"]) {
  if (!Number.isInteger(pairs) || pairs < 1) throw new Error(`pairs must be a positive integer, got ${pairs}`);
  if (pairs % 2 !== 0) throw new Error(`pairs must be even so every ABBA block is complete, got ${pairs}`);
  const [a, b] = lanes;
  const legs = [];
  const blocks = pairs / 2;
  for (let block = 0; block < blocks; block += 1) {
    // A B B A. Position 0 pairs with 1, position 3 pairs with 2 — see pairLegs.
    for (const [position, lane] of [a, b, b, a].entries()) {
      legs.push({ block, position, lane, ordinal: legs.length });
    }
  }
  return legs;
}

/**
 * Pair the legs of one creature. Within each ABBA block the two pairs are (pos 0, pos 1) and (pos 3, pos 2) —
 * i.e. each pair is two ADJACENT legs, which is what makes the block cancel drift.
 *
 * A leg that is missing, fell back to the other lane, or carries no producer proof invalidates its pair; the
 * pair is returned with `usable: false` and the reason, so the report can name what it lost instead of quietly
 * shrinking n.
 */
export function pairLegs(legs) {
  const byKey = new Map();
  for (const leg of legs) byKey.set(`${leg.block}:${leg.position}`, leg);
  const blocks = new Set(legs.map((leg) => leg.block));
  const pairs = [];
  for (const block of [...blocks].sort((x, y) => x - y)) {
    for (const [first, second] of [[0, 1], [3, 2]]) {
      const a = byKey.get(`${block}:${first}`);
      const b = byKey.get(`${block}:${second}`);
      if (!a || !b) {
        pairs.push({ block, positions: [first, second], usable: false, reason: "leg-missing", legs: [a ?? null, b ?? null] });
        continue;
      }
      const problems = [];
      for (const leg of [a, b]) {
        if (leg.ok !== true) problems.push(`${leg.lane}:${leg.failure ?? "not-ok"}`);
        else if (leg.producerProof === null || leg.producerProof === undefined) problems.push(`${leg.lane}:no-producer-proof`);
        else if (leg.presentedLane && leg.presentedLane !== leg.lane) problems.push(`${leg.lane}:presented-${leg.presentedLane}`);
      }
      pairs.push(problems.length > 0
        ? { block, positions: [first, second], usable: false, reason: problems.join(","), legs: [a, b] }
        : { block, positions: [first, second], usable: true, reason: null, legs: [a, b], byLane: { [a.lane]: a, [b.lane]: b } });
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------------------

/** P(X <= k) for X ~ Binomial(n, 0.5). Log-space terms so n in the hundreds is still exact to double precision. */
export function binomialCdfHalf(k, n) {
  if (!Number.isInteger(n) || n < 0) throw new Error(`n must be a non-negative integer, got ${n}`);
  if (k < 0) return 0;
  if (k >= n) return 1;
  let logTerm = -n * Math.LN2;
  let sum = Math.exp(logTerm);
  for (let i = 1; i <= k; i += 1) {
    logTerm += Math.log((n - i + 1) / i);
    sum += Math.exp(logTerm);
  }
  return Math.min(1, sum);
}

/**
 * Exact two-sided paired SIGN test on `deltas` (geoclip minus raster, so a negative delta is a geoclip win).
 *
 * The sign test rather than a t-test on purpose: bake and first-frame times are heavy-tailed and bounded below,
 * a mean is dominated by whichever lane happened to hit a GC or a resource load, and the question the user asked
 * ("does geoclip beat the still?") is exactly a question about which side wins more often. Ties are EXCLUDED
 * from n, per the standard construction, and reported so a reader can see if the test was decided on few pairs.
 */
export function signTest(deltas) {
  const finite = deltas.filter((d) => typeof d === "number" && Number.isFinite(d));
  const wins = finite.filter((d) => d < 0).length;
  const losses = finite.filter((d) => d > 0).length;
  const ties = finite.length - wins - losses;
  const n = wins + losses;
  const p = n === 0 ? null : Math.min(1, 2 * binomialCdfHalf(Math.min(wins, losses), n));
  return {
    test: "exact two-sided paired sign test",
    pairs: finite.length,
    nonTiedPairs: n,
    geoclipWins: wins,
    rasterWins: losses,
    ties,
    pValue: p,
    significantAt: ALPHA,
    significant: p !== null && p < ALPHA,
    direction: n === 0 ? null : wins > losses ? "geoclip-faster" : losses > wins ? "raster-faster" : "even",
  };
}

function sorted(values) {
  return [...values].sort((a, b) => a - b);
}

export function median(values) {
  if (values.length === 0) return null;
  const s = sorted(values);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentile(values, q) {
  if (values.length === 0) return null;
  const s = sorted(values);
  const index = (s.length - 1) * q;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return low === high ? s[low] : s[low] + (s[high] - s[low]) * (index - low);
}

/**
 * Distribution-free confidence interval for the MEDIAN of the paired differences — the order-statistic interval
 * that inverts the sign test above, so the interval and the p-value can never disagree. Null when n is too small
 * for any interval to exclude anything (n < 6 at alpha 0.05), which is itself worth printing.
 */
export function medianConfidenceInterval(deltas, alpha = ALPHA) {
  const finite = sorted(deltas.filter((d) => typeof d === "number" && Number.isFinite(d)));
  const n = finite.length;
  if (n === 0) return { level: 1 - alpha, low: null, high: null, note: "no pairs" };
  let k = -1;
  for (let candidate = 0; candidate <= Math.floor((n - 1) / 2); candidate += 1) {
    if (binomialCdfHalf(candidate, n) <= alpha / 2) k = candidate;
    else break;
  }
  if (k < 0) {
    return { level: 1 - alpha, low: null, high: null, note: `n=${n} is too small for a ${(1 - alpha) * 100}% sign interval` };
  }
  return {
    level: 1 - alpha,
    low: finite[k],
    high: finite[n - 1 - k],
    note: `order statistics ${k + 1} and ${n - k} of ${n} paired differences`,
  };
}

/**
 * One metric's paired comparison, from a list of usable pairs and an extractor that answers a number or null.
 *
 * A pair where EITHER side is null is dropped and counted in `unmeasuredPairs` — that is how a `phases: null`
 * host row leaves the comparison rather than becoming a zero.
 */
export function comparePairs(pairs, extract, { metric, unit = "ms" } = {}) {
  const usable = pairs.filter((pair) => pair.usable);
  const rows = [];
  let unmeasured = 0;
  const unmeasuredReasons = [];
  for (const pair of usable) {
    const geoclip = extract(pair.byLane.geoclip);
    const raster = extract(pair.byLane.raster);
    if (typeof geoclip !== "number" || !Number.isFinite(geoclip) || typeof raster !== "number" || !Number.isFinite(raster)) {
      unmeasured += 1;
      unmeasuredReasons.push({
        block: pair.block,
        positions: pair.positions,
        geoclip: geoclip ?? null,
        raster: raster ?? null,
        geoclipReason: pair.byLane.geoclip?.host?.reason ?? null,
        rasterReason: pair.byLane.raster?.host?.reason ?? null,
      });
      continue;
    }
    rows.push({ block: pair.block, positions: pair.positions, geoclip, raster, delta: geoclip - raster });
  }
  const deltas = rows.map((row) => row.delta);
  const geoclipValues = rows.map((row) => row.geoclip);
  const rasterValues = rows.map((row) => row.raster);
  return {
    metric: metric ?? null,
    unit,
    direction: LOWER_IS_BETTER,
    measuredPairs: rows.length,
    unmeasuredPairs: unmeasured,
    unmeasuredDetail: unmeasuredReasons,
    geoclip: { p50: median(geoclipValues), p95: percentile(geoclipValues, 0.95), max: geoclipValues.length ? Math.max(...geoclipValues) : null },
    raster: { p50: median(rasterValues), p95: percentile(rasterValues, 0.95), max: rasterValues.length ? Math.max(...rasterValues) : null },
    medianPairedDelta: median(deltas),
    pairedDeltaCI: medianConfidenceInterval(deltas),
    signTest: signTest(deltas),
    pairedRows: rows,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Display eligibility
// ---------------------------------------------------------------------------------------------------------

const SOFTWARE_RENDERERS = ["llvmpipe", "softpipe", "swrast", "swiftshader", "lavapipe"];

/**
 * Is this display allowed to decide a CROSS-LANE wall-clock verdict?
 *
 * No, under Xvfb, and no under a software GL stack. qa-recipes §2.x measures Xvfb pricing an awaited engine
 * frame ~20x the desktop's (ForceDraw 27 -> 595 ms per 8 draws); a geoclip bake and a raster still await
 * different numbers of frames, so the distortion does not cancel and the comparison manufactures a verdict.
 * The bench still RUNS there — the plumbing, the producer proofs and the correctness of the legs are all
 * checkable — it just may not conclude.
 */
export function classifyDisplay({ display = null, xServerCommand = null, glRenderer = null, vulkanDevice = null, gamescopeCommand = null, forcedXvfb = null } = {}) {
  const blockers = [];
  const command = (xServerCommand ?? "").toLowerCase();
  const xvfb = forcedXvfb ?? /(^|\/|\s)xvfb\b/.test(command);
  if (xvfb) blockers.push("xvfb-display: Xvfb prices an awaited engine frame ~20x (qa-recipes §2.x); the two lanes await different frame counts, so a cross-lane wall-clock verdict from it is formally invalid");
  const software = [glRenderer, vulkanDevice]
    .filter((name) => typeof name === "string")
    .flatMap((name) => SOFTWARE_RENDERERS.filter((needle) => name.toLowerCase().includes(needle)).map((needle) => ({ needle, name })));
  for (const hit of software) blockers.push(`software-gl: the renderer reports "${hit.name}", so this is not the real GPU`);
  const gamescope = typeof gamescopeCommand === "string" && gamescopeCommand.length > 0;
  if (!gamescope && !xvfb && xServerCommand === null) {
    blockers.push("unidentified-display: the harness could not identify the X server behind DISPLAY, so it cannot certify the display is a private gamescope compositor");
  }
  // ABSENT IS UNMEASURED HERE TOO. glxinfo is not installed on every box, and a null renderer string would
  // otherwise sail through the software check as if it had passed it. A verdict needs POSITIVE evidence of a
  // real GPU — either a GL renderer string or the Vulkan device gamescope logged that it selected.
  if (glRenderer === null && vulkanDevice === null) {
    blockers.push("gpu-unverified: neither a GL renderer string nor a selected Vulkan device could be read, so this run has no positive evidence it used the real GPU rather than a software rasteriser");
  }
  return {
    display,
    xServerCommand,
    glRenderer,
    vulkanDevice,
    gamescopeCommand,
    xvfbDetected: xvfb,
    softwareRenderer: software.length > 0 ? software[0].name : null,
    gamescopeDetected: gamescope,
    verdictEligible: blockers.length === 0,
    blockers,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------------------------------------

export const SCHEMA = "geoclip-knights-bench/1";

/**
 * What this bench CANNOT establish. Carried inside the report, not only in a summary, because a JSON file
 * outlives the message that shipped it and this list is the part a later reader most needs.
 */
export const LIMITS = [
  "It does not establish visual correctness. A leg is graded on producing data, not on the creature looking right; the Stage 2 ablation strip is the only evidence that a creature is drawn from geometry.",
  "It does not measure display scanout. The browser metric ends after two requestAnimationFrame callbacks (docs/agents/geoclip-browser-probe.md); that is a presentation proxy, not a frame-pacing or scanout claim.",
  "It does not measure the shipped client. The probe imports geoclipPlayer/spineClip from source into a bare page; it is not MirrorView, so it prices neither the reconciler nor the deferred-raster path around them.",
  "Its asset timings include a local Vite/proxy hop, identically in both lanes; they are not raw host-socket timings.",
  "Host blockingMs is spirectl's own phase attribution, not an external profiler. Unattributed host time exists and is excluded from the split by construction.",
  "The host CPU figures in /perf/spine.json are process-wide (Process.TotalProcessorTime), so they are an upper bound on the lane, not the lane in isolation.",
  "It says nothing about a warm cache. Every leg is a forced cold produce; the steady-state cost of either lane after a prerender sweep is a different measurement.",
  "One host, one GPU, one encounter, one character. Nothing here generalises to a phone, to another encounter, or to several clients asking at once.",
  "A pair is only as cold as the clear that preceded it. The harness proves it deleted what the previous leg created; it cannot prove the host held no other state.",
];

/**
 * Assemble the final report. `metricSpecs` decides what is compared; the two gate metrics are fixed by the
 * round's acceptance bar and the rest are context.
 */
export function buildBenchReport({
  generatedAt,
  environment,
  target,
  design,
  overhead,
  preflight = null,
  creatures,
  animatedClipContext = null,
  notes = [],
}) {
  const allPairs = creatures.flatMap((creature) => creature.pairs ?? []);
  const aggregate = {
    creatures: creatures.length,
    pairs: allPairs.length,
    usablePairs: allPairs.filter((pair) => pair.usable).length,
    metrics: buildMetricBlock(allPairs),
  };

  const blockers = [...(environment?.blockers ?? [])];
  const hostAbsent = creatures.flatMap((c) => c.legs ?? []).filter((leg) => leg.lane === "geoclip" && leg.host?.hostRow === "absent");
  if (hostAbsent.length > 0) {
    blockers.push(
      `host-row-absent: ${hostAbsent.length} geoclip leg(s) produced no /perf/spine.json row. The geoclip lane is not wired into SpineBakeMetrics (WS-B). This is UNMEASURED, not zero: the host half of the gate cannot be decided.`);
  }
  const noProof = creatures.flatMap((c) => c.legs ?? []).filter((leg) => leg.ok && !leg.producerProof);
  if (noProof.length > 0) {
    blockers.push(`no-producer-proof: ${noProof.length} leg(s) returned a response without entering the producer (no new /perf row, no cache write, no refusal receipt). Those legs measured a cache hit or an unresolvable route, not a produce.`);
  }
  // Per creature, not only in aggregate: three healthy creatures cannot make up for a fourth that produced two
  // usable pairs, and an aggregate-only check would let them.
  const thin = creatures
    .map((creature) => ({ id: creature.id, usable: (creature.pairs ?? []).filter((pair) => pair.usable).length }))
    .filter((creature) => creature.usable < MINIMUM_PAIRS_PER_CREATURE);
  if (thin.length > 0) {
    blockers.push(`insufficient-pairs: ${thin.map((creature) => `${creature.id}=${creature.usable}`).join(", ")} usable pair(s); the round's design calls for at least ${MINIMUM_PAIRS_PER_CREATURE} per creature.`);
  }

  // A pair can be USABLE (both legs ran, both produced) and still be missing the number one gate metric needs —
  // a host row with `phases: null` is exactly that. Deciding a gate on the surviving half and reporting "no
  // significant difference" would be the quiet misreport this harness exists to prevent: the honest answer is
  // that the data is incomplete, so the gate is undecided.
  for (const [name, metric] of [["hostBlockingMs", aggregate.metrics.hostBlockingMs], ["browserFirstFrameMs", aggregate.metrics.browserFirstFrameMs]]) {
    if (metric.unmeasuredPairs > 0 && metric.measuredPairs > 0) {
      blockers.push(`incomplete-gate-data: the ${name} gate lost ${metric.unmeasuredPairs} of ${metric.unmeasuredPairs + metric.measuredPairs} pair(s) to unmeasured readings (${[...new Set(metric.unmeasuredDetail.flatMap((row) => [row.geoclipReason, row.rasterReason]).filter(Boolean))].join(", ") || "reason not recorded"}). A verdict from the surviving half would be a verdict from half the data.`);
    }
  }

  const hostGate = gateVerdict(aggregate.metrics.hostBlockingMs, blockers);
  const browserGate = gateVerdict(aggregate.metrics.browserFirstFrameMs, blockers);

  return {
    schema: SCHEMA,
    generatedAt,
    verdict: {
      eligible: blockers.length === 0,
      blockers,
      hostBlockingGate: hostGate,
      browserFirstFrameGate: browserGate,
      overall: blockers.length > 0
        ? "NOT-DECIDED"
        : hostGate === "geoclip-faster" && browserGate === "geoclip-faster"
          ? "GEOCLIP-PASSES"
          : "GEOCLIP-FAILS",
      rule: "Both halves are required: geoclip must beat the shipped /spines/ still on host main-thread blockingMs AND on browser first-frame, paired, significant at alpha=0.05.",
    },
    environment,
    target,
    design,
    overhead,
    preflight,
    aggregate,
    creatures: creatures.map((creature) => ({
      ...creature,
      metrics: buildMetricBlock(creature.pairs ?? []),
    })),
    animatedClipContext,
    notes,
    limits: LIMITS,
  };
}

function gateVerdict(metric, blockers) {
  if (blockers.length > 0) return "NOT-DECIDED";
  if (!metric || metric.measuredPairs === 0) return "NOT-DECIDED";
  if (!metric.signTest.significant) return "no-significant-difference";
  return metric.signTest.direction;
}

/** The comparison block: two gate metrics, then context. Keep the gate metrics first and named as such. */
export function buildMetricBlock(pairs) {
  return {
    hostBlockingMs: comparePairs(pairs, (leg) => (leg?.host?.measured ? leg.host.blockingMs : null), {
      metric: "GATE — host Godot main-thread blocking time for the produce (/perf/spine.json phases where blocking=true)",
    }),
    browserFirstFrameMs: comparePairs(pairs, (leg) => leg?.browser?.startToAfterTwoRafMs ?? null, {
      metric: "GATE — browser wall clock from issuing the first lane request to the data being drawn, plus two rAF",
    }),
    hostParkedMs: comparePairs(pairs, (leg) => (leg?.host?.measured ? leg.host.parkedMs : null), {
      metric: "context — host time PARKED (frame awaits, extraction gate, disk); costs the requesting client, not the main thread",
    }),
    hostBakeMs: comparePairs(pairs, (leg) => leg?.host?.bakeMs ?? null, {
      metric: "context — total host bake wall clock, blocking plus parked plus unattributed",
    }),
    browserLaneWorkMs: comparePairs(pairs, (leg) => leg?.browser?.laneWorkMs ?? null, {
      metric: "context — browser fetch+decode+upload+draw for the lane, excluding the two rAF",
    }),
    transferBytes: comparePairs(pairs, (leg) => leg?.browser?.transferBytes ?? null, {
      metric: "context — bytes the client actually pulled for this lane",
      unit: "bytes",
    }),
  };
}

/**
 * Per-lane trend over leg ordinal, so a reader can see drift the ABBA blocking was meant to cancel. A Spearman
 * rank correlation, because the question is monotone drift and not a linear rate.
 */
export function driftDiagnostic(legs, extract) {
  const byLane = {};
  for (const lane of new Set(legs.map((leg) => leg.lane))) {
    const points = legs
      .filter((leg) => leg.lane === lane)
      .map((leg) => ({ ordinal: leg.ordinal, value: extract(leg) }))
      .filter((point) => typeof point.value === "number" && Number.isFinite(point.value));
    byLane[lane] = points.length < 3 ? { n: points.length, spearman: null, note: "too few points" } : { n: points.length, spearman: spearman(points.map((p) => p.ordinal), points.map((p) => p.value)), note: null };
  }
  return byLane;
}

function rank(values) {
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].value === indexed[i].value) j += 1;
    const average = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[indexed[k].index] = average;
    i = j + 1;
  }
  return ranks;
}

export function spearman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  const mean = (a) => a.reduce((sum, v) => sum + v, 0) / a.length;
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx === 0 || dy === 0 ? null : num / Math.sqrt(dx * dy);
}
