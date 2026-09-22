#!/usr/bin/env node
//
// Live repro: a 5-player CouchCoop session starts a run with only the host in it.
// ============================================================================================
//
// With the Workshop mod "Unlimited: No Player Limit" (`sts2unlimited`) raising the lobby cap, a session
// of host + 4 browser seats fills the lobby correctly, every seat readies, the run BEGINS -- and the
// in-run multiplayer player list comes back with the host alone. This probe is the committed,
// repeatable reproduction of that: it drives the real thing end to end, and archives the logs that
// discriminate between the candidate root causes.
//
//   node scripts/probe-five-player-run.mjs [--players N] [--base <url>] [--record <bringup.json>]
//                                          [--out <dir>] [--instance <name>]
//
// `--players 5` (the default) is the REPRO and is expected to fail at leg 5 today.
// `--players 4` is the CONTROL and must pass on unmodded stock.
//
// Legs
// ----
//   0 setup gate      `sts2 game mods active`: sts2unlimited enabled AND active, MultiplayerLimitBreak not
//                     active. Informational (never fatal) at --players 4.
//   1 host lobby      load tests/fixtures/pc-lobby-host.sts2.fixture.yaml; netGameType == "host" and
//                     lobby.maxPlayers >= N. maxPlayers is the proof Unlimited is actually live: the stock
//                     lobby reports 4 (StateCharacterSelectLobbyDefaults.MaxPlayers).
//   2 seats join      N-1 Playwright contexts join by name, bounded concurrency; each seat's OWN godot.log
//                     must show a real ENet join.
//   3 roster          lobby.players.length == N, one host + N-1 couch netIds, seat mirror ports on the
//                     base + slot*10 grid.
//   4 characters+ready  select-character then ready for every seat. There is no `start-run` verb:
//                     readying everybody is what embarks.
//   5 THE GATE        run.players.length == N, every entry alive, every seat mirror still serving.
//                     *** This is the leg expected to FAIL at N=5. ***
//   6 playable        one full combat turn resolves (see the note on leg 6 below).
//
// Evidence is the point
// ---------------------
// Around embark (leg 4 -> leg 5) the probe archives the host stdout/stderr log and every seat godot.log
// into the artifact dir, plus a `signals.json` that grep-scans them for the signatures listed in
// LOG_SIGNATURES and records file + line number for every hit. godot.log carries NO per-line timestamps,
// so ordering ("did the disconnect happen before or after `Embarking...`?") is answered two ways:
// per-file line order, and a `phase` stamp computed from a line-count baseline taken immediately BEFORE
// the ready/embark step. Evidence capture runs on the failure path too, and never masks the real error.
//
// The cheap inner loop (documented, deliberately NOT the gate)
// -----------------------------------------------------------
// `sts2 act join-lobby-player --display-name <name>` creates SYNTHETIC host-local seats, so five calls
// build a 5-player LOBBY inside a single process with no browsers, no headless instances and no ENet.
// That is the fast way to bisect game-side lobby/embark logic -- seconds per iteration instead of
// minutes. It is not what this probe does, because those seats never traverse the real ENet join path
// this bug lives on: no handshake, no ClientLobbyJoinResponseMessage, no per-seat process to disconnect.
// A fix proven only against join-lobby-player has not been proven at all.
//
// Traps this file encodes (each cost someone time)
// ------------------------------------------------
//  * Re-selecting the character a seat ALREADY has is refused with reasonCode "not_visible", so leg 4
//    never assigns a player its current character (assignCharacters()).
//  * There is no `start-run` / `begin-run` verb in `sts2 act`. Readying every seat is the embark trigger
//    (`characterSelect.isBeginningRun` = connectingPlayerCount == 0 && all players ready).
//  * `run.players[]` has NO alive/isDead field. Aliveness is derived from `creature.currentHp > 0`, and
//    a null `creature` is reported as "unknown", never silently as alive (runPlayerAliveness()).
//  * Seat browser ports come from HeadlessClientManager.SlotToPort = 13337 + slot*10, using the COMPILED
//    constant, not the host's actually-bound port -- which can differ when the host port-walked. Both
//    bases are tried (slotForPort) and the one that matched is recorded.
//  * Every couch seat runs its own spirectl bridge at /tmp/spirectl-bridge-slot-<N>.sock. A seat-owned
//    semantic action refused by the HOST bridge is retried there, and each seat's own view of the run is
//    captured as evidence -- "the host thinks there is one player, what does seat 3 think?" is exactly
//    the question this bug asks.
//  * `--instance` is threaded through the SPIRECTL_INSTANCE environment variable rather than as an
//    argument, so the shared probe-lib helpers target the record's instance without being re-plumbed.
//    The instance name OWNS the bridge path, so seat-scoped calls clear it and set
//    SPIRECTL_BRIDGE_SOCKET_PATH instead.
//  * A hook's stdout must be exactly one JSON object, so every progress line here goes to stderr.
//
// A note on leg 6. A fresh run does not necessarily open in a combat room (the opening event comes
// first), and resolving that opening for N players is a different probe. Leg 6 therefore waits a bounded
// time for a combat to become current: if one does, the turn assertion is enforced and fatal; if the run
// is parked on another room type, the leg is reported as "skipped" with the observed roomType rather
// than failing on something the game never offered.

import { mkdir, readFile, writeFile, rm, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import { acquireLease, assertLease, releaseLease } from "./live-qa-lock.mjs";
import { PRIMARY_REPO_ROOT, REPO_ROOT as REPO_ROOT_PATH } from "./lib/repo-layout.mjs";
import {
  FIXTURE_HOST_LOBBY, SCREEN_START_RUN_LOBBY,
  ProbeError, assert, sleep,
  run, sts2, loadFixture, state, sceneTree, screenshot, waitFor
} from "./probe-lib-lobby-qr.mjs";

// =================================================================================================
// constants
// =================================================================================================

export const BRINGUP_SCHEMA = "couchcoop-five-player-bringup/1";
export const RESULT_SCHEMA = "couchcoop-five-player-run/1";
export const SIGNALS_SCHEMA = "couchcoop-five-player-signals/1";

/** Workshop mod that must be live for the repro, and the one that must NOT be (they fight). */
export const REQUIRED_MOD_ID = "sts2unlimited";
export const FORBIDDEN_MOD_ID = "STS2-MultiplayerLimitBreak";
const REQUIRED_MOD_WORKSHOP_ID = "3747509118";
const FORBIDDEN_MOD_WORKSHOP_ID = "3747606832";

/** HeadlessClientManager: netId = 1000 + slot, browser port = 13337 + slot*10, slots start at 2. */
export const SEAT_BASE_NET_ID = 1000;
export const SEAT_MIN_SLOT = 2;
export const SEAT_MAX_SLOT = 99;
export const SEAT_PORT_STEP = 10;
export const DEFAULT_HOST_PORT = 13337;

/**
 * The log signatures that discriminate between the candidate root causes. Order is meaningful only
 * within a file (godot.log has no per-line timestamps), which is what `phase` and `ordering` are for.
 *
 * `scope: "seat"` restricts a signature to seat logs -- a bare NullReferenceException in the HOST's
 * stdout is ordinary noise, the same string in a seat log is the seat falling over during embark.
 */
export const LOG_SIGNATURES = Object.freeze([
  { id: "embark", pattern: "Embarking on a multiplayer run. Players:", scope: "any" },
  // CouchCoopHostTransport.LogEffectiveCapacity -- the cap the listener was ACTUALLY built for, on
  // whichever host path ran. A seat refused at the transport shows up here as a number lower than the
  // lobby's, long before any run-start symptom; keep the token in step with that log line.
  { id: "effectiveMaxClients", pattern: "effective maxClients=", scope: "any" },
  { id: "packetSizePatch", pattern: "[PacketSizePatch] Patched", scope: "any" },
  { id: "packetWriterGrowth", pattern: "Packet writer is growing from", scope: "any" },
  { id: "beginRunMessageThrow", pattern: "Exception encountered while processing message LobbyBeginRunMessage", scope: "any" },
  { id: "disconnect", pattern: "disconnected, reason:", scope: "any" },
  { id: "connectionFailureReason", pattern: "ConnectionFailureReason", scope: "any" },
  { id: "netError", pattern: "NetError", scope: "any" },
  { id: "seatNullReference", pattern: "NullReferenceException", scope: "seat" }
]);

const SEAT_NAMES = ["Ann", "Bo", "Cy", "Dee", "Eli", "Fay", "Gus", "Hal", "Ivy", "Jo"];

const MAX_MATCH_TEXT = 400;

// =================================================================================================
// pure helpers (unit-tested by scripts/test-probe-five-player-run.mjs)
// =================================================================================================

/** Thrown for a usage/config problem the operator must fix; distinct from a leg failing. */
export class ProbeUsageError extends Error {
  name = "ProbeUsageError";
}

const FLAGS = new Set(["--players", "--base", "--record", "--out", "--instance", "--seat-timeout-ms", "--seat-concurrency", "--embark-timeout-ms", "--combat-timeout-ms"]);

/**
 * Parses the probe's argv tail (everything after `node script.mjs`).
 *
 * Only `--players` has a default here; everything else stays null so resolveTargets() can tell
 * "the operator asked for this" from "fall back to the record, then to the built-in default".
 */
export function parseProbeArgs(argv = []) {
  const out = {
    players: 5,
    base: null,
    record: null,
    out: null,
    instance: null,
    seatTimeoutMs: 90_000,
    seatConcurrency: 2,
    embarkTimeoutMs: 120_000,
    combatTimeoutMs: 180_000
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!FLAGS.has(flag)) {
      throw new ProbeUsageError(`unknown argument '${flag}'; expected one of ${[...FLAGS].join(" ")}`);
    }
    const value = argv[i + 1];
    if (value === undefined || FLAGS.has(value)) {
      throw new ProbeUsageError(`${flag} requires a value`);
    }
    i += 1;
    switch (flag) {
      case "--players": {
        const players = Number(value);
        if (!Number.isInteger(players) || players < 2 || players > SEAT_MAX_SLOT) {
          throw new ProbeUsageError(`--players must be an integer in 2..${SEAT_MAX_SLOT}; got '${value}'`);
        }
        out.players = players;
        break;
      }
      case "--base": out.base = value; break;
      case "--record": out.record = value; break;
      case "--out": out.out = value; break;
      case "--instance": out.instance = value; break;
      default: {
        const ms = Number(value);
        if (!Number.isInteger(ms) || ms <= 0) {
          throw new ProbeUsageError(`${flag} must be a positive integer of milliseconds; got '${value}'`);
        }
        if (flag === "--seat-timeout-ms") out.seatTimeoutMs = ms;
        else if (flag === "--seat-concurrency") out.seatConcurrency = ms;
        else if (flag === "--embark-timeout-ms") out.embarkTimeoutMs = ms;
        else out.combatTimeoutMs = ms;
        break;
      }
    }
  }
  if (out.seatConcurrency < 1) {
    throw new ProbeUsageError("--seat-concurrency must be >= 1");
  }
  return out;
}

/**
 * Parses and validates a bring-up record (scripts/bring-up-five-player-instance.sh).
 *
 * Only the schema string is required: every other field is optional-with-fallback, because the record
 * is a convenience and the probe has to stay runnable against a hand-started host with nothing but
 * `--base`. A wrong/absent schema is a hard error -- silently treating an unknown document as a record
 * would hand the probe a plausible-looking set of wrong paths.
 */
export function parseBringupRecord(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ProbeUsageError(`--record is not JSON: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProbeUsageError("--record must contain a JSON object");
  }
  if (value.schema !== BRINGUP_SCHEMA) {
    throw new ProbeUsageError(
      `--record schema mismatch: expected "${BRINGUP_SCHEMA}", got ${JSON.stringify(value.schema ?? null)}`
    );
  }
  return value;
}

function portFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

/** Browser port -> couch seat slot, trying every plausible base. Null when the port is not on a grid. */
export function slotForPort(port, bases = [DEFAULT_HOST_PORT]) {
  for (const base of bases) {
    if (!Number.isInteger(base)) continue;
    const delta = port - base;
    if (delta <= 0 || delta % SEAT_PORT_STEP !== 0) continue;
    const slot = delta / SEAT_PORT_STEP;
    if (slot >= SEAT_MIN_SLOT && slot <= SEAT_MAX_SLOT) {
      return { slot, base, netId: SEAT_BASE_NET_ID + slot, playerId: `p:${SEAT_BASE_NET_ID + slot}` };
    }
  }
  return null;
}

export function seatLogPathFor(userDir, slot) {
  return `${userDir}/SlayTheSpire2/couch-coop/headless-slots/slot-${slot}/SlayTheSpire2/logs/godot.log`;
}

export function seatBridgeSocketFor(slot) {
  return `/tmp/spirectl-bridge-slot-${slot}.sock`;
}

/**
 * Folds CLI args, the bring-up record, the environment and the built-in defaults into one target.
 *
 * Precedence is CLI > record > env > default for every field, and each resolved value records WHERE it
 * came from so result.json can be read without re-deriving the fallback chain.
 */
export function resolveTargets({ args, record = null, env = {}, home = homedir(), repoRoot = REPO_ROOT_PATH, primaryRepoRoot = PRIMARY_REPO_ROOT }) {
  const sources = {};
  const pick = (name, ...candidates) => {
    for (const [source, value] of candidates) {
      if (value !== undefined && value !== null && value !== "") {
        sources[name] = source;
        return value;
      }
    }
    sources[name] = "none";
    return null;
  };

  const base = pick("baseUrl",
    ["cli", args.base],
    ["record", record?.browserBaseUrl],
    ["env", env.COUCHCOOP_GAME_ORIGIN],
    ["default", null]);

  const browserPort = pick("browserPort",
    ["cli", args.base ? portFromUrl(args.base) : null],
    ["record", Number.isInteger(record?.browserPort) ? record.browserPort : null],
    ["env", env.COUCHCOOP_GAME_ORIGIN ? portFromUrl(env.COUCHCOOP_GAME_ORIGIN) : null],
    ["default", DEFAULT_HOST_PORT]);

  const baseUrl = base ?? `http://127.0.0.1:${browserPort}`;
  if (base === null) sources.baseUrl = `derived:127.0.0.1:${browserPort}`;

  // "default" is not a real instance name -- it is how the lock resource and the record spell "no
  // --instance flag at all", so it must not be exported as SPIRECTL_INSTANCE.
  const rawInstance = pick("instance",
    ["cli", args.instance],
    ["record", record?.instance],
    ["env", env.SPIRECTL_INSTANCE],
    ["default", null]);
  const instance = rawInstance && rawInstance !== "default" ? rawInstance : null;

  const userDir = pick("userDir",
    ["record", record?.userDir],
    ["env", env.XDG_DATA_HOME],
    ["default", `${home}/.local/share`]);

  const seatLogGlob = pick("seatLogGlob",
    ["record", record?.seatLogGlob],
    ["default", seatLogPathFor(userDir, "*")]);

  // A worktree gets its own EMPTY .sts2/, so the host stdio fallback has to point at the primary
  // checkout, where `sts2 game launch` actually tees the streams.
  const launchDir = `${primaryRepoRoot}/.sts2/artifacts/game-launch`;
  const hostStdoutPath = pick("hostStdoutPath",
    ["record", record?.hostStdoutPath],
    ["default", `${launchDir}/game.stdout.log`]);
  const hostStderrPath = pick("hostStderrPath",
    ["record", record?.hostStderrPath],
    ["default", `${launchDir}/game.stderr.log`]);

  const outDir = args.out
    ? resolvePath(args.out)
    : resolvePath(repoRoot, ".sts2/artifacts/five-player-run");
  sources.outDir = args.out ? "explicit" : "default";

  // Seat ports are laid out from the COMPILED constant; the host's actually-bound port is tried too so
  // a port-walked host still resolves its seats.
  const portBases = [...new Set([browserPort, DEFAULT_HOST_PORT].filter(Number.isInteger))];

  return {
    players: args.players,
    seats: args.players - 1,
    // The tuning knobs belong to the resolved target, not just to argv: joinSeats(), waitForEmbark() and
    // leg 6 all read them off `targets`. While they were missing here every one of them was `undefined`,
    // and `targets.seatConcurrency` in particular collapsed mapWithConcurrency's bound to NaN -- see the
    // note on checkSeatRecords() for what that did to leg 2.
    seatConcurrency: args.seatConcurrency,
    seatTimeoutMs: args.seatTimeoutMs,
    embarkTimeoutMs: args.embarkTimeoutMs,
    combatTimeoutMs: args.combatTimeoutMs,
    baseUrl,
    browserPort,
    portBases,
    instance,
    userDir,
    seatLogGlob,
    hostStdoutPath,
    hostStderrPath,
    outDir,
    display: record?.display ?? null,
    gamePid: record?.gamePid ?? null,
    modsSource: record?.modsSource ?? null,
    recordMods: Array.isArray(record?.mods) ? record.mods : null,
    hasRecord: Boolean(record),
    sources
  };
}

/** The live-QA resources this probe drives: the install, the host game, and every port it touches. */
export function lockResourcesFor(targets) {
  const resources = [
    "shared:install",
    `exclusive:game:${targets.instance ?? "default"}`,
    `exclusive:browser:${targets.browserPort}`
  ];
  for (let slot = SEAT_MIN_SLOT; slot < SEAT_MIN_SLOT + targets.seats; slot += 1) {
    resources.push(`exclusive:port:${DEFAULT_HOST_PORT + slot * SEAT_PORT_STEP}`);
  }
  return resources;
}

/**
 * Reads `sts2 game mods active` and decides the setup gate.
 *
 * Returns a verdict rather than throwing so the caller can downgrade it to informational at the
 * control player count, and so the fix-up text is built in one testable place.
 */
export function evaluateModGate(payload, { players, fatal, modsSource = null }) {
  const mods = Array.isArray(payload?.mods) ? payload.mods : [];
  const byId = new Map(mods.map(entry => [String(entry?.id ?? ""), entry]));
  const required = byId.get(REQUIRED_MOD_ID) ?? null;
  const forbidden = byId.get(FORBIDDEN_MOD_ID) ?? null;

  const problems = [];
  if (!required) {
    problems.push(`${REQUIRED_MOD_ID} is not installed (not listed by \`sts2 game mods active\`)`);
  } else if (required.enabled !== true) {
    problems.push(`${REQUIRED_MOD_ID} is installed but not enabled (loadState=${JSON.stringify(required.loadState ?? null)})`);
  } else if (required.active !== true) {
    // Enabled-but-inactive is the interesting failure: the loadout says yes and the runtime says no,
    // which is what a mod that failed to load, or a game that has not been restarted, looks like.
    problems.push(`${REQUIRED_MOD_ID} is enabled but NOT active (loadState=${JSON.stringify(required.loadState ?? null)}, errors=${JSON.stringify(required.errors ?? [])})`);
  }
  if (forbidden?.active === true) {
    problems.push(`${FORBIDDEN_MOD_ID} is ACTIVE; the two limit mods rewrite the same multiplayer wire fields and must not run together`);
  }

  const fixUp = [
    `# Subscribe to and enable "Unlimited: No Player Limit" (Workshop ${REQUIRED_MOD_WORKSHOP_ID}), then restart the game.`,
    `# Disable "Multiplayer Limit Break" (Workshop ${FORBIDDEN_MOD_WORKSHOP_ID}) -- never run both.`,
    "sts2 --json game mods settings   # shows the settings.save this reads, plus enabledIds/disabledIds",
    "sts2 --json game mods active     # re-check after the restart",
    ...(modsSource ? [`# the bring-up record built its loadout from: ${modsSource}`] : [])
  ].join("\n");

  return {
    ok: problems.length === 0,
    fatal: fatal && problems.length > 0,
    players,
    problems,
    fixUp,
    required,
    forbidden,
    activeIds: Array.isArray(payload?.activeIds) ? payload.activeIds : [],
    enabledIds: Array.isArray(payload?.enabledIds) ? payload.enabledIds : [],
    notices: Array.isArray(payload?.notices) ? payload.notices : []
  };
}

/**
 * Picks a character for every player such that nobody is asked to re-select what it already has
 * (which the game refuses with reasonCode "not_visible").
 *
 * DISTINCT characters are preferred, per the leg-4 contract, and are found by an exact bipartite
 * matching rather than a greedy pass -- greedy paints itself into a corner on rosters that are
 * perfectly satisfiable, and its repair swap cannot tell that case apart from a genuinely infeasible
 * one. Infeasible really does happen: four players all sitting on IRONCLAD with four characters
 * available cannot all move to a DIFFERENT and distinct character, and a fresh lobby is exactly where
 * everybody shares a default. So when no distinct assignment exists -- too few characters, or too many
 * players holding the same one -- the weaker but sufficient invariant (assignment != current) is kept
 * and `distinct:false` is reported rather than the probe pretending it did something it could not.
 */
export function assignCharacters(players, characterIds) {
  const ids = characterIds.filter(id => typeof id === "string" && id && id !== "RANDOM_CHARACTER");
  if (ids.length === 0) {
    throw new ProbeError("no assignable characters were advertised (characterButtons was empty or all RANDOM_CHARACTER)");
  }
  const current = players.map(player => player?.characterId ?? null);

  const distinct = matchDistinctCharacters(current, ids);
  if (distinct) {
    return {
      distinct: true,
      assignments: players.map((player, index) => ({ playerId: player.id, from: current[index], to: distinct[index] })),
      note: null
    };
  }

  const assignments = players.map((player, index) => {
    const to = ids.find(id => id !== current[index]) ?? null;
    if (!to) {
      throw new ProbeError(`player ${player?.id} already holds the only assignable character ${current[index]}`);
    }
    return { playerId: player.id, from: current[index], to };
  });
  return {
    distinct: false,
    assignments,
    note: `no distinct assignment exists for ${players.length} players over ${ids.length} characters `
      + `(currents ${JSON.stringify(current)}) -- duplicates are unavoidable, every player still moves off its own character`
  };
}

/**
 * Kuhn's augmenting-path matching: player i may take any character except `current[i]`. Returns the
 * per-player choice, or null when no perfect matching exists. n is the lobby size, so the O(V*E) form
 * is far more than fast enough and is worth the exactness.
 */
function matchDistinctCharacters(current, ids) {
  const holderOfId = new Map();
  const augment = (player, seen) => {
    for (const id of ids) {
      if (id === current[player] || seen.has(id)) continue;
      seen.add(id);
      const holder = holderOfId.get(id);
      if (holder === undefined || augment(holder, seen)) {
        holderOfId.set(id, player);
        return true;
      }
    }
    return false;
  };
  for (let player = 0; player < current.length; player += 1) {
    if (!augment(player, new Set())) return null;
  }
  const chosen = new Array(current.length).fill(null);
  for (const [id, player] of holderOfId) chosen[player] = id;
  return chosen;
}

/**
 * Aliveness for the leg-5 gate. `run.players[]` carries no alive/isDead field -- the CLI's run player
 * projection is id/netId/displayName/characterId/isLocal/isHost/isRemote/creature/gold/deck/relics/
 * overlays/inventoryComplete/notices -- so HP is the only signal, and a missing creature is reported
 * as "unknown" rather than assumed either way.
 */
export function runPlayerAliveness(runPlayers) {
  return (runPlayers ?? []).map(player => {
    const creature = player?.creature ?? null;
    const currentHp = typeof creature?.currentHp === "number" ? creature.currentHp : null;
    const status = creature === null ? "unknown" : currentHp === null ? "unknown" : currentHp > 0 ? "alive" : "dead";
    return {
      id: player?.id ?? null,
      netId: player?.netId ?? null,
      displayName: player?.displayName ?? null,
      characterId: player?.characterId ?? null,
      isHost: player?.isHost ?? null,
      isLocal: player?.isLocal ?? null,
      isRemote: player?.isRemote ?? null,
      currentHp,
      maxHp: typeof creature?.maxHp === "number" ? creature.maxHp : null,
      status
    };
  });
}

/**
 * Grep-scans captured logs for LOG_SIGNATURES.
 *
 * `files` are `{label, path, role, text, baselineLines}`; `role` is "host-stdout" | "host-stderr" |
 * "seat" and gates the seat-scoped signatures. `baselineLines` is the file's line count taken just
 * before the ready/embark step, which is what makes "before or after embark" answerable from the
 * artifact alone even though godot.log carries no timestamps.
 */
/**
 * Splits log text into its REAL lines: a trailing newline does not make a final empty line.
 *
 * This is load-bearing, not tidiness. The baseline line count and the scanner's line numbers are
 * compared against each other to decide `phase`, so counting the empty tail in one place and not the
 * other shifts every post-embark hit into "pre-embark" by exactly one line -- which is precisely the
 * conclusion this artifact exists to support.
 */
export function splitLogLines(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  return text.replace(/\n$/, "").split("\n");
}

export function scanLogSignatures(files, { capturedAt = new Date().toISOString() } = {}) {
  const scanned = [];
  const bySignature = new Map(LOG_SIGNATURES.map(signature => [signature.id, {
    id: signature.id,
    pattern: signature.pattern,
    scope: signature.scope,
    total: 0,
    byFile: {},
    first: null
  }]));

  for (const file of files ?? []) {
    const text = typeof file?.text === "string" ? file.text : "";
    const lines = splitLogLines(text);
    const baselineLines = Number.isInteger(file?.baselineLines) ? file.baselineLines : null;
    const hits = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === "") continue;
      for (const signature of LOG_SIGNATURES) {
        if (signature.scope === "seat" && file.role !== "seat") continue;
        if (!line.includes(signature.pattern)) continue;
        const lineNumber = index + 1;
        const hit = {
          signature: signature.id,
          lineNumber,
          phase: baselineLines === null ? "unknown" : lineNumber <= baselineLines ? "pre-embark" : "post-embark",
          text: line.length > MAX_MATCH_TEXT ? `${line.slice(0, MAX_MATCH_TEXT)}...` : line
        };
        hits.push(hit);
        const summary = bySignature.get(signature.id);
        summary.total += 1;
        summary.byFile[file.label] = (summary.byFile[file.label] ?? 0) + 1;
        summary.first ??= { file: file.label, path: file.path ?? null, lineNumber, phase: hit.phase, text: hit.text };
      }
    }
    scanned.push({
      label: file.label,
      path: file.path ?? null,
      role: file.role ?? "unknown",
      lines: lines.length,
      bytes: Buffer.byteLength(text, "utf8"),
      baselineLines,
      hits,
      // Per-file signature order. Within one file this IS the chronology; across files it is not,
      // which is what `phase` exists to cover.
      ordering: hits.map(hit => ({ signature: hit.signature, lineNumber: hit.lineNumber, phase: hit.phase }))
    });
  }

  return {
    schema: SIGNALS_SCHEMA,
    capturedAt,
    timestampsAvailable: false,
    note: "godot.log has no per-line timestamps. Order within a file is line order; across files use `phase`, which is relative to the line count captured immediately before the character-select/ready step -- i.e. everything the embark could have produced is `post-embark`.",
    signatures: LOG_SIGNATURES.map(signature => ({ id: signature.id, pattern: signature.pattern, scope: signature.scope })),
    files: scanned,
    bySignature: Object.fromEntries([...bySignature.values()].map(summary => [summary.id, summary]))
  };
}

/**
 * Cross-checks the archive against what the probe itself watched happen.
 *
 * Every zero in `bySignature` means one of two very different things -- "that never happened" or "the
 * scan never saw the file it should have" -- and signals.json cannot tell those apart on its own.
 * One pairing can: waitForEmbark() watches `state.run` appear, and a run that began logs
 * "Embarking on a multiplayer run. Players:" by definition. So an embarked run with zero embark hits
 * means the archive is reading logs this run did not write (a stale hostStdoutPath or userDir -- a
 * worktree's own `.sts2/` is empty, which is exactly how that goes wrong) or the game's wording has
 * moved. Either way every OTHER zero in the file is worthless too, and nothing else in the probe would
 * say so: an all-zero signals.json and a quiet run look identical in the artifact.
 *
 * Warnings, never a verdict. A run whose legs all passed is still a good run, and a gap in its evidence
 * must not be laundered into a leg failure -- the caller prints these and puts them in result.json.
 */
export function checkEvidenceConsistency({ embark = null, signals = null } = {}) {
  const warnings = [];
  // Nothing to be inconsistent WITH until the run demonstrably began: a probe that never got past
  // leg 4 is expected to have no embark line anywhere.
  if (embark?.hasRun !== true) return warnings;

  if (!signals) {
    warnings.push(
      "the run embarked but no signals.json was written, so this run has NO log evidence behind it "
      + "-- archiveEvidence() failed; its reason is on stderr as `evidence archive failed`"
    );
    return warnings;
  }

  const files = Array.isArray(signals.files) ? signals.files : [];
  const scannedLines = files.reduce((total, file) => total + (Number.isInteger(file?.lines) ? file.lines : 0), 0);
  if ((signals.bySignature?.embark?.total ?? 0) === 0) {
    const pattern = LOG_SIGNATURES.find(signature => signature.id === "embark").pattern;
    warnings.push(
      `the run embarked (state.run carried ${embark.runPlayers ?? "?"} player(s)) but "${pattern}" is in NONE `
      + `of the ${files.length} archived log(s), across ${scannedLines} scanned lines. A run that began logs `
      + "that line, so the archive is reading the wrong files or the game's wording has moved: every other "
      + "zero in bySignature is untrustworthy until signals.archive[].sourcePath and .mtime are checked."
    );
  }
  return warnings;
}

/** Assembles result.json. `ok` is false as soon as any leg failed; the FIRST failure is the headline. */
export function buildResult({ legs, targets, args, startedAt, finishedAt, evidence = {}, error = null }) {
  const failing = legs.find(leg => leg.verdict === "fail") ?? null;
  return {
    schema: RESULT_SCHEMA,
    ok: failing === null && error === null,
    failingLeg: failing ? { n: failing.n, name: failing.name, detail: failing.detail, evidence: failing.evidence ?? [] } : null,
    error: error ? { message: error.message, kind: error.kind ?? "probe" } : null,
    // checkEvidenceConsistency()'s findings, at the top level because they qualify everything below
    // them: a run can pass every leg and still have handed back an archive that proves none of it.
    // They never move `ok` -- thin evidence is not a failed leg.
    warnings: Array.isArray(evidence?.warnings) ? evidence.warnings : [],
    players: targets.players,
    seats: targets.seats,
    control: targets.players === 4,
    startedAt,
    finishedAt,
    target: {
      baseUrl: targets.baseUrl,
      browserPort: targets.browserPort,
      instance: targets.instance,
      userDir: targets.userDir,
      seatLogGlob: targets.seatLogGlob,
      hostStdoutPath: targets.hostStdoutPath,
      hostStderrPath: targets.hostStderrPath,
      outDir: targets.outDir,
      hasRecord: targets.hasRecord,
      sources: targets.sources
    },
    args,
    legs,
    evidence
  };
}

/**
 * Runs `worker` over `items` with at most `limit` in flight. Results keep input order.
 *
 * The bound is validated rather than coerced, and the result array is filled rather than left sparse.
 * Both guard the same failure: a non-numeric `limit` made `Math.min(Math.max(1, limit), …)` NaN, and
 * `Array.from({length: NaN})` builds ZERO workers, so this returned an array of holes that had never
 * been written. Holes are invisible to `filter`/`map`/`flatMap`, so the caller saw no failures at all.
 */
export async function mapWithConcurrency(items, limit, worker) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError(`mapWithConcurrency needs a positive integer bound; got ${typeof limit} ${String(limit)}`);
  }
  const results = new Array(items.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), Math.max(1, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function seatNameFor(index) {
  return SEAT_NAMES[index] ?? `Seat${index + 1}`;
}

/**
 * Grades leg 2's seat records, and REFUSES to pass on anything short of positive per-seat evidence.
 * Returns one human-readable problem per seat that cannot be shown to have joined; an empty array is
 * the only thing that lets the leg pass.
 *
 * This exists because leg 2 once reported `pass` in 243 ms with `data: [null,null,null,null]` against a
 * live game: `targets.seatConcurrency` was undefined, mapWithConcurrency built zero workers and returned
 * a fully SPARSE array, and every array method skips holes -- `filter` found no failures, `flatMap`
 * collected no screenshots, and `map(…).join(", ")` rendered four holes as ", , , ". Leg 3 then timed out
 * on a one-player lobby, which reads exactly like the game dropping four seats and was nothing of the
 * kind. So the absence of a record is now itself a failure, distinguished from a seat that tried and
 * failed, and "ok" is not taken at its word without the slot/port and ENet evidence behind it.
 */
export function checkSeatRecords(joined, expected) {
  if (!Array.isArray(joined)) {
    return [`leg 2 produced ${joined === null ? "null" : typeof joined}, not an array of ${expected} seat records`];
  }
  const problems = [];
  if (joined.length !== expected) {
    problems.push(`expected ${expected} seat records, got ${joined.length}`);
  }
  for (let index = 0; index < Math.max(joined.length, expected); index += 1) {
    const label = `seat ${index + 1} (${seatNameFor(index)})`;
    // A HOLE is not the same as a recorded null: it means the join never ran, so say that.
    if (index >= joined.length || !(index in joined)) {
      problems.push(`${label}: no record at all -- the join never ran`);
      continue;
    }
    const seat = joined[index];
    if (seat === null || typeof seat !== "object") {
      problems.push(`${label}: ${String(seat)} instead of a seat record`);
      continue;
    }
    if (seat.ok !== true) {
      problems.push(`${label}: ${seat.detail ?? "did not join, and recorded no detail"}`);
      continue;
    }
    if (!Number.isInteger(seat.slot) || !Number.isInteger(seat.port)) {
      problems.push(`${label}: reported ok but resolved no seat port (slot=${seat.slot}, port=${seat.port})`);
      continue;
    }
    if (!Array.isArray(seat.enetEvidence) || seat.enetEvidence.length === 0) {
      problems.push(`${label}: reported ok on slot ${seat.slot} but carries no ENet handshake evidence`);
    }
  }
  return problems;
}

// =================================================================================================
// live plumbing
// =================================================================================================

const note = (...parts) => console.error("[five-player-run]", ...parts);

/**
 * `sts2 --json ...` against a SPECIFIC bridge socket (a couch seat's own instance).
 *
 * SPIRECTL_INSTANCE is cleared deliberately: in the CLI the instance name owns the bridge path and
 * would win over SPIRECTL_BRIDGE_SOCKET_PATH.
 */
async function sts2AtSocket(socketPath, args, { mode = "dangerous" } = {}) {
  const env = { ...process.env, DOTNET_ROLL_FORWARD: "Major", SPIRECTL_BRIDGE_SOCKET_PATH: socketPath };
  delete env.SPIRECTL_INSTANCE;
  const result = await run("sts2", ["--mode", mode, "--json", ...args], { env });
  if (result.code !== 0) {
    return { ok: false, value: null, stderr: (result.stderr || result.stdout).slice(0, 600) };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout), stderr: null };
  } catch (error) {
    return { ok: false, value: null, stderr: `unparseable JSON: ${error.message}` };
  }
}

/**
 * Runs a semantic action for a player, falling back to that seat's OWN bridge when the host bridge
 * refuses it. Never throws: the full response of every attempt is the evidence this probe exists to
 * produce, so a refusal is returned, not raised.
 */
export async function actForPlayer(playerId, args, seatsByPlayerId) {
  const attempts = [];
  let payload = null;
  try {
    payload = await sts2(["act", ...args, "--player-id", playerId]);
    attempts.push({ via: "host-bridge", accepted: payload?.accepted === true, response: compactAction(payload) });
  } catch (error) {
    attempts.push({ via: "host-bridge", accepted: false, error: error.message });
  }
  if (payload?.accepted === true) {
    return { accepted: true, via: "host-bridge", attempts };
  }

  const seat = seatsByPlayerId.get(playerId);
  if (seat?.slot) {
    const socket = seatBridgeSocketFor(seat.slot);
    const outcome = await sts2AtSocket(socket, ["act", ...args, "--player-id", playerId]);
    attempts.push({
      via: `seat-bridge:${socket}`,
      accepted: outcome.value?.accepted === true,
      response: outcome.ok ? compactAction(outcome.value) : null,
      error: outcome.stderr
    });
    if (outcome.value?.accepted === true) {
      return { accepted: true, via: "seat-bridge", attempts };
    }
  }
  return { accepted: false, via: null, attempts };
}

function compactAction(payload) {
  if (!payload || typeof payload !== "object") return null;
  return {
    accepted: payload.accepted ?? null,
    actionId: payload.actionId ?? payload.id ?? null,
    reasonCode: payload.reasonCode ?? payload.actionFailure?.reasonCode ?? null,
    message: payload.message ?? payload.actionFailure?.message ?? null,
    ownerPlayerId: payload.ownerPlayerId ?? payload.actionFailure?.ownerPlayerId ?? null,
    remoteOrchestration: payload.remoteOrchestration ?? null
  };
}

async function readTextIfPresent(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    return { missing: true, reason: error.code ?? error.message };
  }
}

/** Real line count, counted exactly the way scanLogSignatures numbers lines. */
async function countLines(path) {
  const text = await readTextIfPresent(path);
  if (typeof text !== "string") return null;
  return splitLogLines(text).length;
}

/** Every seat log that exists under the user dir, whether or not the probe spawned it. */
async function discoverSeatLogs(userDir) {
  const root = `${userDir}/SlayTheSpire2/couch-coop/headless-slots`;
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const match = /^slot-(\d+)$/.exec(entry.name);
    if (!match) continue;
    const slot = Number(match[1]);
    const path = seatLogPathFor(userDir, slot);
    if (existsSync(path)) found.push({ slot, path });
  }
  return found.sort((a, b) => a.slot - b.slot);
}

// =================================================================================================
// main
// =================================================================================================

async function main(argv) {
  const startedAt = new Date().toISOString();
  const args = parseProbeArgs(argv);

  // The scenario runner writes {hookName, input, scenario, step} to the hook's stdin; `input` can carry
  // the same keys as the flags. CLI flags win. Guarded by a timeout so an inherited, never-closing
  // stdin cannot wedge a plain terminal run.
  const hookInput = await readHookStdin();
  for (const key of ["players", "base", "record", "out", "instance"]) {
    if (hookInput?.[key] !== undefined && argv.indexOf(`--${key}`) < 0) {
      args[key] = key === "players" ? Number(hookInput[key]) : String(hookInput[key]);
    }
  }
  // Re-validate: the scenario's `input` block bypasses parseProbeArgs entirely.
  if (!Number.isInteger(args.players) || args.players < 2 || args.players > SEAT_MAX_SLOT) {
    throw new ProbeUsageError(`players must be an integer in 2..${SEAT_MAX_SLOT}; got ${JSON.stringify(hookInput?.players ?? args.players)}`);
  }

  const recordPath = args.record ?? process.env.COUCHCOOP_FIVE_PLAYER_RECORD ?? null;
  let record = null;
  if (recordPath) {
    record = parseBringupRecord(await readFile(recordPath, "utf8"));
  }
  const targets = resolveTargets({ args, record, env: process.env });
  if (targets.instance) {
    // Threaded by env so every shared probe-lib helper targets the same instance (see header).
    process.env.SPIRECTL_INSTANCE = targets.instance;
  }

  await mkdir(targets.outDir, { recursive: true });
  await rm(resolvePath(targets.outDir, "result.json"), { force: true });

  note(`players=${targets.players} base=${targets.baseUrl} instance=${targets.instance ?? "(default)"} out=${targets.outDir}`);
  note(`record=${recordPath ?? "(none -- using fallbacks)"}`);

  const legs = [];
  const evidence = { recordPath, screenshots: [], archives: [], seats: [], actions: {}, signalsPath: null };
  let lock = null;
  let fatal = null;

  const leg = async (n, name, assertion, body) => {
    const started = Date.now();
    const entry = { n, name, assertion, verdict: "pending", detail: null, evidence: [], data: null, ms: 0 };
    legs.push(entry);
    try {
      const outcome = await body(entry);
      entry.verdict = outcome?.verdict ?? "pass";
      entry.detail = outcome?.detail ?? null;
      entry.data = outcome?.data ?? null;
      if (outcome?.evidence) entry.evidence.push(...outcome.evidence);
    } catch (error) {
      entry.verdict = "fail";
      entry.detail = error instanceof ProbeError || error instanceof ProbeUsageError
        ? error.message
        : `${error?.name}: ${error?.message}`;
      if (!(error instanceof ProbeError) && !(error instanceof ProbeUsageError)) {
        entry.stack = error?.stack;
      }
    } finally {
      entry.ms = Date.now() - started;
    }
    note(`leg ${n} ${name}: ${entry.verdict}${entry.detail ? ` -- ${entry.detail}` : ""} (${entry.ms}ms)`);
    return entry;
  };

  try {
    lock = acquireLiveLock(targets);
    evidence.liveLock = lock;

    // -------------------------------------------------------------------------------------------
    // LEG 0 -- setup gate
    // -------------------------------------------------------------------------------------------
    const modLeg = await leg(0, "setup-gate", `${REQUIRED_MOD_ID} enabled+active, ${FORBIDDEN_MOD_ID} not active`, async () => {
      // `game mods active` goes through the bridge, so it reports the LIVE loadout of whichever instance
      // SPIRECTL_INSTANCE selects -- not what settings.save says (that is `game mods settings`). An
      // unreachable bridge throws straight out of here and is fatal at ANY player count: only the mod
      // VERDICT is downgraded to informational for the control, never "there is no game".
      const payload = await sts2(["game", "mods", "active"]);
      const gate = evaluateModGate(payload, {
        players: targets.players,
        fatal: targets.players !== 4,
        modsSource: targets.modsSource
      });
      await writeFile(resolvePath(targets.outDir, "mods-active.json"), `${JSON.stringify(payload, null, 2)}\n`);
      if (gate.ok) {
        return { verdict: "pass", detail: `active: ${gate.activeIds.join(", ") || "(none)"}`, data: gate, evidence: [resolvePath(targets.outDir, "mods-active.json")] };
      }
      note(gate.fixUp);
      if (!gate.fatal) {
        return { verdict: "info", detail: `control run (--players ${targets.players}); ${gate.problems.join("; ")}`, data: gate, evidence: [resolvePath(targets.outDir, "mods-active.json")] };
      }
      throw new ProbeError(`${gate.problems.join("; ")}\nFIX-UP:\n${gate.fixUp}`);
    });
    if (modLeg.verdict === "fail") throw new StopProbe();

    // -------------------------------------------------------------------------------------------
    // LEG 1 -- host lobby, and the proof the cap really is raised
    // -------------------------------------------------------------------------------------------
    const lobbyLeg = await leg(1, "host-lobby", `netGameType == "host" and lobby.maxPlayers >= ${targets.players}`, async () => {
      const lobby = await holdHostLobby();
      assert(lobby.netGameType === "host", `lobby.netGameType is ${JSON.stringify(lobby.netGameType)}, expected "host"`);
      assert(
        Number.isInteger(lobby.maxPlayers) && lobby.maxPlayers >= targets.players,
        `lobby.maxPlayers is ${JSON.stringify(lobby.maxPlayers)}; ${targets.players} players need >= ${targets.players}. `
        + `The stock lobby reports 4 -- a 4 here means "${REQUIRED_MOD_ID}" is not raising the cap on this lobby.`
      );
      evidence.screenshots.push(...await tryScreenshot(targets, "01-host-lobby.png"));
      return { detail: `maxPlayers=${lobby.maxPlayers} hostPlayerId=${lobby.hostPlayerId}`, data: lobby };
    });
    if (lobbyLeg.verdict === "fail") throw new StopProbe();

    // -------------------------------------------------------------------------------------------
    // LEG 2 -- seats join through the real browser + ENet path
    // -------------------------------------------------------------------------------------------
    const seatLeg = await leg(2, "seats-join", `${targets.seats} browser seats join and each shows a real ENet handshake in its own godot.log`, async entry => {
      const joined = await joinSeats(targets, evidence);
      // Both of these are hole- and null-tolerant on purpose: a partial join must still hand the caller
      // every screenshot and every seat record it did get, and checkSeatRecords() -- not a TypeError
      // thrown while formatting -- is what reports the gap.
      entry.evidence.push(...joined.flatMap(seat => seat?.screenshots ?? []));
      entry.data = joined;
      const problems = checkSeatRecords(joined, targets.seats);
      if (problems.length > 0) {
        throw new ProbeError(`${problems.length} of ${targets.seats} seats have no proof they joined: ${problems.join(" | ")}`);
      }
      return { detail: joined.map(seat => `${seat.name}->slot ${seat.slot}/port ${seat.port} (${seat.ms}ms)`).join(", "), data: joined };
    });
    const seats = Array.isArray(seatLeg.data) ? seatLeg.data.filter(seat => seat?.ok) : [];
    const seatsByPlayerId = new Map(seats.filter(seat => seat.playerId).map(seat => [seat.playerId, seat]));
    evidence.seats = seats.map(seat => ({ name: seat.name, slot: seat.slot, port: seat.port, playerId: seat.playerId, logPath: seat.logPath, portBase: seat.portBase }));
    if (seatLeg.verdict === "fail") throw new StopProbe();

    // -------------------------------------------------------------------------------------------
    // LEG 3 -- roster
    // -------------------------------------------------------------------------------------------
    const rosterLeg = await leg(3, "roster", `lobby.players.length == ${targets.players}, host + couch netIds, seat ports on the base+slot*10 grid`, async () => {
      const lobby = await waitFor(
        async () => (await state())?.characterSelect?.lobby ?? null,
        value => (value?.players ?? []).length === targets.players,
        { attempts: 40, intervalMs: 500, what: `${targets.players} lobby players` }
      );
      const players = lobby.players ?? [];
      const hostId = lobby.hostPlayerId;
      assert(players.some(player => player.id === hostId), `the host (${hostId}) is not in lobby.players`);

      const seatPlayers = players.filter(player => player.id !== hostId);
      const seatIds = new Set();
      for (const player of seatPlayers) {
        const match = /^p:(\d+)$/.exec(player.id ?? "");
        assert(match, `lobby player id ${JSON.stringify(player.id)} is not the expected "p:<netId>" form`);
        const netId = Number(match[1]);
        assert(
          netId >= SEAT_BASE_NET_ID + SEAT_MIN_SLOT && netId <= SEAT_BASE_NET_ID + SEAT_MAX_SLOT,
          `lobby player ${player.id} is outside the couch seat band ${SEAT_BASE_NET_ID + SEAT_MIN_SLOT}..${SEAT_BASE_NET_ID + SEAT_MAX_SLOT}`
        );
        assert(!seatIds.has(player.id), `duplicate lobby player id ${player.id}`);
        seatIds.add(player.id);
      }

      const observed = new Set(seats.map(seat => seat.playerId).filter(Boolean));
      const missing = [...observed].filter(id => !seatIds.has(id));
      assert(missing.length === 0, `seats joined on ports implying ${[...observed].join(", ")} but the lobby is missing ${missing.join(", ")}`);

      for (const seat of seats) {
        const expected = seat.portBase + seat.slot * SEAT_PORT_STEP;
        assert(seat.port === expected, `seat ${seat.name} is on port ${seat.port}, not ${expected} (base ${seat.portBase} + slot ${seat.slot} * ${SEAT_PORT_STEP})`);
      }

      return {
        detail: `players=${players.map(player => player.id).join(", ")} ports=${seats.map(seat => seat.port).join(", ")}`,
        data: { lobby, seatIds: [...seatIds] }
      };
    });
    if (rosterLeg.verdict === "fail") throw new StopProbe();
    const lobbyBeforeReady = rosterLeg.data.lobby;

    // -------------------------------------------------------------------------------------------
    // LEG 4 -- characters + ready (readying everyone is what begins the run)
    // -------------------------------------------------------------------------------------------
    // Baselines FIRST: everything logged from here on is a candidate for being embark-caused, and a
    // leg-4 failure must still leave a dated artifact behind.
    const baselines = await captureLogBaselines(targets, seats);
    const readyLeg = await leg(4, "characters-and-ready", "every player selects a character and readies; readying all of them is the embark trigger", async () => {
      const snapshot = await state();
      const characterIds = (snapshot?.characterSelect?.characterButtons ?? [])
        .filter(button => button?.isLocked !== true)
        .map(button => button?.characterId)
        .filter(Boolean);
      const plan = assignCharacters(lobbyBeforeReady.players ?? [], characterIds);
      evidence.actions.characterPlan = plan;
      if (!plan.distinct) note(`character plan is NOT distinct: ${plan.note}`);

      for (const assignment of plan.assignments) {
        const outcome = await actForPlayer(assignment.playerId, ["select-character", "--character", assignment.to], seatsByPlayerId);
        evidence.actions[`select-character:${assignment.playerId}`] = outcome;
        assert(outcome.accepted, `select-character ${assignment.from} -> ${assignment.to} for ${assignment.playerId} was refused: ${JSON.stringify(outcome.attempts)}`);
        await sleep(300);
      }

      for (const player of lobbyBeforeReady.players ?? []) {
        const outcome = await actForPlayer(player.id, ["ready"], seatsByPlayerId);
        evidence.actions[`ready:${player.id}`] = outcome;
        assert(outcome.accepted, `ready for ${player.id} was refused: ${JSON.stringify(outcome.attempts)}`);
        await sleep(300);
      }
      return { detail: `assigned ${plan.assignments.map(a => `${a.playerId}=${a.to}`).join(", ")}; readied ${(lobbyBeforeReady.players ?? []).length}`, data: plan };
    });

    // -------------------------------------------------------------------------------------------
    // Evidence capture around embark -- ALWAYS, whatever leg 4 and leg 5 do.
    // -------------------------------------------------------------------------------------------
    // A failed leg 4 never pressed ready, so there is nothing to wait for -- take the snapshot and
    // archive rather than burning the full embark budget.
    const embark = await waitForEmbark(targets, readyLeg.verdict === "fail" ? 10_000 : targets.embarkTimeoutMs);
    evidence.embark = embark;
    const archived = await archiveEvidence(targets, seats, baselines, evidence);
    evidence.signalsPath = archived.signalsPath;
    // A scan is worth exactly what its inputs are. Say so loudly, here and in result.json, when the
    // archive cannot corroborate an embark this probe watched happen -- otherwise a signals.json full
    // of zeros reads as "the game was quiet" when it means "we scanned the wrong files".
    evidence.warnings = checkEvidenceConsistency({ embark, signals: archived.signals });
    for (const warning of evidence.warnings) note(`WARNING: ${warning}`);
    if (readyLeg.verdict === "fail") throw new StopProbe();

    // -------------------------------------------------------------------------------------------
    // LEG 5 -- THE GATE. Expected to fail at N=5 today.
    // -------------------------------------------------------------------------------------------
    const gateLeg = await leg(5, "run-roster", `run.players.length == ${targets.players}, every entry alive, every seat mirror still serving`, async entry => {
      entry.evidence.push(...archived.paths);
      const snapshot = await state();
      const runState = snapshot?.run ?? null;
      assert(runState, `there is no active run after embark (state.run is null); rootScene=${JSON.stringify(snapshot?.rootScene ?? null)}`);
      const aliveness = runPlayerAliveness(runState.players);
      evidence.runPlayers = aliveness;
      const mirrors = await probeSeatMirrors(seats);
      evidence.seatMirrors = mirrors;
      // The seats' OWN view of the run. When the host reports a lonely run, this says whether the seat
      // processes even entered one -- which is the discriminator the log signatures cannot give.
      evidence.seatRunViews = await captureSeatRunViews(seats);
      await writeFile(resolvePath(targets.outDir, "run-state.json"), `${JSON.stringify({ run: runState, aliveness, mirrors, seatRunViews: evidence.seatRunViews }, null, 2)}\n`);
      entry.evidence.push(resolvePath(targets.outDir, "run-state.json"));

      assert(
        aliveness.length === targets.players,
        `run.players.length is ${aliveness.length}, expected ${targets.players}. In-run roster: ${JSON.stringify(aliveness)}`
      );
      const notAlive = aliveness.filter(player => player.status !== "alive");
      assert(notAlive.length === 0, `run players not alive: ${JSON.stringify(notAlive)}`);
      const deadMirrors = mirrors.filter(mirror => !mirror.serving);
      assert(deadMirrors.length === 0, `seat mirrors stopped serving: ${JSON.stringify(deadMirrors)}`);
      return { detail: `run.players=${aliveness.map(player => `${player.id}:${player.currentHp}/${player.maxHp}`).join(", ")}`, data: { aliveness, mirrors } };
    });
    if (gateLeg.verdict === "fail") throw new StopProbe();

    // -------------------------------------------------------------------------------------------
    // LEG 6 -- playable
    // -------------------------------------------------------------------------------------------
    await leg(6, "playable-turn", "one full combat turn resolves: every player ends turn, the enemy turn runs, control returns", async () => {
      return await playOneCombatTurn(targets, seatsByPlayerId, evidence);
    });
  } catch (error) {
    if (!(error instanceof StopProbe)) {
      fatal = { message: error instanceof ProbeError || error instanceof ProbeUsageError ? error.message : `${error?.name}: ${error?.message}`, kind: error?.constructor?.name ?? "Error" };
      note(`aborted: ${fatal.message}`);
    }
  } finally {
    try {
      await closeBrowsers();
    } catch { /* best effort */ }
    releaseLiveLock(lock);
  }

  const result = buildResult({
    legs: legs.map(({ data, ...rest }) => ({ ...rest, data: summarizeLegData(data) })),
    targets,
    args,
    startedAt,
    finishedAt: new Date().toISOString(),
    evidence,
    error: fatal
  });

  const resultPath = resolvePath(targets.outDir, "result.json");
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);

  const artifacts = [{ path: resultPath, kind: "json" }];
  for (const path of [...new Set([...(evidence.signalsPath ? [evidence.signalsPath] : []), ...evidence.archives, ...evidence.screenshots, ...legs.flatMap(entry => entry.evidence ?? [])])]) {
    if (existsSync(path)) artifacts.push({ path, kind: path.endsWith(".png") ? "screenshot" : path.endsWith(".json") ? "json" : "log" });
  }

  // stdout is a headline, result.json is the record: a bridge error can be 800 characters of nested
  // JSON, and burying the leg name behind it helps nobody.
  const headline = detail => typeof detail === "string" && detail.length > 240 ? `${detail.slice(0, 240)}...` : detail;
  const output = {
    ok: result.ok,
    players: targets.players,
    control: result.control,
    failingLeg: result.failingLeg
      ? { ...result.failingLeg, detail: headline(result.failingLeg.detail) }
      : null,
    legs: result.legs.map(entry => ({ n: entry.n, name: entry.name, verdict: entry.verdict, detail: headline(entry.detail) })),
    // Carried on stdout too: a warning nobody reads is not a warning, and the scenario runner only
    // ever sees this object.
    warnings: result.warnings,
    resultPath,
    signalsPath: evidence.signalsPath
  };
  // Repeated at the tail on purpose: the first print was several legs and minutes ago, and this is
  // where a human looks after a run that otherwise reported nothing wrong.
  if (result.warnings.length > 0) {
    note(`${result.warnings.length} evidence warning(s) -- result.json "warnings" has the full text`);
  }

  // stdout carries exactly one JSON object: the scenario runner parses it, and a human reading a
  // failed run gets the failing leg and its evidence paths from the same place.
  console.log(JSON.stringify({ output, artifacts }));
  process.exitCode = result.ok ? 0 : 1;
}

class StopProbe extends Error {}

function summarizeLegData(data) {
  if (data === null || data === undefined) return null;
  const text = JSON.stringify(data);
  if (text.length <= 8000) return data;
  return { truncated: true, bytes: text.length, preview: text.slice(0, 4000) };
}

/** Reads the scenario runner's hook stdin, or null when there is none. Never blocks a terminal run. */
async function readHookStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  const text = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 1000);
    process.stdin.on("data", chunk => chunks.push(chunk));
    process.stdin.on("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf8")); });
    process.stdin.on("error", () => { clearTimeout(timer); resolve(null); });
  });
  // An inherited pipe that never closes would otherwise keep the event loop alive to the end of the
  // run. `unref` only exists when stdin is a socket/pipe -- a file or /dev/null gives an fs.ReadStream
  // that has no such method, so it is called defensively rather than assumed.
  process.stdin.pause();
  process.stdin.unref?.();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed?.input && typeof parsed.input === "object" ? parsed.input : null;
  } catch {
    return null;
  }
}

/**
 * Acquires or inherits leases for exactly the resources this probe drives.
 *
 * probe-lib's acquireLiveLock() is not reused: it hardcodes `exclusive:game:default` and knows nothing
 * about the seat browser ports or a named instance, both of which this probe genuinely occupies.
 */
function acquireLiveLock(targets) {
  const resources = lockResourcesFor(targets);
  const inheritedOwner = process.env.COUCHCOOP_LIVEQA_OWNER;
  const inheritedPid = Number(process.env.COUCHCOOP_LIVEQA_PID ?? 0);
  if (inheritedOwner && inheritedPid > 0) {
    assertLease({ owner: inheritedOwner, pid: inheritedPid, resources });
    return { held: true, owned: false, holder: inheritedOwner, pid: inheritedPid, resources };
  }
  const owner = "five-player-run-probe";
  acquireLease({ owner, pid: process.pid, resources });
  return { held: true, owned: true, holder: owner, pid: process.pid, resources };
}

function releaseLiveLock(lock) {
  if (!lock?.owned) return;
  try { releaseLease({ owner: lock.holder, pid: lock.pid }); } catch { /* a noisy probe beats a stuck lock */ }
}

/**
 * Loads the host lobby fixture and proves it HELD.
 *
 * A freshly restarted game keeps finishing its boot flow for several seconds and that flow pushes the
 * main menu, popping a lobby the fixture just created. Same retry shape as the other lobby probes.
 */
async function holdHostLobby() {
  let lobby = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await loadFixture(FIXTURE_HOST_LOBBY);
    try {
      await waitFor(
        () => sceneTree(),
        value => value?.screen?.id === SCREEN_START_RUN_LOBBY,
        { attempts: 40, intervalMs: 250, what: "the start-run host lobby screen" }
      );
    } catch {
      await sleep(2000);
      continue;
    }
    await sleep(3000);
    const snapshot = await state();
    const candidate = snapshot?.characterSelect?.lobby ?? null;
    if (candidate?.netGameType === "host") {
      lobby = { ...candidate, loadAttempts: attempt };
      break;
    }
    await sleep(2000);
  }
  assert(lobby, "the host lobby fixture never held the lobby screen -- let the game finish booting first");
  return lobby;
}

async function tryScreenshot(targets, name) {
  const path = resolvePath(targets.outDir, name);
  try {
    await screenshot(path);
    return [path];
  } catch (error) {
    note(`screenshot ${name} failed (non-fatal): ${error.message}`);
    return [];
  }
}

// -------------------------------------------------------------------------------------------------
// Playwright seats
// -------------------------------------------------------------------------------------------------

let browser = null;
const openContexts = [];

async function chromium() {
  // Resolved lazily out of frontend/node_modules (this dir has none) so the pure helpers above stay
  // importable by the self-test on a machine with no browsers installed.
  const require = createRequire(new URL("../frontend/package.json", import.meta.url));
  return require("playwright").chromium;
}

/** Exported so a focused probe can reuse this live-proven seat join rather than grow a second one. */
export async function closeBrowsers() {
  for (const context of openContexts.splice(0)) {
    try { await context.close(); } catch { /* already gone */ }
  }
  if (browser) {
    try { await browser.close(); } catch { /* already gone */ }
    browser = null;
  }
}

/**
 * Joins `targets.seats` browser seats, at most `targets.seatConcurrency` at a time.
 *
 * Exported (with {@link closeBrowsers}) so `scripts/probe-steam-host-join.mjs` drives the SAME join
 * path this probe has run live, including its per-seat ENet evidence -- a second implementation of the
 * seat join is a second thing to be wrong. `targets` needs only
 * `{seats, seatConcurrency, baseUrl, browserPort, portBases, userDir, seatTimeoutMs, outDir}`.
 */
export async function joinSeats(targets, evidence) {
  if (!browser) {
    try {
      browser = await (await chromium()).launch();
    } catch (error) {
      throw new ProbeError(`could not launch chromium for the browser seats: ${error.message}\n`
        + "If the browser itself is missing: cd frontend && npx playwright install chromium");
    }
  }
  const names = Array.from({ length: targets.seats }, (_, index) => seatNameFor(index));
  return await mapWithConcurrency(names, targets.seatConcurrency, async name => await joinOneSeat(targets, name, evidence));
}

async function joinOneSeat(targets, name, evidence) {
  const started = Date.now();
  const seat = { name, ok: false, detail: null, slot: null, port: null, portBase: null, playerId: null, logPath: null, socketUrls: [], screenshots: [], ms: 0 };
  const context = await browser.newContext({ viewport: { width: 960, height: 600 } });
  openContexts.push(context);
  const page = await context.newPage();
  // The seat redirect happens INSIDE the page (a WebSocket reconnect to the headless instance's port),
  // never in the page URL -- so the socket URLs are the only client-side evidence of which port the
  // host handed this seat.
  page.on("websocket", socket => seat.socketUrls.push(socket.url()));
  page.on("console", message => { if (message.type() === "error") note(`[${name}] console error: ${message.text()}`); });

  const shot = async label => {
    const path = resolvePath(targets.outDir, `seat-${name}-${label}.png`);
    try { await page.screenshot({ path }); seat.screenshots.push(path); evidence.screenshots.push(path); } catch { /* page may be gone */ }
    return path;
  };

  try {
    await page.goto(`${targets.baseUrl}/`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="player-picker"]').waitFor({ state: "visible", timeout: 30_000 });
    await page.fill('[data-testid="join-name-input"]', name);
    await page.click('[data-testid="join-submit"]');

    // Either the seat's own view comes up, or the host refuses the join and says why.
    const frame = page.locator('[data-testid="mirror-frame"]');
    const rejection = page.locator('[data-testid="mirror-join-message"]');
    const deadline = Date.now() + targets.seatTimeoutMs;
    for (;;) {
      if (await frame.isVisible().catch(() => false)) break;
      if (await rejection.isVisible().catch(() => false)) {
        const message = await rejection.textContent().catch(() => null);
        const detail = await page.locator('[data-testid="mirror-join-detail"]').textContent().catch(() => null);
        await shot("rejected");
        throw new ProbeError(`the host refused the join: ${String(message ?? "").trim()}${detail ? ` -- ${String(detail).trim()}` : ""}`);
      }
      if (Date.now() > deadline) {
        await shot("timeout");
        throw new ProbeError(`no seat view within ${targets.seatTimeoutMs}ms (sockets seen: ${seat.socketUrls.join(", ") || "none"})`);
      }
      await page.waitForTimeout(500);
    }
    await shot("joined");

    const seatPort = resolveSeatPort(seat.socketUrls, targets);
    assert(seatPort, `could not tell which seat port ${name} was redirected to; sockets seen: ${seat.socketUrls.join(", ") || "none"}`);
    seat.port = seatPort.port;
    seat.slot = seatPort.slot;
    seat.portBase = seatPort.base;
    seat.playerId = seatPort.playerId;
    seat.logPath = seatLogPathFor(targets.userDir, seatPort.slot);

    // The REAL ENet join, in that seat's own process log. A browser that shows a scene proves the
    // mirror is up; only these two lines prove the seat actually joined the host's lobby over ENet.
    //
    // The handshake is matched WITH this seat's netId, not just by prefix: a reused slot dir can still
    // hold the previous run's log, and a prefix-only match would let a stale file pass this leg
    // vacuously. `hint` keeps the diagnostic useful if the game's wording ever drifts.
    seat.enetEvidence = await waitForLogSignatures(
      seat.logPath,
      [
        { pattern: `Sending handshake with net ID ${seatPort.netId}`, hint: "Sending handshake with net ID" },
        { pattern: "ClientLobbyJoinResponseMessage Players:", hint: "ClientLobbyJoinResponseMessage" }
      ],
      Math.max(30_000, targets.seatTimeoutMs / 2)
    );
    seat.ok = true;
    seat.detail = `slot ${seat.slot}, port ${seat.port}`;
  } catch (error) {
    seat.detail = error instanceof ProbeError ? error.message : `${error?.name}: ${error?.message}`;
  } finally {
    seat.ms = Date.now() - started;
  }
  return seat;
}

/** The redirect port is the last WebSocket the page opened that is NOT the host's own base port. */
function resolveSeatPort(socketUrls, targets) {
  for (let index = socketUrls.length - 1; index >= 0; index -= 1) {
    const port = portFromUrl(socketUrls[index]);
    if (!Number.isInteger(port) || port === targets.browserPort) continue;
    const resolved = slotForPort(port, targets.portBases);
    if (resolved) return { port, ...resolved };
  }
  return null;
}

/**
 * Polls a log until every `{pattern, hint}` has matched, then returns where each one landed.
 *
 * On timeout the error quotes the last line matching the looser `hint` for each pattern that did NOT
 * match -- so "the game changed its wording" and "this never happened" read differently instead of
 * both surfacing as a bare timeout.
 */
export async function waitForLogSignatures(path, patterns, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lines = [];
  for (;;) {
    const text = await readTextIfPresent(path);
    if (typeof text === "string") {
      lines = splitLogLines(text);
      const found = patterns.map(({ pattern }) => {
        const index = lines.findLastIndex(line => line.includes(pattern));
        return index < 0 ? null : { pattern, lineNumber: index + 1, text: lines[index].slice(0, MAX_MATCH_TEXT) };
      });
      if (found.every(Boolean)) return found;
    }
    if (Date.now() > deadline) {
      const missing = patterns
        .filter(({ pattern }) => !lines.some(line => line.includes(pattern)))
        .map(({ pattern, hint }) => {
          const near = hint ? lines.findLast(line => line.includes(hint)) : null;
          return `"${pattern}"${near ? ` (closest line: ${near.slice(0, MAX_MATCH_TEXT)})` : " (nothing resembling it in the log)"}`;
        });
      throw new ProbeError(`${path}: no ENet join evidence within ${timeoutMs}ms; missing ${missing.join(" / ")}`);
    }
    await sleep(1000);
  }
}

// -------------------------------------------------------------------------------------------------
// embark + evidence
// -------------------------------------------------------------------------------------------------

/**
 * Line counts for every log this probe will archive, taken immediately BEFORE the ready/embark step.
 * This is what makes `phase` -- and therefore "did the disconnect happen before or after `Embarking`?"
 * -- answerable from the artifact alone, on logs that carry no timestamps. Exported so the self-test
 * can exercise the whole evidence pipeline without a game.
 */
export async function captureLogBaselines(targets, seats) {
  const files = [
    { label: "host-stdout", role: "host-stdout", path: targets.hostStdoutPath },
    { label: "host-stderr", role: "host-stderr", path: targets.hostStderrPath },
    ...(await discoverSeatLogs(targets.userDir)).map(entry => ({ label: `seat-slot-${entry.slot}`, role: "seat", path: entry.path, slot: entry.slot }))
  ];
  for (const seat of seats) {
    if (seat.logPath && !files.some(file => file.path === seat.logPath)) {
      files.push({ label: `seat-slot-${seat.slot}`, role: "seat", path: seat.logPath, slot: seat.slot });
    }
  }
  for (const file of files) {
    file.baselineLines = await countLines(file.path);
  }
  return files;
}

/** Waits for the lobby to stop being a lobby (the run begins) or the budget to run out. */
async function waitForEmbark(targets, timeoutMs = targets.embarkTimeoutMs) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let last = null;
  for (;;) {
    const snapshot = await state().catch(() => null);
    const lobby = snapshot?.characterSelect?.lobby ?? null;
    last = {
      hasRun: Boolean(snapshot?.run),
      runPlayers: (snapshot?.run?.players ?? []).length,
      lobbyPlayers: (lobby?.players ?? []).length,
      connectingPlayerCount: lobby?.connectingPlayerCount ?? null,
      allReady: (lobby?.players ?? []).length > 0 && (lobby?.players ?? []).every(player => player.isReady === true)
    };
    if (last.hasRun) {
      // Let the in-run roster settle before the gate reads it.
      await sleep(5000);
      return { settled: true, waitedMs: Date.now() - startedAt, ...last };
    }
    if (Date.now() > deadline) {
      return { settled: false, waitedMs: Date.now() - startedAt, ...last };
    }
    await sleep(1000);
  }
}

/** Copies every log into the artifact dir and writes signals.json. Never throws. */
export async function archiveEvidence(targets, seats, baselines, evidence) {
  const logDir = resolvePath(targets.outDir, "logs");
  const paths = [];
  const scanInput = [];
  try {
    await mkdir(logDir, { recursive: true });
    for (const file of baselines) {
      const text = await readTextIfPresent(file.path);
      if (typeof text !== "string") {
        scanInput.push({ ...file, text: "", missing: text.reason });
        continue;
      }
      const destination = resolvePath(logDir, `${file.label}.log`);
      await writeFile(destination, text);
      paths.push(destination);
      let mtime = null;
      try { mtime = (await stat(file.path)).mtime.toISOString(); } catch { /* fine */ }
      scanInput.push({ ...file, text, archivedPath: destination, mtime });
    }
    const signals = scanLogSignatures(scanInput.map(file => ({
      label: file.label,
      path: file.path,
      role: file.role,
      text: file.text,
      baselineLines: file.baselineLines
    })));
    signals.archive = scanInput.map(file => ({
      label: file.label,
      sourcePath: file.path,
      archivedPath: file.archivedPath ?? null,
      missing: file.missing ?? null,
      mtime: file.mtime ?? null,
      baselineLines: file.baselineLines
    }));
    signals.seats = seats.map(seat => ({ name: seat.name, slot: seat.slot, port: seat.port, playerId: seat.playerId, logPath: seat.logPath }));
    const signalsPath = resolvePath(targets.outDir, "signals.json");
    await writeFile(signalsPath, `${JSON.stringify(signals, null, 2)}\n`);
    paths.push(signalsPath);
    evidence.archives.push(...paths);
    const hitSummary = Object.values(signals.bySignature).filter(entry => entry.total > 0)
      .map(entry => `${entry.id}x${entry.total}`).join(" ");
    note(`archived ${paths.length} evidence files; signatures: ${hitSummary || "(none)"}`);
    return { paths, signalsPath, signals };
  } catch (error) {
    note(`evidence archive failed (non-fatal): ${error.message}`);
    return { paths, signalsPath: null, signals: null };
  }
}

async function probeSeatMirrors(seats) {
  return await Promise.all(seats.map(async seat => {
    try {
      const response = await fetch(`http://127.0.0.1:${seat.port}/`, { signal: AbortSignal.timeout(5000) });
      return { name: seat.name, slot: seat.slot, port: seat.port, serving: response.ok, status: response.status };
    } catch (error) {
      return { name: seat.name, slot: seat.slot, port: seat.port, serving: false, status: null, error: error.message };
    }
  }));
}

/** Each seat's own bridge view of the run -- the discriminator the host's state cannot give. */
async function captureSeatRunViews(seats) {
  const views = [];
  for (const seat of seats) {
    const socket = seatBridgeSocketFor(seat.slot);
    const outcome = await sts2AtSocket(socket, ["state"]);
    views.push({
      name: seat.name,
      slot: seat.slot,
      socket,
      reachable: outcome.ok,
      error: outcome.stderr,
      rootScene: outcome.value?.rootScene ?? null,
      hasRun: Boolean(outcome.value?.run),
      runPlayers: (outcome.value?.run?.players ?? []).map(player => ({ id: player?.id, netId: player?.netId, currentHp: player?.creature?.currentHp ?? null })),
      lobbyPlayers: (outcome.value?.characterSelect?.lobby?.players ?? []).map(player => player?.id)
    });
  }
  return views;
}

// -------------------------------------------------------------------------------------------------
// leg 6
// -------------------------------------------------------------------------------------------------

async function playOneCombatTurn(targets, seatsByPlayerId, evidence) {
  const readCombat = async () => {
    const snapshot = await state().catch(() => null);
    return {
      snapshot,
      roomType: snapshot?.run?.currentRoom?.roomType ?? null,
      combat: snapshot?.run?.currentRoom?.combat?.combatState ?? null,
      players: snapshot?.run?.players ?? []
    };
  };

  // The budget is split three ways: reach a combat, see the enemy turn, get control back.
  const phaseMs = Math.max(10_000, Math.floor(targets.combatTimeoutMs / 3));
  const deadline = Date.now() + phaseMs;
  let view = await readCombat();
  while (!view.combat && Date.now() < deadline) {
    await sleep(2000);
    view = await readCombat();
  }
  if (!view.combat) {
    return {
      verdict: "skipped",
      detail: `no combat became current within ${phaseMs}ms; the run is on roomType ${JSON.stringify(view.roomType)}. `
        + "The turn assertion is only enforced when the game offers a combat -- resolving a run's opening room for N players is a different probe.",
      data: { roomType: view.roomType }
    };
  }

  const roundBefore = view.combat.roundNumber ?? null;
  const sideBefore = view.combat.currentSide ?? null;
  const turns = [];
  for (const player of view.players) {
    const outcome = await actForPlayer(player.id, ["end-turn"], seatsByPlayerId);
    turns.push({ playerId: player.id, ...outcome });
    evidence.actions[`end-turn:${player.id}`] = outcome;
    assert(outcome.accepted, `end-turn for ${player.id} was refused: ${JSON.stringify(outcome.attempts)}`);
  }

  // The enemy turn runs. `currentSide` is an opaque string here on purpose -- the assertion is that it
  // CHANGED (or that player actions went away), not that it equals any particular value.
  const enemyTurn = await waitFor(
    readCombat,
    value => value.combat && (value.combat.currentSide !== sideBefore || value.combat.playerActionsDisabled === true),
    { attempts: Math.ceil(phaseMs / 1000), intervalMs: 1000, what: "the enemy turn to take over" }
  );

  // ...and control comes back to the players: a new round, actions re-enabled, nobody still ended.
  const back = await waitFor(
    readCombat,
    value => value.combat
      && value.combat.playerActionsDisabled !== true
      && (roundBefore === null || (value.combat.roundNumber ?? 0) > roundBefore)
      && value.players.every(player => player?.combat?.hasEndedTurn !== true),
    { attempts: Math.ceil(phaseMs / 1000), intervalMs: 1000, what: "control to return to the players" }
  );

  return {
    detail: `round ${roundBefore} -> ${back.combat.roundNumber}; ${turns.length} players ended turn`,
    data: {
      roundBefore,
      roundAfter: back.combat.roundNumber ?? null,
      sideBefore,
      enemyTurnSide: enemyTurn.combat.currentSide ?? null,
      turns: turns.map(turn => ({ playerId: turn.playerId, via: turn.via }))
    }
  };
}

// =================================================================================================

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    const failure = { ok: false, error: `${error?.name}: ${error?.message}`, stack: error?.stack };
    console.log(JSON.stringify({ output: failure, artifacts: [] }));
    console.error(JSON.stringify(failure, null, 2));
    process.exitCode = 1;
  });
}
