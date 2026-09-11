#!/usr/bin/env node
/**
 * The SESSION half of the geoclip question.
 *
 * `bench-geoclip-knights.mjs` compares ONE cold produce per lane. That is not how the shipped geoclip path
 * behaves over a fight: a scene can request packed geometry and its raster recovery surface across several
 * animations, with retries and cache reuse changing the total cost.
 *
 * This bench measures that, and it measures it with the SHIPPED client: the real SPA served by the host, not
 * the bare-page probe. Per session it reports
 *
 *   hostBlockingMs   summed over EVERY run in /perf/spine.json, not metrics.*.split. A refused bake is
 *                    success:false and is excluded from `metrics` while having cost its full main-thread time,
 *                    so `metrics` systematically under-prices exactly the lane that refuses.
 *   bakes            by key, by kind, success and failure separately — the crux. A still and a geoclip per
 *                    (rig, anim), plus whatever the recovery path re-requests.
 *   transferBytes    PerformanceResourceTiming.encodedBodySize, because the geoclip lane loads its atlas pages
 *                    as IMAGES and a fetch wrapper prices it at its manifest alone (see ce09837).
 *   clientWaitMs     per spine node, the UNION of the intervals in which that node had an asset request in
 *                    flight — i.e. how long the creature was showing stale or fallback content. A union, not a
 *                    sum: two overlapping requests for one creature are one wait, not two.
 *
 * COMPARABILITY. The arms are driven by the same scripted action sequence against the same deterministic
 * session reset, and the harness proves rather than assumes they matched, three ways:
 *   * the reset is `dev fixture load <fixture>` FOLLOWED BY `dev console fight KNIGHTS_ELITE`. `fight` alone is
 *     not a reset — it restores the enemies but not the player's HP and not the run RNG, so sessions drift into
 *     each other and eventually into a corpse. The pair is verified byte-identical across repeats.
 *   * a state fingerprint is captured after every driven step and diffed across arms;
 *   * a passive wire watcher records every spineCurrentAnim transition the producer published,
 *     independently of which lane the browser is using. Two arms that saw different animations are not
 *     comparable and the report says so.
 *
 * ORDER. `--order` is applied verbatim; the default alternates so no arm sits in one position, the same
 * drift-cancelling the per-request gate's ABBA does.
 *
 * Usage (holding the live-QA lease for the instance and its port):
 *   node scripts/bench-geoclip-session.mjs \
 *     --origin http://127.0.0.1:13421 \
 *     --port-file /tmp/.../browser-port \
 *     --config /tmp/.../sts2.geoclip-knights.yaml --instance geoclip-knights --sts2-cwd /tmp/cc-s2a \
 *     --cache-root /tmp/cc-s2a/cache \
 *     --sessions 15 --order RGRRGR... --out .sts2/research/data/geoclip-session-bench-<stamp>
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { snapshotCache, diffSnapshots, removeEntries, assertPrivateCacheRoot } from "./lib/geoclip-bench-cache.mjs";
import { REPO_ROOT, SPIRECTL_ROOT } from "./lib/repo-layout.mjs";

const ROOT = REPO_ROOT;
const PLAYWRIGHT = join(ROOT, "frontend/node_modules/playwright/index.mjs");

// ---------------------------------------------------------------------------------------------- arms

/**
 * The two arms, as query strings on the shipped SPA.
 *
 * Arm R is the SHIPPED DEFAULT and therefore passes no spine query at all. Arm G preserves the old comparison
 * slot as the remaining dynamic-spine diagnostic control. Geoclip playback itself is now always armed; there is
 * no `geoclips` or `spineSource` URL selector.
 */
const ARMS = {
  G: { id: "G", label: "dynamic-spine diagnostic control", query: "spineMode=dynamic" },
  R: { id: "R", label: "shipped default", query: "" },
};

// ---------------------------------------------------------------------------------------------- args

function parseArgs(argv) {
  const o = {
    origin: null, portFile: null, config: null, instance: null, cacheRoot: null, out: null,
    sessions: 10, order: null, settleMs: 9000, stepMs: 4500, turnPollMs: 45000, quietMs: 4000,
    quietMaxMs: 45000, viewport: "1920x1080", keepBrowserOpen: false, dryRun: false,
    bridgeSocket: null, sts2Cwd: null, keepCache: false, clearScope: "spine",
    fixture: resolve(SPIRECTL_ROOT, "fixtures/basic-combat.sts2.fixture.yaml"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const value = () => inline ?? argv[++i];
    if (flag === "--origin") o.origin = value();
    else if (flag === "--port-file") o.portFile = value();
    else if (flag === "--config") o.config = value();
    else if (flag === "--instance") o.instance = value();
    else if (flag === "--cache-root") o.cacheRoot = value();
    else if (flag === "--out") o.out = value();
    else if (flag === "--sessions") o.sessions = Number(value());
    else if (flag === "--order") o.order = value();
    else if (flag === "--settle-ms") o.settleMs = Number(value());
    else if (flag === "--step-ms") o.stepMs = Number(value());
    else if (flag === "--quiet-ms") o.quietMs = Number(value());
    else if (flag === "--viewport") o.viewport = value();
    else if (flag === "--bridge-socket") o.bridgeSocket = value();
    else if (flag === "--sts2-cwd") o.sts2Cwd = value();
    else if (flag === "--fixture") o.fixture = value();
    else if (flag === "--keep-cache") o.keepCache = true;
    else if (flag === "--clear-scope") o.clearScope = value();
    else if (flag === "--dry-run") o.dryRun = true;
    else if (flag === "--help" || flag === "-h") { console.log(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(1, 45).join("\n")); process.exit(0); }
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  for (const required of ["origin", "portFile", "config", "instance", "cacheRoot", "out", "sts2Cwd"]) {
    if (!o[required]) throw new Error(`--${required.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())} is required`);
  }
  return o;
}

// ---------------------------------------------------------------------------------------------- plumbing

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, opts = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "", err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("error", (e) => resolveRun({ code: -1, out, err: String(e) }));
    child.on("close", (code) => resolveRun({ code, out, err }));
  });
}

/**
 * `sts2` against THIS instance only.
 *
 * An instance's bridge socket is `<cwd>/.sts2/ipc/<instance>.sock` — resolved from the WORKING DIRECTORY, and
 * `SPIRECTL_BRIDGE_SOCKET_PATH` does not override it once `--instance` is given (measured: it reports the
 * cwd-derived path back at you). From the wrong directory that resolution lands on the OPERATOR's own running
 * game, so `--sts2-cwd` is required and `assertBridge` proves before the first session that the socket this
 * resolves to belongs to the pid in `--port-file`.
 */
function sts2(o, args, { dangerous = false } = {}) {
  const base = ["--config", o.config, "--instance", o.instance];
  if (dangerous) base.push("--mode", "dangerous");
  return run("sts2", [...base, ...args], { cwd: o.sts2Cwd, env: { ...process.env, SPIRECTL_INSTANCE: o.instance } });
}

/** The socket `--sts2-cwd` resolves to must be the one the `--port-file` pid is listening on. */
async function assertBridge(o, record) {
  const socket = join(o.sts2Cwd, ".sts2", "ipc", `${o.instance}.sock`);
  if (!existsSync(socket)) throw new Error(`no bridge socket at ${socket}: --sts2-cwd ${o.sts2Cwd} is wrong for instance ${o.instance}`);
  const owner = await run("bash", ["-lc", `ls -l /proc/${record.pid}/fd 2>/dev/null | grep -c "socket" || true`]);
  const probe = await sts2(o, ["state", "--json"]);
  if (probe.code !== 0) throw new Error(`sts2 cannot reach instance ${o.instance} from ${o.sts2Cwd}: ${probe.err.slice(0, 300)}`);
  const state = JSON.parse(probe.out);
  const encounter = state.run?.currentRoom?.combat?.encounterId ?? null;
  return { socket, encounter, pid: record.pid, fdSockets: owner.out.trim() };
}

async function fetchJson(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

/** The instance record must name a LIVE pid and the port `--origin` addresses, before any request is made. */
function assertInstance(o) {
  const record = JSON.parse(readFileSync(o.portFile, "utf8"));
  const originPort = Number(new URL(o.origin).port);
  if (record.port !== originPort) throw new Error(`port-file says ${record.port}, --origin says ${originPort}`);
  if (!existsSync(`/proc/${record.pid}`)) throw new Error(`instance pid ${record.pid} is not alive`);
  return record;
}

// ---------------------------------------------------------------------------------------------- state

async function gameState(o) {
  const result = await sts2(o, ["state", "--json"]);
  if (result.code !== 0) throw new Error(`sts2 state failed: ${result.err.slice(0, 400)}`);
  return JSON.parse(result.out);
}

/**
 * The comparability fingerprint: everything about the combat that decides which animations play. Deliberately
 * NOT a whole-state hash — timers and tween phases differ between two runs of an identical script and would
 * make every pair look divergent.
 */
function fingerprint(state) {
  const run_ = state.run ?? {};
  const combat = run_.currentRoom?.combat ?? {};
  const cs = combat.combatState ?? {};
  const player = (run_.players ?? [])[0] ?? {};
  return {
    encounter: combat.encounterId ?? null,
    round: cs.roundNumber ?? null,
    side: cs.currentSide ?? null,
    enemies: (cs.enemies ?? []).map((e) => `${e.modelId}:${e.currentHp}/${e.maxHp}:b${e.block}:${e.nextMove?.id ?? "-"}`),
    playerHp: player.creature?.currentHp ?? null,
    playerBlock: player.creature?.block ?? null,
    energy: player.combat?.energy ?? null,
    hand: (player.combat?.hand?.cards ?? []).map((c) => `${c.modelId}#${c.id}`),
    discard: (player.combat?.discardPile?.cards ?? []).length,
    draw: (player.combat?.drawPile?.cards ?? []).length,
  };
}

const livingEnemies = (state) =>
  (state.run?.currentRoom?.combat?.combatState?.enemies ?? []).filter((e) => (e.currentHp ?? 0) > 0);

// ---------------------------------------------------------------------------------------------- the script

/**
 * The driven combat, as a pure function of state so both arms take the same decisions from the same fixture.
 *
 * Two full player rounds with three attacks each and two enemy turns in between, then two scripted deaths. The
 * deaths are `dev console kill <index>` rather than damage: a starter deck cannot cut 101 HP inside two rounds,
 * and a session with no death animation would not exercise the transition the whole hypothesis is about. Only
 * two of the three die, so the combat does not end and the room does not unmount mid-measurement.
 */
function buildScript() {
  const attackAt = (slot) => ({
    kind: "play-attack", slot,
    describe: `play first playable ATTACK at living enemy #${slot}`,
  });
  return [
    { kind: "settle", describe: "post-mount settle" },
    attackAt(0), attackAt(1), attackAt(2),
    { kind: "end-turn", describe: "end player turn 1; enemies act" },
    attackAt(0), attackAt(1), attackAt(2),
    { kind: "end-turn", describe: "end player turn 2; enemies act" },
    attackAt(0), attackAt(1),
    // `kill <i>` indexes the LIVING enemies 0-based and RE-INDEXES after each death (measured: `kill 0` twice
    // kills Flail then Spectral and leaves Magi alive, while `kill 1; kill 2` kills Spectral and then fails
    // out of range). Two of the three die, so the combat does not end and the room does not unmount mid-run.
    { kind: "console", line: ["kill", "0"], describe: "kill first living enemy (death animation)" },
    { kind: "console", line: ["kill", "0"], describe: "kill next living enemy (death animation)" },
    { kind: "settle", describe: "final settle" },
  ];
}

const ATTACK_MODELS = /STRIKE|BASH|CLEAVE|BODY_SLAM|IRON_WAVE|HEAVY_BLADE|TWIN_STRIKE|POMMEL/;

async function performStep(o, step, log) {
  if (step.kind === "settle") return { ok: true, detail: "settle" };
  if (step.kind === "console") {
    const result = await sts2(o, ["dev", "console", ...step.line], { dangerous: true });
    return { ok: result.code === 0, detail: `console ${step.line.join(" ")}`, code: result.code, err: result.err.slice(0, 300) };
  }
  if (step.kind === "end-turn") {
    const result = await sts2(o, ["act", "end-turn"]);
    if (result.code !== 0) return { ok: false, detail: "end-turn", err: result.err.slice(0, 300) };
    // Wait for the enemy turn to finish rather than for a fixed time: an enemy turn is where most of the
    // animation transitions live, and cutting it short would truncate the workload differently in each arm.
    const deadline = Date.now() + o.turnPollMs;
    let side = null, round = null;
    while (Date.now() < deadline) {
      await sleep(1200);
      const fp = fingerprint(await gameState(o));
      side = fp.side; round = fp.round;
      if (side === "Player" && (fp.energy ?? 0) > 0) break;
    }
    return { ok: side === "Player", detail: `end-turn -> side=${side} round=${round}` };
  }
  if (step.kind === "play-attack") {
    const state = await gameState(o);
    const living = livingEnemies(state);
    if (living.length === 0) return { ok: false, detail: "no living enemies" };
    const target = living[Math.min(step.slot, living.length - 1)];
    const player = state.run.players[0];
    const energy = player.combat?.energy ?? 0;
    const cards = player.combat?.hand?.cards ?? [];
    const card = cards.find((c) => ATTACK_MODELS.test(c.modelId) && c.energyCost <= energy && !c.unplayableReason)
      ?? cards.find((c) => c.energyCost <= energy && !c.unplayableReason);
    if (!card) return { ok: false, detail: `no playable card (energy ${energy})` };
    const args = ["act", "play-card", "--card", card.id];
    if (ATTACK_MODELS.test(card.modelId)) args.push("--target", target.id);
    const result = await sts2(o, args);
    log(`      played ${card.modelId}#${card.id} -> ${target.modelId} (${target.id})`);
    return { ok: result.code === 0, detail: `play ${card.modelId}#${card.id} -> ${target.id}`, played: card.modelId, target: target.modelId, err: result.err.slice(0, 300) };
  }
  throw new Error(`unknown step kind ${step.kind}`);
}

// ------------------------------------------------------------------------------------- wire watcher

/**
 * A PASSIVE extra mirror viewer that records every spineCurrentAnim transition the producer published.
 *
 * This is the arm-independent ground truth for "did both arms see the same animations". It never requests an
 * asset, so it cannot cause a bake; it costs the host one extra delta stream, identically in both arms.
 */
function startWireWatcher(origin) {
  const nodes = new Map();
  const transitions = [];
  const started = Date.now();
  const merge = (into, from) => {
    for (const [k, v] of Object.entries(from)) {
      if (v && typeof v === "object" && !Array.isArray(v) && into[k] && typeof into[k] === "object" && !Array.isArray(into[k])) merge(into[k], v);
      else into[k] = v;
    }
    return into;
  };
  const url = origin.replace(/^http/, "ws") + "/ws?watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0";
  const ws = new WebSocket(url);
  let frames = 0, fulls = 0, errored = null;
  ws.onerror = (e) => { errored = String(e?.message ?? e); };
  ws.onmessage = (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type !== "scene-delta") return;
    frames += 1;
    if (message.full) { fulls += 1; nodes.clear(); }
    for (const upsert of message.upserts ?? []) {
      const existing = nodes.get(upsert.id);
      const before = existing?.spineCurrentAnim ?? null;
      const merged = existing ? merge(existing, upsert) : { ...upsert };
      nodes.set(upsert.id, merged);
      if (!Object.keys(merged).some((k) => k.startsWith("spine"))) continue;
      const after = merged.spineCurrentAnim ?? null;
      if (after !== before) {
        transitions.push({ t: Date.now() - started, id: upsert.id, scene: sceneOf(nodes, merged), anim: after, from: before });
      }
    }
    for (const id of message.removedIds ?? []) nodes.delete(id);
  };
  return {
    stop() { try { ws.close(); } catch { /* already closed */ } return { frames, fulls, errored, transitions }; },
  };
}

function sceneOf(nodes, node) {
  let current = node;
  const guard = new Set();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    if (current.sceneFilePath) return String(current.sceneFilePath).split("/").at(-1);
    current = current.parentId ? nodes.get(current.parentId) : null;
  }
  return "";
}

// ------------------------------------------------------------------------------------- browser client

/**
 * Installed BEFORE the app loads, so no request escapes it. Two independent records are kept:
 *   fetch wrapping, which sees only what goes through `fetch`, and
 *   PerformanceResourceTiming, which sees images and therefore the geoclip lane's atlas pages too.
 * The bytes number comes from the second; keeping the first makes an under-count visible instead of silent.
 */
const PAGE_INIT = `
window.__ccSession = { reqs: [], fetches: [], errors: [], liveSamples: [] };
(function () {
  var interesting = function (s) { return s.indexOf('/spines/') >= 0 || s.indexOf('/geoclips/') >= 0; };
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var u = typeof input === 'string' ? input : (input && input.url) || '';
    var start = performance.now();
    if (interesting(String(u))) window.__ccSession.fetches.push({ url: String(u), start: start });
    return origFetch.apply(this, arguments);
  };
  try {
    var po = new PerformanceObserver(function (list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!interesting(String(e.name))) continue;
        window.__ccSession.reqs.push({
          url: String(e.name), startTime: e.startTime, responseEnd: e.responseEnd, duration: e.duration,
          encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize, transferSize: e.transferSize,
          initiatorType: e.initiatorType, responseStatus: e.responseStatus === undefined ? null : e.responseStatus
        });
      }
    });
    po.observe({ type: 'resource', buffered: true });
  } catch (e) { window.__ccSession.errors.push('PO: ' + e); }
  // Per-creature geoclip liveness. \`.mirror-geoclip-live\` is the class the renderer puts on a node that is
  // painting from GEOMETRY; its absence exposes a recovery-to-raster surface. Sampling it proves the dynamic
  // diagnostic control actually exercised the shipped geoclip path.
  setInterval(function () {
    try {
      var live = [];
      var els = document.querySelectorAll('.mirror-geoclip-live');
      for (var i = 0; i < els.length; i++) live.push(els[i].getAttribute('data-node-id') || els[i].className);
      var spineEls = document.querySelectorAll('.mirror-spine-canvas, .mirror-spine-img');
      window.__ccSession.liveSamples.push({ t: performance.now(), live: live, spineSurfaces: spineEls.length });
    } catch (e) {}
  }, 250);
})();
`;

async function launchClient(o, arm) {
  const { chromium } = await import(PLAYWRIGHT);
  const [width, height] = o.viewport.split("x").map(Number);
  const browser = await chromium.launch({
    headless: false,
    // ANGLE's Vulkan backend binds the Vulkan ICD rather than the display's GLX, so this reaches the real
    // adapter from the virtual display scripts/run-gpu.sh puts us on. `default` here is SwiftShader (ce09837).
    args: ["--use-gl=angle", "--use-angle=vulkan", "--disable-background-throttle", `--window-size=${width},${height}`],
  });
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript(PAGE_INIT);
  const page = await context.newPage();
  const console_ = [];
  page.on("console", (m) => console_.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => console_.push(`[pageerror] ${e.message}`));
  const url = `${o.origin}/${arm.query ? "?" + arm.query : ""}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  const gl = await page.evaluate(() => {
    try {
      const c = document.createElement("canvas"); const g = c.getContext("webgl2");
      const d = g.getExtension("WEBGL_debug_renderer_info");
      return g.getParameter(d.UNMASKED_RENDERER_WEBGL);
    } catch (e) { return `unavailable: ${e}`; }
  });
  return { browser, context, page, console_, url, gl };
}

/** Wait until no new /spines/ or /geoclips/ resource has appeared for `quietMs`. */
async function waitForQuiet(page, quietMs, maxMs) {
  const deadline = Date.now() + maxMs;
  let last = -1, lastChange = Date.now();
  while (Date.now() < deadline) {
    const n = await page.evaluate(() => window.__ccSession.reqs.length);
    if (n !== last) { last = n; lastChange = Date.now(); }
    else if (Date.now() - lastChange >= quietMs) return { quiet: true, count: n, waitedMs: maxMs - (deadline - Date.now()) };
    await sleep(500);
  }
  return { quiet: false, count: last, waitedMs: maxMs };
}

// ------------------------------------------------------------------------------------- metrics

/** Main-thread cost = the blocking phases only. Parked phases overlap each other and are not wall clock. */
function blockingMsOf(run_) {
  let total = 0;
  for (const phase of Object.values(run_.phases ?? {})) if (phase?.blocking === true) total += Number(phase.ms ?? 0);
  return total;
}

function summariseRuns(runs) {
  const byKey = new Map();
  let blocking = 0, bakeWall = 0, outputBytes = 0, failed = 0;
  for (const r of runs) {
    const b = blockingMsOf(r);
    blocking += b;
    bakeWall += Number(r.bakeMs ?? 0);
    outputBytes += Number(r.outputBytes ?? 0);
    if (r.success === false) failed += 1;
    const entry = byKey.get(r.key) ?? { key: r.key, kind: r.kind, count: 0, blockingMs: 0, bakeMs: 0, bytes: 0, successes: 0, failures: 0 };
    entry.count += 1; entry.blockingMs += b; entry.bakeMs += Number(r.bakeMs ?? 0);
    entry.bytes += Number(r.outputBytes ?? 0);
    if (r.success === false) entry.failures += 1; else entry.successes += 1;
    byKey.set(r.key, entry);
  }
  const kinds = {};
  for (const r of runs) kinds[r.kind ?? "?"] = (kinds[r.kind ?? "?"] ?? 0) + 1;
  // Split the host cost by lane and by cause. `retry=1` is the client's one-shot budget-collapse retry; a session
  // full of them is paying for a SECOND still of an identity it already has, which is a different finding from
  // "geoclip bakes are expensive" and must not be folded into it.
  const laneOf_ = (r) => (r.kind === "geoclip" ? "geoclip" : "raster");
  const lane = { geoclip: { bakes: 0, blockingMs: 0, failed: 0 }, raster: { bakes: 0, blockingMs: 0, failed: 0 } };
  let retryRetries = 0, retryBlockingMs = 0;
  for (const r of runs) {
    const l = lane[laneOf_(r)];
    l.bakes += 1; l.blockingMs += blockingMsOf(r);
    if (r.success === false) l.failed += 1;
    if (String(r.key ?? "").includes("&retry=1")) { retryRetries += 1; retryBlockingMs += blockingMsOf(r); }
  }
  for (const l of Object.values(lane)) l.blockingMs = round2(l.blockingMs);
  return {
    bakes: runs.length, failedBakes: failed, hostBlockingMs: round2(blocking), hostBakeWallMs: round2(bakeWall),
    hostOutputBytes: outputBytes, kinds, lane,
    retryRetries, retryBlockingMs: round2(retryBlockingMs),
    distinctKeys: byKey.size,
    byKey: [...byKey.values()].sort((a, b) => b.blockingMs - a.blockingMs)
      .map((e) => ({ ...e, blockingMs: round2(e.blockingMs), bakeMs: round2(e.bakeMs) })),
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

/** scene + node, from either lane's URL. This is the unit a viewer perceives: one creature. */
function creatureOf(url) {
  try {
    const u = new URL(url);
    const scene = u.pathname.replace(/^\/(spines|geoclips)\//, "").replace(/\.tscn$/, "");
    return `${scene}#${u.searchParams.get("node") ?? ""}`;
  } catch { return "?"; }
}

function animOf(url) { try { return new URL(url).searchParams.get("anim"); } catch { return null; } }
function laneOf(url) { return url.includes("/geoclips/") ? "geoclip" : url.includes("/spines/") ? "raster" : "other"; }

/**
 * Per creature, the union of the intervals in which it had an asset request in flight — the time it was showing
 * stale or fallback content while waiting. A union rather than a sum: a creature whose manifest and three atlas
 * pages are in flight together waited once, not four times.
 */
function clientWait(reqs) {
  const byCreature = new Map();
  for (const r of reqs) {
    const c = creatureOf(r.url);
    if (!byCreature.has(c)) byCreature.set(c, []);
    byCreature.get(c).push([r.startTime, r.responseEnd > r.startTime ? r.responseEnd : r.startTime + (r.duration ?? 0)]);
  }
  const per = [];
  let total = 0;
  for (const [creature, spans] of byCreature) {
    spans.sort((a, b) => a[0] - b[0]);
    let merged = 0, start = null, end = null;
    for (const [s, e] of spans) {
      if (start === null) { start = s; end = e; continue; }
      if (s <= end) { end = Math.max(end, e); continue; }
      merged += end - start; start = s; end = e;
    }
    if (start !== null) merged += end - start;
    per.push({ creature, requests: spans.length, unionWaitMs: round2(merged) });
    total += merged;
  }
  per.sort((a, b) => b.unionWaitMs - a.unionWaitMs);
  return { totalUnionWaitMs: round2(total), perCreature: per };
}

function summariseRequests(reqs) {
  let bytes = 0;
  const lanes = {};
  const byAnim = new Map();
  for (const r of reqs) {
    bytes += Number(r.encodedBodySize ?? 0);
    const lane = laneOf(r.url);
    lanes[lane] = (lanes[lane] ?? 0) + 1;
    const key = `${creatureOf(r.url)}|${animOf(r.url)}|${lane}`;
    const entry = byAnim.get(key) ?? { creature: creatureOf(r.url), anim: animOf(r.url), lane, requests: 0, bytes: 0 };
    entry.requests += 1; entry.bytes += Number(r.encodedBodySize ?? 0);
    byAnim.set(key, entry);
  }
  return {
    requests: reqs.length, transferBytes: bytes, lanes,
    distinctCreatureAnim: byAnim.size,
    byCreatureAnim: [...byAnim.values()].sort((a, b) => b.bytes - a.bytes),
    ...clientWait(reqs),
  };
}

// ------------------------------------------------------------------------------------- one session

async function runSession(o, arm, index, outDir, log) {
  const label = `s${String(index).padStart(2, "0")}-${arm.id}`;
  const sessionDir = join(outDir, "sessions", label);
  mkdirSync(sessionDir, { recursive: true });
  log(`\n=== session ${label} (${arm.label}) ===`);
  const record = assertInstance(o);

  // 1. Deterministic reset, BEFORE the browser exists, so the mount the browser then performs is the mount of a
  //    fresh round-1 encounter in every arm.
  //
  //    `fight KNIGHTS_ELITE` ALONE IS NOT A SESSION RESET, and using it as one is what made the first scouting
  //    pass meaningless. It restores the enemies and re-deals a hand, but it does not restore the player's HP
  //    and it does not rewind the run RNG: session 2 started at the HP session 1 ended on, the player died in
  //    round 1, and every subsequent step failed against a corpse. Reloading the fixture first restores both —
  //    measured: two fixture-load + fight cycles produce a byte-identical opening (same hand ids, same HP 67/80,
  //    same enemy HP and next moves).
  const fixture = await sts2(o, ["dev", "fixture", "load", o.fixture]);
  if (fixture.code !== 0) throw new Error(`fixture load failed: ${fixture.err.slice(0, 300)}`);
  await sleep(6000);
  const reset = await sts2(o, ["dev", "console", "fight", "KNIGHTS_ELITE"], { dangerous: true });
  if (reset.code !== 0) throw new Error(`fight reset failed: ${reset.err.slice(0, 300)}`);
  await sleep(5000);
  const openingState = await gameState(o);
  const opening = fingerprint(openingState);
  log(`   reset -> round ${opening.round} ${opening.side} hand=${opening.hand.join(",")} enemies=${opening.enemies.join(" ")}`);

  // 2. cold: snapshot the store, then drain the host's perf ring so the window starts at this session.
  const cacheBefore = await snapshotCache(o.cacheRoot);
  await fetchJson(`${o.origin}/perf/spine.json?reset=1`);

  // 3. the watcher, then the client.
  const watcher = startWireWatcher(o.origin);
  const client = await launchClient(o, arm);
  log(`   client ${client.url}`);
  log(`   webgl  ${client.gl}`);

  const steps = [];
  const script = buildScript();
  try {
    for (const step of script) {
      const t0 = Date.now();
      const outcome = step.kind === "settle" ? { ok: true, detail: "settle" } : await performStep(o, step, log);
      const dwell = step.kind === "settle" ? o.settleMs : o.stepMs;
      await sleep(dwell);
      const fp = fingerprint(await gameState(o));
      steps.push({ step: step.describe, kind: step.kind, ok: outcome.ok, detail: outcome.detail,
        played: outcome.played ?? null, target: outcome.target ?? null, wallMs: Date.now() - t0, after: fp });
      log(`   [${steps.length}/${script.length}] ${step.describe} -> ${outcome.ok ? "ok" : "FAILED " + (outcome.detail ?? "")} | r${fp.round} ${fp.side} hp${fp.playerHp} ${fp.enemies.join(" ")}`);
    }
    const quiet = await waitForQuiet(client.page, o.quietMs, o.quietMaxMs);
    log(`   quiet: ${quiet.quiet ? "yes" : "TIMED OUT"} after ${quiet.count} asset requests`);

    await client.page.screenshot({ path: join(sessionDir, "final.png") });
    const reqs = await client.page.evaluate(() => window.__ccSession.reqs);
    const fetches = await client.page.evaluate(() => window.__ccSession.fetches);
    // THE ANTI-VACUITY READ. A geoclip arm whose `geoclipMounts` is 0 never played a geoclip, whatever its
    // request log says; a run with mounts but non-zero `geoclipDeadlineFires` hit the 20 s backstop and
    // released the deferred raster, which is a fallback wearing the geoclip lane's clothes.
    const walkStats = await client.page.evaluate(() => {
      try {
        const s = window.__mirrorWalkStats;
        if (!s) return null;
        return JSON.parse(JSON.stringify(typeof s.snapshot === "function" ? s.snapshot() : s));
      } catch (e) { return { error: String(e) }; }
    });
    const liveSamples = await client.page.evaluate(() => window.__ccSession.liveSamples);
    writeFileSync(join(sessionDir, "console.log"), client.console_.join("\n"));
    writeFileSync(join(sessionDir, "requests.json"), JSON.stringify(reqs, null, 1));
    writeFileSync(join(sessionDir, "geoclip-live-samples.json"), JSON.stringify(liveSamples, null, 1));

    // 4. host side, read AFTER the client is quiet but BEFORE it is closed, so nothing in flight is lost.
    const perf = await fetchJson(`${o.origin}/perf/spine.json`, 60000);
    writeFileSync(join(sessionDir, "perf-spine.json"), JSON.stringify(perf, null, 1));

    const wire = watcher.stop();
    await client.browser.close();

    // 5. restore the store to exactly its pre-session state, and prove it.
    const cacheAfter = await snapshotCache(o.cacheRoot);
    const diff = diffSnapshots(cacheBefore, cacheAfter);
    // `--keep-cache` deliberately does NOT restore the store: it is how the WARM-SESSION leg is measured, where
    // session 2 of the same encounter finds every key session 1 baked. Both are real scenarios and they answer
    // different questions, so the report must never mix them.
    //
    // `--clear-scope spine` (the default) restores only the SPINE lane: the geoclip store, and the asset store's
    // `spine` scheme. The asset store's other scheme, `res`, is where backgrounds and general art land, and
    // re-baking those every session would add a large constant to both arms' wall clock and make every spine
    // request queue behind a background encode. They are not part of either lane, so they stay warm; the run is
    // primed once beforehand so no session is the one that pays for them. `--clear-scope all` restores
    // everything, which is the honest setting for a cold-launch question this bench is not asking.
    const inScope = (entry) => o.clearScope === "all"
      || entry.store?.startsWith("couchcoop-geoclip-cache")
      || (entry.kind === "assetBlob" && entry.scheme === "spine");
    const toClear = diff.created.filter(inScope);
    const cleared = o.keepCache ? { removed: [], failed: [], skipped: "keep-cache" } : await removeEntries(toClear);

    const host = summariseRuns(perf.runs ?? []);
    const client_ = summariseRequests(reqs);
    const transitions = wire.transitions.filter((t) => t.anim);
    const session = {
      label, arm: arm.id, armLabel: arm.label, query: arm.query, index,
      instance: { pid: record.pid, port: record.port },
      opening, steps,
      host: { ...host, perfParams: perf.params ?? null, perfMetrics: perf.metrics ?? null },
      client: {
        ...client_, fetchOnlyRequests: fetches.length, webglRenderer: client.gl, quiet,
        walkStats, geoclipLive: summariseGeoclipLive(liveSamples),
        geoclipConsole: client.console_.filter((l) => /geoclip/i.test(l)),
      },
      wire: {
        frames: wire.frames, fullFrames: wire.fulls, error: wire.errored,
        transitionCount: transitions.length,
        sequence: transitions.map((t) => `${t.scene}:${t.anim}`),
        distinct: [...new Set(transitions.map((t) => `${t.scene}:${t.anim}`))].sort(),
        detail: transitions,
      },
      cache: {
        created: diff.created.length, modified: diff.modified.length, removed: diff.removed.length,
        clearedOk: cleared.failed.length === 0, clearFailures: cleared.failed, kept: o.keepCache,
        clearScope: o.clearScope, inScopeCreated: toClear.length, outOfScopeCreated: diff.created.length - toClear.length,
        createdByStore: countBy(diff.created, (e) => e.store),
        createdByKind: countBy(diff.created, (e) => e.kind),
      },
      producerProof: {
        perfRows: (perf.runs ?? []).length,
        cacheWrites: diff.created.length + diff.modified.length,
        refusalReceipts: diff.created.filter((e) => e.kind === "refusal").length,
        verdict: (perf.runs ?? []).length > 0 || diff.created.length > 0 ? "entered-producer" : "NO-PROOF",
      },
    };
    writeFileSync(join(sessionDir, "session.json"), JSON.stringify(session, null, 1));
    log(`   host: ${host.bakes} bakes (${host.distinctKeys} distinct keys, ${host.failedBakes} failed), blocking ${host.hostBlockingMs} ms`);
    log(`   client: ${client_.requests} requests, ${(client_.transferBytes / 1024).toFixed(1)} KiB, union wait ${client_.totalUnionWaitMs} ms`);
    log(`   wire: ${transitions.length} anim transitions, ${session.wire.distinct.length} distinct`);
    log(`   cache: cleared ${cleared.removed.length}/${toClear.length} in-scope (${diff.created.length - toClear.length} out-of-scope kept, ${cleared.failed.length} failures)`);
    return session;
  } catch (error) {
    try { watcher.stop(); } catch { /* ignore */ }
    try { await client.browser.close(); } catch { /* ignore */ }
    throw error;
  }
}

/** How much of the session each node spent painting from geometry, from the 250 ms `.mirror-geoclip-live` poll. */
function summariseGeoclipLive(samples) {
  const perNode = new Map();
  let anyLiveSamples = 0;
  for (const sample of samples) {
    if ((sample.live ?? []).length > 0) anyLiveSamples += 1;
    for (const id of sample.live ?? []) perNode.set(id, (perNode.get(id) ?? 0) + 1);
  }
  return {
    samples: samples.length,
    samplesWithAnyLiveGeoclip: anyLiveSamples,
    sharePeriodsWithLiveGeoclip: samples.length ? round2(anyLiveSamples / samples.length) : null,
    peakConcurrentLive: samples.reduce((m, s) => Math.max(m, (s.live ?? []).length), 0),
    perNode: [...perNode.entries()].map(([id, n]) => ({ node: id, samples: n })).sort((a, b) => b.samples - a.samples),
  };
}

function countBy(list, keyOf) {
  const out = {};
  for (const item of list) { const k = keyOf(item) ?? "?"; out[k] = (out[k] ?? 0) + 1; }
  return out;
}

// ------------------------------------------------------------------------------------- statistics

/** Exact two-sided paired sign test, ties dropped, matching the per-request gate's construction. */
function signTest(deltas) {
  const nonZero = deltas.filter((d) => d !== 0);
  const n = nonZero.length;
  const positives = nonZero.filter((d) => d > 0).length;
  const negatives = n - positives;
  if (n === 0) return { n: 0, positives: 0, negatives: 0, p: 1 };
  const choose = (a, b) => { let r = 1; for (let i = 0; i < b; i += 1) r = (r * (a - i)) / (i + 1); return r; };
  const k = Math.min(positives, negatives);
  let tail = 0;
  for (let i = 0; i <= k; i += 1) tail += choose(n, i);
  const p = Math.min(1, 2 * tail / Math.pow(2, n));
  return { n, positives, negatives, p };
}

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function compare(name, gValues, rValues, lowerIsBetter = true) {
  const pairs = Math.min(gValues.length, rValues.length);
  const deltas = [];
  for (let i = 0; i < pairs; i += 1) deltas.push(gValues[i] - rValues[i]);
  const test = signTest(deltas);
  const med = median(deltas);
  const winner = med === null ? "none" : med === 0 ? "tie" : (med < 0) === lowerIsBetter ? "geoclip" : "raster";
  return {
    metric: name, pairs, geoclipMedian: median(gValues), rasterMedian: median(rValues),
    geoclipValues: gValues, rasterValues: rValues, medianPairedDelta: med, deltas,
    signTest: test, better: winner,
  };
}

/**
 * Everything that would make a number here meaningless, named rather than assumed away.
 *
 * `geoclip-arm-never-mounted` is the important one: a G session whose `geoclipMounts` is 0 measured the raster
 * lane under a geoclip label, and its cheap-looking numbers would be the raster lane's numbers.
 */
function blockersFor(sessions) {
  const blockers = [];
  for (const s of sessions) {
    if (s.arm === "G" && (s.client.walkStats?.geoclipMounts ?? 0) === 0) {
      blockers.push({ code: "geoclip-arm-never-mounted", session: s.label, detail: "geoclipMounts=0: this G session never painted a geoclip" });
    }
    if (s.arm === "G" && (s.client.walkStats?.geoclipDeadlineFires ?? 0) > 0) {
      blockers.push({ code: "geoclip-defer-deadline-fired", session: s.label, detail: `geoclipDeadlineFires=${s.client.walkStats.geoclipDeadlineFires}: a deferred raster was released by the backstop` });
    }
    if (s.producerProof.verdict !== "entered-producer") {
      blockers.push({ code: "no-producer-proof", session: s.label, detail: "no perf row and no cache write: nothing proves a request reached the producer" });
    }
    if (!s.cache.clearedOk) blockers.push({ code: "cache-clear-failed", session: s.label, detail: JSON.stringify(s.cache.clearFailures).slice(0, 300) });
    if (!s.client.quiet.quiet) blockers.push({ code: "session-not-quiet", session: s.label, detail: "asset requests were still arriving when the session was cut" });
    if (s.wire.error) blockers.push({ code: "wire-watcher-error", session: s.label, detail: s.wire.error });
    if (/SwiftShader|llvmpipe|softpipe|swrast|lavapipe/i.test(String(s.client.webglRenderer))) {
      blockers.push({ code: "browser-software-gl", session: s.label, detail: String(s.client.webglRenderer) });
    }
    if (s.steps.some((step) => !step.ok)) {
      blockers.push({ code: "driven-step-failed", session: s.label, detail: s.steps.filter((x) => !x.ok).map((x) => x.step).join("; ") });
    }
    // A dead player stops the script dead and turns every later step into a no-op against a corpse — the exact
    // way the first scouting pass produced an 8-bake "session" that was really three quarters of one turn.
    if (s.steps.some((step) => (step.after?.playerHp ?? 1) <= 0)) {
      blockers.push({ code: "player-died", session: s.label, detail: "the driven Ironclad reached 0 HP: the session after that point is not a combat" });
    }
  }
  return blockers;
}

// ------------------------------------------------------------------------------------- main

async function main() {
  const o = parseArgs(process.argv.slice(2));
  assertPrivateCacheRoot(o.cacheRoot);
  const outDir = resolve(o.out);
  mkdirSync(outDir, { recursive: true });
  const lines = [];
  const log = (m) => { console.log(m); lines.push(m); };

  const order = (o.order ?? Array.from({ length: Math.ceil(o.sessions / 4) }, () => "GRRG").join("")).slice(0, o.sessions).split("");
  log(`order: ${order.join("")}  (${order.filter((a) => a === "G").length} G / ${order.filter((a) => a === "R").length} R)`);
  const bridge = await assertBridge(o, assertInstance(o));
  log(`bridge: ${bridge.socket} -> pid ${bridge.pid}, encounter ${bridge.encounter}`);
  if (o.dryRun) { log("dry run: stopping before the first session"); return; }

  const sessions = [];
  for (let i = 0; i < order.length; i += 1) {
    const arm = ARMS[order[i]];
    if (!arm) throw new Error(`unknown arm ${order[i]}`);
    const session = await runSession(o, arm, i + 1, outDir, log);
    sessions.push(session);
    writeFileSync(join(outDir, "sessions.json"), JSON.stringify(sessions, null, 1));
  }

  const METRICS = [
    ["hostBlockingMs", (s) => s.host.hostBlockingMs],
    ["bakes", (s) => s.host.bakes],
    ["distinctBakeKeys", (s) => s.host.distinctKeys],
    ["failedBakes", (s) => s.host.failedBakes],
    ["geoclipBakes", (s) => s.host.lane.geoclip.bakes],
    ["rasterBakes", (s) => s.host.lane.raster.bakes],
    ["retryBakes", (s) => s.host.retryRetries],
    ["hostBakeWallMs", (s) => s.host.hostBakeWallMs],
    ["transferBytes", (s) => s.client.transferBytes],
    ["clientUnionWaitMs", (s) => s.client.totalUnionWaitMs],
    ["assetRequests", (s) => s.client.requests],
  ];
  const byArm = Object.fromEntries(Object.keys(ARMS).map((id) => [id, sessions.filter((s) => s.arm === id)]));
  // Every arm is compared against R, the shipped baseline, and only against R: an arm-vs-arm table where
  // neither side is what ships answers a question nobody asked.
  const comparisons = [];
  for (const armId of Object.keys(ARMS)) {
    if (armId === "R" || byArm[armId].length === 0 || byArm.R.length === 0) continue;
    for (const [name, pick] of METRICS) {
      comparisons.push({ arm: armId, ...compare(name, byArm[armId].map(pick), byArm.R.map(pick)) });
    }
  }

  const distinctByArm = Object.fromEntries(Object.entries(byArm)
    .filter(([, list]) => list.length > 0)
    .map(([id, list]) => [id, [...new Set(list.flatMap((s) => s.wire.distinct))].sort()]));
  const sequenceCountByArm = Object.fromEntries(Object.entries(byArm)
    .filter(([, list]) => list.length > 0)
    .map(([id, list]) => [id, new Set(list.map((s) => s.wire.sequence.join("|"))).size]));
  const referenceAnims = distinctByArm.R ?? [];
  const comparability = {
    identicalOpeningFingerprint: new Set(sessions.map((s) => JSON.stringify(s.opening))).size === 1,
    identicalStepDetails: new Set(sessions.map((s) => JSON.stringify(s.steps.map((x) => x.detail)))).size === 1,
    distinctAnimsByArm: distinctByArm,
    animSetsEqualToR: Object.fromEntries(Object.entries(distinctByArm).map(([id, list]) => [id, list.join(",") === referenceAnims.join(",")])),
    animsMissingVsR: Object.fromEntries(Object.entries(distinctByArm).map(([id, list]) => [id, referenceAnims.filter((a) => !list.includes(a))])),
    animsExtraVsR: Object.fromEntries(Object.entries(distinctByArm).map(([id, list]) => [id, list.filter((a) => !referenceAnims.includes(a))])),
    distinctSequencesWithinArm: sequenceCountByArm,
  };

  const report = {
    schema: "geoclip-session-bench/1",
    capturedAt: new Date().toISOString(),
    origin: o.origin, instance: o.instance, cacheRoot: o.cacheRoot,
    order: order.join(""), sessions: sessions.length,
    arms: ARMS, script: buildScript().map((s) => s.describe),
    dwell: { settleMs: o.settleMs, stepMs: o.stepMs, quietMs: o.quietMs },
    comparability, comparisons,
    perSession: sessions.map((s) => ({
      label: s.label, arm: s.arm, bakes: s.host.bakes, distinctKeys: s.host.distinctKeys,
      failedBakes: s.host.failedBakes, hostBlockingMs: s.host.hostBlockingMs, hostBakeWallMs: s.host.hostBakeWallMs,
      lane: s.host.lane, retryRetries: s.host.retryRetries,
      requests: s.client.requests, transferBytes: s.client.transferBytes,
      clientUnionWaitMs: s.client.totalUnionWaitMs, animTransitions: s.wire.transitionCount,
      geoclipMounts: s.client.walkStats?.geoclipMounts ?? null,
      geoclipDeadlineFires: s.client.walkStats?.geoclipDeadlineFires ?? null,
      liveGeoclipShare: s.client.geoclipLive?.sharePeriodsWithLiveGeoclip ?? null,
      cacheCleared: s.cache.clearedOk, producerProof: s.producerProof.verdict,
    })),
    blockers: blockersFor(sessions),
  };
  writeFileSync(join(outDir, "session-bench.json"), JSON.stringify(report, null, 1));

  for (const armId of [...new Set(comparisons.map((c) => c.arm))]) {
    log(`\n============ ${armId} (${ARMS[armId].label}) vs R (${ARMS.R.label}) — paired, Δ = ${armId} − R ============`);
    for (const c of comparisons.filter((x) => x.arm === armId)) {
      log(`${c.metric.padEnd(20)} ${armId} ${String(c.geoclipMedian).padStart(12)}  R ${String(c.rasterMedian).padStart(12)}  Δ ${String(round2(c.medianPairedDelta ?? 0)).padStart(12)}  wins ${armId}/R ${c.signTest.negatives}/${c.signTest.positives}  p=${c.signTest.p.toExponential(2)}  -> ${c.better === "geoclip" ? armId : c.better === "raster" ? "R" : c.better}`);
    }
  }
  log("\nper session:");
  for (const s of report.perSession) {
    log(`  ${s.label.padEnd(8)} bakes ${String(s.bakes).padStart(3)} (geo ${String(s.lane.geoclip.bakes).padStart(2)}/f${s.lane.geoclip.failed} ras ${String(s.lane.raster.bakes).padStart(2)} retry ${String(s.retryRetries).padStart(2)})  blocking ${String(s.hostBlockingMs).padStart(9)} ms  bytes ${String(s.transferBytes).padStart(9)}  wait ${String(s.clientUnionWaitMs).padStart(9)} ms  mounts ${s.geoclipMounts}  anims ${s.animTransitions}`);
  }
  log("\ncomparability: " + JSON.stringify(comparability, null, 1));
  log("\nblockers: " + (report.blockers.length === 0 ? "none" : JSON.stringify(report.blockers, null, 1)));
  writeFileSync(join(outDir, "console.log"), lines.join("\n"));
}

main().catch((error) => { console.error(error); process.exit(1); });
