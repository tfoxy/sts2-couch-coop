import { chmodSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

export const LINUX_PROCESS_MEMORY_SCHEMA = "couchcoop-linux-process-memory/1";

const KB = 1024;
const BYTE_FIELDS = new Map([
  ["VmRSS", "rssBytes"], ["RssAnon", "anonymousBytes"], ["RssFile", "fileBytes"],
  ["RssShmem", "shmemBytes"], ["VmSwap", "swapBytes"], ["Rss", "rssBytes"],
  ["Pss", "pssBytes"], ["Pss_Anon", "pssAnonymousBytes"], ["Pss_File", "pssFileBytes"],
  ["Pss_Shmem", "pssShmemBytes"], ["Shared_Clean", "sharedCleanBytes"],
  ["Shared_Dirty", "sharedDirtyBytes"], ["Private_Clean", "privateCleanBytes"],
  ["Private_Dirty", "privateDirtyBytes"], ["Anonymous", "anonymousBytes"],
  ["Swap", "swapBytes"], ["SwapPss", "swapPssBytes"], ["AnonHugePages", "anonHugePagesBytes"],
  ["ShmemPmdMapped", "shmemPmdMappedBytes"], ["FilePmdMapped", "filePmdMappedBytes"],
  ["Shared_Hugetlb", "sharedHugePagesBytes"], ["Private_Hugetlb", "privateHugePagesBytes"],
  ["Locked", "lockedBytes"], ["Size", "sizeBytes"]
]);

export const MEMORY_BYTE_FIELDS = [...new Set(BYTE_FIELDS.values())];
export const MAPPING_CLASSES = ["anonymous/heap", "file-backed", "memfd/deleted", "shm", "graphics/device", "executable/JIT", "stack", "other"];
export const MAPPING_CLASS_PRECEDENCE = ["stack", "graphics/device", "memfd/deleted", "shm", "executable/JIT", "anonymous/heap", "file-backed", "other"];

export class LinuxProcessMemoryError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "LinuxProcessMemoryError";
  }
}

const asBytes = value => {
  const match = /^(\d+)\s+kB$/i.exec(value.trim());
  return match ? Number(match[1]) * KB : undefined;
};

const parseMemoryLines = text => {
  const result = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z_]+):\s*(.+)$/.exec(line);
    if (!match) continue;
    const field = BYTE_FIELDS.get(match[1]);
    const bytes = field && asBytes(match[2]);
    if (field && bytes !== undefined) result[field] = bytes;
  }
  return result;
};

/** Parses the identity-bearing parts of procfs stat without being confused by comm parentheses. */
export function parseProcStat(text) {
  const close = text.lastIndexOf(")");
  const open = text.indexOf("(");
  if (open < 1 || close <= open) throw new LinuxProcessMemoryError("malformed /proc stat comm");
  const pid = Number(text.slice(0, open).trim());
  const fields = text.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]); // field 4, following state (field 3)
  const startTimeTicks = Number(fields[19]); // field 22
  if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isFinite(startTimeTicks)) {
    throw new LinuxProcessMemoryError("malformed /proc stat identity");
  }
  return { pid, ppid, startTimeTicks, comm: text.slice(open + 1, close) };
}

/** Parses status memory evidence. Unknown and unavailable fields intentionally remain absent. */
export function parseProcStatus(text) {
  const result = parseMemoryLines(text);
  const name = /^Name:\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (name) result.name = name;
  return result;
}

/** Parses a smaps_rollup record. Rss and Pss are validated by the sampler, not fabricated here. */
export const parseSmapsRollup = text => parseMemoryLines(text);

const mappingHeader = /^([0-9a-fA-F]+)-([0-9a-fA-F]+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)(?:\s+(.*))?$/;

/** Parse detailed smaps into bounded numeric mapping rows; pathname is retained only in the raw artifact. */
export function parseSmaps(text) {
  const mappings = [];
  let current = null;
  for (const line of text.split("\n")) {
    const header = mappingHeader.exec(line);
    if (header) {
      if (current) mappings.push(current);
      const start = Number.parseInt(header[1], 16);
      const end = Number.parseInt(header[2], 16);
      current = { start, end, sizeBytes: end - start, permissions: header[3], pathname: header[7] ?? "" };
      continue;
    }
    if (current) Object.assign(current, parseMemoryLines(line));
  }
  if (current) mappings.push(current);
  return mappings;
}

export function classifyMapping(mapping) {
  const path = mapping.pathname ?? "";
  const perms = mapping.permissions ?? "";
  if (/^\[stack(?::\d+)?\]$/.test(path)) return "stack";
  if (/^\/dev\/(?:dri|kgsl|mali|nvidia|renderD)|\b(?:drm|nvidia|kgsl|mali)\b/i.test(path)) return "graphics/device";
  if (/^(?:\/memfd:|memfd:)|\(deleted\)$/.test(path)) return "memfd/deleted";
  if (/^\/dev\/shm\/|^\/SYSV/i.test(path)) return "shm";
  if (/\[anon:(?:jit|JIT)|\b(?:jit|JIT)\b/.test(path) || perms.includes("x")) return "executable/JIT";
  if (!path || path === "[heap]" || /^\[anon(?::|\])/.test(path)) return "anonymous/heap";
  if (path.startsWith("/")) return "file-backed";
  return "other";
}

const emptyTotals = () => ({ mappingCount: 0 });
const addMetric = (target, source) => {
  for (const field of MEMORY_BYTE_FIELDS) if (typeof source[field] === "number") target[field] = (target[field] ?? 0) + source[field];
};

/** Every row is classified once, so each metric's aggregate exactly conserves its parsed row values. */
export function aggregateMappings(mappings) {
  const classes = Object.fromEntries(MAPPING_CLASSES.map(name => [name, emptyTotals()]));
  const totals = emptyTotals();
  for (const mapping of mappings) {
    const className = classifyMapping(mapping);
    classes[className].mappingCount++;
    totals.mappingCount++;
    addMetric(classes[className], mapping);
    addMetric(totals, mapping);
  }
  return { totals, classes };
}

/** Throws if a caller changes classification/aggregation such that parsed mapping bytes no longer conserve. */
export function assertMappingByteConservation(aggregate) {
  const sums = emptyTotals();
  for (const part of Object.values(aggregate.classes)) {
    sums.mappingCount += part.mappingCount;
    addMetric(sums, part);
  }
  if (sums.mappingCount !== aggregate.totals.mappingCount) {
    throw new LinuxProcessMemoryError("mapping count does not conserve across classes");
  }
  for (const field of MEMORY_BYTE_FIELDS) if ((sums[field] ?? 0) !== (aggregate.totals[field] ?? 0)) {
    throw new LinuxProcessMemoryError(`mapping ${field} does not conserve across classes`);
  }
  return aggregate;
}

const roleFrom = ({ pid, rootPid, exeBasename, cmdline }) => {
  if (pid === rootPid) return "root-launcher";
  const haystack = `${exeBasename}\n${cmdline}`;
  if (/WPENetworkProcess/i.test(haystack)) return "network";
  if (/WPEWebProcess/i.test(haystack)) return "web-content";
  if (/\b(?:WPE|WebKit).*GPU|\bGPUProcess\b/i.test(haystack)) return "gpu";
  if (/MiniBrowser/i.test(haystack)) return "browser";
  return `other:${exeBasename || "unknown"}`;
};

export const classifyLinuxProcessRole = roleFrom;

const sameIdentity = (left, right) => left.pid === right.pid && left.ppid === right.ppid &&
  left.startTimeTicks === right.startTimeTicks && left.exeBasename === right.exeBasename && left.role === right.role;

const keySetEquals = (left, right) => left.length === right.length && left.every((item, index) => sameIdentity(item, right[index]));

export function processIdentityRoster(summary) {
  return (summary?.processes ?? []).map(process => ({
    pid: process.pid, ppid: process.ppid, startTimeTicks: process.startTimeTicks,
    exeBasename: process.exeBasename, role: process.role
  })).sort((left, right) => left.pid - right.pid);
}

export const sameProcessIdentityRoster = (left, right) => keySetEquals(left ?? [], right ?? []);

/**
 * A synchronous, race-detecting sampler. `procRoot` may point at a fixture tree, which makes tests independent
 * of process timing. The injected fs only needs the node fs synchronous methods used below.
 */
export class LinuxProcessMemorySampler {
  #rootPid;
  #procRoot;
  #fs;
  #pinned = null;
  #pinIdentities;

  constructor({ rootPid, mode = "rollup", outDir = null, procRoot = "/proc", fs = null, pinIdentities = true } = {}) {
    if (!Number.isInteger(rootPid) || rootPid <= 0) throw new TypeError("rootPid must be a positive integer");
    this.#rootPid = rootPid;
    this.mode = mode;
    this.outDir = outDir;
    this.#procRoot = procRoot;
    this.#fs = fs ?? { readFileSync, readdirSync, readlinkSync, mkdirSync, writeFileSync, chmodSync };
    this.#pinIdentities = pinIdentities;
  }

  get pinnedIdentities() { return this.#pinned?.map(identity => ({ ...identity })) ?? null; }

  #path(...parts) { return join(this.#procRoot, ...parts.map(String)); }

  #read(path, encoding = "utf8") {
    try { return this.#fs.readFileSync(path, encoding); }
    catch (error) { throw new LinuxProcessMemoryError(`required proc evidence is unreadable: ${path}`, error); }
  }

  #discover() {
    let entries;
    try { entries = this.#fs.readdirSync(this.#procRoot); }
    catch (error) { throw new LinuxProcessMemoryError(`cannot enumerate ${this.#procRoot}`, error); }
    const identities = new Map();
    for (const entry of entries) {
      if (!/^\d+$/.test(String(entry))) continue;
      const pid = Number(entry);
      let stat;
      try { stat = parseProcStat(this.#fs.readFileSync(this.#path(pid, "stat"), "utf8")); }
      catch (error) {
        // A process unrelated to this sample may exit while /proc is enumerated. It was never evidence.
        if (pid === this.#rootPid) throw new LinuxProcessMemoryError(`root identity is unreadable: ${pid}`, error);
        continue;
      }
      if (stat.pid !== pid) throw new LinuxProcessMemoryError(`stat pid mismatch for ${pid}`);
      identities.set(pid, stat);
    }
    if (!identities.has(this.#rootPid)) throw new LinuxProcessMemoryError(`root pid ${this.#rootPid} is absent`);
    const selected = new Map([[this.#rootPid, identities.get(this.#rootPid)]]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, identity] of identities) if (!selected.has(pid) && selected.has(identity.ppid)) {
        selected.set(pid, identity); changed = true;
      }
    }
    return selected;
  }

  #identityRows(tree, details = new Map()) {
    return [...tree.values()].map(identity => {
      const detail = details.get(identity.pid);
      return { ...identity, exeBasename: detail?.exeBasename ?? "", role: detail?.role ?? "" };
    }).sort((a, b) => a.pid - b.pid);
  }

  #writeRaw(rawDir, summaryRoot, pid, files) {
    const dir = join(rawDir, "raw", String(pid));
    this.#fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.#fs.chmodSync(dir, 0o700);
    const paths = {};
    for (const [name, content] of Object.entries(files)) {
      const path = join(dir, name);
      this.#fs.writeFileSync(path, content, { mode: 0o600 });
      this.#fs.chmodSync(path, 0o600);
      paths[name] = relative(summaryRoot, path);
    }
    return paths;
  }

  capture({ label = "sample", index = null, mode = this.mode, outDir = this.outDir } = {}) {
    if (mode !== "rollup" && mode !== "smaps") throw new TypeError("mode must be rollup or smaps");
    if (!outDir) throw new TypeError("outDir is required for raw local evidence");
    const rawDir = join(outDir, `linux-process-memory-${index === null ? label : `${label}-${index}`}`);
    this.#fs.mkdirSync(rawDir, { recursive: true, mode: 0o700 });
    this.#fs.chmodSync(rawDir, 0o700);
    const firstTree = this.#discover();
    const details = new Map();
    for (const [pid, stat] of firstTree) {
      let exe;
      try { exe = this.#fs.readlinkSync(this.#path(pid, "exe")); }
      catch (error) { throw new LinuxProcessMemoryError(`required proc evidence is unreadable: ${this.#path(pid, "exe")}`, error); }
      const cmdline = this.#read(this.#path(pid, "cmdline"), null);
      const statusText = this.#read(this.#path(pid, "status"));
      const rollupText = this.#read(this.#path(pid, "smaps_rollup"));
      const status = parseProcStatus(statusText);
      const rollup = parseSmapsRollup(rollupText);
      if (typeof rollup.rssBytes !== "number" || typeof rollup.pssBytes !== "number") {
        throw new LinuxProcessMemoryError(`required Rss/Pss evidence is missing for pid ${pid}`);
      }
      const smapsText = mode === "smaps" ? this.#read(this.#path(pid, "smaps")) : null;
      const mappings = smapsText === null ? null : parseSmaps(smapsText);
      const exeBasename = basename(exe.replace(/ \(deleted\)$/, ""));
      const command = Buffer.isBuffer(cmdline) ? cmdline.toString("utf8").replaceAll("\0", " ") : String(cmdline).replaceAll("\0", " ");
      const role = roleFrom({ pid, rootPid: this.#rootPid, exeBasename, cmdline: command });
      const raw = this.#writeRaw(rawDir, outDir, pid, {
        stat: this.#read(this.#path(pid, "stat")), exe, cmdline, status: statusText, smaps_rollup: rollupText,
        ...(smapsText === null ? {} : { smaps: smapsText })
      });
      details.set(pid, { stat, exeBasename, role, status, rollup, mappings, raw });
    }
    const firstIdentities = this.#identityRows(firstTree, details);
    const secondTree = this.#discover();
    const secondDetails = new Map();
    for (const [pid] of secondTree) {
      const original = details.get(pid);
      if (!original) continue;
      let secondExe;
      try { secondExe = this.#fs.readlinkSync(this.#path(pid, "exe")); }
      catch (error) { throw new LinuxProcessMemoryError(`required proc evidence is unreadable: ${this.#path(pid, "exe")}`, error); }
      const exeBasename = basename(secondExe.replace(/ \(deleted\)$/, ""));
      const secondCmdline = this.#read(this.#path(pid, "cmdline"), null);
      const command = Buffer.isBuffer(secondCmdline) ? secondCmdline.toString("utf8").replaceAll("\0", " ") : String(secondCmdline).replaceAll("\0", " ");
      secondDetails.set(pid, { exeBasename, role: roleFrom({ pid, rootPid: this.#rootPid, exeBasename, cmdline: command }) });
    }
    const secondIdentities = this.#identityRows(secondTree, secondDetails);
    if (!keySetEquals(firstIdentities, secondIdentities)) throw new LinuxProcessMemoryError("process tree changed during sample");
    if (this.#pinIdentities && this.#pinned && !keySetEquals(this.#pinned, firstIdentities)) throw new LinuxProcessMemoryError("process tree differs from pinned successful sample");
    if (this.#pinIdentities) this.#pinned ??= firstIdentities;

    const processes = firstIdentities.map(identity => {
      const detail = details.get(identity.pid);
      return {
        ...identity, metrics: Object.fromEntries(MEMORY_BYTE_FIELDS
          .filter(field => typeof detail.status[field] === "number" || typeof detail.rollup[field] === "number")
          .map(field => [field, detail.rollup[field] ?? detail.status[field]])),
        ...(detail.mappings ? { mappingClasses: aggregateMappings(detail.mappings).classes } : {}), raw: detail.raw
      };
    });
    const treeTotals = {};
    const roleTotals = {};
    const mappingRows = [];
    const capabilities = { detailedSmaps: mode === "smaps", statusFields: {}, rollupFields: {}, smapsFields: {} };
    for (const process of processes) {
      addMetric(treeTotals, process.metrics);
      treeTotals.processCount = (treeTotals.processCount ?? 0) + 1;
      const role = roleTotals[process.role] ??= {};
      role.processCount = (role.processCount ?? 0) + 1;
      addMetric(role, process.metrics);
      for (const field of MEMORY_BYTE_FIELDS) {
        if (field in detailOr(process, details).status) capabilities.statusFields[field] = true;
        if (field in detailOr(process, details).rollup) capabilities.rollupFields[field] = true;
      }
      if (mode === "smaps") mappingRows.push(...detailOr(process, details).mappings);
    }
    const mappingClasses = mode === "smaps" ? assertMappingByteConservation(aggregateMappings(mappingRows)) : null;
    if (mode === "smaps") for (const mapping of mappingRows) for (const field of MEMORY_BYTE_FIELDS) {
      if (typeof mapping[field] === "number") capabilities.smapsFields[field] = true;
    }
    return {
      schema: LINUX_PROCESS_MEMORY_SCHEMA, rootPid: this.#rootPid, mode,
      rawDir: relative(outDir, rawDir), processes, roles: roleTotals,
      totals: { ...treeTotals, rssIsSummedAcrossProcesses: true, uniqueMemoryMetric: "pssBytes" },
      capabilities, mappingClasses
    };
  }

  sample(options = {}) { return this.capture(options); }
}

const detailOr = (process, details) => details.get(process.pid);

/** Compatibility projection for callers that only need the legacy summed-RSS shape. */
export function legacyRssSummary(summary) {
  return {
    rootPid: summary.rootPid,
    processes: summary.processes.map(process => ({ pid: process.pid, rssBytes: process.metrics.rssBytes })),
    totalBytes: summary.totals.rssBytes
  };
}
