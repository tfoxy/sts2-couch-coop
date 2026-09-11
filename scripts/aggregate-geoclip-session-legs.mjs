#!/usr/bin/env node
/**
 * Cross-arm aggregation for `bench-geoclip-session.mjs` sessions that were run ONE PER PROCESS.
 *
 * The bench compares arms within a single run, which requires several sessions in ONE game process. That is
 * exactly what a geoclip arm must not do: spirectl's in-process refusal memo answers before the baker is
 * reached, so the second and later geoclip sessions in a process price the MEMO rather than the lane (a
 * whole 15-session matrix was voided to that trap in WS-E, every geoclip arm reading `geoclipMounts=0`).
 * The safe shape is one VIRGIN process per session — `--sessions 1 --order <ARM>` per leg — and then the
 * bench's own comparison never runs. This re-does it across legs with the same arithmetic: per-session
 * values in run order, paired by index within arm, medians, exact two-sided paired sign test.
 *
 * Beyond the bench's metrics it reports the crux of the geoclip question — which bake keys each arm actually
 * performed, admitted and refused, the producer's refusal arms, whether any bake was a memo hit, and the
 * per-REQUEST blocking p50 by lane (one key is requested once per session, so a key's blockingMs is one
 * request's blocking time).
 *
 * usage: node scripts/aggregate-geoclip-session-legs.mjs <legs-dir> <out-dir>
 *        legs-dir holds <LABEL>/bench/sessions.json per leg, plus the optional <LABEL>/identity.json and
 *        <LABEL>/geoclip-lines.txt the leg runner writes. Labels starting PRIME or SCOUT are not counted.
 * writes <out-dir>/session-rerun.json and <out-dir>/tables.txt.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const round2 = (n) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function signTest(deltas) {
  const nonZero = deltas.filter((d) => d !== 0);
  const n = nonZero.length;
  const positives = nonZero.filter((d) => d > 0).length;
  const negatives = n - positives;
  if (n === 0) return { n: 0, positives: 0, negatives: 0, p: 1 };
  const choose = (a, b) => { let r = 1; for (let i = 0; i < b; i += 1) r = (r * (a - i)) / (i + 1); return r; };
  const k = Math.min(positives, negatives);
  let tail = 0;
  for (let i = 0; i <= k; i += 1) tail += choose(n, i);
  return { n, positives, negatives, p: Math.min(1, (2 * tail) / Math.pow(2, n)) };
}

function compare(name, armValues, rValues, lowerIsBetter = true) {
  const pairs = Math.min(armValues.length, rValues.length);
  const deltas = [];
  for (let i = 0; i < pairs; i += 1) deltas.push(armValues[i] - rValues[i]);
  const test = signTest(deltas);
  const med = median(deltas);
  const winner = med === null ? "none" : med === 0 ? "tie" : (med < 0) === lowerIsBetter ? "arm" : "R";
  return {
    metric: name, pairs, armMedian: median(armValues), rasterMedian: median(rValues),
    armValues, rasterValues: rValues, medianPairedDelta: med, deltas, signTest: test, better: winner,
    armMin: armValues.length ? Math.min(...armValues) : null, armMax: armValues.length ? Math.max(...armValues) : null,
    rMin: rValues.length ? Math.min(...rValues) : null, rMax: rValues.length ? Math.max(...rValues) : null,
  };
}

const legsDir = process.argv[2];
const outDir = process.argv[3];
mkdirSync(outDir, { recursive: true });

const legs = [];
for (const name of readdirSync(legsDir).sort()) {
  const file = join(legsDir, name, "bench", "sessions.json");
  if (!existsSync(file)) continue;
  const sessions = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(sessions) || sessions.length === 0) continue;
  const identity = existsSync(join(legsDir, name, "identity.json"))
    ? JSON.parse(readFileSync(join(legsDir, name, "identity.json"), "utf8")) : null;
  const geoclipLinesPath = join(legsDir, name, "geoclip-lines.txt");
  const geoclipLines = existsSync(geoclipLinesPath) ? readFileSync(geoclipLinesPath, "utf8").split("\n").filter(Boolean) : [];
  legs.push({ label: name, session: sessions[0], identity, geoclipLines });
}

const counted = legs.filter((l) => !/^(PRIME|SCOUT)/i.test(l.label));

function bakeTable(session) {
  const rows = (session.host.byKey ?? []).map((k) => ({
    key: k.key, kind: k.kind, count: k.count, successes: k.successes, failures: k.failures,
    blockingMs: k.blockingMs, bytes: k.bytes,
  }));
  return rows;
}

function shortKey(key) {
  // /geoclips/<scene>?node=..&anim=..  or the still's query — keep scene+anim+kind only.
  const scene = (key.match(/\/(?:spines|geoclips)\/([^?]+)/) ?? [])[1] ?? key.slice(0, 40);
  const anim = (key.match(/[?&]anim=([^&]+)/) ?? [])[1] ?? "?";
  const still = /still=1/.test(key) ? "still" : /retry=1/.test(key) ? "retry" : "";
  return `${scene.replace(/\.tscn$/, "")}:${anim}${still ? ":" + still : ""}`;
}

const perLeg = counted.map((l) => {
  const s = l.session;
  const geo = s.host.lane.geoclip;
  const geoKeys = (s.host.byKey ?? []).filter((k) => k.kind === "geoclip");
  const rasKeys = (s.host.byKey ?? []).filter((k) => k.kind !== "geoclip");
  return {
    leg: l.label, arm: s.arm, query: s.query,
    hostBlockingMs: s.host.hostBlockingMs,
    hostBakeWallMs: s.host.hostBakeWallMs,
    bakes: s.host.bakes, distinctKeys: s.host.distinctKeys, failedBakes: s.host.failedBakes,
    geoclipBakes: geo.bakes, geoclipFailed: geo.failed, geoclipBlockingMs: geo.blockingMs,
    rasterBakes: s.host.lane.raster.bakes, rasterBlockingMs: s.host.lane.raster.blockingMs,
    retryRetries: s.host.retryRetries, retryBlockingMs: s.host.retryBlockingMs,
    transferBytes: s.client.transferBytes, assetRequests: s.client.requests,
    clientUnionWaitMs: s.client.totalUnionWaitMs,
    geoclipMounts: s.client.walkStats?.geoclipMounts ?? null,
    geoclipDeadlineFires: s.client.walkStats?.geoclipDeadlineFires ?? null,
    liveGeoclipShare: s.client.geoclipLive?.sharePeriodsWithLiveGeoclip ?? null,
    peakConcurrentLive: s.client.geoclipLive?.peakConcurrentLive ?? null,
    animTransitions: s.wire.transitionCount,
    distinctAnims: s.wire.distinct.length,
    producerProof: s.producerProof.verdict,
    cacheCleared: s.cache.clearedOk,
    webgl: s.client.webglRenderer,
    // Per-REQUEST cost, the WS-P/WS-N gate's unit: one key is requested once per session, so a key's
    // blockingMs IS one request's blocking time. Reported beside the per-session sums because the two
    // answer different questions and this round's result is that they disagree.
    geoclipAdmittedBlockingP50: round2(median(geoKeys.filter((k) => k.successes > 0).map((k) => k.blockingMs))),
    geoclipRefusedBlockingP50: round2(median(geoKeys.filter((k) => k.failures > 0).map((k) => k.blockingMs))),
    stillBlockingP50: round2(median(rasKeys.map((k) => k.blockingMs))),
    geoclipKeysAdmitted: geoKeys.filter((k) => k.successes > 0).map((k) => shortKey(k.key)),
    geoclipKeysRefused: geoKeys.filter((k) => k.failures > 0).map((k) => shortKey(k.key)),
    rasterKeys: rasKeys.map((k) => shortKey(k.key)),
    stepFailures: s.steps.filter((x) => !x.ok).map((x) => x.step),
    openingFingerprint: JSON.stringify(s.opening),
    stepDetails: JSON.stringify(s.steps.map((x) => x.detail)),
    animSequence: s.wire.sequence.join("|"),
    identityOk: l.identity?.ok ?? null,
    geoclipLogLines: l.geoclipLines.length,
    cacheInScopeCreated: s.cache.inScopeCreated,
    cacheOutOfScopeCreated: s.cache.outOfScopeCreated,
    cacheCreatedByKind: s.cache.createdByKind,
    refusalReceipts: s.producerProof.refusalReceipts,
    perfRows: s.producerProof.perfRows,
    memoHits: l.geoclipLines.filter((line) => /refused from memo/i.test(line)).length,
    refusalArms: countBy(l.geoclipLines.filter((line) => /REFUSED/.test(line)).map((line) => (line.match(/arm=([a-z-]+)/) ?? [])[1] ?? "?")),
    producerCompleteTrue: l.geoclipLines.filter((line) => /complete=True/.test(line)).length,
    producerCompleteFalse: l.geoclipLines.filter((line) => /complete=False/.test(line)).length,
  };
});

function countBy(list) {
  const out = {};
  for (const item of list) out[item] = (out[item] ?? 0) + 1;
  return out;
}

const METRICS = [
  ["hostBlockingMs", (s) => s.hostBlockingMs],
  ["bakes", (s) => s.bakes],
  ["distinctBakeKeys", (s) => s.distinctKeys],
  ["failedBakes", (s) => s.failedBakes],
  ["geoclipBakes", (s) => s.geoclipBakes],
  ["geoclipFailed", (s) => s.geoclipFailed],
  ["rasterBakes", (s) => s.rasterBakes],
  ["retryBakes", (s) => s.retryRetries],
  ["hostBakeWallMs", (s) => s.hostBakeWallMs],
  ["transferBytes", (s) => s.transferBytes],
  ["clientUnionWaitMs", (s) => s.clientUnionWaitMs],
  ["assetRequests", (s) => s.assetRequests],
];

const byArm = {};
for (const row of perLeg) (byArm[row.arm] ??= []).push(row);

const comparisons = [];
for (const arm of Object.keys(byArm)) {
  if (arm === "R" || !byArm.R) continue;
  for (const [name, pick] of METRICS) comparisons.push({ arm, ...compare(name, byArm[arm].map(pick), byArm.R.map(pick)) });
}

const blockers = [];
for (const row of perLeg) {
  if (row.arm !== "R" && (row.geoclipMounts ?? 0) === 0) blockers.push({ code: "geoclip-arm-never-mounted", leg: row.leg });
  if (row.arm !== "R" && (row.geoclipDeadlineFires ?? 0) > 0) blockers.push({ code: "geoclip-defer-deadline-fired", leg: row.leg, detail: row.geoclipDeadlineFires });
  if (row.producerProof !== "entered-producer") blockers.push({ code: "no-producer-proof", leg: row.leg });
  if (!row.cacheCleared) blockers.push({ code: "cache-clear-failed", leg: row.leg });
  if (row.identityOk !== true) blockers.push({ code: "identity-unproven", leg: row.leg });
  if (/SwiftShader|llvmpipe|softpipe|swrast|lavapipe/i.test(String(row.webgl))) blockers.push({ code: "browser-software-gl", leg: row.leg, detail: row.webgl });
  if (row.stepFailures.length > 0) blockers.push({ code: "driven-step-failed", leg: row.leg, detail: row.stepFailures.join("; ") });
}

const comparability = {
  distinctOpeningFingerprints: new Set(perLeg.map((r) => r.openingFingerprint)).size,
  distinctStepDetailSequences: new Set(perLeg.map((r) => r.stepDetails)).size,
  distinctAnimSequences: new Set(perLeg.map((r) => r.animSequence)).size,
  animTransitionCounts: [...new Set(perLeg.map((r) => r.animTransitions))].sort((a, b) => a - b),
  distinctAnimSetSizes: [...new Set(perLeg.map((r) => r.distinctAnims))].sort((a, b) => a - b),
};

const summary = {};
for (const [arm, rows] of Object.entries(byArm)) {
  summary[arm] = { n: rows.length };
  for (const [name, pick] of METRICS) {
    const values = rows.map(pick);
    summary[arm][name] = { median: round2(median(values)), min: Math.min(...values), max: Math.max(...values), values };
  }
}

const report = {
  schema: "geoclip-session-rerun/1",
  capturedAt: new Date().toISOString(),
  legs: perLeg.map((r) => r.leg),
  order: perLeg.map((r) => r.arm).join(""),
  perLeg, summary, comparisons, comparability, blockers,
};
writeFileSync(join(outDir, "session-rerun.json"), JSON.stringify(report, null, 1));

const lines = [];
const say = (m) => { lines.push(m); console.log(m); };

say(`legs (in run order): ${perLeg.map((r) => `${r.leg}:${r.arm}`).join("  ")}`);
say("");
say("PER-LEG");
say("leg          arm  bakes  geo(f)  ras  retry   blockMs   geoBlock  rasBlock      bytes    waitMs  mounts liveShare anims");
for (const r of perLeg) {
  say(`${r.leg.padEnd(12)} ${r.arm}   ${String(r.bakes).padStart(4)}  ${String(r.geoclipBakes).padStart(3)}(${String(r.geoclipFailed).padStart(2)}) ${String(r.rasterBakes).padStart(4)} ${String(r.retryRetries).padStart(3)} ${String(r.hostBlockingMs).padStart(9)} ${String(r.geoclipBlockingMs).padStart(9)} ${String(r.rasterBlockingMs).padStart(9)} ${String(r.transferBytes).padStart(10)} ${String(r.clientUnionWaitMs).padStart(9)} ${String(r.geoclipMounts).padStart(6)} ${String(r.liveGeoclipShare).padStart(9)} ${String(r.animTransitions).padStart(5)}`);
}
say("");
say("BY ARM (median [min..max])");
for (const [arm, s] of Object.entries(summary)) {
  say(`  arm ${arm} n=${s.n}`);
  for (const [name] of METRICS) {
    const m = s[name];
    say(`    ${name.padEnd(20)} ${String(m.median).padStart(12)}   [${m.min} .. ${m.max}]`);
  }
}
say("");
for (const arm of [...new Set(comparisons.map((c) => c.arm))]) {
  say(`=== ${arm} vs R — paired by index, Δ = ${arm} − R ===`);
  for (const c of comparisons.filter((x) => x.arm === arm)) {
    say(`${c.metric.padEnd(20)} ${arm} ${String(c.armMedian).padStart(12)}  R ${String(c.rasterMedian).padStart(12)}  Δ ${String(round2(c.medianPairedDelta)).padStart(12)}  wins ${arm}/R ${c.signTest.negatives}/${c.signTest.positives}  p=${c.signTest.p.toExponential(2)}  -> ${c.better === "arm" ? arm : c.better}`);
  }
  say("");
}
say("THE CRUX — bake keys per session, by arm (frequency across that arm's legs)");
for (const [arm, rows] of Object.entries(byArm)) {
  const admitted = {}, refused = {}, raster = {};
  for (const r of rows) {
    for (const k of r.geoclipKeysAdmitted) admitted[k] = (admitted[k] ?? 0) + 1;
    for (const k of r.geoclipKeysRefused) refused[k] = (refused[k] ?? 0) + 1;
    for (const k of r.rasterKeys) raster[k] = (raster[k] ?? 0) + 1;
  }
  say(`  arm ${arm} (n=${rows.length} legs)`);
  say(`    raster stills  (${Object.keys(raster).length} distinct): ` + Object.entries(raster).sort().map(([k, v]) => `${k} x${v}`).join(", "));
  say(`    geoclip ADMIT  (${Object.keys(admitted).length} distinct): ` + (Object.entries(admitted).sort().map(([k, v]) => `${k} x${v}`).join(", ") || "-"));
  say(`    geoclip REFUSE (${Object.keys(refused).length} distinct): ` + (Object.entries(refused).sort().map(([k, v]) => `${k} x${v}`).join(", ") || "-"));
  say(`    memo hits total ${rows.reduce((a, r) => a + r.memoHits, 0)}  refusal arms ${JSON.stringify(rows.reduce((a, r) => { for (const [k, v] of Object.entries(r.refusalArms)) a[k] = (a[k] ?? 0) + v; return a; }, {}))}`);
}
say("");
say("comparability: " + JSON.stringify(comparability));
say("blockers: " + (blockers.length === 0 ? "none" : JSON.stringify(blockers, null, 1)));
writeFileSync(join(outDir, "tables.txt"), lines.join("\n"));
