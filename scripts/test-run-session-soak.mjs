#!/usr/bin/env node
//
// Self-test for scripts/run-session-soak.mjs and its libraries (scripts/lib/{process-sampler,run-route,peer-logs,
// session-rig}.mjs). Plain `node scripts/test-run-session-soak.mjs`: no test runner, no game, no browser, no live
// lease, no network beyond a loopback-free unix socket in a temp dir.
//
// Game-free by construction:
//   * /proc is FAKED for the sampler, identity, socket-ownership, preflight and display checks (a directory tree in
//     the shape the kernel exposes);
//   * `sts2` and `gamescope` are FAKE executables on PATH that record every call. The fake `sts2 game launch`
//     starts a fake "game" (a node process) that publishes a port file and spawns a fake "seat" listening on a unix
//     socket in a temp dir — never on a real `/tmp/spirectl-bridge-slot-N.sock`, which a live seat may own;
//   * teardown is exercised on REAL processes this test spawned, next to a "foreign" process it must not touch.
//
// Covered: /proc parsing and CPU/main-thread/RSS/threads accounting, identity pinning, the foreign channel, the
// NDJSON stream schema, route validation (including the refused console commands and the reserved real-input kind),
// route timing and marks, replication proof and its timeout, the desync scan, the end-state compare, the scratch
// config, port-file identity, socket ownership, preflight, display ownership, seat discovery, placement refusals,
// build identity, owned-only teardown, the lock-gate refusals and `--plan` launching nothing, and one full
// session end to end (plus one where a seat never echoes a console step). Also pins the seat-join exports this
// harness borrows from scripts/probe-five-player-run.mjs.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  NdjsonStream, ProcessSampler, SOAK_STREAM_SCHEMA, classifyChromium, descendantsOf, parseMeminfo, parseStat,
  parseStatus, readProcessTable, streamRecordProblems, summarizeForeignLoad
} from "./lib/process-sampler.mjs";
import { REFUSED_CONSOLE_COMMANDS, RouteError, ROUTE_SCHEMA, parseRoute, planRoute, runRoute, validateRoute } from "./lib/run-route.mjs";
import {
  DESYNC_PATTERN_SOURCE, LogTail, compareRunStates, consoleEchoText, drain, hostConsoleProof, replicationLedger,
  scanDesync, summarizeRunState, waitForConsoleEcho
} from "./lib/peer-logs.mjs";
import {
  CLI_SEED_SENTINEL, RigError, SessionRig, assemblyChanges, buildScratchConfig, checkLiveLockGate, checkPlacement,
  createSts2, directLaunchEnv, discoverSeatProcesses, gameLaunchEnv, hostBridgeSocketPath, grepFile, isSameProcess, issuerNetIdFrom, mandatoryLeases, modAssemblies,
  modAssembliesOutside, parseEnvPair, preflight, readIdentity, resolvePublishedPort, terminateOwned,
  terminateOwnedTree, verifyDisplayOwnership, verifyUnixSocketOwner
} from "./lib/session-rig.mjs";
import { RECEIPT_SCHEMA, UsageError, parseSoakArgs, resolveSoakOptions, runGuard, runSession } from "./run-session-soak.mjs";
import { acquireLease, releaseLease } from "./live-qa-lock.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "scripts", "run-session-soak.mjs");
const cases = [];
const test = (name, body) => cases.push({ name, body });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const temps = [];
const spawned = [];
function tmp(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), `soak-${prefix}-`));
  temps.push(dir);
  return dir;
}
/** A dir short enough for unix socket paths (sun_path is ~108 bytes), even under a long TMPDIR. */
function socketDir() {
  let dir = tmp("sock");
  if (dir.length > 80) {
    dir = mkdtempSync("/tmp/ss-");
    temps.push(dir);
  }
  return dir;
}

// =================================================================================================
// a fake /proc
// =================================================================================================

function statLine({ pid, comm = "proc", state = "S", ppid = 1, utime = 0, stime = 0, threads = 1, startTicks = 100, rssPages = 256 }) {
  const rest = [state, ppid, pid, pid, 0, -1, 4194304, 0, 0, 0, 0, utime, stime, 0, 0, 20, 0, threads, 0, startTicks, 1000000, rssPages, 0];
  return `${pid} (${comm}) ${rest.join(" ")}\n`;
}

function writeProc(root, spec) {
  const { pid, comm = "proc", env = {}, argv = [comm], cpus = "0-11", fds = {}, exe = null, maps = "", rssKb = 1024, threads = 1 } = spec;
  const dir = path.join(root, String(pid));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, "task", String(pid)), { recursive: true });
  mkdirSync(path.join(dir, "fd"), { recursive: true });
  writeFileSync(path.join(dir, "stat"), statLine({ ...spec, comm, threads }));
  writeFileSync(path.join(dir, "task", String(pid), "stat"), statLine({ ...spec, comm, threads, utime: spec.mainUtime ?? spec.utime ?? 0, stime: spec.mainStime ?? spec.stime ?? 0 }));
  writeFileSync(path.join(dir, "status"), `Name:\t${comm}\nThreads:\t${threads}\nVmRSS:\t${rssKb} kB\nCpus_allowed_list:\t${cpus}\n`);
  writeFileSync(path.join(dir, "environ"), Object.entries(env).map(([key, value]) => `${key}=${value}\0`).join(""));
  writeFileSync(path.join(dir, "cmdline"), argv.map(arg => `${arg}\0`).join(""));
  for (const [fd, target] of Object.entries(fds)) symlinkSync(target, path.join(dir, "fd", String(fd)));
  if (exe) symlinkSync(exe, path.join(dir, "exe"));
  writeFileSync(path.join(dir, "maps"), maps);
}

function writeProcNet(root, { unix = [], tcp = [], udp = [] } = {}) {
  mkdirSync(path.join(root, "net"), { recursive: true });
  writeFileSync(path.join(root, "net", "unix"),
    "Num       RefCount Protocol Flags    Type St Inode Path\n"
    + unix.map(({ inode, path: socketPath, listening = true }) => `0000000000000000: 00000002 00000000 ${listening ? "00010000" : "00000000"} 0001 01 ${inode} ${socketPath}\n`).join(""));
  const inet = rows => "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
    + rows.map(({ port, state, inode }, index) => `   ${index}: 00000000:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`).join("");
  writeFileSync(path.join(root, "net", "tcp"), inet(tcp));
  writeFileSync(path.join(root, "net", "tcp6"), inet([]));
  writeFileSync(path.join(root, "net", "udp"), inet(udp));
  writeFileSync(path.join(root, "net", "udp6"), inet([]));
}

function fakeProcRoot() {
  const root = tmp("proc");
  writeFileSync(path.join(root, "loadavg"), "0.52 0.40 0.30 2/901 12345\n");
  writeFileSync(path.join(root, "meminfo"), "MemTotal:       32000000 kB\nMemFree:  1 kB\nMemAvailable:    9000000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1000000 kB\n");
  writeProcNet(root);
  return root;
}

// =================================================================================================
// fake executables
// =================================================================================================

const FAKE_STS2 = String.raw`#!/usr/bin/env node
// Fake sts2 for scripts/test-run-session-soak.mjs. Records every call; emulates just enough of the CLI.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const argv = process.argv.slice(2);
const pick = ["SPIRECTL_BRIDGE_SOCKET_PATH", "SPIRECTL_INSTANCE", "DISPLAY", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE", "DOTNET_ROLL_FORWARD"];
if (process.env.FAKE_STS2_LOG) {
  fs.appendFileSync(process.env.FAKE_STS2_LOG, JSON.stringify({ argv, cwd: process.cwd(), env: Object.fromEntries(pick.map(key => [key, process.env[key] ?? null])) }) + "\n");
}
let config = null, instance = null;
const words = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--config") { config = argv[++i]; continue; }
  if (argv[i] === "--instance") { instance = argv[++i]; continue; }
  if (argv[i] === "--mode") { i += 1; continue; }
  if (argv[i] === "--json") continue;
  words.push(argv[i]);
}
const userDir = () => {
  // A direct launch has no --instance on the command line; the test tells us where the instance lives.
  if (process.env.FAKE_USER_DIR) return process.env.FAKE_USER_DIR;
  const dir = JSON.parse(/^\s*dir:\s*(".*")\s*$/m.exec(fs.readFileSync(config, "utf8"))[1]);
  return path.join(dir, instance, "user");
};
const out = value => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
const key = words.slice(0, 2).join(" ");
if (key === "game mods") {
  const data = path.join(userDir(), "SlayTheSpire2");
  fs.mkdirSync(path.join(data, "steam", "1"), { recursive: true });
  fs.writeFileSync(path.join(data, "steam", "1", "settings.save"), "{}");
  // What the real seed drags in from the operator's live session: their port file (a LIVE pid) and seat dirs.
  fs.mkdirSync(path.join(data, "couch-coop", "headless-slots", "slot-2"), { recursive: true });
  fs.writeFileSync(path.join(data, "couch-coop", "browser-port"), JSON.stringify({ port: 13337, pid: process.ppid }));
  out({ settingsFile: path.join(data, "steam", "1", "settings.save") });
}
if (key === "game launch") {
  const child = spawn(process.execPath, [process.env.FAKE_GAME], { detached: true, stdio: "ignore", env: { ...process.env, XDG_DATA_HOME: userDir() } });
  child.unref();
  out({ launch: { pid: child.pid, stdio: { stdoutPath: path.join(userDir(), "host.stdout.log"), stderrPath: path.join(userDir(), "host.stderr.log") } } });
}
if (key === "dev console") {
  const line = words.slice(2).join(" ");
  const echo = "[INFO] Executing DevConsole command (player 1): \x60" + line + "\x60\n[INFO] DevConsole: " + line + "\n";
  const data = path.join(userDir(), "SlayTheSpire2");
  fs.appendFileSync(path.join(data, "logs", "godot.log"), echo);
  if (!process.env.FAKE_NO_SEAT_ECHO) {
    const seatLog = path.join(data, "couch-coop", "headless-slots", "slot-2", "SlayTheSpire2", "logs", "godot.log");
    const delayed = spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').appendFileSync(process.argv[1], process.argv[2]), 300)", seatLog, echo], { detached: true, stdio: "ignore" });
    delayed.unref();
  }
  out({ line, success: true, output: "Enqueued " + words[2] + " command: '" + line + "'", outputLines: [], notices: [{ code: "networked-console-path" }] });
}
if (key === "act ready") out({ accepted: true });
if (key === "dev fixture") out({ loaded: true });
if (words[0] === "state") {
  const player = (id, netId, isHost) => ({ id, netId, isHost, gold: 99, deck: { count: 10 }, creature: { currentHp: 70, maxHp: 80 }, inventoryComplete: true });
  out({
    characterSelect: { lobby: { netGameType: "host", hostPlayerId: "p:1", maxPlayers: 4, players: [{ id: "p:1" }, { id: "p:1002" }] } },
    run: { currentActIndex: 0, actFloor: 1, totalFloor: 1, players: [player("p:1", 1, true), player("p:1002", 1002, false)] }
  });
}
out({});
`;

const FAKE_GAME = String.raw`// Fake host "game" for scripts/test-run-session-soak.mjs: publishes a port, spawns one fake seat.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const user = process.env.XDG_DATA_HOME;
const data = path.join(user, "SlayTheSpire2");
fs.mkdirSync(path.join(data, "logs"), { recursive: true });
fs.appendFileSync(path.join(data, "logs", "godot.log"), "[INFO] Loading assembly DLL fake/mods/couchcoop/CouchCoop.Mod.dll\n");
const seatHome = path.join(data, "couch-coop", "headless-slots", "slot-2");
fs.mkdirSync(path.join(seatHome, "SlayTheSpire2", "logs"), { recursive: true });
fs.appendFileSync(path.join(seatHome, "SlayTheSpire2", "logs", "godot.log"), "[INFO] Loading assembly DLL fake/mods/couchcoop/CouchCoop.Mod.dll\n");
spawn(process.execPath, [process.env.FAKE_SEAT, "--headless"], { stdio: "ignore", env: { ...process.env, XDG_DATA_HOME: seatHome, COUCHCOOP_HEADLESS_SLOT: "2" } });
setTimeout(() => fs.writeFileSync(path.join(data, "couch-coop", "browser-port"), JSON.stringify({ port: 45678, pid: process.pid })), 200);
setInterval(() => {}, 1e6);
`;

const FAKE_SEAT = String.raw`// Fake headless "seat": holds its bridge socket (in a temp dir) like a real seat holds its own.
require("node:net").createServer().listen(require("node:path").join(process.env.FAKE_SEAT_SOCKET_DIR, "bridge-slot-" + process.env.COUCHCOOP_HEADLESS_SLOT + ".sock"));
`;

const FAKE_GAMESCOPE = `#!/bin/sh
# Fake gamescope for scripts/test-run-session-soak.mjs: announces a display the way the real one's child does.
[ -n "$FAKE_GAMESCOPE_LOG" ] && echo "$*" >> "$FAKE_GAMESCOPE_LOG"
echo "GAMESCOPE_CHILD_DISPLAY=:77"
echo "vulkan: selecting physical device 'Fake GPU 2060'"
sleep 60 &
exec sleep 61
`;

function fakeBin() {
  const dir = tmp("bin");
  writeFileSync(path.join(dir, "sts2"), FAKE_STS2);
  writeFileSync(path.join(dir, "gamescope"), FAKE_GAMESCOPE);
  chmodSync(path.join(dir, "sts2"), 0o755);
  chmodSync(path.join(dir, "gamescope"), 0o755);
  writeFileSync(path.join(dir, "fake-game.cjs"), FAKE_GAME);
  writeFileSync(path.join(dir, "fake-seat.cjs"), FAKE_SEAT);
  return dir;
}

const readLog = file => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : []);

function fakeGameRoot({ executable = false } = {}) {
  const root = tmp("game");
  mkdirSync(path.join(root, "mods", "couchcoop"), { recursive: true });
  writeFileSync(path.join(root, "mods", "couchcoop", "CouchCoop.Mod.dll"), "not really an assembly");
  writeFileSync(path.join(root, "mods", "couchcoop", "build-info.txt"), "commit=deadbeef\n");
  if (executable) {
    // What a direct launch spawns: the fake "game", as the farm's own executable.
    writeFileSync(path.join(root, "SlayTheSpire2"), `#!/usr/bin/env node\n${FAKE_GAME}`);
    chmodSync(path.join(root, "SlayTheSpire2"), 0o755);
  }
  return root;
}

/** A farm-style seed: a profile, plus the operator's live port file and seat dirs a careless copy would carry in. */
function fakeSeedDir() {
  const seed = tmp("seed");
  const data = path.join(seed, "SlayTheSpire2");
  mkdirSync(path.join(data, "steam", "1"), { recursive: true });
  writeFileSync(path.join(data, "steam", "1", "settings.save"), "{}");
  mkdirSync(path.join(data, "couch-coop", "headless-slots", "slot-2"), { recursive: true });
  writeFileSync(path.join(data, "couch-coop", "browser-port"), JSON.stringify({ port: 13337, pid: process.pid }));
  return seed;
}

function writeRoute(steps, name = "selftest") {
  const file = path.join(tmp("route"), "route.json");
  writeFileSync(file, JSON.stringify({ schema: ROUTE_SCHEMA, name, steps }));
  return file;
}

// =================================================================================================
// process-sampler
// =================================================================================================

test("parseStat survives a comm with spaces and parentheses", () => {
  const stat = parseStat(statLine({ pid: 42, comm: "Web Content (x) y", ppid: 7, utime: 11, stime: 4, threads: 9, startTicks: 777 }));
  assert.equal(stat.pid, 42);
  assert.equal(stat.comm, "Web Content (x) y");
  assert.equal(stat.ppid, 7);
  assert.equal(stat.cpuTicks, 15);
  assert.equal(stat.numThreads, 9);
  assert.equal(stat.startTicks, 777);
  const status = parseStatus("Name:\tx\nThreads:\t12\nVmRSS:\t2048 kB\nCpus_allowed_list:\t0-7\n");
  assert.deepEqual(status, { name: "x", threads: 12, rssBytes: 2048 * 1024, cpusAllowed: "0-7" });
  assert.equal(parseMeminfo("MemAvailable:  100 kB\n").memAvailableBytes, 102400);
});

test("the sampler turns tick deltas into CPU %, main-thread CPU %, RSS and threads", () => {
  const root = fakeProcRoot();
  writeProc(root, { pid: 100, comm: "SlayTheSpire2", utime: 100, stime: 0, mainUtime: 80, startTicks: 5000, rssKb: 2048, threads: 40 });
  let clock = 1000;
  const sampler = new ProcessSampler({ procRoot: root, ticksPerSecond: 100, now: () => clock, resolveTargets: () => [{ role: "host", pid: 100, startTicks: 5000 }], foreign: false, system: false });
  const [first] = sampler.sample();
  assert.equal(first.kind, "proc");
  assert.equal(first.cpuPct, null, "no interval yet");
  assert.equal(first.first, true);
  assert.equal(first.cpusAllowed, "0-11");
  writeProc(root, { pid: 100, comm: "SlayTheSpire2", utime: 300, stime: 50, mainUtime: 280, mainStime: 0, startTicks: 5000, rssKb: 4096, threads: 41 });
  clock = 6000;
  const [second] = sampler.sample();
  assert.equal(second.cpuPct, 50, "250 ticks over 5 s at 100 Hz is half a core");
  assert.equal(second.mainCpuPct, 40, "the main thread's 200 ticks over 5 s");
  assert.equal(second.rssBytes, 4096 * 1024);
  assert.equal(second.threads, 41);
  assert.equal(second.intervalSeconds, 5);
  assert.equal(second.first, undefined);
});

test("the sampler never mixes two processes behind one pid", () => {
  const root = fakeProcRoot();
  writeProc(root, { pid: 100, startTicks: 5000 });
  writeProc(root, { pid: 200, startTicks: 10, utime: 5 });
  let clock = 0;
  let targets = [{ role: "host", pid: 100, startTicks: 5000 }, { role: "seat-2", pid: 200 }];
  const sampler = new ProcessSampler({ procRoot: root, ticksPerSecond: 100, now: () => clock, resolveTargets: () => targets, foreign: false, system: false });
  sampler.sample();
  writeProc(root, { pid: 100, startTicks: 6000 }); // the host died and its pid was reused
  writeProc(root, { pid: 200, startTicks: 20, utime: 1 }); // a new process behind the seat's pid
  clock = 5000;
  targets = [{ role: "host", pid: 100, startTicks: 5000 }, { role: "seat-2", pid: 200 }];
  const records = sampler.sample();
  const missing = records.find(record => record.kind === "proc-missing");
  assert.equal(missing.role, "host");
  assert.match(missing.reason, /reused/);
  const seat = records.find(record => record.kind === "proc" && record.pid === 200);
  assert.equal(seat.cpuPct, null, "a new identity starts a new interval");
  assert.equal(seat.first, true);
  const exits = records.filter(record => record.kind === "proc-exit").map(record => `${record.role}:${record.startTicks}`).sort();
  assert.deepEqual(exits, ["host:5000", "seat-2:10"]);
});

test("the foreign channel counts only processes the session does not own", () => {
  const root = fakeProcRoot();
  writeProc(root, { pid: 100, utime: 0 });
  writeProc(root, { pid: 900, comm: "operator-game", utime: 0 });
  writeProc(root, { pid: 901, comm: "idle", utime: 10 });
  let clock = 0;
  const sampler = new ProcessSampler({ procRoot: root, ticksPerSecond: 100, now: () => clock, resolveTargets: () => [{ role: "host", pid: 100 }] });
  const firstForeign = sampler.sample().find(record => record.kind === "foreign");
  assert.equal(firstForeign.totalCpuPct, null);
  writeProc(root, { pid: 100, utime: 400 });
  writeProc(root, { pid: 900, comm: "operator-game", utime: 25 });
  writeProc(root, { pid: 901, comm: "idle", utime: 11 });
  clock = 5000;
  const records = sampler.sample();
  const foreign = records.find(record => record.kind === "foreign");
  assert.equal(foreign.totalCpuPct, 5.2, "25 + 1 ticks over 5 s; the owned host's 400 are excluded");
  assert.deepEqual(foreign.top, [{ pid: 900, comm: "operator-game", cpuPct: 5 }], "0.2 % is under the listing floor");
  const system = records.find(record => record.kind === "system");
  assert.equal(system.loadavg.one, 0.52);
  assert.equal(system.memory.memAvailableBytes, 9000000 * 1024);
  const summary = summarizeForeignLoad([{ kind: "foreign", totalCpuPct: 1 }, { kind: "foreign", totalCpuPct: 7 }, { kind: "foreign", totalCpuPct: null }]);
  assert.deepEqual({ ticks: summary.ticks, ticksOver: summary.ticksOver, fractionOver: summary.fractionOver }, { ticks: 2, ticksOver: 1, fractionOver: 0.5 });
});

test("the stream stamps every record with the schema and rejects unknown kinds", () => {
  const file = path.join(tmp("stream"), "stream.ndjson");
  let clock = 10;
  const stream = new NdjsonStream(file, { now: () => clock });
  stream.write({ kind: "phase", phase: "route" });
  clock = 1510;
  stream.write({ kind: "proc", role: "host", pid: 1, startTicks: 2, cpuPct: 12.5 });
  assert.throws(() => stream.write({ kind: "surprise" }), /unknown stream record kind/);
  stream.close();
  const lines = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(lines.length, 2);
  for (const line of lines) assert.deepEqual(streamRecordProblems(line), []);
  assert.equal(lines[0].schema, SOAK_STREAM_SCHEMA);
  assert.equal(lines[1].elapsedMs, 1500);
  assert.ok(streamRecordProblems({ schema: "x", kind: "proc", t: "no", elapsedMs: -1 }).length >= 3);
});

test("classifyChromium maps --type to roles and leaves non-browsers alone", () => {
  assert.equal(classifyChromium(["/x/chrome-headless-shell"]), "chromium-browser");
  assert.equal(classifyChromium(["/x/chrome", "--type=renderer"]), "chromium-renderer");
  assert.equal(classifyChromium(["/x/chrome", "--type=gpu-process"]), "chromium-gpu");
  assert.equal(classifyChromium(["/x/chrome", "--type=utility"]), "chromium-utility");
  assert.equal(classifyChromium(["sts2", "--json", "state"]), null);
  // The real shape of a Chromium child's cmdline: one argument, the whole rewritten title.
  assert.equal(classifyChromium(["/x/chrome-headless-shell-linux64/chrome-headless-shell --type=renderer --headless=old"]), "chromium-renderer");
  assert.equal(classifyChromium(["/x/chrome-headless-shell --type=gpu-process --no-sandbox"]), "chromium-gpu");
  assert.equal(classifyChromium(["/x/chrome-headless-shell --disable-field-trial-config"]), "chromium-browser");
  assert.equal(classifyChromium([]), null);
});

// =================================================================================================
// run-route
// =================================================================================================

const EXAMPLE_ROUTE = path.join(REPO_ROOT, "scripts", "fixtures", "session-soak-act1-boss-to-act2.route.json");

test("the committed example route validates and uses room, not fight", () => {
  const route = parseRoute(readFileSync(EXAMPLE_ROUTE, "utf8"));
  const consoleCommands = route.steps.filter(step => step.kind === "dev-console").map(step => step.args[0]);
  assert.ok(consoleCommands.includes("room") && consoleCommands.includes("win") && consoleCommands.includes("act"));
  assert.ok(!consoleCommands.includes("fight"), "fight can compose an encounter differently per peer");
  const plan = planRoute(route);
  assert.equal(plan.totalDwellSeconds, route.steps.reduce((sum, step) => sum + step.dwellSeconds, 0));
  assert.equal(plan.steps[0].startOffsetSeconds, 0);
});

test("validateRoute normalizes and refuses what a soak route must not contain", () => {
  const ok = validateRoute({ schema: ROUTE_SCHEMA, name: "r", steps: [{ kind: "dev-console", args: ["ROOM", "MONSTER"], dwellSeconds: 1 }] });
  assert.deepEqual(ok.steps[0].args, ["room", "MONSTER"]);
  assert.equal(ok.steps[0].label, "dev-console-0");
  const refuse = (steps, pattern, extra = {}) => assert.throws(() => validateRoute({ schema: ROUTE_SCHEMA, name: "r", steps, ...extra }), pattern);
  assert.throws(() => validateRoute({ schema: "nope", name: "r", steps: [{ kind: "mark" }] }), /schema/);
  refuse([{ kind: "teleport" }], /kind must be/);
  refuse([{ kind: "wait" }], /dwellSeconds > 0/);
  refuse([{ kind: "wait", dwellSeconds: -1 }], /dwellSeconds/);
  refuse([{ kind: "mark", label: "a" }, { kind: "mark", label: "a" }], /duplicate label/);
  refuse([{ kind: "mark", bogus: 1 }], /unknown field/);
  refuse([{ kind: "fetch", args: { path: "http://elsewhere/x" } }], /absolute path/);
  refuse([{ kind: "dev-console", args: [] }], /non-empty array/);
  refuse([{ kind: "dev-console", args: ["room\nwin"] }], /single-line/);
  for (const command of REFUSED_CONSOLE_COMMANDS) {
    refuse([{ kind: "dev-console", args: [command.toUpperCase()] }], /persisted files/);
  }
  refuse([{ kind: "real-input", args: { seat: "Ann", target: "x" } }], /reserved for the full-run E2E/);
  assert.equal(validateRoute({ schema: ROUTE_SCHEMA, name: "r", steps: [{ kind: "real-input", args: { seat: "Ann" } }] }, { allowRealInput: true }).steps[0].kind, "real-input");
  assert.throws(() => parseRoute("{"), RouteError);
});

function fakeClock() {
  let now = 0;
  const sleeps = [];
  return {
    now: () => now,
    advance: ms => { now += ms; },
    sleeps,
    sleep: async (ms, signal) => { sleeps.push(ms); if (!signal?.aborted) now += ms; }
  };
}

test("runRoute timestamps every step, dwells as declared and emits marks", async () => {
  const clock = fakeClock();
  const route = validateRoute({ schema: ROUTE_SCHEMA, name: "r", steps: [
    { kind: "mark", label: "start", data: { note: "x" } },
    { kind: "dev-console", label: "fight", args: ["room", "MONSTER"], dwellSeconds: 240 },
    { kind: "wait", label: "settle", dwellSeconds: 5 },
    { kind: "fetch", label: "snap", args: { path: "/perf/spine.json" } }
  ] });
  const emitted = [];
  const calls = [];
  const result = await runRoute(route, {
    now: clock.now, sleep: clock.sleep, emit: record => emitted.push(record),
    executors: {
      devConsole: async args => { calls.push(["console", ...args]); clock.advance(700); return { ok: true }; },
      fetch: async args => { calls.push(["fetch", args.path]); return { ok: true, status: 200 }; }
    }
  });
  assert.equal(result.completed, true);
  assert.deepEqual(calls, [["console", "room", "MONSTER"], ["fetch", "/perf/spine.json"]]);
  assert.deepEqual(clock.sleeps, [0, 240000, 5000, 0]);
  const fight = result.steps[1];
  assert.equal(fight.actedAt - fight.startedAt, 700, "the action's own time is recorded");
  assert.equal(fight.endedAt - fight.actedAt, 240000, "then the dwell");
  assert.ok(emitted.some(record => record.kind === "mark" && record.label === "start" && record.data.note === "x"));
  const phases = emitted.filter(record => record.kind === "route" && record.label === "fight").map(record => record.event);
  assert.deepEqual(phases, ["start", "acted", "end"]);
});

test("runRoute stops on a failing step unless the step says continue", async () => {
  const clock = fakeClock();
  const route = validateRoute({ schema: ROUTE_SCHEMA, name: "r", steps: [
    { kind: "dev-console", label: "a", args: ["win"], onError: "continue" },
    { kind: "dev-console", label: "b", args: ["win"] },
    { kind: "mark", label: "never" }
  ] });
  const emitted = [];
  const result = await runRoute(route, { now: clock.now, sleep: clock.sleep, emit: record => emitted.push(record), executors: { devConsole: async () => ({ ok: false, error: "refused" }) } });
  assert.equal(result.completed, false);
  assert.deepEqual(result.failedStep, { index: 1, label: "b", error: "refused" });
  assert.equal(result.steps.length, 2);
  assert.ok(!emitted.some(record => record.label === "never"));
  assert.ok(emitted.some(record => record.event === "failed" && record.label === "b"));
});

test("runRoute honours an abort mid-dwell and refuses real-input without an executor", async () => {
  const controller = new AbortController();
  const route = validateRoute({ schema: ROUTE_SCHEMA, name: "r", steps: [{ kind: "wait", label: "long", dwellSeconds: 3600 }, { kind: "mark", label: "after" }] });
  setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  const result = await runRoute(route, { signal: controller.signal });
  assert.ok(Date.now() - started < 5000, "the hour-long dwell ended at the abort");
  assert.equal(result.aborted, true);
  assert.equal(result.steps.length, 1);
  const withInput = validateRoute({ schema: ROUTE_SCHEMA, name: "r", steps: [{ kind: "real-input", args: { seat: "Ann" } }] }, { allowRealInput: true });
  await assert.rejects(runRoute(withInput, {}), /no real-input executor/);
});

// =================================================================================================
// peer-logs
// =================================================================================================

test("LogTail reports only lines written after it opened, with line numbers", () => {
  const file = path.join(tmp("tail"), "godot.log");
  writeFileSync(file, "old 1\nold 2\n");
  const tail = new LogTail(file);
  assert.deepEqual(tail.poll(), []);
  appendFileSync(file, "new 3\nhalf");
  assert.deepEqual(tail.poll().map(row => [row.lineNumber, row.text]), [[3, "new 3"]]);
  appendFileSync(file, " line\n");
  assert.deepEqual(tail.poll().map(row => [row.lineNumber, row.text]), [[4, "half line"]]);
  writeFileSync(file, "rotated\n");
  assert.deepEqual(tail.poll().map(row => row.text), ["rotated"]);
});

test("waitForConsoleEcho proves every peer ran the line and measures the spread from the host", async () => {
  const dir = tmp("echo");
  const hostLog = path.join(dir, "host.log");
  const seatLog = path.join(dir, "seat.log");
  writeFileSync(hostLog, consoleEchoText(1, "room MONSTER") + "\n"); // an OLDER identical line must not count
  writeFileSync(seatLog, "");
  let clock = 0;
  const now = () => clock;
  const peers = [{ peer: "host", tail: new LogTail(hostLog, { now }) }, { peer: "seat-2", tail: new LogTail(seatLog, { now }) }];
  drain(peers);
  let polls = 0;
  const result = await waitForConsoleEcho({
    peers, issuerNetId: 1, line: "room MONSTER", now, timeoutMs: 10000, pollMs: 100,
    sleep: async ms => {
      clock += ms;
      polls += 1;
      if (polls === 1) appendFileSync(hostLog, `[INFO] ${consoleEchoText(1, "room MONSTER")}\n[INFO] DevConsole: room MONSTER\n`);
      if (polls === 4) appendFileSync(seatLog, `[INFO] ${consoleEchoText(1, "room MONSTER")}\n[INFO] DevConsole: room MONSTER\n`);
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  const seat = result.peers.find(entry => entry.peer === "seat-2");
  assert.equal(seat.delayFromHostMs, 300);
  assert.equal(seat.confirmed, true);

  const silent = await waitForConsoleEcho({ peers, issuerNetId: 1, line: "win", now, timeoutMs: 500, pollMs: 100, sleep: async ms => { clock += ms; } });
  assert.equal(silent.ok, false);
  assert.deepEqual(silent.missing, ["host", "seat-2"]);
});

test("hostConsoleProof reads the replicating path off the console payload", () => {
  assert.deepEqual(hostConsoleProof({ output: "Enqueued room command: 'room MONSTER'", notices: [{ code: "networked-console-path" }] }, "room", "room MONSTER"), { enqueued: true, networkedPath: true });
  assert.deepEqual(hostConsoleProof({ outputLines: ["Enqueued win command: 'win'"] }, "win", "win"), { enqueued: true, networkedPath: false });
  assert.deepEqual(hostConsoleProof({ output: "Spawned" }, "room", "room MONSTER"), { enqueued: false, networkedPath: false });
});

test("scanDesync fails on the divergence wording and says when it could not read a log", () => {
  const dir = tmp("desync");
  writeFileSync(path.join(dir, "host.log"), "fine\n[ERROR] State divergence detected!\n");
  writeFileSync(path.join(dir, "seat.log"), "Disconnected. Reason: StateDivergence\nfine\n");
  writeFileSync(path.join(dir, "clean.log"), "all good\n");
  const result = scanDesync([
    { label: "host", path: path.join(dir, "host.log") },
    { label: "seat", path: path.join(dir, "seat.log") },
    { label: "clean", path: path.join(dir, "clean.log") },
    { label: "gone", path: path.join(dir, "missing.log") }
  ]);
  assert.equal(result.pattern, DESYNC_PATTERN_SOURCE);
  assert.equal(result.ok, false);
  assert.equal(result.total, 2);
  assert.deepEqual(result.unreadable, ["gone"]);
  assert.equal(result.files[0].hits[0].line, 2);
  const ledger = replicationLedger({ files: [{ label: "host", path: path.join(dir, "clean.log") }], issuerNetId: 1, lines: ["win"] });
  assert.deepEqual(ledger, [{ line: "win", peers: { host: 0 } }]);
});

test("compareRunStates catches a peer that disagrees about the run", () => {
  const state = (overrides = {}) => ({ run: { currentActIndex: 1, actFloor: 2, totalFloor: 19, players: [
    { id: "p:1", netId: 1, gold: 50, deck: { count: 12 }, creature: { currentHp: 40, maxHp: 80 }, inventoryComplete: true, ...overrides.host },
    { id: "p:1002", netId: 1002, gold: 70, deck: { cards: [{}, {}, {}] }, creature: { currentHp: 30, maxHp: 75 }, inventoryComplete: true, ...overrides.seat }
  ], ...overrides.run } });
  const host = summarizeRunState(state());
  assert.equal(host.players[1].deckSize, 3, "a deck with no count is counted");
  assert.equal(summarizeRunState({}), null);
  assert.deepEqual(compareRunStates([{ peer: "host", summary: host }, { peer: "seat-2", summary: summarizeRunState(state()) }]).mismatches, []);
  const drifted = compareRunStates([
    { peer: "host", summary: host },
    { peer: "seat-2", summary: summarizeRunState(state({ run: { totalFloor: 18 }, seat: { gold: 71 } })) },
    { peer: "seat-3", summary: null }
  ]);
  assert.equal(drifted.ok, false);
  assert.deepEqual(drifted.mismatches.map(m => `${m.peer}:${m.player ?? "run"}:${m.field}`).sort(), ["seat-2:p:1002:gold", "seat-2:run:totalFloor", "seat-3:run:run"]);
  const partial = compareRunStates([{ peer: "host", summary: host }, { peer: "seat-2", summary: summarizeRunState(state({ host: { inventoryComplete: false, gold: 1 } })) }]);
  assert.equal(partial.ok, true, "an incomplete inventory is not compared");
  assert.equal(partial.incomparable.length, 2);
});

// =================================================================================================
// session-rig: pure pieces on a fake /proc
// =================================================================================================

test("the scratch config quotes every value and never inherits the shared user-data links", () => {
  const text = buildScratchConfig({ gamePath: "/g/a \"b\": c", assembliesDir: "/g/data", instancesDir: "/r/instances", launchArgs: ["--force-steam", "off"], launchEnv: { COUCHCOOP_X: "a: b" } });
  assert.match(text, /^  path: "\/g\/a \\"b\\": c"$/m);
  assert.match(text, /^  launchArgs: \["--display-driver","x11","--force-steam","off"\]$/m);
  assert.match(text, /^    "COUCHCOOP_X": "a: b"$/m);
  assert.match(text, /^  symlinkUserDataDirs: \[\]$/m);
  assert.ok(!/^\s*launchWrapper:/m.test(text));
  assert.match(buildScratchConfig({ gamePath: "/g", assembliesDir: "/a", instancesDir: "/i" }), /^  launchEnv: \{\}$/m);
  assert.deepEqual(parseEnvPair("A_B=c=d"), ["A_B", "c=d"]);
  assert.throws(() => parseEnvPair("BAD-KEY=x"), RigError);
  const launchEnv = gameLaunchEnv({ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0", SPIRECTL_BRIDGE_SOCKET_PATH: "/x", SPIRECTL_INSTANCE: "y", KEEP: "1" }, ":77");
  assert.deepEqual(launchEnv, { DISPLAY: ":77", XDG_SESSION_TYPE: "x11", KEEP: "1" });
});

test("a direct launch hands the game a scrubbed environment and a socket that fits", () => {
  const env = directLaunchEnv({
    PATH: "/bin", HOME: "/h", XAUTHORITY: "/h/.Xauthority", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", GAMESCOPE_WAYLAND_DISPLAY: "g",
    COUCHCOOP_CACHE_ROOT: "/operator/cache", SPIRECTL_BRIDGE_SOCKET_PATH: "/operator.sock", DOTNET_ROLL_FORWARD: "Major",
    VK_ICD_FILENAMES: "/x.json", XDG_DATA_HOME: "/h/.local/share", XDG_RUNTIME_DIR: "/run/user/1"
  }, {
    display: ":7", xdg: { XDG_DATA_HOME: "/r/i/user", XDG_CONFIG_HOME: "/r/i/config" }, bridgeSocket: "/r/host-bridge.sock",
    launchEnv: { COUCHCOOP_LAG_PROBE: "1", SPIRECTL_BRIDGE_DISABLE_BACKGROUND_THROTTLE: "0" }
  });
  assert.deepEqual(env, {
    PATH: "/bin", HOME: "/h", XAUTHORITY: "/h/.Xauthority", XDG_RUNTIME_DIR: "/run/user/1",
    XDG_DATA_HOME: "/r/i/user", XDG_CONFIG_HOME: "/r/i/config", DISPLAY: ":7", XDG_SESSION_TYPE: "x11",
    SPIRECTL_BRIDGE_SOCKET_PATH: "/r/host-bridge.sock", SPIRECTL_BRIDGE_DISABLE_BACKGROUND_THROTTLE: "0", COUCHCOOP_LAG_PROBE: "1"
  }, "the caller's launchEnv is applied last and wins");
  assert.equal(hostBridgeSocketPath("/short/run", "soak"), "/short/run/host-bridge.sock");
  const long = hostBridgeSocketPath(`/${"x".repeat(120)}`, "soak");
  assert.match(long, /^\/tmp\/soak-soak-[0-9a-f]{8}\.sock$/);
  assert.match(buildScratchConfig({ gamePath: "/g", assembliesDir: "/a", instancesDir: "/i", ipcPath: "/r/host-bridge.sock" }), /^transport:\n  kind: ipc\n  ipcPath: "\/r\/host-bridge.sock"$/m);
});

test("a caller can register its own route step kinds, and cannot shadow a built-in one", async () => {
  const kinds = { "control-file": { validate: (args, where) => { if (typeof args?.set !== "object") throw new RouteError(`${where}: needs set`); return { set: args.set }; } } };
  const route = validateRoute({ schema: ROUTE_SCHEMA, name: "r", steps: [{ kind: "control-file", label: "b1-off", args: { set: { hostingTracker: "off" } }, dwellSeconds: 2 }] }, { extraKinds: kinds });
  assert.deepEqual(route.steps[0].args, { set: { hostingTracker: "off" } });
  assert.throws(() => validateRoute({ schema: ROUTE_SCHEMA, name: "r", steps: [{ kind: "control-file", args: {} }] }, { extraKinds: kinds }), /needs set/);
  assert.throws(() => validateRoute({ schema: ROUTE_SCHEMA, name: "r", steps: [{ kind: "control-file", args: { set: {} } }] }), /kind must be one of/);
  assert.throws(() => validateRoute({ schema: ROUTE_SCHEMA, name: "r", steps: [{ kind: "mark" }] }, { extraKinds: { wait: { validate: () => null } } }), /shadow a built-in/);
  const clock = fakeClock();
  const seen = [];
  const result = await runRoute(route, { now: clock.now, sleep: clock.sleep, executors: { "control-file": async (args, step) => { seen.push([args, step.label]); return { ok: true }; } } });
  assert.equal(result.completed, true);
  assert.deepEqual(seen, [[{ set: { hostingTracker: "off" } }, "b1-off"]]);
  assert.deepEqual(clock.sleeps, [2000]);
  const orphan = await runRoute(route, { now: clock.now, sleep: clock.sleep, executors: {} });
  assert.match(orphan.failedStep.error, /no executor for step kind "control-file"/);
});

test("a port file is accepted only from a process running under this instance's user dir", () => {
  const root = fakeProcRoot();
  const userDir = path.join(tmp("user"), "user");
  mkdirSync(path.join(userDir, "SlayTheSpire2", "couch-coop"), { recursive: true });
  const portFile = path.join(userDir, "SlayTheSpire2", "couch-coop", "browser-port");
  writeProc(root, { pid: 300, env: { XDG_DATA_HOME: "/home/someone-else/.local/share" } });
  writeProc(root, { pid: 301, env: { XDG_DATA_HOME: userDir } });
  writeFileSync(portFile, JSON.stringify({ port: 13337, pid: 300 }));
  assert.equal(resolvePublishedPort({ userDir, procRoot: root }), null, "the operator's copied record, live pid and all");
  writeFileSync(portFile, JSON.stringify({ port: 13338, pid: 301 }));
  assert.deepEqual(resolvePublishedPort({ userDir, procRoot: root }), { port: 13338, pid: 301, portFile });
  writeFileSync(portFile, JSON.stringify({ port: 13338, pid: 999 }));
  assert.equal(resolvePublishedPort({ userDir, procRoot: root }), null, "a dead writer");
  writeFileSync(portFile, "{half");
  assert.equal(resolvePublishedPort({ userDir, procRoot: root }), null);
});

test("a seat bridge socket is used only when that seat holds it and nobody else does", () => {
  const root = fakeProcRoot();
  const socketPath = "/tmp/fake-bridge-slot-2.sock";
  writeProc(root, { pid: 402, fds: { 5: "socket:[9002]", 6: "pipe:[1]" } });
  writeProc(root, { pid: 777, fds: { 3: "socket:[9999]" } });
  writeProcNet(root, { unix: [{ inode: 9002, path: socketPath }] });
  assert.equal(verifyUnixSocketOwner({ socketPath, pid: 402, procRoot: root }).ok, true);
  assert.match(verifyUnixSocketOwner({ socketPath, pid: 777, procRoot: root }).problem, /none of which pid 777 holds/);
  writeProcNet(root, { unix: [{ inode: 9002, path: socketPath }, { inode: 9999, path: socketPath }] });
  assert.match(verifyUnixSocketOwner({ socketPath, pid: 402, procRoot: root }).problem, /shared with a process this session does not own/);
  writeProcNet(root, { unix: [{ inode: 9002, path: socketPath, listening: false }] });
  assert.match(verifyUnixSocketOwner({ socketPath, pid: 402, procRoot: root }).problem, /nothing is listening/);
});

test("preflight names what another session already holds", () => {
  const root = fakeProcRoot();
  writeProc(root, { pid: 855, comm: "SlayTheSpire2", fds: { 10: "socket:[5001]", 11: "socket:[5002]" } });
  writeProc(root, { pid: 856, comm: "SlayTheSpire2", fds: { 12: "socket:[5003]" } });
  writeProcNet(root, {
    udp: [{ port: 33771, state: "07", inode: 5001 }],
    tcp: [{ port: 13337, state: "0A", inode: 5002 }, { port: 13357, state: "0A", inode: 5003 }, { port: 13367, state: "01", inode: 5004 }],
    unix: [{ inode: 5003, path: "/tmp/spirectl-bridge-slot-2.sock" }]
  });
  const result = preflight({ procRoot: root, seats: 3 });
  assert.deepEqual(result.enet.owners, [{ pid: 855, comm: "SlayTheSpire2" }]);
  assert.deepEqual(result.availableSlots, [3, 4], "an ESTABLISHED socket on 13367 is not a listener");
  assert.equal(result.problems.length, 2);
  assert.match(result.problems[0], /UDP 33771/);
  assert.match(result.problems[1], /at most 2 can join/);
  assert.deepEqual(preflight({ procRoot: root, seats: 2 }).problems.length, 1, "two seats fit around the taken slot");
  const quiet = fakeProcRoot();
  assert.deepEqual(preflight({ procRoot: quiet, seats: 3 }).problems, []);
});

test("the host's display must be served by the compositor's own X server", () => {
  const root = fakeProcRoot();
  writeProc(root, { pid: 500, comm: "gamescope" });
  writeProc(root, { pid: 501, ppid: 500, comm: "Xwayland", fds: { 4: "socket:[7001]" } });
  writeProc(root, { pid: 600, comm: "SlayTheSpire2", env: { DISPLAY: ":77" } });
  writeProc(root, { pid: 666, comm: "Xorg", fds: { 4: "socket:[7002]" } });
  writeProcNet(root, { unix: [{ inode: 7001, path: "@/tmp/.X11-unix/X77" }, { inode: 7002, path: "/tmp/.X11-unix/X0" }] });
  assert.deepEqual(verifyDisplayOwnership({ display: ":77", compositorPid: 500, gamePid: 600, procRoot: root }), { ok: true, problems: [], xServerPids: [501], xServers: [] });
  // gamescope's real shape: it holds the listening socket itself and its XWayland is re-parented away (ppid 1).
  writeProc(root, { pid: 500, comm: "gamescope", fds: { 9: "socket:[7003]" } });
  writeProc(root, { pid: 502, ppid: 1, comm: "Xwayland", startTicks: 44, fds: { 4: "socket:[7003]" } });
  writeProcNet(root, { unix: [{ inode: 7003, path: "/tmp/.X11-unix/X77" }, { inode: 7002, path: "/tmp/.X11-unix/X0" }] });
  assert.deepEqual(verifyDisplayOwnership({ display: ":77", compositorPid: 500, gamePid: 600, procRoot: root }),
    { ok: true, problems: [], xServerPids: [500, 502], xServers: [{ pid: 502, startTicks: 44, comm: "Xwayland", role: "compositor-xserver" }] });
  // A listener our compositor does NOT hold, next to one it does, is still refused.
  writeProcNet(root, { unix: [{ inode: 7003, path: "/tmp/.X11-unix/X77" }, { inode: 7002, path: "@/tmp/.X11-unix/X77" }] });
  assert.match(verifyDisplayOwnership({ display: ":77", compositorPid: 500, gamePid: 600, procRoot: root }).problems[0], /held by pid\(s\) 666, not by the compositor 500/);
  writeProcNet(root, { unix: [{ inode: 7001, path: "@/tmp/.X11-unix/X77" }, { inode: 7002, path: "/tmp/.X11-unix/X0" }] });
  writeProc(root, { pid: 601, comm: "SlayTheSpire2", env: { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" } });
  const desktop = verifyDisplayOwnership({ display: ":0", compositorPid: 500, gamePid: 601, procRoot: root });
  assert.equal(desktop.ok, false);
  assert.ok(desktop.problems.some(problem => /WAYLAND_DISPLAY/.test(problem)));
  assert.ok(desktop.problems.some(problem => /not by the compositor 500/.test(problem)));
});

test("seats are the host's descendants carrying a slot and this instance's data dir", () => {
  const root = fakeProcRoot();
  const userDir = "/r/instances/soak/user";
  const seatHome = slot => `${userDir}/SlayTheSpire2/couch-coop/headless-slots/slot-${slot}`;
  writeProc(root, { pid: 700, comm: "SlayTheSpire2", startTicks: 1 });
  writeProc(root, { pid: 702, ppid: 700, comm: "sh", env: { COUCHCOOP_HEADLESS_SLOT: "2", XDG_DATA_HOME: seatHome(2) }, argv: ["sh", "wrapper.sh"] });
  writeProc(root, { pid: 703, ppid: 702, comm: "SlayTheSpire2", startTicks: 9, env: { COUCHCOOP_HEADLESS_SLOT: "2", XDG_DATA_HOME: seatHome(2) }, argv: ["SlayTheSpire2", "--headless"] });
  writeProc(root, { pid: 704, ppid: 700, comm: "SlayTheSpire2", env: { COUCHCOOP_HEADLESS_SLOT: "3", XDG_DATA_HOME: seatHome(3) }, argv: ["SlayTheSpire2", "--headless"] });
  writeProc(root, { pid: 705, ppid: 700, comm: "crashpad" });
  writeProc(root, { pid: 800, comm: "SlayTheSpire2", env: { COUCHCOOP_HEADLESS_SLOT: "4", XDG_DATA_HOME: "/elsewhere/slot-4" }, argv: ["SlayTheSpire2", "--headless"] });
  const seats = discoverSeatProcesses({ hostPid: 700, userDir, procRoot: root });
  assert.deepEqual(seats.map(seat => [seat.slot, seat.pid, seat.playerId]), [[2, 703, "p:1002"], [3, 704, "p:1003"]]);
  assert.equal(seats[0].startTicks, 9);
  assert.deepEqual([...descendantsOf(readProcessTable({ procRoot: root }), 700)].sort(), [702, 703, 704, 705]);
});

test("ownedTargets files every process under the right role", () => {
  const root = fakeProcRoot();
  const rig = new SessionRig({ instance: "soak", runDir: "/r", instancesDir: "/r/instances", gameRoot: "/g" }, { procRoot: root, runnerPid: 1000 });
  const userDir = rig.userDir;
  writeProc(root, { pid: 700, comm: "SlayTheSpire2", startTicks: 1 });
  writeProc(root, { pid: 703, ppid: 700, comm: "SlayTheSpire2", env: { COUCHCOOP_HEADLESS_SLOT: "2", XDG_DATA_HOME: `${userDir}/SlayTheSpire2/couch-coop/headless-slots/slot-2` }, argv: ["SlayTheSpire2", "--headless"] });
  writeProc(root, { pid: 713, ppid: 703, comm: "crashpad" });
  writeProc(root, { pid: 705, ppid: 700, comm: "crashpad" });
  writeProc(root, { pid: 1000, comm: "node" });
  writeProc(root, { pid: 500, ppid: 1000, comm: "gamescope", startTicks: 3 });
  writeProc(root, { pid: 501, ppid: 500, comm: "Xwayland" });
  writeProc(root, { pid: 1100, ppid: 1000, comm: "chrome", argv: ["/x/chrome-headless-shell", "--headless"] });
  writeProc(root, { pid: 1101, ppid: 1100, comm: "chrome", argv: ["/x/chrome-headless-shell", "--type=renderer"] });
  writeProc(root, { pid: 1102, ppid: 1100, comm: "chrome", argv: ["/x/chrome-headless-shell", "--type=gpu-process"] });
  writeProc(root, { pid: 1200, ppid: 1000, comm: "sts2", argv: ["sts2", "--json", "state"] });
  writeProc(root, { pid: 999, comm: "operator-game" });
  rig.host = { pid: 700, startTicks: 1 };
  rig.compositor = { pid: 500, startTicks: 3 };
  const roles = Object.fromEntries(rig.ownedTargets({ table: readProcessTable({ procRoot: root }) }).map(target => [target.pid, target.role]));
  assert.deepEqual(roles, {
    700: "host", 703: "seat-2", 713: "seat-2-child", 705: "host-child", 500: "compositor", 501: "compositor-child",
    1000: "harness", 1100: "chromium-browser", 1101: "chromium-renderer", 1102: "chromium-gpu", 1200: "harness-child"
  });
});

test("placement refuses a linked mods dir, the live install's mods dir, and the operator's data dirs", () => {
  const good = fakeGameRoot();
  const home = tmp("home");
  mkdirSync(path.join(home, ".local", "share", "SlayTheSpire2"), { recursive: true });
  assert.deepEqual(checkPlacement({ gameRoot: good, runDir: path.join(tmp("run"), "s1"), liveGamePaths: [], home }), []);
  const linked = tmp("linked");
  symlinkSync(path.join(good, "mods"), path.join(linked, "mods"));
  assert.ok(checkPlacement({ gameRoot: linked, runDir: tmp("run"), liveGamePaths: [], home }).some(problem => /symlink/.test(problem)));
  assert.ok(checkPlacement({ gameRoot: good, runDir: tmp("run"), liveGamePaths: [good], home }).some(problem => /IS the configured game install/.test(problem)));
  assert.ok(checkPlacement({ gameRoot: good, runDir: path.join(home, ".local", "share", "SlayTheSpire2", "soak"), liveGamePaths: [], home }).some(problem => /operator's own data/.test(problem)));
  assert.ok(checkPlacement({ gameRoot: path.join(good, "absent"), runDir: tmp("run"), liveGamePaths: [], home }).some(problem => /does not exist/.test(problem)));
});

test("build identity hashes mod assemblies, spots launch-time rewrites and foreign mapped mods", () => {
  const root = fakeGameRoot();
  const before = modAssemblies(root);
  assert.deepEqual(before.assemblies.map(entry => entry.path), ["mods/couchcoop/CouchCoop.Mod.dll"]);
  assert.match(before.assemblies[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(before.buildInfo["mods/couchcoop"], "commit=deadbeef\n");
  mkdirSync(path.join(root, "mods", "spirectlbridge"));
  writeFileSync(path.join(root, "mods", "spirectlbridge", "spirectlbridge.dll"), "x");
  writeFileSync(path.join(root, "mods", "couchcoop", "CouchCoop.Mod.dll"), "rewritten");
  assert.deepEqual(assemblyChanges(before, modAssemblies(root)), [
    { path: "mods/couchcoop/CouchCoop.Mod.dll", change: "modified" },
    { path: "mods/spirectlbridge/spirectlbridge.dll", change: "added" }
  ]);
  assert.deepEqual(modAssembliesOutside([`${root}/mods/couchcoop/CouchCoop.Mod.dll`, "/other/install/mods/couchcoop/CouchCoop.Mod.dll", "/install/data/sts2.dll"], root), ["/other/install/mods/couchcoop/CouchCoop.Mod.dll"]);
  const log = path.join(root, "godot.log");
  writeFileSync(log, "a\nLoading assembly DLL x\nb\n");
  assert.deepEqual(grepFile(log, "Loading assembly"), [{ line: 2, text: "Loading assembly DLL x" }]);
  assert.equal(grepFile(path.join(root, "nope.log"), "x"), null);
});

test("the console issuer's netId survives a 64-bit Steam id", () => {
  // As a JSON number this id is already rounded; the player id string carries it exactly.
  const rounded = JSON.parse('{"netId": 76561198072573591}').netId;
  assert.notEqual(String(rounded), "76561198072573591");
  assert.equal(issuerNetIdFrom("p:76561198072573591", [{ isHost: true, netId: rounded }]), "76561198072573591");
  assert.equal(issuerNetIdFrom(null, [{ isHost: false, netId: 1002 }, { isHost: true, netId: 1 }]), "1");
  assert.equal(issuerNetIdFrom(null, []), null);
});

test("the lock gate needs the flag, an inherited lease, and a lease that covers the run", () => {
  const resources = mandatoryLeases({ instance: "soak" });
  assert.deepEqual(resources, ["shared:install", "exclusive:game:soak", "exclusive:port:33771"]);
  assert.throws(() => checkLiveLockGate({ flag: false, env: {}, resources }), error => error.code === "lock-flag-missing" && error.exitCode === 2);
  assert.throws(() => checkLiveLockGate({ flag: true, env: {}, resources }), error => error.code === "lease-not-inherited");
  const env = { COUCHCOOP_LIVEQA_OWNER: "me", COUCHCOOP_LIVEQA_PID: "4242" };
  assert.throws(() => checkLiveLockGate({ flag: true, env, resources, assert: () => { throw new Error("lease me (4242) does not hold exclusive:game:soak"); } }), error => error.code === "lease-does-not-cover");
  const held = checkLiveLockGate({ flag: true, env, resources, assert: () => ({ resources: [{ mode: "exclusive", name: "game:soak" }] }) });
  assert.deepEqual(held, { owner: "me", pid: 4242, resources: ["exclusive:game:soak"] });
});

// =================================================================================================
// teardown on real processes
// =================================================================================================

function spawnSleeper(seconds = 60, extra = {}) {
  const child = spawn("sleep", [String(seconds)], { stdio: "ignore", ...extra });
  spawned.push(child.pid);
  return child;
}

async function identityOf(pid) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const identity = readIdentity(pid);
    if (identity) return identity;
    await sleep(20);
  }
  throw new Error(`no identity for ${pid}`);
}

test("teardown signals only owned identities: never a stranger, never a reused pid", async () => {
  const owned = spawnSleeper();
  const stranger = spawnSleeper();
  const reused = spawnSleeper();
  const ownedIdentity = await identityOf(owned.pid);
  const reusedIdentity = await identityOf(reused.pid);
  await identityOf(stranger.pid);
  const report = await terminateOwned([
    { ...ownedIdentity, role: "host" },
    { pid: reused.pid, startTicks: reusedIdentity.startTicks + 1, role: "seat-2" }, // the pid now belongs to someone else
    { pid: 1, startTicks: 1, role: "init" }
  ], { graceMs: 3000 });
  assert.deepEqual(report.map(entry => [entry.role, entry.action]), [["seat-2", "already-gone"], ["init", "refused"], ["host", "terminated"]]);
  assert.equal(isSameProcess(ownedIdentity), false);
  assert.ok(readIdentity(stranger.pid), "the stranger is untouched");
  assert.ok(isSameProcess(reusedIdentity), "the process behind the reused pid is untouched");
  stranger.kill("SIGKILL");
  reused.kill("SIGKILL");
});

test("tree teardown takes the root and everything it had spawned, and nothing else", async () => {
  const root = spawn("sh", ["-c", "sleep 60 & sleep 60 & wait"], { stdio: "ignore" });
  spawned.push(root.pid);
  const bystander = spawnSleeper();
  const rootIdentity = await identityOf(root.pid);
  let children = [];
  for (let attempt = 0; attempt < 100 && children.length < 2; attempt += 1) {
    children = [...descendantsOf(readProcessTable(), root.pid)];
    await sleep(20);
  }
  assert.equal(children.length, 2);
  const report = await terminateOwnedTree({ ...rootIdentity, role: "host" }, { graceMs: 3000 });
  assert.equal(report.length, 3);
  assert.ok(report.every(entry => ["terminated", "killed", "already-gone"].includes(entry.action)), JSON.stringify(report));
  for (const pid of children) {
    const left = readIdentity(pid);
    assert.ok(!left || left.state === "Z", `child ${pid} survived`);
  }
  assert.ok(readIdentity(bystander.pid), "the bystander survives");
  bystander.kill("SIGKILL");
});

// =================================================================================================
// the CLI's refusals and --plan: nothing may be spawned
// =================================================================================================

function cliFixture() {
  const bin = fakeBin();
  const logs = tmp("logs");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STS2_LOG: path.join(logs, "sts2.ndjson"), FAKE_GAMESCOPE_LOG: path.join(logs, "gamescope.log") };
  delete env.COUCHCOOP_LIVEQA_OWNER;
  delete env.COUCHCOOP_LIVEQA_PID;
  const runDir = path.join(tmp("run"), "session");
  const base = ["--instance", "selftest-inst", "--game-root", fakeGameRoot(), "--assemblies-dir", tmp("asm"), "--run-dir", runDir, "--lan-host", "192.0.2.1", "--seed-dir", fakeSeedDir()];
  return { bin, logs, env, runDir, base, route: writeRoute([{ kind: "dev-console", label: "fight", args: ["room", "MONSTER"], dwellSeconds: 1 }]) };
}

const runCli = (args, env) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", cwd: tmpdir(), timeout: 60000 });

function assertNothingSpawned(fixture) {
  assert.equal(existsSync(fixture.env.FAKE_STS2_LOG), false, "sts2 was called");
  assert.equal(existsSync(fixture.env.FAKE_GAMESCOPE_LOG), false, "gamescope was started");
  assert.equal(existsSync(path.join(fixture.runDir, "stream.ndjson")), false, "a session stream was opened");
}

test("the CLI refuses to run without --i-hold-the-live-lock", () => {
  const fixture = cliFixture();
  const result = runCli([...fixture.base, "--route", fixture.route], fixture.env);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--i-hold-the-live-lock/);
  assertNothingSpawned(fixture);
});

test("the CLI refuses the flag alone, with no inherited lease", () => {
  const fixture = cliFixture();
  const result = runCli([...fixture.base, "--route", fixture.route, "--i-hold-the-live-lock"], fixture.env);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /no inherited live-QA lease/);
  assertNothingSpawned(fixture);
});

test("the CLI refuses an inherited lease that does not cover the run, and a linked mods dir under a full one", () => {
  const fixture = cliFixture();
  const leaseRoot = path.join(tmp("leases"), "root");
  const guardDir = path.join(tmp("leases"), "guard");
  const config = { leaseRoot, guardDir };
  const env = { ...fixture.env, COUCHCOOP_LIVEQA_LEASE_ROOT: leaseRoot, COUCHCOOP_LIVEQA_REGISTRY_GUARD: guardDir, COUCHCOOP_LIVEQA_OWNER: "soak-selftest", COUCHCOOP_LIVEQA_PID: String(process.pid) };
  acquireLease({ owner: "soak-selftest", pid: process.pid, resources: ["shared:install"], config });
  try {
    const partial = runCli([...fixture.base, "--route", fixture.route, "--i-hold-the-live-lock"], env);
    assert.equal(partial.status, 2, partial.stderr);
    assert.match(partial.stderr, /does not cover/);
    acquireLease({ owner: "soak-selftest", pid: process.pid, resources: mandatoryLeases({ instance: "selftest-inst" }), config });
    const linkedRoot = tmp("linked");
    symlinkSync(path.join(fakeGameRoot(), "mods"), path.join(linkedRoot, "mods"));
    const args = [...fixture.base];
    args[args.indexOf("--game-root") + 1] = linkedRoot;
    const placement = runCli([...args, "--route", fixture.route, "--i-hold-the-live-lock"], env);
    assert.equal(placement.status, 2, placement.stderr);
    assert.match(placement.stderr, /symlink/);
  } finally {
    releaseLease({ owner: "soak-selftest", pid: process.pid, config });
  }
  assertNothingSpawned(fixture);
});

test("--plan prints the whole plan and launches nothing", () => {
  const fixture = cliFixture();
  const result = runCli([...fixture.base, "--route", EXAMPLE_ROUTE, "--seats", "2", "--launch-arg", "--force-steam", "--launch-arg", "off", "--env", "COUCHCOOP_HEADLESS_PROFILE=1", "--game-cpus", "0-7", "--viewer-cpus", "8-11", "--plan"], fixture.env);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.schema, "couchcoop-session-soak-plan/1");
  assert.equal(plan.wouldLaunch, false);
  assert.deepEqual(plan.requiredLeases, ["shared:install", "exclusive:game:selftest-inst", "exclusive:port:33771"]);
  assert.equal(plan.rig.launchMode, "direct");
  assert.deepEqual(plan.rig.launch.argv.slice(0, 3), ["taskset", "-c", "0-7"]);
  assert.match(plan.rig.launch.argv[3], /\/SlayTheSpire2$/);
  assert.deepEqual(plan.rig.launch.argv.slice(4), ["--display-driver", "x11", "--force-steam", "off"]);
  assert.equal(plan.rig.launch.env.set.COUCHCOOP_HEADLESS_PROFILE, "1");
  assert.match(plan.rig.scratchConfig.text, /"--force-steam","off"/);
  assert.match(plan.rig.scratchConfig.text, /^  ipcPath: /m);
  assert.equal(plan.route.name, "act1-boss-to-act2");
  assert.ok(plan.route.totalDwellSeconds > 0);
  assert.ok(Array.isArray(plan.preflight.problems));
  assert.match(plan.invocation, /live-qa-lock\.mjs with/);
  assertNothingSpawned(fixture);
  assert.equal(existsSync(fixture.runDir), false, "--plan does not even create the run dir");
});

test("the CLI refuses a route with a reserved or persisted-file step before anything starts", () => {
  const fixture = cliFixture();
  const realInput = writeRoute([{ kind: "real-input", args: { seat: "Ann", target: "end-turn" } }]);
  const cloud = writeRoute([{ kind: "dev-console", args: ["cloud", "sync"] }]);
  for (const [route, pattern] of [[realInput, /real-input/], [cloud, /persisted files/]]) {
    const result = runCli([...fixture.base, "--route", route, "--plan"], fixture.env);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, pattern);
  }
  assertNothingSpawned(fixture);
});

test("a guard stopped at its time limit is reported as timed out, not as a guard that said no", async () => {
  const dir = tmp("guard");
  const slow = await runGuard("sleep 5; echo never", "pre", dir, { timeoutSeconds: 1 });
  assert.equal(slow.timedOut, true);
  assert.equal(slow.exitCode, null);
  assert.equal(slow.signal, "SIGKILL");
  const fine = await runGuard("echo \"phase=$SESSION_SOAK_PHASE\"; exit 0", "post", dir, { timeoutSeconds: 5 });
  assert.deepEqual([fine.exitCode, fine.timedOut, fine.stdout.trim()], [0, false, "phase=post"]);
  const no = await runGuard("exit 1", "pre", dir, { timeoutSeconds: 5 });
  assert.deepEqual([no.exitCode, no.timedOut, no.signal], [1, false, null]);
  const options = resolveSoakOptions(parseSoakArgs(["--instance", "a", "--game-root", "/g", "--run-dir", "/r", "--route", "/x.json",
    "--assemblies-dir", "/asm", "--lan-host", "10.0.0.2", "--seed-dir", "/seed", "--guard-timeout-seconds", "3600"]), { liveGamePaths: [] });
  assert.equal(options.guardTimeoutSeconds, 3600);
});

test("argument parsing: dash-valued launch args, validation, and defaults", () => {
  const raw = parseSoakArgs(["--instance", "a", "--launch-arg", "--force-steam", "--launch-arg=off", "--env", "K=V", "--plan"]);
  assert.deepEqual(raw.launchArgs, ["--force-steam", "off"]);
  assert.throws(() => parseSoakArgs(["--instance", "--plan"]), /requires a value/);
  assert.throws(() => parseSoakArgs(["--bogus", "1"]), UsageError);
  const base = ["--instance", "a", "--game-root", "/g", "--run-dir", "/r", "--route", "/x.json", "--assemblies-dir", "/asm", "--lan-host", "10.0.0.2", "--seed-dir", "/seed"];
  const options = resolveSoakOptions(parseSoakArgs(base), { liveGamePaths: [] });
  assert.equal(options.seats, 3);
  assert.deepEqual(options.viewport, { width: 915, height: 412 });
  assert.equal(options.replicationRequired, true);
  assert.equal(options.endState, true);
  assert.equal(options.instancesDir, "/r/instances");
  assert.equal(options.launchMode, "direct");
  assert.throws(() => resolveSoakOptions(parseSoakArgs(base.slice(0, -2)), { liveGamePaths: [] }), /--seed-dir is required/);
  assert.equal(resolveSoakOptions(parseSoakArgs([...base.slice(0, -2), "--launch-mode", "cli"]), { liveGamePaths: [] }).seedDir, null);
  const refuse = (extra, pattern) => assert.throws(() => resolveSoakOptions(parseSoakArgs([...base, ...extra]), { liveGamePaths: [] }), pattern);
  refuse(["--seats", "4"], /exceeds --lobby-seats/);
  refuse(["--launch-mode", "sideways"], /--launch-mode must be/);
  assert.throws(() => resolveSoakOptions(parseSoakArgs([...base.slice(0, -2), "--launch-mode", "cli", "--seed-exclusive"]), { liveGamePaths: [] }), /needs --seed-dir/);
  refuse(["--game-cpus", "0-7;rm"], /CPU list/);
  refuse(["--viewport", "big"], /WIDTHxHEIGHT/);
  refuse(["--lease", "global"], /--lease must be/);
  refuse(["--sample-interval", "0"], /sample-interval/);
  assert.throws(() => resolveSoakOptions(parseSoakArgs(base.slice(2)), { liveGamePaths: [] }), /--instance is required/);
});

// =================================================================================================
// one whole session, game-free
// =================================================================================================

async function fullSession({ noSeatEcho = false, launchMode = "direct", routeSteps, extensions = null }) {
  const bin = fakeBin();
  const logs = tmp("logs");
  const sockets = socketDir();
  const runDir = path.join(tmp("run"), "session");
  const route = writeRoute(routeSteps);
  const args = [
    "--instance", "selftest", "--game-root", fakeGameRoot({ executable: launchMode === "direct" }), "--assemblies-dir", tmp("asm"),
    "--run-dir", runDir, "--route", route, "--seats", "1", "--lan-host", "127.0.0.1", "--sample-interval", "0.5",
    "--viewer-metrics-interval", "0", "--boot-settle-ms", "0", "--lobby-settle-ms", "0", "--replication-timeout-seconds", "3",
    "--grep", "Loading assembly", "--launch-mode", launchMode, "--env", "COUCHCOOP_SELFTEST_MARK=1",
    ...(launchMode === "direct" ? ["--seed-dir", fakeSeedDir()] : []),
    "--i-hold-the-live-lock"
  ];
  const options = resolveSoakOptions(parseSoakArgs(args), { liveGamePaths: [] });
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STS2_LOG: path.join(logs, "sts2.ndjson"), FAKE_GAMESCOPE_LOG: path.join(logs, "gamescope.log"),
    FAKE_GAME: path.join(bin, "fake-game.cjs"), FAKE_SEAT: path.join(bin, "fake-seat.cjs"), FAKE_SEAT_SOCKET_DIR: sockets,
    WAYLAND_DISPLAY: "wayland-selftest", DOTNET_ROLL_FORWARD: "Major", SPIRECTL_BRIDGE_SOCKET_PATH: "/must/be/stripped"
  };
  if (launchMode === "direct") env.FAKE_USER_DIR = path.join(options.instancesDir, "selftest", "user");
  if (noSeatEcho) env.FAKE_NO_SEAT_ECHO = "1";
  const bystander = spawnSleeper();
  const joins = [];
  const displayChecks = [];
  const messages = [];
  const exitCode = await runSession(options, parseRoute(readFileSync(route, "utf8"), { extraKinds: extensions?.kinds ?? {} }), {
    lease: { owner: "soak-selftest", pid: process.pid, resources: [] },
    extensions: extensions?.factory ?? null,
    log: message => messages.push(message),
    preflightFn: () => ({ problems: [], stub: true }),
    reassertLease: () => ({ stub: true }),
    rigDeps: {
      env,
      seatSocketFor: slot => path.join(sockets, `bridge-slot-${slot}.sock`),
      joinSeats: async (targets, evidence) => {
        joins.push(targets);
        evidence.screenshots.push("none");
        return [{ name: "Ann", ok: true, slot: 2, port: 13357, playerId: "p:1002", enetEvidence: [{ pattern: "handshake" }], logPath: null, screenshots: [], ms: 1 }];
      },
      closeBrowsers: async () => {},
      seatPages: () => [],
      portIsOpen: async () => true,
      verifyDisplay: input => { displayChecks.push(input); return { ok: true, problems: [], xServerPids: [] }; }
    }
  });
  const receipt = JSON.parse(readFileSync(path.join(runDir, "receipt.json"), "utf8"));
  const stream = readFileSync(path.join(runDir, "stream.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const calls = readLog(env.FAKE_STS2_LOG);
  return { exitCode, receipt, stream, calls, joins, displayChecks, messages, bystander, runDir, sockets, options };
}

function assertTornDown(session) {
  const owned = [
    ...(session.receipt.teardown.host ?? []), ...(session.receipt.teardown.seats ?? []), ...(session.receipt.teardown.compositor ?? [])
  ];
  assert.equal(session.receipt.teardown.clean, true, JSON.stringify(session.receipt.teardown));
  assert.ok(owned.length >= 4, `host, seat, compositor and its child were all accounted for: ${JSON.stringify(owned)}`);
  for (const entry of owned) {
    if (entry.pid) assert.equal(isSameProcess(entry), false, `owned ${entry.role} ${entry.pid} survived teardown`);
  }
  assert.ok(readIdentity(session.bystander.pid), "a process the session does not own survived its teardown");
  session.bystander.kill("SIGKILL");
}

test("a full game-free session (direct launch): bring-up, embark, a replicated route, checks, owned-only teardown", async () => {
  const pings = [];
  const session = await fullSession({
    routeSteps: [
      { kind: "mark", label: "embarked" },
      { kind: "dev-console", label: "fight", args: ["room", "MONSTER"], dwellSeconds: 0.6 },
      { kind: "ping", label: "glue", args: { n: 7 } },
      { kind: "wait", label: "settle", dwellSeconds: 0.6 },
      { kind: "dev-console", label: "fight-win", args: ["win"] },
      { kind: "mark", label: "route-end" }
    ],
    // A caller-registered step kind, the way a round's research glue adds its own.
    extensions: {
      kinds: { ping: { validate: args => { assert.equal(typeof args?.n, "number"); return { n: args.n }; } } },
      factory: async ({ rig }) => ({
        executors: { ping: async args => { pings.push({ ...args, hostPid: rig.host.pid }); return { ok: true }; } },
        finish: async () => ({ pings: pings.length })
      })
    }
  });
  const { exitCode, receipt, stream, calls, joins, displayChecks } = session;
  assert.equal(exitCode, 0, `${JSON.stringify(receipt.failure)}\n${session.messages.join("\n")}`);

  // receipt
  assert.equal(receipt.schema, RECEIPT_SCHEMA);
  assert.equal(receipt.routeResult.completed, true);
  assert.match(receipt.route.sha256, /^[0-9a-f]{64}$/);
  assert.equal(receipt.compositor.display, ":77");
  assert.equal(receipt.compositor.vulkanDevice, "Fake GPU 2060");
  assert.equal(receipt.embark.hostNetId, "1");
  assert.deepEqual(receipt.identity.modAssemblies.map(entry => entry.path), ["mods/couchcoop/CouchCoop.Mod.dll"]);
  assert.deepEqual(receipt.identity.modsChangedByLaunch, []);
  assert.ok(receipt.logs.find(log => log.label === "host-godot").loadingAssembly.length === 1);
  assert.ok(receipt.logs.find(log => log.label === "seat-slot-2-godot").patterns["Loading assembly"].count === 1);
  assert.equal(receipt.desync.ok, true);
  assert.deepEqual(receipt.desync.unreadable, []);
  assert.equal(receipt.endState.compare.ok, true, JSON.stringify(receipt.endState));
  assert.deepEqual(receipt.replicationLedger, [
    { line: "room MONSTER", peers: { "host-godot": 1, "seat-slot-2-godot": 1 } },
    { line: "win", peers: { "host-godot": 1, "seat-slot-2-godot": 1 } }
  ]);
  assert.ok(receipt.contamination.ticks >= 1, "foreign load was sampled during the route");
  assert.equal(receipt.seed.settingsSaves.length, 1);
  assert.deepEqual(receipt.extension, { pings: 1 });
  assert.equal(pings[0].n, 7);
  assert.equal(pings[0].hostPid, receipt.host.pid);

  // the host is the process that published the port, not the operator pid the seed copied in
  assert.equal(displayChecks.length, 1);
  assert.equal(displayChecks[0].display, ":77");
  assert.equal(displayChecks[0].gamePid, receipt.host.pid);
  assert.notEqual(receipt.host.pid, process.pid);
  assert.equal(joins[0].baseUrl, "http://127.0.0.1:45678");
  assert.deepEqual(joins[0].portBases, [45678, 13337]);
  assert.deepEqual(joins[0].viewport, { width: 915, height: 412 });

  // stream
  for (const line of stream) assert.deepEqual(streamRecordProblems(line), [], JSON.stringify(line));
  const phases = stream.filter(line => line.kind === "phase").map(line => line.phase);
  assert.deepEqual(phases, ["bring-up", "route", "post-route", "teardown", "done"]);
  const roles = new Set(stream.filter(line => line.kind === "proc").map(line => line.role));
  for (const role of ["host", "seat-2", "compositor", "compositor-child", "harness"]) assert.ok(roles.has(role), `no ${role} samples: ${[...roles]}`);
  const fightPhases = stream.filter(line => line.kind === "route" && line.label === "fight").map(line => line.event);
  assert.deepEqual(fightPhases, ["start", "acted", "end"]);
  const replication = stream.filter(line => line.kind === "check" && line.check === "replication");
  assert.equal(replication.length, 2);
  assert.ok(replication.every(line => line.ok && line.hostProof.enqueued));
  const seatEcho = replication[0].peers.find(peer => peer.peer === "seat-2");
  assert.ok(seatEcho.afterIssueMs >= 150 && seatEcho.delayFromHostMs >= 100, `the seat's delayed echo was measured: ${JSON.stringify(seatEcho)}`);
  assert.ok(stream.some(line => line.kind === "check" && line.check === "end-state" && line.ok));
  assert.ok(stream.some(line => line.kind === "check" && line.check === "desync" && line.ok));

  // what was sent, and how
  const act = calls.filter(call => call.argv.includes("act"));
  assert.deepEqual([...new Set(act.map(call => call.argv[call.argv.indexOf("act") + 1]))], ["ready"], "embark is the only semantic action");
  const hostReady = act.find(call => call.argv.includes("p:1"));
  const seatReady = act.find(call => call.argv.includes("p:1002"));
  const hostConfig = path.join(session.runDir, "sts2.selftest.yaml");
  const seatConfig = path.join(session.runDir, "sts2.seats.yaml");
  const bridgeSocket = path.join(session.runDir, "host-bridge.sock");
  // A direct launch: the host is reached through the scratch config's transport, never through an instance name.
  assert.deepEqual(hostReady.argv.slice(0, 2), ["--config", hostConfig]);
  assert.ok(!hostReady.argv.includes("--instance") && hostReady.env.SPIRECTL_BRIDGE_SOCKET_PATH === null);
  assert.ok(readFileSync(hostConfig, "utf8").includes(`ipcPath: ${JSON.stringify(bridgeSocket)}`), "the host config points the CLI at the owned socket");
  assert.ok(!/transport:/.test(readFileSync(seatConfig, "utf8")), "the seat config leaves the socket to the environment");
  assert.equal(seatReady.env.SPIRECTL_BRIDGE_SOCKET_PATH, path.join(session.sockets, "bridge-slot-2.sock"));
  assert.deepEqual(seatReady.argv.slice(0, 2), ["--config", seatConfig]);
  const consoleCalls = calls.filter(call => call.argv.includes("console"));
  assert.deepEqual(consoleCalls.map(call => call.argv.slice(call.argv.indexOf("console") + 1)), [["room", "MONSTER"], ["win"]]);
  assert.ok(consoleCalls.every(call => call.argv[1] === hostConfig && !call.argv.includes("--instance")));
  assert.ok(calls.every(call => call.cwd === session.runDir), "one scratch cwd for every call");
  assert.ok(calls.every(call => !call.argv.includes("--mode")), "normal mode throughout");
  assert.ok(!calls.some(call => call.argv.includes("launch") || call.argv.includes("mods")), "a direct launch never asks the CLI to launch or seed");

  // what the directly launched game was handed
  const launch = JSON.parse(readFileSync(path.join(session.runDir, "launch.json"), "utf8"));
  assert.equal(launch.mode, "direct");
  assert.equal(launch.env.DISPLAY, ":77");
  assert.equal(launch.env.SPIRECTL_BRIDGE_SOCKET_PATH, bridgeSocket, "the inherited socket path was replaced");
  assert.equal(launch.env.SPIRECTL_BRIDGE_DISABLE_BACKGROUND_THROTTLE, "1");
  assert.equal(launch.env.COUCHCOOP_SELFTEST_MARK, "1", "--env reaches the game");
  assert.equal(launch.env.XDG_DATA_HOME, path.join(session.options.instancesDir, "selftest", "user"));
  assert.equal(launch.env.DOTNET_ROLL_FORWARD, undefined, "no inherited .NET switches");
  assert.ok(!launch.envKeys.includes("WAYLAND_DISPLAY"), "no desktop route");
  assert.equal(existsSync(bridgeSocket), false, "the owned socket file is removed at teardown");
  assertTornDown(session);
});

test("a console step that a seat never echoes fails the route, and teardown still runs (CLI launch)", async () => {
  const session = await fullSession({ noSeatEcho: true, launchMode: "cli", routeSteps: [
    { kind: "dev-console", label: "fight", args: ["room", "MONSTER"], dwellSeconds: 30 },
    { kind: "mark", label: "never" }
  ] });
  assert.equal(session.exitCode, 1);
  assert.equal(session.receipt.failure.code, "route");
  assert.equal(session.receipt.routeResult.failedStep.label, "fight");
  assert.match(session.receipt.routeResult.failedStep.error, /no echo from seat-2/);
  const replication = session.stream.find(line => line.kind === "check" && line.check === "replication");
  assert.deepEqual(replication.missing, ["seat-2"]);
  assert.ok(!session.stream.some(line => line.kind === "mark" && line.label === "never"));
  assert.deepEqual(session.receipt.replicationLedger, [{ line: "room MONSTER", peers: { "host-godot": 1, "seat-slot-2-godot": 0 } }]);
  assertTornDown(session);
});

// =================================================================================================
// the seat-join path this harness borrows
// =================================================================================================

test("probe-five-player-run.mjs still exports the seat-join path the rig drives", async () => {
  const five = await import("./probe-five-player-run.mjs");
  for (const name of ["joinSeats", "closeBrowsers", "seatPages", "checkSeatRecords", "seatBridgeSocketFor", "seatLogPathFor"]) {
    assert.equal(typeof five[name], "function", `probe-five-player-run.mjs no longer exports ${name}`);
  }
  assert.deepEqual(five.seatPages(), []);
  const source = readFileSync(path.join(REPO_ROOT, "scripts", "probe-five-player-run.mjs"), "utf8");
  assert.match(source, /viewport: targets\.viewport \?\? \{ width: 960, height: 600 \}/, "joinSeats honours a caller's viewport");
  const plain = createSts2({ bin: "sts2", configPath: "/c.yaml", instance: "i", cwd: "/r" });
  assert.deepEqual(plain.hostArgv(["state"]), ["--config", "/c.yaml", "--instance", "i", "--json", "state"]);
  assert.deepEqual(plain.socketArgv(["state"]), ["--config", "/c.yaml", "--json", "state"]);
});

// =================================================================================================

let failures = 0;
try {
  for (const { name, body } of cases) {
    try {
      await body();
      console.log(`  ok  ${name}`);
    } catch (error) {
      failures += 1;
      console.log(`FAIL  ${name}`);
      console.log(`      ${String(error?.stack ?? error?.message).split("\n").join("\n      ")}`);
    }
  }
} finally {
  for (const pid of spawned) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exitCode = failures === 0 ? 0 : 1;
