import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  LINUX_PROCESS_MEMORY_SCHEMA, LinuxProcessMemoryError, LinuxProcessMemorySampler,
  MAPPING_CLASS_PRECEDENCE, aggregateMappings, assertMappingByteConservation, classifyLinuxProcessRole,
  classifyMapping, legacyRssSummary, parseProcStat, parseProcStatus, parseSmaps, parseSmapsRollup
} from "./lib/linux-process-memory.mjs";

const K = 1024;
const fixtureRoot = () => mkdtempSync(join(tmpdir(), "linux-process-memory-"));
const stat = ({ pid, ppid = 1, start = 100, comm = "normal (tricky) comm" }) => {
  const fields = Array(20).fill("0");
  fields[0] = "S"; fields[1] = String(ppid); fields[19] = String(start);
  return `${pid} (${comm}) ${fields.join(" ")}\n`;
};
const rollup = ({ rss = 12, pss = 8, optional = true } = {}) => [
  "00400000-00402000 r--p 00000000 00:00 0 [rollup]", `Rss: ${rss} kB`, `Pss: ${pss} kB`,
  "Shared_Clean: 2 kB", "Private_Dirty: 3 kB", "Anonymous: 4 kB",
  ...(optional ? ["Swap: 1 kB", "Locked: 1 kB"] : [])
].join("\n") + "\n";
const smaps = () => [
  "1000-3000 rw-p 00000000 00:00 0 [heap]", "Size: 8 kB", "Rss: 8 kB", "Pss: 6 kB", "Private_Dirty: 6 kB",
  "3000-4000 r-xs 00000000 00:01 2 /opt/code.so", "Size: 4 kB", "Rss: 4 kB", "Pss: 2 kB", "Shared_Clean: 4 kB"
].join("\n") + "\n";

function processFixture(root, { pid, ppid = 1, start = 100, exe = "helper", cmdline = exe, status = "Name:\thelper\nVmRSS:\t12 kB\nRssAnon:\t4 kB\n", rollupText = rollup(), smapsText = smaps() }) {
  const dir = join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stat"), stat({ pid, ppid, start }));
  symlinkSync(`/usr/bin/${exe}`, join(dir, "exe"));
  writeFileSync(join(dir, "cmdline"), `${cmdline}\0`);
  writeFileSync(join(dir, "status"), status);
  writeFileSync(join(dir, "smaps_rollup"), rollupText);
  writeFileSync(join(dir, "smaps"), smapsText);
}

test("parses stat identity with spaces and parentheses in comm", () => {
  assert.deepEqual(parseProcStat(stat({ pid: 42, ppid: 7, start: 12345, comm: "a ) difficult ( comm" })), {
    pid: 42, ppid: 7, startTimeTicks: 12345, comm: "a ) difficult ( comm"
  });
  assert.throws(() => parseProcStat("42 malformed"), LinuxProcessMemoryError);
});

test("parses status and rollup bytes without inventing optional kernel fields", () => {
  const status = parseProcStatus("Name:\tWPEWebProcess\nVmRSS:\t12 kB\nRssFile:\t3 kB\nVmSwap:\t0 kB\n");
  assert.deepEqual(status, { name: "WPEWebProcess", rssBytes: 12 * K, fileBytes: 3 * K, swapBytes: 0 });
  const parsed = parseSmapsRollup(rollup({ optional: false }));
  assert.equal(parsed.rssBytes, 12 * K);
  assert.equal(parsed.pssBytes, 8 * K);
  assert.equal("swapBytes" in parsed, false);
  assert.equal("lockedBytes" in parsed, false);
});

test("parses realistic detailed smaps rows", () => {
  const rows = parseSmaps(smaps());
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    start: 0x1000, end: 0x3000, sizeBytes: 8 * K, permissions: "rw-p", pathname: "[heap]",
    rssBytes: 8 * K, pssBytes: 6 * K, privateDirtyBytes: 6 * K
  });
  assert.equal(rows[1].sharedCleanBytes, 4 * K);
});

test("mapping precedence is explicit and aggregates conserve every parsed byte", () => {
  assert.deepEqual(MAPPING_CLASS_PRECEDENCE, ["stack", "graphics/device", "memfd/deleted", "shm", "executable/JIT", "anonymous/heap", "file-backed", "other"]);
  const rows = [
    { pathname: "[stack:12]", permissions: "rw-p", sizeBytes: 1 * K, rssBytes: 1 * K },
    { pathname: "/dev/dri/renderD128", permissions: "rw-p", sizeBytes: 2 * K, rssBytes: 2 * K },
    { pathname: "/dev/shm/memfd:both (deleted)", permissions: "rw-p", sizeBytes: 3 * K, rssBytes: 3 * K },
    { pathname: "/dev/shm/shared", permissions: "rw-p", sizeBytes: 4 * K, rssBytes: 4 * K },
    { pathname: "[anon:jit]", permissions: "r-xp", sizeBytes: 5 * K, rssBytes: 5 * K },
    { pathname: "[heap]", permissions: "rw-p", sizeBytes: 6 * K, rssBytes: 6 * K },
    { pathname: "/usr/lib/libx.so", permissions: "r--p", sizeBytes: 7 * K, rssBytes: 7 * K },
    { pathname: "[vdso]", permissions: "r-xp", sizeBytes: 8 * K, rssBytes: 8 * K }
  ];
  assert.deepEqual(rows.map(classifyMapping), ["stack", "graphics/device", "memfd/deleted", "shm", "executable/JIT", "anonymous/heap", "file-backed", "executable/JIT"]);
  const aggregate = assertMappingByteConservation(aggregateMappings(rows));
  assert.equal(aggregate.totals.mappingCount, rows.length);
  assert.equal(aggregate.totals.rssBytes, 36 * K);
  assert.equal(Object.values(aggregate.classes).reduce((sum, part) => sum + (part.rssBytes ?? 0), 0), 36 * K);
  assert.throws(() => assertMappingByteConservation({ ...aggregate, totals: { ...aggregate.totals, rssBytes: 1 } }), /does not conserve/);
});

test("all WebKit roles are deterministic", () => {
  const rootPid = 1;
  assert.equal(classifyLinuxProcessRole({ pid: 1, rootPid, exeBasename: "node", cmdline: "node run" }), "root-launcher");
  assert.equal(classifyLinuxProcessRole({ pid: 2, rootPid, exeBasename: "MiniBrowser", cmdline: "" }), "browser");
  assert.equal(classifyLinuxProcessRole({ pid: 3, rootPid, exeBasename: "WPENetworkProcess", cmdline: "" }), "network");
  assert.equal(classifyLinuxProcessRole({ pid: 4, rootPid, exeBasename: "WPEWebProcess", cmdline: "" }), "web-content");
  assert.equal(classifyLinuxProcessRole({ pid: 5, rootPid, exeBasename: "WebKitGPUProcess", cmdline: "" }), "gpu");
  assert.equal(classifyLinuxProcessRole({ pid: 6, rootPid, exeBasename: "sidecar", cmdline: "" }), "other:sidecar");
});

test("sampler emits bounded schema, raw paths, capability evidence, and secure artifacts", () => {
  const root = fixtureRoot(); const out = join(root, "out");
  try {
    processFixture(root, { pid: 10, ppid: 1, exe: "launcher", cmdline: "launcher" });
    processFixture(root, { pid: 11, ppid: 10, exe: "MiniBrowser" });
    processFixture(root, { pid: 12, ppid: 10, exe: "WPEWebProcess" });
    const sampler = new LinuxProcessMemorySampler({ rootPid: 10, mode: "smaps", outDir: out, procRoot: root });
    const summary = sampler.capture({ label: "mark", index: 2 });
    assert.equal(summary.schema, LINUX_PROCESS_MEMORY_SCHEMA);
    assert.equal(summary.rawDir, "linux-process-memory-mark-2");
    assert.equal(summary.processes.length, 3);
    assert.equal(summary.processes[0].role, "root-launcher");
    assert.equal(summary.processes[2].role, "web-content");
    assert.equal(summary.processes[0].metrics.name, undefined);
    assert.equal(summary.capabilities.rollupFields.swapBytes, true);
    assert.equal(summary.totals.rssIsSummedAcrossProcesses, true);
    assert.equal(summary.totals.uniqueMemoryMetric, "pssBytes");
    const raw = summary.processes[0].raw;
    assert.equal(raw.cmdline.includes(root), false);
    assert.match(readFileSync(join(out, raw.cmdline), "utf8"), /launcher/);
    assert.equal(statSync(join(out, summary.rawDir)).mode & 0o777, 0o700);
    assert.equal(statSync(join(out, raw.smaps_rollup)).mode & 0o777, 0o600);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("RSS remains distinct from PSS when a shared mapping appears in two processes", () => {
  const aggregate = aggregateMappings([
    { pathname: "/dev/shm/shared", permissions: "rw-s", sizeBytes: 4 * K, rssBytes: 4 * K, pssBytes: 2 * K },
    { pathname: "/dev/shm/shared", permissions: "rw-s", sizeBytes: 4 * K, rssBytes: 4 * K, pssBytes: 2 * K }
  ]);
  assert.equal(aggregate.totals.rssBytes, 8 * K);
  assert.equal(aggregate.totals.pssBytes, 4 * K);
});

test("pinned sampler fails closed for replacement, additions, drops, and unreadable required rollup", () => {
  const root = fixtureRoot(); const out = join(root, "out");
  try {
    processFixture(root, { pid: 20, ppid: 1, exe: "launcher" });
    processFixture(root, { pid: 21, ppid: 20, exe: "MiniBrowser" });
    const sampler = new LinuxProcessMemorySampler({ rootPid: 20, outDir: out, procRoot: root });
    sampler.capture({ label: "first" });
    writeFileSync(join(root, "21", "cmdline"), "WPEWebProcess\0");
    assert.throws(() => sampler.capture({ label: "role" }), /process tree (changed|differs)/);
    writeFileSync(join(root, "21", "cmdline"), "MiniBrowser\0");
    writeFileSync(join(root, "21", "stat"), stat({ pid: 21, ppid: 20, start: 999 }));
    assert.throws(() => sampler.capture({ label: "replacement" }), /process tree (changed|differs)/);
    writeFileSync(join(root, "21", "stat"), stat({ pid: 21, ppid: 20, start: 100 }));
    processFixture(root, { pid: 22, ppid: 20, exe: "WPENetworkProcess" });
    assert.throws(() => sampler.capture({ label: "add" }), /process tree (changed|differs)/);
    rmSync(join(root, "22"), { recursive: true });
    rmSync(join(root, "21"), { recursive: true });
    assert.throws(() => sampler.capture({ label: "drop" }), /process tree (changed|differs)/);
    const bad = fixtureRoot();
    try {
      processFixture(bad, { pid: 30, ppid: 1 });
      rmSync(join(bad, "30", "smaps_rollup"));
      assert.throws(() => new LinuxProcessMemorySampler({ rootPid: 30, outDir: join(bad, "out"), procRoot: bad }).capture(), /required proc evidence/);
    } finally { rmSync(bad, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy RSS projection is available for gradual probe integration", () => {
  assert.deepEqual(legacyRssSummary({ rootPid: 8, processes: [{ pid: 8, metrics: { rssBytes: 3 } }], totals: { rssBytes: 3 } }), {
    rootPid: 8, processes: [{ pid: 8, rssBytes: 3 }], totalBytes: 3
  });
});
