import assert from "node:assert/strict";
import test from "node:test";

import { computeCpuBlock, processKeyOf } from "./trace-cpu-block.mjs";

// Metadata + a small cross-process event set. Window is [1_000_000, 3_000_000] us
// (2000 ms). Renderer main: one 1000 ms task, 800 ms CPU. Renderer compositor:
// one 400 ms task with NO tdur (CPU unknown). Browser main: one 200 ms task,
// 100 ms CPU. GPU main: one 600 ms task, 60 ms CPU. Plus a nested child on the
// renderer main that must NOT be double-counted, and one event fully outside the
// window that must be ignored.
const META = [
  { ph: "M", name: "process_name", pid: 10, tid: 0, args: { name: "Renderer" } },
  { ph: "M", name: "thread_name", pid: 10, tid: 1, args: { name: "CrRendererMain" } },
  { ph: "M", name: "thread_name", pid: 10, tid: 2, args: { name: "Compositor" } },
  { ph: "M", name: "process_name", pid: 20, tid: 0, args: { name: "Browser" } },
  { ph: "M", name: "thread_name", pid: 20, tid: 1, args: { name: "CrBrowserMain" } },
  { ph: "M", name: "process_name", pid: 30, tid: 0, args: { name: "GPU Process" } },
  { ph: "M", name: "thread_name", pid: 30, tid: 1, args: { name: "CrGpuMain" } },
];

const EVENTS = [
  ...META,
  { ph: "X", name: "RunTask", pid: 10, tid: 1, ts: 1_000_000, dur: 1_000_000, tdur: 800_000 },
  // nested child of the task above — its time is already inside the parent.
  { ph: "X", name: "SomeChild", pid: 10, tid: 1, ts: 1_200_000, dur: 300_000, tdur: 250_000 },
  { ph: "X", name: "RunTask", pid: 10, tid: 2, ts: 1_500_000, dur: 400_000 },
  { ph: "X", name: "RunTask", pid: 20, tid: 1, ts: 1_100_000, dur: 200_000, tdur: 100_000 },
  { ph: "X", name: "GpuWork", pid: 30, tid: 1, ts: 1_400_000, dur: 600_000, tdur: 60_000 },
  // fully outside the window — ignored.
  { ph: "X", name: "RunTask", pid: 10, tid: 1, ts: 5_000_000, dur: 100_000, tdur: 90_000 },
];

const WINDOW = { startTs: 1_000_000, endTs: 3_000_000, windowMs: 2000 };

test("processKeyOf normalises the three known processes and slugs the rest", () => {
  assert.equal(processKeyOf("Renderer"), "renderer");
  assert.equal(processKeyOf("Browser"), "browser");
  assert.equal(processKeyOf("GPU Process"), "gpu");
  assert.equal(processKeyOf("Utility: Network Service"), "utility-network-service");
  assert.equal(processKeyOf(""), "unknown");
});

test("folds by (process, thread), excludes nested children and out-of-window events", () => {
  const cpu = computeCpuBlock(EVENTS, WINDOW);

  assert.equal(cpu.windowMs, 2000);

  const main = cpu.byThread.find((r) => r.thread === "CrRendererMain");
  assert.ok(main, "renderer main row present");
  // 800 ms CPU from the parent task only — the 250 ms nested child is not added.
  assert.equal(main.cpuMs, 800);
  assert.equal(main.wallMs, 1000);
  assert.equal(main.instances, 1);
  // coreRatio = cpuUs / windowUs = 800000 / 2000000 = 0.4
  assert.equal(main.coreRatio, 0.4);

  // the out-of-window renderer-main task is not counted.
  assert.ok(cpu.byThread.every((r) => r.cpuMs <= 800));
});

test("a thread whose events carry no tdur reports wallMs > 0, cpuMs 0", () => {
  const cpu = computeCpuBlock(EVENTS, WINDOW);
  const comp = cpu.byThread.find((r) => r.thread === "Compositor");
  assert.ok(comp);
  assert.equal(comp.cpuMs, 0);
  assert.equal(comp.wallMs, 400);
  assert.equal(comp.coreRatio, 0);
});

test("byProcess is keyed renderer|browser|gpu and totals add up", () => {
  const cpu = computeCpuBlock(EVENTS, WINDOW);
  assert.deepEqual(Object.keys(cpu.byProcess).sort(), ["browser", "gpu", "renderer"]);
  assert.equal(cpu.byProcess.renderer.cpuMs, 800);
  assert.equal(cpu.byProcess.renderer.threads, 2); // main + compositor
  assert.equal(cpu.byProcess.browser.cpuMs, 100);
  assert.equal(cpu.byProcess.gpu.cpuMs, 60);

  // totalCpuMs = 800 + 0 + 100 + 60 = 960; totalCoreRatio = 960000/2000000 = 0.48
  assert.equal(cpu.totalCpuMs, 960);
  assert.equal(cpu.totalCoreRatio, 0.48);
});

test("cpuCoverage is the tdur-known fraction of summed wall time", () => {
  const cpu = computeCpuBlock(EVENTS, WINDOW);
  // known wall = 1000 (main) + 200 (browser) + 600 (gpu) = 1800 ms
  // total wall = 1800 + 400 (compositor, no tdur) = 2200 ms
  // coverage = 1800 / 2200 = 0.8182
  assert.ok(Math.abs(cpu.cpuCoverage - 0.8182) < 0.001, `coverage ${cpu.cpuCoverage}`);
  assert.ok(cpu.cpuCoverage < 1);
});

test("straddling events contribute a clamped tdur fraction", () => {
  // one task that starts 500 ms before the window and ends 500 ms into it:
  // dur 1000 ms, tdur 1000 ms, overlap 500 ms -> cpu 500 ms.
  const events = [
    { ph: "M", name: "process_name", pid: 10, tid: 0, args: { name: "Renderer" } },
    { ph: "M", name: "thread_name", pid: 10, tid: 1, args: { name: "CrRendererMain" } },
    { ph: "X", name: "RunTask", pid: 10, tid: 1, ts: 500_000, dur: 1_000_000, tdur: 1_000_000 },
  ];
  const cpu = computeCpuBlock(events, { startTs: 1_000_000, endTs: 3_000_000, windowMs: 2000 });
  const main = cpu.byThread.find((r) => r.thread === "CrRendererMain");
  assert.equal(main.cpuMs, 500);
  assert.equal(main.wallMs, 500);
});

test("an empty window yields all-zero totals and byThread []", () => {
  const cpu = computeCpuBlock(EVENTS, { startTs: 90_000_000, endTs: 91_000_000, windowMs: 1000 });
  assert.deepEqual(cpu.byThread, []);
  assert.deepEqual(cpu.byProcess, {});
  assert.equal(cpu.totalCpuMs, 0);
  assert.equal(cpu.totalCoreRatio, 0);
  assert.equal(cpu.cpuCoverage, 0);
  assert.equal(cpu.windowMs, 1000);
});

test("falls back to the trace's own metadata when maps are not supplied", () => {
  const withMaps = computeCpuBlock(EVENTS, {
    ...WINDOW,
    threadNames: new Map([
      ["10:1", "CrRendererMain"],
      ["10:2", "Compositor"],
      ["20:1", "CrBrowserMain"],
      ["30:1", "CrGpuMain"],
    ]),
    processNames: new Map([
      [10, "Renderer"],
      [20, "Browser"],
      [30, "GPU Process"],
    ]),
  });
  const withoutMaps = computeCpuBlock(EVENTS, WINDOW);
  assert.deepEqual(withMaps.byProcess, withoutMaps.byProcess);
});
