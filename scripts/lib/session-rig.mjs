// A HOSTED COUCH-COOP SESSION YOU OWN END TO END — the lifecycle half of scripts/run-session-soak.mjs.
//
// One isolated host game inside a PRIVATE headless gamescope compositor, N browser seats joined through the real
// join path, an embark, and a teardown that signals only processes this rig started or can prove it owns.
//
// It is the same lifecycle as scripts/bring-up-gamescope-instance.sh and scripts/bring-up-five-player-instance.sh
// (scratch config, `env -u DISPLAY -u WAYLAND_DISPLAY` compositor, display from the compositor's own child, launch
// INTO it with `--display-driver x11`, identity-checked port file, pid+start-ticks teardown) re-expressed in Node
// for three reasons: both scripts hard-code their run dir and a purpose-specific environment (geoclip bench
// switches; the >4-player loadout editor), a soak has to SUPERVISE the compositor and the host for the whole
// session rather than hand them off, and the self-test needs every side effect injectable. Read those scripts'
// headers for the WHY behind each step; the traps are the same and are not re-explained here.
//
// What this rig adds on top of them:
//   * a configurable GAME ROOT (an isolated farm: symlinked install + real `mods/`), with a refusal when that root's
//     `mods/` is the live install's — `sts2 game launch` repairs the bridge in place, so a launch against the live
//     install's mods dir is a deploy;
//   * an optional SEED dir copied into the instance user dir before the CLI's own seed (copy-if-missing, so the
//     seed's files win), and `seedExclusive` to stop the CLI layering the operator's profile on top;
//   * a read-only PREFLIGHT for the three ways another session on this machine silently breaks a hosted run:
//     the ENet port already bound, seat ports already listening (the host skips them and the lobby runs short of
//     slots), and seat bridge sockets already held (a seat's bridge path is `/tmp/spirectl-bridge-slot-<N>.sock`
//     for EVERY host on the box);
//   * seat discovery from the host's own process tree, confirmed by each seat's environment;
//   * an embark that readies every player through ITS OWN bridge with `sts2 act ready` — the one semantic action
//     the maintainer approved for embarking a QA run. Before a seat's bridge is used, the socket is proved to be
//     held by that seat's process and by nothing else, so a ready can never reach another session's seat.
//
// Nothing here sends gameplay input. The route (scripts/lib/run-route.mjs) is what happens after embark.

import { spawn as nodeSpawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import path from "node:path";

import { assertLease } from "../live-qa-lock.mjs";
import {
  DEFAULT_HOST_PORT, SEAT_BASE_NET_ID, SEAT_MIN_SLOT, SEAT_PORT_STEP,
  checkSeatRecords, closeBrowsers as closeSeatBrowsers, joinSeats as joinBrowserSeats,
  seatBridgeSocketFor, seatLogPathFor, seatPages as openSeatPages
} from "../probe-five-player-run.mjs";
import { BROWSER_PORT_RELATIVE, portIsOpen } from "./instance-port.mjs";
import { compareRunStates, summarizeRunState } from "./peer-logs.mjs";
import { classifyChromium, descendantsOf, parseStat, readCmdline, readEnviron, readProcessTable } from "./process-sampler.mjs";
import { PRIMARY_REPO_ROOT, REPO_ROOT } from "./repo-layout.mjs";

export const DEFAULT_ENET_PORT = 33771;
/** A stock lobby holds four players: the host plus three couch seats (slots 2..4). */
export const STOCK_LOBBY_SEATS = 3;
export const DEFAULT_LOBBY_FIXTURE = path.join(REPO_ROOT, "tests/fixtures/pc-lobby-host.sts2.fixture.yaml");
export const LOCK_FLAG = "--i-hold-the-live-lock";
/** The `sts2` CLI's seed sentinel: present => the CLI does not copy the operator's profile into the instance. */
export const CLI_SEED_SENTINEL = path.join("SlayTheSpire2", ".spirectl-seeded");

export class RigError extends Error {
  name = "RigError";
  constructor(code, message, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));

// =================================================================================================
// the live-QA gate
// =================================================================================================

/**
 * The leases every hosted run needs whatever else it touches: the install it reads (shared, as every live session
 * holds it), its own game, and the ENet port it will bind.
 */
export function mandatoryLeases({ instance, enetPort = DEFAULT_ENET_PORT }) {
  return ["shared:install", `exclusive:game:${instance}`, `exclusive:port:${enetPort}`];
}

/**
 * Refuses unless the operator said they hold the lease AND the lease they inherited (from
 * `scripts/live-qa-lock.mjs with ... --`) really covers `resources`. The flag alone is a promise; the assertion is
 * the proof. Returns the lease as held.
 */
export function checkLiveLockGate({ flag, env = process.env, resources, assert = assertLease }) {
  if (!flag) {
    throw new RigError("lock-flag-missing",
      `this starts a real game, a compositor and browsers. Take the live-QA lease first (the \`couch-live-lock\` skill), `
      + `run under \`node scripts/live-qa-lock.mjs with --owner <you> --resource <each> -- <this command>\`, and re-run with ${LOCK_FLAG}.`, 2);
  }
  const owner = env.COUCHCOOP_LIVEQA_OWNER;
  const pid = Number(env.COUCHCOOP_LIVEQA_PID ?? 0);
  if (!owner || !Number.isInteger(pid) || pid <= 0) {
    throw new RigError("lease-not-inherited",
      "no inherited live-QA lease (COUCHCOOP_LIVEQA_OWNER / COUCHCOOP_LIVEQA_PID are unset). Run this under "
      + "`node scripts/live-qa-lock.mjs with --owner <you> --resource <each> -- <this command>`; never hand-write --pid.", 2);
  }
  try {
    const lease = assert({ owner, pid, resources });
    return { owner, pid, resources: lease.resources.map(resource => `${resource.mode}:${resource.name}`) };
  } catch (error) {
    throw new RigError("lease-does-not-cover", `the inherited lease does not cover this run: ${error.message}`, 2);
  }
}

// =================================================================================================
// small pure helpers
// =================================================================================================

export function parseEnvPair(text) {
  const split = String(text).indexOf("=");
  const key = split < 0 ? "" : text.slice(0, split);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new RigError("bad-env", `--env expects KEY=VALUE with a shell-safe KEY; got ${JSON.stringify(text)}`, 2);
  return [key, text.slice(split + 1)];
}

/** YAML-safe scalar: a JSON string is a valid YAML double-quoted scalar. */
const yamlScalar = value => JSON.stringify(String(value));

/**
 * The scratch `sts2` config for this session. Passed with `--config` on every call, from a scratch cwd, so the
 * repo's cwd-discovered `sts2.local.yaml` (which injects a desktop launch wrapper) is never read.
 * `symlinkUserDataDirs: []`: see bring-up-five-player-instance.sh — inheriting the shared `couch-coop` link would
 * clobber the operator's browser-port record.
 */
export function buildScratchConfig({ gamePath, assembliesDir, instancesDir, launchArgs = [], launchEnv = {}, disableBackgroundThrottle = true, ipcPath = null }) {
  const env = Object.entries(launchEnv);
  return [
    "# Generated by scripts/lib/session-rig.mjs. Scratch config: never commit, never reuse across sessions.",
    "game:",
    `  path: ${yamlScalar(gamePath)}`,
    `  assembliesDir: ${yamlScalar(assembliesDir)}`,
    "  # No launchWrapper: the private compositor is already running and the launch goes INTO it via DISPLAY.",
    `  launchArgs: ${JSON.stringify(["--display-driver", "x11", ...launchArgs.map(String)])}`,
    `  disableBackgroundThrottle: ${disableBackgroundThrottle ? "true" : "false"}`,
    env.length === 0 ? "  launchEnv: {}" : "  launchEnv:",
    ...env.map(([key, value]) => `    ${yamlScalar(key)}: ${yamlScalar(value)}`),
    "instances:",
    `  dir: ${yamlScalar(instancesDir)}`,
    "  symlinkUserDataDirs: []",
    // A directly launched host listens where WE told it to; the CLI must look there and nowhere else.
    ...(ipcPath ? ["transport:", "  kind: ipc", `  ipcPath: ${yamlScalar(ipcPath)}`] : []),
    ""
  ].join("\n");
}

/** The compositor must not see a desktop route: with WAYLAND_DISPLAY set, clients sail past it onto the desktop. */
export function compositorEnv(env) {
  const out = { ...env };
  delete out.DISPLAY;
  delete out.WAYLAND_DISPLAY;
  out.XDG_SESSION_TYPE = "x11";
  return out;
}

/** Environment for any `sts2` call: the instance (or an explicit socket) owns the bridge path, never an inherited one. */
export function sts2BaseEnv(env) {
  const out = { ...env };
  for (const key of ["SPIRECTL_INSTANCE", "SPIRECTL_BRIDGE_SOCKET_PATH", "SPIRECTL_BRIDGE_PIPE_NAME", "SPIRECTL_BRIDGE_TCP_ADDRESS", "COUCHCOOP_PROBE_STS2_PREFIX"]) {
    delete out[key];
  }
  return out;
}

/** Environment for `sts2 game launch`: into the private display, and no desktop route to fall back to. */
export function gameLaunchEnv(env, display) {
  const out = sts2BaseEnv(env);
  delete out.WAYLAND_DISPLAY;
  out.DISPLAY = display;
  out.XDG_SESSION_TYPE = "x11";
  return out;
}

/**
 * Environment for launching the game binary DIRECTLY (the default launch mode): the caller's environment minus every
 * display route and every variable this repo, spirectl, .NET or Vulkan reads (an inherited one would silently change
 * the build or the device under test), plus private XDG dirs, the private display, the bridge socket, and the
 * caller's own `launchEnv` last so it wins. XAUTHORITY is kept, as the gamescope bring-up scripts keep it.
 */
export function directLaunchEnv(env, { display, xdg, bridgeSocket, disableBackgroundThrottle = true, launchEnv = {} }) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (["DISPLAY", "WAYLAND_DISPLAY", "GAMESCOPE_WAYLAND_DISPLAY"].includes(key)) continue;
    if (/^(COUCHCOOP_|SPIRECTL_|DOTNET_|VK_)/.test(key) || /^XDG_(DATA|CONFIG|CACHE|STATE)_HOME$/.test(key)) continue;
    out[key] = value;
  }
  Object.assign(out, xdg, { DISPLAY: display, XDG_SESSION_TYPE: "x11", SPIRECTL_BRIDGE_SOCKET_PATH: bridgeSocket });
  if (disableBackgroundThrottle) out.SPIRECTL_BRIDGE_DISABLE_BACKGROUND_THROTTLE = "1";
  return Object.assign(out, launchEnv);
}

/** A bridge socket path for a directly launched host: in the run dir when it fits sun_path, else a short /tmp one. */
export function hostBridgeSocketPath(runDir, instance) {
  const inRunDir = path.join(runDir, "host-bridge.sock");
  if (Buffer.byteLength(inRunDir) <= 100) return inRunDir;
  return `/tmp/soak-${instance}-${createHash("sha256").update(runDir).digest("hex").slice(0, 8)}.sock`;
}

/** First non-internal IPv4 address. The mod's browser server refuses loopback for viewer routes. */
export function detectLanHost(interfaces = networkInterfaces()) {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if ((entry.family === "IPv4" || entry.family === 4) && !entry.internal) return entry.address;
    }
  }
  return null;
}

export function cpuListIsValid(list) {
  return typeof list === "string" && /^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(list);
}

/** `game.path` / `game.assembliesDir` as the repo's own local config spells them (the bring-up scripts' grep). */
export function readLocalGameConfig(file, fs = nodeFs) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { path: null, assembliesDir: null };
  }
  const pick = key => {
    const match = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m").exec(text);
    return match ? match[1].replace(/^["']|["']$/g, "") : null;
  };
  return { path: pick("path"), assembliesDir: pick("assembliesDir") };
}

const realpathOrNull = (fs, target) => {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
};

const isInside = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/**
 * Refusals about WHERE this session would run, checked before anything starts:
 *   * the game root must have a real `mods/` of its own (`game launch` may write the bridge into it);
 *   * that `mods/` must not be the live install's (configured in `sts2.local.yaml`), which holds somebody's deploy;
 *   * the run dir must not be inside the operator's own game data or Steam dirs.
 */
export function checkPlacement({ gameRoot, runDir, liveGamePaths = [], fs = nodeFs, home = homedir() }) {
  const problems = [];
  const root = realpathOrNull(fs, gameRoot);
  if (!root) {
    problems.push(`--game-root ${gameRoot} does not exist`);
  } else {
    const mods = path.join(gameRoot, "mods");
    let modsStat = null;
    try { modsStat = fs.lstatSync(mods); } catch { /* absent */ }
    if (!modsStat) problems.push(`${mods} does not exist; an isolated game root needs a real mods/ of its own`);
    else if (modsStat.isSymbolicLink()) problems.push(`${mods} is a symlink; \`sts2 game launch\` repairs the bridge in place, so a linked mods/ would be written THROUGH`);
    const realMods = realpathOrNull(fs, mods);
    for (const live of liveGamePaths.filter(Boolean)) {
      const liveMods = realpathOrNull(fs, path.join(live, "mods"));
      if (realMods && liveMods && realMods === liveMods) {
        problems.push(`${mods} IS the configured game install's mods dir (${liveMods}); this rig never launches against the live install`);
      }
    }
  }
  const operatorRoots = [path.join(home, ".local", "share", "SlayTheSpire2"), path.join(home, ".steam"), path.join(home, ".local", "share", "Steam")];
  const run = path.resolve(runDir);
  for (const operatorRoot of operatorRoots) {
    const resolved = realpathOrNull(fs, operatorRoot) ?? operatorRoot;
    if (isInside(run, resolved) || isInside(run, operatorRoot)) problems.push(`--run-dir ${runDir} is inside the operator's own data (${operatorRoot})`);
  }
  return problems;
}

// =================================================================================================
// process identity
// =================================================================================================

/** `{pid, startTicks, ppid, comm, state, exe, cmdline}` for a live process, or null. */
export function readIdentity(pid, { procRoot = "/proc", fs = nodeFs } = {}) {
  let stat;
  try {
    stat = parseStat(fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8"));
  } catch {
    return null;
  }
  let exe = null;
  try { exe = fs.readlinkSync(path.join(procRoot, String(pid), "exe")); } catch { /* not ours, or gone */ }
  return { pid, startTicks: stat.startTicks, ppid: stat.ppid, comm: stat.comm, state: stat.state, exe, cmdline: readCmdline(procRoot, pid, fs) };
}

/** Is `identity` (pid + start ticks) still that same, non-zombie process? */
export function isSameProcess(identity, options = {}) {
  if (!identity || !Number.isInteger(identity.pid)) return false;
  const now = readIdentity(identity.pid, options);
  return Boolean(now) && now.startTicks === identity.startTicks && now.state !== "Z";
}

/**
 * The mod's published browser port, accepted only when the WRITER runs under this instance's user dir. A JS
 * mirror of scripts/lib/mp5-instance-port.py: a liveness check is not enough, because the CLI's seed copies the
 * operator's own port file (their port AND their live pid) into every new instance.
 */
export function resolvePublishedPort({ userDir, procRoot = "/proc", fs = nodeFs }) {
  const portFile = path.join(userDir, BROWSER_PORT_RELATIVE);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(portFile, "utf8"));
  } catch {
    return null;
  }
  const port = record?.port;
  const pid = record?.pid;
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !Number.isInteger(pid) || pid <= 0) return null;
  const env = readEnviron(procRoot, pid, fs);
  if (!env || env.get("XDG_DATA_HOME") !== userDir) return null;
  return { port, pid, portFile };
}

/** Any process whose own XDG_DATA_HOME is `userDir` — "is this instance still up", independent of its pid. */
export function anyProcessUnder(userDir, { procRoot = "/proc", fs = nodeFs, table = null } = {}) {
  for (const pid of (table ?? readProcessTable({ procRoot, fs })).keys()) {
    if (readEnviron(procRoot, pid, fs)?.get("XDG_DATA_HOME") === userDir) return pid;
  }
  return null;
}

// =================================================================================================
// sockets (read-only, from /proc/net)
// =================================================================================================

/** `/proc/net/unix` rows. `listening` = SO_ACCEPTCON (flag 0x10000) in state 01. */
export function parseProcNetUnix(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 7) continue;
    const flags = Number.parseInt(fields[3], 16);
    rows.push({
      inode: Number(fields[6]),
      flags,
      type: fields[4],
      state: fields[5],
      path: fields[7] ?? null,
      listening: (flags & 0x10000) !== 0 && fields[5] === "01"
    });
  }
  return rows;
}

/** `/proc/net/{tcp,tcp6,udp,udp6}` rows: local port, state (hex; 0A = TCP LISTEN), inode. */
export function parseProcNetInet(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const local = fields[1];
    const split = local.lastIndexOf(":");
    rows.push({ localPort: Number.parseInt(local.slice(split + 1), 16), state: fields[3].toUpperCase(), inode: Number(fields[9]) });
  }
  return rows;
}

const readProcNet = (procRoot, fs, name) => {
  try {
    return fs.readFileSync(path.join(procRoot, "net", name), "utf8");
  } catch {
    return "";
  }
};

/** Socket inodes a process holds, from its fd links (`socket:[<inode>]`). */
export function socketInodesOf(pid, { procRoot = "/proc", fs = nodeFs } = {}) {
  const inodes = new Set();
  let fds = [];
  try { fds = fs.readdirSync(path.join(procRoot, String(pid), "fd")); } catch { return inodes; }
  for (const fd of fds) {
    try {
      const match = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(path.join(procRoot, String(pid), "fd", String(fd))));
      if (match) inodes.add(Number(match[1]));
    } catch { /* closed between readdir and readlink */ }
  }
  return inodes;
}

/** `inode -> [{pid, comm}]` for the wanted inodes, by walking every readable process's fds once. */
export function socketOwners(inodes, { procRoot = "/proc", fs = nodeFs, table = null } = {}) {
  const wanted = new Set([...inodes].filter(inode => inode > 0));
  const owners = new Map([...wanted].map(inode => [inode, []]));
  if (wanted.size === 0) return owners;
  for (const row of (table ?? readProcessTable({ procRoot, fs })).values()) {
    for (const inode of socketInodesOf(row.pid, { procRoot, fs })) {
      if (wanted.has(inode)) owners.get(inode).push({ pid: row.pid, comm: row.comm });
    }
  }
  return owners;
}

/**
 * Proves `socketPath` is listened on by `pid` and by NOTHING else. Every host on this machine gives its slot-N
 * seat the same bridge path, so "something answers there" is not evidence it is our seat.
 */
export function verifyUnixSocketOwner({ socketPath, pid, procRoot = "/proc", fs = nodeFs }) {
  const listeners = parseProcNetUnix(readProcNet(procRoot, fs, "unix")).filter(row => row.listening && row.path === socketPath);
  if (listeners.length === 0) {
    return { ok: false, problem: `nothing is listening on ${socketPath} (does this seat load the spirectl bridge mod?)` };
  }
  const held = socketInodesOf(pid, { procRoot, fs });
  const mine = listeners.filter(row => held.has(row.inode));
  const other = listeners.filter(row => !held.has(row.inode));
  if (mine.length === 0) {
    return { ok: false, problem: `${socketPath} is listened on by inode(s) ${listeners.map(row => row.inode).join(", ")}, none of which pid ${pid} holds` };
  }
  if (other.length > 0) {
    return { ok: false, problem: `${socketPath} has ${other.length} other listener(s) besides pid ${pid}: the path is shared with a process this session does not own` };
  }
  return { ok: true, inode: mine[0].inode };
}

/**
 * Read-only preflight: what else on this machine already holds what this session is about to need. Nothing here
 * is ours yet, so every owner found is foreign.
 */
export function preflight({ procRoot = "/proc", fs = nodeFs, seats, lobbySeats = STOCK_LOBBY_SEATS, enetPort = DEFAULT_ENET_PORT, hostPort = DEFAULT_HOST_PORT }) {
  const table = readProcessTable({ procRoot, fs });
  const udp = [...parseProcNetInet(readProcNet(procRoot, fs, "udp")), ...parseProcNetInet(readProcNet(procRoot, fs, "udp6"))]
    .filter(row => row.localPort === enetPort);
  const tcpListen = [...parseProcNetInet(readProcNet(procRoot, fs, "tcp")), ...parseProcNetInet(readProcNet(procRoot, fs, "tcp6"))]
    .filter(row => row.state === "0A");
  const unixListen = parseProcNetUnix(readProcNet(procRoot, fs, "unix")).filter(row => row.listening);

  const slots = Array.from({ length: lobbySeats }, (_, index) => SEAT_MIN_SLOT + index);
  const seatRows = slots.map(slot => {
    const port = hostPort + slot * SEAT_PORT_STEP;
    const socket = seatBridgeSocketFor(slot);
    return { slot, port, socket, tcp: tcpListen.filter(row => row.localPort === port), unix: unixListen.filter(row => row.path === socket) };
  });
  const owners = socketOwners([...udp, ...seatRows.flatMap(row => [...row.tcp, ...row.unix])].map(row => row.inode), { procRoot, fs, table });
  const ownersOf = rows => rows.flatMap(row => owners.get(row.inode)?.length ? owners.get(row.inode) : [{ pid: null, comm: `unknown owner of inode ${row.inode}` }]);

  const seatSlots = seatRows.map(row => ({
    slot: row.slot,
    port: row.port,
    portOwners: ownersOf(row.tcp),
    bridgeSocket: row.socket,
    bridgeSocketOwners: ownersOf(row.unix)
  }));
  const availableSlots = seatSlots.filter(row => row.portOwners.length === 0).map(row => row.slot);
  const problems = [];
  if (udp.length > 0) {
    problems.push(`UDP ${enetPort} (ENet) is already bound by ${JSON.stringify(ownersOf(udp))}: a second ENet host either fails to bind or `
      + "steals that session's packets, and an orphaned bind blocks every seat join. Free it (or wait for its owner) first.");
  }
  if (seats > availableSlots.length) {
    const taken = seatSlots.filter(row => row.portOwners.length > 0).map(row => `slot ${row.slot} (port ${row.port}) by ${JSON.stringify(row.portOwners)}`);
    problems.push(`${seats} seats requested but a ${lobbySeats + 1}-player lobby allocates slots ${slots[0]}..${slots.at(-1)} and ${taken.join("; ")} `
      + `${taken.length === 1 ? "is" : "are"} already taken, so at most ${availableSlots.length} can join. Lower --seats or free the port(s).`);
  }
  for (const row of seatSlots) {
    if (row.bridgeSocketOwners.length > 0 && availableSlots.includes(row.slot)) {
      problems.push(`${row.bridgeSocket} is already held by ${JSON.stringify(row.bridgeSocketOwners)} although port ${row.port} is free: `
        + "a seat on that slot would share its bridge path with another session.");
    }
  }
  return { enet: { port: enetPort, owners: ownersOf(udp) }, seatSlots, availableSlots, problems };
}

/**
 * Proves the game's display connection belongs to OUR compositor: the game's environment names the private display
 * and carries no Wayland route, AND every socket listening on that display is held by the compositor (or one of its
 * children). Environment alone is not proof (qa-recipes §2.x); socket ownership is.
 *
 * gamescope creates the X listening sockets itself and hands them to its XWayland, which it starts DETACHED — the
 * XWayland process is re-parented away from gamescope (measured: its ppid is the session's subreaper). So "is the X
 * server a descendant" is the wrong question; "does our compositor hold the listening socket" is the right one. The
 * other holders of the same socket are returned as `xServers`: they are this session's X server, to be sampled and
 * torn down as owned.
 */
export function verifyDisplayOwnership({ display, compositorPid, gamePid, procRoot = "/proc", fs = nodeFs }) {
  const problems = [];
  const env = readEnviron(procRoot, gamePid, fs);
  if (!env) problems.push(`cannot read the environment of game pid ${gamePid}`);
  else {
    if (env.get("DISPLAY") !== display) problems.push(`game DISPLAY is ${JSON.stringify(env.get("DISPLAY") ?? null)}, expected ${display}`);
    if (env.has("WAYLAND_DISPLAY")) problems.push(`game inherited WAYLAND_DISPLAY=${env.get("WAYLAND_DISPLAY")} (a desktop route)`);
  }
  const number = /^:(\d+)(?:\.\d+)?$/.exec(display ?? "")?.[1];
  let xServerPids = [];
  let xServers = [];
  if (number === undefined) problems.push(`display ${JSON.stringify(display)} is not of the form :N`);
  else {
    const socketPath = `/tmp/.X11-unix/X${number}`;
    const listeners = parseProcNetUnix(readProcNet(procRoot, fs, "unix"))
      .filter(row => row.listening && (row.path === socketPath || row.path === `@${socketPath}`));
    const table = readProcessTable({ procRoot, fs });
    const owners = socketOwners(listeners.map(row => row.inode), { procRoot, fs, table });
    xServerPids = [...new Set([...owners.values()].flat().map(owner => owner.pid))];
    const ours = new Set([compositorPid, ...descendantsOf(table, compositorPid)]);
    if (listeners.length === 0) problems.push(`no X server is listening on ${socketPath}`);
    else {
      const foreign = listeners.filter(row => !(owners.get(row.inode) ?? []).some(owner => ours.has(owner.pid)));
      if (foreign.length > 0) {
        const holders = foreign.flatMap(row => owners.get(row.inode) ?? []).map(owner => owner.pid);
        problems.push(`a socket listening on ${socketPath} is held by pid(s) ${holders.join(", ") || "(none visible)"}, not by the compositor ${compositorPid} or its children`);
      }
      xServers = xServerPids.filter(pid => !ours.has(pid) && table.has(pid))
        .map(pid => ({ pid, startTicks: table.get(pid).startTicks, comm: table.get(pid).comm, role: "compositor-xserver" }));
    }
  }
  return { ok: problems.length === 0, problems, xServerPids, xServers };
}

// =================================================================================================
// teardown: signal only what we own, by pid AND start ticks
// =================================================================================================

async function waitUntil(predicate, timeoutMs, pollMs, sleep) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

/**
 * SIGTERM every still-identical process in `identities`, wait up to `graceMs`, SIGKILL survivors. Never a
 * pattern, never a pid whose start ticks moved (a reused pid is somebody else's process), never pid <= 1 or this
 * process.
 */
export async function terminateOwned(identities, { procRoot = "/proc", fs = nodeFs, kill = (pid, signal) => process.kill(pid, signal), sleep = sleepMs, graceMs = 10000, pollMs = 100 } = {}) {
  const alive = identity => isSameProcess(identity, { procRoot, fs });
  const report = [];
  const targets = [];
  for (const identity of identities) {
    const entry = { pid: identity.pid, startTicks: identity.startTicks, comm: identity.comm ?? null, role: identity.role ?? null };
    if (!Number.isInteger(identity.pid) || identity.pid <= 1 || identity.pid === process.pid || !Number.isFinite(identity.startTicks)) {
      report.push({ ...entry, action: "refused" });
      continue;
    }
    if (!alive(identity)) {
      report.push({ ...entry, action: "already-gone" });
      continue;
    }
    try { kill(identity.pid, "SIGTERM"); } catch { /* raced its exit */ }
    targets.push({ identity, entry });
  }
  await waitUntil(() => targets.every(({ identity }) => !alive(identity)), graceMs, pollMs, sleep);
  const stubborn = targets.filter(({ identity }) => alive(identity));
  for (const { identity } of stubborn) {
    try { kill(identity.pid, "SIGKILL"); } catch { /* raced its exit */ }
  }
  if (stubborn.length > 0) await waitUntil(() => stubborn.every(({ identity }) => !alive(identity)), 3000, pollMs, sleep);
  for (const { identity, entry } of targets) {
    const survived = alive(identity);
    report.push({ ...entry, action: survived ? "survived" : stubborn.some(item => item.identity === identity) ? "killed" : "terminated" });
  }
  return report;
}

/**
 * Terminates `root` and then every process that was descended from it at the moment of the call. Descendants are
 * snapshotted BEFORE the root is signalled: once it dies they are reparented and no longer look like ours.
 */
export async function terminateOwnedTree(root, options = {}) {
  if (!root) return [];
  const { procRoot = "/proc", fs = nodeFs } = options;
  const table = readProcessTable({ procRoot, fs });
  const rootRow = table.get(root.pid);
  const descendants = rootRow && rootRow.startTicks === root.startTicks
    ? [...descendantsOf(table, root.pid)].map(pid => ({ pid, startTicks: table.get(pid).startTicks, comm: table.get(pid).comm, role: `${root.role ?? "owned"}-child` }))
    : [];
  const first = await terminateOwned([root], options);
  const rest = await terminateOwned(descendants, options);
  return [...first, ...rest];
}

// =================================================================================================
// seats
// =================================================================================================

/**
 * Seat processes under the host: descendants of the host pid whose environment carries a couch seat slot and a
 * data dir inside this instance's user dir. Both conditions are identity, not guesswork: the operator's seats run
 * under the operator's user dir, and a seat's slot is in its environment by contract (architecture-map, seat
 * launch contract). When a launch wrapper did not `exec`, the wrapper and the game both match; the one with the
 * `--headless` argument is the game.
 */
export function discoverSeatProcesses({ hostPid, userDir, procRoot = "/proc", fs = nodeFs, table = null }) {
  const rows = table ?? readProcessTable({ procRoot, fs });
  const bySlot = new Map();
  for (const pid of descendantsOf(rows, hostPid)) {
    const env = readEnviron(procRoot, pid, fs);
    const slot = Number(env?.get("COUCHCOOP_HEADLESS_SLOT"));
    const dataHome = env?.get("XDG_DATA_HOME") ?? "";
    if (!Number.isInteger(slot) || slot < SEAT_MIN_SLOT || !dataHome.startsWith(`${userDir}/`)) continue;
    const argv = readCmdline(procRoot, pid, fs) ?? [];
    const candidate = { slot, pid, startTicks: rows.get(pid).startTicks, comm: rows.get(pid).comm, headless: argv.includes("--headless") };
    const prior = bySlot.get(slot);
    if (!prior || (candidate.headless && !prior.headless)) bySlot.set(slot, candidate);
  }
  return [...bySlot.values()].sort((a, b) => a.slot - b.slot)
    .map(({ headless, ...seat }) => ({ ...seat, netId: SEAT_BASE_NET_ID + seat.slot, playerId: `p:${SEAT_BASE_NET_ID + seat.slot}` }));
}

/**
 * The netId the host's console commands are issued as — every peer's echo line names it. Read from the player id
 * STRING first: a Steam-hosted run's netId is a 64-bit Steam id, which JSON.parse rounds when it arrives as a
 * number, and a rounded id would never match the echo.
 */
export function issuerNetIdFrom(hostPlayerId, runPlayers = []) {
  const fromId = /^p:(\d+)$/.exec(String(hostPlayerId ?? ""))?.[1];
  if (fromId) return fromId;
  const numeric = runPlayers.find(player => player?.isHost === true)?.netId;
  return numeric === undefined || numeric === null ? null : String(numeric);
}

// =================================================================================================
// build identity
// =================================================================================================

export function sha256File(file, fs = nodeFs) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Every `*.dll` (and each mod's build-info.txt) under `<gameRoot>/mods`, hashed. Depth-limited; no symlink loops. */
export function modAssemblies(gameRoot, fs = nodeFs, maxDepth = 3) {
  const root = path.join(gameRoot, "mods");
  const assemblies = [];
  const buildInfo = {};
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < maxDepth) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".dll")) {
        assemblies.push({ path: path.relative(gameRoot, full), bytes: fs.statSync(full).size, sha256: sha256File(full, fs) });
      } else if (entry.isFile() && entry.name === "build-info.txt") {
        buildInfo[path.relative(gameRoot, dir)] = fs.readFileSync(full, "utf8").slice(0, 4000);
      }
    }
  };
  walk(root, 0);
  assemblies.sort((a, b) => a.path.localeCompare(b.path));
  return { assemblies, buildInfo };
}

/** Assemblies whose hash differs between two `modAssemblies()` results — what a launch-time bridge repair looks like. */
export function assemblyChanges(before, after) {
  const index = new Map(before.assemblies.map(entry => [entry.path, entry.sha256]));
  const changes = [];
  for (const entry of after.assemblies) {
    if (!index.has(entry.path)) changes.push({ path: entry.path, change: "added" });
    else if (index.get(entry.path) !== entry.sha256) changes.push({ path: entry.path, change: "modified" });
    index.delete(entry.path);
  }
  for (const gone of index.keys()) changes.push({ path: gone, change: "removed" });
  return changes;
}

/** Unique `.dll` paths a live process has mapped, from `/proc/<pid>/maps`. */
export function mappedAssemblies(pid, { procRoot = "/proc", fs = nodeFs } = {}) {
  let text = "";
  try { text = fs.readFileSync(path.join(procRoot, String(pid), "maps"), "utf8"); } catch { return null; }
  const found = new Set();
  for (const line of text.split("\n")) {
    const file = line.trim().split(/\s+/).slice(5).join(" ");
    if (file.toLowerCase().endsWith(".dll")) found.add(file);
  }
  return [...found].sort();
}

/** Mapped mod assemblies (a `/mods/` path) that do NOT come from this game root's own mods dir. */
export function modAssembliesOutside(mapped, gameRoot, fs = nodeFs) {
  const modsReal = realpathOrNull(fs, path.join(gameRoot, "mods")) ?? path.join(gameRoot, "mods");
  return (mapped ?? []).filter(file => file.includes("/mods/") && !isInside(file, modsReal) && !isInside(file, path.join(gameRoot, "mods")));
}

/** Lines of `file` containing `needle`, capped. A missing file is `null`, never an empty list. */
export function grepFile(file, needle, { fs = nodeFs, limit = 200 } = {}) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  const hits = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length && hits.length < limit; index += 1) {
    if (lines[index].includes(needle)) hits.push({ line: index + 1, text: lines[index].slice(0, 400) });
  }
  return hits;
}

// =================================================================================================
// `sts2` invocation
// =================================================================================================

/**
 * Runs a command to completion, capturing output. `timeoutMs` kills only that child, and says so: the result
 * carries `timedOut` and the terminating `signal`, because a bare `code: null` reads like a failure of the command
 * itself when it was this function that stopped it.
 */
export function runProcess(command, args, { env = process.env, cwd, timeoutMs = 0, spawn = nodeSpawn } = {}) {
  return new Promise(resolve => {
    let stdout = "";
    let stderr = "";
    let timer = null;
    let timedOut = false;
    let child;
    try {
      child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, signal: null, timedOut, stdout, stderr: error.message, error });
      return;
    }
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGKILL"); } catch { /* gone */ }
      }, timeoutMs);
    }
    child.on("error", error => { clearTimeout(timer); resolve({ code: null, signal: null, timedOut, stdout, stderr: stderr || error.message, error }); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut, stdout, stderr }); });
  });
}

/**
 * The only door to `sts2`. Every call carries `--config <scratch>` and runs from ONE scratch cwd: the CLI derives
 * an instance's bridge socket from the nearest `.git` ancestor of its cwd, so a call from anywhere else would look
 * for the host's bridge somewhere else. Mode is always the CLI default (`normal`); nothing here needs more.
 *
 *   host(args)                -> `sts2 --config C [--instance I] --json <args>`  (the host's own bridge: through the
 *                                config's transport.ipcPath for a direct launch, through the instance for a CLI one)
 *   atSocket(socket, args)    -> `sts2 --config S --json <args>` with SPIRECTL_BRIDGE_SOCKET_PATH=socket (S has no
 *                                transport section, so the environment decides)
 */
export function createSts2({ bin = "sts2", configPath, seatConfigPath = configPath, instance = null, cwd, env = process.env, run = runProcess, prefix = [] }) {
  const baseEnv = { ...sts2BaseEnv(env), DOTNET_ROLL_FORWARD: "Major" };
  const finish = (argv, result) => {
    let value = null;
    try { value = result.stdout ? JSON.parse(result.stdout) : null; } catch { /* not JSON */ }
    return { ok: result.code === 0, code: result.code, value, stderr: (result.stderr || "").slice(0, 2000), argv };
  };
  return {
    bin,
    cwd,
    hostArgv: args => ["--config", configPath, ...(instance ? ["--instance", instance] : []), "--json", ...args],
    socketArgv: args => ["--config", seatConfigPath, "--json", ...args],
    async host(args, { timeoutMs = 120000, extraEnv = {}, command = null } = {}) {
      const argv = ["--config", configPath, ...(instance ? ["--instance", instance] : []), "--json", ...args];
      const [exe, ...pre] = command ?? [...prefix, bin];
      return finish(argv, await run(exe, [...pre, ...argv], { env: { ...baseEnv, ...extraEnv }, cwd, timeoutMs }));
    },
    async atSocket(socketPath, args, { timeoutMs = 60000 } = {}) {
      const argv = ["--config", seatConfigPath, "--json", ...args];
      return finish(argv, await run(bin, argv, { env: { ...baseEnv, SPIRECTL_BRIDGE_SOCKET_PATH: socketPath }, cwd, timeoutMs }));
    }
  };
}

// =================================================================================================
// the rig
// =================================================================================================

/**
 * Options (all resolved by the caller; see scripts/run-session-soak.mjs for flags and defaults):
 *   instance, gameRoot, assembliesDir, runDir, instancesDir, launchArgs, launchEnv, disableBackgroundThrottle,
 *   width, height, gamescopeArgs, requireGpu, seedDir, seedExclusive, lobbyFixture, seats, seatConcurrency,
 *   seatTimeoutMs, viewport, lanHost, gameCpus, viewerCpus, launchTimeoutMs, portTimeoutMs, bootSettleMs,
 *   lobbySettleMs, lobbyTimeoutMs, embarkTimeoutMs, launchMode
 *
 * LAUNCH MODES. `direct` (the default) spawns `<gameRoot>/SlayTheSpire2` itself, with private XDG dirs, its own bridge
 * socket and an environment scrubbed of inherited display routes and toolchain switches (see directLaunchEnv); the
 * profile comes only from `seedDir`. Nothing but the game touches the game root. `cli` goes through
 * `sts2 --instance <name> game launch`, which ALSO seeds the instance from the operator's profile, repairs the bridge
 * inside `<gameRoot>/mods` when its version differs from the CLI's, and matches already-running games by executable —
 * fine for a private install, wrong for a farm another session may be running from at the same time.
 *
 * Deps (injectable for the self-test): spawn, run, procRoot, fs, sleep, log, kill, runnerPid, sts2Bin,
 *   gamescopeBin, joinSeats, closeBrowsers, seatPages, verifyDisplay, portIsOpen, env, signal (an AbortSignal the
 *   bring-up polling loops honour; teardown never does), seatSocketFor (slot -> bridge socket path; the real one is
 *   fixed by the mod, the self-test points it at a temp dir so it never touches a live seat's path)
 */
export class SessionRig {
  constructor(options, deps = {}) {
    this.options = options;
    this.deps = {
      spawn: nodeSpawn, run: runProcess, procRoot: "/proc", fs: nodeFs, sleep: sleepMs, log: () => {},
      kill: (pid, signal) => process.kill(pid, signal), runnerPid: process.pid, sts2Bin: "sts2", gamescopeBin: "gamescope",
      joinSeats: joinBrowserSeats, closeBrowsers: closeSeatBrowsers, seatPages: openSeatPages,
      verifyDisplay: verifyDisplayOwnership, portIsOpen, env: process.env, seatSocketFor: seatBridgeSocketFor,
      ...deps
    };
    const { runDir, instancesDir, instance } = options;
    this.launchMode = options.launchMode ?? "direct";
    if (this.launchMode !== "direct" && this.launchMode !== "cli") throw new RigError("launch-mode", `unknown launch mode ${JSON.stringify(this.launchMode)}`, 2);
    this.configPath = path.join(runDir, `sts2.${instance}.yaml`);
    this.seatConfigPath = path.join(runDir, "sts2.seats.yaml");
    this.xdgRoot = path.join(instancesDir, instance);
    this.userDir = path.join(this.xdgRoot, "user");
    this.bridgeSocket = this.launchMode === "direct" ? hostBridgeSocketPath(runDir, instance) : null;
    this.compositorLog = path.join(runDir, "gamescope.log");
    this.sts2 = createSts2({
      bin: this.deps.sts2Bin, configPath: this.configPath, seatConfigPath: this.seatConfigPath,
      instance: this.launchMode === "cli" ? instance : null, cwd: runDir, env: this.deps.env, run: this.deps.run
    });
    this.compositor = null;
    this.host = null;
    this.hostPort = null;
    this.baseUrl = null;
    this.seats = [];
    this.seatProcesses = [];
    this.knownSeatIdentities = new Map();
    this.launch = null;
    this.events = [];
    this.#roleCache = new Map();
  }

  #roleCache;

  #checkAbort(during) {
    if (this.deps.signal?.aborted) throw new RigError("aborted", `stopped during ${during}`);
  }

  #note(message, extra = {}) {
    this.events.push({ at: new Date().toISOString(), message, ...extra });
    this.deps.log(message);
  }

  get procOptions() {
    return { procRoot: this.deps.procRoot, fs: this.deps.fs };
  }

  scratchConfigText({ forSeats = false } = {}) {
    const { gameRoot, assembliesDir, instancesDir, launchArgs, launchEnv, disableBackgroundThrottle } = this.options;
    return buildScratchConfig({
      gamePath: gameRoot, assembliesDir, instancesDir, launchArgs, launchEnv, disableBackgroundThrottle,
      ipcPath: forSeats ? null : this.bridgeSocket
    });
  }

  /** Private XDG base dirs for a direct launch: the game's user:// is `<XDG_DATA_HOME>/SlayTheSpire2`. */
  xdgDirs() {
    return {
      XDG_DATA_HOME: this.userDir,
      XDG_CONFIG_HOME: path.join(this.xdgRoot, "config"),
      XDG_CACHE_HOME: path.join(this.xdgRoot, "cache"),
      XDG_STATE_HOME: path.join(this.xdgRoot, "state")
    };
  }

  compositorArgv() {
    const { width, height, gamescopeArgs = [] } = this.options;
    return [
      "--backend", "headless", "-W", String(width), "-H", String(height), "-w", String(width), "-h", String(height),
      ...gamescopeArgs,
      "--", "sh", "-c", 'echo "GAMESCOPE_CHILD_DISPLAY=$DISPLAY"; exec sleep infinity'
    ];
  }

  launchCommand() {
    const { gameCpus, launchTimeoutMs, gameRoot, launchArgs = [] } = this.options;
    const argv = this.launchMode === "direct"
      ? [path.join(gameRoot, "SlayTheSpire2"), "--display-driver", "x11", ...launchArgs.map(String)]
      : [this.deps.sts2Bin, ...this.sts2.hostArgv(["game", "launch", "--timeout-ms", String(launchTimeoutMs)])];
    return gameCpus ? ["taskset", "-c", gameCpus, ...argv] : argv;
  }

  /** Everything a `--plan` prints: what would run, with which environment, from which cwd. Spawns nothing. */
  describe() {
    return {
      cwd: this.options.runDir,
      launchMode: this.launchMode,
      scratchConfig: { path: this.configPath, text: this.scratchConfigText() },
      seatConfig: { path: this.seatConfigPath },
      bridgeSocket: this.bridgeSocket,
      userDir: this.userDir,
      compositor: { argv: [this.deps.gamescopeBin, ...this.compositorArgv()], env: { unset: ["DISPLAY", "WAYLAND_DISPLAY"], set: { XDG_SESSION_TYPE: "x11" } }, detached: true, log: this.compositorLog },
      seed: {
        copyFrom: this.options.seedDir ?? null,
        exclusive: Boolean(this.options.seedExclusive),
        cliSeed: this.launchMode === "cli" ? [this.deps.sts2Bin, ...this.sts2.hostArgv(["game", "mods", "settings"])] : null,
        scrubbed: [path.join(this.userDir, BROWSER_PORT_RELATIVE), path.join(this.userDir, "SlayTheSpire2", "couch-coop", "headless-slots")]
      },
      launch: this.launchMode === "direct"
        ? {
          argv: this.launchCommand(), cwd: this.options.gameRoot, stdout: path.join(this.options.runDir, "host.stdout.log"),
          env: {
            unset: ["DISPLAY", "WAYLAND_DISPLAY", "GAMESCOPE_WAYLAND_DISPLAY", "COUCHCOOP_*", "SPIRECTL_*", "DOTNET_*", "VK_*"],
            set: { ...this.xdgDirs(), DISPLAY: "<compositor display>", XDG_SESSION_TYPE: "x11", SPIRECTL_BRIDGE_SOCKET_PATH: this.bridgeSocket, ...(this.options.disableBackgroundThrottle === false ? {} : { SPIRECTL_BRIDGE_DISABLE_BACKGROUND_THROTTLE: "1" }), ...this.options.launchEnv }
          }
        }
        : { argv: this.launchCommand(), env: { unset: ["WAYLAND_DISPLAY", "SPIRECTL_*"], set: { DISPLAY: "<compositor display>", XDG_SESSION_TYPE: "x11" } } },
      lobby: [this.deps.sts2Bin, ...this.sts2.hostArgv(["dev", "fixture", "load", "--path", this.options.lobbyFixture])],
      seats: { count: this.options.seats, viewport: this.options.viewport, baseUrl: `http://${this.options.lanHost ?? "<lan-host>"}:<published port>`, viewerCpus: this.options.viewerCpus ?? null },
      embark: {
        host: [this.deps.sts2Bin, ...this.sts2.hostArgv(["act", "ready", "--player-id", "<lobby.hostPlayerId>"])],
        seat: { env: { SPIRECTL_BRIDGE_SOCKET_PATH: seatBridgeSocketFor("<slot>") }, argv: [this.deps.sts2Bin, ...this.sts2.socketArgv(["act", "ready", "--player-id", "p:<1000+slot>"])], precondition: "socket held by that seat's pid and nothing else" }
      },
      devConsole: [this.deps.sts2Bin, ...this.sts2.hostArgv(["dev", "console", "<command>", "<args...>"])],
      teardown: "SIGTERM then SIGKILL by pid+start ticks: browsers, host tree (seats included), seats seen earlier, compositor tree"
    };
  }

  writeScratchConfig() {
    const { fs } = this.deps;
    fs.mkdirSync(this.options.runDir, { recursive: true });
    fs.writeFileSync(this.configPath, this.scratchConfigText());
    fs.writeFileSync(this.seatConfigPath, this.scratchConfigText({ forSeats: true }));
  }

  async startCompositor() {
    const { fs, spawn, sleep, env } = this.deps;
    fs.mkdirSync(this.options.runDir, { recursive: true });
    const fd = fs.openSync(this.compositorLog, "a");
    let spawnError = null;
    let child;
    try {
      child = spawn(this.deps.gamescopeBin, this.compositorArgv(), { env: compositorEnv(env), stdio: ["ignore", fd, fd], detached: true, cwd: this.options.runDir });
    } finally {
      fs.closeSync(fd);
    }
    child.on("error", error => { spawnError = error; });
    child.unref();
    const logText = () => { try { return fs.readFileSync(this.compositorLog, "utf8"); } catch { return ""; } };
    let display = null;
    const started = Date.now();
    while (Date.now() - started < 20000) {
      this.#checkAbort("the compositor start");
      if (spawnError) throw new RigError("compositor", `gamescope could not start: ${spawnError.message}`);
      display = /GAMESCOPE_CHILD_DISPLAY=(:\d+)/.exec(logText())?.[1] ?? null;
      if (display) break;
      if (child.exitCode !== null || child.signalCode !== null) throw new RigError("compositor", `gamescope exited before it produced a display:\n${logText().slice(-3000)}`);
      await sleep(100);
    }
    if (!display) throw new RigError("compositor", `gamescope produced no XWayland display within 20 s:\n${logText().slice(-3000)}`);
    const identity = readIdentity(child.pid, this.procOptions);
    if (!identity) throw new RigError("compositor", "gamescope exited before its process identity could be recorded");
    // The device line can trail the display line by a moment; give it a short window rather than guess.
    let vulkanDevice = null;
    for (let attempt = 0; attempt < 30 && !vulkanDevice; attempt += 1) {
      vulkanDevice = /selecting physical device '([^']+)'/.exec(logText())?.[1] ?? null;
      if (!vulkanDevice) await sleep(100);
    }
    this.compositor = { role: "compositor", pid: child.pid, startTicks: identity.startTicks, display, vulkanDevice, log: this.compositorLog, readyMs: Date.now() - started };
    this.#note(`compositor ready on DISPLAY=${display} (pid ${child.pid}, device ${vulkanDevice ?? "UNKNOWN"})`);
    if (this.options.requireGpu && !(vulkanDevice ?? "").includes(this.options.requireGpu)) {
      throw new RigError("compositor-gpu", `the compositor selected ${JSON.stringify(vulkanDevice)}, not a device matching ${JSON.stringify(this.options.requireGpu)}`);
    }
    return this.compositor;
  }

  /**
   * Seeds the instance user dir: the seed dir first (copy-if-missing, so its files win), then — for a CLI launch
   * only — the CLI's own seed without launching (see bring-up-five-player-instance.sh). Then scrubs live state.
   */
  async seedInstance() {
    const { fs } = this.deps;
    const { seedDir, seedExclusive } = this.options;
    if (this.launchMode === "direct" && !seedDir) {
      throw new RigError("seed", "a direct launch needs --seed-dir: nothing else gives the instance a profile", 2);
    }
    for (const dir of Object.values(this.xdgDirs())) fs.mkdirSync(dir, { recursive: true });
    if (seedDir) {
      if (!fs.existsSync(path.join(seedDir, "SlayTheSpire2"))) {
        throw new RigError("seed", `--seed-dir ${seedDir} has no SlayTheSpire2/ inside; it must mirror an XDG_DATA_HOME`, 2);
      }
      fs.cpSync(seedDir, this.userDir, { recursive: true, force: false, errorOnExist: false, verbatimSymlinks: true });
      if (seedExclusive && this.launchMode === "cli") fs.writeFileSync(path.join(this.userDir, CLI_SEED_SENTINEL), "");
    }
    let seeded = { code: null, value: null };
    if (this.launchMode === "cli") {
      seeded = await this.sts2.host(["game", "mods", "settings"], { timeoutMs: 600000 });
      fs.writeFileSync(path.join(this.options.runDir, "mods-settings-seed.json"), seeded.value ? `${JSON.stringify(seeded.value, null, 2)}\n` : "");
    }
    // The CLI seed copies two pieces of the operator's LIVE session: their port file (port + live pid) and their
    // seat dirs. Neither may be inherited; anything that appears afterwards was written by this instance.
    fs.rmSync(path.join(this.userDir, BROWSER_PORT_RELATIVE), { force: true });
    fs.rmSync(path.join(this.userDir, "SlayTheSpire2", "couch-coop", "headless-slots"), { recursive: true, force: true });
    const profiles = [];
    for (const group of ["steam", "default"]) {
      const dir = path.join(this.userDir, "SlayTheSpire2", group);
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const entry of entries) {
        if (fs.existsSync(path.join(dir, entry, "settings.save"))) profiles.push(path.join(dir, entry, "settings.save"));
      }
    }
    if (profiles.length === 0) {
      throw new RigError("seed", `no settings.save under ${this.userDir}/SlayTheSpire2/{steam,default}/* after seeding; the game would start with no mod list to read`);
    }
    this.seed = { cliSeedExit: seeded.code, settingsSaves: profiles, exclusive: Boolean(seedExclusive), copiedFrom: seedDir ?? null };
    return this.seed;
  }

  /** Launches the host into the compositor and waits for the port ITS process publishes (and, direct, its bridge). */
  async launchHost() {
    const { fs, sleep } = this.deps;
    const { gameRoot, portTimeoutMs, lanHost } = this.options;
    if (!this.compositor) throw new RigError("launch", "the compositor is not up");
    const modsBefore = modAssemblies(gameRoot, fs);
    const started = Date.now();
    const child = this.launchMode === "direct" ? this.#spawnDirect() : null;
    if (!child) await this.#launchThroughCli();
    this.#requireCompositor("the host launch");

    const deadline = Date.now() + portTimeoutMs;
    const graceUntil = Date.now() + 30000;
    let published = null;
    for (let poll = 1; ; poll += 1) {
      published = resolvePublishedPort({ userDir: this.userDir, ...this.procOptions });
      if (published) break;
      this.#checkAbort("the wait for the host's browser port");
      if (child && (child.spawnError || child.exitCode !== null || child.signalCode !== null)) {
        const tail = (() => { try { return fs.readFileSync(this.launch.stderrPath, "utf8").slice(-2000); } catch { return ""; } })();
        throw new RigError("launch", `the game exited before publishing a browser port (${child.spawnError?.message ?? `exit ${child.exitCode ?? child.signalCode}`}):\n${tail}`);
      }
      this.#requireCompositor("the wait for the host's browser port");
      if (poll % 10 === 0 && Date.now() >= graceUntil && anyProcessUnder(this.userDir, this.procOptions) === null) {
        throw new RigError("launch", `no process is running under ${this.userDir} any more: the game exited before publishing a browser port`);
      }
      if (Date.now() >= deadline) throw new RigError("launch", `no browser port published under ${this.userDir} within ${portTimeoutMs} ms`);
      await sleep(500);
    }
    const identity = readIdentity(published.pid, this.procOptions);
    if (!identity) throw new RigError("launch", `the process that published the port (${published.pid}) is gone`);
    this.host = { role: "host", pid: published.pid, startTicks: identity.startTicks, exe: identity.exe, readyMs: Date.now() - started };
    if (child && child.pid !== published.pid) this.#note(`WARNING: the port was published by pid ${published.pid}, not the spawned ${child.pid}`);
    this.hostPort = published.port;
    this.baseUrl = `http://${lanHost}:${published.port}`;

    const exeReal = identity.exe ? identity.exe.replace(/ \(deleted\)$/, "") : null;
    const rootReal = realpathOrNull(fs, gameRoot) ?? gameRoot;
    this.hostExeInsideGameRoot = Boolean(exeReal && isInside(exeReal, rootReal));
    if (!this.hostExeInsideGameRoot) this.#note(`WARNING: host executable ${exeReal} is not under the game root ${rootReal}`);

    const display = this.deps.verifyDisplay({ display: this.compositor.display, compositorPid: this.compositor.pid, gamePid: this.host.pid, ...this.procOptions });
    this.displayCheck = display;
    // The compositor's detached X server: owned by this session, though not in the compositor's process tree.
    this.xServers = display.xServers ?? [];
    if (!display.ok) throw new RigError("display", `the host's display is not provably the private compositor's: ${display.problems.join("; ")}`);

    if (!(await this.deps.portIsOpen(published.port, lanHost, 2000))) {
      throw new RigError("launch", `the host published port ${published.port} but nothing answers at ${lanHost}:${published.port}`);
    }
    if (this.launchMode === "direct") await this.#waitForBridge(started);
    this.modsChangedByLaunch = assemblyChanges(modsBefore, modAssemblies(gameRoot, fs));
    if (this.modsChangedByLaunch.length > 0) this.#note(`WARNING: the launch changed mod assemblies: ${JSON.stringify(this.modsChangedByLaunch)}`);
    this.#note(`host up: pid ${this.host.pid}, ${this.baseUrl} (${this.host.readyMs} ms)`);
    return this.host;
  }

  #spawnDirect() {
    const { fs, spawn, env } = this.deps;
    const [command, ...args] = this.launchCommand();
    const stdoutPath = path.join(this.options.runDir, "host.stdout.log");
    const stderrPath = path.join(this.options.runDir, "host.stderr.log");
    const out = fs.openSync(stdoutPath, "a");
    const err = fs.openSync(stderrPath, "a");
    const environment = directLaunchEnv(env, {
      display: this.compositor.display, xdg: this.xdgDirs(), bridgeSocket: this.bridgeSocket,
      disableBackgroundThrottle: this.options.disableBackgroundThrottle !== false, launchEnv: this.options.launchEnv ?? {}
    });
    let child;
    try {
      // Its own session, so a signal aimed at this harness's process group never reaches the game directly;
      // teardown stops it by pid + start ticks like everything else.
      child = spawn(command, args, { cwd: this.options.gameRoot, env: environment, stdio: ["ignore", out, err], detached: true });
    } finally {
      fs.closeSync(out);
      fs.closeSync(err);
    }
    child.on("error", error => { child.spawnError = error; });
    child.unref();
    this.launch = { mode: "direct", argv: [command, ...args], stdoutPath, stderrPath, spawnPid: child.pid, envKeys: Object.keys(environment).sort() };
    fs.writeFileSync(path.join(this.options.runDir, "launch.json"), `${JSON.stringify({ ...this.launch, env: Object.fromEntries(Object.entries(environment).filter(([key]) => /^(COUCHCOOP_|SPIRECTL_|DOTNET_|XDG_|DISPLAY$)/.test(key))) }, null, 2)}\n`);
    return child;
  }

  async #launchThroughCli() {
    const { fs, run, env } = this.deps;
    const [command, ...args] = this.launchCommand();
    const launchEnvironment = gameLaunchEnv(env, this.compositor.display);
    // The launch lands in the GAME's environment too; do not hand it a runtime roll-forward a player would not have.
    delete launchEnvironment.DOTNET_ROLL_FORWARD;
    const result = await run(command, args, { env: launchEnvironment, cwd: this.options.runDir, timeoutMs: this.options.launchTimeoutMs + 60000 });
    fs.writeFileSync(path.join(this.options.runDir, "launch.json"), result.stdout ?? "");
    fs.writeFileSync(path.join(this.options.runDir, "launch.err"), result.stderr ?? "");
    if (result.code !== 0) throw new RigError("launch", `game launch failed (exit ${result.code}):\n${String(result.stderr).slice(-3000)}`);
    let launch = null;
    try { launch = JSON.parse(result.stdout); } catch { /* recorded raw above */ }
    this.launch = {
      mode: "cli",
      stdoutPath: launch?.launch?.stdio?.stdoutPath ?? null,
      stderrPath: launch?.launch?.stdio?.stderrPath ?? null,
      spawnPid: launch?.launch?.pid ?? null
    };
  }

  /** A direct launch has nobody waiting on the bridge for us: poll a read-only state until it answers. */
  async #waitForBridge(started) {
    const deadline = started + this.options.launchTimeoutMs;
    for (;;) {
      const result = await this.sts2.host(["state"], { timeoutMs: 30000 });
      if (result.ok) {
        this.bridgeReadyMs = Date.now() - started;
        return;
      }
      this.#checkAbort("the wait for the host's bridge");
      this.#requireCompositor("the wait for the host's bridge");
      if (!isSameProcess(this.host, this.procOptions)) throw new RigError("launch", "the host exited before its bridge answered");
      if (Date.now() >= deadline) throw new RigError("bridge", `the host's bridge at ${this.bridgeSocket} did not answer within ${this.options.launchTimeoutMs} ms: ${result.stderr.slice(0, 400)}`);
      await this.deps.sleep(1000);
    }
  }

  #requireCompositor(during) {
    if (!isSameProcess(this.compositor, this.procOptions)) {
      throw new RigError("compositor-lost", `the compositor (pid ${this.compositor?.pid}) died during ${during}`);
    }
  }

  async #state() {
    const result = await this.sts2.host(["state"], { timeoutMs: 60000 });
    return result.ok ? result.value : null;
  }

  /** Loads the host-lobby fixture and proves the lobby HELD (a booting game pops a fixture lobby back to the menu). */
  async holdLobby() {
    const { sleep } = this.deps;
    await sleep(this.options.bootSettleMs);
    const attempts = [];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      this.#checkAbort("the host lobby");
      const load = await this.sts2.host(["dev", "fixture", "load", "--path", this.options.lobbyFixture], { timeoutMs: 120000 });
      attempts.push({ attempt, ok: load.ok, stderr: load.ok ? null : load.stderr.slice(0, 400) });
      if (load.ok) {
        await sleep(this.options.lobbySettleMs ?? 3000);
        const first = (await this.#state())?.characterSelect?.lobby ?? null;
        if (first?.netGameType === "host") {
          await sleep(this.options.lobbySettleMs ?? 3000);
          const second = (await this.#state())?.characterSelect?.lobby ?? null;
          if (second?.netGameType === "host") {
            this.lobby = { hostPlayerId: second.hostPlayerId ?? null, maxPlayers: second.maxPlayers ?? null, attempts };
            this.#note(`host lobby held (attempt ${attempt}, maxPlayers ${second.maxPlayers ?? "?"})`);
            return this.lobby;
          }
        }
      }
      await sleep(2000);
    }
    throw new RigError("lobby", `the host lobby never held: ${JSON.stringify(attempts)}`);
  }

  /** Joins the browser seats through scripts/probe-five-player-run.mjs `joinSeats()` — the live-proven path. */
  async joinSeats() {
    const { run, env } = this.deps;
    const { viewerCpus, seats, seatConcurrency, seatTimeoutMs, viewport } = this.options;
    if (viewerCpus) {
      // Chromium is launched from this process, so pinning this process pins every browser process it forks.
      const pinned = await run("taskset", ["-a", "-cp", viewerCpus, String(this.deps.runnerPid)], { env });
      if (pinned.code !== 0) throw new RigError("affinity", `could not pin the harness to CPUs ${viewerCpus}: ${pinned.stderr}`);
    }
    // A headless browser needs no display; make sure it has no desktop route to find either.
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;
    const outDir = path.join(this.options.runDir, "seats");
    this.deps.fs.mkdirSync(outDir, { recursive: true });
    const targets = {
      seats, seatConcurrency, seatTimeoutMs, outDir, viewport,
      baseUrl: this.baseUrl,
      browserPort: this.hostPort,
      portBases: [...new Set([this.hostPort, DEFAULT_HOST_PORT])],
      userDir: this.userDir
    };
    const evidence = { screenshots: [] };
    const joined = await this.deps.joinSeats(targets, evidence);
    this.seatJoinRecords = (joined ?? []).map(seat => seat && ({ name: seat.name, ok: seat.ok, slot: seat.slot, port: seat.port, playerId: seat.playerId, detail: seat.detail, ms: seat.ms, logPath: seat.logPath, screenshots: seat.screenshots }));
    const problems = checkSeatRecords(joined, seats);
    this.seats = (joined ?? []).filter(seat => seat?.ok);
    if (problems.length > 0) throw new RigError("seats", `${problems.length} of ${seats} seats have no proof they joined: ${problems.join(" | ")}`);
    await this.#refreshSeatProcesses(this.seats.map(seat => seat.slot));
    this.#note(`seats joined: ${this.seats.map(seat => `${seat.name}->slot ${seat.slot}/pid ${this.#seatProcess(seat.slot)?.pid ?? "?"}`).join(", ")}`);
    return this.seats;
  }

  async #refreshSeatProcesses(expectedSlots = [], timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.seatProcesses = discoverSeatProcesses({ hostPid: this.host.pid, userDir: this.userDir, ...this.procOptions });
      for (const seat of this.seatProcesses) this.knownSeatIdentities.set(`${seat.pid}:${seat.startTicks}`, { ...seat, role: `seat-${seat.slot}` });
      const found = new Set(this.seatProcesses.map(seat => seat.slot));
      if (expectedSlots.every(slot => found.has(slot))) return this.seatProcesses;
      this.#checkAbort("seat discovery");
      if (Date.now() >= deadline) {
        throw new RigError("seats", `seat process(es) for slot(s) ${expectedSlots.filter(slot => !found.has(slot)).join(", ")} not found under host pid ${this.host.pid}`);
      }
      await this.deps.sleep(500);
    }
  }

  #seatProcess(slot) {
    return this.seatProcesses.find(seat => seat.slot === slot) ?? null;
  }

  /**
   * Embarks: every player readies through its OWN bridge (`sts2 act ready`, approved for embarking a QA run and
   * for nothing else). A seat's bridge socket is used only once it is proved to be that seat's and no one else's.
   */
  async embark() {
    const { sleep } = this.deps;
    const expected = this.seats.length + 1;
    let lobby = null;
    const lobbyDeadline = Date.now() + this.options.lobbyTimeoutMs;
    for (;;) {
      lobby = (await this.#state())?.characterSelect?.lobby ?? null;
      if ((lobby?.players ?? []).length === expected) break;
      this.#checkAbort("the embark");
      if (Date.now() >= lobbyDeadline) {
        throw new RigError("embark", `the lobby shows ${(lobby?.players ?? []).length} player(s), expected ${expected} (host + ${this.seats.length} seats)`);
      }
      await sleep(1000);
    }
    const hostPlayerId = lobby.hostPlayerId;
    if (!hostPlayerId) throw new RigError("embark", "the lobby reports no hostPlayerId");
    const calls = [];
    const hostReady = await this.sts2.host(["act", "ready", "--player-id", hostPlayerId], { timeoutMs: 60000 });
    calls.push({ player: hostPlayerId, via: "host-bridge", ok: hostReady.ok, accepted: hostReady.value?.accepted ?? null, stderr: hostReady.ok ? null : hostReady.stderr.slice(0, 400) });
    if (hostReady.value?.accepted !== true) throw new RigError("embark", `ready for the host (${hostPlayerId}) was not accepted: ${JSON.stringify(calls.at(-1))}`);

    await this.#refreshSeatProcesses(this.seats.map(seat => seat.slot));
    for (const seat of [...this.seats].sort((a, b) => a.slot - b.slot)) {
      const proc = this.#seatProcess(seat.slot);
      const socket = this.deps.seatSocketFor(seat.slot);
      const owner = verifyUnixSocketOwner({ socketPath: socket, pid: proc.pid, ...this.procOptions });
      if (!owner.ok) throw new RigError("embark", `refusing to ready ${seat.playerId} through ${socket}: ${owner.problem}`);
      const ready = await this.sts2.atSocket(socket, ["act", "ready", "--player-id", seat.playerId]);
      calls.push({ player: seat.playerId, via: socket, seatPid: proc.pid, ok: ready.ok, accepted: ready.value?.accepted ?? null, stderr: ready.ok ? null : ready.stderr.slice(0, 400) });
      if (ready.value?.accepted !== true) throw new RigError("embark", `ready for ${seat.playerId} was not accepted through its own bridge: ${JSON.stringify(calls.at(-1))}`);
      await sleep(300);
    }

    const runDeadline = Date.now() + this.options.embarkTimeoutMs;
    for (;;) {
      const snapshot = await this.#state();
      if (snapshot?.run) {
        const runPlayers = snapshot.run.players ?? [];
        this.issuerNetId = issuerNetIdFrom(hostPlayerId, runPlayers);
        this.embarked = { hostPlayerId, hostNetId: this.issuerNetId, calls, runPlayers: runPlayers.map(player => player?.id ?? null), waitedMs: this.options.embarkTimeoutMs - (runDeadline - Date.now()) };
        this.#note(`embarked: run players ${this.embarked.runPlayers.join(", ")}`);
        return this.embarked;
      }
      this.#checkAbort("the embark");
      if (Date.now() >= runDeadline) throw new RigError("embark", `every player readied but no run began within ${this.options.embarkTimeoutMs} ms: ${JSON.stringify(calls)}`);
      await sleep(1000);
    }
  }

  /**
   * The sampler's view of what this session owns, re-resolved every tick from a fresh process table: host and its
   * tree (seats by slot), compositor and its tree, and this harness with every Chromium process it forked.
   */
  ownedTargets({ table }) {
    const targets = [];
    const seen = new Set();
    const add = (role, pid, startTicks) => {
      if (seen.has(pid)) return;
      seen.add(pid);
      targets.push({ role, pid, startTicks });
    };
    if (this.host) {
      add("host", this.host.pid, this.host.startTicks);
      const hostTree = descendantsOf(table, this.host.pid);
      const seats = new Map();
      for (const pid of hostTree) {
        const row = table.get(pid);
        const seat = this.#seatRoleFor(pid, row.startTicks);
        if (seat !== null) seats.set(pid, seat);
      }
      for (const [pid, slot] of seats) add(`seat-${slot}`, pid, table.get(pid).startTicks);
      for (const [seatPid, slot] of seats) {
        for (const pid of descendantsOf(table, seatPid)) add(`seat-${slot}-child`, pid, table.get(pid).startTicks);
      }
      for (const pid of hostTree) add("host-child", pid, table.get(pid).startTicks);
    }
    if (this.compositor) {
      add("compositor", this.compositor.pid, this.compositor.startTicks);
      for (const pid of descendantsOf(table, this.compositor.pid)) add("compositor-child", pid, table.get(pid).startTicks);
      for (const server of this.xServers ?? []) add("compositor-xserver", server.pid, server.startTicks);
    }
    const runner = table.get(this.deps.runnerPid);
    if (runner) {
      add("harness", runner.pid, runner.startTicks);
      for (const pid of descendantsOf(table, runner.pid)) {
        const row = table.get(pid);
        add(this.#chromiumRoleFor(pid, row.startTicks) ?? "harness-child", pid, row.startTicks);
      }
    }
    return targets;
  }

  #seatRoleFor(pid, startTicks) {
    const key = `seat:${pid}:${startTicks}`;
    if (!this.#roleCache.has(key)) {
      const env = readEnviron(this.deps.procRoot, pid, this.deps.fs);
      const slot = Number(env?.get("COUCHCOOP_HEADLESS_SLOT"));
      const inside = (env?.get("XDG_DATA_HOME") ?? "").startsWith(`${this.userDir}/`);
      const argv = readCmdline(this.deps.procRoot, pid, this.deps.fs) ?? [];
      this.#roleCache.set(key, Number.isInteger(slot) && inside && argv.includes("--headless") ? slot : null);
    }
    return this.#roleCache.get(key);
  }

  #chromiumRoleFor(pid, startTicks) {
    const key = `chromium:${pid}:${startTicks}`;
    if (!this.#roleCache.has(key)) this.#roleCache.set(key, classifyChromium(readCmdline(this.deps.procRoot, pid, this.deps.fs)));
    return this.#roleCache.get(key);
  }

  /** `{compositor, host}` liveness by identity. The runner stops the session when either is lost. */
  liveness() {
    return {
      compositor: this.compositor ? isSameProcess(this.compositor, this.procOptions) : null,
      host: this.host ? isSameProcess(this.host, this.procOptions) : null
    };
  }

  /** Build identity for the receipt. Call while the host and seats are alive: `/proc/<pid>/maps` dies with them. */
  buildIdentity() {
    const { fs } = this.deps;
    const { gameRoot } = this.options;
    const exe = path.join(gameRoot, "SlayTheSpire2");
    const mods = modAssemblies(gameRoot, fs);
    const processes = [
      ...(this.host ? [{ role: "host", pid: this.host.pid }] : []),
      ...this.seatProcesses.map(seat => ({ role: `seat-${seat.slot}`, pid: seat.pid }))
    ].map(entry => {
      const mapped = mappedAssemblies(entry.pid, this.procOptions);
      return { ...entry, mappedAssemblies: mapped, modAssembliesOutsideGameRoot: modAssembliesOutside(mapped, gameRoot, fs) };
    });
    return {
      gameRoot,
      gameRootReal: realpathOrNull(fs, gameRoot),
      executable: fs.existsSync(exe) ? { path: exe, sha256: sha256File(exe, fs) } : null,
      hostExeInsideGameRoot: this.hostExeInsideGameRoot ?? null,
      modAssemblies: mods.assemblies,
      buildInfo: mods.buildInfo,
      modsChangedByLaunch: this.modsChangedByLaunch ?? null,
      processes
    };
  }

  hostLogPath() {
    return path.join(this.userDir, "SlayTheSpire2", "logs", "godot.log");
  }

  /** Every peer's own godot.log: the host first, then each seat by slot. */
  peerLogFiles() {
    const slots = [...new Set([...this.seatProcesses.map(seat => seat.slot), ...this.seats.map(seat => seat.slot)])].sort((a, b) => a - b);
    return [
      { peer: "host", label: "host-godot", path: this.hostLogPath() },
      ...slots.map(slot => ({ peer: `seat-${slot}`, label: `seat-slot-${slot}-godot`, path: seatLogPathFor(this.userDir, slot) }))
    ];
  }

  /**
   * Copies the host and seat logs into the run dir and greps them: the `Loading assembly` lines (build identity)
   * plus every caller pattern (e.g. desync signatures). Call after teardown so the logs are complete.
   */
  collectLogs(patterns = []) {
    const { fs } = this.deps;
    const dir = path.join(this.options.runDir, "logs");
    fs.mkdirSync(dir, { recursive: true });
    const sources = [
      { label: "host-godot", path: this.hostLogPath() },
      { label: "host-stdout", path: this.launch?.stdoutPath ?? null },
      { label: "host-stderr", path: this.launch?.stderrPath ?? null },
      ...[...new Set([...this.seatProcesses.map(seat => seat.slot), ...this.seats.map(seat => seat.slot)])].sort((a, b) => a - b)
        .map(slot => ({ label: `seat-slot-${slot}-godot`, path: seatLogPathFor(this.userDir, slot) }))
    ].filter(source => source.path);
    const logs = sources.map(source => {
      let copiedTo = null;
      try {
        copiedTo = path.join(dir, `${source.label}.log`);
        fs.copyFileSync(source.path, copiedTo);
      } catch {
        copiedTo = null;
      }
      return {
        ...source,
        copiedTo,
        loadingAssembly: grepFile(source.path, "Loading assembly", { fs, limit: 50 }),
        patterns: Object.fromEntries(patterns.map(pattern => {
          const hits = grepFile(source.path, pattern, { fs, limit: 20 });
          return [pattern, hits === null ? null : { count: hits.length, first: hits.slice(0, 5) }];
        }))
      };
    });
    return logs;
  }

  /**
   * Read-only end-of-session state from the host and from every seat through ITS OWN (verified) bridge, saved to
   * final-state/, then compared: act, floor, and per player deck size, gold and HP must agree with the host. A
   * mismatch is a divergence even when no log line says so. A seat whose bridge cannot be proved its own is a
   * mismatch too ("no run" from that peer), never silently skipped.
   */
  async captureEndState() {
    const { fs } = this.deps;
    const dir = path.join(this.options.runDir, "final-state");
    fs.mkdirSync(dir, { recursive: true });
    const peers = [];
    const host = await this.sts2.host(["state"], { timeoutMs: 60000 });
    fs.writeFileSync(path.join(dir, "host.json"), host.value ? `${JSON.stringify(host.value, null, 2)}\n` : "");
    peers.push({ peer: "host", ok: host.ok, file: path.join(dir, "host.json"), summary: host.ok ? summarizeRunState(host.value) : null });
    for (const seat of this.seatProcesses) {
      const socket = this.deps.seatSocketFor(seat.slot);
      const owner = verifyUnixSocketOwner({ socketPath: socket, pid: seat.pid, ...this.procOptions });
      if (!owner.ok) {
        peers.push({ peer: `seat-${seat.slot}`, ok: false, skipped: owner.problem, summary: null });
        continue;
      }
      const state = await this.sts2.atSocket(socket, ["state"]);
      const file = path.join(dir, `seat-slot-${seat.slot}.json`);
      fs.writeFileSync(file, state.value ? `${JSON.stringify(state.value, null, 2)}\n` : "");
      peers.push({ peer: `seat-${seat.slot}`, ok: state.ok, file, summary: state.ok ? summarizeRunState(state.value) : null });
    }
    return { peers, compare: compareRunStates(peers.map(({ peer, summary }) => ({ peer, summary }))) };
  }

  /** Tears down everything this rig started, in dependency order, by pid + start ticks only. Never throws. */
  async teardown() {
    const report = { browsers: null, chromiumLeftovers: [], host: [], seats: [], compositor: [] };
    const opts = { procRoot: this.deps.procRoot, fs: this.deps.fs, kill: this.deps.kill, sleep: this.deps.sleep };
    try {
      await this.deps.closeBrowsers();
      report.browsers = "closed";
    } catch (error) {
      report.browsers = `close failed: ${error.message}`;
    }
    try {
      const table = readProcessTable(this.procOptions);
      const leftovers = [...descendantsOf(table, this.deps.runnerPid)]
        .filter(pid => classifyChromium(readCmdline(this.deps.procRoot, pid, this.deps.fs)) !== null)
        .map(pid => ({ pid, startTicks: table.get(pid).startTicks, comm: table.get(pid).comm, role: "chromium" }));
      report.chromiumLeftovers = await terminateOwned(leftovers, opts);
    } catch (error) {
      report.chromiumLeftovers = [{ error: error.message }];
    }
    try {
      report.host = await terminateOwnedTree(this.host, opts);
    } catch (error) {
      report.host = [{ error: error.message }];
    }
    try {
      report.seats = await terminateOwned([...this.knownSeatIdentities.values()], opts);
    } catch (error) {
      report.seats = [{ error: error.message }];
    }
    try {
      report.compositor = await terminateOwnedTree(this.compositor, opts);
      // Its detached X server normally exits with it; anything still standing is stopped by identity.
      report.compositor.push(...await terminateOwned(this.xServers ?? [], opts));
    } catch (error) {
      report.compositor = [{ error: error.message }];
    }
    if (this.bridgeSocket) {
      try { this.deps.fs.rmSync(this.bridgeSocket, { force: true }); } catch { /* not ours to worry about */ }
    }
    const survivors = [...report.chromiumLeftovers, ...report.host, ...report.seats, ...report.compositor].filter(entry => entry.action === "survived");
    report.clean = survivors.length === 0;
    return report;
  }
}

/** Where the primary checkout's and this checkout's local config say the live install is. Used by checkPlacement. */
export function configuredLiveGamePaths(fs = nodeFs) {
  return [...new Set([REPO_ROOT, PRIMARY_REPO_ROOT].map(root => readLocalGameConfig(path.join(root, "sts2.local.yaml"), fs).path).filter(Boolean))];
}

/** HEAD and dirtiness of this checkout, for the receipt. */
export function checkoutIdentity(root = REPO_ROOT) {
  const git = args => {
    try {
      return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  const status = git(["status", "--porcelain", "--untracked-files=no"]);
  return { root, head: git(["rev-parse", "HEAD"]), branch: git(["rev-parse", "--abbrev-ref", "HEAD"]), dirty: status === null ? null : status.length > 0 };
}
