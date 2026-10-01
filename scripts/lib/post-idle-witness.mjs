import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { requireReadyWitnessState, stableWitnessState } from "./pre-idle-witness.mjs";

export class PostIdleWitnessError extends Error {
  constructor(code, receiptPath) {
    super(`post-idle witness rejected: ${code}`);
    this.name = "PostIdleWitnessError";
    this.code = code;
    this.receiptPath = receiptPath;
  }
}

export function postIdleRejectedRepeats(runs, requested) {
  if (!requested) return [];
  return runs.flatMap((run, index) => {
    const marker = run.idle?.postIdleWitness;
    let verified = false;
    if (marker?.verified === true && typeof marker.receiptPath === "string" &&
        typeof marker.processLedger?.path === "string" &&
        /^[a-f0-9]{64}$/.test(marker.processLedger?.sha256 ?? "")) {
      try {
        const receipt = JSON.parse(readFileSync(marker.receiptPath, "utf8"));
        const ledgerSha256 = createHash("sha256").update(readFileSync(marker.processLedger.path)).digest("hex");
        const motionCaptures = inspectMotionCaptures(receipt.motionCaptures, receipt.ready);
        verified = receipt.schema === "mirror-post-idle-result/1" && receipt.failure === null &&
          receipt.ack?.captureOk === true && receipt.ack?.token === receipt.ready?.token &&
          receipt.processLedger?.path === marker.processLedger.path &&
          receipt.processLedger?.sha256 === marker.processLedger.sha256 &&
          ledgerSha256 === marker.processLedger.sha256 &&
          Array.isArray(receipt.motionCaptures) &&
          motionCaptures?.length === receipt.motionCaptures.length &&
          !!receipt.before && !!receipt.after;
      } catch { /* missing or corrupt receipt rejects the cell */ }
    }
    if (verified) return [];
    return [{ repeat: index + 1, code: run.witnessFailure?.code ?? "missingPostIdleWitness",
      reason: run.witnessFailure?.reason ?? run.crashReason ?? "verified post-idle witness or ledger is absent",
      receiptPath: run.witnessFailure?.receiptPath ?? marker?.receiptPath ?? null }];
  });
}

function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  renameSync(temp, path);
}

export function inspectProcessLedger(ledger, browser) {
  if (typeof ledger?.path !== "string" || !ledger.path ||
      !Number.isFinite(ledger.capturedEpochMs) || !existsSync(ledger.path)) return null;
  const bytes = readFileSync(ledger.path);
  const lines = bytes.toString("utf8").split(/\r?\n/).filter(Boolean);
  if (!/^\s*PID\s+RSS\s+NAME\s*$/i.test(lines[0] ?? "")) return null;
  const rows = lines.slice(1).map((line) => /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)).filter(Boolean);
  const names = rows.map((row) => row[3]);
  if (!rows.some((row) => Number(row[1]) === browser.pid && row[3] === browser.packageName) ||
      !names.some((name) => name.startsWith(`${browser.packageName}:sandboxed_process`)) ||
      !names.some((name) => name.startsWith(`${browser.packageName}:privileged_process`))) return null;
  return { ...ledger, sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length, processRows: rows.length };
}

export function inspectMotionCaptures(captures, ready) {
  if (!Array.isArray(captures) || captures.length < 2) return null;
  const rows = [];
  for (const capture of captures) {
    if (typeof capture?.physicalPath !== "string" || typeof capture?.pagePath !== "string" ||
        !Number.isFinite(capture.physicalEpochMs) || !Number.isFinite(capture.pageEpochMs) ||
        capture.physicalEpochMs < ready.createdEpochMs || capture.pageEpochMs < ready.createdEpochMs ||
        !existsSync(capture.physicalPath) || !existsSync(capture.pagePath)) return null;
    const physical = readFileSync(capture.physicalPath);
    const page = readFileSync(capture.pagePath);
    if (!physical.length || !page.length) return null;
    const physicalSha256 = createHash("sha256").update(physical).digest("hex");
    const pageSha256 = createHash("sha256").update(page).digest("hex");
    if (capture.physicalSha256 !== physicalSha256 || capture.pageSha256 !== pageSha256) return null;
    rows.push({ physicalPath: capture.physicalPath, physicalSha256, physicalEpochMs: capture.physicalEpochMs,
      pagePath: capture.pagePath, pageSha256, pageEpochMs: capture.pageEpochMs });
  }
  if (rows[1].physicalEpochMs <= rows[0].physicalEpochMs || rows[1].pageEpochMs <= rows[0].pageEpochMs) return null;
  return rows;
}

export async function runPostIdleWitness({ prefix, preVerified, idleMarkers, capture, targetId,
  timeoutMs = 30_000, signal, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!prefix || !preVerified?.request?.token || !preVerified?.after ||
      typeof capture !== "function" || typeof targetId !== "function" ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
      !(idleMarkers?.endAtMs > idleMarkers?.startAtMs)) {
    throw new TypeError("invalid post-idle witness options");
  }
  const readyPath = `${prefix}.post-idle-ready.json`;
  const ackPath = `${prefix}.post-idle-ack.json`;
  const verifiedPath = `${prefix}.post-idle-verified.json`;
  const rejectedPath = `${prefix}.post-idle-rejected.json`;
  const receipt = { schema: "mirror-post-idle-result/1", preRequest: preVerified.request,
    idleMarkers, ready: null, ack: null, before: null, after: null, processLedger: null,
    motionCaptures: null,
    failure: null, finishedEpochMs: null };
  const reject = (code, observed = null) => {
    receipt.failure = { code, observed, atEpochMs: now() };
    receipt.finishedEpochMs = now();
    writeAtomic(rejectedPath, receipt);
    throw new PostIdleWitnessError(code, rejectedPath);
  };
  const requireAlive = () => { if (signal?.aborted) reject("navigationOrClose"); };
  if ([readyPath, ackPath, verifiedPath, rejectedPath].some(existsSync)) reject("filesAlreadyExist");
  requireAlive();
  try { receipt.before = await capture(); }
  catch (error) { reject("captureFailure", { phase: "before", error: String(error) }); }
  requireAlive();
  try { requireReadyWitnessState(receipt.before, true); }
  catch (error) { reject("readinessFailure", { phase: "before", error: String(error), state: receipt.before }); }
  if (stableWitnessState(receipt.before) !== stableWitnessState(preVerified.after)) {
    reject("identityChanged", { phase: "before", expected: preVerified.after, observed: receipt.before });
  }
  let selectedTargetId;
  try { selectedTargetId = await targetId(); }
  catch (error) { reject("contextFailure", { phase: "before", error: String(error) }); }
  requireAlive();
  if (selectedTargetId !== preVerified.request.targetId) {
    reject("targetChanged", { phase: "before", expected: preVerified.request.targetId, observed: selectedTargetId });
  }
  const request = preVerified.request;
  receipt.ready = { schema: "mirror-post-idle-ready/1", token: randomUUID(), cellToken: request.token,
    documentNonce: receipt.before.documentNonce, targetId: selectedTargetId, browser: request.browser,
    url: receipt.before.url, timeOrigin: receipt.before.timeOrigin, renderer: receipt.before.renderer,
    quality: receipt.before.quality, visibility: receipt.before.visibility,
    viewport: receipt.before.viewport, contextEvents: receipt.before.contextEvents,
    savedSettings: receipt.before.savedSettings, freshDefaults: receipt.before.freshDefaults,
    idleMarkers, createdEpochMs: now() };
  writeAtomic(readyPath, receipt.ready);
  const deadline = now() + timeoutMs;
  while (!existsSync(ackPath)) {
    requireAlive();
    if (now() >= deadline) reject("timeout");
    await sleep(50);
  }
  requireAlive();
  try { receipt.ack = JSON.parse(readFileSync(ackPath, "utf8")); }
  catch (error) { reject("ackMalformed", { error: String(error) }); }
  const ack = receipt.ack;
  // Preserve an available process ledger even when a stale or failed ack must
  // reject the cell; the page is still alive at this point.
  try { receipt.processLedger = inspectProcessLedger(ack.processLedger, preVerified.request.browser); }
  catch (error) { receipt.ledgerInspectionError = String(error); }
  if (ack.schema !== "mirror-post-idle-ack/1" || ack.token !== receipt.ready.token ||
      ack.cellToken !== request.token || ack.documentNonce !== request.documentNonce ||
      ack.targetId !== request.targetId || ack.browser?.packageName !== request.browser.packageName ||
      ack.browser?.pid !== request.browser.pid) reject("ackIdentityMismatch", { ack });
  try { receipt.motionCaptures = inspectMotionCaptures(ack.captures, receipt.ready); }
  catch (error) { reject("captureFailure", { ack, error: String(error) }); }
  if (ack.captureOk !== true || !receipt.motionCaptures) reject("captureFailure", { ack });
  if (!receipt.processLedger) reject("ledgerFailure", { ledger: ack.processLedger });
  const lastMotionEpochMs = Math.max(...receipt.motionCaptures.flatMap((capture) =>
    [capture.physicalEpochMs, capture.pageEpochMs]));
  if (receipt.processLedger.capturedEpochMs < lastMotionEpochMs ||
      receipt.processLedger.capturedEpochMs > now()) {
    reject("ledgerFailure", { ledger: ack.processLedger, reason: "ledger not captured after motion" });
  }
  try { receipt.after = await capture(); }
  catch (error) { reject("captureFailure", { phase: "after", error: String(error) }); }
  requireAlive();
  try { requireReadyWitnessState(receipt.after, true); }
  catch (error) { reject("readinessFailure", { phase: "after", error: String(error), state: receipt.after }); }
  let finalTargetId;
  try { finalTargetId = await targetId(); }
  catch (error) { reject("contextFailure", { phase: "after", error: String(error) }); }
  requireAlive();
  if (finalTargetId !== request.targetId) {
    reject("targetChanged", { phase: "after", expected: request.targetId, observed: finalTargetId });
  }
  if (stableWitnessState(receipt.before) !== stableWitnessState(receipt.after)) {
    reject("identityChanged", { phase: "after", expected: receipt.before, observed: receipt.after });
  }
  receipt.finishedEpochMs = now();
  writeAtomic(verifiedPath, receipt);
  return receipt;
}
