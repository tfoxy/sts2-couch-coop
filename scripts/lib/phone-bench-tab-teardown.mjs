import { isHttpPageOnPort } from "./phone-bench-tab-target.mjs";

export function chromeRenderGpuSignature(ledger) {
  const rows = String(ledger ?? "").split(/\r?\n/).map((line) => line.trim().split(/\s+/));
  return rows
    .filter((row) => row.length >= 3 && /^\d+$/.test(row[0]) && /com\.android\.chrome:(?:sandboxed|privileged)_process/.test(row.at(-1)))
    .map((row) => `${row[0]}:${row.at(-1)}`)
    .sort()
    .join(",");
}

export function chromeSandboxedRendererPids(ledger) {
  return String(ledger ?? "").split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((row) => row.length >= 3 && /^\d+$/.test(row[0]) && /com\.android\.chrome:sandboxed_process/.test(row.at(-1)))
    .map((row) => row[0]);
}

/**
 * Wait until only targets on the bench's explicit port are gone, then require
 * a pre-close renderer PID to exit and the remaining renderer/GPU process set
 * to stay quiet. The process set is observational only: never kill or alter it.
 */
export async function waitForBenchTargetTeardown({
  listTargets,
  sampleProcesses,
  benchPort,
  preCloseRendererPids,
  timeoutMs = 90_000,
  pollMs = 250,
  stabilizeMs = 3_000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!Array.isArray(preCloseRendererPids) || preCloseRendererPids.length === 0) {
    throw new Error("bench target teardown has no pre-close sandboxed renderer PID evidence");
  }
  const deadline = now() + timeoutMs;
  let quietSince = null;
  let signature = null;
  for (;;) {
    const remaining = deadline - now();
    if (remaining < 0) break;
    let owned = [];
    try {
      const targets = await listTargets();
      owned = Array.isArray(targets) ? targets.filter((t) => t?.type === "page" && isHttpPageOnPort(t.url, benchPort)) : [];
    } catch { owned = [{ type: "page" }]; }
    if (owned.length === 0) {
      let ledger = null;
      try { ledger = await sampleProcesses(); } catch { ledger = null; }
      const rendererGone = ledger !== null && preCloseRendererPids.some((pid) => !chromeSandboxedRendererPids(ledger).includes(pid));
      const next = ledger === null ? null : chromeRenderGpuSignature(ledger);
      if (rendererGone && next === signature) {
        if (quietSince !== null && now() - quietSince >= stabilizeMs) {
          return { elapsedMs: timeoutMs - remaining, signature: next };
        }
      } else {
        signature = next;
        quietSince = now();
      }
    } else {
      signature = null;
      quietSince = null;
    }
    await sleep(Math.max(1, Math.min(pollMs, deadline - now())));
  }
  throw new Error(`bench target/process teardown did not quiesce on port ${benchPort} within ${timeoutMs}ms`);
}
