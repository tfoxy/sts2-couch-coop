#!/usr/bin/env node
//
// Behavioural seat-join gate for the STEAM-HOSTED transport branch.
// ============================================================================================
//
// Every automated gate this repo has for a new game build is a METADATA gate -- `sts2 code
// verify-references`, `dotnet run --project tests/CouchCoop.Mod.Tests -- beta-targets`, spirectl's
// `Sts2GameApiProbe`. They prove that every member the mod binds to still resolves. They cannot see a
// brand-new protocol STEP that the mod does not participate in: a new handshake resolves nothing and
// breaks nothing they look at, and the seat simply never joins. That is exactly how the game's v0.111.0
// beta shipped a transport-level version handshake that stopped headless seats joining a Steam-hosted
// session, with all 43 patch targets still green.
//
// The other half of the blind spot is that the only automated seat-join coverage -- `-fastmp` and the
// `tests/fixtures/pc-lobby-host.sts2.fixture.yaml` lobby -- takes the ENET host branch, where
// `HostNetIdPatch` is inert because `hostNetId == 1`. The Steam-hosted branch has never had an
// automated join test.
//
// This probe closes that: it drives a REAL Steam-hosted lobby through the menus, joins one browser
// seat, and asserts the seat reaches a connected roster. One seat is enough -- this is about the
// transport path, not about player count (that is `scripts/probe-five-player-run.mjs`).
//
//   node scripts/probe-steam-host-join.mjs [--base <url>] [--out <dir>] [--instance <name>]
//                                          [--handshake auto|require|skip] [--dry-run] [--help]
//
// Legs
// ----
//   0 preflight     the bridge answers; record the game build and the bridge's build identity; refuse a
//                   `-fastmp` host outright, because that flag makes the Steam branch UNREACHABLE.
//   1 menu-host     Main Menu -> Multiplayer -> Host -> Standard, landing on a host lobby.
//   2 steam-branch  THE ANTI-DEGRADATION GATE. The host's own log has to say it took the Steam branch
//                   and created a real lobby. *** If this leg cannot prove Steam, the run FAILS. ***
//   3 seat-join     one browser seat joins, with real ENet handshake evidence in its own godot.log.
//   4 roster        the seat is in `lobby.players` and nobody is left connecting.
//   5 handshake     build-conditional: on a build with the transport version handshake, the seat log
//                   must show a handshake it accepted and must NOT show one it refused.
//
// Legs 4 and 5 run WHETHER OR NOT leg 3 passed, and leg 2 runs whether or not leg 1 did. That is not
// tidiness: a seat that never joined is the symptom, and the reason is in the two logs those legs read.
// The one place the probe does stop early is a host that is not on the Steam branch -- joining a seat to
// it would produce a green ENet result, which is the outcome this whole gate exists to prevent.
//
// Why leg 2 exists, and why it is fatal
// -------------------------------------
// A gate that silently degrades to ENet is WORSE than no gate, because ENet is precisely the branch
// that already worked. So "did we actually get Steam?" is answered from the host's own log rather than
// from intent, and three different not-Steam outcomes are told apart by name:
//
//   `host-transport effective maxClients=N (requested=M, source=host-start)`  our StartSteamHost prefix ran
//   `host-transport effective maxClients=N (requested=M, source=stock-enet)`  the ENet branch ran instead
//   `host-transport steam host started lobby=L hostNetId=H couchSeats=ENet:P.` a real Steam lobby exists
//   `host-transport steam host failed (...)` / `steam host threw (...)`        Steam offline -> ENet fallback
//
// `source=host-start` ALONE does not prove Steam: the Steam-offline fallback runs through the same
// prefix and then hosts on ENet anyway. The gate therefore needs the `steam host started` line too, AND
// a `hostNetId` that is not the ENet wire's `1` -- because `HostNetIdPatch` only does anything when the
// host answers to a SteamID64. A run whose hostNetId is 1 exercises nothing this probe exists for.
//
// The menu route is the only way in
// ---------------------------------
// `NMultiplayerHostSubmenu` picks the Steam host only when Steam is initialized AND `-fastmp` is absent,
// so no fixture can get here: a fixture lobby materializes through the ENet host. The route below is
// three clicks, and hover-before-click is REQUIRED rather than stylistic -- `NClickableControl` acts on
// a click only when it is already focused, so a click at a guessed centre lands on the wrong node.
//
// Traps this file encodes
// -----------------------
//  * `lobby.players[].isConnected` is NOT a usable "this seat is in" signal. A live 5-seat Steam-hosted
//    lobby that went on to start a run reported `isConnected: false` for every couch seat. Membership
//    plus `connectingPlayerCount == 0` is what the roster leg asserts; isConnected is recorded as
//    evidence and believed about nothing.
//  * The host log accumulates. A baseline line count is taken immediately BEFORE the Standard click, and
//    leg 2 reads only past it -- otherwise a previous host start in the same process answers the
//    question instead of this one.
//  * `dev screenshot` is called with no --width/--height. Asking for a resize captures a partial frame.
//  * The Steam-offline modal (`CouchCoopHostTransportAlert`) pops over a lobby with a full-rect scrim
//    when Steam is initialized but offline. This probe fails leg 2 in that case anyway, but that alert
//    is what a blocked click afterwards would look like.
//  * A hook's stdout must be exactly one JSON object, so every progress line here goes to stderr.
//
// What this probe deliberately does NOT do: ready up and embark. Reaching a connected roster over the
// Steam transport is the contract; what happens afterwards is the five-player probe's job.

import { mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import { acquireLease, assertLease, releaseLease } from "./live-qa-lock.mjs";
import { PRIMARY_REPO_ROOT, REPO_ROOT as REPO_ROOT_PATH } from "./lib/repo-layout.mjs";
import {
  FIXTURE_MAIN_MENU, SCREEN_START_RUN_LOBBY,
  ProbeError, sleep,
  sts2, loadFixture, state, sceneTree, waitFor,
  hoverAndClick, nodeDetails, isEffectivelyVisible
} from "./probe-lib-lobby-qr.mjs";
import {
  DEFAULT_HOST_PORT, SEAT_MIN_SLOT, SEAT_PORT_STEP,
  seatLogPathFor, seatNameFor, splitLogLines, checkSeatRecords,
  joinSeats, closeBrowsers
} from "./probe-five-player-run.mjs";

// =================================================================================================
// constants
// =================================================================================================

export const RESULT_SCHEMA = "couchcoop-steam-host-join/1";

/** The main-menu screen id `dev scene tree` reports (spirectl `Sts2SupportedScreenIds`). */
export const SCREEN_MAIN_MENU = "Screens.MainMenu.NMainMenu";

/** What the ENet transport reports as its host's net id. `HostNetIdPatch` is inert at this value. */
export const ENET_WIRE_HOST_NET_ID = "1";

/**
 * Game builds with NO transport version handshake, so leg 5 has nothing to assert on them.
 *
 * Membership, not a range: a build this probe has never seen defaults to REQUIRING the handshake, which
 * is the fail-loud direction for a gate whose entire purpose is noticing a new protocol step. If a
 * future build renames the log line, this leg goes red and somebody looks -- which is the outcome the
 * v0.111.0 break did not get.
 */
export const BUILDS_WITHOUT_HANDSHAKE = Object.freeze(["v0.107.1"]);

/**
 * The three clicks from the main menu to a Steam-hosted lobby.
 *
 * Node names and types only -- no label text, because the label is localized and the probe has to run on
 * any locale. `scopeType` narrows the search to the submenu the previous step opened, so a leftover
 * hidden copy of a submenu cannot answer for the live one.
 */
export const MENU_ROUTE = Object.freeze([
  Object.freeze({
    id: "multiplayer",
    name: "MultiplayerButton",
    nodeType: "NMainMenuTextButton",
    scopeType: null,
    opensType: "NMultiplayerSubmenu",
    shot: "02-multiplayer-submenu.png"
  }),
  Object.freeze({
    id: "host",
    name: "HostButton",
    nodeType: "NSubmenuButton",
    scopeType: "NMultiplayerSubmenu",
    opensType: "NMultiplayerHostSubmenu",
    shot: "03-host-submenu.png"
  }),
  Object.freeze({
    id: "standard",
    name: "StandardButton",
    nodeType: "NSubmenuButton",
    scopeType: "NMultiplayerHostSubmenu",
    opensType: null,
    shot: "04-hosted-lobby.png"
  })
]);

const MAX_MATCH_TEXT = 400;

export const USAGE = `usage: node scripts/probe-steam-host-join.mjs [options]

Drives a REAL Steam-hosted lobby through Main Menu -> Multiplayer -> Host -> Standard, joins one
browser seat, and asserts the seat reaches a connected roster. Fails if the host did not actually take
the Steam branch.

  --base <url>              hosted browser origin (default http://127.0.0.1:${DEFAULT_HOST_PORT})
  --out <dir>               artifact directory (default <repo>/.sts2/artifacts/steam-host-join)
  --instance <name>         SPIRECTL_INSTANCE to drive
  --user-dir <dir>          where seat logs live (default $XDG_DATA_HOME or ~/.local/share)
  --host-stderr <path>      the host's stderr log; leg 2 reads the host-transport lines from it
  --host-stdout <path>      the host's stdout log, archived as evidence
  --host-pid <pid>          read /proc/<pid>/cmdline for the -fastmp preflight
  --handshake <mode>        auto (default) | require | skip -- leg 5's build-conditional assertions
  --handshake-sender <id>   pin the accepted handshake sender id instead of the default pair
  --menu-timeout-ms <ms>    per menu step (default 20000)
  --lobby-timeout-ms <ms>   for the lobby to appear after the Standard click (default 60000)
  --seat-timeout-ms <ms>    for the seat's browser view and ENet evidence (default 90000)
  --dry-run                 resolve and print the plan; touch nothing
  --help                    this text
`;

// =================================================================================================
// pure helpers (unit-tested by scripts/test-probe-steam-host-join.mjs)
// =================================================================================================

/** Thrown for a usage/config problem the operator must fix; distinct from a leg failing. */
export class ProbeUsageError extends Error {
  name = "ProbeUsageError";
}

const VALUE_FLAGS = new Set([
  "--base", "--out", "--instance", "--user-dir", "--host-stderr", "--host-stdout", "--host-pid",
  "--handshake", "--handshake-sender",
  "--menu-timeout-ms", "--lobby-timeout-ms", "--seat-timeout-ms"
]);
const BOOLEAN_FLAGS = new Set(["--help", "-h", "--dry-run"]);
export const HANDSHAKE_MODES = Object.freeze(["auto", "require", "skip"]);

export function parseProbeArgs(argv = []) {
  const out = {
    base: null,
    out: null,
    instance: null,
    userDir: null,
    hostStderr: null,
    hostStdout: null,
    hostPid: null,
    handshake: "auto",
    handshakeSender: null,
    menuTimeoutMs: 20_000,
    lobbyTimeoutMs: 60_000,
    seatTimeoutMs: 90_000,
    help: false,
    dryRun: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (BOOLEAN_FLAGS.has(flag)) {
      if (flag === "--dry-run") out.dryRun = true;
      else out.help = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) {
      throw new ProbeUsageError(`unknown argument '${flag}'; run with --help`);
    }
    const value = argv[i + 1];
    if (value === undefined || VALUE_FLAGS.has(value) || BOOLEAN_FLAGS.has(value)) {
      throw new ProbeUsageError(`${flag} requires a value`);
    }
    i += 1;
    switch (flag) {
      case "--base": out.base = value; break;
      case "--out": out.out = value; break;
      case "--instance": out.instance = value; break;
      case "--user-dir": out.userDir = value; break;
      case "--host-stderr": out.hostStderr = value; break;
      case "--host-stdout": out.hostStdout = value; break;
      case "--handshake": {
        if (!HANDSHAKE_MODES.includes(value)) {
          throw new ProbeUsageError(`--handshake must be one of ${HANDSHAKE_MODES.join("|")}; got '${value}'`);
        }
        out.handshake = value;
        break;
      }
      case "--handshake-sender": {
        if (!/^\d+$/.test(value)) {
          throw new ProbeUsageError(`--handshake-sender must be a decimal net id; got '${value}'`);
        }
        out.handshakeSender = value;
        break;
      }
      case "--host-pid": {
        const pid = Number(value);
        if (!Number.isInteger(pid) || pid <= 0) {
          throw new ProbeUsageError(`--host-pid must be a positive integer; got '${value}'`);
        }
        out.hostPid = pid;
        break;
      }
      default: {
        const ms = Number(value);
        if (!Number.isInteger(ms) || ms <= 0) {
          throw new ProbeUsageError(`${flag} must be a positive integer of milliseconds; got '${value}'`);
        }
        if (flag === "--menu-timeout-ms") out.menuTimeoutMs = ms;
        else if (flag === "--lobby-timeout-ms") out.lobbyTimeoutMs = ms;
        else out.seatTimeoutMs = ms;
        break;
      }
    }
  }
  return out;
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

/**
 * Folds CLI args, the environment and the built-in defaults into one target, recording WHERE each
 * value came from so result.json can be read without re-deriving the fallback chain.
 */
export function resolveTargets({ args, env = {}, home = homedir(), repoRoot = REPO_ROOT_PATH, primaryRepoRoot = PRIMARY_REPO_ROOT }) {
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

  const base = pick("baseUrl", ["cli", args.base], ["env", env.COUCHCOOP_GAME_ORIGIN]);
  const browserPort = pick("browserPort",
    ["cli", args.base ? portFromUrl(args.base) : null],
    ["env", env.COUCHCOOP_GAME_ORIGIN ? portFromUrl(env.COUCHCOOP_GAME_ORIGIN) : null],
    ["default", DEFAULT_HOST_PORT]);
  const baseUrl = base ?? `http://127.0.0.1:${browserPort}`;
  if (base === null) sources.baseUrl = `derived:127.0.0.1:${browserPort}`;

  // "default" is how the lock resource spells "no --instance at all"; it must not be exported as a
  // real SPIRECTL_INSTANCE.
  const rawInstance = pick("instance", ["cli", args.instance], ["env", env.SPIRECTL_INSTANCE]);
  const instance = rawInstance && rawInstance !== "default" ? rawInstance : null;

  const userDir = pick("userDir",
    ["cli", args.userDir],
    ["env", env.XDG_DATA_HOME],
    ["default", `${home}/.local/share`]);

  // A worktree gets its own EMPTY .sts2/, so the host stdio fallback has to name the primary checkout,
  // where `sts2 game launch` actually tees the streams.
  const launchDir = `${primaryRepoRoot}/.sts2/artifacts/game-launch`;
  const hostStdoutPath = pick("hostStdoutPath", ["cli", args.hostStdout], ["default", `${launchDir}/game.stdout.log`]);
  const hostStderrPath = pick("hostStderrPath", ["cli", args.hostStderr], ["default", `${launchDir}/game.stderr.log`]);

  const outDir = args.out ? resolvePath(args.out) : resolvePath(repoRoot, ".sts2/artifacts/steam-host-join");
  sources.outDir = args.out ? "explicit" : "default";

  // Seats are laid out from the COMPILED 13337 base even when the host itself port-walked, so both
  // bases have to resolve a seat port.
  const portBases = [...new Set([browserPort, DEFAULT_HOST_PORT].filter(Number.isInteger))];

  return {
    // `seats`/`seatConcurrency` are the shape probe-five-player-run's joinSeats() reads off a target,
    // and one seat is the whole point: this gates the transport, not the player count. The seat is
    // named by that probe's own roster (`seatNameFor(0)`), so artifacts line up across the two.
    seats: 1,
    seatConcurrency: 1,
    seatName: seatNameFor(0),
    baseUrl,
    browserPort,
    portBases,
    instance,
    userDir,
    hostStdoutPath,
    hostStderrPath,
    hostPid: args.hostPid,
    outDir,
    handshake: args.handshake,
    handshakeSender: args.handshakeSender,
    menuTimeoutMs: args.menuTimeoutMs,
    lobbyTimeoutMs: args.lobbyTimeoutMs,
    seatTimeoutMs: args.seatTimeoutMs,
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
 * Grades a host's launch arguments for the one flag that makes this probe impossible.
 *
 * `-fastmp` forces the non-Steam platform, so the game takes `StartENetHost` and the Steam branch is
 * never reached. Better to say that up front than to spend three minutes reaching leg 2 and report
 * "not the Steam branch" about a host that was never going to be.
 *
 * `tokens` is a flat argv list from whatever source could supply one. Null/absent means "nobody could
 * tell us", which is `unknown` -- never a pass and never a failure.
 */
export function gradeLaunchArgs(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return { verdict: "unknown", fastmp: null, detail: "no launch arguments were readable for this host" };
  }
  const hit = tokens.find(token => typeof token === "string" && /(^|=)-?-?fastmp\b/.test(token.trim()));
  if (hit) {
    return {
      verdict: "fastmp",
      fastmp: hit,
      detail: `the host was launched with ${JSON.stringify(hit)}. \`-fastmp\` forces the non-Steam platform, so `
        + "hosting takes the ENet branch and the Steam branch this probe gates is UNREACHABLE. Relaunch the host "
        + "without it (a plain `sts2 game launch`), with the Steam client running and online."
    };
  }
  return { verdict: "clean", fastmp: null, detail: `${tokens.length} launch argument(s), none of them -fastmp` };
}

/** `/proc/<pid>/cmdline` is NUL-delimited with a trailing NUL. */
export function parseProcCmdline(raw) {
  if (typeof raw !== "string" || raw.length === 0) return [];
  return raw.split("\0").filter(token => token.length > 0);
}

export const CAPACITY_RE = /host-transport effective maxClients=(\d+) \(requested=(\d+), source=([A-Za-z0-9-]+)\)/;
export const STEAM_STARTED_RE = /host-transport steam host started lobby=(\S+) hostNetId=(\d+) couchSeats=([^\s.]+)\.?\s*$/;
export const STEAM_FALLBACK_RE = /host-transport steam host (failed|threw) \(/;

/**
 * Pulls this host start's transport facts out of the host log.
 *
 * `sinceLine` is the line count captured immediately before the Standard click, so an earlier host
 * start in the same process cannot answer for this one. Lines are numbered the way
 * {@link splitLogLines} counts them -- a trailing newline is not a line.
 */
export function parseHostTransportLog(text, { sinceLine = 0 } = {}) {
  const lines = splitLogLines(text);
  const capacity = [];
  const fallbacks = [];
  let steamStarted = null;
  for (let index = Math.max(0, sinceLine); index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const capacityMatch = CAPACITY_RE.exec(line);
    if (capacityMatch) {
      capacity.push({
        effective: Number(capacityMatch[1]),
        requested: Number(capacityMatch[2]),
        source: capacityMatch[3],
        lineNumber
      });
      continue;
    }
    const startedMatch = STEAM_STARTED_RE.exec(line);
    if (startedMatch) {
      steamStarted = {
        lobbyId: startedMatch[1],
        hostNetId: startedMatch[2],
        couchSeats: startedMatch[3],
        lineNumber,
        text: line.slice(0, MAX_MATCH_TEXT)
      };
      continue;
    }
    const fallbackMatch = STEAM_FALLBACK_RE.exec(line);
    if (fallbackMatch) {
      fallbacks.push({ kind: fallbackMatch[1], lineNumber, text: line.slice(0, MAX_MATCH_TEXT) });
    }
  }
  return { sinceLine, scannedLines: lines.length, capacity, steamStarted, fallbacks };
}

/**
 * THE ANTI-DEGRADATION VERDICT. Turns parsed transport facts into one of five named branches.
 *
 * Only `steam` passes. Every other outcome names what happened instead, because "the gate went green on
 * ENet" is the failure this whole probe exists to make impossible.
 */
export function gradeHostBranch(parsed) {
  const sources = (parsed?.capacity ?? []).map(entry => entry.source);
  const problems = [];

  if (sources.length === 0 && !parsed?.steamStarted && (parsed?.fallbacks ?? []).length === 0) {
    return {
      ok: false,
      branch: "unknown",
      hostNetId: null,
      problems: [
        "the host logged NO `[couch-coop] host-transport` line for this host start "
        + `(scanned ${parsed?.scannedLines ?? 0} line(s), from line ${(parsed?.sinceLine ?? 0) + 1}). `
        + "Either the log path is wrong -- a worktree's own .sts2/ is empty, so --host-stderr may be "
        + "pointing at nothing -- or CouchCoop is not loaded in this host at all."
      ],
      sources
    };
  }

  if (!sources.includes("host-start")) {
    const tookEnet = sources.includes("stock-enet");
    return {
      ok: false,
      branch: tookEnet ? "stock-enet" : "unknown",
      hostNetId: null,
      problems: [
        (tookEnet
          ? "the host took the ENet branch (source=stock-enet), not the Steam branch. "
          : `no \`source=host-start\` capacity line was logged (sources seen: ${sources.join(", ") || "none"}), `
            + "so the Steam host start never ran. ")
        + "`NMultiplayerHostSubmenu` picks the Steam host only when Steam is initialized AND `-fastmp` is "
        + "absent, so: relaunch without -fastmp, with the Steam client running. A fixture lobby ALWAYS "
        + "takes the ENet branch and can never satisfy this gate."
      ],
      sources
    };
  }

  if ((parsed.fallbacks ?? []).length > 0) {
    return {
      ok: false,
      branch: "steam-fallback-enet",
      hostNetId: null,
      problems: [
        "the Steam host start ran but Steam could not deliver a lobby, so CouchCoop fell back to a "
        + `couch/LAN-only ENet host: ${parsed.fallbacks.map(entry => entry.text).join(" | ")}. `
        + "That fallback hosts as net id 1, which is the ENet branch in all but name. Bring the Steam "
        + "client online and re-run."
      ],
      sources
    };
  }

  if (!parsed.steamStarted) {
    return {
      ok: false,
      branch: "host-start-incomplete",
      hostNetId: null,
      problems: [
        "the Steam host start began (source=host-start) but never logged `steam host started lobby=...`, "
        + "so no Steam lobby was created and nothing says why. Check the host log around line "
        + `${parsed.capacity.at(-1)?.lineNumber ?? "?"} for a throw.`
      ],
      sources
    };
  }

  const { hostNetId, couchSeats, lobbyId } = parsed.steamStarted;
  if (hostNetId === ENET_WIRE_HOST_NET_ID) {
    problems.push(
      `the Steam host reports hostNetId=${hostNetId}, which is the ENet wire's own host id. `
      + "`HostNetIdPatch` does nothing at that value, so this run would exercise none of the identity "
      + "handling the Steam branch exists to cover."
    );
  }
  if (!/^ENet:\d+$/.test(couchSeats)) {
    problems.push(
      `the Steam lobby came up but the couch ENet side did not (couchSeats=${couchSeats}), so no browser `
      + "seat can join it at all. Port 33771 is most likely already bound by another game instance."
    );
  }

  return {
    ok: problems.length === 0,
    branch: problems.length === 0 ? "steam" : "steam-degraded",
    hostNetId,
    lobbyId,
    couchSeats,
    problems,
    sources
  };
}

/**
 * Decides whether leg 5 asserts anything on this game build.
 *
 * `override` is `--handshake`: `require` and `skip` are the operator's word and win. `auto` consults
 * {@link BUILDS_WITHOUT_HANDSHAKE}, and an UNKNOWN build requires the handshake -- see the note there.
 */
export function resolveHandshakeMode(gameVersion, override = "auto") {
  if (override === "require") return { mode: "require", reason: `--handshake require (build ${gameVersion ?? "unknown"})` };
  if (override === "skip") return { mode: "skip", reason: `--handshake skip (build ${gameVersion ?? "unknown"})` };
  if (typeof gameVersion === "string" && BUILDS_WITHOUT_HANDSHAKE.includes(gameVersion)) {
    return { mode: "skip", reason: `game build ${gameVersion} has no transport version handshake` };
  }
  if (!gameVersion) {
    return {
      mode: "require",
      reason: "the game build could not be read, and an unknown build is assumed to have the handshake "
        + "(a false red here is a question; a false green is the bug this probe exists for)"
    };
  }
  return { mode: "require", reason: `game build ${gameVersion} is not in BUILDS_WITHOUT_HANDSHAKE` };
}

/**
 * The two seat-log lines leg 5 turns on, both emitted by the game's own connection handshake manager.
 *
 * The accepted one carries that manager's `[Context]` prefix because it goes through its `Logger`; the
 * refused one does not, because it goes through the global warn path. Keep them as separate literals
 * rather than one pattern: they are different lines from different code paths, and a "fix" that made
 * them share a prefix would be guessing.
 */
export const HANDSHAKE_ACCEPTED_TEXT = "[HandshakeManager] Got handshake from sender";
export const HANDSHAKE_ACCEPTED_RE = /\[HandshakeManager\] Got handshake from sender (\d+)/;
export const HANDSHAKE_REFUSED_TEXT = "not currently in the middle of a handshake";

/**
 * Grades the seat's own log for the transport version handshake.
 *
 * The refused line is the DEFECT signature and is fatal in every mode, including `skip`: on a build with
 * no handshake it cannot appear at all, so if it does, something is very wrong and silence would be the
 * wrong answer.
 *
 * `expectedSenders` is deliberately a SET rather than one id. The seat's `HandshakeManager` prints the
 * sender id its transport handed it, and which id that is -- the host's net id, or the ENet wire's `1`
 * -- depends on where the sender mapping ends up living. On an ENet-hosted session the two are the same
 * number anyway. Accepting either, and RECORDING which one showed up, is a real assertion (a third id
 * fails) that cannot go red for the wrong reason; `--handshake-sender` pins it exactly once the answer
 * is settled, and `preferredSender` turns "it was the other one" into a note in the artifact rather
 * than either a failure or a silence.
 */
export function gradeSeatHandshake(text, { expectedSenders = [], preferredSender = null, mode = "require" } = {}) {
  const lines = splitLogLines(text);
  const accepted = [];
  const refused = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = HANDSHAKE_ACCEPTED_RE.exec(line);
    if (match) {
      accepted.push({ sender: match[1], lineNumber: index + 1, text: line.slice(0, MAX_MATCH_TEXT) });
    }
    if (line.includes(HANDSHAKE_REFUSED_TEXT)) {
      refused.push({ lineNumber: index + 1, text: line.slice(0, MAX_MATCH_TEXT) });
    }
  }

  const senders = [...new Set(accepted.map(entry => entry.sender))];
  const problems = [];
  const notes = [];
  // Not a failure: both ids are a working handshake. But on a Steam-hosted session the host's own net
  // id is the expected one, so seeing only the ENet wire id means the sender mapping lives somewhere
  // other than where this was written -- worth saying out loud in the artifact, once.
  if (preferredSender && senders.length > 0 && !senders.includes(preferredSender)) {
    notes.push(
      `the seat accepted its handshake from sender(s) ${senders.join(", ")} rather than the host's own net id `
      + `${preferredSender}. Both are a working handshake; pin the one this build actually uses with `
      + "--handshake-sender once it is settled."
    );
  }
  if (refused.length > 0) {
    problems.push(
      `the seat refused ${refused.length} handshake message(s) as arriving for a peer it is not mid-handshake `
      + `with: ${refused.map(entry => entry.text).join(" | ")}. That is the exact signature of the seat `
      + "registering its handshake under an id the transport never delivers."
    );
  }
  if (mode === "require") {
    if (accepted.length === 0) {
      problems.push(
        `the seat log has no "${HANDSHAKE_ACCEPTED_TEXT} <id>" line, so the transport version handshake `
        + "never completed on this seat. If this build genuinely has no handshake step, add it to "
        + "BUILDS_WITHOUT_HANDSHAKE or pass --handshake skip -- do not delete the leg."
      );
    }
    const unexpected = expectedSenders.length > 0 ? senders.filter(sender => !expectedSenders.includes(sender)) : [];
    if (unexpected.length > 0) {
      problems.push(
        `the seat accepted a handshake from sender(s) ${unexpected.join(", ")}, which is neither the host's net id `
        + `nor the ENet wire host id (expected one of ${expectedSenders.join(", ")}).`
      );
    }
  }

  return {
    ok: problems.length === 0,
    verdict: problems.length > 0 ? "fail" : mode === "skip" ? "skipped" : "pass",
    mode,
    senders,
    accepted,
    refused,
    expectedSenders,
    preferredSender,
    notes,
    problems
  };
}

/**
 * The roster gate: the seat is a member AND nobody is still connecting.
 *
 * `isConnected` is NOT consulted. A live five-seat Steam-hosted lobby that went on to start a run
 * reported `isConnected: false` for every couch seat, so a gate built on it would be red on a healthy
 * session and, worse, could be green on an unhealthy one. It is returned as evidence and believed about
 * nothing.
 */
export function gradeRoster(lobby, { seatPlayerId }) {
  const players = lobby?.players ?? [];
  const ids = players.map(player => player?.id ?? null);
  const problems = [];
  if (lobby?.netGameType !== "host") {
    problems.push(`lobby.netGameType is ${JSON.stringify(lobby?.netGameType ?? null)}, expected "host"`);
  }
  if (!seatPlayerId) {
    problems.push("the seat never resolved a player id, so its membership cannot be checked");
  } else if (!ids.includes(seatPlayerId)) {
    problems.push(`the seat ${seatPlayerId} is not in lobby.players (${ids.join(", ") || "empty"})`);
  }
  const connecting = lobby?.connectingPlayerCount ?? null;
  if (connecting !== 0) {
    problems.push(`lobby.connectingPlayerCount is ${JSON.stringify(connecting)}, expected 0 -- a seat still mid-join has not joined`);
  }
  return {
    ok: problems.length === 0,
    problems,
    playerIds: ids,
    hostPlayerId: lobby?.hostPlayerId ?? null,
    connectingPlayerCount: connecting,
    maxPlayers: lobby?.maxPlayers ?? null,
    // Recorded, never asserted on -- see the doc comment.
    isConnectedReported: players.map(player => ({ id: player?.id ?? null, isConnected: player?.isConnected ?? null }))
  };
}

/**
 * Finds the one node a menu step should click.
 *
 * `dev scene tree` returns a FLAT node list, so a step is "the node named X whose type ends in Y, under
 * the submenu the previous step opened". Ambiguity is reported rather than resolved by picking the
 * first: two live candidates means the route's assumption is wrong, and clicking one at random is how a
 * probe lands on the wrong screen and then blames the game.
 */
export function findMenuCandidates(tree, { name, nodeType, scopePath = null }) {
  const prefix = scopePath ? `${scopePath}/` : null;
  return (tree?.nodes ?? []).filter(node => {
    if (node?.name !== name) return false;
    if (nodeType && !String(node?.nodeType ?? "").endsWith(`.${nodeType}`) && node?.nodeType !== nodeType) return false;
    if (prefix && !String(node?.nodePath ?? "").startsWith(prefix)) return false;
    return true;
  });
}

/** Nodes whose managed type is exactly the given class (matched on the type's tail). */
export function findNodesOfType(tree, nodeType) {
  return (tree?.nodes ?? []).filter(node =>
    String(node?.nodeType ?? "").endsWith(`.${nodeType}`) || node?.nodeType === nodeType);
}

/** Assembles result.json. `ok` is false as soon as any leg failed; the FIRST failure is the headline. */
export function buildResult({ legs, targets, args, startedAt, finishedAt, evidence = {}, error = null }) {
  const failing = legs.find(leg => leg.verdict === "fail") ?? null;
  return {
    schema: RESULT_SCHEMA,
    ok: failing === null && error === null,
    failingLeg: failing ? { n: failing.n, name: failing.name, detail: failing.detail, evidence: failing.evidence ?? [] } : null,
    error: error ? { message: error.message, kind: error.kind ?? "probe" } : null,
    startedAt,
    finishedAt,
    gameVersion: evidence?.gameVersion ?? null,
    hostBranch: evidence?.hostBranch ?? null,
    target: {
      baseUrl: targets.baseUrl,
      browserPort: targets.browserPort,
      instance: targets.instance,
      userDir: targets.userDir,
      hostStdoutPath: targets.hostStdoutPath,
      hostStderrPath: targets.hostStderrPath,
      outDir: targets.outDir,
      sources: targets.sources
    },
    args,
    legs,
    evidence
  };
}

// =================================================================================================
// live plumbing
// =================================================================================================

const note = (...parts) => console.error("[steam-host-join]", ...parts);

async function readTextIfPresent(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    return { missing: true, reason: error.code ?? error.message };
  }
}

/** Real line count, counted exactly the way parseHostTransportLog numbers lines. */
async function countLines(path) {
  const text = await readTextIfPresent(path);
  if (typeof text !== "string") return null;
  return splitLogLines(text).length;
}

/**
 * A screenshot with NO --width/--height.
 *
 * Asking the game to resize for a capture returns a partially-composited frame; the probe-lib helper
 * always passes a size, so this deliberately does not use it.
 */
async function shot(targets, name, evidence) {
  const path = resolvePath(targets.outDir, name);
  try {
    await sts2(["dev", "screenshot", "--output", path]);
    evidence.screenshots.push(path);
    return path;
  } catch (error) {
    note(`screenshot ${name} failed (non-fatal): ${error.message}`);
    return null;
  }
}

// =================================================================================================
// main
// =================================================================================================

async function main(argv) {
  const startedAt = new Date().toISOString();
  const args = parseProbeArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  // The scenario runner writes {hookName, input, scenario, step} to the hook's stdin; `input` may carry
  // the same keys as the flags, and CLI flags win.
  const hookInput = await readHookStdin();
  for (const key of ["base", "out", "instance", "handshake"]) {
    if (hookInput?.[key] !== undefined && argv.indexOf(`--${key}`) < 0) {
      args[key] = String(hookInput[key]);
    }
  }
  // Re-validate: the scenario's `input` block bypasses parseProbeArgs entirely.
  if (!HANDSHAKE_MODES.includes(args.handshake)) {
    throw new ProbeUsageError(`handshake must be one of ${HANDSHAKE_MODES.join("|")}; got ${JSON.stringify(args.handshake)}`);
  }

  const targets = resolveTargets({ args, env: process.env });
  if (targets.instance) {
    process.env.SPIRECTL_INSTANCE = targets.instance;
  }

  if (args.dryRun) {
    // Everything that can be decided without touching the game, printed as the one JSON object a hook
    // is allowed to emit. No lease, no bridge call, no browser.
    const plan = {
      dryRun: true,
      target: targets,
      lockResources: lockResourcesFor(targets),
      menuRoute: MENU_ROUTE,
      handshake: resolveHandshakeMode(null, targets.handshake),
      seatLogPathPattern: seatLogPathFor(targets.userDir, "<slot>")
    };
    console.log(JSON.stringify({ output: plan, artifacts: [] }));
    return;
  }

  await mkdir(targets.outDir, { recursive: true });
  await rm(resolvePath(targets.outDir, "result.json"), { force: true });

  note(`base=${targets.baseUrl} instance=${targets.instance ?? "(default)"} out=${targets.outDir}`);
  note(`host stderr=${targets.hostStderrPath}`);

  const legs = [];
  const evidence = { screenshots: [], archives: [], menu: [], gameVersion: null, hostBranch: null, seat: null };
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
    // LEG 0 -- preflight: which build, and is the Steam branch even reachable?
    // -------------------------------------------------------------------------------------------
    const preflight = await leg(0, "preflight", "the bridge answers, the game build is known, and the host is not running with -fastmp", async () => {
      const info = await sts2(["game", "info"]);
      const gameVersion = info?.bridge?.gameVersion ?? null;
      evidence.gameVersion = gameVersion;
      evidence.bridgeBuildIdentity = info?.bridge?.buildIdentity ?? null;
      await writeFile(resolvePath(targets.outDir, "game-info.json"), `${JSON.stringify(info, null, 2)}\n`);

      const configuredArgs = info?.config?.game?.launchArgs ?? null;
      let processArgs = null;
      if (targets.hostPid) {
        const raw = await readTextIfPresent(`/proc/${targets.hostPid}/cmdline`);
        processArgs = typeof raw === "string" ? parseProcCmdline(raw) : null;
      }
      // The process's own argv is the truth when we have it; the configured list is the best available
      // answer when we do not.
      const launch = gradeLaunchArgs(processArgs ?? (Array.isArray(configuredArgs) ? configuredArgs : null));
      evidence.launchArgs = { configuredArgs, processArgs, ...launch };
      if (launch.verdict === "fastmp") {
        throw new ProbeError(launch.detail);
      }
      const handshake = resolveHandshakeMode(gameVersion, targets.handshake);
      evidence.handshakePlan = handshake;
      return {
        detail: `game=${gameVersion ?? "unknown"} lane=${info?.bridge?.buildIdentity?.sts2ApiLane ?? "unknown"} `
          + `launchArgs=${launch.verdict}; leg 5 will ${handshake.mode} (${handshake.reason})`,
        data: { gameVersion, handshake, launch },
        evidence: [resolvePath(targets.outDir, "game-info.json")]
      };
    });
    if (preflight.verdict === "fail") throw new StopProbe();

    // -------------------------------------------------------------------------------------------
    // LEG 1 -- the three clicks that reach a Steam-hosted lobby
    // -------------------------------------------------------------------------------------------
    // The baseline is taken BEFORE the route runs, so leg 2 reads only what this host start wrote.
    const hostLogBaseline = await countLines(targets.hostStderrPath);
    evidence.hostLogBaseline = hostLogBaseline;

    const menuLeg = await leg(1, "menu-host", "Main Menu -> Multiplayer -> Host -> Standard reaches a host lobby", async entry => {
      await reachMainMenu(targets);
      entry.evidence.push(...[await shot(targets, "01-main-menu.png", evidence)].filter(Boolean));

      let scopePath = null;
      for (const step of MENU_ROUTE) {
        const resolved = await resolveMenuStep(step, scopePath, targets);
        evidence.menu.push(resolved);
        const click = await hoverAndClick(resolved.nodePath);
        resolved.click = click;
        note(`menu step ${step.id}: clicked ${resolved.nodePath} at (${click.x},${click.y})`);
        if (step.opensType) {
          const opened = await waitFor(
            () => sceneTree(),
            tree => findNodesOfType(tree, step.opensType).length > 0,
            { attempts: Math.ceil(targets.menuTimeoutMs / 500), intervalMs: 500, what: `the ${step.opensType} submenu` }
          );
          scopePath = findNodesOfType(opened, step.opensType).at(-1).nodePath;
          resolved.opened = scopePath;
        }
        await sleep(500);
        entry.evidence.push(...[await shot(targets, step.shot, evidence)].filter(Boolean));
      }

      // Hosting is asynchronous: the lobby screen appears once the transport is up.
      await waitFor(
        () => sceneTree(),
        tree => tree?.screen?.id === SCREEN_START_RUN_LOBBY,
        { attempts: Math.ceil(targets.lobbyTimeoutMs / 1000), intervalMs: 1000, what: "the start-run host lobby screen" }
      );
      const lobby = await waitFor(
        async () => (await state())?.characterSelect?.lobby ?? null,
        value => value?.netGameType === "host",
        { attempts: 30, intervalMs: 1000, what: 'characterSelect.lobby.netGameType == "host"' }
      );
      return {
        detail: `hostPlayerId=${lobby.hostPlayerId} maxPlayers=${lobby.maxPlayers}`,
        data: { lobby, route: evidence.menu.map(step => ({ id: step.id, nodePath: step.nodePath })) }
      };
    });
    // -------------------------------------------------------------------------------------------
    // LEG 2 -- THE ANTI-DEGRADATION GATE
    // -------------------------------------------------------------------------------------------
    // Runs even when leg 1 failed, because it is the diagnosis: "the lobby never appeared" and "the
    // host start took the ENet branch" look identical from the menu and are answered here.
    const branchLeg = await leg(2, "steam-branch", "the host log proves the STEAM branch ran and created a real lobby with a couch ENet side", async entry => {
      const text = await readTextIfPresent(targets.hostStderrPath);
      if (typeof text !== "string") {
        throw new ProbeError(
          `the host log ${targets.hostStderrPath} could not be read (${text.reason}). Point --host-stderr at the `
          + "stream `sts2 game launch` tees for THIS host; a worktree's own .sts2/ is empty."
        );
      }
      const parsed = parseHostTransportLog(text, { sinceLine: hostLogBaseline ?? 0 });
      const verdict = gradeHostBranch(parsed);
      evidence.hostBranch = { ...verdict, parsed };
      const transportPath = resolvePath(targets.outDir, "host-transport.json");
      await writeFile(transportPath, `${JSON.stringify({ hostStderrPath: targets.hostStderrPath, baselineLines: hostLogBaseline, parsed, verdict }, null, 2)}\n`);
      entry.evidence.push(transportPath);
      if (!verdict.ok) {
        throw new ProbeError(`host branch is "${verdict.branch}", not "steam": ${verdict.problems.join(" | ")}`);
      }
      return {
        detail: `branch=steam lobby=${verdict.lobbyId} hostNetId=${verdict.hostNetId} couchSeats=${verdict.couchSeats}`,
        data: verdict
      };
    });
    // A host that is not on the Steam branch cannot answer the question this probe asks, and joining a
    // seat to it would produce a green ENet result -- the exact outcome the gate exists to prevent.
    if (menuLeg.verdict === "fail" || branchLeg.verdict === "fail") throw new StopProbe();
    const hostNetId = branchLeg.data.hostNetId;

    // -------------------------------------------------------------------------------------------
    // LEG 3 -- one browser seat joins over the real path
    // -------------------------------------------------------------------------------------------
    const seatLeg = await leg(3, "seat-join", "one browser seat reaches its mirror view and shows a real ENet handshake in its own godot.log", async entry => {
      const joined = await joinSeats({ ...targets, seats: 1 }, evidence);
      entry.evidence.push(...joined.flatMap(record => record?.screenshots ?? []));
      // Recorded BEFORE the verdict: a seat that failed still has a slot, a port and a log, and legs 4
      // and 5 are what turn those into an explanation.
      entry.data = joined[0] ?? null;
      const problems = checkSeatRecords(joined, 1);
      if (problems.length > 0) {
        throw new ProbeError(`the seat has no proof it joined: ${problems.join(" | ")}`);
      }
      const record = joined[0];
      return { detail: `${record.name} -> slot ${record.slot} / port ${record.port} (${record.ms}ms)`, data: record };
    });

    // Legs 4 and 5 run WHETHER OR NOT the join succeeded. A seat that never appeared is precisely the
    // symptom of a broken transport handshake, and its log is where the reason is written -- stopping
    // here would throw away the diagnosis at the moment it is worth most. When the join failed before
    // a port was resolved there is no recorded log path, so the first seat slot is used instead.
    const seat = seatLeg.data ?? null;
    const seatLogPath = seat?.logPath ?? seatLogPathFor(targets.userDir, SEAT_MIN_SLOT);
    evidence.seat = {
      name: seat?.name ?? targets.seatName,
      slot: seat?.slot ?? SEAT_MIN_SLOT,
      port: seat?.port ?? null,
      playerId: seat?.playerId ?? null,
      logPath: seatLogPath,
      logPathIsAssumed: !seat?.logPath
    };

    // -------------------------------------------------------------------------------------------
    // LEG 4 -- the roster the whole gate is about
    // -------------------------------------------------------------------------------------------
    await leg(4, "roster", "the seat is in lobby.players and no player is left connecting", async () => {
      // The wait is a convenience; gradeRoster is the verdict. On a timeout the LAST observed lobby is
      // graded anyway, so the failure reads "p:1002 is not in lobby.players (p:7656…)" rather than a
      // bare "timed out waiting for".
      let lobby = null;
      try {
        lobby = await waitFor(
          async () => (await state())?.characterSelect?.lobby ?? null,
          value => (value?.players ?? []).some(player => player?.id === seat?.playerId) && value?.connectingPlayerCount === 0,
          { attempts: 40, intervalMs: 1000, what: `${seat?.playerId ?? "the seat"} to be a settled member of the lobby` }
        );
      } catch {
        lobby = (await state().catch(() => null))?.characterSelect?.lobby ?? null;
      }
      const verdict = gradeRoster(lobby, { seatPlayerId: seat?.playerId ?? null });
      evidence.roster = verdict;
      if (!verdict.ok) {
        throw new ProbeError(verdict.problems.join(" | "));
      }
      return { detail: `players=${verdict.playerIds.join(", ")} host=${verdict.hostPlayerId}`, data: verdict };
    });
    await shot(targets, "05-lobby-with-seat.png", evidence);

    // -------------------------------------------------------------------------------------------
    // LEG 5 -- the transport version handshake, on builds that have one
    // -------------------------------------------------------------------------------------------
    const plan = evidence.handshakePlan;
    await leg(5, "handshake", `the seat accepted the transport version handshake and refused none (${plan.mode}: ${plan.reason})`, async entry => {
      const text = await readTextIfPresent(seatLogPath);
      if (typeof text !== "string") {
        throw new ProbeError(
          `the seat log ${seatLogPath} could not be read (${text.reason})`
          + (evidence.seat.logPathIsAssumed ? " -- the join failed before a seat port was resolved, so this path is the first seat slot, not an observed one" : "")
        );
      }
      const expectedSenders = targets.handshakeSender
        ? [targets.handshakeSender]
        : [...new Set([hostNetId, ENET_WIRE_HOST_NET_ID].filter(Boolean))];
      const verdict = gradeSeatHandshake(text, { expectedSenders, preferredSender: hostNetId, mode: plan.mode });
      evidence.handshake = verdict;
      const handshakePath = resolvePath(targets.outDir, "handshake.json");
      await writeFile(handshakePath, `${JSON.stringify({ seatLogPath, logPathIsAssumed: evidence.seat.logPathIsAssumed, plan, verdict }, null, 2)}\n`);
      entry.evidence.push(handshakePath);
      if (!verdict.ok) {
        throw new ProbeError(verdict.problems.join(" | "));
      }
      return {
        verdict: verdict.verdict,
        detail: (verdict.mode === "skip"
          ? `skipped (${plan.reason}); no refused-handshake line present either`
          : `accepted from sender(s) ${verdict.senders.join(", ")}; ${verdict.refused.length} refused`)
          + (verdict.notes.length > 0 ? ` -- NOTE: ${verdict.notes.join(" ")}` : ""),
        data: verdict
      };
    });
  } catch (error) {
    if (!(error instanceof StopProbe)) {
      fatal = {
        message: error instanceof ProbeError || error instanceof ProbeUsageError ? error.message : `${error?.name}: ${error?.message}`,
        kind: error?.constructor?.name ?? "Error"
      };
      note(`aborted: ${fatal.message}`);
    }
  } finally {
    try { evidence.archives.push(...await archiveLogs(targets, evidence)); } catch (error) { note(`log archive failed (non-fatal): ${error.message}`); }
    try { await closeBrowsers(); } catch { /* best effort */ }
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
  for (const path of [...new Set([...evidence.archives, ...evidence.screenshots, ...legs.flatMap(entry => entry.evidence ?? [])])]) {
    if (existsSync(path)) artifacts.push({ path, kind: path.endsWith(".png") ? "screenshot" : path.endsWith(".json") ? "json" : "log" });
  }

  const headline = detail => typeof detail === "string" && detail.length > 240 ? `${detail.slice(0, 240)}...` : detail;
  const output = {
    ok: result.ok,
    gameVersion: result.gameVersion,
    hostBranch: result.hostBranch?.branch ?? null,
    failingLeg: result.failingLeg ? { ...result.failingLeg, detail: headline(result.failingLeg.detail) } : null,
    legs: result.legs.map(entry => ({ n: entry.n, name: entry.name, verdict: entry.verdict, detail: headline(entry.detail) })),
    resultPath
  };
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

/** Acquires or inherits leases for exactly the resources this probe drives. */
function acquireLiveLock(targets) {
  const resources = lockResourcesFor(targets);
  const inheritedOwner = process.env.COUCHCOOP_LIVEQA_OWNER;
  const inheritedPid = Number(process.env.COUCHCOOP_LIVEQA_PID ?? 0);
  if (inheritedOwner && inheritedPid > 0) {
    assertLease({ owner: inheritedOwner, pid: inheritedPid, resources });
    return { held: true, owned: false, holder: inheritedOwner, pid: inheritedPid, resources };
  }
  const owner = "steam-host-join-probe";
  acquireLease({ owner, pid: process.pid, resources });
  return { held: true, owned: true, holder: owner, pid: process.pid, resources };
}

function releaseLiveLock(lock) {
  if (!lock?.owned) return;
  try { releaseLease({ owner: lock.holder, pid: lock.pid }); } catch { /* a noisy probe beats a stuck lock */ }
}

// -------------------------------------------------------------------------------------------------
// the menu route
// -------------------------------------------------------------------------------------------------

/**
 * Puts the game on the main menu, loading the shared main-menu fixture if it is somewhere else.
 *
 * A freshly restarted game reaches the menu on its own, but a probe re-run against a game that is
 * already in a lobby or a run has to get back out, and the fixture is the committed way to do that.
 */
async function reachMainMenu(targets) {
  let tree = await sceneTree();
  if (tree?.screen?.id === SCREEN_MAIN_MENU) return tree;
  note(`screen is ${JSON.stringify(tree?.screen?.id ?? null)}; loading the main-menu fixture`);
  await loadFixture(FIXTURE_MAIN_MENU);
  tree = await waitFor(
    () => sceneTree(),
    value => value?.screen?.id === SCREEN_MAIN_MENU,
    { attempts: Math.ceil(targets.menuTimeoutMs / 500), intervalMs: 500, what: "the main menu screen" }
  );
  // The boot flow keeps pushing screens for a moment after a restart; let it settle before clicking.
  await sleep(1500);
  return tree;
}

/**
 * Resolves one menu step to a single node path, waiting for the button to exist and be effectively
 * visible, and refusing an ambiguous match.
 */
async function resolveMenuStep(step, scopePath, targets) {
  const tree = await waitFor(
    () => sceneTree(),
    value => findMenuCandidates(value, { name: step.name, nodeType: step.nodeType, scopePath }).length > 0,
    { attempts: Math.ceil(targets.menuTimeoutMs / 500), intervalMs: 500, what: `a ${step.nodeType} named ${step.name}${scopePath ? ` under ${scopePath}` : ""}` }
  );
  const candidates = findMenuCandidates(tree, { name: step.name, nodeType: step.nodeType, scopePath });

  const visible = [];
  for (const candidate of candidates) {
    const details = await nodeDetails(candidate.nodePath, { properties: true, transform: false }).catch(() => null);
    if (isEffectivelyVisible(details)) visible.push(candidate);
  }
  const chosen = visible.length === 1 ? visible[0] : null;
  if (!chosen) {
    const described = candidates.map(node => `${node.nodePath} (${node.nodeType})`).join(", ") || "none";
    throw new ProbeError(
      `menu step "${step.id}" needs exactly one effectively-visible ${step.nodeType} named ${step.name}`
      + `${scopePath ? ` under ${scopePath}` : ""}, found ${visible.length} of ${candidates.length} candidate(s): ${described}. `
      + "If the game moved this button, update MENU_ROUTE -- do not widen the match."
    );
  }
  return { id: step.id, name: step.name, nodeType: step.nodeType, scopePath, nodePath: chosen.nodePath, candidates: candidates.length };
}

// -------------------------------------------------------------------------------------------------
// evidence
// -------------------------------------------------------------------------------------------------

/** Copies the host and seat logs into the artifact dir. Runs on the failure path too. */
async function archiveLogs(targets, evidence) {
  const logDir = resolvePath(targets.outDir, "logs");
  await mkdir(logDir, { recursive: true });
  const files = [
    { label: "host-stdout", path: targets.hostStdoutPath },
    { label: "host-stderr", path: targets.hostStderrPath },
    ...(evidence.seat?.logPath ? [{ label: `seat-slot-${evidence.seat.slot}`, path: evidence.seat.logPath }] : [])
  ];
  const written = [];
  const manifest = [];
  for (const file of files) {
    const text = await readTextIfPresent(file.path);
    if (typeof text !== "string") {
      manifest.push({ ...file, archivedPath: null, missing: text.reason });
      continue;
    }
    const destination = resolvePath(logDir, `${file.label}.log`);
    await writeFile(destination, text);
    written.push(destination);
    let mtime = null;
    try { mtime = (await stat(file.path)).mtime.toISOString(); } catch { /* fine */ }
    manifest.push({ ...file, archivedPath: destination, mtime, lines: splitLogLines(text).length });
  }
  const manifestPath = resolvePath(targets.outDir, "logs.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  written.push(manifestPath);
  note(`archived ${written.length} evidence file(s) into ${logDir}`);
  return written;
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
