#!/usr/bin/env node
//
// Self-test for scripts/probe-five-player-run.mjs -- everything in that probe that does NOT need a
// running game. Plain `node scripts/test-probe-five-player-run.mjs`, no test runner, no game, no
// network, no live lock.
//
// Covered: argument parsing, bring-up record loading/validation/fallback, target resolution and its
// precedence chain, the live-QA resource set, the seat port/slot algebra, the mod setup gate,
// character assignment (including the "re-selecting your own character is refused" trap and the
// five-players/four-characters case), in-run aliveness derivation, the log-signature scanner, the
// whole evidence pipeline end to end on real temp files, result.json assembly, and bounded
// concurrency. Plus the wiring checks: the probe still parses, the scenario parses the same way the
// existing three do, and its hook name resolves to a real hook whose command exists.
//
// Log fixtures are SYNTHESIZED here rather than committed: the signature strings themselves are the
// contract, a captured game log is not ours to commit.
//
// Two of these tests exist because they caught real bugs while this was being written -- the greedy
// character assignment that failed on a satisfiable roster, and the trailing-newline off-by-one that
// dated every post-embark log hit as pre-embark. Do not delete them as redundant.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BRINGUP_SCHEMA, RESULT_SCHEMA, SIGNALS_SCHEMA,
  REQUIRED_MOD_ID, FORBIDDEN_MOD_ID,
  DEFAULT_HOST_PORT,
  ProbeUsageError,
  parseProbeArgs, parseBringupRecord, resolveTargets, lockResourcesFor,
  slotForPort, seatLogPathFor, seatBridgeSocketFor, seatNameFor,
  evaluateModGate, assignCharacters, runPlayerAliveness,
  scanLogSignatures, splitLogLines, buildResult, mapWithConcurrency,
  captureLogBaselines, archiveEvidence, waitForLogSignatures
} from "./probe-five-player-run.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cases = [];
const test = (name, body) => cases.push({ name, body });

// =================================================================================================
// argument parsing
// =================================================================================================

test("parseProbeArgs defaults to the five-player repro", () => {
  const args = parseProbeArgs([]);
  assert.equal(args.players, 5);
  assert.equal(args.base, null);
  assert.equal(args.record, null);
  assert.equal(args.out, null);
  assert.equal(args.instance, null);
  assert.equal(args.seatConcurrency, 2);
  assert.ok(args.seatTimeoutMs > 0 && args.embarkTimeoutMs > 0 && args.combatTimeoutMs > 0);
});

test("parseProbeArgs reads every flag", () => {
  const args = parseProbeArgs([
    "--players", "4",
    "--base", "http://10.0.0.5:13400",
    "--record", "/tmp/bringup.json",
    "--out", "/tmp/out",
    "--instance", "mp5",
    "--seat-timeout-ms", "60000",
    "--seat-concurrency", "3",
    "--embark-timeout-ms", "90000",
    "--combat-timeout-ms", "45000"
  ]);
  assert.deepEqual(args, {
    players: 4,
    base: "http://10.0.0.5:13400",
    record: "/tmp/bringup.json",
    out: "/tmp/out",
    instance: "mp5",
    seatTimeoutMs: 60000,
    seatConcurrency: 3,
    embarkTimeoutMs: 90000,
    combatTimeoutMs: 45000
  });
});

test("parseProbeArgs rejects bad usage instead of guessing", () => {
  assert.throws(() => parseProbeArgs(["--nope"]), ProbeUsageError);
  assert.throws(() => parseProbeArgs(["--players"]), /requires a value/);
  // A flag where a value belongs is a typo, not a value.
  assert.throws(() => parseProbeArgs(["--players", "--base"]), /requires a value/);
  assert.throws(() => parseProbeArgs(["--players", "1"]), /must be an integer in 2\.\./);
  assert.throws(() => parseProbeArgs(["--players", "five"]), /must be an integer/);
  assert.throws(() => parseProbeArgs(["--seat-timeout-ms", "0"]), /positive integer/);
});

// =================================================================================================
// bring-up record
// =================================================================================================

const RECORD = Object.freeze({
  schema: BRINGUP_SCHEMA,
  instance: "mp5",
  config: "/tmp/mp5/sts2.local.yaml",
  runDir: "/tmp/mp5",
  display: ":77",
  gamescopePid: 4242,
  gamescopeLog: "/tmp/mp5/gamescope.log",
  vulkanDevice: "llvmpipe",
  userDir: "/tmp/mp5/xdg",
  browserPort: 13400,
  browserBaseUrl: "http://127.0.0.1:13400",
  gamePid: 4343,
  hostStdoutPath: "/tmp/mp5/host.stdout.log",
  hostStderrPath: "/tmp/mp5/host.stderr.log",
  seatLogGlob: "/tmp/mp5/xdg/SlayTheSpire2/couch-coop/headless-slots/slot-*/SlayTheSpire2/logs/godot.log",
  mods: [{ id: "sts2unlimited", enabled: true, source: "steam_workshop" }],
  modsSource: "/tmp/mp5/mods",
  readyMs: 61234
});

test("parseBringupRecord accepts the documented schema", () => {
  const record = parseBringupRecord(JSON.stringify(RECORD));
  assert.equal(record.browserPort, 13400);
  assert.equal(record.instance, "mp5");
});

test("parseBringupRecord fails clearly on a schema mismatch", () => {
  assert.throws(() => parseBringupRecord(JSON.stringify({ ...RECORD, schema: "couchcoop-five-player-bringup/2" })), /schema mismatch/);
  assert.throws(() => parseBringupRecord(JSON.stringify({ browserPort: 1 })), /schema mismatch/);
  assert.throws(() => parseBringupRecord("not json"), /not JSON/);
  assert.throws(() => parseBringupRecord("[]"), /must contain a JSON object/);
});

// =================================================================================================
// target resolution
// =================================================================================================

test("resolveTargets takes everything from the record when there are no flags", () => {
  const targets = resolveTargets({
    args: parseProbeArgs([]),
    record: RECORD,
    env: {},
    home: "/home/qa",
    repoRoot: "/repo",
    primaryRepoRoot: "/primary"
  });
  assert.equal(targets.players, 5);
  assert.equal(targets.seats, 4);
  assert.equal(targets.baseUrl, "http://127.0.0.1:13400");
  assert.equal(targets.browserPort, 13400);
  assert.equal(targets.instance, "mp5");
  assert.equal(targets.userDir, "/tmp/mp5/xdg");
  assert.equal(targets.hostStdoutPath, "/tmp/mp5/host.stdout.log");
  assert.equal(targets.outDir, "/repo/.sts2/artifacts/five-player-run");
  assert.equal(targets.hasRecord, true);
  assert.deepEqual(targets.portBases, [13400, DEFAULT_HOST_PORT]);
  assert.equal(targets.sources.browserPort, "record");
});

test("resolveTargets falls back to the defaults with no record at all", () => {
  const targets = resolveTargets({
    args: parseProbeArgs([]),
    record: null,
    env: {},
    home: "/home/qa",
    repoRoot: "/repo",
    primaryRepoRoot: "/primary"
  });
  assert.equal(targets.baseUrl, "http://127.0.0.1:13337");
  assert.equal(targets.browserPort, DEFAULT_HOST_PORT);
  assert.equal(targets.instance, null);
  assert.equal(targets.userDir, "/home/qa/.local/share");
  assert.equal(targets.seatLogGlob, "/home/qa/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-*/SlayTheSpire2/logs/godot.log");
  // A worktree's own .sts2/ is empty, so the host stdio fallback must point at the primary checkout.
  assert.equal(targets.hostStdoutPath, "/primary/.sts2/artifacts/game-launch/game.stdout.log");
  assert.equal(targets.hostStderrPath, "/primary/.sts2/artifacts/game-launch/game.stderr.log");
  assert.equal(targets.hasRecord, false);
  assert.deepEqual(targets.portBases, [DEFAULT_HOST_PORT]);
});

test("resolveTargets lets a flag beat the record, and the record beat the env", () => {
  const flagged = resolveTargets({
    args: parseProbeArgs(["--base", "http://127.0.0.1:14000", "--instance", "other", "--out", "/tmp/elsewhere"]),
    record: RECORD,
    env: { COUCHCOOP_GAME_ORIGIN: "http://127.0.0.1:19999", XDG_DATA_HOME: "/env/share" },
    home: "/home/qa"
  });
  assert.equal(flagged.baseUrl, "http://127.0.0.1:14000");
  assert.equal(flagged.browserPort, 14000);
  assert.equal(flagged.instance, "other");
  assert.equal(flagged.outDir, "/tmp/elsewhere");
  assert.equal(flagged.sources.baseUrl, "cli");

  const enved = resolveTargets({
    args: parseProbeArgs([]),
    record: null,
    env: { COUCHCOOP_GAME_ORIGIN: "http://127.0.0.1:19999", XDG_DATA_HOME: "/env/share" },
    home: "/home/qa"
  });
  assert.equal(enved.baseUrl, "http://127.0.0.1:19999");
  assert.equal(enved.browserPort, 19999);
  assert.equal(enved.userDir, "/env/share");
  assert.equal(enved.sources.userDir, "env");
});

test('resolveTargets treats the instance name "default" as no --instance at all', () => {
  const targets = resolveTargets({ args: parseProbeArgs([]), record: { ...RECORD, instance: "default" }, env: {}, home: "/home/qa" });
  assert.equal(targets.instance, null);
});

test("lockResourcesFor claims the install, the game, the host port and every seat port", () => {
  const targets = resolveTargets({ args: parseProbeArgs([]), record: RECORD, env: {}, home: "/home/qa" });
  assert.deepEqual(lockResourcesFor(targets), [
    "shared:install",
    "exclusive:game:mp5",
    "exclusive:browser:13400",
    "exclusive:port:13357",
    "exclusive:port:13367",
    "exclusive:port:13377",
    "exclusive:port:13387"
  ]);
  const control = resolveTargets({ args: parseProbeArgs(["--players", "4"]), record: null, env: {}, home: "/home/qa" });
  assert.deepEqual(lockResourcesFor(control), [
    "shared:install",
    "exclusive:game:default",
    "exclusive:browser:13337",
    "exclusive:port:13357",
    "exclusive:port:13367",
    "exclusive:port:13377"
  ]);
});

// =================================================================================================
// seat port algebra
// =================================================================================================

test("slotForPort inverts HeadlessClientManager.SlotToPort", () => {
  assert.deepEqual(slotForPort(13357), { slot: 2, base: 13337, netId: 1002, playerId: "p:1002" });
  assert.deepEqual(slotForPort(13387), { slot: 5, base: 13337, netId: 1005, playerId: "p:1005" });
  assert.equal(slotForPort(13337), null, "the host's own port is not a seat");
  assert.equal(slotForPort(13342), null, "off-grid ports are not seats");
  assert.equal(slotForPort(13347), null, "slot 1 is below MinSlot");
});

test("slotForPort tries the walked host port as well as the compiled constant", () => {
  // Seats are launched from the COMPILED 13337 base even when the host itself walked to 13400, so both
  // bases have to resolve -- and the constant must not shadow a genuine walked-base seat.
  assert.deepEqual(slotForPort(13357, [13400, 13337]), { slot: 2, base: 13337, netId: 1002, playerId: "p:1002" });
  assert.deepEqual(slotForPort(13420, [13400, 13337]), { slot: 2, base: 13400, netId: 1002, playerId: "p:1002" });
  assert.equal(slotForPort(13401, [13400, 13337]), null);
});

test("seat paths follow the documented layout", () => {
  assert.equal(
    seatLogPathFor("/tmp/xdg", 3),
    "/tmp/xdg/SlayTheSpire2/couch-coop/headless-slots/slot-3/SlayTheSpire2/logs/godot.log"
  );
  assert.equal(seatBridgeSocketFor(3), "/tmp/spirectl-bridge-slot-3.sock");
  assert.equal(seatNameFor(0), "Ann");
  assert.notEqual(seatNameFor(0), seatNameFor(1));
  assert.equal(seatNameFor(500), "Seat501", "names never run out");
});

// =================================================================================================
// leg 0 -- the mod setup gate
// =================================================================================================

const modsPayload = mods => ({
  mods,
  activeIds: mods.filter(entry => entry.active).map(entry => entry.id),
  enabledIds: mods.filter(entry => entry.enabled).map(entry => entry.id),
  notices: []
});
const UNLIMITED_OK = { id: REQUIRED_MOD_ID, enabled: true, active: true, loadState: "loaded" };

test("evaluateModGate passes when Unlimited is live and the other limit mod is not", () => {
  const gate = evaluateModGate(modsPayload([UNLIMITED_OK, { id: "CouchCoop", enabled: true, active: true }]), { players: 5, fatal: true });
  assert.equal(gate.ok, true);
  assert.equal(gate.fatal, false);
  assert.deepEqual(gate.problems, []);
});

test("evaluateModGate names each way the loadout can be wrong", () => {
  const missing = evaluateModGate(modsPayload([]), { players: 5, fatal: true });
  assert.match(missing.problems.join(" "), /is not installed/);

  const disabled = evaluateModGate(modsPayload([{ ...UNLIMITED_OK, enabled: false, active: false }]), { players: 5, fatal: true });
  assert.equal(disabled.problems.length, 1);
  assert.match(disabled.problems[0], /not enabled/);

  // Enabled but inactive is the interesting one: the loadout says yes, the runtime says no.
  const inactive = evaluateModGate(modsPayload([{ ...UNLIMITED_OK, active: false, loadState: "failed", errors: ["boom"] }]), { players: 5, fatal: true });
  assert.equal(inactive.problems.length, 1);
  assert.match(inactive.problems[0], /enabled but NOT active/);
  assert.match(inactive.problems[0], /failed/);

  const both = evaluateModGate(modsPayload([UNLIMITED_OK, { id: FORBIDDEN_MOD_ID, enabled: true, active: true }]), { players: 5, fatal: true });
  assert.equal(both.ok, false);
  assert.match(both.problems.join(" "), /must not run together/);
});

test("evaluateModGate is never fatal for the control run, and always prints a fix-up", () => {
  const control = evaluateModGate(modsPayload([]), { players: 4, fatal: false, modsSource: "/tmp/mp5/mods" });
  assert.equal(control.ok, false);
  assert.equal(control.fatal, false, "a missing limit mod must not fail the 4-player control");
  assert.match(control.fixUp, /sts2 --json game mods settings/);
  assert.match(control.fixUp, /3747509118/);
  assert.match(control.fixUp, /3747606832/);
  assert.match(control.fixUp, /\/tmp\/mp5\/mods/);
});

// =================================================================================================
// leg 4 -- character assignment
// =================================================================================================

const CHARACTERS = ["IRONCLAD", "SILENT", "DEFECT", "WATCHER"];

test("assignCharacters never re-selects a player's own character", () => {
  const players = [
    { id: "p:1", characterId: "IRONCLAD" },
    { id: "p:1002", characterId: "SILENT" },
    { id: "p:1003", characterId: "DEFECT" },
    { id: "p:1004", characterId: "WATCHER" }
  ];
  const plan = assignCharacters(players, CHARACTERS);
  assert.equal(plan.distinct, true);
  assert.equal(new Set(plan.assignments.map(a => a.to)).size, 4, "distinct assignments");
  for (const assignment of plan.assignments) {
    assert.notEqual(assignment.to, assignment.from, `${assignment.playerId} would be refused with reasonCode not_visible`);
  }
});

test("assignCharacters finds the distinct assignment greedy misses", () => {
  // A fresh lobby is where everybody shares a default, and greedy-plus-repair fails here even though
  // one spare character makes the roster perfectly satisfiable.
  const players = Array.from({ length: 4 }, (_, index) => ({ id: `p:${1000 + index}`, characterId: "IRONCLAD" }));
  const plan = assignCharacters(players, [...CHARACTERS, "NECROBINDER"]);
  assert.equal(plan.distinct, true);
  assert.equal(new Set(plan.assignments.map(a => a.to)).size, 4);
  for (const assignment of plan.assignments) {
    assert.notEqual(assignment.to, "IRONCLAD");
  }
});

test("assignCharacters reports infeasibility instead of inventing a distinct plan", () => {
  // Four players all on IRONCLAD with four characters: only three characters are a legal move for
  // anybody, so no distinct assignment exists at all. The probe must say so, not throw and not lie.
  const players = Array.from({ length: 4 }, (_, index) => ({ id: `p:${1000 + index}`, characterId: "IRONCLAD" }));
  const plan = assignCharacters(players, CHARACTERS);
  assert.equal(plan.distinct, false);
  assert.match(plan.note, /no distinct assignment exists/);
  for (const assignment of plan.assignments) {
    assert.notEqual(assignment.to, assignment.from);
  }
});

test("assignCharacters solves the tail conflict greedy walks into", () => {
  // Greedy assignment hands IRONCLAD/SILENT/DEFECT to the first three, leaving WATCHER for a player
  // that already holds it -- the case that needs an augmenting path, not a fresh pick.
  const players = [
    { id: "p:1", characterId: "SILENT" },
    { id: "p:1002", characterId: "DEFECT" },
    { id: "p:1003", characterId: null },
    { id: "p:1004", characterId: "WATCHER" }
  ];
  const plan = assignCharacters(players, CHARACTERS);
  assert.equal(plan.distinct, true);
  assert.equal(new Set(plan.assignments.map(a => a.to)).size, 4);
  for (const assignment of plan.assignments) {
    assert.notEqual(assignment.to, assignment.from);
  }
});

test("assignCharacters keeps the real invariant when five players share four characters", () => {
  // The repro's own shape: five players, and the stock game has fewer characters than that.
  const players = Array.from({ length: 5 }, (_, index) => ({ id: `p:${1000 + index}`, characterId: CHARACTERS[index % 4] }));
  const plan = assignCharacters(players, CHARACTERS);
  assert.equal(plan.distinct, false, "distinctness is impossible and must be reported, not faked");
  assert.match(plan.note, /duplicates are unavoidable/);
  assert.equal(plan.assignments.length, 5);
  for (const assignment of plan.assignments) {
    assert.notEqual(assignment.to, assignment.from);
  }
});

test("assignCharacters ignores RANDOM_CHARACTER and refuses an empty list", () => {
  const players = [{ id: "p:1", characterId: "IRONCLAD" }];
  assert.equal(assignCharacters(players, ["RANDOM_CHARACTER", "SILENT"]).assignments[0].to, "SILENT");
  assert.throws(() => assignCharacters(players, ["RANDOM_CHARACTER"]), /no assignable characters/);
  assert.throws(() => assignCharacters(players, []), /no assignable characters/);
});

// =================================================================================================
// leg 5 -- aliveness
// =================================================================================================

test("runPlayerAliveness derives aliveness from HP and never guesses", () => {
  const derived = runPlayerAliveness([
    { id: "p:1", netId: "1", isHost: true, creature: { currentHp: 52, maxHp: 80 } },
    { id: "p:1002", netId: "1002", creature: { currentHp: 0, maxHp: 70 } },
    // run.players[] has no alive/isDead field, so a missing creature is "unknown", not "alive".
    { id: "p:1003", netId: "1003", creature: null },
    { id: "p:1004", netId: "1004", creature: { maxHp: 70 } }
  ]);
  assert.deepEqual(derived.map(player => player.status), ["alive", "dead", "unknown", "unknown"]);
  assert.equal(derived[0].currentHp, 52);
  assert.equal(derived[0].maxHp, 80);
  assert.deepEqual(runPlayerAliveness(undefined), []);
});

// =================================================================================================
// evidence -- the log-signature scanner
// =================================================================================================

const hostLog = [
  "[couch-coop] browser server listening on 13337",                                  // 1
  "[couch-coop] headless netId-bound spawn slot=2 netId=1002",                       // 2
  "[PacketSizePatch] Patched NetMessageWriter",                                      // 3
  "Embarking on a multiplayer run. Players: 5",                                      // 4
  "Packet writer is growing from 4096 to 8192",                                      // 5
  "Player 1004 disconnected, reason: 3",                                             // 6
  "ConnectionFailureReason: Timeout",                                                // 7
  "System.NullReferenceException: Object reference not set",                         // 8  host-only: NOT a signature
  ""
].join("\n");

const seatLog = [
  "MegaDot v4.5.1.m.12.mono.custom_build",                                           // 1
  "Sending handshake with net ID 1004",                                              // 2
  "ClientLobbyJoinResponseMessage Players: 5",                                       // 3
  "NetError.IdCollision",                                                            // 4
  "System.NullReferenceException: Object reference not set",                         // 5
  "Server disconnected, reason: 0",                                                  // 6
  ""
].join("\n");

test("scanLogSignatures finds every signature with its file and line", () => {
  const signals = scanLogSignatures([
    { label: "host-stdout", path: "/tmp/host.stdout.log", role: "host-stdout", text: hostLog, baselineLines: 3 },
    { label: "seat-slot-4", path: "/tmp/slot-4/godot.log", role: "seat", text: seatLog, baselineLines: 3 }
  ], { capturedAt: "2026-09-11T00:00:00.000Z" });

  assert.equal(signals.schema, SIGNALS_SCHEMA);
  assert.equal(signals.timestampsAvailable, false);
  assert.equal(signals.bySignature.embark.total, 1);
  assert.deepEqual(signals.bySignature.embark.first, {
    file: "host-stdout",
    path: "/tmp/host.stdout.log",
    lineNumber: 4,
    phase: "post-embark",
    text: "Embarking on a multiplayer run. Players: 5"
  });
  assert.equal(signals.bySignature.packetSizePatch.total, 1);
  assert.equal(signals.bySignature.packetWriterGrowth.total, 1);
  assert.equal(signals.bySignature.beginRunMessageThrow.total, 0);
  assert.equal(signals.bySignature.disconnect.total, 2, "both logs disconnect");
  assert.deepEqual(signals.bySignature.disconnect.byFile, { "host-stdout": 1, "seat-slot-4": 1 });
  assert.equal(signals.bySignature.connectionFailureReason.total, 1);
  assert.equal(signals.bySignature.netError.total, 1);
});

test("scanLogSignatures scopes NullReferenceException to seat logs", () => {
  const signals = scanLogSignatures([
    { label: "host-stdout", role: "host-stdout", text: hostLog, baselineLines: 3 },
    { label: "seat-slot-4", role: "seat", text: seatLog, baselineLines: 3 }
  ]);
  assert.equal(signals.bySignature.seatNullReference.total, 1, "the host's own NRE is ordinary noise");
  assert.deepEqual(signals.bySignature.seatNullReference.byFile, { "seat-slot-4": 1 });
});

test("scanLogSignatures answers before-or-after-embark from the baseline alone", () => {
  const signals = scanLogSignatures([
    { label: "host-stdout", role: "host-stdout", text: hostLog, baselineLines: 3 }
  ]);
  const host = signals.files[0];
  // The baseline is the line count taken just before the ready/embark step, so the patch line (3) is
  // pre-embark and everything the embark produced is post-embark.
  assert.equal(host.hits.find(hit => hit.signature === "packetSizePatch").phase, "pre-embark");
  assert.equal(host.hits.find(hit => hit.signature === "embark").phase, "post-embark");
  // ...and within one file, line order IS the chronology: the disconnect came after the embark.
  const order = host.ordering.map(hit => hit.signature);
  assert.ok(order.indexOf("disconnect") > order.indexOf("embark"), "the disconnect follows the embark line");
  assert.deepEqual(order, ["packetSizePatch", "embark", "packetWriterGrowth", "disconnect", "connectionFailureReason"]);
});

test("splitLogLines does not invent a line for the trailing newline", () => {
  assert.deepEqual(splitLogLines(""), []);
  assert.deepEqual(splitLogLines("a\n"), ["a"]);
  assert.deepEqual(splitLogLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLogLines("a\nb"), ["a", "b"]);
  // Blank lines INSIDE a log are still lines -- only the tail is dropped.
  assert.deepEqual(splitLogLines("a\n\nb\n"), ["a", "", "b"]);
  assert.deepEqual(splitLogLines(null), []);
});

test("scanLogSignatures survives a missing log and an unknown baseline", () => {
  const signals = scanLogSignatures([
    { label: "host-stderr", role: "host-stderr", text: "", baselineLines: null },
    { label: "seat-slot-9", role: "seat", text: "Server disconnected, reason: 0\n", baselineLines: null }
  ]);
  assert.equal(signals.files[0].lines, 0);
  assert.equal(signals.files[0].hits.length, 0);
  assert.equal(signals.files[1].hits[0].phase, "unknown");
  assert.equal(signals.bySignature.disconnect.total, 1);
});

// =================================================================================================
// leg 2 -- the per-seat ENet join evidence
// =================================================================================================

test("waitForLogSignatures matches the handshake for THIS seat's netId, not a stale one", async () => {
  const root = mkdtempSync(join(tmpdir(), "five-player-enet-"));
  try {
    const path = join(root, "godot.log");
    // A reused slot dir can still hold the previous run's log. A prefix-only match would pass this
    // leg vacuously on it, which is why the netId is part of the pattern.
    writeFileSync(path, "Sending handshake with net ID 1002\nClientLobbyJoinResponseMessage Players: 3\n");
    const patterns = netId => [
      { pattern: `Sending handshake with net ID ${netId}`, hint: "Sending handshake with net ID" },
      { pattern: "ClientLobbyJoinResponseMessage Players:", hint: "ClientLobbyJoinResponseMessage" }
    ];

    const found = await waitForLogSignatures(path, patterns(1002), 50);
    assert.equal(found.length, 2);
    assert.equal(found[0].lineNumber, 1);
    assert.equal(found[1].lineNumber, 2);

    await assert.rejects(
      () => waitForLogSignatures(path, patterns(1005), 1),
      // The diagnostic quotes the closest line, so a wording drift reads differently from "never happened".
      /closest line: Sending handshake with net ID 1002/
    );
    await assert.rejects(
      () => waitForLogSignatures(join(root, "absent.log"), patterns(1002), 1),
      /nothing resembling it in the log/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// =================================================================================================
// evidence -- the whole archive pipeline, on real files, with no game
// =================================================================================================

test("captureLogBaselines + archiveEvidence produce a signals.json that dates the embark", async () => {
  const root = mkdtempSync(join(tmpdir(), "five-player-evidence-"));
  try {
    const userDir = join(root, "xdg");
    const slotLogDir = slot => join(userDir, "SlayTheSpire2/couch-coop/headless-slots", `slot-${slot}`, "SlayTheSpire2/logs");
    for (const slot of [2, 3]) mkdirSync(slotLogDir(slot), { recursive: true });
    const hostStdoutPath = join(root, "host.stdout.log");
    const seat2 = join(slotLogDir(2), "godot.log");
    const seat3 = join(slotLogDir(3), "godot.log");

    // Pre-embark content: whatever the host and the seats logged while the lobby filled.
    writeFileSync(hostStdoutPath, "[couch-coop] browser server listening\n[PacketSizePatch] Patched NetMessageWriter\n");
    writeFileSync(seat2, "Sending handshake with net ID 1002\nClientLobbyJoinResponseMessage Players: 3\n");
    writeFileSync(seat3, "Sending handshake with net ID 1003\nClientLobbyJoinResponseMessage Players: 3\n");

    const targets = {
      outDir: join(root, "artifacts"),
      userDir,
      hostStdoutPath,
      // Deliberately absent: the host stderr log has to be tolerated, not crashed on.
      hostStderrPath: join(root, "host.stderr.log")
    };
    const seats = [
      { name: "Ann", slot: 2, port: 13357, playerId: "p:1002", logPath: seat2 },
      { name: "Bo", slot: 3, port: 13367, playerId: "p:1003", logPath: seat3 }
    ];

    const baselines = await captureLogBaselines(targets, seats);
    assert.deepEqual(baselines.map(file => file.label).sort(), ["host-stderr", "host-stdout", "seat-slot-2", "seat-slot-3"]);
    // Two real lines: a trailing newline must NOT be counted, or every post-embark hit slides one
    // line back into "pre-embark" and the artifact argues the opposite of the truth.
    assert.equal(baselines.find(file => file.label === "host-stdout").baselineLines, 2);
    assert.equal(baselines.find(file => file.label === "host-stderr").baselineLines, null, "a missing log has no baseline");

    // ...then embark happens, and everything after this point is post-embark.
    appendFileSync(hostStdoutPath, "Embarking on a multiplayer run. Players: 3\nPlayer 1003 disconnected, reason: 3\n");
    appendFileSync(seat3, "System.NullReferenceException: boom\n");

    const evidence = { archives: [] };
    const archived = await archiveEvidence(targets, seats, baselines, evidence);
    assert.ok(archived.signalsPath.endsWith("signals.json"));
    assert.ok(existsSync(archived.signalsPath));
    assert.ok(existsSync(join(targets.outDir, "logs/host-stdout.log")), "the host log is copied into the artifact dir");
    assert.ok(existsSync(join(targets.outDir, "logs/seat-slot-3.log")));
    assert.ok(evidence.archives.length >= 4, "every archived path is recorded on the evidence bundle");

    const signals = JSON.parse(readFileSync(archived.signalsPath, "utf8"));
    assert.equal(signals.schema, SIGNALS_SCHEMA);
    // The patch line was there before the ready step; the embark and the disconnect were not.
    const host = signals.files.find(file => file.label === "host-stdout");
    assert.equal(host.hits.find(hit => hit.signature === "packetSizePatch").phase, "pre-embark");
    assert.equal(host.hits.find(hit => hit.signature === "embark").phase, "post-embark");
    assert.equal(host.hits.find(hit => hit.signature === "disconnect").phase, "post-embark");
    assert.ok(
      host.ordering.findIndex(hit => hit.signature === "disconnect") > host.ordering.findIndex(hit => hit.signature === "embark"),
      "the disconnect follows the embark, answerable from the artifact alone"
    );
    assert.equal(signals.bySignature.seatNullReference.total, 1);
    assert.equal(signals.bySignature.seatNullReference.first.file, "seat-slot-3");
    // A missing source log is reported, not silently dropped.
    const stderrEntry = signals.archive.find(entry => entry.label === "host-stderr");
    assert.equal(stderrEntry.archivedPath, null);
    assert.ok(stderrEntry.missing, "the absent host stderr log is recorded as missing");
    assert.deepEqual(signals.seats.map(seat => seat.slot), [2, 3]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// =================================================================================================
// result assembly
// =================================================================================================

const targetsFixture = () => resolveTargets({ args: parseProbeArgs([]), record: RECORD, env: {}, home: "/home/qa", repoRoot: "/repo", primaryRepoRoot: "/primary" });

test("buildResult reports ok with every leg passing", () => {
  const result = buildResult({
    legs: [{ n: 0, name: "setup-gate", verdict: "info" }, { n: 5, name: "run-roster", verdict: "pass" }, { n: 6, name: "playable-turn", verdict: "skipped" }],
    targets: targetsFixture(),
    args: parseProbeArgs([]),
    startedAt: "a",
    finishedAt: "b"
  });
  assert.equal(result.schema, RESULT_SCHEMA);
  assert.equal(result.ok, true);
  assert.equal(result.failingLeg, null);
  assert.equal(result.control, false);
  assert.equal(result.target.browserPort, 13400);
});

test("buildResult names the FIRST failing leg and carries its evidence", () => {
  const result = buildResult({
    legs: [
      { n: 0, name: "setup-gate", verdict: "pass" },
      { n: 5, name: "run-roster", verdict: "fail", detail: "run.players.length is 1, expected 5", evidence: ["/tmp/out/signals.json"] },
      { n: 6, name: "playable-turn", verdict: "fail", detail: "later" }
    ],
    targets: targetsFixture(),
    args: parseProbeArgs([]),
    startedAt: "a",
    finishedAt: "b"
  });
  assert.equal(result.ok, false);
  assert.equal(result.failingLeg.n, 5);
  assert.equal(result.failingLeg.name, "run-roster");
  assert.match(result.failingLeg.detail, /expected 5/);
  assert.deepEqual(result.failingLeg.evidence, ["/tmp/out/signals.json"]);
});

test("buildResult marks a four-player run as the control and is not ok after an abort", () => {
  const targets = resolveTargets({ args: parseProbeArgs(["--players", "4"]), record: null, env: {}, home: "/home/qa" });
  const result = buildResult({
    legs: [{ n: 0, name: "setup-gate", verdict: "pass" }],
    targets,
    args: parseProbeArgs(["--players", "4"]),
    startedAt: "a",
    finishedAt: "b",
    error: { message: "the game went away" }
  });
  assert.equal(result.control, true);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /went away/);
});

// =================================================================================================
// concurrency
// =================================================================================================

test("mapWithConcurrency keeps input order and respects the bound", () => {
  return (async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency([10, 20, 30, 40, 50], 2, async (value, index) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(done => setTimeout(done, 5));
      inFlight -= 1;
      return `${index}:${value}`;
    });
    assert.deepEqual(results, ["0:10", "1:20", "2:30", "3:40", "4:50"]);
    assert.ok(peak <= 2, `peak concurrency was ${peak}, expected <= 2`);
    assert.deepEqual(await mapWithConcurrency([], 4, async () => "x"), []);
  })();
});

// =================================================================================================
// wiring: the probe parses, and the scenario's hook resolves
// =================================================================================================

test("the probe file itself parses", () => {
  const check = spawnSync(process.execPath, ["--check", resolve(REPO_ROOT, "scripts/probe-five-player-run.mjs")], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("the scenario's hook name resolves to a hook whose command exists", () => {
  const scenario = readFileSync(resolve(REPO_ROOT, "tests/scenarios/five-player-run.sts2.yaml"), "utf8");
  const hookName = /name:\s*(couchcoop\.[a-z0-9.-]+)\s*$/m.exec(scenario)?.[1];
  assert.equal(hookName, "couchcoop.five-player-run-probe");

  const hooks = readFileSync(resolve(REPO_ROOT, "sts2.hooks.yaml"), "utf8");
  assert.ok(new RegExp(`^\\s{2}${hookName.replace(/\./g, "\\.")}:\\s*$`, "m").test(hooks), `${hookName} is not declared in sts2.hooks.yaml`);

  const commands = [...hooks.matchAll(/^\s{4}command:\s*(\S+)\s*$/gm)].map(match => match[1]);
  assert.ok(commands.includes("scripts/probe-five-player-run.mjs"), "the hook does not point at the probe");
  for (const command of commands) {
    assert.ok(existsSync(resolve(REPO_ROOT, command)), `hook command ${command} does not exist`);
  }
});

test("the scenario parses the same way the existing three do", () => {
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
  const mine = scenarios["five-player-run.sts2.yaml"];
  assert.ok(mine, "five-player-run.sts2.yaml did not parse");

  const reference = scenarios["lobby-actions-remain-available.sts2.yaml"];
  assert.ok(reference, "the reference scenario did not parse");
  assert.deepEqual(Object.keys(mine).sort(), Object.keys(reference).sort(), "top-level shape must match the existing scenarios");
  assert.equal(mine.name, "five-player-run");
  assert.equal(typeof mine.description, "string");

  const stepIds = mine.steps.map(step => Object.keys(step)[0]);
  const knownIds = new Set(Object.values(scenarios).flatMap(value => value.steps.map(step => Object.keys(step)[0])));
  for (const id of stepIds) {
    assert.ok(knownIds.has(id), `step ${id} is not used by any committed scenario`);
  }
  assert.deepEqual(stepIds, ["game.deploy", "dev.delay", "project.hook"]);
  const hook = mine.steps.at(-1)["project.hook"];
  assert.equal(hook.name, "couchcoop.five-player-run-probe");
  assert.deepEqual(hook.input, { players: 5 });
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
