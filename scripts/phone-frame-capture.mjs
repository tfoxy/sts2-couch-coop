#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsvRows, bootOffsetNs, queryTrace } from "./lib/perfetto-frame-timeline.mjs";
import { markerWindow } from "./analyze-phone-canvas-cell.mjs";
import { assertLease } from "./live-qa-lock.mjs";

export function captureConfig(schedCpu = false) {
  return `buffers { size_kb: ${schedCpu ? 65536 : 32768} fill_policy: DISCARD }
duration_ms: 180000
data_sources { config { name: "android.surfaceflinger.frametimeline" } }
data_sources { config { name: "linux.process_stats" process_stats_config { scan_all_processes_on_start: true } } }
${schedCpu ? `data_sources { config { name: "linux.ftrace" target_buffer: 0 ftrace_config {
  compact_sched { enabled: true }
  ftrace_events: "sched/sched_switch"
  ftrace_events: "sched/sched_process_exit"
  ftrace_events: "sched/sched_process_free"
  ftrace_events: "task/task_newtask"
  ftrace_events: "task/task_rename"
} } }
` : ""}`;
}
const adb = (serial, args, options = {}) => execFileSync(process.env.ADB_BIN || "adb", ["-s", serial, ...args], {
  encoding: "utf8", timeout: 35_000, ...options
});
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function requireCaptureLock(env = process.env, serial = env.ADB_SERIAL) {
  const expectedOwner = env.COUCHCOOP_LIVEQA_OWNER;
  const expectedPid = env.COUCHCOOP_LIVEQA_PID;
  if (!expectedOwner || !/^\d+$/.test(expectedPid ?? "")) throw new Error("Explicit live-QA owner and PID are required");
  if (!serial) throw new Error("ADB serial is required for the live-QA device lease");
  assertLease({ owner: expectedOwner, pid: Number(expectedPid), resources: ["shared:install", `exclusive:android:${serial}`] });
  return { owner: expectedOwner, pid: Number(expectedPid) };
}

export function chooseChromeLayer(rows, packageName) {
  const eligible = rows.filter((row) => (row.layer_name?.startsWith(`TX - ${packageName}/ChromeChildSurface#`)
      || (packageName === "coop.couch.webview" && row.layer_name?.startsWith(`TX - ${packageName}/${packageName}.MainActivity#`)))
    && /^\d+$/.test(String(row.upid)) && /^\d+$/.test(String(row.pid))
    && (row.process_name === packageName || row.process_name?.startsWith(`${packageName}:`)));
  const candidates = new Map(eligible.map((row) => [`${row.upid}\0${row.layer_name}`, row]));
  if (candidates.size !== 1) return null;
  const row = [...candidates.values()][0];
  return { surface: row.layer_name, upid: Number(row.upid), pid: Number(row.pid), processName: row.process_name };
}

export async function startCapture(args) {
  const owner = requireCaptureLock(process.env, args.serial);
  const prefix = resolve(args.outPrefix);
  const statePath = `${prefix}.perfetto-state.json`;
  if (!args.package) throw new Error("--package is required");
  if (existsSync(statePath)) throw new Error(`Capture already owned: ${statePath}`);
  mkdirSync(dirname(prefix), { recursive: true });
  const remote = `/data/misc/perfetto-traces/couchcoop-${process.pid}-${Date.now()}.pftrace`;
  const requestedSchedCpu = process.env.PERFETTO_SCHED_CPU ?? "off";
  if (!["on", "off"].includes(requestedSchedCpu)) throw new Error("PERFETTO_SCHED_CPU must be on or off");
  const schedCpu = requestedSchedCpu === "on";
  const config = captureConfig(schedCpu);
  writeFileSync(`${prefix}.perfetto.cfg`, config);
  // Perfetto itself backgrounds after acknowledging data-source readiness and prints its capture PID.
  // A shell '&' loses both that acknowledgement and stdin containing the configuration.
  const output = adb(args.serial, ["shell", "perfetto", "--txt", "--background-wait", "-c", "-", "-o", remote], { input: config });
  const pids = output.split(/\r?\n/).filter((line) => /^\d+$/.test(line.trim()));
  if (pids.length !== 1 || Number(pids[0]) <= 0) throw new Error(`Perfetto did not return one capture PID: ${output}`);
  const state = { schema: "phone-frame-capture/1", ...owner, serial: args.serial, package: args.package,
    capturePid: Number(pids[0]), remote, maxDurationMs: 180000, schedCpu };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

async function stopDeviceCapture(state) {
  let cmdline;
  try { cmdline = adb(state.serial, ["shell", "cat", `/proc/${state.capturePid}/cmdline`]); }
  catch (error) {
    if (/No such file or directory/.test(String(error.stderr))) return;
    throw error;
  } // Permission/transport errors are not evidence of capture completion.
  if (!cmdline.includes("perfetto") || !cmdline.includes(state.remote)) throw new Error("Capture PID was reused; refusing to signal it");
  adb(state.serial, ["shell", "kill", "-TERM", String(state.capturePid)]);
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const stat = adb(state.serial, ["shell", "cat", `/proc/${state.capturePid}/stat`], { timeout: 5000 });
      if (/\) Z /.test(stat)) return;
    } catch (error) {
      if (/No such file or directory/.test(String(error.stderr))) return;
      throw error;
    }
    await sleep(100);
  }
  throw new Error("Perfetto did not finish flushing after TERM; capture retained for recovery");
}

export async function stopCapture(args, { cancel = false } = {}) {
  const owner = requireCaptureLock(process.env, args.serial);
  const prefix = resolve(args.outPrefix);
  const statePath = `${prefix}.perfetto-state.json`;
  if (cancel && !existsSync(statePath)) return;
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (state.serial !== args.serial || state.owner !== owner.owner || state.pid !== owner.pid) throw new Error("Capture belongs to another session");
  if (!/^\/data\/misc\/perfetto-traces\/couchcoop-\d+-\d+\.pftrace$/.test(state.remote)
    || !Number.isSafeInteger(state.capturePid) || state.capturePid <= 0) throw new Error("Invalid capture ownership record");
  await stopDeviceCapture(state);
  const local = `${prefix}.pftrace`;
  // Preserve device file/state on pull failure; cancelled runs are still diagnostic evidence.
  adb(state.serial, ["pull", state.remote, local]);
  adb(state.serial, ["shell", "rm", state.remote]);
  unlinkSync(statePath);
  if (cancel) return local;
  if (!args.meta || !args.traceProcessor) throw new Error("--meta and --trace-processor are required");
  const meta = JSON.parse(readFileSync(args.meta, "utf8"));
  meta.artifacts = { ...meta.artifacts, perfettoTrace: local, traceProcessor: args.traceProcessor, perfettoSchedCpu: state.schedCpu === true };
  // Navigation can leave an older content layer in the same capture. Attribute only actual display
  // presents in the measured marker window, rather than whichever surface happened to exist in warmup.
  const traceJson = JSON.parse(readFileSync(meta.artifacts.trace, "utf8"));
  const window = markerWindow(Array.isArray(traceJson) ? traceJson : traceJson.traceEvents, meta.workload.phase);
  const clocks = queryTrace(args.traceProcessor, local, "SELECT ts, clock_value AS monotonic FROM clock_snapshot WHERE clock_name='MONOTONIC'");
  const offset = bootOffsetNs(clocks);
  if (offset === null) throw new Error("Cannot align content-surface attribution to the marker window");
  const fromNs = (window.traceStartUs + window.startMs * 1000) * 1000 + offset;
  const toNs = (window.traceStartUs + window.endMs * 1000) * 1000 + offset;
  const sql = `SELECT DISTINCT a.upid, a.layer_name, p.pid, p.name AS process_name
    FROM actual_frame_timeline_slice a JOIN process p USING(upid)
    JOIN actual_frame_timeline_slice sf ON sf.display_frame_token = a.display_frame_token
    JOIN process sp ON sp.upid = sf.upid
    WHERE a.layer_name IS NOT NULL AND sf.layer_name IS NULL AND sp.name GLOB '*surfaceflinger'
      AND sf.dur > 0 AND sf.ts + sf.dur >= ${fromNs} AND sf.ts + sf.dur <= ${toNs}`;
  const rows = parseCsvRows(execFileSync(args.traceProcessor, [local, "-Q", sql], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
  const layer = chooseChromeLayer(rows, state.package);
  meta.presentation = layer ? { ...layer, source: "Perfetto actual_frame_timeline_slice" }
    : { error: "Missing or ambiguous Chrome content surface", source: "Perfetto actual_frame_timeline_slice" };
  writeFileSync(args.meta, `${JSON.stringify(meta, null, 2)}\n`);
  if (!layer) throw new Error(meta.presentation.error);
  return local;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    const command = argv.shift();
    const args = {};
    while (argv.length) {
      const key = argv.shift();
      if (!['--serial', '--out-prefix', '--package', '--meta', '--trace-processor'].includes(key) || !argv.length) throw new Error(`Invalid argument: ${key}`);
      args[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv.shift();
    }
    if (!args.serial || !args.outPrefix) throw new Error("--serial and --out-prefix are required");
    if (command === "start") await startCapture(args);
    else if (command === "stop" || command === "cancel") await stopCapture(args, { cancel: command === "cancel" });
    else throw new Error("Use start, stop, or cancel");
  } catch (error) { console.error(`phone-frame-capture: ${error.message}`); process.exitCode = 1; }
}
