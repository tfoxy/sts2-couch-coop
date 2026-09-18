#!/usr/bin/env node
import { lstat, readdir, realpath, readFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [kind, candidate] = process.argv.slice(2);
const allowedByKind = {
  webkit: new Set(["browser-lifecycle.jsonl", "iphone-webkit-result.json", "iphone-webkit-timeline.json", "iphone-webkit-failure.png"]),
  safari: new Set([
    "browser-lifecycle.jsonl",
    "iphone-safari-result.json",
    "iphone-safari-timeline.json",
    "iphone-safari-crash-metadata.json",
    "iphone-safari-failure.png",
  ]),
};
const requiredByKind = {
  webkit: new Set(["browser-lifecycle.jsonl", "iphone-webkit-result.json", "iphone-webkit-timeline.json"]),
  safari: new Set(["iphone-safari-result.json", "iphone-safari-timeline.json"]),
};
if (!(kind in allowedByKind) || !candidate) {
  process.stderr.write("usage: validate-iphone-artifact-stage.mjs webkit|safari PATH\n");
  process.exit(64);
}

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const stage = resolve(candidate);
const stageProfile = basename(stage);
const expectedRoots = kind === "webkit"
  ? [resolve(repoRoot, ".ci-artifacts", "iphone-webkit", "baseline"), resolve(repoRoot, ".ci-artifacts", "iphone-webkit", "field-repro")]
  : [resolve(repoRoot, ".ci-artifacts", "iphone-safari-arm", "field-repro")];
if (!expectedRoots.includes(stage) || basename(stage).includes("..")) throw new Error("iPhone artifact stage is not a reviewed profile root");

let entries;
try {
  entries = await readdir(stage, { withFileTypes: true });
} catch (error) {
  if (error?.code === "ENOENT") throw new Error("required iPhone artifact stage is missing");
  throw error;
}
if (await realpath(stage) !== stage) throw new Error("iPhone artifact stage may not be a symlink");
const names = new Set(entries.map(entry => entry.name));
for (const required of requiredByKind[kind]) {
  if (!names.has(required)) throw new Error(`required iPhone artifact is missing: ${required}`);
}
if (kind === "safari") {
  const result = JSON.parse(await readFile(resolve(stage, "iphone-safari-result.json"), "utf8"));
  if (result?.category !== "capability" && !names.has("browser-lifecycle.jsonl")) {
    throw new Error("required iPhone artifact is missing: browser-lifecycle.jsonl");
  }
}
for (const entry of entries) {
  if (!entry.isFile() || !allowedByKind[kind].has(entry.name)) {
    throw new Error(`unreviewed iPhone artifact: ${entry.name}`);
  }
  const path = resolve(stage, entry.name);
  const info = await lstat(path);
  if (info.isSymbolicLink() || await realpath(path) !== path) throw new Error(`symlinked iPhone artifact: ${entry.name}`);
  const maximum = entry.name === "browser-lifecycle.jsonl" ? 1024 * 1024
    : entry.name.endsWith(".png") ? 10 * 1024 * 1024
      : 64 * 1024;
  if (info.size > maximum) throw new Error(`oversized iPhone artifact: ${entry.name}`);
  if (entry.name.endsWith(".png")) {
    const bytes = await readFile(path);
    if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error(`invalid PNG artifact: ${entry.name}`);
  }
  if (entry.name.endsWith(".json")) validateJson(entry.name, JSON.parse(await readFile(path, "utf8")));
  if (entry.name.endsWith(".jsonl")) for (const line of (await readFile(path, "utf8")).split("\n").filter(Boolean)) validateLifecycle(JSON.parse(line));
}
process.stdout.write(`iPhone ${kind} artifact stage: ok\n`);

function exact(value, fields) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw new Error("invalid iPhone artifact schema"); }
function boundedInt(value, maximum = 1_000_000) { return Number.isInteger(value) && value >= 0 && value <= maximum; }
function validateJson(name, value) {
  if (name.includes("timeline")) {
    if (!Array.isArray(value) || value.length > 128) throw new Error("invalid timeline schema");
    if (name.includes("webkit")) {
      for (const row of value) {
        exact(row, ["role", "closed", "queryKeys"]);
        if (!["host", "seat", "other"].includes(row.role) || typeof row.closed !== "boolean"
          || !Array.isArray(row.queryKeys) || row.queryKeys.length > 16
          || row.queryKeys.some(key => typeof key !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key))) {
          throw new Error("invalid WebKit timeline schema");
        }
      }
    } else {
      for (const row of value) {
        exact(row, ["t", "kind"]);
        if (!boundedInt(row.t, 30 * 60 * 1000)
          || !["session-open", "control-loaded", "seat-selected", "final-ack-observed", "survival-complete", "assertion-failed", "passed", "failed", "session-closed"].includes(row.kind)) {
          throw new Error("invalid Safari timeline schema");
        }
      }
    }
    return;
  }
  if (name.includes("webkit-result")) {
    exact(value, ["category", "phase", "failureClass", "ok", "presentations", "acks", "animationFrames", "responsive", "crash", "viewError", "hostSocketOpen", "seatSocketOpen", "journeyValid", "profile", "pageErrorCategories"]);
    if (!["renderer-page-crash", "unexpected-reload-navigation", "seat-socket-close", "host-socket-close", "client-view-error", "missing-acknowledgement", "render-stall", "script-unresponsive", "simulator-safaridriver-failure", "success"].includes(value.category)
      || !["pre-first-frame", "post-first-frame", "post-final-delta"].includes(value.phase)
      || (value.failureClass !== null && value.failureClass !== "post-first-frame-browser-disappearance")
      || typeof value.ok !== "boolean"
      || ![value.presentations, value.acks, value.animationFrames].every(item => boundedInt(item))
      || typeof value.responsive !== "boolean" || typeof value.crash !== "boolean" || typeof value.viewError !== "boolean"
      || typeof value.hostSocketOpen !== "boolean" || typeof value.seatSocketOpen !== "boolean" || typeof value.journeyValid !== "boolean"
      || value.profile !== stageProfile
      || !Array.isArray(value.pageErrorCategories) || value.pageErrorCategories.length > 16
      || value.pageErrorCategories.some(item => !["pageerror", "console:error", "console:warning"].includes(item))
      || value.ok !== (value.category === "success")
      || (value.ok && (value.phase !== "post-final-delta" || value.failureClass !== null
        || value.presentations < (value.profile === "field-repro" ? 6 : 2)
        || value.acks < (value.profile === "field-repro" ? 6 : 2)
        || value.animationFrames < 30 || !value.responsive || value.crash || value.viewError
        || !value.hostSocketOpen || !value.seatSocketOpen || !value.journeyValid))) {
      throw new Error("invalid WebKit result schema");
    }
    return;
  }
  if (name.includes("safari-result")) {
    exact(value, ["category", "phase", "failureClass", "ok", "reason", "presentations", "acks", "hostSocketOpen", "seatSocketOpen", "viewError", "crash", "animationFrames", "responsive", "requiredMessages", "failures", "profile"]);
    if (typeof value.ok !== "boolean"
      || !["renderer-page-crash", "unexpected-reload-navigation", "seat-socket-close", "host-socket-close", "client-view-error", "missing-acknowledgement", "render-stall", "script-unresponsive", "simulator-safaridriver-failure", "success", "capability"].includes(value.category)
      || !["pre-first-frame", "post-first-frame", "post-final-delta"].includes(value.phase)
      || (value.failureClass !== null && value.failureClass !== "post-first-frame-browser-disappearance")
      || value.profile !== "field-repro"
      || (value.reason !== undefined && !/^[a-z0-9-]{1,64}$/.test(value.reason))
      || (value.presentations !== undefined && !boundedInt(value.presentations))
      || (value.acks !== undefined && !boundedInt(value.acks))
      || (value.animationFrames !== undefined && !boundedInt(value.animationFrames))
      || (value.requiredMessages !== undefined && ![2, 6].includes(value.requiredMessages))
      || (value.hostSocketOpen !== undefined && typeof value.hostSocketOpen !== "boolean")
      || (value.seatSocketOpen !== undefined && typeof value.seatSocketOpen !== "boolean")
      || (value.viewError !== undefined && typeof value.viewError !== "boolean")
      || (value.crash !== undefined && typeof value.crash !== "boolean")
      || (value.responsive !== undefined && typeof value.responsive !== "boolean")
      || (value.failures !== undefined && (!Array.isArray(value.failures) || value.failures.length > 9
        || value.failures.some(item => !/^[a-z0-9-]{1,64}$/.test(item))))
      || value.ok !== (value.category === "success")
      || (value.ok && (value.phase !== "post-final-delta" || value.failureClass !== null
        || value.presentations < 6 || value.acks < 6 || value.requiredMessages !== 6
        || value.hostSocketOpen !== true || value.seatSocketOpen !== true || value.viewError !== false
        || value.crash !== false || value.animationFrames < 30 || value.responsive !== true
        || !Array.isArray(value.failures) || value.failures.length !== 0))) {
      throw new Error("invalid Safari result schema");
    }
    return;
  }
  if (name.includes("crash-metadata")) { if (!Array.isArray(value) || value.length > 10 || value.some(row => { exact(row, ["relativeTimeMs", "processCategory", "bugType"]); return !boundedInt(row.relativeTimeMs, 30 * 60 * 1000) || !["mobile-safari", "safari", "webkit", "simulator-jetsam"].includes(row.processCategory) || !/^(?:\d{1,4}|unknown)$/.test(row.bugType); })) throw new Error("invalid crash metadata schema"); }
}
function validateLifecycle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !boundedInt(value.visit, 256) || value.visit < 1 || !boundedInt(value.t, 30 * 60 * 1000)) throw new Error("invalid lifecycle schema");
  const base = ["visit", "t", "kind"];
  switch (value.kind) {
    case "lifecycle":
      exactKeys(value, [...base, "state"]);
      if (!["load", "pageshow", "pagehide", "navigation"].includes(value.state)) throw new Error("invalid lifecycle state");
      break;
    case "visibility":
      exactKeys(value, [...base, "state"]);
      if (!["visible", "hidden"].includes(value.state)) throw new Error("invalid visibility state");
      break;
    case "orientation":
      exactKeys(value, [...base, "state"]);
      if (!["portrait", "landscape"].includes(value.state)) throw new Error("invalid orientation state");
      break;
    case "viewport":
      exactKeys(value, [...base, "width", "height"]);
      if (!boundedInt(value.width, 32768) || value.width < 1 || !boundedInt(value.height, 32768) || value.height < 1) throw new Error("invalid viewport");
      break;
    case "fullscreen":
      exactKeys(value, [...base, "active"]);
      if (typeof value.active !== "boolean") throw new Error("invalid fullscreen state");
      break;
    case "ws-open":
      exactKeys(value, [...base, "role"]);
      if (!["host", "seat"].includes(value.role)) throw new Error("invalid socket role");
      break;
    case "ws-error":
      exactKeys(value, [...base, "role", "category"]);
      if (!["host", "seat"].includes(value.role) || value.category !== "transport") throw new Error("invalid socket error");
      break;
    case "ws-close":
      exact(value, [...base, "role", "code", "clean"]);
      if (!["host", "seat"].includes(value.role)
        || (value.code !== undefined && (!boundedInt(value.code, 4999) || value.code < 1000))
        || (value.clean !== undefined && typeof value.clean !== "boolean")) throw new Error("invalid socket close");
      break;
    case "error":
      exactKeys(value, [...base, "category"]);
      if (!["runtime", "exception", "transport", "render"].includes(value.category)) throw new Error("invalid error category");
      break;
    case "scene-received":
    case "render-begin":
    case "frame-presented":
    case "ack-sent":
      exactKeys(value, [...base, "ordinal"]);
      if (!boundedInt(value.ordinal) || value.ordinal < 1) throw new Error("invalid checkpoint ordinal");
      break;
    default:
      throw new Error("invalid lifecycle kind");
  }
}

function exactKeys(value, fields) {
  exact(value, fields);
  if (Object.keys(value).length !== fields.length || fields.some(field => !(field in value))) throw new Error("invalid iPhone artifact schema");
}
