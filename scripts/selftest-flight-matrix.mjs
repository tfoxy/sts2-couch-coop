#!/usr/bin/env node
// Self-test for scripts/bench-flight-matrix.mjs — no dev server, no device, no live bench.
//
//   node scripts/selftest-flight-matrix.mjs
//
// The matrix driver's own logic (plan, fixture cache, BENCH_RESULT extraction, ABBA pooling, regression gate)
// is testable without any of the things it orchestrates, so it is: this script writes throwaway stand-ins for
// the generator (WP-A) and the bench (WP-B) into a temp dir, points the driver at them with the internal
// --fixture-cmd / --bench-cmd seams, and asserts the observable output. COUCHCOOP_FLIGHT_BENCH_ROOT redirects
// the fixture cache + baseline dir into the same temp dir, so a self-test run can never leave a stand-in
// fixture where a real matrix run would find it.
//
// Coverage: dry-run plan (executes nothing) | extraction of the post-WP-B/WP-C field set | extraction against
// an OLDER bench that lacks those fields (nulls, no crash) | failed cell | ABBA ordering + drift cancellation
// | write-baseline -> clean compare (exit 0) | perturbed run (exit 1, violations listed) | changed fixture
// params (exit 2, refusal).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const driver = path.join(scriptDir, "bench-flight-matrix.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flight-matrix-selftest-"));
const benchRoot = path.join(tmp, "bench");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  -- ${detail}` : ""}`);
  if (!ok) failures++;
};

// --- stand-ins -------------------------------------------------------------------------------------------

// Generator stand-in: same output CONTRACT as scripts/make-flight-fixture.mjs (content-addressed filename,
// meta.derived.params + .suggestedWindow, prints the path it wrote).
fs.writeFileSync(path.join(tmp, "gen.mjs"), `
import fs from "node:fs"; import path from "node:path"; import { createHash } from "node:crypto";
const arg = (n, d = null) => { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; };
const n = Number(arg("n", "3")), kind = arg("kind", "shuffle");
const params = { n, kind, seed: Number(arg("seed", "1")), staggerMs: 60, duration: 1.4 };
const hash8 = createHash("sha1").update(JSON.stringify(params)).digest("hex").slice(0, 8);
const dir = path.join(process.env.COUCHCOOP_FLIGHT_BENCH_ROOT, "synth");
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, \`flight-n\${n}-\${kind}-\${hash8}.ndjson\`);
const meta = { recordedAt: new Date().toISOString(), url: "synthetic:flight", durationMs: 5000, messages: 4 + n,
  derived: { params, paramsHash: hash8, suggestedWindow: [750, 4500] } };
fs.writeFileSync(out, [JSON.stringify({ meta }), JSON.stringify({ t: 0, data: "{}" })].join("\\n") + "\\n");
console.log(\`wrote \${out}: \${meta.messages} messages, suggested window 750:4500\`);
`);

// Bench stand-in with the CURRENT field set (frameGaps, flightCanvases, trailPathBboxAreaSum, walkStatsWindow).
// FLIGHT_FAKE_SCALE inflates the cost metrics so the gate has something to catch.
fs.writeFileSync(path.join(tmp, "bench.mjs"), `
const s = Number(process.env.FLIGHT_FAKE_SCALE ?? "1");
const arg = (n, d = null) => { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; };
const n = Number(/flight-n(\\d+)-/.exec(String(arg("recording", "")))?.[1] ?? 3);
const heavy = String(arg("query", "")).includes("trailWriteDiet=off") ? 1.4 : 1;
const r2 = (v) => Math.round(v * 10) / 10;
console.log("=== medians === (the human table the bench prints before its result line)");
console.log("BENCH_RESULT " + JSON.stringify({
  config: { url: arg("url"), repeats: Number(arg("repeats", "3")), effects: arg("effects", "off") === "on",
            viewport: arg("viewport", "2100x900"), cpuThrottle: 1 },
  window: { startMs: 750, endMs: 4500, spanMs: 3750 },
  medians: {
    busyPct: r2(18 * heavy * s),
    tickMs: { p50: 1.2, p95: r2(4.4 * heavy * s), max: 22.1, count: 210, totalMs: 480 },
    frameGaps: { frames: 300, p50: 11.1, p95: r2(2.35 * n * heavy * s), max: 96.3, vsyncMs: 11.1,
                 dropped: Math.round(1.2 * n * heavy * s), droppedPct: r2(0.42 * n * heavy * s) }
  },
  busyPctSpreadPct: 6.3,
  flightCanvases: { count: 4 * n, bytes: 4 * n * 262144, pageTotal: 4 * n + 12 },
  // Cumulative counters are deliberately absurd: the driver must prefer the WINDOWED delta for counters and
  // fall back to cumulative only for the PEAK (whose windowed delta here is a meaningless 0).
  walkStats: { trailPaints: 999999, flightsArmed: 999, trailStrokesPeak: 2 * n },
  walkStatsWindow: { trailPaints: Math.round(120 * n * heavy), trailPathWrites: Math.round(360 * n * heavy),
                     trailPathBboxAreaSum: 1.9e6 * n * heavy, flightsArmed: n, flightCssAnimStarted: n,
                     flightDietFrames: heavy > 1 ? 0 : 40, trailStrokesPeak: 0 },
  perRepeatLongTasks: [{ count: 5, ge100: 1, maxMs: 133, totalMs: 410 }, { count: 7, ge100: 2, maxMs: 151, totalMs: 480 },
                       { count: 6, ge100: 1, maxMs: 140, totalMs: 445 }]
}));
`);

// Pre-WP-B/WP-C bench: no frameGaps, no canvas census, no bbox counter, no windowed walk stats.
fs.writeFileSync(path.join(tmp, "bench-old.mjs"), `
const arg = (n, d = null) => { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; };
console.log("BENCH_RESULT " + JSON.stringify({
  config: { url: arg("url"), viewport: "2100x900", cpuThrottle: 1 },
  medians: { busyPct: 17.5, tickMs: { p50: 1.1, p95: 4.2, max: 20 } },
  walkStats: { trailPaints: 360, trailPathWrites: 1080, flightsArmed: 3, flightCssAnimStarted: 3,
               flightDietFrames: 40, trailStrokesPeak: 6 },
  walkStatsWindow: null, perRepeatLongTasks: [null]
}));
`);

fs.writeFileSync(path.join(tmp, "bench-fail.mjs"), `console.log("no result line"); console.error("boom"); process.exit(3);\n`);

// Drifting bench: every invocation is 10% hotter, so ABBA pooling has a ramp to cancel.
fs.writeFileSync(path.join(tmp, "bench-drift.mjs"), `
import fs from "node:fs";
const counter = ${JSON.stringify(path.join(tmp, "drift.count"))};
const i = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
fs.writeFileSync(counter, String(i));
const arg = (n, d = null) => { const k = process.argv.indexOf("--" + n); return k >= 0 ? process.argv[k + 1] : d; };
const drift = 1 + 0.1 * (i - 1);
const heavy = String(arg("query", "")).includes("trailWriteDiet=off") ? 2 : 1;
console.log("BENCH_RESULT " + JSON.stringify({
  config: { url: arg("url"), viewport: "2100x900", cpuThrottle: 1 },
  medians: { busyPct: Math.round(20 * heavy * drift * 10) / 10, tickMs: { p50: 1, p95: 4, max: 9 },
             frameGaps: { frames: 300, p50: 11.1, p95: 20, max: 90, vsyncMs: 11.1, dropped: 10, droppedPct: 5 } },
  walkStatsWindow: { trailPaints: 100 * heavy, trailPathWrites: 300 * heavy, flightsArmed: 3 },
  walkStats: { trailStrokesPeak: 6 }, perRepeatLongTasks: [{ count: 2, ge100: 0, maxMs: 60, totalMs: 110 }]
}));
`);

fs.writeFileSync(path.join(tmp, "cells.json"), JSON.stringify({
  cells: [{ name: "base", query: "" }, { name: "heavy", query: "trailMassCap=off&trailWriteDiet=off&flightVfxDiet=off" }]
}));

const CELLS = path.join(tmp, "cells.json");
const GEN = `node ${path.join(tmp, "gen.mjs")}`;
const BENCH = (file) => `node ${path.join(tmp, file)}`;

function matrix(extra, env = {}) {
  const r = spawnSync("node", [driver, "--url", "http://selftest.invalid", "--cells", CELLS, "--fixture-cmd", GEN, ...extra], {
    cwd: repoRoot, encoding: "utf8", env: { ...process.env, COUCHCOOP_FLIGHT_BENCH_ROOT: benchRoot, ...env }
  });
  const out = `${r.stdout}\n${r.stderr}`;
  const line = r.stdout.split("\n").find((l) => l.startsWith("MATRIX_RESULT "));
  let report = null;
  try { report = line ? JSON.parse(line.slice("MATRIX_RESULT ".length)) : null; } catch { report = null; }
  return { code: r.status, out, report };
}
const cellOf = (report, name, n) => report?.cells?.find((c) => c.name === name && c.n === n) ?? null;

// --- 1. dry run ------------------------------------------------------------------------------------------

console.log("\n[1] dry run plans, executes nothing");
{
  const r = matrix(["--ns", "3,30", "--repeats", "2", "--bench-cmd", BENCH("bench.mjs"), "--dry-run"]);
  check("exit 0", r.code === 0, `exit ${r.code}`);
  check("plans one generator invocation per N", (r.out.match(/would run .*gen\.mjs/g) ?? []).length === 2);
  check("plans one bench invocation per cell x N", (r.out.match(/\[dry-run\]/g) ?? []).length === 4);
  check("bench plan carries --window auto", /--window auto/.test(r.out));
  check("bench plan carries the cell query", /--query 'trailMassCap=off&trailWriteDiet=off&flightVfxDiet=off'/.test(r.out));
  check("nothing was written", !fs.existsSync(path.join(benchRoot, "synth")));
}

// --- 2. extraction ---------------------------------------------------------------------------------------

console.log("\n[2] BENCH_RESULT extraction (current field set)");
{
  const r = matrix(["--ns", "3,30", "--repeats", "2", "--bench-cmd", BENCH("bench.mjs")]);
  const m = cellOf(r.report, "base", 3)?.metrics ?? {};
  check("exit 0", r.code === 0, `exit ${r.code}`);
  check("frameGaps.droppedPct", m.droppedPct === 1.3, String(m.droppedPct));
  check("frameGaps.p95", m.frameGapsP95 === 7.1, String(m.frameGapsP95));
  check("medians.tickMs.p95", m.tickP95 === 4.4, String(m.tickP95));
  check("medians.busyPct", m.busyPct === 18, String(m.busyPct));
  check("longTasks folded to the median repeat", m.longTaskGe100 === 1 && m.longTaskCount === 6, `${m.longTaskGe100}/${m.longTaskCount}`);
  check("flightCanvases", m.canvasCount === 12 && m.canvasPageTotal === 24, String(m.canvasCount));
  check("counters read the WINDOW, not cumulative", m.trailPaints === 360 && m.flightsArmed === 3, `${m.trailPaints}/${m.flightsArmed}`);
  check("trailPathWrites", m.trailPathWrites === 1080, String(m.trailPathWrites));
  check("trailPathBboxAreaSum", m.trailPathBboxAreaSum === 5700000, String(m.trailPathBboxAreaSum));
  check("peak reads CUMULATIVE (windowed delta is 0)", m.trailStrokesPeak === 6, String(m.trailStrokesPeak));
  check("scales with N", cellOf(r.report, "base", 30)?.metrics?.trailPaints === 3600);
  check("fixture hash recorded per N", Object.keys(r.report?.env?.fixtureHashes ?? {}).length === 2);
  check("suggestedWindow carried into the report", r.report?.fixtures?.[0]?.suggestedWindow?.[1] === 4500);
}

console.log("\n[3] extraction against an OLDER bench (missing fields -> null, no crash)");
{
  const r = matrix(["--ns", "3", "--repeats", "2", "--bench-cmd", BENCH("bench-old.mjs")]);
  const m = cellOf(r.report, "base", 3)?.metrics ?? {};
  check("exit 0", r.code === 0, `exit ${r.code}`);
  check("frameGaps fields null", m.droppedPct === null && m.frameGapsP95 === null);
  check("flightCanvases null", m.canvasCount === null && m.canvasBytes === null);
  check("trailPathBboxAreaSum null", m.trailPathBboxAreaSum === null);
  check("long tasks null (no summaries)", m.longTaskCount === null);
  check("counters fall back to cumulative", m.trailPaints === 360 && m.windowSource === "cumulative", String(m.windowSource));
  check("table prints '-' for nulls", /\s-\s/.test(r.out));
}

console.log("\n[4] a failing bench is a failed CELL, not a crash");
{
  const r = matrix(["--ns", "3", "--repeats", "1", "--bench-cmd", BENCH("bench-fail.mjs")]);
  check("exit 1", r.code === 1, `exit ${r.code}`);
  check("cells listed as failed", /FAILED CELLS \(2\)/.test(r.out));
  check("metrics are null, report still emitted", cellOf(r.report, "base", 3)?.metrics === null);
  check("error names the exit code", cellOf(r.report, "base", 3)?.error === "bench-exit-3");
}

// --- 5. ABBA ---------------------------------------------------------------------------------------------

console.log("\n[5] ABBA ordering + drift cancellation");
{
  const r = matrix(["--ns", "3", "--repeats", "1", "--abba", "--bench-cmd", BENCH("bench-drift.mjs")]);
  const order = [...r.out.matchAll(/run (\S+) n=3 \((fwd|rev)\)/g)].map((m) => `${m[1]}/${m[2]}`);
  check("exit 0", r.code === 0, `exit ${r.code}`);
  check("order is A,B,B,A", order.join(" ") === "base/fwd heavy/fwd heavy/rev base/rev", order.join(" "));
  const base = cellOf(r.report, "base", 3)?.metrics;
  const heavy = cellOf(r.report, "heavy", 3)?.metrics;
  check("two passes pooled per cell", cellOf(r.report, "base", 3)?.passes === 2);
  // Ramp: base sees invocations 1 and 4 (x1.0, x1.3) -> 23; heavy sees 2 and 3 (x1.1, x1.2) -> 46. The drift
  // cancels: the pooled ratio is the true 2.0x, which the un-pooled forward pass alone would have read as 2.2x.
  check("pooled busyPct cancels the ramp", base?.busyPct === 23 && heavy?.busyPct === 46, `${base?.busyPct}/${heavy?.busyPct}`);
  check("spread records the arm min/max", cellOf(r.report, "base", 3)?.spread?.busyPct?.min === 20);
}

// --- 6. regression gate ----------------------------------------------------------------------------------

console.log("\n[6] regression gate");
{
  const w = matrix(["--ns", "3,30", "--repeats", "1", "--bench-cmd", BENCH("bench.mjs"), "--write-baseline", "selftest"]);
  check("write-baseline exit 0", w.code === 0, `exit ${w.code}`);
  const baselineFile = path.join(benchRoot, "flight-baselines", "selftest.json");
  check("baseline written to the (git-ignored) baselines dir", fs.existsSync(baselineFile));
  const baseline = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, "utf8")) : {};
  check("baseline embeds the fixture hashes", !!baseline.fixtureParamsHash && !!baseline.fixtureHashes);

  const same = matrix(["--ns", "3,30", "--repeats", "1", "--bench-cmd", BENCH("bench.mjs"), "--baseline", "selftest"]);
  check("immediate re-compare is clean (exit 0)", same.code === 0, `exit ${same.code}`);
  check("gate says clean", /gate: clean/.test(same.out));

  const subset = matrix(["--ns", "3", "--repeats", "1", "--bench-cmd", BENCH("bench.mjs"), "--baseline", "selftest"]);
  check("a SUBSET of Ns still compares (no false refusal)", subset.code === 0, `exit ${subset.code}`);

  const worse = matrix(["--ns", "3,30", "--repeats", "1", "--bench-cmd", BENCH("bench.mjs"), "--baseline", "selftest"], { FLIGHT_FAKE_SCALE: "1.6" });
  check("perturbed run exits 1", worse.code === 1, `exit ${worse.code}`);
  check("violations printed", /REGRESSIONS \(\d+\)/.test(worse.out));
  check("frameGaps.p95 rule fires (x1.20)", /frameGapsP95: .*base x1\.20/.test(worse.out));
  check("busyPct rule fires (x1.15)", /busyPct: .*base x1\.15/.test(worse.out));
  check("droppedPct rule is ABSOLUTE (+5 points)", /droppedPct: .*base \+ 5 points/.test(worse.out));

  // trailPaints is near-deterministic: a baseline perturbed by >10% must be caught in BOTH directions.
  const bumped = JSON.parse(JSON.stringify(baseline));
  for (const c of bumped.cells) if (c.name === "base" && c.n === 3) { c.metrics.trailPaints *= 0.5; c.metrics.trailPathWrites *= 1.5; }
  fs.writeFileSync(path.join(benchRoot, "flight-baselines", "paints.json"), JSON.stringify(bumped));
  const paints = matrix(["--ns", "3", "--repeats", "1", "--bench-cmd", BENCH("bench.mjs"), "--baseline", "paints"]);
  check("trailPaints above +10% fires", paints.code === 1 && /trailPaints: 360 \(baseline 180/.test(paints.out));
  check("trailPathWrites below -10% fires", /trailPathWrites: 1080 \(baseline 1620/.test(paints.out));

  const rehashed = matrix(["--ns", "3,30", "--repeats", "1", "--bench-cmd", BENCH("bench.mjs"), "--baseline", "selftest", "--fixture-args", "--seed 9"]);
  check("changed fixture params REFUSE with exit 2", rehashed.code === 2, `exit ${rehashed.code}`);
  check("refusal names the conflicting N", /REFUSING: fixtures differ .*n=3:/.test(rehashed.out));
  const forced = matrix(["--ns", "3,30", "--repeats", "1", "--bench-cmd", BENCH("bench.mjs"), "--baseline", "selftest", "--fixture-args", "--seed 9", "--force-baseline"]);
  check("--force-baseline overrides the refusal, loudly", forced.code === 0 && /WARN --force-baseline/.test(forced.out), `exit ${forced.code}`);
}

console.log("");
if (failures) {
  console.log(`SELFTEST FAILED: ${failures} check(s). Artifacts kept at ${tmp}`);
  process.exit(1);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log("SELFTEST OK — all checks passed.");
