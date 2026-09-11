#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACTIVE_TRACE_WINDOW, IDLE_TRACE_WINDOW, markerWindowOrError, traceWindowForOptions } from "./bench-trace-lifecycle.mjs";
import { effectiveConnectPageUrl, httpPagePort, selectConnectBenchPageIndex } from "./lib/connect-bench-page.mjs";

assert.equal(traceWindowForOptions({ trace: null, report: null, idle: null }), null);
assert.deepEqual(traceWindowForOptions({ report: "/tmp/cell.report.json", idle: null }), ACTIVE_TRACE_WINDOW);
assert.deepEqual(traceWindowForOptions({ report: "/tmp/cell.report.json", idle: 5000 }), IDLE_TRACE_WINDOW);

const active = [
  { ts: 1, name: "TimeStamp", args: { data: { message: "cc-report-start" } } },
  { ts: 5_001, name: "RunTask", dur: 100 },
  { ts: 10_001, name: "TimeStamp", args: { data: { message: "cc-report-end" } } }
];
assert.equal(markerWindowOrError(active, ACTIVE_TRACE_WINDOW).windowMs, 10);
assert.match(markerWindowOrError(active.slice(0, 2), ACTIVE_TRACE_WINDOW).error, /cc-report-end/);
assert.match(markerWindowOrError(active, IDLE_TRACE_WINDOW).error, /cc-idle-start/);
assert.match(markerWindowOrError([active[0], { ...active[2], ts: 1 }], ACTIVE_TRACE_WINDOW).error, /invalid trace active marker interval/);

// The lifecycle is deliberately checked at its call sites too: a trace that starts during navigation can still
// have correct marker names yet overflow before idle; a stale listener can still make repeat two append to one.
const replay = readFileSync(resolve("scripts/bench-mirror-replay.mjs"), "utf8");
assert.match(replay, /function beginActiveMarkerWindowInPage\(input\) \{[\s\S]*?window\.__benchLongTasks\.length = 0;[\s\S]*?console\.timeStamp\(input\.marker\)/,
  "the active marker must retain the harness-owned observation reset and trace bracket");
assert.match(replay, /function idleMarkerWindowInPage\(input\) \{[\s\S]*?performance\.mark\(input\.label\)[\s\S]*?__benchIdleFrameGaps/,
  "the idle marker must retain its generic page-clock and frame-gap observations");
assert.match(replay, /scope\?\.phase === "active"\) await markerTrace\.start\(\);\n  const wallA = performance\.now\(\);\n  const a = await getMetrics\(\);\n  const nodesA/);
assert.match(
  replay,
  /if \(markerTrace\.scope\?\.phase === "idle"\) await markerTrace\.start\(\);\n    const stageBefore = await readStage\(\);\n    const markerStartAtMs = await mark\("cc-idle-start"\);/
);
assert.match(
  replay,
  /const markerEndAtMs = await mark\("cc-idle-end"\);\n    const stageAfter = await readStage\(\);\n    if \(markerTrace\.scope\?\.phase === "idle"\) \{/,
  "stage samples must exclude trace start/stop latency while staying outside the marker bracket"
);
assert.match(replay, /const sampledAtMs = performance\.now\(\);/);
assert.match(replay, /const stageSampleWindowMs = stageAfter\.sampledAtMs - stageBefore\.sampledAtMs;/);
assert.match(replay, /const secs = stageSampleWindowMs > 0 \? stageSampleWindowMs \/ 1000 : null;/);
assert.match(replay, /runs: s\.textGlyphs\.pass\.runs \?\? null,/);
assert.match(replay, /glyphs: s\.textGlyphs\.pass\.glyphs \?\? null/);
assert.match(replay, /const delta = \(a, b\) => \(typeof a === "number" && typeof b === "number" \? b - a : null\);/,
  "cumulative counter deltas must leave absent instrumentation unmeasured");
assert.match(replay, /idle\.stageDeltas = \{[\s\S]*?frames: delta\(stageBefore\.frames, stageAfter\.frames\),[\s\S]*?glyphPass/,
  "the report must preserve identity-guarded canvas counter deltas across the exact sample span");
assert.match(replay, /idle canvas deltas:[\s\S]*?across \$\{d\.sampleWindowMs\}ms/,
  "the human-readable result must state the exact counter-delta span");
assert.match(replay, /markerWindowMs: round\(markerWindowMs, 3\),/);
assert.match(replay, /traceMarkerWindowMs: traceMetrics\?\.windowMs \?\? null,/);
assert.match(replay, /instanceId: s\.instance\?\.id \?\? null/);
assert.match(replay, /stageBefore\.instanceId !== stageAfter\.instanceId/);
assert.match(replay, /idle\.stageMismatch = \{/);
assert.match(replay, /cdp\.off\?\.\("Tracing\.dataCollected", dataListener\)/);
assert.match(replay, /if \(markerError\) \{\n      console\.error\(`  report trace: \$\{markerError\}`\);\n      throw new Error\(markerError\);/);
assert.match(replay, /import \{ BENCH_ASSET_FAMILIES, isBenchAssetRoute \} from "\.\/lib\/bench-asset-route\.mjs";/);
assert.match(replay, /if \(assetServingEnabled && isBenchAssetRoute\(url\.pathname\)\) \{\n      const answer = resolveBenchAsset\(url\);/);
assert.match(replay, /if \(assetServingEnabled && !connectMode\) \{[\s\S]*?for \(const assetFamily of BENCH_ASSET_FAMILIES\) \{\n    await context\.route\(`\*\*\/\$\{assetFamily\}\/\*\*`, \(route\) => \{/);
assert.match(replay, /import \{ effectiveConnectPageUrl, selectConnectBenchPageIndex \} from "\.\/lib\/connect-bench-page\.mjs";/);
assert.match(replay, /connectPage = pages\[selectConnectBenchPageIndex\(pages\.map\(\(p\) => p\.url\(\)\), args\.url\)\];/);
assert.match(replay, /pageUrl = effectiveConnectPageUrl\(requestedPageUrl, connectPage\.url\(\)\);/);
assert.match(replay, /requestedUrl: requestedPageUrl,[\s\S]*?effectiveUrl: pageUrl,/,
  "the report must retain both requested and canonicalized effective phone URLs");
assert.doesNotMatch(replay, /pages\.find\(\(p\) => benchish\(p\.url\(\)\)\) \?\? pages\[0\]/,
  "connect mode must never fall back to a Chrome internal or unrelated first tab");
assert.doesNotMatch(replay, /new URLSearchParams\(`view=/,
  "the generic replay harness must not seed an ignored view query");
assert.doesNotMatch(replay, /retainedMarkerTiming|__mirrorRetainedMarkerTiming|retained-force-decline/,
  "the deleted retained replay must not leave benchmark controls or page hooks behind");

assert.equal(httpPagePort("http://worky.local:5299/?quality=high"), "5299");
assert.equal(httpPagePort("https://example.test/"), "443");
assert.equal(httpPagePort("chrome-native://newtab/"), null);
assert.equal(selectConnectBenchPageIndex([
  "chrome-native://newtab/", "https://user.example/", "http://worky.local:5299/?quality=high"
], "http://127.0.0.1:5299"), 2);
assert.throws(() => selectConnectBenchPageIndex(["chrome-native://newtab/"], "http://127.0.0.1:5299"),
  /no HTTP\(S\) page on benchmark port 5299/);
assert.throws(() => selectConnectBenchPageIndex([
  "http://127.0.0.1:5299/", "http://worky.local:5299/?quality=high"
], "http://127.0.0.1:5299"), /refusing ambiguous attached tabs/);
assert.equal(
  effectiveConnectPageUrl(
    "http://127.0.0.1:5299/mirror/replay?stage=canvas#proof",
    "http://worky.local:5299/?quality=high"
  ),
  "http://worky.local:5299/mirror/replay?stage=canvas#proof"
);
assert.throws(() => effectiveConnectPageUrl("http://127.0.0.1:5299/", "http://worky.local:5300/"),
  /does not match requested benchmark port/);

console.log("marker-scoped trace lifecycle tests passed");
