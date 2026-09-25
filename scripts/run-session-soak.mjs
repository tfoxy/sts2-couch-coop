#!/usr/bin/env node
//
// SESSION SOAK: a hosted couch-coop session you own end to end, driven along a declarative route while the cost of
// every process in it is sampled from /proc.
// =================================================================================================================
//
//   node scripts/live-qa-lock.mjs with --owner <you> \
//     --resource shared:install --resource exclusive:game:<instance> --resource exclusive:port:33771 \
//     -- node scripts/run-session-soak.mjs --instance <instance> --game-root <isolated game root> \
//          --run-dir <fresh dir> --route <route.json> [--seats 3] [--seed-dir <dir> --seed-exclusive] \
//          [--env KEY=VALUE ...] [--launch-arg ARG ...] [--game-cpus 0-7 --viewer-cpus 8-11] \
//          --i-hold-the-live-lock
//
//   node scripts/run-session-soak.mjs ... --plan      # prints everything it would do; launches nothing
//
// What one run does, in order (scripts/lib/session-rig.mjs has the why of each step):
//   1. read-only preflight: ENet port, seat ports and seat bridge sockets already held by another session;
//   2. private headless gamescope; the host game launched INTO it from an isolated game root;
//   3. the host-lobby fixture, N browser seats joined through the live-proven join (probe-five-player-run.mjs
//      `joinSeats()`), and an embark that readies every player through its OWN bridge (`sts2 act ready` — the
//      one semantic action approved for embarking a QA run);
//   4. the route (scripts/lib/run-route.mjs): dev-console jumps, waits, marks, endpoint snapshots — each step
//      timestamped into the stream. Every dev-console step must be PROVEN to replicate: the host's console answers
//      `Enqueued …` and every peer's own godot.log echoes the line (scripts/lib/peer-logs.mjs); an unproven step
//      fails the route unless --replication-optional;
//   5. throughout, the sampler (scripts/lib/process-sampler.mjs) every --sample-interval seconds, plus per-viewer
//      CDP heap/DOM counters every --viewer-metrics-interval seconds;
//   6. end-of-session checks: every peer's read-only state through its own bridge must agree with the host's (act,
//      floor, deck sizes, gold, HP), and no peer log may carry the game's divergence wording;
//   7. teardown by pid + start ticks only, then a receipt.
//
// ROUTES IN A HOSTED RUN. The game replicates its networked console commands to every peer, so a route step is a
// step for the whole table. Prefer `room MONSTER|ELITE|BOSS` to `fight <id>`: `room` draws the encounter the same way
// on every peer, while `fight` can compose some encounters differently per peer. Issue `room`/`fight`/`act` outside
// combat or after `win`. A `room` step waits for every seat, so a step that never replicates is a seat that never
// ran it. scripts/fixtures/session-soak-act1-boss-to-act2.route.json is the worked example.
//
// Outputs, all under --run-dir: stream.ndjson (schema couchcoop-session-soak/1), receipt.json (schema
// couchcoop-session-soak-receipt/1: build identity, leases, route, preflight, contamination, logs, teardown),
// the scratch sts2 config, gamescope.log, launch.{json,err}, seats/ (join screenshots), fetch/, final-state/,
// logs/ (copies of host and seat logs), and the instance user dir under instances/ unless --instances-dir moves it.
//
// This is the reusable harness; a round's specifics (probe switches, control files, where evidence is filed) are
// passed in as --env / --route / --guard-cmd, never written here. For the future full-run E2E, swap the route's
// dev-console steps for `real-input` ones once an executor exists (see REAL_INPUT_CONTRACT in run-route.mjs).
//
// Exit codes: 0 route completed, every check passed and teardown was clean; 1 the session failed (route,
// replication, end-state, divergence, guard) or teardown left survivors;
// 2 usage error or a refusal (lock gate, placement); 3 preflight refusal (something else holds what we need).

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_ENET_PORT, DEFAULT_LOBBY_FIXTURE, LOCK_FLAG, STOCK_LOBBY_SEATS, RigError, SessionRig,
  checkLiveLockGate, checkPlacement, checkoutIdentity, configuredLiveGamePaths, cpuListIsValid, detectLanHost,
  mandatoryLeases, parseEnvPair, preflight, readLocalGameConfig, runProcess
} from "./lib/session-rig.mjs";
import { NdjsonStream, ProcessSampler, parseMeminfo, summarizeForeignLoad } from "./lib/process-sampler.mjs";
import { LogTail, drain, hostConsoleProof, replicationLedger, scanDesync, waitForConsoleEcho } from "./lib/peer-logs.mjs";
import { RouteError, parseRoute, planRoute, runRoute } from "./lib/run-route.mjs";
import { PRIMARY_REPO_ROOT, REPO_ROOT } from "./lib/repo-layout.mjs";

export const RECEIPT_SCHEMA = "couchcoop-session-soak-receipt/1";
export const PLAN_SCHEMA = "couchcoop-session-soak-plan/1";

export class UsageError extends Error {
  name = "UsageError";
}

const VALUE_FLAGS = {
  "--instance": "instance", "--game-root": "gameRoot", "--assemblies-dir": "assembliesDir", "--run-dir": "runDir",
  "--instances-dir": "instancesDir", "--route": "route", "--seats": "seats", "--lobby-seats": "lobbySeats",
  "--lobby-fixture": "lobbyFixture", "--seed-dir": "seedDir", "--width": "width", "--height": "height",
  "--require-gpu": "requireGpu", "--lan-host": "lanHost", "--viewport": "viewport", "--game-cpus": "gameCpus",
  "--viewer-cpus": "viewerCpus", "--sample-interval": "sampleInterval", "--viewer-metrics-interval": "viewerMetricsInterval",
  "--guard-cmd": "guardCmd", "--enet-port": "enetPort", "--seat-concurrency": "seatConcurrency",
  "--launch-timeout-ms": "launchTimeoutMs", "--port-timeout-ms": "portTimeoutMs", "--seat-timeout-ms": "seatTimeoutMs",
  "--embark-timeout-ms": "embarkTimeoutMs", "--lobby-timeout-ms": "lobbyTimeoutMs", "--boot-settle-ms": "bootSettleMs",
  "--lobby-settle-ms": "lobbySettleMs", "--replication-timeout-seconds": "replicationTimeoutSeconds",
  "--launch-mode": "launchMode", "--guard-timeout-seconds": "guardTimeoutSeconds",
  "--contamination-threshold-pct": "contaminationThresholdPct"
};
/** Repeatable. `--launch-arg` / `--gamescope-arg` values may themselves start with `--`. */
const REPEAT_FLAGS = { "--env": "env", "--launch-arg": "launchArgs", "--gamescope-arg": "gamescopeArgs", "--grep": "grep", "--lease": "leases" };
const DASH_VALUES = new Set(["--launch-arg", "--gamescope-arg"]);
const BOOL_FLAGS = {
  "--plan": "plan", [LOCK_FLAG]: "lockHeld", "--seed-exclusive": "seedExclusive", "--no-end-state": "noEndState",
  "--replication-optional": "replicationOptional", "--no-foreign-load": "noForeignLoad",
  "--keep-background-throttle": "keepBackgroundThrottle", "--help": "help", "-h": "help"
};

const DEFAULTS = Object.freeze({
  seats: 3, lobbySeats: STOCK_LOBBY_SEATS, seatConcurrency: 2, width: 1920, height: 1080, viewport: "915x412",
  sampleInterval: 5, viewerMetricsInterval: 60, enetPort: DEFAULT_ENET_PORT, launchTimeoutMs: 120000,
  portTimeoutMs: 240000, seatTimeoutMs: 120000, embarkTimeoutMs: 120000, lobbyTimeoutMs: 60000, bootSettleMs: 10000,
  lobbySettleMs: 3000, contaminationThresholdPct: 5, replicationTimeoutSeconds: 60, guardTimeoutSeconds: 900
});

const INTEGER_FIELDS = {
  seats: [1, 98], lobbySeats: [1, 98], seatConcurrency: [1, 16], width: [320, 7680], height: [240, 4320],
  enetPort: [1, 65535], launchTimeoutMs: [1000, 3600000], portTimeoutMs: [1000, 3600000], seatTimeoutMs: [1000, 3600000],
  embarkTimeoutMs: [1000, 3600000], lobbyTimeoutMs: [1000, 3600000], bootSettleMs: [0, 600000], lobbySettleMs: [0, 60000]
};
const NUMBER_FIELDS = {
  sampleInterval: [0.5, 3600], viewerMetricsInterval: [0, 3600], contaminationThresholdPct: [0, 10000], replicationTimeoutSeconds: [1, 3600],
  guardTimeoutSeconds: [1, 86400]
};

export const USAGE = `usage: node scripts/run-session-soak.mjs --instance <name> --game-root <dir> --run-dir <dir> --route <route.json>
         [--seats N] [--lobby-seats N] [--seed-dir <dir> [--seed-exclusive]] [--env KEY=VALUE]... [--launch-arg ARG]...
         [--assemblies-dir <dir>] [--instances-dir <dir>] [--lobby-fixture <file>] [--lan-host <ip>] [--viewport WxH]
         [--game-cpus LIST] [--viewer-cpus LIST] [--width N --height N] [--gamescope-arg ARG]... [--require-gpu TEXT]
         [--sample-interval S] [--viewer-metrics-interval S] [--no-foreign-load] [--contamination-threshold-pct P]
         [--grep TEXT]... [--no-end-state] [--replication-timeout-seconds S] [--replication-optional]
         [--guard-cmd CMD] [--guard-timeout-seconds S] [--lease MODE:NAME]... [--enet-port N]
         [--launch-timeout-ms N] [--port-timeout-ms N] [--seat-timeout-ms N] [--embark-timeout-ms N]
         [--lobby-timeout-ms N] [--boot-settle-ms N] [--lobby-settle-ms N] [--seat-concurrency N] [--keep-background-throttle]
         [--launch-mode direct|cli]
         (--plan | ${LOCK_FLAG})`;

/** Parses argv into raw option values (strings/arrays/booleans). No filesystem access. */
export function parseSoakArgs(argv) {
  const out = { env: [], launchArgs: [], gamescopeArgs: [], grep: [], leases: [] };
  for (let index = 0; index < argv.length; index += 1) {
    let flag = argv[index];
    let inline = null;
    if (flag.startsWith("--") && flag.includes("=")) {
      inline = flag.slice(flag.indexOf("=") + 1);
      flag = flag.slice(0, flag.indexOf("="));
    }
    if (BOOL_FLAGS[flag]) {
      if (inline !== null) throw new UsageError(`${flag} takes no value`);
      out[BOOL_FLAGS[flag]] = true;
      continue;
    }
    const key = VALUE_FLAGS[flag] ?? REPEAT_FLAGS[flag];
    if (!key) throw new UsageError(`unknown argument ${JSON.stringify(argv[index])}`);
    let value = inline;
    if (value === null) {
      value = argv[index + 1];
      index += 1;
      if (value === undefined || (value.startsWith("--") && !DASH_VALUES.has(flag))) throw new UsageError(`${flag} requires a value`);
    }
    if (REPEAT_FLAGS[flag]) out[key].push(value);
    else out[key] = value;
  }
  return out;
}

/** Turns parsed args into the options the rig and the runner use. Reads only the repo's local config. */
export function resolveSoakOptions(raw, { liveGamePaths = null, lanHost = null } = {}) {
  const options = { ...DEFAULTS };
  for (const required of ["instance", "gameRoot", "runDir", "route"]) {
    if (!raw[required]) throw new UsageError(`--${required.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)} is required`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(raw.instance)) throw new UsageError("--instance must be 1-41 characters of [A-Za-z0-9._-]");
  options.instance = raw.instance;
  options.gameRoot = path.resolve(raw.gameRoot);
  options.runDir = path.resolve(raw.runDir);
  options.instancesDir = path.resolve(raw.instancesDir ?? path.join(options.runDir, "instances"));
  options.route = path.resolve(raw.route);
  options.lobbyFixture = path.resolve(raw.lobbyFixture ?? DEFAULT_LOBBY_FIXTURE);
  options.seedDir = raw.seedDir ? path.resolve(raw.seedDir) : null;
  options.seedExclusive = Boolean(raw.seedExclusive);
  options.launchMode = raw.launchMode ?? "direct";
  if (!["direct", "cli"].includes(options.launchMode)) throw new UsageError("--launch-mode must be direct or cli");
  if (options.launchMode === "direct" && !options.seedDir) {
    throw new UsageError("--seed-dir is required for --launch-mode direct (the default): nothing else gives the instance a profile");
  }
  if (options.seedExclusive && !options.seedDir) throw new UsageError("--seed-exclusive needs --seed-dir: an instance seeded from nothing has no profile");

  for (const [field, [min, max]] of Object.entries(INTEGER_FIELDS)) {
    if (raw[field] === undefined) continue;
    const value = Number(raw[field]);
    if (!Number.isInteger(value) || value < min || value > max) throw new UsageError(`--${field.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)} must be an integer in ${min}..${max}`);
    options[field] = value;
  }
  for (const [field, [min, max]] of Object.entries(NUMBER_FIELDS)) {
    if (raw[field] === undefined) continue;
    const value = Number(raw[field]);
    if (!Number.isFinite(value) || value < min || value > max) throw new UsageError(`--${field.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)} must be a number in ${min}..${max}`);
    options[field] = value;
  }
  if (options.seats > options.lobbySeats) throw new UsageError(`--seats ${options.seats} exceeds --lobby-seats ${options.lobbySeats} (a stock lobby holds the host + ${STOCK_LOBBY_SEATS})`);

  const viewport = /^(\d{2,5})x(\d{2,5})$/.exec(raw.viewport ?? DEFAULTS.viewport);
  if (!viewport) throw new UsageError("--viewport must be WIDTHxHEIGHT");
  options.viewport = { width: Number(viewport[1]), height: Number(viewport[2]) };

  for (const field of ["gameCpus", "viewerCpus"]) {
    if (raw[field] === undefined) continue;
    if (!cpuListIsValid(raw[field])) throw new UsageError(`--${field === "gameCpus" ? "game" : "viewer"}-cpus must be a CPU list like 0-7 or 0,2,4`);
    options[field] = raw[field];
  }
  options.launchEnv = Object.fromEntries(raw.env.map(parseEnvPair));
  options.launchArgs = [...raw.launchArgs];
  options.gamescopeArgs = [...raw.gamescopeArgs];
  options.grep = [...raw.grep];
  options.requireGpu = raw.requireGpu ?? null;
  options.guardCmd = raw.guardCmd ?? null;
  options.endState = !raw.noEndState;
  options.replicationRequired = !raw.replicationOptional;
  options.foreignLoad = !raw.noForeignLoad;
  options.disableBackgroundThrottle = !raw.keepBackgroundThrottle;
  options.plan = Boolean(raw.plan);
  options.lockHeld = Boolean(raw.lockHeld);

  for (const lease of raw.leases) {
    if (!/^(shared|exclusive):[^\s:][^\s]*$/.test(lease)) throw new UsageError(`--lease must be shared:<name> or exclusive:<name>; got ${JSON.stringify(lease)}`);
  }
  options.requiredLeases = [...new Set([...mandatoryLeases(options), ...raw.leases])];

  const local = [REPO_ROOT, PRIMARY_REPO_ROOT].map(root => readLocalGameConfig(path.join(root, "sts2.local.yaml")));
  options.assembliesDir = raw.assembliesDir ? path.resolve(raw.assembliesDir) : local.find(config => config.assembliesDir)?.assembliesDir ?? null;
  if (!options.assembliesDir) throw new UsageError("no game assemblies dir: pass --assemblies-dir, or set game.assembliesDir in sts2.local.yaml");
  options.liveGamePaths = liveGamePaths ?? configuredLiveGamePaths();

  options.lanHost = raw.lanHost ?? lanHost ?? detectLanHost();
  if (!options.lanHost) throw new UsageError("no LAN address found; pass --lan-host (the browser server refuses loopback for viewer routes)");
  return options;
}

const sha256 = text => createHash("sha256").update(text).digest("hex");

const now = () => new Date().toISOString();

function readMemAvailable() {
  try {
    return parseMeminfo(readFileSync("/proc/meminfo", "utf8")).memAvailableBytes ?? null;
  } catch {
    return null;
  }
}

/** What `--plan` prints. Spawns nothing; the preflight only reads /proc. */
export function buildPlan(options, route, { preflightResult }) {
  const rig = new SessionRig(options);
  const leaseArgs = options.requiredLeases.map(lease => `--resource ${lease}`).join(" ");
  return {
    schema: PLAN_SCHEMA,
    wouldLaunch: false,
    note: "Nothing was launched. Re-run with the lock gate (see `invocation`) to execute this plan.",
    invocation: `node scripts/live-qa-lock.mjs with --owner <you> ${leaseArgs} -- node scripts/run-session-soak.mjs <same flags without --plan> ${LOCK_FLAG}`,
    requiredLeases: options.requiredLeases,
    options,
    rig: rig.describe(),
    route: planRoute(route),
    sampler: {
      intervalSeconds: options.sampleInterval,
      foreignLoad: options.foreignLoad,
      viewerMetricsIntervalSeconds: options.viewerMetricsInterval,
      contaminationThresholdPct: options.contaminationThresholdPct
    },
    preflight: preflightResult,
    memAvailableBytes: readMemAvailable(),
    outputs: {
      runDir: options.runDir,
      stream: path.join(options.runDir, "stream.ndjson"),
      receipt: path.join(options.runDir, "receipt.json"),
      userDir: rig.userDir
    }
  };
}

/**
 * Runs --guard-cmd with SESSION_SOAK_PHASE=pre|post. A guard may legitimately WAIT (a load gate), so its time limit
 * is its own flag; a guard stopped at that limit is reported as timed out, not as a guard that said no.
 */
export async function runGuard(command, phase, runDir, { timeoutSeconds = DEFAULTS.guardTimeoutSeconds } = {}) {
  if (!command) return null;
  const result = await runProcess("sh", ["-c", command], { env: { ...process.env, SESSION_SOAK_PHASE: phase, SESSION_SOAK_RUN_DIR: runDir }, cwd: runDir, timeoutMs: timeoutSeconds * 1000 });
  return {
    phase, command, exitCode: result.code, signal: result.signal ?? null, timedOut: Boolean(result.timedOut), timeoutSeconds,
    stdout: result.stdout.slice(-4000), stderr: result.stderr.slice(-4000)
  };
}

const guardVerdict = guard => guard.timedOut
  ? `timed out after ${guard.timeoutSeconds} s and was stopped (raise --guard-timeout-seconds if the guard waits by design)`
  : guard.signal ? `was killed by ${guard.signal}` : `exited ${guard.exitCode}`;

/** One full session. Returns the process exit code; never leaves owned processes behind on any path. */
export async function runSession(options, route, {
  lease,
  log = message => console.error(`[session-soak] ${message}`),
  rigDeps = {},
  preflightFn = preflight,
  reassertLease = () => checkLiveLockGate({ flag: true, resources: options.requiredLeases }),
  extensions = null
} = {}) {
  mkdirSync(options.runDir, { recursive: true });
  const streamPath = path.join(options.runDir, "stream.ndjson");
  if (existsSync(streamPath)) throw new RigError("run-dir-used", `${options.runDir} already holds a session stream; every session gets a fresh --run-dir`, 2);
  const receiptPath = path.join(options.runDir, "receipt.json");
  const routeText = readFileSync(options.route, "utf8");
  const receipt = {
    schema: RECEIPT_SCHEMA,
    startedAt: now(),
    finishedAt: null,
    argv: process.argv.slice(2),
    checkout: checkoutIdentity(),
    lease,
    options,
    route: { file: options.route, sha256: sha256(routeText), name: route.name, plan: planRoute(route) },
    failure: null
  };
  const writeReceipt = () => writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  writeReceipt();

  const stream = new NdjsonStream(streamPath);
  const controller = new AbortController();
  const onSignal = signal => {
    log(`${signal}: stopping the route; teardown follows`);
    stream.write({ kind: "error", where: "signal", message: signal });
    controller.abort();
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, onSignal);

  const rig = new SessionRig(options, { log, signal: controller.signal, ...rigDeps });
  let extension = null;
  const routeForeign = [];
  const consoleLines = [];
  let phase = "preflight";
  let samplerTimer = null;
  let viewerTimer = null;
  let sampler = null;
  let lost = null;
  const setPhase = next => {
    phase = next;
    stream.write({ kind: "phase", phase });
  };
  const tick = () => {
    if (!sampler) return;
    try {
      for (const record of sampler.sample()) {
        const line = stream.write({ ...record, phase });
        if (record.kind === "foreign" && phase === "route") routeForeign.push(line);
      }
    } catch (error) {
      stream.write({ kind: "error", where: "sampler", message: error.message });
    }
    const live = rig.liveness();
    if (!lost && (live.compositor === false || live.host === false)) {
      lost = live.compositor === false ? "compositor" : "host";
      stream.write({ kind: "check", check: "liveness", ok: false, lost });
      log(`the ${lost} died; stopping the session (a compositor loss also stops the owned game)`);
      controller.abort();
    }
  };

  let viewerBusy = false;
  const cdp = new Map();
  const viewerTick = async () => {
    if (viewerBusy) return;
    viewerBusy = true;
    try {
      for (const { name, context, page } of rig.deps.seatPages()) {
        let session = cdp.get(name);
        if (!session) {
          session = await context.newCDPSession(page);
          await session.send("Performance.enable");
          cdp.set(name, session);
        }
        const { metrics } = await session.send("Performance.getMetrics");
        const domCounters = await session.send("Memory.getDOMCounters");
        stream.write({ kind: "viewer", phase, seat: name, metrics: Object.fromEntries(metrics.map(metric => [metric.name, metric.value])), domCounters });
      }
    } catch (error) {
      stream.write({ kind: "error", where: "viewer-metrics", message: error.message });
    } finally {
      viewerBusy = false;
    }
  };

  let exitCode = 1;
  try {
    receipt.guard = { pre: await runGuard(options.guardCmd, "pre", options.runDir, { timeoutSeconds: options.guardTimeoutSeconds }), post: null };
    if (receipt.guard.pre && receipt.guard.pre.exitCode !== 0) throw new RigError("guard", `--guard-cmd before the session ${guardVerdict(receipt.guard.pre)}`, 3);

    receipt.preflight = preflightFn({ seats: options.seats, lobbySeats: options.lobbySeats, enetPort: options.enetPort });
    stream.write({ kind: "check", check: "preflight", ok: receipt.preflight.problems.length === 0, problems: receipt.preflight.problems });
    if (receipt.preflight.problems.length > 0) throw new RigError("preflight", receipt.preflight.problems.join("\n"), 3);

    setPhase("bring-up");
    rig.writeScratchConfig();
    receipt.compositor = await rig.startCompositor();
    receipt.seed = await rig.seedInstance();
    receipt.host = await rig.launchHost();
    receipt.displayCheck = rig.displayCheck;
    receipt.hostPort = rig.hostPort;
    receipt.baseUrl = rig.baseUrl;
    stream.write({ kind: "meta", what: "host", host: receipt.host, compositor: receipt.compositor, baseUrl: rig.baseUrl });

    sampler = new ProcessSampler({ resolveTargets: ({ table }) => rig.ownedTargets({ table }), foreign: options.foreignLoad });
    tick();
    samplerTimer = setInterval(tick, options.sampleInterval * 1000);

    receipt.lobby = await rig.holdLobby();
    if (controller.signal.aborted) throw new RigError("aborted", "stopped during bring-up");
    try {
      await rig.joinSeats();
    } finally {
      receipt.seats = rig.seatJoinRecords ?? null;
    }
    receipt.embark = await rig.embark();
    receipt.seatProcesses = rig.seatProcesses;
    if (controller.signal.aborted) throw new RigError("aborted", "stopped during bring-up");
    // The lease is re-proved before the part that takes the longest.
    receipt.leaseAtRouteStart = reassertLease();

    if (options.viewerMetricsInterval > 0) {
      await viewerTick();
      viewerTimer = setInterval(viewerTick, options.viewerMetricsInterval * 1000);
    }
    setPhase("route");
    // Every peer's own log, tailed from here on: the replication proof for each dev-console step.
    const peerTails = rig.peerLogFiles().map(file => ({ peer: file.peer, tail: new LogTail(file.path) }));
    // A caller's extra step kinds (research glue): built once the session is up, finished before the end checks.
    extension = extensions ? await extensions({ rig, options, stream, signal: controller.signal, phase: () => phase }) : null;
    const executors = {
      ...(extension?.executors ?? {}),
      devConsole: async (args, step) => {
        const line = args.join(" ");
        drain(peerTails);
        const result = await rig.sts2.host(["dev", "console", ...args], { timeoutMs: 120000 });
        consoleLines.push(line);
        const hostProof = hostConsoleProof(result.value, args[0], line);
        if (!result.ok) return { ok: false, exitCode: result.code, response: result.value, hostProof, error: result.stderr.slice(0, 800) };
        const replication = rig.issuerNetId === null
          ? { ok: false, line, missing: peerTails.map(entry => entry.peer), note: "the host's netId is unknown, so no echo can be matched" }
          : await waitForConsoleEcho({ peers: peerTails, issuerNetId: rig.issuerNetId, line, timeoutMs: options.replicationTimeoutSeconds * 1000, signal: controller.signal });
        stream.write({ kind: "check", check: "replication", phase, stepIndex: step.index, label: step.label, hostProof, ...replication });
        const proven = hostProof.enqueued && replication.ok;
        return {
          ok: proven || !options.replicationRequired,
          exitCode: result.code,
          hostProof,
          replication: { ok: replication.ok, missing: replication.missing, unconfirmed: replication.unconfirmed, peers: replication.peers },
          error: proven ? null : `replication not proven: ${!hostProof.enqueued ? "the host did not enqueue it for replication; " : ""}${replication.missing?.length ? `no echo from ${replication.missing.join(", ")}` : ""}`
        };
      },
      fetch: async (args, step) => {
        const response = await fetch(`${rig.baseUrl}${args.path}`, { signal: AbortSignal.timeout(15000) });
        const body = Buffer.from(await response.arrayBuffer());
        const dir = path.join(options.runDir, "fetch");
        mkdirSync(dir, { recursive: true });
        const savedTo = path.join(dir, `${String(step.index).padStart(3, "0")}-${step.label}.body`);
        writeFileSync(savedTo, body);
        return { ok: response.ok, status: response.status, bytes: body.length, savedTo };
      }
    };
    receipt.routeResult = await runRoute(route, { executors, emit: record => stream.write({ ...record, phase }), signal: controller.signal });
    setPhase("post-route");
    if (extension?.finish) receipt.extension = await extension.finish();
    tick();
    if (lost) throw new RigError("lost", `the ${lost} died during the session`);
    exitCode = receipt.routeResult.completed ? 0 : 1;
    if (!receipt.routeResult.completed) receipt.failure = { code: "route", message: receipt.routeResult.failedStep ? JSON.stringify(receipt.routeResult.failedStep) : "the route was interrupted" };
    if (options.endState) {
      receipt.endState = await rig.captureEndState();
      stream.write({ kind: "check", check: "end-state", ok: receipt.endState.compare.ok, mismatches: receipt.endState.compare.mismatches });
      if (!receipt.endState.compare.ok) {
        receipt.failure = receipt.failure ?? { code: "end-state", message: `peers disagree about the run: ${JSON.stringify(receipt.endState.compare.mismatches).slice(0, 1500)}` };
        exitCode = 1;
      }
    }
  } catch (error) {
    receipt.failure = { code: error.code ?? error.name, message: error.message };
    exitCode = error.exitCode === 3 ? 3 : error.exitCode === 2 ? 2 : 1;
    stream.write({ kind: "error", where: phase, code: error.code ?? null, message: error.message });
    log(`FAILED (${phase}): ${error.message}`);
  } finally {
    clearInterval(samplerTimer);
    clearInterval(viewerTimer);
    if (extension?.finish && receipt.extension === undefined) {
      try { receipt.extension = await extension.finish(); } catch (error) { receipt.extension = { error: error.message }; }
    }
    try {
      if (rig.host) receipt.identity = rig.buildIdentity();
    } catch (error) {
      receipt.identityError = error.message;
    }
    setPhase("teardown");
    receipt.teardown = await rig.teardown();
    if (!receipt.teardown.clean && exitCode === 0) exitCode = 1;
    try {
      if (rig.host) {
        receipt.logs = rig.collectLogs(options.grep);
        // Every peer's log, host included, read after the processes are gone. Any divergence line fails the
        // session, and so does a log that could not be read: "no hits" in a file nobody scanned proves nothing.
        receipt.desync = scanDesync(rig.peerLogFiles());
        stream.write({ kind: "check", check: "desync", ok: receipt.desync.ok && receipt.desync.unreadable.length === 0, total: receipt.desync.total, unreadable: receipt.desync.unreadable });
        if (receipt.embark && (!receipt.desync.ok || receipt.desync.unreadable.length > 0)) {
          receipt.failure = receipt.failure ?? {
            code: receipt.desync.ok ? "desync-unscanned" : "desync",
            message: receipt.desync.ok ? `peer log(s) unreadable: ${receipt.desync.unreadable.join(", ")}` : `${receipt.desync.total} divergence line(s) in the peer logs`
          };
          if (exitCode === 0) exitCode = 1;
        }
        if (rig.issuerNetId !== null && consoleLines.length > 0) {
          receipt.replicationLedger = replicationLedger({ files: rig.peerLogFiles(), issuerNetId: rig.issuerNetId, lines: [...new Set(consoleLines)] });
        }
      }
    } catch (error) {
      receipt.logsError = error.message;
    }
    receipt.guard = receipt.guard ?? { pre: null, post: null };
    receipt.guard.post = await runGuard(options.guardCmd, "post", options.runDir, { timeoutSeconds: options.guardTimeoutSeconds });
    if (receipt.guard.post && receipt.guard.post.exitCode !== 0) {
      receipt.failure = receipt.failure ?? { code: "guard", message: `--guard-cmd after the session ${guardVerdict(receipt.guard.post)}` };
      if (exitCode === 0) exitCode = 1;
    }
    receipt.contamination = summarizeForeignLoad(routeForeign, { thresholdPct: options.contaminationThresholdPct });
    receipt.events = rig.events;
    receipt.stream = { path: streamPath, records: stream.records };
    receipt.finishedAt = now();
    receipt.exitCode = exitCode;
    stream.write({ kind: "phase", phase: "done" });
    stream.close();
    writeReceipt();
    for (const signal of signals) process.off(signal, onSignal);
  }
  log(`${exitCode === 0 ? "done" : "finished with failures"}: ${receiptPath}`);
  return exitCode;
}

/**
 * The CLI, callable. `routeKinds` / `extensions` let a caller (a round's research glue) register extra route step
 * kinds without forking this file: `routeKinds[kind].validate(args, where)` at parse time, and
 * `extensions({rig, options, stream, signal, phase}) -> {executors: {[kind]: fn}, finish?: async () => receiptPart}`
 * once the session is up.
 */
export async function main(argv, { routeKinds = {}, extensions = null } = {}) {
  let options;
  let route;
  try {
    const raw = parseSoakArgs(argv);
    if (raw.help) {
      console.log(USAGE);
      return 0;
    }
    options = resolveSoakOptions(raw);
    route = parseRoute(readFileSync(options.route, "utf8"), { extraKinds: routeKinds });
  } catch (error) {
    if (error instanceof UsageError || error instanceof RouteError || error instanceof RigError || error?.code === "ENOENT") {
      console.error(`run-session-soak: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }

  const placement = checkPlacement({ gameRoot: options.gameRoot, runDir: options.runDir, liveGamePaths: options.liveGamePaths });

  if (options.plan) {
    const plan = buildPlan(options, route, { preflightResult: preflight({ seats: options.seats, lobbySeats: options.lobbySeats, enetPort: options.enetPort }) });
    plan.placementProblems = placement;
    console.log(JSON.stringify(plan, null, 2));
    for (const problem of [...placement, ...plan.preflight.problems]) console.error(`run-session-soak: plan WARNING: ${problem}`);
    return 0;
  }

  let lease;
  try {
    lease = checkLiveLockGate({ flag: options.lockHeld, resources: options.requiredLeases });
  } catch (error) {
    console.error(`run-session-soak: ${error.message}`);
    return error.exitCode ?? 2;
  }
  if (placement.length > 0) {
    console.error(`run-session-soak: refusing:\n  ${placement.join("\n  ")}`);
    return 2;
  }
  try {
    return await runSession(options, route, { lease, extensions });
  } catch (error) {
    console.error(`run-session-soak: ${error.message}`);
    return error.exitCode ?? 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(`run-session-soak: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
