// CHROME'S PROCESS TREE AS THE OPERATING SYSTEM SEES IT — VmRSS per process TYPE, not per browser.
//
// WHY A SHARED MODULE, AND WHY NOW. Round 6's phone matrix concluded that the canvas arm "dies on device,
// mechanism unestablished". The mechanism was in the captured artifacts the whole time: the process Android's
// lowmemorykiller took was `com.android.chrome:privileged_process2` — the GPU PROCESS — at 1.33-1.63 GB under a
// PSI critical event. Killing the GPU process takes every renderer's GL context with it, which is why no kill
// line ever named the bench's own renderer and why the failure looked like a mystery. Every instrument pointed
// at the wrong process: the phone script's `dumpsys meminfo` read the BROWSER process, and this repo's only
// prior renderer-only /proc walk filtered on `--type=renderer` and could not see a GPU process at all.
// So the walk moves here and learns the other process types.
//
// THE ANCESTRY FILTER IS LOAD-BEARING on a shared box. A first version of the walk this is lifted from summed
// every chromium renderer alive, which on this machine meant ~935 MB of unrelated browsers and produced a delta
// with the WRONG SIGN. Only processes descended from the launched browser's pid are counted.
//
// THE HONESTY LIMIT, which must travel with every number this module produces:
//
//   VmRSS IS A LOWER BOUND ON WHAT A GPU PROCESS COSTS. Textures, swapchains and command buffers live in driver
//   and kernel allocations that are largely NOT resident in the process's own address space — on a discrete or
//   ANGLE/Vulkan path much of the memory a GPU process is responsible for never appears in its VmRSS at all.
//   A rising `gpu` number here is real evidence that GPU-process memory is growing. A flat one is NOT evidence
//   that it is not: it may only mean the growth landed somewhere VmRSS cannot see. Android's lowmemorykiller
//   quotes the same VmRSS-flavoured figure in its kill lines, so this is directly comparable to the .lmk
//   artifacts, and that comparability is the reason to report it — but it is SUPPORTING evidence and is never
//   the sole basis for a claim.
//
// This is Linux-only by construction (/proc). On any other platform every reader returns nulls and the caller
// reports "not measured" rather than zero.

import { readFileSync, readdirSync } from "node:fs";

/** `pid -> ppid` for every live process, so a child process can be attributed to the run that launched it. */
function parentMap() {
  const parents = new Map();
  let entries = [];
  try {
    entries = readdirSync("/proc");
  } catch {
    return parents;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      // `/proc/<pid>/stat` field 4 is the ppid; `comm` can contain spaces and parens, so read past the LAST ')'.
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      parents.set(Number(entry), Number(after[1]));
    } catch { /* the process exited between readdir and read — normal */ }
  }
  return parents;
}

// Chrome's own `--type=` values, mapped to the buckets a memory reading is actually read in. Anything else a
// build spawns (`--type=zygote`, sandbox helpers) lands in `other` rather than being silently dropped: an
// unclassified megabyte still has to appear in the total.
const TYPE_BUCKETS = {
  renderer: "renderers",
  // Chrome spells the GPU process `--type=gpu-process`; Android names the same process
  // `com.android.chrome:privileged_process*`, which is the currency the .lmk kill lines use.
  "gpu-process": "gpu",
  utility: "utility",
  broker: "other",
  zygote: "other"
};

/**
 * Every chromium process DESCENDED FROM `rootPid`, bucketed by `--type=` and summed in bytes.
 *
 * Returns `{ browser, gpu, renderers, utility, other, totalBytes, procs }` where each bucket is
 * `{ bytes, count, pids }`. The BROWSER process is the one with no `--type=` at all (it is `rootPid` itself
 * under a launched Playwright browser, and the walk does not assume that).
 *
 * Returns null on a platform without /proc, so a caller can say "not measured" instead of "0 MB".
 */
export function sampleChromeProcMem(rootPid) {
  let entries = [];
  try {
    entries = readdirSync("/proc");
  } catch {
    return null; // not Linux
  }
  const parents = parentMap();
  const descends = (pid) => {
    for (let p = pid, hops = 0; p > 1 && hops < 32; hops++) {
      if (p === rootPid) return true;
      p = parents.get(p) ?? 0;
    }
    return false;
  };
  const buckets = {
    browser: { bytes: 0, count: 0, pids: [] },
    gpu: { bytes: 0, count: 0, pids: [] },
    renderers: { bytes: 0, count: 0, pids: [] },
    utility: { bytes: 0, count: 0, pids: [] },
    other: { bytes: 0, count: 0, pids: [] }
  };
  let seen = 0;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid !== rootPid && !descends(pid)) continue;
    let cmdline = "";
    try {
      // NUL-separated argv. Joined with spaces so a `--type=` match cannot straddle two arguments.
      cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").join(" ");
    } catch { continue; }
    if (!cmdline.trim()) continue; // kernel thread
    // CHROME ONLY. `rootPid` is usually the harness's own node process (Playwright launches the browser as its
    // child), so without this the node process itself — and any other tool the run spawned — would land in the
    // `browser` bucket and inflate a number that is supposed to describe Chrome. A child process always carries
    // `--type=`; the browser process is recognised by its binary name.
    const argv0 = cmdline.split(" ")[0];
    const looksLikeChrome =
      /--type=/.test(cmdline) || /(^|\/)(chrome|chromium|headless_shell|chrome_crashpad_handler)$/i.test(argv0);
    if (!looksLikeChrome) continue;
    let status = "";
    try {
      status = readFileSync(`/proc/${entry}/status`, "utf8");
    } catch { continue; }
    const m = /VmRSS:\s+(\d+) kB/.exec(status);
    if (!m) continue;
    const bytes = Number(m[1]) * 1024;
    const type = /--type=([a-z-]+)/.exec(cmdline)?.[1] ?? null;
    const key = type === null ? "browser" : (TYPE_BUCKETS[type] ?? "other");
    buckets[key].bytes += bytes;
    buckets[key].count++;
    buckets[key].pids.push(pid);
    seen++;
  }
  if (seen === 0) return null; // the tree is gone (or was never ours) — unknown, not zero
  const totalBytes = Object.values(buckets).reduce((sum, b) => sum + b.bytes, 0);
  return { ...buckets, totalBytes, procs: seen };
}

/** Bytes -> MB, rounded to 1dp, null-preserving. */
export const procMemMb = (bytes) => (typeof bytes === "number" ? Math.round((bytes / (1024 * 1024)) * 10) / 10 : null);

/**
 * A one-line summary in the currency the Android kill lines use, ready to print beside a bench cell.
 * `null` in, "not measured" out — never a fabricated zero.
 */
export function formatProcMem(sample) {
  if (!sample) return "not measured (no /proc, or the process tree was gone)";
  const part = (label, b) => `${label} ${procMemMb(b.bytes)}MB${b.count > 1 ? ` x${b.count}` : ""}`;
  return (
    `${part("browser", sample.browser)}, ${part("gpu", sample.gpu)}, ` +
    `${part("renderers", sample.renderers)}, ${part("utility", sample.utility)}` +
    (sample.other.count ? `, ${part("other", sample.other)}` : "") +
    `  = ${procMemMb(sample.totalBytes)}MB total over ${sample.procs} process(es)`
  );
}

/**
 * Peak-and-last sampler over a live process tree.
 *
 * WHY THERE ARE THREE READINGS AND NOT ONE, learned by getting it wrong first. A caller that closes its page
 * before stopping the sampler — which the bench does, once per repeat — has a `last` sample taken AFTER the
 * renderer exited. The first version of this reported exactly that and made a 620 MB renderer look like 66 MB:
 * a settled reading that describes a process which no longer exists. So:
 *
 *   last      the final sample, whatever state the tree was in (kept for completeness)
 *   lastLive  the last sample in which a RENDERER still existed — the settled reading of a live page
 *   peak      per-bucket maxima across the whole run, each taken independently
 *
 * The per-bucket peak matters on its own terms: where a low-memory killer is the failure mode, what decides
 * whether a cell survives is the worst moment, not the settled one, and the GPU process and the renderers reach
 * their worst moments at different times (texture upload vs. atlas decode).
 *
 * Returns a handle with `stop()`, which clears the timer and yields `{ last, lastLive, peak, samples }`.
 */
export function startProcMemSampler(rootPid, intervalMs = 500) {
  let last = null;
  let lastLive = null;
  let samples = 0;
  const peak = { browser: 0, gpu: 0, renderers: 0, utility: 0, other: 0, total: 0 };
  const take = () => {
    const s = sampleChromeProcMem(rootPid);
    if (!s) return;
    samples++;
    last = s;
    if (s.renderers.count > 0) lastLive = s;
    for (const key of ["browser", "gpu", "renderers", "utility", "other"]) {
      if (s[key].bytes > peak[key]) peak[key] = s[key].bytes;
    }
    if (s.totalBytes > peak.total) peak.total = s.totalBytes;
  };
  take();
  const timer = setInterval(take, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return {
    stop() {
      clearInterval(timer);
      take();
      return { last, lastLive, peak, samples };
    }
  };
}
