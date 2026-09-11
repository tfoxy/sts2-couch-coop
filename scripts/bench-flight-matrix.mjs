#!/usr/bin/env node
// Flight/trail lever MATRIX driver + regression gate (R15 WP-D).
//
// Orchestrates `scripts/bench-mirror-replay.mjs` over a grid of (lever cell × card count N) against the
// synthetic flight fixtures produced by `scripts/make-flight-fixture.mjs` (R15 WP-A), extracts the
// flight/trail metrics out of each run's BENCH_RESULT line, prints one aligned table + a machine-readable
// MATRIX_RESULT line, and can gate a run against a stored baseline.
//
// Usage:
//   node scripts/bench-flight-matrix.mjs --url http://127.0.0.1:5173 --ns 3,5,30
//   node scripts/bench-flight-matrix.mjs --url ... --write-baseline desktop.json
//   node scripts/bench-flight-matrix.mjs --url ... --baseline desktop.json          # exit 1 on regression
//   node scripts/bench-flight-matrix.mjs --url ... --abba --connect-cdp http://127.0.0.1:9222 --serve-port 8123
//   node scripts/bench-flight-matrix.mjs --url ... --ns 3,30 --dry-run              # print the plan only
//
// Design notes that are contract, not taste:
//
// * FIXTURE RESOLUTION is content-addressed by the generator, not by this driver: fixtures live at
//   `.sts2/bench/synth/flight-n<N>-<kind>-<hash8>.ndjson` where hash8 is the generator's own hash of its
//   normalized params. This driver therefore never computes that hash. With DEFAULT params it GLOBS for the
//   (N, kind) pattern and reuses the file when exactly one candidate exists; on zero candidates (missing) or
//   two-or-more (ambiguous — params changed at some point) it invokes the generator and takes the path the
//   generator printed (falling back to "newest matching file after the run" if the print format ever drifts).
//   As soon as `--fixture-args` is used the glob CANNOT decide whether a cached file carries those params, so
//   the generator is always invoked (it is synthetic, fast and idempotent — it re-derives the same path).
//   That keeps the cache deterministic without duplicating the generator's normalization rules here.
// * WINDOWING is delegated: every bench spawn passes `--window auto`, which reads
//   `meta.derived.suggestedWindow` out of the fixture. This driver only warns when the meta lacks it.
// * EVERY metric extraction is null-tolerant. The sibling packages (frame-gap metric, canvas census,
//   `trailPathBboxAreaSum`) land separately; against an older bench/renderer the corresponding cells read
//   `null` and the table prints `-` instead of crashing.
// * PEAK vs COUNTER: windowed walk stats are DELTAS (bench `diffWalkStats`), so a *peak* field like
//   `trailStrokesPeak` is meaningless as a delta (it is 0 whenever the peak predates the window). Peaks are
//   read from the cumulative `walkStats`; monotone counters prefer `walkStatsWindow` and fall back to
//   cumulative.
// * ABBA (`--abba`, mandatory on a phone — device drift is only cancellable by ordering, see the
//   device-A/B-drift memory): each N block runs the cell list FORWARD, then the same list REVERSED. Cell i
//   and cell (len-1-i) therefore see the sequence A…B B…A, i.e. their thermal/positional bias cancels to
//   first order. The two passes are pooled per (cell, N) (median of the pass values) and their min/max is
//   reported as `spread`. `--abba` doubles wall time; it does not halve `--repeats`.
//
// Exit codes: 0 = clean; 1 = regressions and/or failed cells; 2 = REFUSAL (baseline fixture-param hash does
// not match this run's fixtures — comparing those numbers would invent regressions).

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
// Both roots are git-ignored (`.sts2/`): fixtures are large and baselines are box-specific numbers.
// COUCHCOOP_FLIGHT_BENCH_ROOT relocates BOTH — used by selftest-flight-matrix.mjs so a test run can never
// land a stand-in fixture in the cache a real matrix run globs. (The generator still writes where IT decides;
// the override only moves this driver's cache lookup + default baseline directory.)
const BENCH_ROOT = path.resolve(repoRoot, process.env.COUCHCOOP_FLIGHT_BENCH_ROOT ?? path.join(".sts2", "bench"));
const SYNTH_DIR = path.join(BENCH_ROOT, "synth");
const BASELINE_DIR = path.join(BENCH_ROOT, "flight-baselines");
const DEFAULT_CELLS = path.join(scriptDir, "flight-cells", "default.json");

const log = (m) => console.log(`[matrix] ${m}`);
const warn = (m) => console.warn(`[matrix] WARN ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------------------------------------

// Minimal quote-aware tokenizer for the string-valued arg lists (--fixture-args, --bench-cmd, cell.extraArgs).
function tokenize(text) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(text ?? ""))) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
const shellQuote = (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
const asArgv = (v) => (Array.isArray(v) ? v.map(String) : v ? tokenize(v) : []);

function parseArgs(argv) {
  const a = {
    url: "http://127.0.0.1:5173",
    ns: [1, 2, 3, 5, 8, 12, 20, 30],
    cells: DEFAULT_CELLS,
    repeats: 3,
    kind: "shuffle",
    viewport: "2100x900",
    connectCdp: null,
    servePort: null,
    abba: false,
    cooldownMs: 0,
    effects: null,
    wave: null,
    baseline: null,
    writeBaseline: null,
    out: null,
    dryRun: false,
    fixtureArgs: [],
    regenFixtures: false,
    forceBaseline: false,
    // Internal test seams (self-tests only): swap the child commands for canned stand-ins so the driver's
    // plan/parse/gate paths are testable without a dev server, a device, or the sibling packages.
    benchCmd: null,
    fixtureCmd: null,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const [key, inline] = eq > 0 ? [raw.slice(0, eq), raw.slice(eq + 1)] : [raw, null];
    const val = () => inline ?? argv[++i];
    switch (key) {
      case "--url": a.url = String(val()); break;
      case "--ns": a.ns = String(val()).split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0); break;
      case "--cells": a.cells = path.resolve(repoRoot, String(val())); break;
      case "--repeats": a.repeats = Number(val()); break;
      case "--kind": a.kind = String(val()); break;
      case "--viewport": a.viewport = String(val()); break;
      case "--connect-cdp": a.connectCdp = String(val()); break;
      case "--serve-port": a.servePort = Number(val()); break;
      case "--abba": a.abba = true; break;
      case "--cooldown-ms": a.cooldownMs = Number(val()); break;
      case "--wave": a.wave = Number(val()); break;
      case "--effects": a.effects = /^(on|1|true|yes)$/i.test(String(val())) ? "on" : "off"; break;
      case "--baseline": a.baseline = String(val()); break;
      case "--write-baseline": a.writeBaseline = String(val()); break;
      case "--out": a.out = path.resolve(repoRoot, String(val())); break;
      case "--dry-run": a.dryRun = true; break;
      case "--fixture-args": a.fixtureArgs = tokenize(val()); break;
      case "--regen-fixtures": a.regenFixtures = true; break;
      case "--force-baseline": a.forceBaseline = true; break;
      case "--bench-cmd": a.benchCmd = tokenize(val()); break;
      case "--fixture-cmd": a.fixtureCmd = tokenize(val()); break;
      case "--help": case "-h": a.help = true; break;
      default: console.error(`Unknown argument: ${raw}`); a.help = true;
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`bench-flight-matrix.mjs — run the flight/trail lever matrix and gate it against a baseline

  --url <origin>            dev server the bench navigates (default http://127.0.0.1:5173)
  --ns 1,2,3,5,8,12,20,30   card counts; one synthetic fixture per N
  --cells <path>            cell list json (default scripts/flight-cells/default.json)
                            schema: [{name, query, extraArgs?, ns?}] or {cells:[...]}
  --repeats <n>             bench repeats per cell run (default 3)
  --kind shuffle|discard|mixed   fixture kind (default shuffle)
  --viewport WxH            bench viewport (default 2100x900)
  --effects on|off          pass through to the bench (phone leg is normally --effects on)
  --connect-cdp <endpoint>  attach to an already-running Chrome (phone leg) instead of launching
  --serve-port <n>          bench-side recording/asset server port (connect mode)
  --abba                    run each N block forward THEN reversed and pool per arm (MANDATORY on phone)
  --cooldown-ms <n>         sleep between cells (doubled for a cell when battery temp > 40.0 C)
  --wave <i>                window the i-th VOLLEY (1-based) of a multi-wave fixture instead of the whole
                            fixture. Needs --fixture-args "--waves <k>"; reads meta.derived.waveWindows.
                            Wave 1 is the COLD volley (nothing the client caches has been built yet) and the
                            last is the warm steady state — a run that windows both averages the two.
  --baseline <file>         compare against a baseline and exit 1 on any violation
  --write-baseline <file>   write this run in baseline format (bare names land in .sts2/bench/flight-baselines/)
  --force-baseline          compare anyway when the baseline's fixture hash differs (loud, unsafe)
  --out <file>              write the full run report json
  --regen-fixtures          regenerate fixtures even when a cached one exists
  --fixture-args "<args>"   extra args appended to every generator invocation
  --dry-run                 print the planned generator + bench invocations, run nothing

  env COUCHCOOP_FLIGHT_BENCH_ROOT   relocate the fixture cache + baseline dir (default .sts2/bench)

Gate (per cell,N vs baseline; a side that is null is skipped):
  droppedPct > base + 5 points | frameGaps.p95 > base x1.20 | busyPct > base x1.15
  trailPaints / trailPathWrites outside +/-10% of base (near-deterministic: drift means the pipeline changed)

Prints an aligned table + a machine-readable "MATRIX_RESULT {json}" line.
Exit 0 clean / 1 regressions or failed cells / 2 baseline fixture-hash mismatch (refusal).`);
  process.exit(0);
}

const benchCmd = args.benchCmd ?? ["node", path.join(scriptDir, "bench-mirror-replay.mjs")];
const fixtureCmd = args.fixtureCmd ?? ["node", path.join(scriptDir, "make-flight-fixture.mjs")];

// ---------------------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------------------

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const dig = (obj, dotted) => String(dotted).split(".").reduce((o, k) => (o == null ? null : o[k]), obj);
const pickNum = (obj, dotted) => num(dig(obj, dotted));
const round = (v, d = 2) => (num(v) === null ? null : Math.round(v * 10 ** d) / 10 ** d);

function median(values) {
  const v = values.filter((x) => num(x) !== null).sort((x, y) => x - y);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function run(cmd, argvRest) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, argvRest, { cwd: repoRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => resolvePromise({ code: -1, out, err: `${err}${e}` }));
    child.on("close", (code) => resolvePromise({ code, out, err }));
  });
}

// The ONLY adb use in this driver, and it is read-only: a per-cell battery temperature so a phone run can
// say "this number was taken at 43 C" instead of silently reporting thermal throttling as a regression.
// Silently returns null when adb is absent / the device is gone.
function batteryTempC() {
  try {
    const r = spawnSync("adb", ["shell", "dumpsys", "battery"], { encoding: "utf8", timeout: 10_000 });
    if (r.error || r.status !== 0) return null;
    const m = /temperature:\s*(-?\d+)/.exec(r.stdout ?? "");
    return m ? Number(m[1]) / 10 : null; // dumpsys reports tenths of a degree C
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// cells
// ---------------------------------------------------------------------------------------------------------

function loadCells(file) {
  if (!fs.existsSync(file)) {
    console.error(`[matrix] cells file not found: ${file}`);
    process.exit(2);
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = Array.isArray(parsed) ? parsed : parsed.cells;
  if (!Array.isArray(list) || !list.length) {
    console.error(`[matrix] cells file has no cells: ${file}`);
    process.exit(2);
  }
  return list.map((c, i) => ({
    name: String(c.name ?? `cell${i}`),
    query: String(c.query ?? "").replace(/^[?&]/, ""),
    extraArgs: asArgv(c.extraArgs),
    ns: Array.isArray(c.ns) ? c.ns.map(Number).filter(Number.isFinite) : null
  }));
}

// ---------------------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------------------

const fixtures = new Map(); // n -> {path, hash8, params, suggestedWindow, generated}

function fixtureGlob(n) {
  if (!fs.existsSync(SYNTH_DIR)) return [];
  const re = new RegExp(`^flight-n${n}-${args.kind}-[0-9a-f]+\\.ndjson$`);
  return fs.readdirSync(SYNTH_DIR).filter((f) => re.test(f)).map((f) => path.join(SYNTH_DIR, f));
}

function readFixtureMeta(file) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(1 << 20);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const firstLine = buf.slice(0, read).toString("utf8").split("\n")[0];
    return JSON.parse(firstLine)?.meta ?? null;
  } catch {
    return null;
  }
}

function describeFixture(file, generated) {
  const meta = readFixtureMeta(file);
  const hashFromName = /-([0-9a-f]+)\.ndjson$/.exec(path.basename(file))?.[1] ?? null;
  const suggestedWindow = dig(meta, "derived.suggestedWindow");
  if (!Array.isArray(suggestedWindow)) {
    warn(`${path.basename(file)}: meta.derived.suggestedWindow missing — the bench's --window auto will fail`);
  }
  // Per-volley brackets (`--wave`). Absent on a single-wave fixture and on any fixture built before the
  // generator learned to emit them, which is why the selector fails LOUDLY at use rather than silently
  // falling back to the whole-fixture window — averaging a cold volley with a warm one is exactly the
  // reading `--wave` exists to prevent.
  const waveWindows = dig(meta, "derived.waveWindows");
  return {
    path: file,
    hash8: dig(meta, "derived.paramsHash") ?? hashFromName,
    params: dig(meta, "derived.params") ?? null,
    suggestedWindow: Array.isArray(suggestedWindow) ? suggestedWindow : null,
    waveWindows: Array.isArray(waveWindows) ? waveWindows : null,
    messages: num(meta?.messages),
    generated
  };
}

function generatorArgv(n) {
  return [...fixtureCmd.slice(1), "--n", String(n), "--kind", args.kind, ...args.fixtureArgs];
}

async function ensureFixture(n) {
  if (fixtures.has(n)) return fixtures.get(n);
  // Custom generator params defeat the (N, kind) glob — see the header. Regenerate instead of guessing.
  const globbable = !args.regenFixtures && args.fixtureArgs.length === 0;
  const cached = globbable ? fixtureGlob(n) : [];
  const plan = `${fixtureCmd[0]} ${generatorArgv(n).map(shellQuote).join(" ")}`;

  if (args.dryRun) {
    if (cached.length === 1) log(`fixture n=${n}: CACHED ${path.relative(repoRoot, cached[0])}  (would skip: ${plan})`);
    else log(`fixture n=${n}: would run  ${plan}${cached.length > 1 ? `   (${cached.length} ambiguous candidates present)` : ""}`);
    const f = cached.length === 1 ? describeFixture(cached[0], false) : { path: `.sts2/bench/synth/flight-n${n}-${args.kind}-<hash8>.ndjson`, hash8: null, params: null, suggestedWindow: null, messages: null, generated: false };
    fixtures.set(n, f);
    return f;
  }

  if (cached.length === 1) {
    const f = describeFixture(cached[0], false);
    log(`fixture n=${n}: reuse ${path.relative(repoRoot, f.path)}`);
    fixtures.set(n, f);
    return f;
  }
  if (cached.length > 1) warn(`n=${n}: ${cached.length} cached fixtures match — regenerating to disambiguate`);
  log(`fixture n=${n}: generating (${plan})`);
  const res = await run(fixtureCmd[0], generatorArgv(n));
  if (res.code !== 0) {
    console.error(`[matrix] generator failed for n=${n} (exit ${res.code})\n${res.err || res.out}`);
    return null;
  }
  // Take the LAST synth path the generator printed; if its print format ever changes, fall back to the
  // newest file matching this (N, kind).
  const printed = [...`${res.out}\n${res.err}`.matchAll(/(\S*flight-n\d+-[a-z]+-[0-9a-f]+\.ndjson)/g)].map((m) => m[1]);
  let file = printed.length ? path.resolve(repoRoot, printed[printed.length - 1]) : null;
  if (!file || !fs.existsSync(file)) {
    const after = fixtureGlob(n).sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs);
    file = after[0] ?? null;
  }
  if (!file) {
    console.error(`[matrix] generator produced no locatable fixture for n=${n}\n${res.out}`);
    return null;
  }
  const f = describeFixture(file, true);
  fixtures.set(n, f);
  return f;
}

// Run-level fixture identity. `fixtureHashes` is the per-N generator hash (the precise thing to compare: it
// lets a subset run — say --ns 3 — be gated against a full baseline by intersecting the Ns). The aggregate
// `fixtureParamsHash` is the one-glance provenance stamp, and the fallback for baselines written before the
// per-N map existed. A baseline taken against a different generator parameterisation compares apples to
// oranges, so the gate REFUSES rather than inventing regressions.
function fixtureHashes() {
  const map = {};
  for (const [n, f] of [...fixtures.entries()].sort((a, b) => a[0] - b[0])) {
    map[n] = f?.hash8 ?? (f?.params ? createHash("sha1").update(JSON.stringify(f.params)).digest("hex").slice(0, 8) : null);
  }
  return map;
}

function fixtureParamsHash(map) {
  const parts = Object.entries(map).map(([n, h]) => `${n}:${args.kind}:${h ?? "unknown"}`);
  if (!parts.length) return null;
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}

// Which shared Ns disagree about their fixture? Empty array = comparable.
function fixtureConflicts(current, baseline) {
  if (!baseline || typeof baseline !== "object") return null; // no per-N map on the baseline: caller falls back
  const conflicts = [];
  for (const [n, hash] of Object.entries(current)) {
    const other = baseline[n];
    if (other === undefined) continue; // N absent from the baseline — reported as "not compared", not a refusal
    if (other !== hash) conflicts.push(`n=${n}: baseline ${other ?? "unknown"} != current ${hash ?? "unknown"}`);
  }
  return conflicts;
}

// ---------------------------------------------------------------------------------------------------------
// bench spawn + BENCH_RESULT extraction
// ---------------------------------------------------------------------------------------------------------

// `--window` for one bench spawn: the fixture's own bracket (`auto`, the delegation this driver has always
// used) or, under `--wave i`, that volley's bracket read out of the fixture meta. A `--wave` that cannot be
// honoured is fatal rather than degraded: the whole point of the selector is that the run is about ONE volley,
// so quietly measuring all of them would publish a number for a question nobody asked.
function windowArgFor(fixture) {
  if (args.wave === null) return "auto";
  const windows = typeof fixture === "string" ? null : fixture.waveWindows;
  const picked = Array.isArray(windows) ? windows[args.wave - 1] : null;
  if (!Array.isArray(picked) || picked.length !== 2) {
    // A dry run has not generated anything yet, so an ungenerated fixture legitimately has no windows to read;
    // print the intent instead of refusing a plan.
    if (args.dryRun) return `<wave ${args.wave}>`;
    console.error(
      `[matrix] --wave ${args.wave} needs meta.derived.waveWindows[${args.wave - 1}] in the fixture ` +
        `(generate with --fixture-args "--waves <k>"; k must be >= ${args.wave})`
    );
    process.exit(2);
  }
  return `${picked[0]}:${picked[1]}`;
}

function benchArgv(cell, fixture) {
  const fixturePath = typeof fixture === "string" ? fixture : fixture.path;
  const a = [
    ...benchCmd.slice(1),
    "--url", args.url,
    "--recording", fixturePath,
    "--window", windowArgFor(fixture),
    "--repeats", String(args.repeats),
    "--viewport", args.viewport
  ];
  if (cell.query) a.push("--query", cell.query);
  if (args.effects) a.push("--effects", args.effects);
  if (args.connectCdp) a.push("--connect-cdp", args.connectCdp);
  if (args.servePort !== null) a.push("--serve-port", String(args.servePort));
  a.push(...cell.extraArgs);
  return a;
}

function parseBenchResult(stdout) {
  const lines = String(stdout ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("BENCH_RESULT ")) continue;
    try {
      return JSON.parse(line.slice("BENCH_RESULT ".length));
    } catch {
      return null; // a truncated/garbled tail is a failed cell, never a crash
    }
  }
  return null;
}

// Every read below is defensive: the frame-gap metric, the canvas census and `trailPathBboxAreaSum` ship in
// sibling packages, and an older bench simply omits them (=> null, printed as "-").
function extractMetrics(result) {
  if (!result || typeof result !== "object") return null;
  const gaps = dig(result, "medians.frameGaps");
  const canvases = result.flightCanvases ?? null;

  // Windowed walk counters are the bracket delta; cumulative is the fallback for an un-windowed run.
  const w = result.walkStatsWindow ?? null;
  const c = result.walkStats ?? null;
  const counter = (key) => {
    const fromWindow = pickNum(w, key);
    return fromWindow !== null ? fromWindow : pickNum(c, key);
  };
  // Peaks are not deltas (see header): cumulative first.
  const peak = (key) => {
    const fromCumulative = pickNum(c, key);
    return fromCumulative !== null ? fromCumulative : pickNum(w, key);
  };

  // The bench reports long tasks per repeat; fold to the median repeat so a cell has one number per field.
  const perRepeat = Array.isArray(result.perRepeatLongTasks) ? result.perRepeatLongTasks.filter(Boolean) : [];
  const ltDirect = dig(result, "medians.longTasks") ?? result.longTasks ?? null;
  const lt = (key) => (ltDirect ? pickNum(ltDirect, key) : round(median(perRepeat.map((r) => pickNum(r, key))), 1));

  return {
    droppedPct: pickNum(gaps, "droppedPct"),
    dropped: pickNum(gaps, "dropped"),
    frameGapsP50: pickNum(gaps, "p50"),
    frameGapsP95: pickNum(gaps, "p95"),
    frameGapsMax: pickNum(gaps, "max"),
    frameGapsFrames: pickNum(gaps, "frames"),
    vsyncMs: pickNum(gaps, "vsyncMs"),
    tickP50: pickNum(result, "medians.tickMs.p50"),
    tickP95: pickNum(result, "medians.tickMs.p95"),
    busyPct: pickNum(result, "medians.busyPct") ?? pickNum(result, "busyPct"),
    longTaskCount: lt("count"),
    longTaskGe100: lt("ge100"),
    longTaskMaxMs: lt("maxMs"),
    longTaskTotalMs: lt("totalMs"),
    canvasCount: pickNum(canvases, "count"),
    canvasBytes: pickNum(canvases, "bytes"),
    canvasPageTotal: pickNum(canvases, "pageTotal"),
    // R16 follow-up: canvases the gsw WebGPU backend stamped, page-wide — the measured adoption gauge.
    canvasPageWebgpu: pickNum(canvases, "pageWebgpu"),
    // R17: the swap's own half of the census — `<img>` stand-ins under the flight roots, and the distinct
    // particle spec strings there (the ceiling on distinct stills). Read `canv` and `imgs` together: a swapped
    // cell moves surfaces from one column to the other, it does not delete a subtree.
    canvasImgs: pickNum(canvases, "imgs"),
    canvasDefaultSized: pickNum(canvases, "defaultSized"),
    canvasDistinctSpecs: pickNum(canvases, "distinctSpecs"),
    trailPaints: counter("trailPaints"),
    trailPathWrites: counter("trailPathWrites"),
    trailPathBboxAreaSum: counter("trailPathBboxAreaSum"),
    flightsArmed: counter("flightsArmed"),
    flightCssAnimStarted: counter("flightCssAnimStarted"),
    flightDietFrames: counter("flightDietFrames"),
    trailStrokesPeak: peak("trailStrokesPeak"),
    // R16 — STANDING blended-surface area (px², high-water over the window): the term the surface diet cuts.
    // trailPathBboxAreaSum above is WRITTEN area (a fill price); this is what the compositor carries per frame.
    trailSurfaceAreaPeak: peak("trailSurfaceAreaPeak"),
    busyPctSpreadPct: pickNum(result, "busyPctSpreadPct"),
    windowSource: w ? "window" : c ? "cumulative" : null
  };
}

const METRIC_KEYS = Object.keys(
  extractMetrics({ medians: {}, walkStats: {}, walkStatsWindow: null, perRepeatLongTasks: [] }) ?? {}
).filter((k) => k !== "windowSource");

// Pool the ABBA passes: median per numeric field (2 passes => their mean), plus min/max spread on the
// headline metrics so a report can say whether the arms even separate.
const SPREAD_KEYS = ["droppedPct", "frameGapsP95", "busyPct", "tickP95", "trailPaints"];
function poolPasses(passes) {
  const good = passes.filter(Boolean);
  if (!good.length) return { metrics: null, spread: null };
  const metrics = {};
  for (const key of METRIC_KEYS) metrics[key] = round(median(good.map((m) => m[key])), 3);
  metrics.windowSource = good[0].windowSource;
  const spread = {};
  for (const key of SPREAD_KEYS) {
    const vals = good.map((m) => m[key]).filter((v) => num(v) !== null);
    if (vals.length < 2) continue;
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const mid = median(vals);
    spread[key] = { min: round(lo, 3), max: round(hi, 3), spreadPct: mid ? round(((hi - lo) / Math.abs(mid)) * 100, 1) : null };
  }
  return { metrics, spread: Object.keys(spread).length ? spread : null };
}

// ---------------------------------------------------------------------------------------------------------
// table
// ---------------------------------------------------------------------------------------------------------

const COLUMNS = [
  ["cell", (r) => r.name, "left"],
  ["N", (r) => r.n],
  ["drop%", (r) => round(r.metrics?.droppedPct, 1)],
  ["gapP95", (r) => round(r.metrics?.frameGapsP95, 1)],
  ["gapP50", (r) => round(r.metrics?.frameGapsP50, 1)],
  ["tickP95", (r) => round(r.metrics?.tickP95, 2)],
  ["busy%", (r) => round(r.metrics?.busyPct, 1)],
  ["LT>=100", (r) => r.metrics?.longTaskGe100],
  ["LTmax", (r) => round(r.metrics?.longTaskMaxMs, 0)],
  ["canv", (r) => r.metrics?.canvasCount],
  ["imgs", (r) => r.metrics?.canvasImgs],
  ["canv0", (r) => r.metrics?.canvasDefaultSized],
  ["specs", (r) => r.metrics?.canvasDistinctSpecs],
  ["canvGpu", (r) => r.metrics?.canvasPageWebgpu],
  ["canvMB", (r) => (num(r.metrics?.canvasBytes) === null ? null : round(r.metrics.canvasBytes / 1e6, 1))],
  ["paints", (r) => r.metrics?.trailPaints],
  ["writes", (r) => r.metrics?.trailPathWrites],
  ["bboxMpx", (r) => (num(r.metrics?.trailPathBboxAreaSum) === null ? null : round(r.metrics.trailPathBboxAreaSum / 1e6, 1))],
  ["armed", (r) => r.metrics?.flightsArmed],
  ["css", (r) => r.metrics?.flightCssAnimStarted],
  ["diet", (r) => r.metrics?.flightDietFrames],
  ["peak", (r) => r.metrics?.trailStrokesPeak],
  ["surfMpx", (r) => (num(r.metrics?.trailSurfaceAreaPeak) === null ? null : round(r.metrics.trailSurfaceAreaPeak / 1e6, 1))],
  ["temp", (r) => r.batteryTempC],
  ["status", (r) => r.error ?? "ok", "left"]
];

function renderTable(rows) {
  const header = COLUMNS.map((c) => c[0]);
  const body = rows.map((r) => COLUMNS.map((c) => {
    const v = c[1](r);
    return v === null || v === undefined ? "-" : String(v);
  }));
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const fmt = (cells) => cells.map((v, i) => (COLUMNS[i][2] === "left" ? v.padEnd(widths[i]) : v.padStart(widths[i]))).join("  ");
  return [fmt(header), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(fmt)].join("\n");
}

// ---------------------------------------------------------------------------------------------------------
// regression gate
// ---------------------------------------------------------------------------------------------------------

function resolveBaselinePath(name) {
  if (name.includes("/") || name.includes(path.sep)) return path.resolve(repoRoot, name);
  return path.join(BASELINE_DIR, name.endsWith(".json") ? name : `${name}.json`);
}

function gate(report, baseline) {
  const violations = [];
  let compared = 0;
  const index = new Map();
  for (const cell of baseline.cells ?? []) index.set(`${cell.name}@${cell.n}`, cell.metrics ?? null);

  for (const row of report.cells) {
    const base = index.get(`${row.name}@${row.n}`);
    if (!base) {
      warn(`no baseline entry for ${row.name}@n=${row.n} — not compared`);
      continue;
    }
    const cur = row.metrics;
    if (!cur) continue;
    compared++;
    const check = (key, ok, describe) => {
      const a = num(cur[key]);
      const b = num(base[key]);
      if (a === null || b === null) return; // one-sided field (older bench / newer counter): skip, never guess
      if (!ok(a, b)) violations.push({ cell: row.name, n: row.n, metric: key, current: a, baseline: b, rule: describe(b) });
    };
    check("droppedPct", (a, b) => a <= b + 5, (b) => `<= ${round(b + 5, 2)} (base + 5 points)`);
    check("frameGapsP95", (a, b) => a <= b * 1.2, (b) => `<= ${round(b * 1.2, 2)} (base x1.20)`);
    check("busyPct", (a, b) => a <= b * 1.15, (b) => `<= ${round(b * 1.15, 2)} (base x1.15)`);
    for (const key of ["trailPaints", "trailPathWrites"]) {
      check(key, (a, b) => Math.abs(a - b) <= Math.abs(b) * 0.1, (b) => `${round(b * 0.9, 1)}..${round(b * 1.1, 1)} (base +/-10%)`);
    }
  }
  return { violations, compared };
}

// ---------------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------------

async function main() {
  const cells = loadCells(args.cells);
  log(`cells: ${cells.map((c) => c.name).join(", ")}`);
  log(`ns: ${args.ns.join(",")}   repeats: ${args.repeats}   abba: ${args.abba ? "on" : "off"}${args.connectCdp ? `   connect-cdp: ${args.connectCdp}` : ""}`);
  if (args.connectCdp && !args.abba) warn("phone runs (--connect-cdp) should always use --abba — device drift is only cancellable by ordering");

  const rows = [];
  const passLists = args.abba ? [cells, [...cells].reverse()] : [cells];
  let benchConfig = null;

  for (const n of args.ns) {
    const fixture = await ensureFixture(n);
    if (!fixture) {
      for (const cell of cells) {
        if (cell.ns && !cell.ns.includes(n)) continue;
        rows.push({ name: cell.name, n, metrics: null, spread: null, error: "fixture-failed" });
      }
      continue;
    }
    const perCell = new Map(); // cell name -> pass metrics[]
    for (let passIndex = 0; passIndex < passLists.length; passIndex++) {
      for (const cell of passLists[passIndex]) {
        if (cell.ns && !cell.ns.includes(n)) continue;
        const argvRest = benchArgv(cell, fixture);
        const printable = `${benchCmd[0]} ${argvRest.map(shellQuote).join(" ")}`;
        if (args.dryRun) {
          log(`[dry-run] ${cell.name} n=${n}${args.abba ? ` pass=${passIndex === 0 ? "fwd" : "rev"}` : ""}: ${printable}`);
          continue;
        }
        // Phone hygiene: record the temperature this cell was measured at, and back off when it is hot.
        const temp = args.connectCdp ? batteryTempC() : null;
        let cooldown = args.cooldownMs;
        if (num(temp) !== null && temp > 40) {
          warn(`battery ${temp}C > 40.0C before ${cell.name}@n=${n} — doubling cooldown to ${cooldown * 2}ms`);
          cooldown *= 2;
        }
        log(`run ${cell.name} n=${n}${args.abba ? ` (${passIndex === 0 ? "fwd" : "rev"})` : ""}${num(temp) !== null ? ` [${temp}C]` : ""}`);
        const res = await run(benchCmd[0], argvRest);
        const parsed = parseBenchResult(res.out);
        if (!parsed) {
          warn(`${cell.name}@n=${n}: no parseable BENCH_RESULT (exit ${res.code})`);
          if (res.err) warn(`  stderr tail: ${res.err.trim().split("\n").slice(-2).join(" | ")}`);
        }
        benchConfig ??= parsed?.config ?? null;
        const metrics = extractMetrics(parsed);
        if (!perCell.has(cell.name)) perCell.set(cell.name, { passes: [], temp, error: null });
        const entry = perCell.get(cell.name);
        entry.passes.push(metrics);
        if (entry.temp === null) entry.temp = temp;
        if (!metrics) entry.error = res.code === 0 ? "no-bench-result" : `bench-exit-${res.code}`;
        if (cooldown > 0) await sleep(cooldown);
      }
    }
    for (const cell of cells) {
      if (cell.ns && !cell.ns.includes(n)) continue;
      if (args.dryRun) continue;
      const entry = perCell.get(cell.name) ?? { passes: [], temp: null, error: "not-run" };
      const { metrics, spread } = poolPasses(entry.passes);
      const passesFailed = entry.passes.filter((p) => !p).length;
      // A partly-failed cell still reports its surviving pass, but never silently: the count rides along in
      // the report and the operator gets a warning.
      if (metrics && passesFailed) warn(`${cell.name}@n=${n}: ${passesFailed}/${entry.passes.length} pass(es) produced no result — pooled from the rest`);
      rows.push({
        name: cell.name,
        n,
        metrics,
        spread,
        batteryTempC: entry.temp,
        passes: entry.passes.length - passesFailed,
        passesFailed,
        error: metrics ? null : (entry.error ?? "no-data")
      });
    }
  }

  if (args.dryRun) {
    log("dry run: nothing executed.");
    return 0;
  }

  const hashes = fixtureHashes();
  const report = {
    createdAt: new Date().toISOString(),
    env: {
      url: args.url,
      connectCdp: args.connectCdp,
      // Normalised to "on"/"off": the bench reports its own `effects` as a boolean.
      effects: args.effects ?? (typeof benchConfig?.effects === "boolean" ? (benchConfig.effects ? "on" : "off") : null),
      cpuThrottle: benchConfig?.cpuThrottle ?? (process.env.COUCHCOOP_CPU_THROTTLE ? Number(process.env.COUCHCOOP_CPU_THROTTLE) : null),
      viewport: benchConfig?.viewport ?? args.viewport,
      fixtureParamsHash: fixtureParamsHash(hashes),
      fixtureHashes: hashes,
      kind: args.kind,
      repeats: args.repeats,
      abba: args.abba,
      cellsFile: path.relative(repoRoot, args.cells)
    },
    fixtures: [...fixtures.entries()].filter(([, f]) => f).sort((a, b) => a[0] - b[0]).map(([n, f]) => ({
      n, path: path.relative(repoRoot, f.path), hash8: f.hash8, suggestedWindow: f.suggestedWindow, generated: f.generated
    })),
    cells: rows
  };

  console.log("");
  console.log(renderTable(rows));
  console.log("");
  console.log("MATRIX_RESULT " + JSON.stringify(report));

  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2) + "\n");
    log(`wrote ${path.relative(repoRoot, args.out)}`);
  }

  if (args.writeBaseline) {
    const file = resolveBaselinePath(args.writeBaseline);
    const baseline = {
      kind: "flight-matrix-baseline",
      version: 1,
      createdAt: report.createdAt,
      fixtureParamsHash: report.env.fixtureParamsHash,
      fixtureHashes: report.env.fixtureHashes,
      env: report.env,
      cells: rows.map((r) => ({ name: r.name, n: r.n, metrics: r.metrics }))
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(baseline, null, 2) + "\n");
    log(`wrote baseline ${path.relative(repoRoot, file)} (fixture hash ${baseline.fixtureParamsHash ?? "unknown"})`);
  }

  const failed = rows.filter((r) => r.error);
  let exitCode = failed.length ? 1 : 0;
  if (failed.length) console.log(`\nFAILED CELLS (${failed.length}): ${failed.map((r) => `${r.name}@n=${r.n} (${r.error})`).join(", ")}`);

  if (args.baseline) {
    const file = resolveBaselinePath(args.baseline);
    if (!fs.existsSync(file)) {
      console.error(`[matrix] baseline not found: ${file}`);
      return 2;
    }
    const baseline = JSON.parse(fs.readFileSync(file, "utf8"));
    const baseHash = baseline.fixtureParamsHash ?? baseline.env?.fixtureParamsHash ?? null;
    const curHash = report.env.fixtureParamsHash;
    // Per-N first (a subset run is legitimately comparable); aggregate only for pre-map baselines.
    const conflicts = fixtureConflicts(hashes, baseline.fixtureHashes ?? baseline.env?.fixtureHashes ?? null);
    const mismatch = conflicts ? conflicts.length > 0 : baseHash !== curHash;
    if (mismatch) {
      const msg = conflicts?.length
        ? `fixtures differ from the baseline (${conflicts.join("; ")}) — these numbers are not comparable`
        : `baseline fixture hash ${baseHash ?? "unknown"} != current ${curHash ?? "unknown"} — the fixtures changed, so these numbers are not comparable`;
      if (!args.forceBaseline) {
        console.error(`[matrix] REFUSING: ${msg}`);
        console.error(`[matrix]   re-record with --write-baseline, or pass --force-baseline to compare anyway.`);
        return 2;
      }
      warn(`--force-baseline: comparing anyway. ${msg}`);
    }
    const { violations, compared } = gate(report, baseline);
    const scope = `${compared}/${report.cells.length} cells compared`;
    if (violations.length) {
      console.log(`\nREGRESSIONS (${violations.length}) vs ${path.relative(repoRoot, file)} (${scope}):`);
      for (const v of violations) {
        console.log(`  ${v.cell}@n=${v.n}  ${v.metric}: ${v.current} (baseline ${v.baseline}, allowed ${v.rule})`);
      }
      exitCode = 1;
    } else {
      log(`gate: clean vs ${path.relative(repoRoot, file)} (${scope})`);
    }
  }
  return exitCode;
}

main().then(
  (code) => process.exit(code ?? 0),
  (error) => {
    console.error(`[matrix] fatal: ${error?.stack ?? error}`);
    process.exit(1);
  }
);
