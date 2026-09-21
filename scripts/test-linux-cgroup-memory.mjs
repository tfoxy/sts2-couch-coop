import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertOwnedScopeName, parseCgroupLimit, parseMemoryEvents, parseProcCgroup,
  readCgroupMemorySample, summarizeCgroupSamples
} from "./lib/linux-cgroup-memory.mjs";

test("cgroup-v2 identity and memory event parsers fail closed", () => {
  assert.deepEqual(parseProcCgroup("0::/user.slice/example.scope\n"), {
    rows: [{ hierarchyId: 0, controllers: [], path: "/user.slice/example.scope" }],
    unifiedPath: "/user.slice/example.scope"
  });
  assert.throws(() => parseProcCgroup("2:cpu:/legacy"), /no unified cgroup-v2 row/);
  assert.deepEqual(parseMemoryEvents("low 2\nhigh 3\noom 1\noom_kill 1\n"), { low: 2, high: 3, oom: 1, oom_kill: 1 });
  assert.throws(() => parseMemoryEvents("oom nope"), /malformed/);
  assert.equal(parseCgroupLimit("max\n"), "max");
  assert.equal(parseCgroupLimit("1073741824\n"), 1_073_741_824);
});

test("scope ownership validation cannot be widened to another unit", () => {
  const token = "42-test-token";
  assert.equal(assertOwnedScopeName(`cc-webkit-memory-${token}.scope`, token), true);
  assert.throws(() => assertOwnedScopeName("session-2.scope", token), /refusing to manage unowned/);
  assert.throws(() => assertOwnedScopeName(`cc-webkit-memory-${token}.service`, token), /refusing to manage unowned/);
});

test("cgroup samples keep current, peak, swap, events, and exact member pids separate", () => {
  const root = mkdtempSync(join(tmpdir(), "cc-cgroup-memory-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "memory.current"), "120\n");
  writeFileSync(join(root, "memory.peak"), "300\n");
  writeFileSync(join(root, "memory.swap.current"), "0\n");
  writeFileSync(join(root, "memory.events"), "oom 0\noom_kill 0\n");
  writeFileSync(join(root, "cgroup.procs"), "20\n10\n");
  assert.deepEqual(readCgroupMemorySample(root), {
    currentBytes: 120, peakBytes: 300, swapCurrentBytes: 0,
    events: { oom: 0, oom_kill: 0 }, memberPids: [10, 20]
  });
  assert.deepEqual(summarizeCgroupSamples([], {}), {
    measured: false, sampleCount: 0, peakBytes: null, currentPeakBytes: null,
    swapPeakBytes: null, latest: null, eventsDelta: {}
  });
  writeFileSync(join(root, "memory.swap.current"), "unknown\n");
  assert.throws(() => readCgroupMemorySample(root), /memory.swap.current is missing or non-numeric/);
});
