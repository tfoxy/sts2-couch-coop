#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { perfettoSchedCpu } from "./lib/perfetto-sched-cpu.mjs";

const bytes = (...parts) => Uint8Array.from(parts.flatMap((part) => [...part]));
const uint64 = (value) => { let n = BigInt(value); const out = []; do { const b = Number(n & 0x7fn); n >>= 7n; out.push(n ? b | 0x80 : b); } while (n); return Uint8Array.from(out); };
const scalar = (field, value) => bytes(uint64(BigInt(field) << 3n), uint64(value));
const message = (field, value) => bytes(uint64((BigInt(field) << 3n) | 2n), uint64(value.length), value);
const packet = (timestamp, event) => message(1, bytes(scalar(8, timestamp), message(76, event)));
const actualStart = (cookie, token) => message(4, bytes(scalar(1, cookie), scalar(3, token)));
const frameEnd = (cookie) => message(5, scalar(1, cookie));
const knownFrameEndDefect = bytes(packet(100n, actualStart(7n, 11n)), packet(0x8000000000000000n, frameEnd(7n)));

const dir = mkdtempSync(join(tmpdir(), "perfetto-sched-cpu-"));
try {
  const processor = join(dir, "processor"), trace = join(dir, "trace");
  writeFileSync(trace, "");
  writeFileSync(processor, `#!/usr/bin/env node
const q=process.argv.at(-1), mode=process.env.MODE||"good"; const csv=(s)=>console.log(s);
if(q.includes("FROM stats")) csv(mode==="health"?"name,value\\nftrace_cpu_buffer_overrun,1":mode==="dataLoss"?"name,severity,value\\ntrace_sorter_negative_timestamp_dropped,data_loss,1":mode==="known"?"name,value\\ntrace_sorter_negative_timestamp_dropped,1":"name,value");
else if(q.includes("FROM clock_snapshot")) csv("ts,monotonic\\n1000500,1000000\\n2000500,2000000");
else if(q.includes("FROM trace_bounds")) csv("start_ts,end_ts\\n1000000,3000000");
else if(q.includes("open_slice_count")) csv(mode==="open"?"open_slice_count\\n1":"open_slice_count\\n0");
else if(q==="SELECT cpu FROM cpu ORDER BY cpu") csv("cpu\\n0\\n1");
else if(q.includes("WITH relevant")) csv(mode==="missingCPU"?"cpu,start_covered,end_covered,gap_count\\n0,1,1,0":"cpu,start_covered,end_covered,gap_count\\n0,1,1,0\\n1,1,1,0");
else if(q.includes("unmapped_thread_count")) csv(mode==="unmapped"?"unmapped_thread_count\\n1":"unmapped_thread_count\\n0");
else if(q.includes("COUNT(DISTINCT t.utid)")) csv(mode==="mapping"?"pid,upid,thread_count\\n41,8,2":"pid,upid,thread_count\\n41,8,2\\n42,9,3");
else if(q.includes("COUNT(s.id)")) csv(mode==="slices"?"pid,slice_count,cpu_ns\\n41,2,200000":"pid,slice_count,cpu_ns\\n41,2,200000\\n42,0,0");
else process.exit(7);`, { mode: 0o755 });
  const input = { processor, trace, chromeStartUs: 1000, chromeEndUs: 2000, gpuPids: [41, 42] };
  const result = perfettoSchedCpu(input);
  assert.deepEqual(result.processes, [{ pid: 41, cpuMs: 0.2, schedSlices: 2, threadCount: 2 }, { pid: 42, cpuMs: 0, schedSlices: 0, threadCount: 3 }],
    "a mapped GPU thread/process can be sleeping for the whole complete window");
  assert.equal(result.cpuMs, 0.2);
  assert.equal(result.cpuPct, 20);
  assert.equal(result.coverage.onlineCpus, 2);
  assert.deepEqual(result.pids, [41, 42]);
  assert.throws(() => perfettoSchedCpu({ ...input, gpuPids: [41] }), /stable Perfetto process/);
  // Even an otherwise auditable packet cannot waive a data-loss severity.
  writeFileSync(trace, knownFrameEndDefect);
  for (const [mode, expected] of [["health", /Perfetto trace health/], ["dataLoss", /Perfetto trace health/], ["mapping", /stable Perfetto process/], ["slices", /sched slices/],
    ["missingCPU", /coverage is incomplete/], ["open", /open sched slices/], ["unmapped", /unmapped scheduled threads/] ]) {
    process.env.MODE = mode;
    assert.throws(() => perfettoSchedCpu(input), expected);
  }
  process.env.MODE = "known";
  writeFileSync(trace, knownFrameEndDefect);
  const known = perfettoSchedCpu(input);
  assert.equal(known.coverage.health.kind, "trace_sorter_negative_timestamp_dropped", "only the raw-audited FrameEnd anomaly is tolerated");
  delete process.env.MODE;
  console.log("Perfetto sched CPU coverage, sleeping-thread, and health tests passed");
} finally { rmSync(dir, { recursive: true, force: true }); }
