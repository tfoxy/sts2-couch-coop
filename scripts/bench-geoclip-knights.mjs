#!/usr/bin/env node
// THE KNIGHTS_ELITE GATE BENCH — does the geoclip path beat the shipped /spines/ still, per creature and for the
// encounter, on (a) host Godot main-thread BLOCKING time and (b) browser request -> data-in-hand?
//
// It reuses rather than reinvents: scripts/probe-geoclip-first-frame.mjs is the browser half (one fresh process
// per leg, so no browser cache warmth survives between legs), /perf/spine.json is the host half, and
// scripts/lib/geoclip-bench-{stats,cache}.mjs hold the arithmetic and the cold-produce protocol.
//
// WHAT MAKES A LEG COUNT, and why each check exists:
//
//   COLD          Every cache entry the previous leg created is deleted first, by snapshot diff rather than by
//                 re-deriving a key path (geoclip-bench-cache.mjs explains why derivation is the trap).
//   PRODUCED      The leg must leave a witness that it entered the producer: a /perf/spine.json row, a cache
//                 write, or a refusal receipt. A response is not a produce; a 404 from an unresolvable cache
//                 root and a real refusal are indistinguishable on the wire and have fooled a round before.
//   PAIRED        Legs run ABBA, and each pair is two adjacent legs, so a monotone drift cancels to first order.
//   ELIGIBLE      The verdict is refused outright under Xvfb (which prices an awaited engine frame ~20x while
//                 the two lanes await different numbers of frames), under a software GL stack on either side,
//                 and whenever any leg failed one of the checks above. The report still prints; it just says
//                 NOT-DECIDED and names the blocker.
//
// It never launches or drives a game. scripts/bring-up-gamescope-instance.sh does that, under the live-QA lock.
//
//   node scripts/bench-geoclip-knights.mjs --origin http://127.0.0.1:<port> \
//     --port-file <instance-user-dir>/SlayTheSpire2/couch-coop/browser-port \
//     --dataset <roster.json> --cache-root /tmp/geoclip-bench-cache \
//     --pairs 8 --out .sts2/bench/geoclip-knights-<stamp>
//
//   node scripts/bench-geoclip-knights.mjs --self-test --out /tmp/ws-d-selftest    # no game, no host, no GPU

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  abbaSchedule,
  buildBenchReport,
  classifyDisplay,
  driftDiagnostic,
  foldRunPhases,
  hostWindowForLeg,
  pairLegs,
} from "./lib/geoclip-bench-stats.mjs";
import {
  assertPrivateCacheRoot,
  diffSnapshots,
  producerProofFor,
  purgeCache,
  removeEntries,
  snapshotCache,
} from "./lib/geoclip-bench-cache.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = path.join(ROOT, "scripts", "probe-geoclip-first-frame.mjs");
const RUN_GPU = path.join(ROOT, "scripts", "run-gpu.sh");

const SOFTWARE_GL = ["llvmpipe", "softpipe", "swrast", "swiftshader", "lavapipe"];

function usage() {
  console.log(`bench-geoclip-knights.mjs — paired geoclip vs /spines/-still gate for one encounter

  --origin <url>            the ISOLATED instance's browser server (never 13337 unless it is yours)
  --port-file <file>        that instance's couch-coop/browser-port record; pid and port are verified
  --dataset <file>          probe dataset: { identities: [ { id, scene, node, anim } ] } — the live roster
  --cache-root <dir>        the instance's private COUCHCOOP_CACHE_ROOT. PURGED at start; must not be the operator's
  --out <dir>               report and per-leg evidence
  --identities a,b,c        subset of the dataset (default: all)
  --pairs N                 pairs per creature per lane, even, >= 8 for a gate (default 8)
  --browser headed-gpu|headless-software   default headed-gpu (through scripts/run-gpu.sh, ANGLE's Vulkan
                            backend reaches the real adapter from the virtual display; verified per run by the
                            probe's own WebGL2 renderer string, which raises browser-software-gl if it does not)
  --include-animated-clip   also run the animated /spines/ clip leg — CONTEXT, never part of the gate
  --keep-images first|all|none   per-leg probe screenshots to retain (default first)
  --allow-ineligible        run to completion on a display that cannot decide a verdict; output stays NOT-DECIDED
  --bringup-record <file>   JSON from bring-up-gamescope-instance.sh, folded into the overhead block
  --self-test [--synthetic-artifact <dir>]   offline: synthetic artifact, no host, no game. Proves the plumbing.
  --self-test-inject <mode> none|host-row-absent|phases-null|no-producer-proof|xvfb — drive one documented
                            failure mode through the whole orchestrator, not just the unit tests
  --no-preflight            skip the one uncounted geoclip leg per creature that fails fast when a
                            creature cannot bake at all (not recommended: it is what stops a 20-minute matrix
                            from being spent discovering that nothing mounts)
  --dry-run                 print the plan and exit`);
}

function parseArgs(argv) {
  const options = {
    origin: null, portFile: null, dataset: null, cacheRoot: null, out: null,
    identities: null, pairs: 8, browser: "headed-gpu", includeAnimatedClip: false,
    keepImages: "first", allowIneligible: false, bringupRecord: null,
    selfTest: false, syntheticArtifact: null, selfTestInject: "none", dryRun: false, allowUnsafeCacheRoot: false,
    noPreflight: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const value = () => inline ?? argv[++i];
    switch (flag) {
      case "--origin": options.origin = value(); break;
      case "--port-file": options.portFile = value(); break;
      case "--dataset": options.dataset = value(); break;
      case "--cache-root": options.cacheRoot = value(); break;
      case "--out": options.out = value(); break;
      case "--identities": options.identities = value().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--pairs": options.pairs = Number(value()); break;
      case "--browser": options.browser = value(); break;
      case "--include-animated-clip": options.includeAnimatedClip = true; break;
      case "--keep-images": options.keepImages = value(); break;
      case "--allow-ineligible": options.allowIneligible = true; break;
      case "--bringup-record": options.bringupRecord = value(); break;
      case "--self-test": options.selfTest = true; break;
      case "--synthetic-artifact": options.syntheticArtifact = value(); break;
      case "--self-test-inject": options.selfTestInject = value(); break;
      case "--no-preflight": options.noPreflight = true; break;
      case "--dry-run": options.dryRun = true; break;
      case "--i-know-this-cache-root-is-not-private": options.allowUnsafeCacheRoot = true; break;
      case "--help": case "-h": usage(); process.exit(0); break;
      default: throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  if (!options.out) throw new Error("--out is required");
  if (!["headed-gpu", "headless-software"].includes(options.browser)) throw new Error("--browser must be headed-gpu or headless-software");
  if (!["first", "all", "none"].includes(options.keepImages)) throw new Error("--keep-images must be first, all or none");
  if (!Number.isInteger(options.pairs) || options.pairs < 2 || options.pairs % 2 !== 0) throw new Error("--pairs must be an even integer >= 2 (>= 8 for a gate)");
  if (!SELF_TEST_INJECTIONS.includes(options.selfTestInject)) throw new Error(`--self-test-inject must be one of ${SELF_TEST_INJECTIONS.join(", ")}`);
  if (options.selfTest) return options;
  for (const required of ["origin", "portFile", "dataset", "cacheRoot"]) {
    if (!options[required]) throw new Error(`--${required.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())} is required for a live run (or pass --self-test)`);
  }
  return options;
}

// -----------------------------------------------------------------------------------------------------------
// Preflight: is this the instance we were promised, and can this display decide anything?
// -----------------------------------------------------------------------------------------------------------

function readProcEnviron(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/environ`, "utf8");
    const env = {};
    for (const pair of raw.split("\0")) {
      const at = pair.indexOf("=");
      if (at > 0) env[pair.slice(0, at)] = pair.slice(at + 1);
    }
    return env;
  } catch {
    return null;
  }
}

function readProcCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
  } catch {
    return null;
  }
}

function readProcParent(pid) {
  try {
    // /proc/<pid>/stat: comm is parenthesised and may contain spaces, so read after the last ')'.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(fields[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

/** The game's ancestor chain, so a gamescope or xvfb-run wrapper is found where it actually is. */
function ancestorChain(pid, limit = 12) {
  const chain = [];
  let current = pid;
  for (let depth = 0; depth < limit && current && current !== 1; depth += 1) {
    const cmdline = readProcCmdline(current);
    chain.push({ pid: current, cmdline });
    current = readProcParent(current);
  }
  return chain;
}

async function run(command, args, { env = process.env, timeoutMs = 30_000, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(error) }); });
  });
}

/** The X server process behind a DISPLAY, by matching the display token in the server's own argv. */
async function findXServer(display) {
  if (!display) return null;
  const { stdout } = await run("ps", ["-eo", "pid=,args="], { timeoutMs: 10_000 });
  const token = display.trim();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceAt = trimmed.indexOf(" ");
    const args = trimmed.slice(spaceAt + 1);
    if (!/(^|\/)(Xvfb|Xwayland|Xorg|X)\b/.test(args)) continue;
    if (args.split(/\s+/).includes(token)) return { pid: Number(trimmed.slice(0, spaceAt)), args };
  }
  return null;
}

async function findGamescope(chain) {
  const wrapper = chain.find((entry) => /(^|\/)gamescope\b/.test(entry.cmdline ?? ""));
  if (wrapper) return wrapper.cmdline;
  const { stdout } = await run("ps", ["-eo", "args="], { timeoutMs: 10_000 });
  const line = stdout.split("\n").find((candidate) => /(^|\/)gamescope\b/.test(candidate));
  return line ? line.trim() : null;
}

async function glRendererFor(display) {
  if (!display) return null;
  const { code, stdout } = await run("glxinfo", ["-B"], { env: { ...process.env, DISPLAY: display }, timeoutMs: 15_000 });
  if (code !== 0) return null; // glxinfo is not installed on every box; the Vulkan device below is the fallback
  const line = stdout.split("\n").find((candidate) => candidate.includes("OpenGL renderer string:"));
  return line ? line.split(":").slice(1).join(":").trim() : null;
}

/**
 * The GPU the MEASURED PROCESS actually rendered on, out of its own engine log.
 *
 * Stronger evidence than anything the harness can ask the display for: glxinfo describes a GL context the
 * harness opened, and gamescope's log describes the compositor. This line is the game's own renderer telling us
 * which device it bound — the only one of the three that is about the process whose blocking time is the gate.
 */
function readGameRenderDevice(xdgDataHome, bringupRecord) {
  const candidates = [];
  if (xdgDataHome) candidates.push(path.join(xdgDataHome, "SlayTheSpire2", "logs", "godot.log"));
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const text = readFileSync(file, "utf8");
      // Godot logs its chosen adapter once at startup, e.g. "Vulkan 1.3.xxx - Forward+ - Using Device #0: NVIDIA - NVIDIA GeForce RTX 2060".
      const line = text.split("\n").reverse().find((candidate) => /Using Device #\d+:/.test(candidate));
      if (line) return { device: line.trim(), source: file };
    } catch { /* an unreadable log is simply no evidence */ }
  }
  if (bringupRecord?.vulkanDevice) return { device: bringupRecord.vulkanDevice, source: `${bringupRecord.gamescopeLog ?? "bring-up record"} (compositor, not the game process)` };
  return null;
}

function verifyPortFile(file, origin) {
  const record = JSON.parse(readFileSync(file, "utf8"));
  const port = Number(record.port);
  const pid = Number(record.pid);
  if (!Number.isInteger(port) || !Number.isInteger(pid) || pid < 1) throw new Error(`invalid port/pid record ${file}`);
  try { process.kill(pid, 0); } catch { throw new Error(`the instance pid ${pid} from ${file} is not alive`); }
  const url = new URL(origin);
  const actual = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (actual !== port) throw new Error(`--origin port ${actual} does not match the instance's recorded port ${port} (${file})`);
  return { file: path.resolve(file), port, pid };
}

/**
 * Everything about the running instance that could silently void the measurement.
 *
 * The cache-root check is the load-bearing one: if the game resolved a DIFFERENT COUCHCOOP_CACHE_ROOT from the
 * one this bench purges and watches, every leg would look cold, every diff would be empty, and the producer
 * proof would fail on all 64 legs at the end of a long run rather than in the first second of it.
 */
async function preflightInstance(instance, options, bringupRecord) {
  const env = readProcEnviron(instance.pid);
  const chain = ancestorChain(instance.pid);
  const problems = [];
  if (!env) problems.push(`cannot read /proc/${instance.pid}/environ, so the instance's isolation cannot be verified`);

  const gameCacheRoot = env?.COUCHCOOP_CACHE_ROOT ?? null;
  const wanted = path.resolve(options.cacheRoot);
  if (!gameCacheRoot) {
    problems.push("the instance has no COUCHCOOP_CACHE_ROOT in its environment, so it is writing to the machine default — relaunch it with an explicit private root");
  } else if (path.resolve(gameCacheRoot) !== wanted) {
    problems.push(`the instance's COUCHCOOP_CACHE_ROOT is ${gameCacheRoot} but this bench was told ${wanted}; it would purge and watch a cache the game never touches`);
  }

  const xdgDataHome = env?.XDG_DATA_HOME ?? null;
  const operatorData = path.join(homedir(), ".local", "share");
  if (!xdgDataHome) problems.push("the instance has no XDG_DATA_HOME, so it shares the operator's Godot user dir (and their browser-port record)");
  else if (path.resolve(xdgDataHome) === operatorData) problems.push(`the instance's XDG_DATA_HOME is the operator's own ${operatorData}`);

  const display = env?.DISPLAY ?? null;
  const xServer = await findXServer(display);
  const gamescopeCommand = await findGamescope(chain);
  const glRenderer = await glRendererFor(display);
  const renderDevice = readGameRenderDevice(xdgDataHome, bringupRecord);
  const environment = classifyDisplay({
    display,
    xServerCommand: xServer?.args ?? null,
    glRenderer,
    vulkanDevice: renderDevice?.device ?? null,
    gamescopeCommand,
  });

  return {
    ...environment,
    renderDeviceSource: renderDevice?.source ?? null,
    instancePid: instance.pid,
    instancePort: instance.port,
    gameCacheRoot,
    xdgDataHome,
    waylandDisplay: env?.WAYLAND_DISPLAY ?? null,
    gameArgv: readProcCmdline(instance.pid),
    ancestors: chain.map((entry) => entry.cmdline),
    geoclipEnv: Object.fromEntries(Object.entries(env ?? {}).filter(([key]) => key.startsWith("COUCHCOOP_") || key.startsWith("SPIRECTL_"))),
    isolationProblems: problems,
    blockers: [...environment.blockers, ...problems],
  };
}

// -----------------------------------------------------------------------------------------------------------
// The host window
// -----------------------------------------------------------------------------------------------------------

async function fetchJson(url, { timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* a non-JSON body is itself the finding */ }
    return { status: response.status, json, text: json ? null : text.slice(0, 400) };
  } finally {
    clearTimeout(timer);
  }
}

/** Drain and reset the host's bake ring, so the next window holds only what the next leg causes. */
async function drainPerf(origin, label) {
  const result = await fetchJson(`${origin}/perf/spine.json?reset=1&scenario=geoclip-knights&label=${encodeURIComponent(label)}`);
  if (result.status !== 200 || !result.json) throw new Error(`/perf/spine.json answered ${result.status}${result.text ? `: ${result.text}` : ""} — if the perf routes hang right after a launch, run 'ss -ltn | grep 133': a host that found 13337 taken binds 13339/13340 and never serves /perf/*`);
  return result.json;
}

// -----------------------------------------------------------------------------------------------------------
// One leg
// -----------------------------------------------------------------------------------------------------------

function probeCommand(options, identity, lane, legOut) {
  const args = [
    PROBE,
    "--origin", options.origin,
    "--identity", identity,
    "--lane", lane,
    "--out", legOut,
  ];
  if (options.selfTest) {
    args.push("--artifact", options.syntheticArtifact, "--renderer", "software");
    // The probe owns the synthetic artifact's exact shape (manifest placement + a real SpineClipWire/1
    // raster.spcl). Ask IT to mint it on the first leg rather than restating that container here, where the two
    // would silently drift; every later leg reads the artifact it left behind.
    if (options.needSyntheticArtifact) args.push("--make-synthetic");
  } else {
    args.push("--dataset", options.dataset, "--port-file", options.portFile);
    // `--renderer default` on the virtual display run-gpu.sh opens is NOT the GPU: Xvfb has no hardware GLX, so
    // Chromium falls back to SwiftShader and the harness's own browser-software-gl check then refuses the
    // verdict this mode exists to produce. Naming ANGLE's Vulkan backend binds the Vulkan ICD instead of the X
    // display's GLX and reaches the real adapter — which is what this flag's help text always claimed.
    if (options.browser === "headed-gpu") args.push("--headed", "--renderer", "gpu-vulkan");
    else args.push("--renderer", "software");
  }
  if (options.browser === "headed-gpu" && !options.selfTest) return { command: RUN_GPU, args: ["node", ...args] };
  return { command: process.execPath, args };
}

function parseProbeResult(stdout) {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith("GEOCLIP_FIRST_FRAME_RESULT "));
  if (!line) return null;
  try { return JSON.parse(line.slice("GEOCLIP_FIRST_FRAME_RESULT ".length)); } catch { return null; }
}

/** The browser numbers this bench compares, folded out of the probe's own phase fields. */
function browserMetricsFrom(result) {
  const phases = result?.phases ?? {};
  const laneWorkMs = result.lane === "geoclip"
    ? sumOrNull([phases.geoclipProbeDurationMs, phases.geoclipUploadDurationMs, phases.geoclipDrawDurationMs])
    : sumOrNull([phases.rasterDecodeDrawDurationMs]);
  // TRANSFER MUST COME FROM RESOURCE TIMING, NOT FROM THE FETCH LOG. The harness's `requests[]` is a
  // window.fetch wrapper, and the geoclip lane loads its atlas pages as images, which never pass through fetch.
  // Counting fetch bodies alone therefore prices a geoclip at its manifest only — measured here as 44 KB
  // against the still's 85 KB, i.e. it reports the lane that actually moves ~238 KB as moving half as much as
  // its rival. PerformanceResourceTiming sees every /geoclips/ and /spines/ response the page took.
  const fetchBytes = (result?.requests ?? []).reduce((total, request) => {
    const bytes = request?.bodyBytes ?? request?.contentLength;
    return typeof bytes === "number" ? total + bytes : total;
  }, 0);
  const timings = result?.resourceTiming ?? [];
  const timedBytes = timings.reduce((total, entry) => {
    const bytes = entry?.encodedBodySize;
    return typeof bytes === "number" ? total + bytes : total;
  }, 0);
  const transferBytes = timedBytes > 0 ? timedBytes : (fetchBytes > 0 ? fetchBytes : null);
  return {
    startToAfterTwoRafMs: typeof phases.startToAfterTwoRafMs === "number" ? phases.startToAfterTwoRafMs : null,
    laneWorkMs,
    probeMs: phases.geoclipProbeDurationMs ?? null,
    uploadMs: phases.geoclipUploadDurationMs ?? null,
    drawMs: phases.geoclipDrawDurationMs ?? null,
    rasterDecodeDrawMs: phases.rasterDecodeDrawDurationMs ?? null,
    transferBytes,
    transferSource: timedBytes > 0 ? "resource-timing-encodedBodySize" : (fetchBytes > 0 ? "window.fetch-bodies-only (no resource timing; UNDERSTATES a geoclip's image loads)" : null),
    fetchOnlyBytes: fetchBytes > 0 ? fetchBytes : null,
    assetResponses: timings.length,
    requests: (result?.requests ?? []).length,
    webglRenderer: result?.backendProbe?.webgl2?.renderer ?? null,
    alphaPixels: result?.paint?.alphaPixels ?? null,
  };
}

function sumOrNull(values) {
  let total = 0;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    total += value;
  }
  return total;
}

async function runLeg({ options, identity, lane, scheduleEntry, outDir, live, random }) {
  const legLabel = `${identity.id}-${lane}-b${scheduleEntry.block}p${scheduleEntry.position}`;
  const legOut = path.join(outDir, "legs", legLabel);
  await mkdir(legOut, { recursive: true });

  const before = live ? await snapshotCache(options.cacheRoot) : null;
  if (live) await drainPerf(options.origin, `${legLabel}-drain`);

  const { command, args } = probeCommand(options, identity.id, lane, legOut);
  const spawnedAt = Date.now();
  const child = await run(command, args, { timeoutMs: 180_000 });
  const processWallMs = Date.now() - spawnedAt;
  options.needSyntheticArtifact = false;

  const result = parseProbeResult(child.stdout);
  const perf = live
    ? await drainPerf(options.origin, legLabel)
    : simulatedHostWindow(lane, scheduleEntry.ordinal, random, options.selfTestInject);
  const after = live ? await snapshotCache(options.cacheRoot) : null;
  const diff = live ? diffSnapshots(before, after) : simulatedDiff(lane, scheduleEntry.ordinal, options.selfTestInject);
  const host = { ...hostWindowForLeg(perf, lane), simulated: !live };
  const producerProof = producerProofFor({ hostWindow: host, diff });

  const cleared = live && diff ? await removeEntries(diff.created) : { removed: [], failed: [] };
  if (live && diff && diff.created.length > 0 && cleared.removed.length !== diff.created.length) {
    throw new Error(`leg ${legLabel} created ${diff.created.length} cache entr(ies) but only ${cleared.removed.length} could be cleared; the next leg would not be cold: ${JSON.stringify(cleared.failed)}`);
  }

  const browser = result ? browserMetricsFrom(result) : null;
  const ok = child.code === 0 && result !== null;
  const leg = {
    ...scheduleEntry,
    label: legLabel,
    identity: identity.id,
    ok,
    failure: ok ? null : (child.code !== 0 ? `probe exit ${child.code}: ${child.stderr.trim().split("\n").slice(-3).join(" | ")}` : "probe printed no GEOCLIP_FIRST_FRAME_RESULT"),
    presentedLane: result?.presentedLane === "raster-fallback" ? "raster" : result?.lane ?? null,
    fallback: result?.fallback ?? null,
    browser,
    host,
    producerProof,
    producerProofSummary: producerProof?.summary ?? null,
    cacheCreated: diff ? diff.created.map((entry) => ({ path: entry.path, kind: entry.kind, size: entry.size })) : null,
    cacheModified: diff ? diff.modified.length : null,
    cleared: { removed: cleared.removed.length, failed: cleared.failed },
    overheadMs: browser?.startToAfterTwoRafMs != null ? processWallMs - browser.startToAfterTwoRafMs : null,
    processWallMs,
    images: result ? { page: result.screenshot ?? null, canvas: result.canvasScreenshot ?? null } : null,
  };
  return leg;
}

async function trimImages(legs, keepImages) {
  if (keepImages === "all") return;
  const seen = new Set();
  for (const leg of legs) {
    const key = `${leg.identity}:${leg.lane}`;
    const keep = keepImages === "first" && !seen.has(key);
    seen.add(key);
    if (keep || !leg.images) continue;
    for (const file of [leg.images.page, leg.images.canvas]) {
      if (file && existsSync(file)) await rm(file, { force: true });
    }
    leg.images = { page: null, canvas: null, note: `dropped by --keep-images ${keepImages}` };
  }
}

// -----------------------------------------------------------------------------------------------------------
// The animated-clip context leg — reported, never gating
// -----------------------------------------------------------------------------------------------------------

async function animatedClipLeg(options, identity) {
  const scene = identity.scene.replace(/^res:\/\//, "").split("/").map(encodeURIComponent).join("/");
  const selectors = new URLSearchParams({ node: identity.node, anim: identity.anim });
  const url = `${options.origin}/spines/${scene}?${selectors}`;
  const before = await snapshotCache(options.cacheRoot);
  await drainPerf(options.origin, `${identity.id}-animated-drain`);
  const started = Date.now();
  let status = null;
  let bytes = null;
  let error = null;
  try {
    const response = await fetch(url);
    status = response.status;
    bytes = (await response.arrayBuffer()).byteLength;
  } catch (failure) {
    error = String(failure?.message ?? failure);
  }
  const wallMs = Date.now() - started;
  const perf = await drainPerf(options.origin, `${identity.id}-animated`);
  const after = await snapshotCache(options.cacheRoot);
  const diff = diffSnapshots(before, after);
  // The animated clip's key carries neither `&still=` nor `&geo=1`, so neither gate-lane predicate matches it.
  // Fold the recorded run directly rather than misfiling it under the still lane.
  const runs = (perf.runs ?? []).filter((entry) => entry?.kind === "clip");
  const host = runs.length > 0
    ? { hostRow: "present", key: runs.at(-1).key ?? null, bakeMs: runs.at(-1).bakeMs ?? null, frames: runs.at(-1).frames ?? null, outputBytes: runs.at(-1).outputBytes ?? null, success: runs.at(-1).success === true, ...foldRunPhases(runs.at(-1)) }
    : { hostRow: "absent", measured: false, blockingMs: null, parkedMs: null, reason: "no clip run recorded in the window" };
  const cleared = await removeEntries(diff.created);
  return {
    identity: identity.id,
    url,
    status,
    error,
    bytes,
    nodeFetchWallMs: wallMs,
    host,
    cleared: cleared.removed.length,
    contextOnly: true,
    note: "CONTEXT ONLY, not part of the gate. This is a node-side fetch of the animated /spines/ clip: it has no browser decode, no upload and no draw, so its wall clock is NOT comparable with either gate lane's browser number. The host row beside it is.",
  };
}

// -----------------------------------------------------------------------------------------------------------
// Self-test: the whole orchestration, offline
//
// The BROWSER half is entirely real here — a real probe process, a real Chromium, the real geoclipPlayer and
// spineClip modules, real timings, parsed by the real parser. Only the host half is simulated, because there is
// no host: the simulator emits a genuine `perf-report/1`-shaped `runs[]` window so hostWindowForLeg is exercised
// against real structure rather than a convenient object. Every leg is stamped `host.simulated: true` and the
// report's verdict is NOT-DECIDED by construction — a self-test can prove the plumbing and can never prove a
// product claim, and the two must never be confusable in an artifact somebody reads six weeks later.
//
// --self-test-inject drives one documented failure mode through the SAME orchestrator the live run uses, which
// is the only way to know the live run would actually notice it.
// -----------------------------------------------------------------------------------------------------------

const SELF_TEST_INJECTIONS = ["none", "host-row-absent", "phases-null", "no-producer-proof", "xvfb"];

/** A deterministic pseudo-random stream, so a self-test run is reproducible and its p-value is stable. */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * A `/perf/spine.json` window for one simulated leg, in the real envelope shape.
 *
 * The numbers are drawn so that geoclip is the faster lane on blocking time, which is a HYPOTHESIS the live run
 * exists to test and is asserted here only to prove the sign test can detect a real effect and report it with
 * the right sign. Nothing about these numbers is a claim about the product.
 */
function simulatedHostWindow(lane, ordinal, random, inject) {
  if (inject === "host-row-absent" && lane === "geoclip") return { schema: "perf-report/1", runs: [] };
  // "The producer was never reached" is the conjunction of BOTH silences — no perf row AND no cache write. A
  // perf row on its own is already a witness, so an injection that only emptied the cache diff would prove
  // nothing about the check.
  if (inject === "no-producer-proof" && lane === "geoclip" && ordinal % 4 === 0) return { schema: "perf-report/1", runs: [] };
  const geoclipKey = "spine://scene/x.tscn?node=Visuals&anim=idle_loop&codec=webp&fps=15&q=85&geo=1&gv=1";
  const stillKey = "spine://scene/x.tscn?node=Visuals&anim=idle_loop&codec=webp&fps=15&q=85&still=1&sf=1";
  const base = lane === "geoclip" ? 150 : 260;
  const jitter = (random() - 0.5) * 40;
  const blocking = Math.max(1, base + jitter);
  const parked = Math.max(1, (lane === "geoclip" ? 90 : 30) + (random() - 0.5) * 20);
  const phases = inject === "phases-null" && lane === "geoclip" && ordinal % 3 === 0
    ? null
    : {
      resourceLoad: { ms: Number((blocking * 0.4).toFixed(2)), calls: 1, blocking: true },
      sweep: { ms: Number((blocking * 0.6).toFixed(2)), calls: 1, blocking: true },
      frameAwait: { ms: Number((parked * 0.7).toFixed(2)), calls: 2, blocking: false },
      encodeWait: { ms: Number((parked * 0.3).toFixed(2)), calls: 1, blocking: false },
    };
  return {
    schema: "perf-report/1",
    runs: [{
      key: lane === "geoclip" ? geoclipKey : stillKey,
      kind: lane === "geoclip" ? "geoclip" : "still",
      route: "self-test",
      bakeMs: Number((blocking + parked).toFixed(2)),
      outputBytes: lane === "geoclip" ? 460_000 : 330_000,
      frames: lane === "geoclip" ? 61 : 1,
      success: true,
      phases,
      counters: null,
    }],
  };
}

/**
 * The cache-diff a simulated leg "produced". Shaped like a real diff so producerProofFor is exercised for real,
 * including the mode where a leg answers without writing anything and must therefore be excluded.
 */
function simulatedDiff(lane, ordinal, inject) {
  if (inject === "no-producer-proof" && lane === "geoclip" && ordinal % 4 === 0) return { created: [], modified: [], removed: [] };
  const kind = lane === "geoclip" ? "poseDir" : "assetBlob";
  return {
    created: [{ path: `/self-test/${lane}/${ordinal}`, kind, size: lane === "geoclip" ? null : 330_000, complete: true }],
    modified: [],
    removed: [],
  };
}

// -----------------------------------------------------------------------------------------------------------

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`geoclip-knights: ${error.message}`);
    usage();
    process.exit(2);
    return;
  }

  const outDir = path.resolve(options.out);
  await mkdir(outDir, { recursive: true });
  const live = !options.selfTest;

  let identities;
  if (options.selfTest) {
    options.syntheticArtifact = path.resolve(options.syntheticArtifact ?? path.join(outDir, "synthetic-artifact"));
    await mkdir(options.syntheticArtifact, { recursive: true });
    options.needSyntheticArtifact = true;
    // The probe requires an --origin even in offline artifact mode, where it forwards nothing. Port 9
    // (discard) is the documented placeholder: a request that escaped the artifact branch would fail loudly
    // rather than silently reaching a real host.
    options.origin ??= "http://127.0.0.1:9";
    identities = [{ id: "synthetic", scene: "offline", node: "offline", anim: "offline" }];
  } else {
    const dataset = JSON.parse(await readFile(options.dataset, "utf8"));
    identities = dataset.identities.filter((item) => !options.identities || options.identities.includes(item.id));
    if (identities.length === 0) throw new Error(`no identities selected from ${options.dataset}`);
  }

  let bringup = null;
  if (options.bringupRecord) {
    try { bringup = JSON.parse(await readFile(options.bringupRecord, "utf8")); } catch (error) { bringup = { error: String(error?.message ?? error), file: options.bringupRecord }; }
  }

  let instance = null;
  let environment;
  let purge = null;
  if (live) {
    assertPrivateCacheRoot(options.cacheRoot, { allowUnsafe: options.allowUnsafeCacheRoot });
    instance = verifyPortFile(options.portFile, options.origin);
    environment = await preflightInstance(instance, options, bringup);
  } else {
    // The xvfb injection runs the REAL classifier against a real Xvfb argv, so what is under test is the rule
    // the live run would apply, not a boolean this branch set by hand.
    const injectedXvfb = options.selfTestInject === "xvfb";
    environment = {
      ...classifyDisplay({
        display: injectedXvfb ? ":99" : null,
        xServerCommand: injectedXvfb ? "/usr/bin/Xvfb :99 -screen 0 2560x1440x24" : null,
        glRenderer: injectedXvfb ? "llvmpipe (LLVM 15.0.7, 256 bits)" : "self-test: no display",
        gamescopeCommand: null,
      }),
      selfTest: true,
      selfTestInject: options.selfTestInject,
    };
    environment.verdictEligible = false;
    environment.blockers = [
      "self-test: this run used a synthetic artifact, a simulated host window and no game, so it measures the harness and can never measure the product",
      ...environment.blockers,
    ];
  }

  if (options.dryRun) {
    console.log(JSON.stringify({
      plan: identities.map((identity) => ({ identity: identity.id, schedule: abbaSchedule(options.pairs).map((entry) => entry.lane) })),
      environment,
      cacheRoot: options.cacheRoot,
      out: outDir,
    }, null, 2));
    return;
  }

  if (live && !environment.verdictEligible && !options.allowIneligible) {
    console.error("geoclip-knights: this display cannot decide a cross-lane verdict:");
    for (const blocker of environment.blockers) console.error(`  - ${blocker}`);
    console.error("Re-run under a private gamescope compositor, or pass --allow-ineligible to collect NON-VERDICT data anyway.");
    process.exit(3);
    return;
  }

  if (live) {
    purge = await purgeCache(options.cacheRoot, { allowUnsafe: options.allowUnsafeCacheRoot });
    console.error(`geoclip-knights: purged ${purge.entriesBefore} cache entries under ${purge.cacheRoot}`);
  }

  const startedAt = Date.now();
  const random = seededRandom(0x5eed);

  // PREFLIGHT, one uncounted geoclip leg per identity. Without it, an encounter that is not up (or a creature
  // that refuses to bake) is discovered only after every leg has quietly fallen back to raster and every pair
  // has been thrown away — twenty minutes for a result of "nothing". It costs one leg per creature and it turns
  // a silent matrix of unusable pairs into a named list, at the start, before anything is spent.
  const preflight = [];
  if (!options.noPreflight) {
    for (const identity of identities) {
      const leg = await runLeg({ options, identity, lane: "geoclip", scheduleEntry: { block: -1, position: 0, lane: "geoclip", ordinal: -1 }, outDir, live, random });
      preflight.push({
        identity: identity.id,
        ok: leg.ok,
        presentedLane: leg.presentedLane,
        fallback: leg.fallback,
        producerProof: leg.producerProofSummary,
        failure: leg.failure,
        mountsGeoclip: leg.ok && leg.presentedLane === "geoclip",
      });
      console.error(`  preflight ${identity.id}: ${leg.ok ? leg.presentedLane : "FAIL"} ${leg.fallback ? `(fallback: ${leg.fallback.reason})` : ""} proof=${leg.producerProofSummary ?? "NONE"}`);
    }
  }
  const refusing = preflight.filter((entry) => !entry.mountsGeoclip);
  const measurable = identities.filter((identity) => !refusing.some((entry) => entry.identity === identity.id));
  if (refusing.length > 0 && measurable.length === 0) {
    throw new Error(`no creature produced a geoclip in preflight (${refusing.map((entry) => `${entry.identity}: ${entry.fallback?.reason ?? entry.failure ?? "?"}`).join("; ")}). Is the encounter actually running, and are on-demand geoclips armed? Stopping before spending a matrix on it.`);
  }

  const creatures = [];
  const allLegs = [];
  for (const identity of measurable) {
    const schedule = abbaSchedule(options.pairs);
    const legs = [];
    for (const entry of schedule) {
      const leg = await runLeg({ options, identity, lane: entry.lane, scheduleEntry: entry, outDir, live, random });
      legs.push(leg);
      allLegs.push(leg);
      const host = leg.host?.measured ? `${leg.host.blockingMs.toFixed(1)}ms blocking` : `host ${leg.host?.hostRow ?? "?"}(${leg.host?.reason ?? "-"})`;
      console.error(`  ${leg.label}: ${leg.ok ? "ok" : "FAIL"} first-frame=${leg.browser?.startToAfterTwoRafMs?.toFixed?.(1) ?? "-"}ms ${host} proof=${leg.producerProofSummary ?? "NONE"}`);
    }
    await trimImages(legs, options.keepImages);
    creatures.push({
      id: identity.id,
      scene: identity.scene,
      node: identity.node,
      anim: identity.anim,
      legs,
      pairs: pairLegs(legs),
      drift: {
        browserFirstFrameMs: driftDiagnostic(legs, (leg) => leg.browser?.startToAfterTwoRafMs ?? null),
        hostBlockingMs: driftDiagnostic(legs, (leg) => (leg.host?.measured ? leg.host.blockingMs : null)),
      },
    });
  }

  const animated = [];
  if (live && options.includeAnimatedClip) {
    for (const identity of identities) animated.push(await animatedClipLeg(options, identity));
  }

  if (refusing.length > 0) {
    environment.blockers = [
      ...environment.blockers,
      `creature-refused-geoclip: ${refusing.map((entry) => `${entry.identity} (${entry.fallback?.reason ?? entry.failure ?? "no geoclip presented"})`).join(", ")} produced no geoclip in preflight and was excluded from the matrix. The round's correctness half requires ALL creatures to mount geoclips, so the encounter gate cannot pass while any creature is missing — this is a finding, not a harness fault.`,
    ];
    environment.verdictEligible = false;
  }

  const softwareBrowser = allLegs
    .map((leg) => leg.browser?.webglRenderer ?? null)
    .filter((renderer) => typeof renderer === "string" && SOFTWARE_GL.some((name) => renderer.toLowerCase().includes(name)));
  if (softwareBrowser.length > 0) {
    environment.blockers = [...environment.blockers, `browser-software-gl: the probe's WebGL2 context reports "${softwareBrowser[0]}" on ${softwareBrowser.length} leg(s). A software GL stack prices the geoclip lane's texture and buffer uploads unrealistically against the raster lane's 2D drawImage, so the browser half of the gate would be biased against geoclip.`];
    environment.verdictEligible = false;
  }

  const overheadValues = allLegs.map((leg) => leg.overheadMs).filter((ms) => typeof ms === "number");
  const report = buildBenchReport({
    generatedAt: new Date().toISOString(),
    environment,
    target: {
      origin: options.origin,
      portFile: instance?.file ?? null,
      instancePid: instance?.pid ?? null,
      instancePort: instance?.port ?? null,
      cacheRoot: options.cacheRoot ? path.resolve(options.cacheRoot) : null,
      dataset: options.dataset ? path.resolve(options.dataset) : null,
      selfTest: options.selfTest,
    },
    design: {
      order: "ABBA per creature; each pair is two adjacent legs, so a monotone drift cancels to first order",
      pairsPerCreature: options.pairs,
      legsPerLanePerCreature: options.pairs,
      lanes: { geoclip: "/geoclips/<scene>?node&anim&file=manifest.json (on-demand bake)", raster: "/spines/<scene>?node&anim&still=1 (the SHIPPED baseline)" },
      coldProtocol: "whole-store purge at start; per leg: snapshot -> drain /perf/spine.json?reset=1 -> one fresh probe process -> drain /perf again -> snapshot -> delete exactly what appeared",
      producerProof: "a leg counts only if it left a /perf row, a cache write, or a refusal receipt",
      browserMode: options.browser,
      probe: path.relative(ROOT, PROBE),
    },
    overhead: {
      bringup,
      note: "Compositor and game startup are NOT inside any lane number. Legs run against an already-running instance; per-leg overhead below is this harness's own cost (fresh node + Vite + Chromium per leg) and is excluded from both gate metrics, which are measured inside the browser.",
      perLegHarnessMs: {
        p50: overheadValues.length ? overheadValues.sort((a, b) => a - b)[Math.floor(overheadValues.length / 2)] : null,
        min: overheadValues.length ? Math.min(...overheadValues) : null,
        max: overheadValues.length ? Math.max(...overheadValues) : null,
        note: "probe process wall clock minus the browser-reported first-frame time",
      },
      totalWallMs: Date.now() - startedAt,
      cachePurge: purge,
    },
    preflight,
    creatures,
    animatedClipContext: animated.length > 0 ? animated : null,
    notes: [
      options.selfTest ? "SELF-TEST RUN. The browser half is real (a real probe process, real Chromium, the real geoclipPlayer/spineClip modules, real timings); the host half is a simulator emitting perf-report/1-shaped windows. Both lanes read ONE synthetic artifact, so every comparison here is meaningless by construction — only the plumbing, the cold protocol and the statistics are under test." : null,
      options.selfTest && options.selfTestInject !== "none" ? `SELF-TEST INJECTION: ${options.selfTestInject}. The orchestrator was fed this documented failure mode deliberately; the blockers below are the PASS condition, not a problem.` : null,
      options.browser === "headless-software" ? "Browser ran headless with SwiftShader explicitly requested; see the browser-software-gl blocker." : null,
    ].filter(Boolean),
  });

  const reportPath = path.join(outDir, "geoclip-knights-bench.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`GEOCLIP_KNIGHTS_REPORT ${reportPath}`);
  console.log(summaryText(report));
  // A self-test's NOT-DECIDED is its designed outcome, not a failure, so it exits 0. Only a LIVE run that could
  // not reach a verdict is worth a non-zero code a wrapper script can trip over.
  if (live && report.verdict.overall === "NOT-DECIDED") process.exitCode = 4;
}

function fmt(value, digits = 1) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function summaryText(report) {
  const lines = [];
  lines.push("");
  lines.push(`verdict: ${report.verdict.overall}   (host ${report.verdict.hostBlockingGate}, browser ${report.verdict.browserFirstFrameGate})`);
  for (const blocker of report.verdict.blockers) lines.push(`  BLOCKER ${blocker}`);
  const table = (title, metric) => {
    lines.push(`  ${title}: geoclip p50 ${fmt(metric.geoclip.p50)} vs raster p50 ${fmt(metric.raster.p50)} ${metric.unit}; median paired delta ${fmt(metric.medianPairedDelta)} (CI ${fmt(metric.pairedDeltaCI.low)}..${fmt(metric.pairedDeltaCI.high)}); sign test ${metric.signTest.geoclipWins}/${metric.signTest.nonTiedPairs} p=${metric.signTest.pValue === null ? "—" : metric.signTest.pValue.toFixed(4)}${metric.unmeasuredPairs ? `; ${metric.unmeasuredPairs} pair(s) UNMEASURED` : ""}`);
  };
  lines.push(`aggregate over ${report.aggregate.creatures} creature(s), ${report.aggregate.usablePairs}/${report.aggregate.pairs} usable pairs:`);
  table("host blockingMs  (GATE)", report.aggregate.metrics.hostBlockingMs);
  table("browser first-frame (GATE)", report.aggregate.metrics.browserFirstFrameMs);
  table("host parkedMs   (ctx)", report.aggregate.metrics.hostParkedMs);
  table("transfer bytes  (ctx)", report.aggregate.metrics.transferBytes);
  for (const creature of report.creatures) {
    const host = creature.metrics.hostBlockingMs;
    const browser = creature.metrics.browserFirstFrameMs;
    lines.push(`  ${creature.id}: host Δ ${fmt(host.medianPairedDelta)}ms p=${host.signTest.pValue === null ? "—" : host.signTest.pValue.toFixed(4)} (${host.measuredPairs} pairs) | browser Δ ${fmt(browser.medianPairedDelta)}ms p=${browser.signTest.pValue === null ? "—" : browser.signTest.pValue.toFixed(4)} (${browser.measuredPairs} pairs)`);
  }
  return lines.join("\n");
}

main().catch((error) => {
  console.error(`geoclip-knights: ${error.stack || error}`);
  process.exit(1);
});
