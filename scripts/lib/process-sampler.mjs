// PER-PROCESS COST OF A LONG SESSION, READ FROM /proc — for scripts/run-session-soak.mjs.
//
// Every T seconds, for each process the session OWNS (the host game, each headless seat, the private compositor
// and its children, every Chromium process the harness launched, and the harness itself), this reads:
//
//   /proc/<pid>/stat                 utime+stime            -> CPU % of one core over the interval
//   /proc/<pid>/task/<pid>/stat      the MAIN thread's time -> main-thread CPU % (Godot's main loop runs there)
//   /proc/<pid>/status               VmRSS, Threads, Cpus_allowed_list
//
// plus, optionally, the CPU of every process the session does NOT own (the "foreign" channel, which is what a
// timed window is voided on), /proc/loadavg and /proc/meminfo.
//
// WHAT "OWNED" MEANS is decided by the caller, every tick, through `resolveTargets({table})`: it gets a fresh
// `pid -> stat` table and returns `[{role, pid, startTicks?}]`. That keeps discovery (seats appear minutes into a
// session; Chromium forks renderers when it likes) out of this file, which only measures.
//
// IDENTITY, NOT JUST PID. A delta is only computed between two reads of the same `(pid, starttime)`. A pid that
// was reused between ticks, or a role that now points at a different process, starts over with `cpuPct: null`
// rather than producing a number that mixes two processes.
//
// HONESTY LIMITS that travel with every number here:
//   * CPU is accounted in clock ticks (USER_HZ, 100/s on Linux). Over a 5 s interval one tick is 0.2 % of a core;
//     a single sample cannot resolve less than that.
//   * VmRSS counts shared pages in every process that maps them; summed across processes it over-counts.
//   * A process that lives and dies between two ticks is never seen.
//
// `procRoot` and `fs` are injectable so the self-test (scripts/test-run-session-soak.mjs) runs on a fake tree.

import { execFileSync } from "node:child_process";
import * as nodeFs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

/** Schema id carried by every record of the session stream (stream.ndjson). */
export const SOAK_STREAM_SCHEMA = "couchcoop-session-soak/1";

/** Record kinds the stream may carry. A reader that meets anything else is reading a newer schema. */
export const STREAM_KINDS = Object.freeze([
  "meta", "phase", "proc", "proc-missing", "proc-exit", "foreign", "system",
  "route", "mark", "viewer", "check", "error"
]);

const monotonicMs = () => performance.now();

/**
 * Parses `/proc/<pid>/stat`. `comm` may contain spaces and parentheses, so everything after the LAST `)` is split.
 * Field numbers below are proc(5)'s, 1-based; `rest[0]` is field 3 (state).
 */
export function parseStat(text) {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 1 || close <= open) throw new Error("malformed /proc stat: no comm");
  const pid = Number(text.slice(0, open).trim());
  const rest = text.slice(close + 1).trim().split(/\s+/);
  if (rest.length < 22) throw new Error("malformed /proc stat: truncated");
  const utime = Number(rest[11]); // field 14
  const stime = Number(rest[12]); // field 15
  const parsed = {
    pid,
    comm: text.slice(open + 1, close),
    state: rest[0],
    ppid: Number(rest[1]), // field 4
    utime,
    stime,
    cpuTicks: utime + stime,
    numThreads: Number(rest[17]), // field 20
    startTicks: Number(rest[19]), // field 22
    rssPages: Number(rest[21]) // field 24
  };
  if (![pid, parsed.ppid, utime, stime, parsed.startTicks].every(Number.isFinite)) {
    throw new Error("malformed /proc stat: non-numeric field");
  }
  return parsed;
}

/** The parts of `/proc/<pid>/status` this sampler reports. Absent fields stay absent (kernel threads have no VmRSS). */
export function parseStatus(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (key === "Name") out.name = value.trim();
    else if (key === "VmRSS") {
      const kb = /^(\d+)\s*kB$/i.exec(value.trim());
      if (kb) out.rssBytes = Number(kb[1]) * 1024;
    } else if (key === "Threads") out.threads = Number(value.trim());
    else if (key === "Cpus_allowed_list") out.cpusAllowed = value.trim();
  }
  return out;
}

/** `/proc/loadavg` -> `{one, five, fifteen, runnable, total}`. */
export function parseLoadavg(text) {
  const [one, five, fifteen, ratio] = text.trim().split(/\s+/);
  const [runnable, total] = String(ratio ?? "").split("/").map(Number);
  return { one: Number(one), five: Number(five), fifteen: Number(fifteen), runnable, total };
}

/** `/proc/meminfo` -> bytes for the fields a RAM-tight soak needs to watch. */
export function parseMeminfo(text) {
  const wanted = { MemTotal: "memTotalBytes", MemAvailable: "memAvailableBytes", SwapTotal: "swapTotalBytes", SwapFree: "swapFreeBytes" };
  const out = {};
  for (const line of text.split("\n")) {
    const match = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (match && wanted[match[1]]) out[wanted[match[1]]] = Number(match[2]) * 1024;
  }
  return out;
}

/** USER_HZ. Linux has reported 100 on every mainstream architecture for decades; `getconf` is asked anyway. */
export function clockTicksPerSecond() {
  try {
    const value = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    if (Number.isInteger(value) && value > 0) return value;
  } catch { /* fall through */ }
  return 100;
}

const readText = (fs, file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** `pid -> parsed stat` for every process readable under `procRoot`. A process that exits mid-walk is skipped. */
export function readProcessTable({ procRoot = "/proc", fs = nodeFs } = {}) {
  const table = new Map();
  let entries = [];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return table;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(String(entry))) continue;
    const text = readText(fs, path.join(procRoot, String(entry), "stat"));
    if (text === null) continue;
    try {
      const stat = parseStat(text);
      if (stat.pid === Number(entry)) table.set(stat.pid, stat);
    } catch { /* torn read of an exiting process */ }
  }
  return table;
}

/** Every pid in `table` descended from `rootPid` (the root itself excluded). */
export function descendantsOf(table, rootPid) {
  const children = new Map();
  for (const row of table.values()) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const out = new Set();
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (out.has(pid) || pid === rootPid) continue;
    out.add(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

/** `/proc/<pid>/cmdline` as argv, or null when unreadable. */
export function readCmdline(procRoot, pid, fs = nodeFs) {
  const text = readText(fs, path.join(procRoot, String(pid), "cmdline"));
  if (text === null) return null;
  const argv = text.split("\0");
  if (argv.at(-1) === "") argv.pop(); // the kernel NUL-terminates the last argument too
  return argv;
}

/** `/proc/<pid>/environ` as a Map, or null when unreadable (gone, or not ours to read). */
export function readEnviron(procRoot, pid, fs = nodeFs) {
  const text = readText(fs, path.join(procRoot, String(pid), "environ"));
  if (text === null) return null;
  const env = new Map();
  for (const entry of text.split("\0")) {
    const split = entry.indexOf("=");
    if (split > 0) env.set(entry.slice(0, split), entry.slice(split + 1));
  }
  return env;
}

/**
 * Chromium's own `--type=` switch, mapped to a role. The browser process is the one with NO `--type`; a process
 * that does not look like Chromium at all returns null so the caller can file it elsewhere (a `sts2` CLI call, a
 * shell) instead of calling it a browser.
 */
export function classifyChromium(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return null;
  // Chromium rewrites its process title: /proc/<pid>/cmdline then holds ONE space-joined string, not NUL-separated
  // arguments (measured on Playwright's headless shell), so the switches are read from the joined text.
  const text = argv.join(" ");
  const type = /(?:^|\s)--type=(\S+)/.exec(text)?.[1] ?? null;
  const exe = path.basename(text.split(/\s+/, 1)[0] ?? "");
  const looksLikeChromium = type !== null || /chrom|headless_shell/i.test(exe);
  if (!looksLikeChromium) return null;
  switch (type) {
    case null: return "chromium-browser";
    case "renderer": return "chromium-renderer";
    case "gpu-process": return "chromium-gpu";
    case "utility": return "chromium-utility";
    case "zygote": return "chromium-zygote";
    default: return "chromium-other";
  }
}

/**
 * The sampler. `sample()` returns this tick's records (unstamped: the stream adds `t`/`elapsedMs`/`schema`).
 *
 * `resolveTargets({table, procRoot})` -> `[{role, pid, startTicks?}]`. `startTicks` pins the identity when the
 * caller knows it (the host, the compositor); a discovered process may omit it and is pinned on first sight.
 */
export class ProcessSampler {
  #procRoot;
  #fs;
  #hz;
  #now;
  #resolveTargets;
  #foreign;
  #foreignTop;
  #foreignMinCpuPct;
  #system;
  #previous = new Map(); // `${pid}:${startTicks}` -> {cpuTicks, mainTicks, at, role, pid, startTicks}
  #previousForeign = new Map(); // `${pid}:${startTicks}` -> {cpuTicks, at}

  constructor({
    procRoot = "/proc", fs = nodeFs, ticksPerSecond = clockTicksPerSecond(), now = monotonicMs,
    resolveTargets, foreign = true, foreignTop = 5, foreignMinCpuPct = 0.5, system = true
  } = {}) {
    if (typeof resolveTargets !== "function") throw new TypeError("resolveTargets must be a function");
    if (!Number.isInteger(ticksPerSecond) || ticksPerSecond <= 0) throw new TypeError("ticksPerSecond must be a positive integer");
    this.#procRoot = procRoot;
    this.#fs = fs;
    this.#hz = ticksPerSecond;
    this.#now = now;
    this.#resolveTargets = resolveTargets;
    this.#foreign = foreign;
    this.#foreignTop = foreignTop;
    this.#foreignMinCpuPct = foreignMinCpuPct;
    this.#system = system;
  }

  get ticksPerSecond() { return this.#hz; }

  #pct(ticks, seconds) {
    return seconds > 0 ? +(((ticks / this.#hz) / seconds) * 100).toFixed(3) : null;
  }

  sample() {
    const at = this.#now();
    const table = readProcessTable({ procRoot: this.#procRoot, fs: this.#fs });
    const targets = this.#resolveTargets({ table, procRoot: this.#procRoot }) ?? [];
    const records = [];
    const next = new Map();
    const owned = new Set();

    for (const target of targets) {
      const row = table.get(target.pid);
      if (!row || row.state === "Z" || (Number.isFinite(target.startTicks) && row.startTicks !== target.startTicks)) {
        records.push({
          kind: "proc-missing", role: target.role, pid: target.pid, startTicks: target.startTicks ?? null,
          reason: !row ? "absent" : row.state === "Z" ? "zombie" : "pid reused by another process"
        });
        continue;
      }
      if (owned.has(row.pid)) continue; // two roles resolved to one process; the first role wins
      owned.add(row.pid);
      const key = `${row.pid}:${row.startTicks}`;
      const status = parseStatus(readText(this.#fs, path.join(this.#procRoot, String(row.pid), "status")) ?? "");
      const mainText = readText(this.#fs, path.join(this.#procRoot, String(row.pid), "task", String(row.pid), "stat"));
      let mainTicks = null;
      if (mainText !== null) {
        try { mainTicks = parseStat(mainText).cpuTicks; } catch { /* torn */ }
      }
      const prior = this.#previous.get(key);
      const seconds = prior ? (at - prior.at) / 1000 : null;
      const record = {
        kind: "proc",
        role: target.role,
        pid: row.pid,
        startTicks: row.startTicks,
        comm: row.comm,
        state: row.state,
        cpuPct: prior ? this.#pct(row.cpuTicks - prior.cpuTicks, seconds) : null,
        mainCpuPct: prior && mainTicks !== null && prior.mainTicks !== null ? this.#pct(mainTicks - prior.mainTicks, seconds) : null,
        cpuSeconds: +(row.cpuTicks / this.#hz).toFixed(2),
        mainCpuSeconds: mainTicks === null ? null : +(mainTicks / this.#hz).toFixed(2),
        rssBytes: status.rssBytes ?? null,
        threads: status.threads ?? row.numThreads,
        intervalSeconds: seconds === null ? null : +seconds.toFixed(3)
      };
      if (!prior) {
        record.first = true;
        record.cpusAllowed = status.cpusAllowed ?? null;
      }
      records.push(record);
      next.set(key, { cpuTicks: row.cpuTicks, mainTicks, at, role: target.role, pid: row.pid, startTicks: row.startTicks });
    }

    for (const [key, prior] of this.#previous) {
      if (next.has(key)) continue;
      const row = table.get(prior.pid);
      const gone = !row || row.startTicks !== prior.startTicks || row.state === "Z";
      // A process still alive but no longer resolved is the caller's choice, not an exit.
      if (gone) records.push({ kind: "proc-exit", role: prior.role, pid: prior.pid, startTicks: prior.startTicks });
    }
    this.#previous = next;

    if (this.#foreign) records.push(this.#foreignRecord(table, owned, at));
    if (this.#system) records.push(this.#systemRecord());
    return records;
  }

  #foreignRecord(table, owned, at) {
    const next = new Map();
    let totalTicks = 0;
    let seconds = null;
    const busy = [];
    for (const row of table.values()) {
      if (owned.has(row.pid)) continue;
      const key = `${row.pid}:${row.startTicks}`;
      next.set(key, { cpuTicks: row.cpuTicks, at });
      const prior = this.#previousForeign.get(key);
      if (!prior) continue; // first sight: no interval to attribute yet
      seconds = (at - prior.at) / 1000;
      const ticks = Math.max(0, row.cpuTicks - prior.cpuTicks);
      totalTicks += ticks;
      const pct = this.#pct(ticks, seconds);
      if (pct !== null && pct >= this.#foreignMinCpuPct) busy.push({ pid: row.pid, comm: row.comm, cpuPct: pct });
    }
    this.#previousForeign = next;
    busy.sort((a, b) => b.cpuPct - a.cpuPct);
    return {
      kind: "foreign",
      processCount: next.size,
      totalCpuPct: seconds === null ? null : this.#pct(totalTicks, seconds),
      top: busy.slice(0, this.#foreignTop)
    };
  }

  #systemRecord() {
    const load = readText(this.#fs, path.join(this.#procRoot, "loadavg"));
    const mem = readText(this.#fs, path.join(this.#procRoot, "meminfo"));
    return {
      kind: "system",
      loadavg: load === null ? null : parseLoadavg(load),
      memory: mem === null ? null : parseMeminfo(mem)
    };
  }
}

/**
 * Contamination verdict input for a window: how many foreign ticks exceeded `thresholdPct` of a core. The VERDICT
 * (void or not) belongs to whoever predeclared the tolerance; this only counts.
 */
export function summarizeForeignLoad(records, { thresholdPct = 5 } = {}) {
  const values = records.filter(record => record?.kind === "foreign" && typeof record.totalCpuPct === "number").map(record => record.totalCpuPct);
  const over = values.filter(value => value > thresholdPct).length;
  return {
    thresholdPct,
    ticks: values.length,
    ticksOver: over,
    fractionOver: values.length === 0 ? null : +(over / values.length).toFixed(4),
    maxCpuPct: values.length === 0 ? null : Math.max(...values),
    meanCpuPct: values.length === 0 ? null : +(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)
  };
}

/**
 * The session stream: one JSON object per line, each stamped with the schema, a wall-clock ISO time and the
 * milliseconds since the stream opened (monotonic, so it survives a wall-clock step).
 */
export class NdjsonStream {
  #fd;
  #fs;
  #now;
  #openedAt;
  #wall;
  records = 0;

  constructor(file, { fs = nodeFs, now = monotonicMs, wall = () => new Date() } = {}) {
    this.#fs = fs;
    this.#fd = fs.openSync(file, "a");
    this.#now = now;
    this.#wall = wall;
    this.#openedAt = now();
    this.path = file;
  }

  write(record) {
    if (!STREAM_KINDS.includes(record?.kind)) throw new Error(`unknown stream record kind ${JSON.stringify(record?.kind)}`);
    const line = { schema: SOAK_STREAM_SCHEMA, t: this.#wall().toISOString(), elapsedMs: Math.round(this.#now() - this.#openedAt), ...record };
    this.#fs.writeSync(this.#fd, `${JSON.stringify(line)}\n`);
    this.records += 1;
    return line;
  }

  close() {
    if (this.#fd !== null) {
      this.#fs.closeSync(this.#fd);
      this.#fd = null;
    }
  }
}

/** Validates one parsed stream line; returns a list of problems (empty = valid). Used by the self-test. */
export function streamRecordProblems(line) {
  const problems = [];
  if (line?.schema !== SOAK_STREAM_SCHEMA) problems.push(`schema is ${JSON.stringify(line?.schema)}`);
  if (!STREAM_KINDS.includes(line?.kind)) problems.push(`unknown kind ${JSON.stringify(line?.kind)}`);
  if (typeof line?.t !== "string" || Number.isNaN(Date.parse(line.t))) problems.push("t is not an ISO time");
  if (!Number.isInteger(line?.elapsedMs) || line.elapsedMs < 0) problems.push("elapsedMs is not a non-negative integer");
  if (line?.kind === "proc") {
    for (const field of ["role", "pid", "startTicks"]) if (line[field] === undefined) problems.push(`proc record lacks ${field}`);
    if (line.cpuPct !== null && typeof line.cpuPct !== "number") problems.push("cpuPct is neither null nor a number");
  }
  return problems;
}
