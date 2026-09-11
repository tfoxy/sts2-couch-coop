// Exact GPU-process CPU comes from kernel sched_switch accounting, not Chrome's
// partial RunTask slices. This reader is intentionally conservative: a trace
// with any error, incomplete clock/window coverage, or a PID without a stable
// Perfetto process/thread mapping is unavailable.

import { readFileSync } from "node:fs";
import { bootOffsetNs, queryTrace, validateTraceHealth } from "./perfetto-frame-timeline.mjs";

const numbers = (rows, key) => rows.map((row) => Number(row[key])).filter(Number.isSafeInteger);

export function perfettoSchedCpu({ processor, trace, chromeStartUs, chromeEndUs, gpuPids }) {
  if (![processor, trace].every((value) => typeof value === "string" && value)
    || !Number.isFinite(chromeStartUs) || !Number.isFinite(chromeEndUs) || chromeEndUs <= chromeStartUs
    || !Array.isArray(gpuPids) || !gpuPids.length || !gpuPids.every((pid) => Number.isSafeInteger(pid) && pid > 0)) return null;
  const uniquePids = [...new Set(gpuPids)].sort((a, b) => a - b);
  if (uniquePids.length !== gpuPids.length) throw Error("GPU PID ledger contains duplicates");

  // Trace processor categorizes loss separately from generic errors. Both make
  // sched accounting incomplete; the narrow FrameEnd waiver below is the only
  // exception and can apply only to an error row, never data loss.
  const health = queryTrace(processor, trace,
    "SELECT name, severity, value FROM stats WHERE value > 0 AND severity IN ('error', 'data_loss')");
  if (health.some((row) => row.severity === "data_loss")) throw Error("Perfetto trace health reports data loss");
  const healthValidation = validateTraceHealth(health, readFileSync(trace));
  if (!healthValidation) throw Error(`Perfetto trace health errors: ${health.map((row) => `${row.name}=${row.value}`).join(", ")}`);
  const clocks = queryTrace(processor, trace,
    "SELECT ts, clock_value AS monotonic FROM clock_snapshot WHERE clock_name='MONOTONIC' ORDER BY ts");
  const offset = bootOffsetNs(clocks);
  if (offset === null) throw Error("Perfetto MONOTONIC clock alignment is unavailable");
  const fromNs = chromeStartUs * 1000 + offset;
  const toNs = chromeEndUs * 1000 + offset;
  const [bounds] = queryTrace(processor, trace, "SELECT start_ts, end_ts FROM trace_bounds");
  if (!bounds || !Number.isFinite(Number(bounds.start_ts)) || !Number.isFinite(Number(bounds.end_ts))
    || fromNs < Number(bounds.start_ts) || toNs > Number(bounds.end_ts)) throw Error("Perfetto sched trace does not cover marker window");

  // A sched slice is closed by a later sched_switch. An open slice can be a
  // normal trace tail, but it makes any overlapping marker interval unknown.
  const [open] = queryTrace(processor, trace, `SELECT COUNT(*) AS open_slice_count FROM sched_slice
    WHERE dur < 0 AND ts <= ${toNs}`);
  if (!open || Number(open.open_slice_count) !== 0) throw Error("Perfetto has open sched slices in marker window");
  // CPU is the authoritative online-CPU ledger from this ftrace import. Every
  // online core must have an unbroken sched timeline containing both bounds;
  // otherwise a sleeping GPU thread cannot be distinguished from a missing CPU.
  const online = queryTrace(processor, trace, "SELECT cpu FROM cpu ORDER BY cpu");
  const onlineCpus = numbers(online, "cpu");
  if (!onlineCpus.length || onlineCpus.length !== online.length || new Set(onlineCpus).size !== onlineCpus.length) {
    throw Error("Perfetto has no unambiguous online CPU ledger");
  }
  const coverage = queryTrace(processor, trace, `WITH relevant AS (
      SELECT cpu, ts, dur, ts + dur AS end_ts,
        LAG(ts + dur) OVER (PARTITION BY cpu ORDER BY ts) AS previous_end
      FROM sched_slice WHERE dur >= 0 AND ts < ${toNs} AND ts + dur > ${fromNs}
    ) SELECT cpu,
        SUM(CASE WHEN ts <= ${fromNs} AND end_ts >= ${fromNs} THEN 1 ELSE 0 END) AS start_covered,
        SUM(CASE WHEN ts <= ${toNs} AND end_ts >= ${toNs} THEN 1 ELSE 0 END) AS end_covered,
        SUM(CASE WHEN previous_end IS NOT NULL AND ts != previous_end THEN 1 ELSE 0 END) AS gap_count
      FROM relevant GROUP BY cpu ORDER BY cpu`);
  if (coverage.length !== onlineCpus.length || numbers(coverage, "cpu").join(",") !== onlineCpus.join(",")
    || coverage.some((row) => Number(row.start_covered) !== 1 || Number(row.end_covered) !== 1 || Number(row.gap_count) !== 0)) {
    throw Error("Perfetto sched coverage is incomplete on one or more online CPUs");
  }
  // process_stats at capture start and ftrace task lifecycle events should map
  // every running user thread. If an in-window sched thread has no UPID, it
  // could be a GPU worker that process accounting failed to attribute, so do
  // not report a selectively summed GPU process figure.
  const [unmapped] = queryTrace(processor, trace, `SELECT COUNT(DISTINCT s.utid) AS unmapped_thread_count
    FROM sched_slice s JOIN thread t USING(utid)
    WHERE s.dur >= 0 AND s.ts < ${toNs} AND s.ts + s.dur > ${fromNs} AND t.upid IS NULL`);
  if (!unmapped || Number(unmapped.unmapped_thread_count) !== 0) {
    throw Error("Perfetto has unmapped scheduled threads in marker window");
  }

  const pidList = uniquePids.join(",");
  // A stable Chrome GPU PID has one Perfetto process instance. Reused PIDs or
  // absent thread metadata make a summed process figure ambiguous.
  const mappings = queryTrace(processor, trace, `SELECT p.pid, p.upid, COUNT(DISTINCT t.utid) AS thread_count
    FROM process p LEFT JOIN thread t USING(upid) WHERE p.pid IN (${pidList}) GROUP BY p.pid, p.upid ORDER BY p.pid, p.upid`);
  if (mappings.length !== uniquePids.length || numbers(mappings, "pid").join(",") !== uniquePids.join(",")
    || mappings.some((row) => !Number.isSafeInteger(Number(row.upid)) || Number(row.upid) <= 0 || Number(row.thread_count) <= 0)) {
    throw Error("GPU PID ledger does not map to one stable Perfetto process with threads");
  }
  const perPid = queryTrace(processor, trace, `SELECT p.pid, COUNT(s.id) AS slice_count,
      COALESCE(SUM(MAX(0, MIN(s.ts + s.dur, ${toNs}) - MAX(s.ts, ${fromNs}))), 0) AS cpu_ns
    FROM process p JOIN thread t USING(upid) LEFT JOIN sched_slice s ON s.utid = t.utid
      AND s.dur >= 0 AND s.ts < ${toNs} AND s.ts + s.dur > ${fromNs}
    WHERE p.pid IN (${pidList})
    GROUP BY p.pid ORDER BY p.pid`);
  if (perPid.length !== uniquePids.length || numbers(perPid, "pid").join(",") !== uniquePids.join(",")
    || perPid.some((row) => !Number.isSafeInteger(Number(row.slice_count)) || Number(row.slice_count) < 0
      || !Number.isFinite(Number(row.cpu_ns)) || Number(row.cpu_ns) < 0)) {
    throw Error("GPU sched slices are missing for one or more ledger PIDs");
  }
  const cpuNs = perPid.reduce((total, row) => total + Number(row.cpu_ns), 0);
  const windowNs = toNs - fromNs;
  // Multiple threads can run concurrently, so aggregate process CPU can exceed
  // one wall-clock window. It is bounded by the number of mapped GPU threads.
  const threadCount = mappings.reduce((total, row) => total + Number(row.thread_count), 0);
  if (!Number.isFinite(cpuNs) || cpuNs > windowNs * threadCount) throw Error("GPU sched CPU exceeds mapped thread capacity");
  return {
    source: "perfetto-linux-ftrace-sched-switch",
    cpuMs: +(cpuNs / 1_000_000).toFixed(3),
    cpuPct: +((cpuNs / windowNs * 100)).toFixed(3),
    windowMs: +(windowNs / 1_000_000).toFixed(3),
    pids: uniquePids,
    processes: perPid.map((row) => ({ pid: Number(row.pid), cpuMs: +(Number(row.cpu_ns) / 1_000_000).toFixed(3),
      schedSlices: Number(row.slice_count), threadCount: Number(mappings.find((mapping) => Number(mapping.pid) === Number(row.pid)).thread_count) })),
    clock: { source: "Perfetto clock_snapshot MONOTONIC", bootOffsetNs: offset },
    coverage: { traceBounds: "marker-window-contained", health: healthValidation.provenance ?? "no-error-stats",
      onlineCpus: onlineCpus.length, schedTimeline: "continuous-per-online-cpu", unmappedScheduledThreads: 0,
      processMapping: "one-upid-per-ledger-pid" }
  };
}
