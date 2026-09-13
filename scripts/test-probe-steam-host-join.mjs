#!/usr/bin/env node
//
// Self-test for scripts/probe-steam-host-join.mjs -- everything in that probe that does NOT need a
// running game. Plain `node scripts/test-probe-steam-host-join.mjs`: no test runner, no game, no
// network, no live lock.
//
// Covered: argument parsing (including --help and --dry-run), target resolution and its precedence
// chain, the live-QA resource set, the -fastmp preflight, the host-transport log parser and the branch
// verdict across all five outcomes, the build-conditional handshake decision, the seat handshake
// grader, the roster grader, the flat-tree menu-step matcher, result.json assembly, and the wiring
// checks (the probe parses, --help and --dry-run run to completion as real processes, the scenario
// parses the same way the committed ones do, and its hook resolves to a command that exists).
//
// Log fixtures are SYNTHESIZED from the format strings in the code that emits them. The one exception
// is documented inline: the two seat-log lines whose exact shape was read off a captured live log.
//
// The tests that matter most here are the leg-2 ones. A gate that silently degrades to ENet is worse
// than no gate, so every not-Steam outcome has a case proving it comes back RED with its own name --
// including the two that look like success from a distance (`source=host-start` with a Steam failure
// underneath it, and a Steam lobby whose hostNetId is the ENet wire's 1).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RESULT_SCHEMA, SCREEN_MAIN_MENU, ENET_WIRE_HOST_NET_ID, BUILDS_WITHOUT_HANDSHAKE, MENU_ROUTE,
  HANDSHAKE_REFUSED_TEXT, USAGE,
  ProbeUsageError,
  parseProbeArgs, resolveTargets, lockResourcesFor,
  gradeLaunchArgs, parseProcCmdline,
  parseHostTransportLog, gradeHostBranch,
  resolveHandshakeMode, gradeSeatHandshake,
  gradeRoster, findMenuCandidates, findNodesOfType,
  buildResult
} from "./probe-steam-host-join.mjs";
import { DEFAULT_HOST_PORT } from "./probe-five-player-run.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cases = [];
const test = (name, body) => cases.push({ name, body });

// =================================================================================================
// argument parsing
// =================================================================================================

test("parseProbeArgs defaults to a single seat against the compiled host port", () => {
  const args = parseProbeArgs([]);
  assert.equal(args.base, null);
  assert.equal(args.handshake, "auto");
  assert.equal(args.handshakeSender, null);
  assert.equal(args.help, false);
  assert.equal(args.dryRun, false);
  assert.ok(args.menuTimeoutMs > 0 && args.lobbyTimeoutMs > 0 && args.seatTimeoutMs > 0);
});

test("parseProbeArgs reads every flag", () => {
  const args = parseProbeArgs([
    "--base", "http://10.0.0.5:13400",
    "--out", "/tmp/out",
    "--instance", "beta",
    "--user-dir", "/tmp/xdg",
    "--host-stderr", "/tmp/host.stderr.log",
    "--host-stdout", "/tmp/host.stdout.log",
    "--host-pid", "4242",
    "--handshake", "require",
    "--handshake-sender", "76561198072573591",
    "--menu-timeout-ms", "1000",
    "--lobby-timeout-ms", "2000",
    "--seat-timeout-ms", "3000"
  ]);
  assert.equal(args.base, "http://10.0.0.5:13400");
  assert.equal(args.instance, "beta");
  assert.equal(args.hostPid, 4242);
  assert.equal(args.handshake, "require");
  assert.equal(args.handshakeSender, "76561198072573591");
  assert.equal(args.menuTimeoutMs, 1000);
  assert.equal(args.lobbyTimeoutMs, 2000);
  assert.equal(args.seatTimeoutMs, 3000);
});

test("parseProbeArgs takes --help and --dry-run as booleans anywhere", () => {
  assert.equal(parseProbeArgs(["--help"]).help, true);
  assert.equal(parseProbeArgs(["-h"]).help, true);
  assert.equal(parseProbeArgs(["--dry-run"]).dryRun, true);
  const both = parseProbeArgs(["--base", "http://x:1", "--dry-run"]);
  assert.equal(both.dryRun, true);
  assert.equal(both.base, "http://x:1");
});

test("parseProbeArgs rejects bad usage instead of guessing", () => {
  assert.throws(() => parseProbeArgs(["--nope"]), ProbeUsageError);
  assert.throws(() => parseProbeArgs(["--base"]), /requires a value/);
  // A flag where a value belongs is a typo, not a value -- including a boolean one.
  assert.throws(() => parseProbeArgs(["--base", "--out"]), /requires a value/);
  assert.throws(() => parseProbeArgs(["--base", "--dry-run"]), /requires a value/);
  assert.throws(() => parseProbeArgs(["--handshake", "maybe"]), /must be one of auto\|require\|skip/);
  assert.throws(() => parseProbeArgs(["--handshake-sender", "steam:1"]), /decimal net id/);
  assert.throws(() => parseProbeArgs(["--host-pid", "0"]), /positive integer/);
  assert.throws(() => parseProbeArgs(["--menu-timeout-ms", "-1"]), /positive integer/);
});

// =================================================================================================
// target resolution
// =================================================================================================

test("resolveTargets falls back to the defaults with no flags and no env", () => {
  const targets = resolveTargets({
    args: parseProbeArgs([]),
    env: {},
    home: "/home/qa",
    repoRoot: "/repo",
    primaryRepoRoot: "/primary"
  });
  assert.equal(targets.seats, 1, "one seat is the whole point: this gates the transport, not the count");
  assert.equal(targets.seatConcurrency, 1);
  assert.equal(targets.baseUrl, `http://127.0.0.1:${DEFAULT_HOST_PORT}`);
  assert.equal(targets.browserPort, DEFAULT_HOST_PORT);
  assert.equal(targets.userDir, "/home/qa/.local/share");
  assert.equal(targets.outDir, "/repo/.sts2/artifacts/steam-host-join");
  // A worktree's own .sts2/ is empty, so the host stdio fallback must name the primary checkout.
  assert.equal(targets.hostStderrPath, "/primary/.sts2/artifacts/game-launch/game.stderr.log");
  assert.equal(targets.hostStdoutPath, "/primary/.sts2/artifacts/game-launch/game.stdout.log");
  assert.deepEqual(targets.portBases, [DEFAULT_HOST_PORT]);
});

test("resolveTargets lets a flag beat the env, and records where each value came from", () => {
  const targets = resolveTargets({
    args: parseProbeArgs(["--base", "http://127.0.0.1:14000", "--out", "/tmp/elsewhere"]),
    env: { COUCHCOOP_GAME_ORIGIN: "http://127.0.0.1:19999", XDG_DATA_HOME: "/env/share", SPIRECTL_INSTANCE: "beta" },
    home: "/home/qa"
  });
  assert.equal(targets.baseUrl, "http://127.0.0.1:14000");
  assert.equal(targets.browserPort, 14000);
  assert.equal(targets.outDir, "/tmp/elsewhere");
  assert.equal(targets.userDir, "/env/share");
  assert.equal(targets.instance, "beta");
  assert.equal(targets.sources.baseUrl, "cli");
  assert.equal(targets.sources.userDir, "env");
  // Seats are launched from the COMPILED base even when the host port-walked, so both must resolve.
  assert.deepEqual(targets.portBases, [14000, DEFAULT_HOST_PORT]);
});

test('resolveTargets treats the instance name "default" as no --instance at all', () => {
  const targets = resolveTargets({ args: parseProbeArgs(["--instance", "default"]), env: {}, home: "/home/qa" });
  assert.equal(targets.instance, null);
});

test("lockResourcesFor claims the install, the game, the host port and the one seat port", () => {
  const targets = resolveTargets({ args: parseProbeArgs(["--instance", "beta"]), env: {}, home: "/home/qa" });
  assert.deepEqual(lockResourcesFor(targets), [
    "shared:install",
    "exclusive:game:beta",
    `exclusive:browser:${DEFAULT_HOST_PORT}`,
    "exclusive:port:13357"
  ]);
});

// =================================================================================================
// leg 0 -- the -fastmp preflight
// =================================================================================================

test("gradeLaunchArgs refuses a -fastmp host, because the Steam branch is then unreachable", () => {
  const verdict = gradeLaunchArgs(["/opt/game/SlayTheSpire2", "--", "-fastmp", "host_standard"]);
  assert.equal(verdict.verdict, "fastmp");
  assert.equal(verdict.fastmp, "-fastmp");
  assert.match(verdict.detail, /UNREACHABLE/);
  assert.match(verdict.detail, /Relaunch the host without it/);
});

test("gradeLaunchArgs passes a plain launch and stays honest about an unreadable one", () => {
  assert.equal(gradeLaunchArgs(["/opt/game/SlayTheSpire2", "--prerender-spines"]).verdict, "clean");
  for (const nothing of [null, undefined, [], "not an array"]) {
    const verdict = gradeLaunchArgs(nothing);
    assert.equal(verdict.verdict, "unknown", `${String(nothing)} should be unknown, not a pass`);
    assert.equal(verdict.fastmp, null);
  }
});

test("gradeLaunchArgs matches the flag itself, not any argument mentioning it", () => {
  // The value `host_standard` and a path that merely contains the word must not trip the gate; the
  // flag in either spelling must.
  assert.equal(gradeLaunchArgs(["host_standard", "/tmp/fastmpnotes.txt"]).verdict, "clean");
  assert.equal(gradeLaunchArgs(["--fastmp=join"]).verdict, "fastmp");
  assert.equal(gradeLaunchArgs([" -fastmp "]).verdict, "fastmp", "argv tokens can carry stray whitespace");
});

test("parseProcCmdline splits the NUL-delimited argv and drops the trailing NUL", () => {
  assert.deepEqual(parseProcCmdline("/opt/game/SlayTheSpire2\0--headless\0"), ["/opt/game/SlayTheSpire2", "--headless"]);
  assert.deepEqual(parseProcCmdline(""), []);
  assert.deepEqual(parseProcCmdline(null), []);
});

// =================================================================================================
// leg 2 -- the host-transport parser and THE ANTI-DEGRADATION VERDICT
// =================================================================================================

// Synthesized from the format strings in src/CouchCoop.Mod/Session/CouchCoopHostTransport.cs
// (`LogEffectiveCapacity` and the `steam host started` line). Both go to stderr with no level prefix.
const STEAM_LOG = [
  "[couch-coop] browser server listening on 13337",
  "[couch-coop] host-transport effective maxClients=8 (requested=8, source=host-start)",
  "[couch-coop] host-transport steam host started lobby=109775241058315825 hostNetId=76561198072573591 couchSeats=ENet:33771.",
  ""
].join("\n");

const ENET_LOG = [
  "[couch-coop] browser server listening on 13337",
  "[couch-coop] host-transport effective maxClients=4 (requested=4, source=stock-enet)",
  ""
].join("\n");

const STEAM_OFFLINE_LOG = [
  "[couch-coop] host-transport effective maxClients=8 (requested=8, source=host-start)",
  "[couch-coop] host-transport steam host failed (k_EResultNoConnection) — falling back to a couch/LAN-only ENet host on port 33771. Remote Steam friends cannot join this session.",
  ""
].join("\n");

test("parseHostTransportLog reads the capacity and the steam-start lines with their line numbers", () => {
  const parsed = parseHostTransportLog(STEAM_LOG);
  assert.equal(parsed.scannedLines, 3, "a trailing newline is not a line");
  assert.deepEqual(parsed.capacity, [{ effective: 8, requested: 8, source: "host-start", lineNumber: 2 }]);
  assert.equal(parsed.steamStarted.hostNetId, "76561198072573591");
  assert.equal(parsed.steamStarted.lobbyId, "109775241058315825");
  assert.equal(parsed.steamStarted.couchSeats, "ENet:33771", "the sentence's trailing period is not part of the value");
  assert.deepEqual(parsed.fallbacks, []);
});

// The host process outlives a single host start. Without the baseline, a PREVIOUS Steam host in the
// same process answers the question instead of the one the probe just drove -- which is exactly how a
// gate goes green about a run it never observed.
test("parseHostTransportLog reads only past the baseline line", () => {
  const combined = `${ENET_LOG}${STEAM_LOG}`;
  const wholeFile = parseHostTransportLog(combined);
  assert.equal(wholeFile.capacity.length, 2, "the whole file has both host starts in it");

  const thisStart = parseHostTransportLog(combined, { sinceLine: 2 });
  assert.deepEqual(thisStart.capacity.map(entry => entry.source), ["host-start"]);
  assert.ok(thisStart.steamStarted);

  const earlierStart = parseHostTransportLog(combined, { sinceLine: 0 });
  assert.deepEqual(earlierStart.capacity.map(entry => entry.source), ["stock-enet", "host-start"]);

  // ...and a baseline past everything finds nothing at all, rather than quietly reusing old lines.
  const afterEverything = parseHostTransportLog(combined, { sinceLine: 999 });
  assert.deepEqual(afterEverything.capacity, []);
  assert.equal(afterEverything.steamStarted, null);
});

test("gradeHostBranch passes ONLY a real Steam lobby with a couch ENet side", () => {
  const verdict = gradeHostBranch(parseHostTransportLog(STEAM_LOG));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.branch, "steam");
  assert.equal(verdict.hostNetId, "76561198072573591");
  assert.equal(verdict.couchSeats, "ENet:33771");
  assert.deepEqual(verdict.problems, []);
});

test("gradeHostBranch REFUSES the ENet branch by name", () => {
  const verdict = gradeHostBranch(parseHostTransportLog(ENET_LOG));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.branch, "stock-enet");
  assert.match(verdict.problems.join(" "), /took the ENet branch \(source=stock-enet\)/);
  assert.match(verdict.problems.join(" "), /fixture lobby ALWAYS takes the ENet branch/);
});

// Not the same case, and it must not borrow the other one's wording: nothing said "stock-enet" here,
// so "the host took the ENet branch" would be a claim the log does not support.
test("gradeHostBranch tells a silent host start apart from an ENet one", () => {
  const verdict = gradeHostBranch(parseHostTransportLog([
    "[couch-coop] host-transport steam host threw (InvalidOperationException: Steam is not initialized)",
    ""
  ].join("\n")));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.branch, "unknown");
  assert.match(verdict.problems.join(" "), /no `source=host-start` capacity line was logged/);
});

// The dangerous near-miss: the Steam prefix DID run, so `source=host-start` is present, and the host is
// nonetheless an ENet listener at net id 1. Grading on the capacity source alone would pass this.
test("gradeHostBranch REFUSES a Steam start that fell back to ENet", () => {
  const verdict = gradeHostBranch(parseHostTransportLog(STEAM_OFFLINE_LOG));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.branch, "steam-fallback-enet");
  assert.match(verdict.problems.join(" "), /fell back to a couch\/LAN-only ENet host/);
  assert.match(verdict.problems.join(" "), /k_EResultNoConnection/, "the game's own reason is quoted back");
});

test("gradeHostBranch REFUSES a Steam start that never produced a lobby", () => {
  const verdict = gradeHostBranch(parseHostTransportLog([
    "[couch-coop] host-transport effective maxClients=8 (requested=8, source=host-start)",
    ""
  ].join("\n")));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.branch, "host-start-incomplete");
  assert.match(verdict.problems.join(" "), /never logged `steam host started/);
});

// The second near-miss: a Steam lobby whose host answers to net id 1 exercises none of the identity
// handling -- HostNetIdPatch is inert there, which is the whole reason the ENet coverage missed this.
test("gradeHostBranch REFUSES a Steam lobby hosting as the ENet wire id", () => {
  const verdict = gradeHostBranch(parseHostTransportLog([
    "[couch-coop] host-transport effective maxClients=4 (requested=4, source=host-start)",
    `[couch-coop] host-transport steam host started lobby=1 hostNetId=${ENET_WIRE_HOST_NET_ID} couchSeats=ENet:33771.`,
    ""
  ].join("\n")));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.branch, "steam-degraded");
  assert.match(verdict.problems.join(" "), /HostNetIdPatch` does nothing at that value/);
});

test("gradeHostBranch REFUSES a Steam lobby with no couch ENet side, and says why no seat could join", () => {
  const verdict = gradeHostBranch(parseHostTransportLog([
    "[couch-coop] host-transport effective maxClients=4 (requested=4, source=host-start)",
    "[couch-coop] host-transport steam host started lobby=109775241058315825 hostNetId=76561198072573591 couchSeats=unavailable.",
    ""
  ].join("\n")));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.branch, "steam-degraded");
  assert.match(verdict.problems.join(" "), /no browser seat can join it at all/);
});

// A silent log and a healthy one must not look the same. This is the "we scanned the wrong file" case.
test("gradeHostBranch REFUSES a log with no host-transport line at all, and names the likely cause", () => {
  const verdict = gradeHostBranch(parseHostTransportLog("boot\nnothing here\n"));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.branch, "unknown");
  assert.match(verdict.problems.join(" "), /logged NO `\[couch-coop\] host-transport` line/);
  assert.match(verdict.problems.join(" "), /a worktree's own \.sts2\/ is empty/);
});

// =================================================================================================
// leg 5 -- the build-conditional handshake
// =================================================================================================

test("resolveHandshakeMode skips the build that has no handshake step", () => {
  assert.deepEqual(BUILDS_WITHOUT_HANDSHAKE, ["v0.107.1"]);
  const stable = resolveHandshakeMode("v0.107.1");
  assert.equal(stable.mode, "skip");
  assert.match(stable.reason, /no transport version handshake/);
});

test("resolveHandshakeMode requires the handshake on the beta, and on any build it has never seen", () => {
  assert.equal(resolveHandshakeMode("v0.111.0").mode, "require");
  // The fail-loud default: a new build is assumed to have the step. A red leg is a question; a green
  // one on a build that grew a new protocol step is the bug this probe exists for.
  assert.equal(resolveHandshakeMode("v0.999.0").mode, "require");
  const unknown = resolveHandshakeMode(null);
  assert.equal(unknown.mode, "require");
  assert.match(unknown.reason, /a false green is the bug this probe exists for/);
});

test("resolveHandshakeMode lets the operator override in both directions", () => {
  assert.equal(resolveHandshakeMode("v0.107.1", "require").mode, "require");
  assert.equal(resolveHandshakeMode("v0.111.0", "skip").mode, "skip");
});

// The two lines below are the shapes read off a real seat godot.log: `[LEVEL] [Context] message`.
const HOST_NET_ID = "76561198072573591";
const acceptedLine = sender => `[INFO] [HandshakeManager] Got handshake from sender ${sender}. Version: 0.111.0 Branch: public-beta Hash: 123`;
const refusedLine = sender => `[WARN] Received handshake message for ${sender} who is ${HANDSHAKE_REFUSED_TEXT}!`;

test("gradeSeatHandshake passes a seat that accepted a handshake from the host", () => {
  const verdict = gradeSeatHandshake([
    "[INFO] [ENetClient] Sending handshake with net ID 1002",
    acceptedLine(HOST_NET_ID),
    "[INFO] [NetMessageBus] Received message ClientLobbyJoinResponseMessage Players: 2 Ascension: 0, sending to 1 handlers",
    ""
  ].join("\n"), { expectedSenders: [HOST_NET_ID, ENET_WIRE_HOST_NET_ID], mode: "require" });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.verdict, "pass");
  assert.deepEqual(verdict.senders, [HOST_NET_ID]);
  assert.deepEqual(verdict.refused, []);
});

// Deliberate, documented looseness: which of the two ids the seat prints depends on where the
// transport's sender mapping lives, and BOTH are a working handshake. A third id is not.
test("gradeSeatHandshake accepts either documented sender and refuses a third", () => {
  const wire = gradeSeatHandshake(`${acceptedLine(ENET_WIRE_HOST_NET_ID)}\n`, {
    expectedSenders: [HOST_NET_ID, ENET_WIRE_HOST_NET_ID], mode: "require"
  });
  assert.equal(wire.ok, true);
  assert.deepEqual(wire.senders, [ENET_WIRE_HOST_NET_ID]);

  const stranger = gradeSeatHandshake(`${acceptedLine("424242")}\n`, {
    expectedSenders: [HOST_NET_ID, ENET_WIRE_HOST_NET_ID], mode: "require"
  });
  assert.equal(stranger.ok, false);
  assert.match(stranger.problems.join(" "), /neither the host's net id nor the ENet wire host id/);

  // --handshake-sender pins it exactly once the answer is settled.
  const pinned = gradeSeatHandshake(`${acceptedLine(ENET_WIRE_HOST_NET_ID)}\n`, {
    expectedSenders: [HOST_NET_ID], mode: "require"
  });
  assert.equal(pinned.ok, false);
});

// The looseness above must not be silent. On a Steam-hosted session the host's own net id is the
// expected sender, so the other accepted value gets said out loud -- as a note, not a verdict.
test("gradeSeatHandshake notes, without failing, a handshake from the non-preferred sender", () => {
  const other = gradeSeatHandshake(`${acceptedLine(ENET_WIRE_HOST_NET_ID)}\n`, {
    expectedSenders: [HOST_NET_ID, ENET_WIRE_HOST_NET_ID], preferredSender: HOST_NET_ID, mode: "require"
  });
  assert.equal(other.ok, true);
  assert.equal(other.notes.length, 1, JSON.stringify(other.notes));
  assert.match(other.notes[0], /rather than the host's own net id/);
  assert.match(other.notes[0], /--handshake-sender/);

  const expected = gradeSeatHandshake(`${acceptedLine(HOST_NET_ID)}\n`, {
    expectedSenders: [HOST_NET_ID, ENET_WIRE_HOST_NET_ID], preferredSender: HOST_NET_ID, mode: "require"
  });
  assert.deepEqual(expected.notes, [], "the expected sender is not worth a note");

  // No accepted line at all is a PROBLEM, not a note -- the note must not paper over the failure.
  const silent = gradeSeatHandshake("nothing\n", {
    expectedSenders: [HOST_NET_ID], preferredSender: HOST_NET_ID, mode: "require"
  });
  assert.equal(silent.ok, false);
  assert.deepEqual(silent.notes, []);
});

// THE DEFECT SIGNATURE. This is what the v0.111.0 break looked like in a seat log.
test("gradeSeatHandshake fails the refused-handshake line in EVERY mode, including skip", () => {
  const log = [
    "[INFO] [ENetClient] Sending handshake with net ID 1002",
    refusedLine("1"),
    ""
  ].join("\n");
  for (const mode of ["require", "skip"]) {
    const verdict = gradeSeatHandshake(log, { expectedSenders: [HOST_NET_ID], mode });
    assert.equal(verdict.ok, false, `mode ${mode} must not swallow the defect signature`);
    assert.equal(verdict.refused.length, 1);
    assert.match(verdict.problems.join(" "), /registering its handshake under an id the transport never delivers/);
  }
});

test("gradeSeatHandshake fails a require-mode seat that never completed a handshake", () => {
  const verdict = gradeSeatHandshake("[INFO] [ENetClient] Sending handshake with net ID 1002\n", {
    expectedSenders: [HOST_NET_ID], mode: "require"
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join(" "), /never completed on this seat/);
  assert.match(verdict.problems.join(" "), /do not delete the leg/);
});

test("gradeSeatHandshake in skip mode reports a quiet log as skipped, not as a pass", () => {
  const verdict = gradeSeatHandshake("[INFO] [ENetClient] Sending handshake with net ID 1002\n", {
    expectedSenders: [HOST_NET_ID], mode: "skip"
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.verdict, "skipped");
  assert.deepEqual(verdict.senders, []);
});

// =================================================================================================
// leg 4 -- the roster
// =================================================================================================

const steamLobby = (overrides = {}) => ({
  netGameType: "host",
  hostPlayerId: `p:${HOST_NET_ID}`,
  connectingPlayerCount: 0,
  maxPlayers: 4,
  players: [
    { id: `p:${HOST_NET_ID}`, isConnected: true },
    // A live Steam-hosted lobby that went on to start a run reported isConnected:false for its couch
    // seats. The grader must pass this, or the gate is red on a healthy session.
    { id: "p:1002", isConnected: false }
  ],
  ...overrides
});

test("gradeRoster passes a seat that is a member, even with isConnected false", () => {
  const verdict = gradeRoster(steamLobby(), { seatPlayerId: "p:1002" });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.problems));
  assert.deepEqual(verdict.playerIds, [`p:${HOST_NET_ID}`, "p:1002"]);
  assert.deepEqual(verdict.isConnectedReported, [
    { id: `p:${HOST_NET_ID}`, isConnected: true },
    { id: "p:1002", isConnected: false }
  ], "isConnected is recorded as evidence, and asserted on by nothing");
});

test("gradeRoster fails an absent seat, a mid-join lobby and a lobby that is not hosting", () => {
  const absent = gradeRoster(steamLobby({ players: [{ id: `p:${HOST_NET_ID}` }] }), { seatPlayerId: "p:1002" });
  assert.equal(absent.ok, false);
  assert.match(absent.problems.join(" "), /p:1002 is not in lobby\.players/);

  const connecting = gradeRoster(steamLobby({ connectingPlayerCount: 1 }), { seatPlayerId: "p:1002" });
  assert.equal(connecting.ok, false);
  assert.match(connecting.problems.join(" "), /still mid-join has not joined/);

  const joined = gradeRoster(steamLobby({ netGameType: "join" }), { seatPlayerId: "p:1002" });
  assert.equal(joined.ok, false);
  assert.match(joined.problems.join(" "), /netGameType/);

  const nameless = gradeRoster(steamLobby(), { seatPlayerId: null });
  assert.equal(nameless.ok, false);
  assert.match(nameless.problems.join(" "), /never resolved a player id/);

  // A missing connectingPlayerCount is not a zero.
  const silent = gradeRoster(steamLobby({ connectingPlayerCount: undefined }), { seatPlayerId: "p:1002" });
  assert.equal(silent.ok, false);
});

// =================================================================================================
// leg 1 -- the flat-tree menu matcher
// =================================================================================================

const N = "MegaCrit.Sts2.Core.Nodes.Screens.MainMenu";
const menuTree = {
  screen: { id: SCREEN_MAIN_MENU },
  nodes: [
    { name: "MultiplayerButton", nodePath: "/root/Main/MainMenu/MainMenuTextButtons/MultiplayerButton", nodeType: `${N}.NMainMenuTextButton` },
    { name: "SingleplayerButton", nodePath: "/root/Main/MainMenu/MainMenuTextButtons/SingleplayerButton", nodeType: `${N}.NMainMenuTextButton` },
    { name: "Submenus", nodePath: "/root/Main/MainMenu/Submenus", nodeType: `${N}.NMainMenuSubmenuStack` },
    { name: "MultiplayerSubmenu", nodePath: "/root/Main/MainMenu/Submenus/MultiplayerSubmenu", nodeType: `${N}.NMultiplayerSubmenu` },
    { name: "HostButton", nodePath: "/root/Main/MainMenu/Submenus/MultiplayerSubmenu/ButtonContainer/HostButton", nodeType: `${N}.NSubmenuButton` },
    { name: "HostButton", nodePath: "/root/Main/MainMenu/Submenus/SingleplayerSubmenu/ButtonContainer/HostButton", nodeType: `${N}.NSubmenuButton` }
  ]
};

test("MENU_ROUTE is the three clicks, scoped to the submenu each one opens", () => {
  assert.deepEqual(MENU_ROUTE.map(step => step.id), ["multiplayer", "host", "standard"]);
  assert.deepEqual(MENU_ROUTE.map(step => step.name), ["MultiplayerButton", "HostButton", "StandardButton"]);
  assert.equal(MENU_ROUTE[0].scopeType, null);
  assert.equal(MENU_ROUTE[1].scopeType, "NMultiplayerSubmenu");
  assert.equal(MENU_ROUTE[2].scopeType, "NMultiplayerHostSubmenu");
  assert.equal(MENU_ROUTE.at(-1).opensType, null, "the last click opens a lobby, not a submenu");
});

test("findMenuCandidates matches on name and type tail over the FLAT node list", () => {
  const found = findMenuCandidates(menuTree, { name: "MultiplayerButton", nodeType: "NMainMenuTextButton" });
  assert.equal(found.length, 1);
  assert.equal(found[0].nodePath, "/root/Main/MainMenu/MainMenuTextButtons/MultiplayerButton");
  // The type tail must be a whole segment: a button class that merely ENDS with the name is not it.
  assert.deepEqual(findMenuCandidates(menuTree, { name: "MultiplayerButton", nodeType: "MainMenuTextButton" }), []);
  assert.deepEqual(findMenuCandidates(menuTree, { name: "NopeButton", nodeType: "NSubmenuButton" }), []);
});

// Two submenus can each own a node of the same name. Scoping to the one the previous click opened is
// what stops the probe clicking a button on a screen it is not on.
test("findMenuCandidates scopes to the submenu the previous step opened", () => {
  const unscoped = findMenuCandidates(menuTree, { name: "HostButton", nodeType: "NSubmenuButton" });
  assert.equal(unscoped.length, 2, "unscoped, this name is genuinely ambiguous");

  const scoped = findMenuCandidates(menuTree, {
    name: "HostButton",
    nodeType: "NSubmenuButton",
    scopePath: "/root/Main/MainMenu/Submenus/MultiplayerSubmenu"
  });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].nodePath, "/root/Main/MainMenu/Submenus/MultiplayerSubmenu/ButtonContainer/HostButton");

  // The scope is a path PREFIX with a separator, so a sibling whose path merely starts with the same
  // characters cannot slip through.
  assert.deepEqual(findMenuCandidates(menuTree, {
    name: "HostButton", nodeType: "NSubmenuButton", scopePath: "/root/Main/MainMenu/Submenus/Multiplayer"
  }), []);
});

test("findNodesOfType finds a submenu by its managed type", () => {
  const found = findNodesOfType(menuTree, "NMultiplayerSubmenu");
  assert.equal(found.length, 1);
  assert.equal(found[0].nodePath, "/root/Main/MainMenu/Submenus/MultiplayerSubmenu");
  assert.deepEqual(findNodesOfType(menuTree, "NMultiplayerHostSubmenu"), []);
  assert.deepEqual(findNodesOfType({ nodes: [] }, "NMultiplayerSubmenu"), []);
});

// =================================================================================================
// result assembly
// =================================================================================================

const targetsFixture = () => resolveTargets({ args: parseProbeArgs([]), env: {}, home: "/home/qa", repoRoot: "/repo", primaryRepoRoot: "/primary" });

test("buildResult reports ok with every leg passing, and carries the build and branch at the top", () => {
  const result = buildResult({
    legs: [
      { n: 0, name: "preflight", verdict: "pass" },
      { n: 2, name: "steam-branch", verdict: "pass" },
      { n: 5, name: "handshake", verdict: "skipped" }
    ],
    targets: targetsFixture(),
    args: parseProbeArgs([]),
    startedAt: "a",
    finishedAt: "b",
    evidence: { gameVersion: "v0.111.0", hostBranch: { branch: "steam", hostNetId: HOST_NET_ID } }
  });
  assert.equal(result.schema, RESULT_SCHEMA);
  assert.equal(result.ok, true);
  assert.equal(result.failingLeg, null);
  assert.equal(result.gameVersion, "v0.111.0");
  assert.equal(result.hostBranch.branch, "steam");
});

test("buildResult names the FIRST failing leg and is not ok after an abort", () => {
  const failed = buildResult({
    legs: [
      { n: 0, name: "preflight", verdict: "pass" },
      { n: 2, name: "steam-branch", verdict: "fail", detail: 'host branch is "stock-enet"', evidence: ["/tmp/out/host-transport.json"] },
      { n: 3, name: "seat-join", verdict: "fail", detail: "later" }
    ],
    targets: targetsFixture(),
    args: parseProbeArgs([]),
    startedAt: "a",
    finishedAt: "b"
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.failingLeg.n, 2);
  assert.deepEqual(failed.failingLeg.evidence, ["/tmp/out/host-transport.json"]);

  const aborted = buildResult({
    legs: [{ n: 0, name: "preflight", verdict: "pass" }],
    targets: targetsFixture(),
    args: parseProbeArgs([]),
    startedAt: "a",
    finishedAt: "b",
    error: { message: "the game went away" }
  });
  assert.equal(aborted.ok, false);
  assert.match(aborted.error.message, /went away/);
});

// =================================================================================================
// wiring: the probe parses and runs its game-free paths, and the scenario's hook resolves
// =================================================================================================

const PROBE = resolve(REPO_ROOT, "scripts/probe-steam-host-join.mjs");

test("the probe file itself parses", () => {
  const check = spawnSync(process.execPath, ["--check", PROBE], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("--help prints the usage and exits 0 without touching the game", () => {
  const help = spawnSync(process.execPath, [PROBE, "--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stdout, USAGE);
  assert.match(help.stdout, /--handshake <mode>/);
});

// The dry run is the operator's "what would this do" -- and it is also the only end-to-end path of
// main() that can be exercised without a game, so it keeps argv -> targets -> plan honest.
test("--dry-run resolves the plan, emits one JSON object, and takes no lease", () => {
  const dry = spawnSync(process.execPath, [PROBE, "--dry-run", "--base", "http://127.0.0.1:14000", "--instance", "beta"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, COUCHCOOP_LIVEQA_OWNER: "", COUCHCOOP_LIVEQA_PID: "" }
  });
  assert.equal(dry.status, 0, dry.stderr);
  const payload = JSON.parse(dry.stdout);
  assert.equal(payload.output.dryRun, true);
  assert.deepEqual(payload.artifacts, []);
  assert.equal(payload.output.target.browserPort, 14000);
  assert.deepEqual(payload.output.lockResources, [
    "shared:install", "exclusive:game:beta", "exclusive:browser:14000", "exclusive:port:13357"
  ]);
  assert.deepEqual(payload.output.menuRoute.map(step => step.id), ["multiplayer", "host", "standard"]);
  assert.match(payload.output.seatLogPathPattern, /headless-slots\/slot-<slot>\//);
});

test("an unknown flag fails loudly instead of running against the game", () => {
  const bad = spawnSync(process.execPath, [PROBE, "--players", "5"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown argument '--players'/);
});

test("the scenario's hook name resolves to a hook whose command exists", () => {
  const scenario = readFileSync(resolve(REPO_ROOT, "tests/scenarios/steam-host-join.sts2.yaml"), "utf8");
  const hookName = /name:\s*(couchcoop\.[a-z0-9.-]+)\s*$/m.exec(scenario)?.[1];
  assert.equal(hookName, "couchcoop.steam-host-join-probe");

  const hooks = readFileSync(resolve(REPO_ROOT, "sts2.hooks.yaml"), "utf8");
  assert.ok(new RegExp(`^\\s{2}${hookName.replace(/\./g, "\\.")}:\\s*$`, "m").test(hooks), `${hookName} is not declared in sts2.hooks.yaml`);

  const commands = [...hooks.matchAll(/^\s{4}command:\s*(\S+)\s*$/gm)].map(match => match[1]);
  assert.ok(commands.includes("scripts/probe-steam-host-join.mjs"), "the hook does not point at the probe");
  for (const command of commands) {
    assert.ok(existsSync(resolve(REPO_ROOT, command)), `hook command ${command} does not exist`);
  }
});

test("the scenario parses the same way the existing ones do", () => {
  const scenarioDir = resolve(REPO_ROOT, "tests/scenarios");
  const script = [
    "import json,sys,yaml,glob,os",
    "out={}",
    "for path in sorted(glob.glob(os.path.join(sys.argv[1],'*.sts2.yaml'))):",
    "    with open(path) as handle: out[os.path.basename(path)]=yaml.safe_load(handle)",
    "print(json.dumps(out))"
  ].join("\n");
  const parsed = spawnSync("python3", ["-c", script, scenarioDir], { encoding: "utf8" });
  if (parsed.status !== 0) {
    console.log(`  ~ SKIP yaml parse leg (python3/PyYAML unavailable): ${(parsed.stderr || parsed.error?.message || "").trim().split("\n").pop()}`);
    return;
  }
  const scenarios = JSON.parse(parsed.stdout);
  const mine = scenarios["steam-host-join.sts2.yaml"];
  assert.ok(mine, "steam-host-join.sts2.yaml did not parse");

  const reference = scenarios["five-player-run.sts2.yaml"];
  assert.ok(reference, "the reference scenario did not parse");
  assert.deepEqual(Object.keys(mine).sort(), Object.keys(reference).sort(), "top-level shape must match the existing scenarios");
  assert.equal(mine.name, "steam-host-join");
  assert.equal(typeof mine.description, "string");

  const stepIds = mine.steps.map(step => Object.keys(step)[0]);
  assert.deepEqual(stepIds, ["game.deploy", "dev.delay", "project.hook"]);
  const knownIds = new Set(Object.values(scenarios).flatMap(value => value.steps.map(step => Object.keys(step)[0])));
  for (const id of stepIds) {
    assert.ok(knownIds.has(id), `step ${id} is not used by any committed scenario`);
  }
  const hook = mine.steps.at(-1)["project.hook"];
  assert.equal(hook.name, "couchcoop.steam-host-join-probe");
  assert.deepEqual(hook.input, { handshake: "auto" });
});

// The five-player probe is the seat-join implementation this one reuses. If those exports go away, the
// reuse silently becomes a second implementation -- so pin them.
test("the seat-join path this probe borrows is still exported by the five-player probe", async () => {
  const five = await import("./probe-five-player-run.mjs");
  for (const name of ["joinSeats", "closeBrowsers", "checkSeatRecords", "seatLogPathFor", "seatNameFor", "splitLogLines"]) {
    assert.equal(typeof five[name], "function", `probe-five-player-run.mjs no longer exports ${name}`);
  }
});

// =================================================================================================

let failures = 0;
for (const { name, body } of cases) {
  try {
    await body();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${error?.message?.split("\n").join("\n      ")}`);
  }
}
console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exitCode = failures === 0 ? 0 : 1;
