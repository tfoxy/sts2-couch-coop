import { accessSync, constants, readFileSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const LINUX_CGROUP_MEMORY_SCHEMA = "couchcoop-linux-cgroup-memory/1";
export const SYSTEMD_SCOPE_PREFIX = "cc-webkit-memory";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseProcCgroup(text) {
  const rows = String(text).trim().split(/\r?\n/).filter(Boolean).map(line => {
    const match = /^(\d+):([^:]*):(\/.*)$/.exec(line);
    if (!match) throw new Error(`malformed /proc cgroup row: ${JSON.stringify(line)}`);
    return { hierarchyId: Number(match[1]), controllers: match[2] ? match[2].split(",") : [], path: match[3] };
  });
  const unified = rows.find(row => row.hierarchyId === 0 && row.controllers.length === 0);
  if (!unified) throw new Error("/proc cgroup identity has no unified cgroup-v2 row");
  return { rows, unifiedPath: unified.path };
}

export function parseMemoryEvents(text) {
  const result = {};
  for (const line of String(text).trim().split(/\r?\n/).filter(Boolean)) {
    const match = /^(\S+)\s+(\d+)$/.exec(line);
    if (!match) throw new Error(`malformed memory.events row: ${JSON.stringify(line)}`);
    result[match[1]] = Number(match[2]);
  }
  return result;
}

export function parseCgroupLimit(text, label = "cgroup limit") {
  const value = String(text).trim();
  if (value === "max") return "max";
  if (!/^\d+$/.test(value)) throw new Error(`${label} is neither max nor an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} exceeds JavaScript's safe integer range`);
  return parsed;
}

export function assertOwnedScopeName(unit, token) {
  const expected = `${SYSTEMD_SCOPE_PREFIX}-${token}`;
  if (unit !== `${expected}.scope`) throw new Error(`refusing to manage unowned systemd scope ${JSON.stringify(unit)}`);
  if (!/^[a-zA-Z0-9_.-]+$/.test(unit)) throw new Error(`unsafe systemd scope name ${JSON.stringify(unit)}`);
  return true;
}

const readNumber = (path, label) => {
  const value = String(readFileSync(path, "utf8")).trim();
  if (!/^\d+$/.test(value)) throw new Error(`${label} is missing or non-numeric at ${path}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} exceeds JavaScript's safe integer range`);
  return parsed;
};

export function readCgroupMemorySample(cgroupDir) {
  const memberPids = readFileSync(join(cgroupDir, "cgroup.procs"), "utf8").trim().split(/\s+/).filter(Boolean).map(Number).sort((a, b) => a - b);
  return {
    currentBytes: readNumber(join(cgroupDir, "memory.current"), "memory.current"),
    peakBytes: readNumber(join(cgroupDir, "memory.peak"), "memory.peak"),
    swapCurrentBytes: readNumber(join(cgroupDir, "memory.swap.current"), "memory.swap.current"),
    events: parseMemoryEvents(readFileSync(join(cgroupDir, "memory.events"), "utf8")),
    memberPids
  };
}

export function summarizeCgroupSamples(samples, initialEvents = {}) {
  const measured = samples.filter(sample => sample && typeof sample.currentBytes === "number");
  const latest = measured.at(-1) ?? null;
  const eventsDelta = {};
  for (const [name, value] of Object.entries(latest?.events ?? {})) eventsDelta[name] = value - (initialEvents[name] ?? 0);
  return {
    measured: measured.length > 0,
    sampleCount: measured.length,
    peakBytes: measured.length ? measured.reduce((max, sample) => Math.max(max, sample.peakBytes, sample.currentBytes), 0) : null,
    currentPeakBytes: measured.length ? measured.reduce((max, sample) => Math.max(max, sample.currentBytes), 0) : null,
    swapPeakBytes: measured.length ? measured.reduce((max, sample) => Math.max(max, sample.swapCurrentBytes), 0) : null,
    latest,
    eventsDelta
  };
}

export class LinuxCgroupMemorySampler {
  constructor({ unit, token, cgroupPath, cgroupRoot = "/sys/fs/cgroup", browserPid, launcherPid, nodePid = process.pid }) {
    assertOwnedScopeName(unit, token);
    this.unit = unit;
    this.token = token;
    this.cgroupPath = cgroupPath;
    this.cgroupDir = join(cgroupRoot, cgroupPath.replace(/^\/+/, ""));
    this.browserPid = browserPid;
    this.launcherPid = launcherPid;
    this.nodePid = nodePid;
    accessSync(this.cgroupDir, constants.R_OK | constants.W_OK);
    for (const name of ["memory.current", "memory.peak", "memory.events", "memory.swap.current", "memory.max", "memory.swap.max", "cgroup.procs"]) {
      accessSync(join(this.cgroupDir, name), constants.R_OK);
    }
    const browser = parseProcCgroup(readFileSync(`/proc/${browserPid}/cgroup`, "utf8"));
    const launcher = parseProcCgroup(readFileSync(`/proc/${launcherPid}/cgroup`, "utf8"));
    const orchestrator = parseProcCgroup(readFileSync(`/proc/${nodePid}/cgroup`, "utf8"));
    if (browser.unifiedPath !== cgroupPath || launcher.unifiedPath !== cgroupPath) {
      throw new Error(`browser cgroup identity mismatch: expected ${cgroupPath}, browser=${browser.unifiedPath}, launcher=${launcher.unifiedPath}`);
    }
    if (orchestrator.unifiedPath === cgroupPath) throw new Error("Node orchestrator unexpectedly entered the WebKit cgroup");
    this.identity = {
      browser: { pid: browserPid, cgroupPath: browser.unifiedPath, exe: readlinkSync(`/proc/${browserPid}/exe`) },
      launcher: { pid: launcherPid, cgroupPath: launcher.unifiedPath, exe: readlinkSync(`/proc/${launcherPid}/exe`) },
      orchestrator: { pid: nodePid, cgroupPath: orchestrator.unifiedPath, outsideBrowserCgroup: true }
    };
    this.config = {
      memoryMax: parseCgroupLimit(readFileSync(join(this.cgroupDir, "memory.max"), "utf8"), "memory.max"),
      memorySwapMax: parseCgroupLimit(readFileSync(join(this.cgroupDir, "memory.swap.max"), "utf8"), "memory.swap.max")
    };
    this.initial = this.capture();
  }

  capture() { return readCgroupMemorySample(this.cgroupDir); }
}

const scopeProperty = value => value === null ? "infinity" : String(value);

/** Launches only the WebKit command in a fresh transient user scope; the calling Node process remains outside. */
export async function launchWebKitScope({ executable, args, memoryMaxBytes = null, memorySwapMaxBytes = 0, timeoutMs = 10_000 }) {
  if (process.platform !== "linux") throw new Error("the cgroup WebKit harness requires Linux");
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const base = `${SYSTEMD_SCOPE_PREFIX}-${token}`;
  const unit = `${base}.scope`;
  assertOwnedScopeName(unit, token);
  const command = [
    "--user", "--scope", "--quiet", `--unit=${base}`,
    `--property=MemoryMax=${scopeProperty(memoryMaxBytes)}`,
    `--property=MemorySwapMax=${scopeProperty(memorySwapMaxBytes)}`,
    "--property=KillMode=control-group",
    executable, ...args
  ];
  const child = spawn("systemd-run", command, { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
  let systemdStderr = "";
  let spawnError = null;
  child.stderr.on("data", chunk => { systemdStderr += chunk.toString("utf8"); });
  child.once("error", error => { spawnError = error; });
  try {
    const deadline = Date.now() + timeoutMs;
    let cgroupPath = "";
    let launcherPid = null;
    let browserPid = null;
    const wantedBrowser = "MiniBrowser";
    while (Date.now() < deadline && !browserPid) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`systemd-run exited before WebKit scope became ready: ${systemdStderr.trim()}`);
      try {
        const shown = await execFileAsync("systemctl", ["--user", "show", unit, "--property=ControlGroup", "--value"], { encoding: "utf8" });
        cgroupPath = shown.stdout.trim();
        if (cgroupPath) {
          const cgroupDir = join("/sys/fs/cgroup", cgroupPath.replace(/^\/+/, ""));
          accessSync(cgroupDir, constants.R_OK | constants.W_OK);
          const members = readFileSync(join(cgroupDir, "cgroup.procs"), "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
          const memberSet = new Set(members);
          for (const pid of members) {
            try {
              const exe = readlinkSync(`/proc/${pid}/exe`);
              const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
              const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
              if (!memberSet.has(ppid)) launcherPid ??= pid;
              if (basename(exe) === wantedBrowser) browserPid = pid;
            } catch { /* member raced during startup */ }
          }
        }
      } catch { /* scope has not appeared yet */ }
      if (!browserPid) await wait(20);
    }
    if (!cgroupPath || !launcherPid || !browserPid) {
      throw new Error(`WebKit scope startup timed out: cgroup=${JSON.stringify(cgroupPath)} launcher=${launcherPid} browser=${browserPid}; ${systemdStderr.trim()}`);
    }
    const sampler = new LinuxCgroupMemorySampler({ unit, token, cgroupPath, browserPid, launcherPid });
    if (sampler.config.memoryMax !== (memoryMaxBytes ?? "max")) throw new Error("systemd scope did not apply the requested memory.max");
    if (sampler.config.memorySwapMax !== (memorySwapMaxBytes ?? "max")) throw new Error("systemd scope did not apply the requested memory.swap.max");
    return { child, unit, token, cgroupPath, launcherPid, browserPid, sampler, systemdStderr: () => systemdStderr, command };
  } catch (error) {
    await stopOwnedScope({ unit, token }).catch(() => {});
    if (child.exitCode === null) child.kill("SIGTERM");
    throw error;
  }
}

export async function stopOwnedScope({ unit, token, timeoutMs = 4_000 }) {
  assertOwnedScopeName(unit, token);
  let stopError = null;
  try { await execFileAsync("systemctl", ["--user", "stop", unit], { encoding: "utf8" }); }
  catch (error) {
    if (!/not loaded|not found|could not be found/i.test(`${error.stderr ?? ""}\n${error.message}`)) stopError = error.message;
  }
  const deadline = Date.now() + timeoutMs;
  let activeState = "unknown";
  while (Date.now() < deadline) {
    try {
      const shown = await execFileAsync("systemctl", ["--user", "show", unit, "--property=ActiveState", "--value"], { encoding: "utf8" });
      activeState = shown.stdout.trim();
      if (!activeState || ["inactive", "failed"].includes(activeState)) break;
    } catch { activeState = "not-found"; break; }
    await wait(25);
  }
  return { unit, owned: true, activeState, stopped: ["inactive", "failed", "not-found", ""].includes(activeState), ...(stopError ? { error: stopError } : {}) };
}
