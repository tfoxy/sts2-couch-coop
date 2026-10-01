#!/usr/bin/env node
// Thin alternating A/B runner over the existing scripts/bench-mirror-replay.mjs — a quick, cheap "does this
// query flag move renderer/GPU CPU" instrument. No oracle, no freeze, no review gate: it runs N cells (one
// bench-mirror-replay process per cell, --repeats 1 each), pulls the numbers the bench ALREADY measures out of
// its --result-json, and prints a table. Nothing here adds new measurement code to the bench.
//
//   node scripts/bench-rust-ab.mjs --config <control-config.json> \
//     --arm OFF= --arm ON=rustSomeFlag=1 --order OFF,ON,ON,OFF \
//     --out .sts2/bench/quick-ab-<name> --owner quickab
//
//   node scripts/bench-rust-ab.mjs --url http://127.0.0.1:5371/?stage=canvas \
//     --arm OFF= --arm ON=foo=1 --order OFF,ON --out .sts2/bench/quick-ab-x --owner quickab \
//     -- --recording .sts2/bench/foo.ndjson --res-root /path/to/recovered-project --window 12000:19000
//
// STAGE GATE: a `?stage=canvas`/`?stage=rust` URL is a REQUEST for the Rust backend, not a guarantee — if the
// Wasm module 403s (e.g. a worktree's `.sts2/rust-prototype-web` is a symlink outside Vite's `server.fs.allow`,
// or an env var the page needs to find the module is unset) the selected stage fails and produces no valid
// measurement. So every cell is gated on
// `perRepeat[0].rendererWindow.{before,after}.backend` equalling the expected backend (inferred "rust" from
// `stage=canvas`/`stage=rust` in the URL, override with `--expect-backend`), both `.ready === true`, and — for
// the "rust" backend specifically — `result.walkStats.walks === 0` (the legacy DOM walk reconciler must never
// run under the Rust backend; a nonzero count means the wrong renderer ran). A cell also fails on any
// recorded non-2xx response for a `.wasm`/`rust_prototype` URL (`result.responseErrors`). A gate failure is a
// FAILED cell, same as a crash: its numbers stay in the per-cell row for debugging but are excluded from every
// arm mean.
//
// CPU SOURCE: timed cells run `--report <cell>/report.json --untraced-report` by default — `--report` is what
// turns on bench-mirror-replay's /proc `processIdentity` capture (gated on `opts.report`, independent of
// tracing), and `--untraced-report` skips the Chrome trace entirely so tracing's own overhead never perturbs
// the CPU being measured. Pass `--traced` to swap in `--trace <cell>/trace.json` instead (no
// `--untraced-report`) for a cell that needs phase attribution (scripts/analyze-phase-cpu.mjs) or a JS profile.
// PRIMARY renderer/GPU CPU here always comes from `/proc` (`perRepeat[0].processIdentity`, `processCpuMs`
// summed per role, deduped by pid); the Chrome-trace `cpu.byProcess` block, when present (traced cells only),
// is reported as `secondary` only. Renderer MAIN-THREAD CPU can only be attributed to a specific OS thread when
// a trace supplies the `CrRendererMain` thread name (folded into `processIdentity[].role`), so it reads "n/a"
// on an untraced cell — that is expected, not a bug.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "./lib/repo-layout.mjs";

function fail(message) {
  console.error(`bench-rust-ab: ${message}`);
  process.exit(2);
}

export function splitShellWords(text) {
  if (!text) return [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function parseArgs(argv) {
  const a = {
    config: null, url: null, arms: new Map(), order: null, out: null, owner: null,
    extraBenchArgs: [], dryRun: false, passthrough: null, help: false,
    expectBackend: null, traced: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { a.passthrough = argv.slice(i + 1); break; }
    switch (arg) {
      case "--config": a.config = argv[++i]; break;
      case "--url": a.url = argv[++i]; break;
      case "--arm": {
        const spec = argv[++i];
        const eq = spec?.indexOf("=") ?? -1;
        if (!spec || eq < 0) fail(`--arm must be NAME=<query> (query may be empty), got: ${spec}`);
        a.arms.set(spec.slice(0, eq), spec.slice(eq + 1));
        break;
      }
      case "--order": a.order = argv[++i].split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--out": a.out = argv[++i]; break;
      case "--owner": a.owner = argv[++i]; break;
      case "--extra-bench-args": a.extraBenchArgs.push(...splitShellWords(argv[++i])); break;
      case "--expect-backend": a.expectBackend = argv[++i]; break;
      case "--traced": a.traced = true; break;
      case "--dry-run": a.dryRun = true; break;
      case "--help": case "-h": a.help = true; break;
      default: fail(`unknown argument: ${arg}`);
    }
  }
  return a;
}

function usage() {
  console.log(`usage: bench-rust-ab.mjs --config <control-config.json> | --url <url> -- <passthrough bench args>
    --arm NAME=<query>       (repeatable; query is appended to the base URL's own query string)
    --order NAME,NAME,...    cell sequence, by arm name (repeats allowed)
    --out <dir>              output directory (must not already exist and be non-empty)
    --owner <lease-owner>    scripts/live-qa-lock.mjs owner for every cell
    --extra-bench-args '...' appended to EVERY cell's bench-mirror-replay.mjs invocation
    --expect-backend <name>  stage-gate override (default: "rust" when the URL has stage=canvas/stage=rust)
    --traced                 record a Chrome trace (--trace) instead of the default --untraced-report
    --dry-run                print the commands without running them
`);
}

export function buildCellUrl(baseUrlString, armQuery) {
  const url = new URL(baseUrlString);
  if (armQuery) {
    const extra = new URLSearchParams(armQuery.replace(/^[?&]/, ""));
    for (const [key, value] of extra.entries()) url.searchParams.set(key, value);
  }
  return url.toString();
}

export function defaultLeaseResources(config, baseUrl) {
  const port = baseUrl.port || (baseUrl.protocol === "https:" ? "443" : "80");
  const resources = ["exclusive:bench:desktop", "exclusive:browser:desktop-rust-replay", `exclusive:port:${port}`];
  if (config?.assetPort) resources.push(`exclusive:port:${config.assetPort}`);
  return resources;
}

// "rust" when the URL explicitly asks for the canvas/rust stage; otherwise no gate unless --expect-backend
// says so (an explicit override always wins).
export function inferExpectBackend(baseUrlString, explicit) {
  if (explicit) return explicit;
  try {
    const stage = new URL(baseUrlString).searchParams.get("stage");
    if (stage === "canvas" || stage === "rust") return "rust";
  } catch { /* fall through */ }
  return null;
}

// Mirrors the mapping scripts/profile-mirror-rust.mjs's `capture` command applies to the SAME control-config
// shape (see its `benchArgs` construction, including `--quality`/`--effects` from the config), minus
// everything that script does ONLY for its own heavier oracle/receipt machinery (scratch server lifecycle,
// visual/hit reference checks, SHA pinning ceremony).
export function buildCellBenchArgs({ config, url, passthrough, cellDir, extraBenchArgs, traced }) {
  const args = ["scripts/bench-mirror-replay.mjs", "--url", url];
  if (config) {
    if (config.recording) args.push("--recording", resolve(config.recording));
    args.push("--quality", config.quality ?? "auto", "--effects", config.effects ? "on" : "off");
    if (config.resRoot) args.push("--res-root", resolve(config.resRoot));
    if (config.browserExecutable) {
      args.push("--browser-executable", resolve(config.browserExecutable),
        "--browser-executable-sha256", config.browserExecutableSha256);
    }
    args.push(...(config.benchArgs ?? []));
    if (config.assetCacheRoot) args.push("--asset-cache-root", resolve(config.assetCacheRoot));
  } else {
    args.push(...passthrough);
  }
  // Always win over anything a config/passthrough happened to set: one repeat per cell, --report to turn on
  // /proc process-identity capture, and either a real trace (--traced) or none at all (the default, so tracing
  // overhead never perturbs the CPU number this runner actually reads).
  args.push("--repeats", "1", "--report", join(cellDir, "report.json"));
  if (traced) args.push("--trace", join(cellDir, "trace.json"));
  else args.push("--untraced-report");
  args.push("--result-json", join(cellDir, "result.json"));
  args.push(...extraBenchArgs);
  return args;
}

export function shellQuote(token) {
  return /^[A-Za-z0-9_.\-/:=@]+$/.test(token) ? token : `'${token.replace(/'/g, "'\\''")}'`;
}

function runCell({ owner, leaseResources, benchArgs, cellDir, dryRun }) {
  const lockArgs = ["scripts/live-qa-lock.mjs", "with", "--owner", owner,
    ...leaseResources.flatMap((r) => ["--resource", r]), "--", process.execPath, ...benchArgs];
  const commandLine = [process.execPath, ...lockArgs].map(shellQuote).join(" ");
  // Dry-run touches NOTHING on disk — not even the cell directory — so a later real run against the same
  // --out is never blocked by a dry-run's own leftovers.
  if (dryRun) { console.log(commandLine); return { dryRun: true, command: commandLine }; }
  mkdirSync(cellDir, { recursive: true });
  writeFileSync(join(cellDir, "command.txt"), commandLine + "\n");
  const run = spawnSync(process.execPath, lockArgs, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  writeFileSync(join(cellDir, "stdout.log"), run.stdout ?? "");
  writeFileSync(join(cellDir, "stderr.log"), run.stderr ?? "");
  return { command: commandLine, exitCode: run.status, signal: run.signal, spawnError: run.error ? String(run.error) : null };
}

// --- result.json -> plain numbers -------------------------------------------------------------------------

export function sumUniqueProcessCpuMs(processIdentity, roleTest) {
  const seenPid = new Set();
  let sum = null;
  for (const row of processIdentity ?? []) {
    if (!roleTest(row.role ?? "")) continue;
    if (seenPid.has(row.pid)) continue;
    seenPid.add(row.pid);
    if (typeof row.processCpuMs === "number") sum = (sum ?? 0) + row.processCpuMs;
  }
  return sum;
}

// PRIMARY source is always /proc (`perRepeat[0].processIdentity`): renderer/GPU CPU is `processCpuMs` summed
// over each role's UNIQUE pids (the same value repeats once per OS thread of that process, so dedupe by pid
// before summing). `role` only carries a real OS thread name ("Renderer/CrRendererMain") when the cell was
// traced (see the module doc comment); an untraced cell's rows are "renderer/untraced" etc. with no thread
// breakdown, so `rendererMainThreadCpuMs` is honestly null there. `cpu.byProcess` (the Chrome-trace block) is
// only ever present on a traced cell, and only ever reported here as `secondary`.
export function extractCellMetrics(result) {
  if (!result) return null;
  const repeat = result.perRepeat?.[0] ?? null;
  const processIdentity = repeat?.processIdentity ?? [];
  const cpu = repeat?.cpu ?? null;

  const rendererCpuMs = sumUniqueProcessCpuMs(processIdentity, (role) => /^renderer\b/i.test(role));
  const gpuCpuMs = sumUniqueProcessCpuMs(processIdentity, (role) => /^gpu/i.test(role));
  const mainThreadRow = processIdentity.find((row) => /renderer/i.test(row.role ?? "") && /crrenderermain/i.test(row.role ?? ""));
  const rendererMainThreadCpuMs = mainThreadRow?.cpuMs ?? null;

  const windowMs = result.window?.spanMs ?? cpu?.windowMs ?? null;
  const presentedFrames = repeat?.presentationCandidate?.count ?? null;
  const deliveredBefore = repeat?.replayDelivery?.before ?? null;
  const deliveredAfter = repeat?.replayDelivery?.after ?? null;
  const delivered = deliveredBefore != null && deliveredAfter != null ? deliveredAfter - deliveredBefore : null;

  return {
    rendererCpuMs,
    rendererMainThreadCpuMs,
    gpuProcessCpuMs: gpuCpuMs,
    windowMs: windowMs ?? null,
    presentedFrames,
    deliveredMessages: delivered,
    completedBuilds: null, // bench-mirror-replay only surfaces a build counter on --idle cells; n/a on a --window cell
    cpuPerFrame: rendererCpuMs != null && presentedFrames ? rendererCpuMs / presentedFrames : null,
    secondary: cpu ? {
      rendererCpuMs: cpu.byProcess?.renderer?.cpuMs ?? null,
      gpuProcessCpuMs: cpu.byProcess?.gpu?.cpuMs ?? null,
      cpuCoverage: cpu.cpuCoverage ?? null,
    } : null,
  };
}

// Stage gate: null means "passed" (or no gate requested). A non-null string is the failure reason. See the
// module doc comment for why this exists — a 403'd Wasm module silently falls back to the DOM renderer, and
// every CPU number from that cell would describe the wrong backend.
export function evaluateStageGate(result, expectBackend) {
  if (!expectBackend) return null;
  const repeat = result?.perRepeat?.[0] ?? null;
  const before = repeat?.rendererWindow?.before ?? null;
  const after = repeat?.rendererWindow?.after ?? null;
  if (!before || !after) return `stage gate: rendererWindow.before/after missing (expected backend '${expectBackend}')`;
  if (before.backend !== expectBackend || after.backend !== expectBackend) {
    return `stage gate: backend mismatch (expected '${expectBackend}', got before='${before.backend}' after='${after.backend}')`;
  }
  if (before.ready !== true || after.ready !== true) {
    return `stage gate: renderer not ready (before.ready=${before.ready}, after.ready=${after.ready})`;
  }
  if (expectBackend === "rust") {
    const walks = result?.walkStats?.walks;
    if (walks !== 0) {
      return `stage gate: walkStats.walks=${walks ?? "n/a"} (expected 0 under the rust backend — DOM walk reconciler ran)`;
    }
  }
  const badResources = (result?.responseErrors ?? []).filter((e) =>
    /\.wasm(?:[?#]|$)/i.test(e?.pathname ?? "") || /rust_prototype/i.test(e?.pathname ?? ""));
  if (badResources.length) {
    return `stage gate: non-2xx response for ${badResources.map((e) => `${e.status} ${e.pathname}`).join(", ")}`;
  }
  return null;
}

function evaluateCell(cellDir, runOutcome, expectBackend) {
  const resultPath = join(cellDir, "result.json");
  if (!existsSync(resultPath)) {
    return { failed: true, reason: "no result.json written", metrics: null, backend: null, exitCode: runOutcome?.exitCode ?? null };
  }
  let result;
  try { result = JSON.parse(readFileSync(resultPath, "utf8")); }
  catch (error) { return { failed: true, reason: `result.json unparsable: ${error.message}`, metrics: null, backend: null, exitCode: runOutcome?.exitCode ?? null }; }
  const backend = result.perRepeat?.[0]?.rendererWindow?.before?.backend ?? null;
  const crashed = (result.crashedRepeats ?? []).length > 0;
  if (crashed) {
    return { failed: true, reason: `crashed repeat: ${JSON.stringify(result.crashedRepeats)}`, metrics: null, backend, exitCode: runOutcome?.exitCode ?? null };
  }
  const gateReason = evaluateStageGate(result, expectBackend);
  const metrics = extractCellMetrics(result);
  if (gateReason) {
    return { failed: true, reason: gateReason, metrics, backend, exitCode: runOutcome?.exitCode ?? null };
  }
  const hasMeasurement = metrics && (metrics.rendererCpuMs != null || metrics.rendererMainThreadCpuMs != null || metrics.gpuProcessCpuMs != null);
  if (!hasMeasurement) {
    return { failed: true, reason: "no cpu/processIdentity measurement in result.json (did --report run take effect?)", metrics, backend, exitCode: runOutcome?.exitCode ?? null };
  }
  return { failed: false, reason: null, metrics, backend, exitCode: runOutcome?.exitCode ?? null };
}

// --- stats + table -----------------------------------------------------------------------------------------

export function stats(values) {
  const finite = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!finite.length) return { n: 0, mean: null, min: null, max: null, spread: null };
  const mean = finite.reduce((s, v) => s + v, 0) / finite.length;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  return { n: finite.length, mean, min, max, spread: max - min };
}

function fmt(v, digits = 1) { return v == null ? "n/a" : v.toFixed(digits); }

function printReport({ order, cells, byArm, baselineArm, expectBackend }) {
  console.log("");
  console.log(`=== per-cell === (expect-backend: ${expectBackend ?? "none (no stage gate)"})`);
  for (const cell of cells) {
    const m = cell.metrics;
    const status = cell.failed ? `FAILED (${cell.reason})` : "ok";
    console.log(`  [${cell.index}] ${cell.arm.padEnd(10)} backend=${cell.backend ?? "n/a"} ${status}`);
    if (m) {
      console.log(`        renderer ${fmt(m.rendererCpuMs)}ms  main-thread ${fmt(m.rendererMainThreadCpuMs)}ms  ` +
        `gpu ${fmt(m.gpuProcessCpuMs)}ms  window ${fmt(m.windowMs)}ms  frames ${m.presentedFrames ?? "n/a"}  ` +
        `delivered ${m.deliveredMessages ?? "n/a"}  cpu/frame ${fmt(m.cpuPerFrame, 3)}ms`);
      if (m.secondary) {
        console.log(`        (trace secondary) renderer ${fmt(m.secondary.rendererCpuMs)}ms  ` +
          `gpu ${fmt(m.secondary.gpuProcessCpuMs)}ms  coverage ${m.secondary.cpuCoverage ?? "n/a"}`);
      }
    }
  }
  console.log("");
  console.log("=== per-arm (successful cells only) ===");
  const baseline = byArm[baselineArm]?.rendererCpuMs?.mean ?? null;
  for (const name of [...new Set(order)]) {
    const a = byArm[name];
    const pct = baseline != null && a.rendererCpuMs.mean != null
      ? `${(((a.rendererCpuMs.mean - baseline) / baseline) * 100).toFixed(1)}%` : "n/a";
    console.log(`  ${name.padEnd(10)} n=${a.n}/${a.total}  ` +
      `renderer mean ${fmt(a.rendererCpuMs.mean)}ms (min ${fmt(a.rendererCpuMs.min)} max ${fmt(a.rendererCpuMs.max)} spread ${fmt(a.rendererCpuMs.spread)})  ` +
      `Δ vs ${baselineArm} ${pct}`);
    console.log(`              main-thread mean ${fmt(a.rendererMainThreadCpuMs.mean)}ms  ` +
      `gpu mean ${fmt(a.gpuProcessCpuMs.mean)}ms  cpu/frame mean ${fmt(a.cpuPerFrame.mean, 3)}ms`);
  }
  console.log("");
}

// --- main ----------------------------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); process.exit(0); }
  if (!args.out) fail("--out is required");
  if (!args.owner) fail("--owner is required");
  if (!args.order || !args.order.length) fail("--order is required (comma-separated arm names)");
  if (!args.config && !args.url) fail("one of --config or --url is required");
  if (args.config && args.url) fail("--config and --url are mutually exclusive");
  if (!args.config && !args.passthrough) fail("--url mode requires passthrough bench args after --");
  for (const name of new Set(args.order)) {
    if (!args.arms.has(name)) fail(`--order references arm '${name}' with no matching --arm`);
  }

  const config = args.config ? JSON.parse(readFileSync(resolve(args.config), "utf8")) : null;
  const baseUrlString = config?.url ?? args.url;
  if (!baseUrlString) fail("no base URL (config.url or --url)");
  const baseUrl = new URL(baseUrlString);
  const leaseResources = config?.requiredLeaseResources ?? defaultLeaseResources(config, baseUrl);
  const expectBackend = inferExpectBackend(baseUrlString, args.expectBackend);

  const outDir = resolve(args.out);
  if (!args.dryRun) {
    if (existsSync(outDir) && readdirSync(outDir).length > 0) fail(`--out '${outDir}' already exists and is non-empty`);
    mkdirSync(outDir, { recursive: true });
  }

  const cells = [];
  args.order.forEach((arm, index) => {
    const armQuery = args.arms.get(arm);
    const cellUrl = buildCellUrl(baseUrlString, armQuery);
    const cellDirName = `${index}-${arm}`;
    const cellDir = join(outDir, cellDirName);
    const benchArgs = buildCellBenchArgs({ config, url: cellUrl, passthrough: args.passthrough, cellDir, extraBenchArgs: args.extraBenchArgs, traced: args.traced });
    cells.push({ index, arm, url: cellUrl, dir: cellDir, benchArgs });
  });

  if (args.dryRun) {
    console.log(`# ${cells.length} cells, expect-backend: ${expectBackend ?? "none"}, lease resources: ${leaseResources.join(", ")}`);
    for (const cell of cells) {
      runCell({ owner: args.owner, leaseResources, benchArgs: cell.benchArgs, cellDir: cell.dir, dryRun: true });
    }
    process.exit(0);
  }

  for (const cell of cells) {
    console.log(`--- cell [${cell.index}] arm=${cell.arm} -> ${cell.dir} ---`);
    const runOutcome = runCell({ owner: args.owner, leaseResources, benchArgs: cell.benchArgs, cellDir: cell.dir, dryRun: false });
    const evaluated = evaluateCell(cell.dir, runOutcome, expectBackend);
    cell.failed = evaluated.failed;
    cell.reason = evaluated.reason;
    cell.metrics = evaluated.metrics;
    cell.backend = evaluated.backend;
    cell.exitCode = evaluated.exitCode;
    if (cell.failed) console.log(`    FAILED: ${cell.reason} (exit ${cell.exitCode}, backend ${cell.backend ?? "n/a"})`);
    else console.log(`    ok (exit ${cell.exitCode}, backend ${cell.backend ?? "n/a"})`);
  }

  const byArm = {};
  for (const name of new Set(args.order)) {
    const armCells = cells.filter((c) => c.arm === name);
    const ok = armCells.filter((c) => !c.failed);
    byArm[name] = {
      total: armCells.length,
      n: ok.length,
      rendererCpuMs: stats(ok.map((c) => c.metrics?.rendererCpuMs)),
      rendererMainThreadCpuMs: stats(ok.map((c) => c.metrics?.rendererMainThreadCpuMs)),
      gpuProcessCpuMs: stats(ok.map((c) => c.metrics?.gpuProcessCpuMs)),
      windowMs: stats(ok.map((c) => c.metrics?.windowMs)),
      cpuPerFrame: stats(ok.map((c) => c.metrics?.cpuPerFrame)),
    };
  }
  const baselineArm = args.order[0];
  printReport({ order: args.order, cells, byArm, baselineArm, expectBackend });

  const summary = {
    schema: "bench-rust-ab-summary/1",
    config: args.config ? resolve(args.config) : null,
    url: baseUrlString,
    arms: Object.fromEntries(args.arms),
    order: args.order,
    expectBackend,
    traced: args.traced,
    leaseResources,
    out: outDir,
    cells: cells.map((c) => ({ index: c.index, arm: c.arm, dir: c.dir, url: c.url, backend: c.backend, failed: c.failed, reason: c.reason, exitCode: c.exitCode, metrics: c.metrics })),
    byArm,
    baselineArm,
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`summary: ${join(outDir, "summary.json")}`);

  const anyFailed = cells.some((c) => c.failed);
  process.exit(anyFailed && cells.every((c) => c.failed) ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
