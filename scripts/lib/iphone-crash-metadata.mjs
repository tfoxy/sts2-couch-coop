import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const values = Object.fromEntries(process.argv.slice(2).reduce((result, value, index, all) => {
  if (value.startsWith("--")) result.push([value.slice(2), all[index + 1]]);
  return result;
}, []));
if (!values.sinceEpochMs || !values.output) throw new Error("requires --sinceEpochMs N --output PATH");
const since = Number(values.sinceEpochMs);
const crashDirectory = join(process.env.HOME ?? "", "Library", "Logs", "DiagnosticReports");
const allowedName = /^(?:MobileSafari|Safari|com\.apple\.WebKit|WebKit)[^/]*\.(?:ips|crash)$/;
const records = [];
try {
  for (const entry of (await readdir(crashDirectory)).filter((name) => allowedName.test(name)).slice(-20)) {
    const path = join(crashDirectory, entry);
    const info = await stat(path);
    if (info.mtimeMs < since) continue;
    const firstLine = (await readFile(path, "utf8")).split(/\r?\n/, 1)[0];
    let header = {};
    try { header = JSON.parse(firstLine); } catch { /* Legacy reports have no safely bounded structured header. */ }
    const process = basename(entry).replace(/[-_ ].*$/, "").replace(/^com\.apple\./, "");
    records.push({
      process: /^(MobileSafari|Safari|WebKit)$/.test(process) ? process : "WebKit",
      bugType: /^\d{1,4}$/.test(String(header.bug_type ?? "")) ? String(header.bug_type) : "unknown",
      osVersion: /^\d+(?:\.\d+){1,2}(?: \([^)]{1,32}\))?$/.test(String(header.os_version ?? ""))
        ? String(header.os_version)
        : "unknown",
      ageMs: Math.max(0, Math.round(Date.now() - info.mtimeMs)),
    });
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (records.length > 0) {
  await writeFile(values.output, `${JSON.stringify(records.slice(0, 10))}\n`);
  process.exitCode = 10;
}
