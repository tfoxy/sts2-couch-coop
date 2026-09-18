import { open, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const values = Object.fromEntries(process.argv.slice(2).reduce((result, value, index, all) => {
  if (value.startsWith("--")) result.push([value.slice(2), all[index + 1]]);
  return result;
}, []));
if (!values.sinceEpochMs || !values.untilEpochMs || !values.output || !values.udid) throw new Error("requires --sinceEpochMs N --untilEpochMs N --udid UDID --output PATH");
const since = Number(values.sinceEpochMs);
const until = Number(values.untilEpochMs);
if (!Number.isFinite(since) || !Number.isFinite(until) || until < since || !/^[A-Fa-f0-9-]{8,64}$/.test(values.udid)) throw new Error("invalid crash scan bounds");
const roots = [
  { path: join(process.env.HOME ?? "", "Library", "Logs", "DiagnosticReports"), simulator: false },
  { path: join(process.env.HOME ?? "", "Library", "Developer", "CoreSimulator", "Devices", values.udid, "data", "Library", "Logs", "CrashReporter"), simulator: true },
];
const safariName = /^(?:MobileSafari|Safari|com\.apple\.WebKit|WebKit)[^/]*\.(?:ips|crash)$/;
const jetsamName = /^JetsamEvent[^/]*\.(?:ips|crash)$/;
const maximumDirectoryEntries = 256;
const candidates = [];
for (const root of roots) {
  try {
    for (const name of (await readdir(root.path)).sort().slice(-maximumDirectoryEntries)) {
      if (!safariName.test(name) && !(root.simulator && jetsamName.test(name))) continue;
      const info = await stat(join(root.path, name));
      if (info.mtimeMs > since && info.mtimeMs < until) candidates.push({ root, name, mtimeMs: info.mtimeMs });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
const records = [];
for (const candidate of candidates.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 20)) {
  const handle = await open(join(candidate.root.path, candidate.name), "r");
  const bytes = Buffer.alloc(8192);
  const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
  await handle.close();
  let header = {};
  let parsedHeader = false;
  try { header = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0]); parsedHeader = true; } catch { /* Legacy report bodies are never read. */ }
  const declaredProcess = String(header.procName ?? header.process ?? "");
  if (!jetsamName.test(candidate.name) && parsedHeader
    && !/^(?:MobileSafari|Safari|WebKit(?:\.[A-Za-z0-9_-]+)*|com\.apple\.WebKit(?:\.[A-Za-z0-9_-]+)*)$/.test(declaredProcess)) continue;
  const processCategory = jetsamName.test(candidate.name) ? "simulator-jetsam" : candidate.name.startsWith("MobileSafari") ? "mobile-safari" : candidate.name.startsWith("Safari") ? "safari" : "webkit";
  records.push({ relativeTimeMs: Math.max(0, Math.round(candidate.mtimeMs - since)), processCategory, bugType: /^\d{1,4}$/.test(String(header.bug_type ?? "")) ? String(header.bug_type) : "unknown" });
}
if (records.length > 0) {
  await writeFile(values.output, `${JSON.stringify(records.slice(0, 10))}\n`);
  process.exitCode = 10;
}
