#!/usr/bin/env node
// =====================================================================================================
// LIVE CLOSED-LOOP VALIDATION FOR THE MIRROR'S HAND TOUCH/MOUSE INPUT  (checks H1-H17)
// =====================================================================================================
//
// WHY THIS EXISTS
// ---------------
// Mirror input is COORDINATE-ONLY on the wire: the browser resolves a pointer to a GAME design-space
// point (1920x1080) and the game hit-tests it natively. Readable-hand mode then RAISES the hand ~119px
// with a cosmetic CSS translate, and `raiseInverse.ts` un-maps a pointer that lands on a raised card.
//
// Every bug this file pins is a FEEDBACK-LOOP bug, and that is the whole reason it drives a real game:
//
//     send a coordinate -> the game focuses/z-lifts/re-poses the holders -> the boxes MOVE ->
//     the next resolve sees different geometry -> it sends a different coordinate -> ...
//
// A replayed recording cannot exercise that loop: a recording is passive, so the boxes never answer
// back. That is exactly why the round-1 identity/anchor targeting work passed every unit test and every
// replayed-recording probe and still regressed live (hovered cards not focusing, focus applying then
// dropping, the targeting arrow riding a constant offset from the cursor, grabbed cards vanishing).
// Those four symptoms are H1, H2, H3 and H4 below. This harness is the ANTI-CHURN mechanism: the same
// class of bug has been fixed and re-broken across three rounds, so the checks are NAMED, the failure
// output is diagnostic, and every future touch-input round must run this before landing.
//
// WHAT EACH CHECK PINS
// --------------------
//   H1  hover-focus        Dwelling on a card focuses THAT card, and the focus is stable while dwelling.
//                          Sampled at card centres, at fan SEAMS (points drawn over two cards) and in
//                          the bottom band the raise reveals. On failure the whole focused-holder
//                          timeline is printed, because "which card, when" is the actual diagnosis.
//   H2  no overshoot       A focus that lands does not apply-then-drop: once a card focuses it stays for
//                          the rest of the dwell (one tween, ~250ms, then quiet).
//   H3  arrow tracking     Dragging a TARGETED card: once the pointer is far from the press point, the
//                          coordinate on the wire must converge to the pointer's own design position.
//                          The game draws the targeting arrow AT that coordinate, so a constant offset
//                          here IS the "arrow does not follow my finger" report. Screenshot saved.
//   H4  held visibility    Through grab -> drag -> targeting -> release, the grabbed card's element stays
//                          renderable: present, displayed, non-zero, on stage. Records WHICH frames broke.
//   H5  top-band grab      A press near the TOP edge of a raised card still starts a grab (the band that
//                          used to resolve above the card into empty board).
//   H6  edge/corner taps   A tap on a card's corner/edge, and on the art that overhangs the hitbox,
//                          focuses the card the player SEES there, not a distant neighbour.
//   H7  choice prompt      While a from-hand choice prompt is up the cosmetic raise drops to 0 (the
//                          prompt lays the hand out its own way; raising it fights the game).
//   H8  confirm firewall   Touch only. A rest-site option tap FOCUSES and raises the confirm button
//                          without committing; a tap in the label band BELOW the button's true hit box
//                          does nothing at all. Optionally the same for a reward card's nominal box.
//   H9  drag-drop cancel    A hand card dragged up into the play area and dropped back into the hand —
//                          OFF the grab point — cancels, and the hand answers hover/tap again afterwards.
//                          Records the post-drop envelopes so "nothing was sent" and "nothing answered"
//                          stay separable.
//   H10 handoff overshoot   Focus handed back and forth across adjacent cards: sampled every animation
//                          frame, no card may be drawn PAST the pose it is heading for and come back.
//   H14 hold-to-raise       The client hand control enables readable-hand mode on pointer-down, stays enabled
//                          under capture outside its box, and restores the saved OFF setting on release.
//   H15 five-to-four        Playing the fifth card leaves four; the fourth survivor's raised-only upper band
//                          focuses it, while a nearby dead pixel receives no raise correction.
//   H16 reward focus        Reward-list entry follows the page's last press modality. Touch entry focuses the
//                          first row (and therefore shows its HoverTip), one tap on that row puts a plain left
//                          click on its native centre, and the readiness that made it one-tap does NOT survive
//                          focus moving away. Pointer entry never auto-focuses, and unknown -> touch while the
//                          list is already open never moves focus by itself. Activation is asserted on the WIRE:
//                          no reward can be CLAIMED on a rewards fixture — see checkH16.
//   H17 shop removal        The merchant's card-removal coin honours every Tap to focus / Confirm tap setting
//                          combination. Each irreversible route starts from a fresh shop, opens removal, then
//                          stages (but never confirms) one deck card through the real browser-to-game loop.
//
// PREREQUISITES
// -------------
//   * A working tree that builds under vite (this harness serves the UNDEPLOYED client on purpose).
//   * `sts2` on PATH and `sts2.local.yaml` present at the repo root (run from anywhere; the script cds).
//   * The mod already deployed in the game install. This harness NEVER builds or deploys anything.
//
// HOW TO RUN
// ----------
//     node scripts/validate-touch-live.mjs                       # full matrix, brings everything up
//     node scripts/validate-touch-live.mjs --keep                # leave instance + vite up to iterate
//     node scripts/validate-touch-live.mjs --checks H1,H3 --combos mouse-1920
//     node scripts/validate-touch-live.mjs --list                # print the combo/check names and exit
//     node scripts/validate-touch-live.mjs --observe --keep      # bring-up ONLY, no gestures, leave it up
//
// `--observe` (BRING-UP WITHOUT GESTURES)
// ---------------------------------------
// Both `--checks` and `--combos` still RUN gestures — a subset is a smaller closed loop, not a quiet one.
// Some work (the U3b live raise probe, `scripts/probe-raise-live.mjs`) needs the lifecycle and nothing
// else: instance up, fixture loaded, a mirror page streamed and readable-hand mode on, then a second
// tool opens its own pages. Round 7 had to reproduce that lifecycle by hand.
//
// `--observe` truncates to the FIRST selected combo and returns from `runCombo` between the
// `__mirrorHandRaise` sanity read and `makePointer` — the first gesture-capable line. So the entire
// gesture-free prefix runs VERBATIM, which is the point: observe certifies the same bring-up path the
// gesture combos use rather than a lookalike of it. The WebSocket recorder stays installed (it is
// passive, it is part of the path being certified, and printing `sentInputs: 0` makes "observe sent no
// gestures" MEASURED rather than asserted). `--keep` means exactly what it always meant.
//
// The MATRIX is stage {DOM, canvas} x pointer {mouse, touch} x viewport {1920x1080, 2400x1080}.
// Checks that still depend on per-node DOM explicitly skip on canvas; H11-H17 use
// shared renderer seams and therefore gate both backends. Readiness is also stage-specific: streamed DOM node
// count for DOM, interactive canvas rects for canvas.
//
// The wide leg is not optional: widescreen stretch is ON by default and the design box grows to as much
// as 2520 at 20:9, and the near-miss / spread / squeeze machinery ONLY runs above designWidth 1920. A
// 16:9-only run proves nothing about any of it.
//
// EXIT CODE
// ---------
// The table always prints in full. Every selected combination gates the exit code.
//
// SAFETY RULES (non-negotiable — a past incident scripted blind input into a live game)
// -------------------------------------------------------------------------------------
//   * This harness talks ONLY to its OWN named instance (default `touchqa`) on its OWN port (default
//     13457). The developer's game lives on :13337 with the default bridge socket and must never be
//     touched: no input, no `game close` without `--instance`, no fixture loads.
//   * It shuts down ONLY what it started. An instance/vite it FOUND already running is left running,
//     whatever `--keep` says.
//   * Nothing is swallowed. Unlike `scripts/validate-map-overlay-live.mjs` (which drops outgoing action
//     envelopes so it cannot disturb a live game), every gesture here really reaches the game — the
//     closed loop IS the measurement. That is safe precisely because the instance is ours.
//   * Artifacts go to `.sts2/artifacts/touch-harness/` (git-ignored). Never commit them.
//
// HOW THE PAGE IS OBSERVED (the seams, so a later agent does not have to re-derive them)
// -------------------------------------------------------------------------------------
//   * `window.__mirrorInteractiveRects()`  -> the frame's mouse-visible boxes. The hand's 300x422
//     hitboxes are the entries with `raiseGoverned`; each carries `transform` (game-space affine),
//     `localRect`, `spreadDx` (widescreen shift) and `raiseDy` (the cosmetic lift, negative).
//   * `window.__mirrorHandRaise()` -> every gate behind the current lift plus a per-holder ramp
//     (`holders[].localY` / `.dy` / `.translate`), `targetingArrows`, `choicePrompt`, `dragging`.
//   * FOCUS IDENTITY: `window.__mirrorHandPoses()` carries every holder's streamed zIndex and game pose on both
//     stages. The game z-lifts the focused holder IMMEDIATELY (zIndex 1), before sibling reordering; the lowest
//     pose is the independent cross-check (about 159px above the resting fan).
//   * A hitbox rect maps to its holder through the DOM: `[data-node-id="<rect.id>"]`.closest(holder).
//   * `.mirror-stage` — `offsetWidth/offsetHeight` is the DESIGN box, `getBoundingClientRect()` the CSS
//     box; their ratio is the design->CSS scale (transform-origin is centre, so the rect already
//     accounts for it — do not add a centring offset).
//   * SENT COORDINATES: an init script wraps `WebSocket.prototype.send` and RECORDS (never drops)
//     `{type:"input"}` envelopes into `window.__sentInputs` with timestamps. That is the stimulus half
//     of the closed loop, and H3 is an assertion about it.
//
// GOTCHAS THAT COST TIME BEFORE (leave these comments in)
// ------------------------------------------------------
//   * A fresh instance whose user-dir has no `steam/<id>` profile opens a Steam cloud-sync modal and the
//     browser server NEVER starts (symptom: the port never opens). `sts2 --instance` seeds the profile
//     itself; if the port never opens, check `<instanceDir>/user/SlayTheSpire2/logs/godot.log` first.
//   * Under `--headless` the mod's idle visual suspender drops `Engine.MaxFps` to 8 after a quiet
//     period, which adds seconds of latency to a closed-loop measurement. The launcher below exports
//     `COUCHCOOP_HEADLESS_IDLE_FPS=0` to disable the throttle while keeping the freezes.
//   * `page.evaluate(<string>)` IGNORES extra args. Every page-side helper here is a real function with
//     real arguments for that reason.
//   * Playwright's touchscreen only exposes `tap()`. Everything needing a held finger (a peek dwell, a
//     drag, a targeting sweep) goes through CDP `Input.dispatchTouchEvent`.
//   * The confirm button hides with a 350ms exit slide, so its visibility is sampled >=800ms after the
//     tap that should have hidden it. Sampling sooner false-fails.
//   * A drag released over an enemy PLAYS the card. Every gesture here that does not mean to commit
//     returns to its press point before releasing, and every combo reloads the combat fixture first.
//
// =====================================================================================================

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { waitForInstancePort } from "./lib/instance-port.mjs";
import { acquireLease, releaseLease } from "./live-qa-lock.mjs";
import { assessClientConfirm, selectMirrorModuleBundle } from "./lib/h17-client-confirm-readiness.mjs";
import { h15CoordinateVerdict, h15FocusedGrabFailure, planH15FifthPlay } from "./lib/h15-plan.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(`${REPO_ROOT}/frontend/package.json`);
const { chromium } = require("@playwright/test");

// ---------------------------------------------------------------------------------------------------
// Constants that are FACTS ABOUT THE GAME, capture-verified. Changing one of these is changing what the
// harness believes the game does, not a tuning knob.
// ---------------------------------------------------------------------------------------------------

/** A focused holder sits this far above the resting fan (game px). Used only as a sanity cross-check. */
const FOCUS_POSE_RISE_PX = 120;
/** The cosmetic readable-hand lift. `?handRaise=` can retune it; the harness reads the live value. */
const NOMINAL_RAISE_PX = 119;
/**
 * How close (in a card's own local px) the runner-up card may be to containing a point before the point counts
 * as a SEAM rather than as exclusively one card's. See the use site in H1 for why this is not slack.
 *
 * 30 is chosen against the fan's own geometry, not picked for a green run: a card CENTRE sits about 58 local px
 * clear of its neighbour's edge, so the centres — the points this check most wants to be strict about — stay
 * strict, while the 1-to-25px band where a settling fan and the game's topmost-first arbitration genuinely
 * disagree with a stale read is absorbed. A tolerance of 60 turns the centres into seams and hollows the check
 * out; that was measured before this value was chosen.
 */
const SEAM_TOLERANCE_LOCAL_PX = 30;
/** Reward cards are guarded by a nominal box about the (0x0) card origin — the client's own model. */
const REWARD_CARD_NOMINAL = { w: 240, h: 338 };
/** The confirm button's exit slide. Sample its visibility no sooner than this after the triggering tap. */
const CONFIRM_SETTLE_MS = 850;
/**
 * How long H11 lets a focus / selection take hold before it starts WAITING for rest.
 *
 * It is a floor, not the wait: `awaitPoseRest` is what decides the hand has stopped. This just covers the gap
 * between the gesture and the game reacting to it at all, so the rest wait cannot succeed on the state BEFORE the
 * gesture (two quiet polls of a fan that has not moved yet look exactly like a settled one).
 */
const FOCUS_SETTLE_MS = 420;

// ---------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------

const ALL_CHECKS = ["H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8", "H9", "H10", "H11", "H12", "H13", "H14", "H15", "H16", "H17"];

/**
 * THE STAGE AXIS (2026-08-28).
 *
 * This file used to say, in its header, that there is deliberately no `?stage=canvas` lever here, because every
 * check reads `[data-node-id]` geometry and the canvas stage hands out DOM elements for overlay records only.
 * That was true, and it is exactly how the canvas stage came to ship a hand-motion prediction that no instrument
 * had ever been pointed at: the one check that measures the reported defect (H10, and now H11) could not run on
 * the stage that has it.
 *
 * What changed is that both backends now answer `window.__mirrorHandPoses()` — the shared seam in
 * `frontend/src/mirror/handPoseProbe.ts` — with the hand's drawn geometry, the game's own poses, and the ids that
 * used to require walking DOM ancestry. So a check written against THAT runs on either stage.
 *
 * H11-H17 are written that way and run on both. H1-H10 are not (yet): they read elements, so on a canvas
 * combo they SKIP with a reason rather than failing for the wrong cause. Porting them is the next round's work;
 * DOM remains the shipping default, while every selected combo still gates its applicable checks.
 */
const STAGES = ["dom", "canvas"];
/** Checks that read the shared seam alone, and therefore run on any stage. */
const STAGE_AGNOSTIC_CHECKS = new Set(["H11", "H12", "H13", "H14", "H15", "H16", "H17"]);

const COMBOS = [];
for (const stage of STAGES) {
  for (const pointer of ["mouse", "touch"]) {
    for (const [w, h, tag] of [[1920, 1080, "1920"], [2400, 1080, "2400"]]) {
      const base = `${pointer}-${tag}`;
      COMBOS.push({ name: stage === "dom" ? base : `canvas-${base}`, stage, pointer, width: w, height: h });
    }
  }
}

function parseArgs(argv) {
  const a = {
    gamePort: 13457,
    vitePort: 5199,
    instance: "touchqa",
    checks: ALL_CHECKS.slice(),
    // The DOM combos, which is what this harness has always run. `--stage canvas` / `--stage both` widens it.
    combos: COMBOS.filter((c) => c.stage === "dom").map((c) => c.name),
    keep: false,
    list: false,
    observe: false,
    out: `${REPO_ROOT}/.sts2/artifacts/touch-harness`,
    launchTimeoutMs: 240000,
    stage: "dom",
    combosExplicit: false,
    // Extra query params appended to the page URL for EVERY combo — how a URL lever gets bisected against a live
    // game without editing this file. `--query tweenReparent=keep,spreadEndpoint=off`.
    query: []
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--game-port": a.gamePort = Number(next()); break;
      case "--vite-port": a.vitePort = Number(next()); break;
      case "--instance": a.instance = next(); break;
      case "--checks": a.checks = next().split(",").map((s) => s.trim().toUpperCase()).filter(Boolean); break;
      case "--combos": a.combos = next().split(",").map((s) => s.trim()).filter(Boolean); a.combosExplicit = true; break;
      case "--stage": a.stage = next().trim(); break;
      case "--query": a.query = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--out": a.out = resolve(next()); break;
      case "--keep": a.keep = true; break;
      case "--observe": a.observe = true; break;
      case "--list": a.list = true; break;
      case "-h": case "--help": a.list = true; break;
      default: throw new Error(`unknown flag ${arg}`);
    }
  }
  if (!["dom", "canvas", "both"].includes(a.stage)) {
    throw new Error(`unknown --stage ${a.stage} (dom | canvas | both)`);
  }
  // `--stage` selects the combo SET unless the caller named combos explicitly, in which case they said what they
  // wanted and the flag must not silently widen or narrow it.
  if (!a.combosExplicit) {
    const stages = a.stage === "both" ? STAGES : [a.stage];
    a.combos = COMBOS.filter((c) => stages.includes(c.stage)).map((c) => c.name);
  }
  const unknownCheck = a.checks.find((c) => !ALL_CHECKS.includes(c));
  if (unknownCheck) throw new Error(`unknown check ${unknownCheck} (known: ${ALL_CHECKS.join(",")})`);
  const unknownCombo = a.combos.find((c) => !COMBOS.some((x) => x.name === c));
  if (unknownCombo) throw new Error(`unknown combo ${unknownCombo} (known: ${COMBOS.map((c) => c.name).join(",")})`);
  return a;
}

const args = parseArgs(process.argv.slice(2));

if (args.list) {
  console.log("checks:", ALL_CHECKS.join(", "));
  console.log("combos:", COMBOS.map((c) => c.name).join(", "));
  console.log("\n--observe: bring-up only — the first selected combo, no gestures, no checks. Prints the page url,");
  console.log("           readiness ms, the streamed node count, the __mirrorHandRaise digest, the interactive-rect");
  console.log("           count and sentInputs (0, measured). Honours --keep. Use it to hand a live page to another");
  console.log("           tool without this harness driving any input at all.");
  console.log("\nsee the header of this file for what each check pins and for the safety rules.");
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log(...m);
const now = () => Date.now();

function portOpen(port) {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (ok) => { socket.destroy(); done(ok); };
    socket.setTimeout(700);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitForPort(port, timeoutMs, label) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (await portOpen(port)) return true;
    await sleep(600);
  }
  throw new Error(`${label} never came up on :${port} within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------------------------------
// Lifecycle. Everything here is scoped to OUR instance and OUR ports; see the safety rules in the header.
// ---------------------------------------------------------------------------------------------------

const spawned = { game: false, vite: null };
const lease = { held: false, owner: `touch-input-qa-${process.pid}` };

const FIXTURES = {
  combat: "scripts/fixtures/touch-live-combat.sts2.fixture.yaml",
  handFive: "scripts/fixtures/touch-live-hand-five.sts2.fixture.yaml",
  handSelect: "scripts/fixtures/touch-live-hand-select.sts2.fixture.yaml",
  rest: "scripts/fixtures/touch-live-rest.sts2.fixture.yaml",
  rewards: "scripts/fixtures/touch-live-rewards.sts2.fixture.yaml",
  rewardFocus: "scripts/fixtures/touch-live-reward-focus.sts2.fixture.yaml",
  shopRemoval: "scripts/fixtures/touch-live-shop-removal.sts2.fixture.yaml"
};

async function ensureGame() {
  if (await portOpen(args.gamePort)) {
    log(`[setup] reusing the game already serving :${args.gamePort} (not ours to shut down)`);
    return;
  }
  log(`[setup] launching instance '${args.instance}' headless, browser server on :${args.gamePort} ...`);
  const res = spawnSync(
    "sts2",
    ["--instance", args.instance, "game", "launch", "--timeout-ms", String(args.launchTimeoutMs), "--", "--headless"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: args.launchTimeoutMs + 30000,
      env: {
        ...process.env,
        COUCHCOOP_PREFERRED_PORT: String(args.gamePort),
        // Keep the closed loop responsive: the headless idle suspender otherwise caps Engine.MaxFps at 8.
        COUCHCOOP_HEADLESS_IDLE_FPS: "0"
      }
    }
  );
  if (res.status !== 0) {
    throw new Error(`sts2 game launch failed (${res.status}):\n${(res.stderr || res.stdout || "").slice(-2000)}`);
  }
  spawned.game = true;
  // THE PORT WE ASKED FOR IS A PREFERENCE. `CouchCoopBrowserServer.StartAsync` walks upward when it is taken, so
  // waiting on `args.gamePort` alone cannot tell "still booting" from "up on a port nothing told us about" — and
  // the second one looks exactly like an infinite boot. The mod writes the port it bound into its own user dir;
  // this resolves it and REBINDS `args.gamePort` so the vite proxy and every page URL follow the real one.
  args.gamePort = await waitForInstancePort(REPO_ROOT, args.instance, args.gamePort, 180000, log);
  log(`[setup] instance '${args.instance}' up on :${args.gamePort}`);
}

async function ensureVite() {
  if (await portOpen(args.vitePort)) {
    log(`[setup] reusing the dev server already on :${args.vitePort} (not ours to shut down)`);
    return;
  }
  log(`[setup] starting vite on :${args.vitePort} proxying to :${args.gamePort} ...`);
  // DETACHED on purpose: `npx` is a wrapper that spawns vite as a child, so SIGTERM to the npx pid
  // leaves vite holding the port. Its own process group lets teardown signal the whole tree
  // (`process.kill(-pid)`), and lets `--keep` walk away from a server that stays up.
  const child = spawn("npx", ["vite", "--port", String(args.vitePort), "--strictPort"], {
    cwd: `${REPO_ROOT}/frontend`,
    env: { ...process.env, COUCHCOOP_DEV_PROXY_TARGET: `http://127.0.0.1:${args.gamePort}` },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => process.stderr.write(`[vite] ${d}`));
  spawned.vite = child;
  await waitForPort(args.vitePort, 60000, "the vite dev server");
  log(`[setup] vite up on :${args.vitePort}`);
}

function shutdown() {
  if (args.keep) {
    log(`\n[teardown] --keep: leaving instance '${args.instance}' and vite :${args.vitePort} up.`);
    log(`[teardown] stop them later with:  sts2 --instance ${args.instance} game close`);
    if (spawned.vite) spawned.vite.unref();
    return;
  }
  if (spawned.vite) {
    log("[teardown] stopping the vite dev server we started");
    // The GROUP, not the pid: see ensureVite — killing the npx wrapper alone leaves vite on the port.
    try { process.kill(-spawned.vite.pid, "SIGTERM"); } catch { /* already gone */ }
    try { spawned.vite.kill("SIGTERM"); } catch { /* already gone */ }
  }
  if (spawned.game) {
    log(`[teardown] closing instance '${args.instance}' (ours; never the developer's :13337 game)`);
    spawnSync("sts2", ["--instance", args.instance, "game", "close"], { cwd: REPO_ROOT, encoding: "utf8", timeout: 60000 });
  }
}

let loadedFixture = null;
function loadFixture(key, { force = false } = {}) {
  if (!force && loadedFixture === key) return;
  const res = spawnSync(
    "sts2",
    ["--instance", args.instance, "--mode", "dangerous", "dev", "fixture", "load", FIXTURES[key]],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 180000 }
  );
  if (res.status !== 0) {
    throw new Error(`fixture load '${key}' failed (${res.status}):\n${(res.stderr || res.stdout || "").slice(-1500)}`);
  }
  loadedFixture = key;
}

/**
 * Read semantic state from OUR named instance. H17 deliberately uses this after the browser gesture rather than
 * inferring a deck-selection overlay from painted nodes: the state response is the game-side proof that the
 * removal service opened, and that a picker tap staged exactly one card without committing it.
 */
function currentGameState() {
  const res = spawnSync(
    "sts2",
    ["--instance", args.instance, "--json", "state"],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 30000 }
  );
  if (res.status !== 0) {
    throw new Error(`sts2 state failed (${res.status}):\n${(res.stderr || res.stdout || "").slice(-1200)}`);
  }
  try {
    return JSON.parse(res.stdout);
  } catch (err) {
    throw new Error(`sts2 state returned invalid JSON: ${String(err)}\n${String(res.stdout).slice(-1200)}`);
  }
}

/** The current player's raw deck-card-selection overlay, or null when no deck picker is open. */
function currentDeckCardSelection() {
  const state = currentGameState();
  const players = Array.isArray(state?.run?.players) ? state.run.players : [];
  const currentPlayerId = state?.playerId ?? state?.localPlayerId ?? state?.run?.view?.playerId ?? null;
  const player = players.find((candidate) => candidate?.id === currentPlayerId) ?? players.find((candidate) => candidate?.isLocal) ?? players[0];
  const overlay = Array.isArray(player?.overlays)
    ? player.overlays.find((candidate) => candidate?.deckCardSelection)?.deckCardSelection
    : null;
  return { state, playerId: player?.id ?? null, overlay: overlay ?? null };
}

/** Wait for a game-semantic deck-selection transition instead of racing the streamed renderer. */
async function waitDeckCardSelection(predicate, timeoutMs = 12000) {
  const deadline = now() + timeoutMs;
  let last = null;
  while (now() < deadline) {
    last = currentDeckCardSelection();
    if (predicate(last.overlay, last)) return last;
    await sleep(160);
  }
  throw new Error(`deck-card-selection state did not settle: ${JSON.stringify(deckSelectionDigest(last))}`);
}

/** Keep H17 reports diagnostic without embedding an entire state response or card-grid payload per route. */
function deckSelectionDigest(selection) {
  const overlay = selection?.overlay;
  return {
    playerId: selection?.playerId ?? null,
    kind: overlay?.kind ?? null,
    canConfirm: overlay?.canConfirm ?? null,
    selectedCardIds: Array.isArray(overlay?.selectedCardIds) ? overlay.selectedCardIds : [],
    cardCount: Array.isArray(overlay?.cards) ? overlay.cards.length : 0
  };
}

// ---------------------------------------------------------------------------------------------------
// Page-side readers. Real functions with real arguments (a STRING pageFunction would drop the args).
// ---------------------------------------------------------------------------------------------------

/**
 * The whole hand as the input side sees it: one entry per governed (readable-hand) hitbox, with its
 * holder + card node ids and a set of named sample points already converted to CLIENT px.
 *
 * `at(fx, fy)` walks the rect's own local frame, so the points ride the card's rotation — a fanned card
 * is tilted up to ~15 degrees and an axis-aligned "top edge" would not be on the card at all. `fy` may
 * exceed [0,1] deliberately: that is how the art-overhang samples (H6) get just OUTSIDE the hit box.
 */
const readHand = (page) =>
  page.evaluate(() => {
    const stage = document.querySelector(".mirror-stage");
    if (!stage) return null;
    const r = stage.getBoundingClientRect();
    const designW = stage.offsetWidth;
    const scale = r.width / designW;
    // THE JOIN, off the shared seam rather than off DOM ancestry (2026-08-28). It used to be
    // `rect → closest([data-node-type$=NHandCardHolder])`, which is why this whole harness was DOM-only: the
    // canvas stage emits no per-node elements for that to find. `__mirrorHandPoses()` publishes each holder's
    // own hitbox id — the id `interactiveRects()` keys the drawn card rect under — and whether the holder is
    // still in the FAN, which is the same out-of-fan exclusion this used `handRaise().holders[].localY === null`
    // for. One reader, both stages, same numbers.
    const seam = window.__mirrorHandPoses ? window.__mirrorHandPoses() : null;
    if (!seam) return null;
    const byHitbox = new Map();
    for (const h of seam.holders) {
      if (h.hitboxId) byHitbox.set(h.hitboxId, h);
    }
    const gov = window
      .__mirrorInteractiveRects()
      .filter((x) => x.raiseGoverned && byHitbox.has(x.id) && byHitbox.get(x.id).inFan);
    const cards = gov.map((rect, index) => {
      const holder = byHitbox.get(rect.id);
      const m = rect.transform;
      const lr = rect.localRect;
      const at = (fx, fy) => {
        const lx = lr.x + lr.width * fx;
        const ly = lr.y + lr.height * fy;
        const gx = m[0] * lx + m[2] * ly + m[4];
        const gy = m[1] * lx + m[3] * ly + m[5] + rect.raiseDy;
        return {
          gx,
          gy,
          cx: r.left + (gx + rect.spreadDx) * scale,
          cy: r.top + gy * scale,
          // The fan's outer cards hang BELOW the stage even after the raise, so their nominal bottom
          // band is a place no finger can reach. Sampling there measures the harness, not the game.
          onStage: gx >= 2 && gx <= designW - 2 && gy >= 2 && gy <= stage.offsetHeight - 2
        };
      };
      return {
        index,
        rectId: rect.id,
        holderId: holder.id,
        cardId: holder.cardId,
        cardContentKey: holder.cardContentKey,
        name: holder.name,
        raiseDy: rect.raiseDy,
        spreadDx: rect.spreadDx,
        centre: at(0.5, 0.5),
        top: at(0.5, 0.06),
        bottom: at(0.5, 0.9),
        leftEdge: at(0.04, 0.5),
        rightEdge: at(0.96, 0.5),
        topLeft: at(0.06, 0.08),
        topRight: at(0.94, 0.08),
        overhangTop: at(0.5, -0.05),
        overhangLeft: at(-0.05, 0.5),
      };
    });
    return { scale, designW, designH: stage.offsetHeight, origin: { x: r.left, y: r.top }, cards };
  });

/**
 * The focus verdict for one sample: WHICH holder the game has focused, plus every gate the raise
 * depends on. `zFocus` is the authoritative id (the game z-lifts the focused holder immediately);
 * `poseFocus` is the same answer read off the pose ramp, kept as an independent cross-check so a
 * disagreement between the two is itself visible in a failure dump. Both answers come from the hand-pose seam:
 * canvas deliberately has no holder DOM to inspect, and the seam gives each stage the same z-order + game pose.
 */
const readFocus = (page, riseThreshold) =>
  page.evaluate((rise) => {
    const pose = window.__mirrorHandPoses ? window.__mirrorHandPoses() : null;
    const holders = pose?.holders.filter((h) => h.inFan) ?? [];
    const zFocus = holders.filter((h) => h.zIndex === 1).map((h) => h.id);
    const ys = holders
      .filter((h) => Array.isArray(h.mGame) && Number.isFinite(h.mGame[5]))
      .map((h) => ({ id: h.id, y: h.mGame[5] }));
    const sorted = [...ys].sort((a, b) => a.y - b.y);
    const gap = sorted.length > 1 ? sorted[1].y - sorted[0].y : 0;
    const hr = window.__mirrorHandRaise ? window.__mirrorHandRaise() : null;
    const raise = hr?.raise ?? hr ?? {};
    return {
      t: Math.round(performance.now()),
      zFocus: zFocus.length === 1 ? zFocus[0] : zFocus.length === 0 ? null : zFocus.join("+"),
      poseFocus: gap >= rise ? sorted[0].id : null,
      lift: raise.liftPx ?? 0,
      arrows: raise.targetingArrows ?? (raise.targeting ? 1 : 0),
      choicePrompt: !!raise.choicePrompt,
      dragging: !!raise.dragging,
      dimmed: !!raise.dimmed,
      // The holders the game has taken OUT of the fan (selected / mid-drag / mid-return): `localY` is null for
      // exactly those (see handOutOfFan). Carried here as well as in the dedicated reader because a failure dump
      // that says "the game focused nothing" is only readable next to "…and it still had a card selected".
      outOfFan: pose?.holders.filter((h) => !h.inFan).map((h) => h.id) ?? []
    };
  }, riseThreshold);

/**
 * WHICH CARDS IS THIS POINT ON? — the expectation source for every targeting check.
 *
 * The obvious candidate, `document.elementsFromPoint`, is WRONG here and was measured to be wrong: a
 * hand card paints an always-on glow whose box is roughly twice the card, so the topmost *element* over
 * card N's own centre is routinely card N+1's glow. Using it made every check fail by exactly one card.
 *
 * So containment is computed against the DRAWN 300x422 hit boxes instead — the card's real footprint,
 * the box the art is centred on, and the box the game itself hit-tests (shifted by the renderer's
 * cosmetic `raiseDy`, which is what "drawn" means here). The test is ORIENTED, not an AABB: a fan card
 * sits at up to ~15 degrees and its axis-aligned bounds cover a lot of things it does not.
 *
 * Returns, for each governed card: whether the point is inside its drawn box, and its penetration
 * distance in the card's own local px when it is not. `topmost` is the containing card the player sees
 * on top (later in paint order wins; the renderer publishes the rects in that order).
 */
const classifyPoint = (page, gx, gy) =>
  page.evaluate(([px, py]) => {
    // Same out-of-fan exclusion as readHand: the expectation and the sample point must be computed from the SAME
    // set of cards, or an index in one names a different card in the other.
    const outOfFan = new Set(window.__mirrorHandRaise().holders.filter((h) => h.localY === null).map((h) => h.id));
    const gov = window.__mirrorInteractiveRects().filter((x) => {
      if (!x.raiseGoverned) return false;
      const el = document.querySelector(`[data-node-id="${x.id}"]`);
      const holder = el ? el.closest('[data-node-type$="NHandCardHolder"]') : null;
      return holder !== null && !outOfFan.has(holder.getAttribute("data-node-id"));
    });
    const rows = gov.map((rect, index) => {
      const m = rect.transform;
      const lr = rect.localRect;
      const det = m[0] * m[3] - m[1] * m[2];
      const dx = px - m[4];
      const dy = py - rect.raiseDy - m[5]; // un-do the cosmetic lift: compare against the DRAWN box
      const lx = (dx * m[3] - dy * m[2]) / det;
      const ly = (-dx * m[1] + dy * m[0]) / det;
      const ox = lx < lr.x ? lr.x - lx : lx > lr.x + lr.width ? lx - (lr.x + lr.width) : 0;
      const oy = ly < lr.y ? lr.y - ly : ly > lr.y + lr.height ? ly - (lr.y + lr.height) : 0;
      const el = document.querySelector(`[data-node-id="${rect.id}"]`);
      const holder = el ? el.closest('[data-node-type$="NHandCardHolder"]') : null;
      return {
        index,
        holderId: holder ? holder.getAttribute("data-node-id") : null,
        inside: ox === 0 && oy === 0,
        penetration: Math.round(Math.hypot(ox, oy))
      };
    });
    const containing = rows.filter((r) => r.inside);
    const nearest = [...rows].sort((a, b) => a.penetration - b.penetration);
    // How far the SECOND-nearest card is from containing the point, in its own local px. A fan overlaps
    // continuously, so a point a few px from a neighbour's edge is a seam in practice however cleanly the
    // arithmetic says it is inside exactly one box — see SEAM_TOLERANCE_LOCAL_PX.
    const runnerUp = nearest.filter((r) => r.penetration > 0)[0];
    return {
      containing: containing.map((r) => r.holderId),
      containingIndexes: containing.map((r) => r.index),
      runnerUpHolder: runnerUp ? runnerUp.holderId : null,
      runnerUpPenetration: runnerUp ? runnerUp.penetration : null,
      topmost: containing.length ? containing[containing.length - 1].holderId : null,
      nearest: nearest.slice(0, 2).map((r) => r.holderId),
      nearestIndexes: nearest.slice(0, 2).map((r) => r.index),
      nearestPenetration: nearest[0] ? nearest[0].penetration : null,
      // Per-card penetration, so a failure dump answers "how far off was it" without a second run.
      penetrations: rows.map((r) => r.penetration)
    };
  }, [gx, gy]);

/** The grabbed card's renderability, by node id. `sub` is the union of its painting descendants. */
const readCardVisibility = (page, cardId) =>
  page.evaluate((id) => {
    const el = document.querySelector(`[data-node-id="${id}"]`);
    const stage = document.querySelector(".mirror-stage");
    if (!el || !stage) return { t: Math.round(performance.now()), missing: true };
    const cs = getComputedStyle(el);
    const sr = stage.getBoundingClientRect();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
    for (const d of el.querySelectorAll("*")) {
      const b = d.getBoundingClientRect();
      if (b.width > 2 && b.height > 2 && getComputedStyle(d).display !== "none") {
        n++;
        minX = Math.min(minX, b.left); minY = Math.min(minY, b.top);
        maxX = Math.max(maxX, b.right); maxY = Math.max(maxY, b.bottom);
      }
    }
    const box = n ? { x: Math.round(minX), y: Math.round(minY), w: Math.round(maxX - minX), h: Math.round(maxY - minY) } : null;
    const onStage = box !== null && box.x < sr.right && box.x + box.w > sr.left && box.y < sr.bottom && box.y + box.h > sr.top;
    return {
      t: Math.round(performance.now()),
      missing: false,
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      paintingDescendants: n,
      box,
      onStage
    };
  }, cardId);

/**
 * Read the hand only once the fan has stopped moving. EVERY hand check must go through this: a check
 * that reads geometry while the previous check's card is still sliding home samples points that are not
 * where it thinks they are, and then reports the game for it.
 */
async function handAtRest(page) {
  await awaitFanRest(page);
  return readHand(page);
}

/**
 * Resolve a planned sample point from the CURRENT hand: `holders` names the card (or, for a seam, the two cards
 * whose named points are averaged) by holder id, `key` names the point on it. Null when a named card is no longer
 * in the hand — that is a "nothing to ask" case, not a failure, and the caller counts it separately.
 *
 * This exists because a dwell can move the hand: a touch dwell is a PEEK, which lifts the card and lets the game
 * re-pose the fan around it. Points fixed at the start of a sweep then aim at where the cards used to be while the
 * expectation is computed from where they are now, and the disagreement reads exactly like a mis-target.
 */
async function livePoint(page, holders, key) {
  const live = await handAtRest(page);
  if (!live) return null;
  const cards = holders.map((id) => live.cards.find((c) => c.holderId === id));
  if (cards.some((c) => c === undefined)) return null;
  if (cards.length === 1) return cards[0][key];
  const a = cards[0][key];
  const b = cards[1][key];
  return {
    cx: (a.cx + b.cx) / 2,
    cy: (a.cy + b.cy) / 2,
    gx: (a.gx + b.gx) / 2,
    gy: (a.gy + b.gy) / 2,
    onStage: a.onStage !== false && b.onStage !== false
  };
}

const readSentInputs = (page, sinceIndex) =>
  page.evaluate((from) => window.__sentInputs.slice(from), sinceIndex);

const sentCount = (page) => page.evaluate(() => window.__sentInputs.length);

// ---------------------------------------------------------------------------------------------------
// Pointer abstraction. Mouse rides page.mouse; touch rides CDP, because Playwright's touchscreen only
// offers an atomic tap() and every interesting gesture here needs a HELD finger.
// ---------------------------------------------------------------------------------------------------

async function makePointer(page, kind) {
  if (kind === "mouse") {
    let lastPosition = null;
    const move = async (x, y) => {
      await page.mouse.move(x, y);
      lastPosition = { x, y };
    };
    return {
      kind,
      // A dwell for a mouse is simply hovering there; nothing to end. Moving to the coordinate the cursor
      // already occupies emits no event, so only that case needs a tiny jiggle to make the dwell observable.
      // Approaching every point from y-3 is itself a sample: it can focus a card and repose the hand before
      // the target point is sent, leaving that stale target over a different card.
      dwellStart: async (x, y) => {
        if (lastPosition?.x === x && lastPosition.y === y) await move(x, y - 3);
        await move(x, y);
      },
      dwellEnd: async () => {},
      press: async (x, y) => { await move(x, y); await page.mouse.down(); },
      drag: (x, y) => move(x, y),
      release: async (x, y) => { await move(x, y); await page.mouse.up(); },
      // Park the cursor somewhere with nothing under it, so the next sample starts unfocused.
      rest: (x, y) => move(x, y)
    };
  }
  const cdp = await page.context().newCDPSession(page);
  const dispatch = (type, x, y) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 1 }]
    });
  return {
    kind,
    // A TOUCH dwell is a PEEK: a finger held still on a hand card past PEEK_MS focuses + raises it and
    // does NOT play it on release. That is the honest touch analogue of a mouse hover, and it is the
    // only one — a touchscreen has no hover channel at all.
    dwellStart: (x, y) => dispatch("touchStart", x, y),
    dwellEnd: (x, y) => dispatch("touchEnd", x, y),
    press: (x, y) => dispatch("touchStart", x, y),
    drag: (x, y) => dispatch("touchMove", x, y),
    release: (x, y) => dispatch("touchEnd", x, y),
    // REST IS A TAP ON NOTHING, and it is not decoration — it is the touch leg's equivalent of parking the
    // mouse cursor, and it took a diagnosis round to find out why the no-op it used to be was wrong.
    //
    // The two-step tap is the product's own gesture: the first tap on a widget ARMS it, a later tap on the
    // SAME widget COMMITS. `armedRootId` is client state that survives a whole sweep, so a check that dwells
    // five times on one card eventually re-taps the armed one and SELECTS it — the game then parks that
    // holder on the hand root and answers no hover-focus on the hand at all, and every remaining point
    // reports the game for it (measured 2026-08-26: exactly the three surviving H6 touch failures, each one
    // immediately after a dwell whose release committed). A mouse never reaches that state because it has no
    // tap gesture, which is why only the touch leg saw it.
    //
    // A tap on EMPTY space is the disarm the client itself documents (onTouchUp's `!top` branch clears
    // `armedRootId` and `pressedRootId`), and it is a no-op in the game. Deliberately refused when anything
    // is stamped under the point: a tap on a widget would arm THAT, which is the problem again with a
    // different subject, and a tap on a blocking button is a real click on a real button.
    rest: async (x, y) => {
      const empty = await page.evaluate(([px, py]) => {
        if (typeof document.elementsFromPoint !== "function") return false;
        for (const el of document.elementsFromPoint(px, py)) {
          if (el.getAttribute("data-touch-id") !== null || el.getAttribute("data-touch-block") !== null) return false;
        }
        return true;
      }, [x, y]);
      if (!empty) return;
      await dispatch("touchStart", x, y);
      await sleep(40);
      await dispatch("touchEnd", x, y);
    },
    tap: async (x, y) => { await dispatch("touchStart", x, y); await sleep(40); await dispatch("touchEnd", x, y); }
  };
}

// ---------------------------------------------------------------------------------------------------
// Result plumbing
// ---------------------------------------------------------------------------------------------------

const PASS = "PASS", FAIL = "FAIL", SKIP = "SKIP";
// `detail` on a PASS too: a check that measured something worth reading (H12's landing rows) should not have to
// fail to be allowed to say what it measured. It lands in the report file, never in the console summary.
const ok = (note, detail) => ({ status: PASS, note, detail });
const bad = (note, detail) => ({ status: FAIL, note, detail });
const skip = (note) => ({ status: SKIP, note });

/** Compress a focus timeline to its transitions, which is what a human reads in a failure dump. */
function compressTimeline(samples) {
  const out = [];
  for (const s of samples) {
    const last = out[out.length - 1];
    if (!last || last.focus !== s.zFocus) out.push({ focus: s.zFocus, from: s.t, to: s.t, n: 1 });
    else { last.to = s.t; last.n++; }
  }
  return out.map((seg) => `${seg.focus ?? "none"}@+${seg.from}..${seg.to}ms(${seg.n})`);
}

/**
 * Put an ARMED card back in the hand before the next sample point.
 *
 * On touch the two-step tap is the product's own gesture: tap once to focus, tap again to commit. A sweep that
 * dwells all over one card therefore SELECTS it eventually — and a selected targeted attack raises the targeting
 * arrow, after which the hand stops answering hover-focus at all. Photographed once (touch-1920-on H6): nine cards
 * still in hand, full energy, turn 1, and a Strike sitting in the play position with the arrow up, so every
 * remaining point in the sweep reported "focused nothing".
 *
 * The reset is the game's own cancel — a right click — driven with the mouse even in a touch context, because it
 * is HARNESS plumbing between measurements rather than part of any measurement. Cheap: it only fires when the hand
 * is actually disturbed.
 *
 * TWO disturbances, not one. An arrow up is the loud case. The quiet one — and the one that produced every touch
 * H6 failure on 2026-08-26 — is a card that was selected and needs no target: the game reparents its holder off
 * the hand CONTAINER onto the hand ROOT and parks it in the play position, where it is still a governed 300x422
 * hitbox and so still looks like a hand card to `readHand`. The sweep then aimed its next points at a card that had
 * left the hand and reported the game for not focusing it. `handRaise().holders[].localY` is null for exactly those
 * holders (see mirrorRenderer.handHolderInFan), which is the cheapest honest test available from the page.
 */
async function handOutOfFan(page) {
  // The seam's `inFan` is the same fact `handRaise().holders[].localY === null` reported (a holder the game has
  // reparented onto the hand ROOT), asked in a way the canvas stage can also answer.
  return page.evaluate(() => {
    const report = window.__mirrorHandPoses ? window.__mirrorHandPoses() : null;
    return report !== null && report.holders.some((h) => !h.inFan);
  });
}

/**
 * The raise's own gates, normalised across the two backends' debug shapes.
 *
 * The DOM publishes them flat (`targetingArrows` as a COUNT); the canvas nests the same facts under `raise` and
 * spells the arrow gate as a boolean, because its plan carries gates rather than a live element set. Neither
 * shape is wrong and neither is going to change for the harness, so the difference is absorbed here, once.
 */
const readRaiseGates = (page) =>
  page.evaluate(() => {
    const hr = window.__mirrorHandRaise ? window.__mirrorHandRaise() : null;
    if (!hr) return null;
    const r = hr.raise ?? hr;
    return {
      enabled: !!r.enabled,
      liftPx: r.liftPx ?? 0,
      targeting: (r.targetingArrows ?? 0) > 0 || r.targeting === true,
      choicePrompt: !!r.choicePrompt,
      dragging: !!r.dragging,
      dimmed: !!r.dimmed
    };
  });

async function cancelArmedSelection(page, pointer) {
  const gates = await readRaiseGates(page);
  if (!(gates && gates.targeting) && !(await handOutOfFan(page))) {
    return false;
  }
  const box = await page.evaluate(() => {
    const stage = document.querySelector(".mirror-stage");
    if (!stage) return null;
    const r = stage.getBoundingClientRect();
    return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.25 };
  });
  if (!box) return false;
  await page.mouse.click(box.x, box.y, { button: "right" });
  // Right-click is outside the pointer contract, but Playwright leaves the mouse at its click target.
  // Re-enter through `rest` so the mouse tracker's next dwell knows that exact destination. The same-point
  // move is intentionally harmless, and touch continues to use its existing mouse cancellation path.
  if (pointer?.kind === "mouse") await pointer.rest(box.x, box.y);
  await sleep(450);
  return true;
}

/**
 * Wait for the fan to come back to REST after a dwell, before the next point's geometry is read.
 *
 * This matters more than it looks: the game moves a holder by a per-process-frame exponential lerp, not
 * a fixed tween, so a card that was just focused takes several hundred ms to slide the ~159px back down
 * — and while it is in flight the published transforms are NOT the resting fan. Classifying the next
 * sample point against a mid-return fan silently produces the wrong expectation and the harness invents
 * failures. (It did: three "seam" mis-focus reports in the first run were entirely this.)
 *
 * A HAND WITH A CARD OUT OF IT IS NOT AT REST, and this is the second thing that had to be waited on. A
 * `localY` of null means the game has that holder parented to the hand ROOT rather than to the container —
 * it is selected, or in flight home from a cancel. The old test mapped null to 0 and read it as a stable
 * pose, so the wait returned immediately after a cancel and the next point was sampled into a state where
 * the game answers NO hover-focus on the hand at all (measured 2026-08-26: three H6 points reported the
 * game for not focusing while a card the sweep's own two-step tap had committed was still out).
 */
async function awaitFanRest(page, timeoutMs = 3000) {
  // Delegated to the seam's own rest wait (2026-08-28). What it used to do — read
  // `__mirrorHandRaise().holders[].localY` plus `[data-node-type$=NHandCardHolder]` z-indexes — is DOM-only, and
  // this is the wait every hand check runs through. `awaitPoseRest` asks the same three questions of the shared
  // seam (the poses stopped, the fan is whole) and adds one the element read could not: no client-side channel is
  // still replaying, so a wait cannot return in the middle of a predicted motion.
  return awaitPoseRest(page, { timeoutMs });
}

/**
 * Dwell at a point and sample the focus for `windowMs`. Returns the raw timeline plus the two verdicts
 * every hand check needs: what settled, and whether it stayed settled.
 */
async function dwellAndSample(page, pointer, pt, { settleMs = 320, windowMs = 620, stepMs = 55 } = {}) {
  const sentBefore = await sentCount(page);
  await pointer.dwellStart(pt.cx, pt.cy);
  const t0 = now();
  const samples = [];
  while (now() - t0 < settleMs + windowMs) {
    const s = await readFocus(page, FOCUS_POSE_RISE_PX);
    samples.push({ ...s, t: now() - t0 });
    await sleep(stepMs);
  }
  await pointer.dwellEnd(pt.cx, pt.cy);
  const settled = samples.filter((s) => s.t >= settleMs);
  const distinct = [...new Set(settled.map((s) => s.zFocus))];
  return {
    samples,
    // How many input envelopes the dwell put on the wire, and the last few verbatim. Carried into every
    // failure record so "the game focused nothing" can be told apart from "the browser never sent
    // anything" (different bugs, only one of them the game's) and so a mis-focus can be read as a
    // coordinate — which is the only thing that actually crossed the wire — without a second run.
    sent: (await sentCount(page)) - sentBefore,
    sentCoords: (await readSentInputs(page, sentBefore))
      .filter((s) => s.coordX !== undefined)
      .slice(-3)
      .map((s) => [Math.round(s.coordX), Math.round(s.coordY)]),
    settledFocus: distinct.length === 1 ? distinct[0] : null,
    distinctAfterSettle: distinct,
    stable: distinct.length === 1
  };
}

// ---------------------------------------------------------------------------------------------------
// CHECKS
// ---------------------------------------------------------------------------------------------------

/**
 * H1 — hover-focus. Dwell across the fan and require that the game focuses the card the pointer is on,
 * and only that card, for the whole dwell.
 *
 * TWO STRENGTHS OF ASSERTION, because the fan genuinely overlaps itself and honesty matters more than
 * a big number:
 *   * UNAMBIGUOUS point (inside exactly one card's drawn hit box) — the focus must be THAT card. This
 *     is the strict half: focusing anything else means the coordinate left the card the finger was on.
 *   * AMBIGUOUS point (a seam / an overlap, inside two or more) — the focus must be one of the cards
 *     the point is actually on. Which of two overlapping cards wins is a tie-break the player cannot
 *     call either, so asserting a specific one would invent a requirement. Focusing a card the point is
 *     NOT on is still a failure, and that is the shape every reported seam bug had.
 * A point on no card at all is dropped: there is no honest expectation for it here (H6 covers the
 * art-overhang case deliberately).
 *
 * Every point is also required to be STABLE for the dwell — an identity flip mid-dwell is H1's other
 * half, and the compressed focus timeline is printed for each failure because "which card, when" is the
 * diagnosis a fix starts from.
 */
async function checkH1(ctx) {
  const { page, pointer } = ctx;
  const hand = await handAtRest(page);
  if (!hand || hand.cards.length < 5) return skip(`only ${hand ? hand.cards.length : 0} governed hand rects — is readable-hand mode on and a hand dealt?`);

  // The plan is expressed as HOLDER IDS plus a named point on the card, never as fixed coordinates: a dwell can
  // move the hand (a touch dwell is a peek, which lifts the card the game then re-poses), and a sweep that
  // pre-computed every coordinate from the opening frame goes on aiming at where the cards USED to be while
  // `classifyPoint` answers about where they are now. That mismatch is indistinguishable from a mis-target in the
  // output, and it produced several — every point below is re-resolved from live geometry immediately before it
  // is sampled.
  const plan = [];
  for (const c of hand.cards) plan.push({ label: `card${c.index}.centre`, holders: [c.holderId], key: "centre" });
  // Bottom band: the part of the card the raise REVEALS. Its un-mapped game y is below the game's own
  // viewport floor, which is exactly the class of point that used to reach the UI but never focus.
  for (const c of hand.cards) plan.push({ label: `card${c.index}.bottom`, holders: [c.holderId], key: "bottom" });
  // Seams: the midpoint between adjacent card centres is drawn over two cards by construction.
  for (let i = 0; i + 1 < hand.cards.length; i++) {
    plan.push({ label: `seam${i}-${i + 1}`, holders: [hand.cards[i].holderId, hand.cards[i + 1].holderId], key: "centre" });
  }

  const failures = [];
  let strict = 0;
  let loose = 0;
  let offStage = 0;
  let gone = 0;
  for (const { label, holders, key } of plan) {
    const pt = await livePoint(page, holders, key);
    if (pt === null) { gone++; continue; }
    if (pt.onStage === false) { offStage++; continue; }
    const where = await classifyPoint(page, pt.gx, pt.gy);
    if (where.containing.length === 0) continue; // on no card — nothing honest to require
    // A point is treated as a SEAM either when two boxes really contain it, or when the runner-up is within
    // SEAM_TOLERANCE_LOCAL_PX of doing so. The second case is not generosity: the geometry is read up to a
    // frame or two before the coordinate is sent, the fan is a per-frame exponential lerp that is still
    // settling, and the game's own arbitration is topmost-first — so a point a handful of px from the
    // neighbour's edge can be genuinely inside it by the time the send lands. Measured: every near-boundary
    // failure of this check had the runner-up between 1 and 58 local px away and resolved to exactly that
    // neighbour, i.e. to the card drawn on top. Asserting a specific winner there measures the settle, not
    // the targeting. Points with no neighbour anywhere near keep the strict rule, which is where the bugs
    // this check exists for actually live.
    const nearSeam = where.runnerUpPenetration !== null && where.runnerUpPenetration <= SEAM_TOLERANCE_LOCAL_PX;
    const ambiguous = where.containing.length > 1 || nearSeam;
    const acceptable = nearSeam && where.runnerUpHolder ? [...where.containing, where.runnerUpHolder] : where.containing;
    if (ambiguous) loose++; else strict++;
    const r = await dwellAndSample(page, pointer, pt);
    const wrong = ambiguous ? !acceptable.includes(r.settledFocus) : r.settledFocus !== where.containing[0];
    if (wrong || !r.stable) {
      failures.push({
        point: label,
        kind: ambiguous ? "overlap" : "exclusive",
        client: [Math.round(pt.cx), Math.round(pt.cy)],
        design: [Math.round(pt.gx), Math.round(pt.gy)],
        pointIsOn: where.containing,
        pointIsOnCards: where.containingIndexes,
        acceptable,
        runnerUpPenetration: where.runnerUpPenetration,
        penetrations: where.penetrations,
        topmostDrawn: where.topmost,
        settledFocus: r.settledFocus,
        stable: r.stable,
        inputsSent: r.sent,
        sentCoords: r.sentCoords,
        timeline: compressTimeline(r.samples)
      });
    }
    await pointer.rest(hand.origin.x + hand.scale * hand.designW * 0.5, hand.origin.y + hand.scale * 220);
    await cancelArmedSelection(page, pointer);
    await awaitFanRest(page);
  }
  const evaluated = strict + loose;
  if (evaluated === 0) return skip("no sample point landed on a hand card's drawn hit box");
  const notes = [];
  if (offStage) notes.push(`${offStage} off the bottom of the stage`);
  if (gone) notes.push(`${gone} whose card had left the hand`);
  const suffix = notes.length ? ` (${notes.join(", ")} skipped)` : "";
  if (failures.length === 0) return ok(`${strict} exclusive + ${loose} overlap dwell points, all focused a card the pointer was on and held it${suffix}`);
  return bad(`${failures.length}/${evaluated} dwell points mis-focused or flipped${suffix}`, { failures });
}

/**
 * H2 — no transient overshoot. Same machinery as H1 but a LONGER dwell on a few cards, asserting only
 * the settling property: once a card focuses it must not un-focus or hand over again while the pointer
 * has not moved. This is the "applies then drops" report, isolated from "focuses the wrong card".
 */
async function checkH2(ctx) {
  const { page, pointer } = ctx;
  const hand = await handAtRest(page);
  if (!hand || hand.cards.length < 3) return skip("no hand to dwell on");
  const picks = [hand.cards[0], hand.cards[Math.floor(hand.cards.length / 2)], hand.cards[hand.cards.length - 1]]
    .filter((c) => c.centre.onStage !== false);
  if (picks.length === 0) return skip("no card centre is on stage");
  const failures = [];
  let evaluated = 0;
  for (const c of picks) {
    const where = await classifyPoint(page, c.centre.gx, c.centre.gy);
    // The fan can differ from the frame the pick was chosen in (a card drawn, a re-layout). A centre that
    // is no longer on any drawn box has nothing to say about settling; asserting on it reports the
    // harness, not the game.
    if (where.containing.length === 0) continue;
    evaluated++;
    const r = await dwellAndSample(page, pointer, c.centre, { settleMs: 300, windowMs: 1100, stepMs: 55 });
    const focusedAt = r.samples.findIndex((s) => s.zFocus !== null);
    const after = focusedAt < 0 ? [] : r.samples.slice(focusedAt);
    const flips = after.filter((s, i) => i > 0 && s.zFocus !== after[i - 1].zFocus);
    const dropped = after.some((s) => s.zFocus === null);
    if (focusedAt < 0 || flips.length > 0 || dropped) {
      failures.push({
        card: c.index,
        holder: c.holderId,
        pointIsOn: where.containing,
        pointDesign: [Math.round(c.centre.gx), Math.round(c.centre.gy)],
        inputsSent: r.sent,
        sentCoords: r.sentCoords,
        everFocused: focusedAt >= 0,
        droppedAfterFocus: dropped,
        transitionsAfterFirstFocus: flips.length,
        timeline: compressTimeline(r.samples)
      });
    }
    await pointer.rest(hand.origin.x + hand.scale * hand.designW * 0.5, hand.origin.y + hand.scale * 220);
    await awaitFanRest(page);
  }
  if (evaluated === 0) return skip("no card centre was still on a drawn hit box when the dwell started");
  if (failures.length === 0) return ok(`${evaluated} long dwells settled within one tween and stayed`);
  const never = failures.filter((f) => !f.everFocused).length;
  const churned = failures.length - never;
  const parts = [];
  if (churned) parts.push(`${churned} applied then changed/dropped`);
  if (never) parts.push(`${never} never focused at all`);
  return bad(`${failures.length}/${evaluated} dwells unsettled (${parts.join("; ")})`, { failures });
}

/**
 * Find a hand card whose drag raises the game's targeting arrow.
 *
 * ALWAYS ends with the gesture CANCELLED (dragged back to the press point, then released), whatever it
 * found. The caller then starts its own clean press. That costs one extra grab cycle and buys the thing
 * that matters: the measured drag begins from a settled hand rather than from wherever the probe left
 * the pointer — a sweep that restarts near the fan while a card is still held drops the card back into
 * the hand, and every sample after that is a plain hover being scored as a targeting drag.
 */
async function findTargetedCard(page, pointer, hand) {
  const named = hand.cards.filter((c) => /STRIKE|BASH|ANGER/i.test(c.name ?? ""));
  const candidates = [...named, ...hand.cards.filter((c) => !named.includes(c))].filter((c) => c.centre.onStage !== false);
  for (const c of candidates.slice(0, 4)) {
    await pointer.press(c.centre.cx, c.centre.cy);
    let sawArrow = false;
    for (let i = 1; i <= 5; i++) {
      await pointer.drag(c.centre.cx, c.centre.cy - i * 60);
      await sleep(80);
      if ((await readFocus(page, FOCUS_POSE_RISE_PX)).arrows > 0) sawArrow = true;
    }
    await pointer.drag(c.centre.cx, c.centre.cy);
    await sleep(150);
    await pointer.release(c.centre.cx, c.centre.cy);
    await sleep(600);
    if (sawArrow) return c;
  }
  return null;
}

/**
 * H3 — arrow tracking. The game draws the targeting arrow at the coordinate the client sends, and on a
 * widened stage a world-space visual is re-placed at `sentX * spreadFactor`. So the tracking error the
 * player sees is `|sentX * spreadFactor - pointerDesignX|` (and `|sentY - pointerDesignY|`, since Y is a
 * strict 1:1 fraction of the stage). At 16:9 spreadFactor is 1 and this is the identity map.
 *
 * Only samples taken once the pointer is well away from the press point count: near the pickup the game
 * is still resolving the grab and a few px of lag there is not the reported bug.
 */
async function checkH3(ctx) {
  const { page, pointer, combo, outDir } = ctx;
  const hand = await handAtRest(page);
  if (!hand || hand.cards.length < 3) return skip("no hand to drag from");
  const probe = await findTargetedCard(page, pointer, hand);
  if (!probe) return skip("no hand card raised a targeting arrow (fixture has no targeted attack in hand?)");
  // Re-read: the probe's grab moved the fan, and the measured drag must start from where the card IS.
  const settled = await handAtRest(page);
  const card = settled.cards.find((c) => c.holderId === probe.holderId) ?? probe;

  const spreadFactor = hand.designW / 1920;
  const before = await sentCount(page);
  const samples = [];
  const startX = card.centre.cx, startY = card.centre.cy;
  const pressDesignX = (startX - hand.origin.x) / hand.scale;
  const pressDesignY = (startY - hand.origin.y) / hand.scale;
  await pointer.press(startX, startY);
  // Sweep up and across toward the enemy row. Long enough that the "far from the press" gate has plenty
  // of samples, and slow enough that each move produces its own send.
  for (let i = 1; i <= 14; i++) {
    const cx = startX + i * 14;
    const cy = startY - i * 48;
    await pointer.drag(cx, cy);
    await sleep(85);
    const designX = (cx - hand.origin.x) / hand.scale;
    const designY = (cy - hand.origin.y) / hand.scale;
    // Travel is measured POINTER-to-PRESS, both in the stage's own widened design space. Comparing against the
    // card's `gx` instead would mix two spaces: on a widened stage the card's game-space x is its design x minus
    // its spread shift, so the "distance from the press" came out inflated by that shift (up to ~390px at 2400)
    // and samples that were still inside the raise-fade ramp were scored as if they were past it.
    const dist = Math.hypot(designX - pressDesignX, designY - pressDesignY);
    const sent = (await readSentInputs(page, before)).filter((s) => s.coordX !== undefined).slice(-1)[0];
    if (!sent) continue;
    samples.push({
      i,
      dist: Math.round(dist),
      designX: Math.round(designX), designY: Math.round(designY),
      sentX: Math.round(sent.coordX), sentY: Math.round(sent.coordY),
      errX: Math.round(sent.coordX * spreadFactor - designX),
      errY: Math.round(sent.coordY - designY)
    });
  }
  const f = await readFocus(page, FOCUS_POSE_RISE_PX);
  const shot = `${outDir}/${combo.name}-H3-arrow.png`;
  await page.screenshot({ path: shot });

  // Cancel: return to the press point and release there, so the card goes back to the hand instead of
  // being played at whatever the arrow was pointing at.
  await pointer.drag(startX, startY);
  await sleep(180);
  await pointer.release(startX, startY);
  await sleep(600);

  // Past the raise-fade ramp (inputCapture's RAISE_DRAG_FADE_PX, 200 design px) with margin: inside it the client
  // is DELIBERATELY still carrying part of the press-time raise correction, so scoring those samples would be
  // scoring the fix rather than the bug.
  const FAR_ENOUGH_PX = 220;
  const far = samples.filter((s) => s.dist > FAR_ENOUGH_PX);
  if (far.length === 0) return bad(`the drag never produced a sample >${FAR_ENOUGH_PX} design px from the press point`, { samples, screenshot: shot });
  const worst = far.reduce((a, b) => (Math.hypot(b.errX, b.errY) > Math.hypot(a.errX, a.errY) ? b : a));
  const tolerance = 25;
  const detail = { screenshot: shot, spreadFactor, arrowsAtScreenshot: f.arrows, worst, farSamples: far };
  if (f.arrows === 0) return bad("the targeting arrow was gone by the end of the drag", detail);
  if (Math.hypot(worst.errX, worst.errY) > tolerance) {
    return bad(`sent coordinate is off the pointer by up to (${worst.errX}, ${worst.errY}) design px (tolerance ${tolerance})`, detail);
  }
  return ok(`arrow coordinate tracked the pointer within (${worst.errX}, ${worst.errY}) px over ${far.length} far samples; ${shot}`);
}

/**
 * H4 — the grabbed card must stay renderable for the WHOLE gesture. "Vanished" has meant several
 * different DOM states across rounds (element pruned, display none, collapsed to zero, translated off
 * stage), so all of them are sampled and the offending frames are reported verbatim: which frame, what
 * the style said, where the box was.
 */
async function checkH4(ctx) {
  const { page, pointer } = ctx;
  const hand = await handAtRest(page);
  if (!hand || hand.cards.length < 3) return skip("no hand to grab from");
  const card = hand.cards[Math.floor(hand.cards.length / 2)];
  if (!card.cardId) return skip("could not resolve the grabbed card's node id");

  const frames = [];
  const sample = async (phase) => {
    const v = await readCardVisibility(page, card.cardId);
    frames.push({ phase, ...v });
  };

  await pointer.press(card.centre.cx, card.centre.cy);
  await sample("press");
  for (let i = 1; i <= 10; i++) {
    await pointer.drag(card.centre.cx + i * 10, card.centre.cy - i * 50);
    await sleep(60);
    await sample(`drag${i}`);
  }
  for (let i = 0; i < 4; i++) { await sleep(60); await sample(`hold${i}`); }
  for (let i = 9; i >= 1; i--) {
    await pointer.drag(card.centre.cx + i * 10, card.centre.cy - i * 50);
    await sleep(60);
    await sample(`back${i}`);
  }
  await pointer.release(card.centre.cx, card.centre.cy);
  for (let i = 0; i < 5; i++) { await sleep(60); await sample(`release${i}`); }

  const broken = frames.filter(
    (f) => f.missing || f.display === "none" || f.visibility === "hidden" || Number(f.opacity) === 0 || !f.box || f.box.w < 4 || f.box.h < 4 || !f.onStage
  );
  await sleep(400);
  if (broken.length === 0) return ok(`${frames.length} frames, the grabbed card stayed drawn throughout`);
  return bad(`the grabbed card was not renderable on ${broken.length}/${frames.length} sampled frames`, {
    cardId: card.cardId,
    brokenFrames: broken.slice(0, 24),
    firstGoodFrame: frames.find((f) => !broken.includes(f)) ?? null
  });
}

/**
 * H5 — a press near the TOP edge of a raised card must start a grab. This is the band whose un-mapped
 * game point used to land above the card in empty board, so the press reached nothing and the card was
 * never picked up. "Grab engaged" is read from the game's own consequences (the hand drops its raise
 * and/or a drag is active and/or a targeting arrow came up), never from the client's intent.
 */
async function checkH5(ctx) {
  const { page, pointer } = ctx;
  const hand = await handAtRest(page);
  if (!hand || hand.cards.length < 3) return skip("no hand to grab from");
  const picks = [hand.cards[1], hand.cards[Math.floor(hand.cards.length / 2)], hand.cards[hand.cards.length - 2]].filter((c) => c.top.onStage !== false);
  if (picks.length === 0) return skip("no card's top band is on stage");
  const failures = [];
  for (const c of picks) {
    await pointer.press(c.top.cx, c.top.cy);
    let engaged = false;
    const trace = [];
    for (let i = 1; i <= 6; i++) {
      await pointer.drag(c.top.cx, c.top.cy - i * 55);
      await sleep(80);
      const f = await readFocus(page, FOCUS_POSE_RISE_PX);
      trace.push({ i, lift: f.lift, dragging: f.dragging, arrows: f.arrows });
      if (f.dragging || f.arrows > 0 || f.lift === 0) engaged = true;
    }
    await pointer.drag(c.top.cx, c.top.cy);
    await sleep(140);
    await pointer.release(c.top.cx, c.top.cy);
    await sleep(500);
    if (!engaged) failures.push({ card: c.index, holder: c.holderId, pressClient: [Math.round(c.top.cx), Math.round(c.top.cy)], pressDesign: [Math.round(c.top.gx), Math.round(c.top.gy)], trace });
  }
  if (failures.length === 0) return ok(`${picks.length} top-edge presses all engaged a grab`);
  return bad(`${failures.length}/${picks.length} top-edge presses never engaged a grab`, { failures });
}

/**
 * H6 — corner, edge and ART-OVERHANG taps must resolve to a card the finger is plainly aiming at, never
 * a distant neighbour and never nothing.
 *
 * The overhang samples sit just OUTSIDE the oriented hit box, on the frame/banner/border art that
 * overhangs it — the exact class of tap that used to resolve 119px above the card into empty board. A
 * point out there is on no hit box at all, so the requirement is deliberately weaker than H1's and
 * still says everything the bug report said: the focus must be one of the TWO NEAREST cards (by
 * penetration into their own local frame), and it must not be null. Which of the two nearest wins is a
 * tie-break; "the card 1.4 pitches away" and "nothing" are not.
 *
 * The corner/edge samples are inside the hit box, so they carry H1's strict rule.
 */
async function checkH6(ctx) {
  const { page, pointer } = ctx;
  const hand = await handAtRest(page);
  if (!hand || hand.cards.length < 4) return skip("no hand to sample corners on");
  const picks = [hand.cards[1], hand.cards[Math.floor(hand.cards.length / 2)], hand.cards[hand.cards.length - 2]];
  const plan = [];
  for (const c of picks) {
    for (const key of ["topLeft", "topRight", "leftEdge", "rightEdge", "overhangTop"]) {
      plan.push({ label: `card${c.index}.${key}`, holders: [c.holderId], key });
    }
  }
  const failures = [];
  let inside = 0;
  let overhang = 0;
  for (const { label, holders, key } of plan) {
    const pt = await livePoint(page, holders, key);
    if (pt === null || pt.onStage === false) continue;
    const where = await classifyPoint(page, pt.gx, pt.gy);
    const isOverhang = where.containing.length === 0;
    // Far outside every card (a stray point, e.g. an outer card's overhang over open board) — no claim.
    if (isOverhang && (where.nearestPenetration === null || where.nearestPenetration > 60)) continue;
    if (isOverhang) overhang++; else inside++;
    const r = await dwellAndSample(page, pointer, pt, { settleMs: 300, windowMs: 420 });
    const allowed = isOverhang ? where.nearest : where.containing;
    if (!allowed.includes(r.settledFocus)) {
      failures.push({
        point: label,
        kind: isOverhang ? `overhang(+${where.nearestPenetration}px outside)` : where.containing.length > 1 ? "overlap" : "exclusive",
        client: [Math.round(pt.cx), Math.round(pt.cy)],
        design: [Math.round(pt.gx), Math.round(pt.gy)],
        acceptable: allowed,
        acceptableCards: isOverhang ? where.nearestIndexes : where.containingIndexes,
        penetrations: where.penetrations,
        focused: r.settledFocus,
        inputsSent: r.sent,
        sentCoords: r.sentCoords,
        timeline: compressTimeline(r.samples)
      });
    }
    await pointer.rest(hand.origin.x + hand.scale * hand.designW * 0.5, hand.origin.y + hand.scale * 220);
    await cancelArmedSelection(page, pointer);
    await awaitFanRest(page);
  }
  const evaluated = inside + overhang;
  if (evaluated === 0) return skip("no corner/overhang sample was close enough to a card to make a claim about");
  if (failures.length === 0) return ok(`${inside} corner/edge + ${overhang} art-overhang points all resolved to a card the finger was aiming at`);
  return bad(`${failures.length}/${evaluated} corner/edge/overhang points resolved to the wrong card (or to nothing)`, { failures });
}

/**
 * H7 — while a from-hand CHOICE prompt is up, the cosmetic raise must drop to zero: the prompt lays the
 * hand out its own way (selected cards lift out of the fan) and a raise on top of it both misleads the
 * player and sinks the selected cards under the focus ramp.
 */
async function checkH7(ctx) {
  const { page } = ctx;
  loadFixture("handSelect");
  await sleep(2500);
  let state = null;
  for (let i = 0; i < 24; i++) {
    state = await readFocus(page, FOCUS_POSE_RISE_PX);
    if (state.choicePrompt) break;
    await sleep(400);
  }
  if (!state || !state.choicePrompt) {
    return skip(`the hand-choice prompt never registered (choicePrompt stayed false) — last state ${JSON.stringify(state)}`);
  }
  const settle = [];
  for (let i = 0; i < 8; i++) { settle.push((await readFocus(page, FOCUS_POSE_RISE_PX)).lift); await sleep(120); }
  const raised = settle.filter((l) => l > 0);
  if (raised.length === 0) return ok(`raise dropped to 0 for the whole prompt (nominal lift is ${NOMINAL_RAISE_PX}px)`);
  return bad(`the hand stayed raised under a choice prompt (lift samples ${settle.join(",")})`, { liftSamples: settle });
}

/**
 * H8 — the confirm-tap firewall, on the screen where a mis-tap costs a run. Touch only: on a mouse the
 * two-step tap gesture (and therefore the confirm button) does not apply at all.
 *
 * Three assertions, in an order chosen so each starts from a clean slate:
 *   1. a tap in the LABEL BAND below a rest-site button's true hit box does nothing — no confirm button,
 *      no commit (the label overhangs the button by ~165px, and that band looks like part of the button);
 *   2. a tap on the button's true hit box raises the confirm button and does NOT commit;
 *   3. (best effort) on a card-reward screen, a tap inside the client's 240x338 nominal box arms the
 *      confirm button and a tap well outside it does not.
 */
async function checkH8(ctx) {
  const { page, pointer, combo } = ctx;
  if (combo.pointer !== "touch") return skip("confirm-tap is a touch-only gesture; nothing to assert for a mouse");

  loadFixture("rest");
  await sleep(3000);
  await page.waitForFunction(() => document.querySelectorAll('[data-node-type$="NRestSiteButton"]').length > 0, null, { timeout: 30000 })
    .catch(() => {});

  const rest = await page.evaluate(() => {
    const stage = document.querySelector(".mirror-stage");
    if (!stage) return null;
    const r = stage.getBoundingClientRect();
    const scale = r.width / stage.offsetWidth;
    const toClient = (b) => ({ cx: b.left + b.width / 2, cy: b.top + b.height / 2 });
    const btns = [...document.querySelectorAll('[data-node-type$="NRestSiteButton"]')].map((el) => {
      const b = el.getBoundingClientRect();
      const label = [...el.querySelectorAll("*")].find((k) => (k.getAttribute("data-node-path") || "").endsWith("/Label"));
      const lb = label ? label.getBoundingClientRect() : null;
      // The band of the label that hangs BELOW the button's own hit box: what a finger reads as "the
      // button" and the game does not.
      const overhang = lb && lb.bottom > b.bottom
        ? { left: lb.left, top: b.bottom + 8, width: lb.width, height: Math.max(8, lb.bottom - b.bottom - 12) }
        : null;
      return {
        id: el.getAttribute("data-node-id"),
        design: [Math.round((b.x - r.left) / scale), Math.round((b.y - r.top) / scale), Math.round(b.width / scale), Math.round(b.height / scale)],
        hit: toClient(b),
        overhang: overhang ? { cx: overhang.left + overhang.width / 2, cy: overhang.top + overhang.height / 2, designY: Math.round((overhang.top + overhang.height / 2 - r.top) / scale) } : null
      };
    });
    return { count: btns.length, btns };
  });
  if (!rest || rest.count === 0) return skip("no rest-site buttons in the tree — did the rest fixture load?");

  const confirmState = () =>
    page.evaluate(() => {
      const el = document.querySelector('[data-testid="mirror-confirm-button"]');
      if (!el) return { present: false, visible: false };
      const cs = getComputedStyle(el);
      const b = el.getBoundingClientRect();
      return { present: true, visible: cs.display !== "none" && b.width > 4 && b.height > 4, display: cs.display, box: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] };
    });
  const restStillOpen = () => page.evaluate(() => document.querySelectorAll('[data-node-type$="NRestSiteButton"]').length > 0);

  const findings = [];

  // (1) label-overhang band
  const withOverhang = rest.btns.find((b) => b.overhang);
  if (!withOverhang) {
    findings.push({ part: "overhang", status: SKIP, note: "no rest-site label hung below its button box" });
  } else {
    await pointer.tap(withOverhang.overhang.cx, withOverhang.overhang.cy);
    await sleep(CONFIRM_SETTLE_MS);
    const c = await confirmState();
    const open = await restStillOpen();
    findings.push({
      part: "overhang",
      status: !c.visible && open ? PASS : FAIL,
      note: `tap at design y=${withOverhang.overhang.designY} (below the button's hit box) -> confirm ${c.visible ? "APPEARED" : "stayed hidden"}, rest site ${open ? "still open" : "COMMITTED"}`,
      confirm: c
    });
  }

  // (2) the button's own hit box
  const target = rest.btns[0];
  await pointer.tap(target.hit.cx, target.hit.cy);
  await sleep(CONFIRM_SETTLE_MS);
  const c2 = await confirmState();
  const open2 = await restStillOpen();
  findings.push({
    part: "hitbox",
    status: c2.visible && open2 ? PASS : FAIL,
    note: `tap on the button (design box ${target.design.join(",")}) -> confirm ${c2.visible ? "shown" : "MISSING"}, rest site ${open2 ? "still open (not committed)" : "COMMITTED WITHOUT CONFIRM"}`,
    confirm: c2
  });

  // (3) reward card nominal box, best effort
  loadFixture("rewards");
  await sleep(3000);
  const reward = await page.evaluate((nominal) => {
    const stage = document.querySelector(".mirror-stage");
    if (!stage) return null;
    const r = stage.getBoundingClientRect();
    const scale = r.width / stage.offsetWidth;
    const rows = [...document.querySelectorAll('[data-node-type$="NRewardButton"]')].map((el) => {
      const b = el.getBoundingClientRect();
      return { cx: b.left + b.width / 2, cy: b.top + b.height / 2, text: (el.textContent || "").trim().slice(0, 30) };
    });
    const cards = [...document.querySelectorAll('[data-scene-file$="card_reward_selection_screen.tscn"] [data-node-type$="NCard"]')].map((el) => {
      const b = el.getBoundingClientRect();
      return {
        inside: { cx: b.left, cy: b.top },
        outside: { cx: b.left + (nominal.w / 2 + 90) * scale, cy: b.top }
      };
    });
    return { rows, cards, scale };
  }, REWARD_CARD_NOMINAL);

  if (!reward || reward.cards.length === 0) {
    // The `rewards` overlay lands on the reward LIST ("Loot!"), not on the card selection screen. The
    // list row is deliberately NOT confirm-gated (opening a reward screen spends nothing), so on touch
    // it is a plain two-step: tap to focus, tap to open. Retried a few times because the first tap after
    // a fixture load can land before the row is interactive.
    const row = reward && reward.rows.find((r) => /card/i.test(r.text));
    for (let attempt = 0; row && attempt < 3; attempt++) {
      await pointer.tap(row.cx, row.cy);
      await sleep(900);
      await pointer.tap(row.cx, row.cy);
      await sleep(2200);
      const opened = await page.evaluate(() => document.querySelectorAll('[data-scene-file$="card_reward_selection_screen.tscn"]').length > 0);
      if (opened) break;
    }
  }
  const reward2 = await page.evaluate((nominal) => {
    const stage = document.querySelector(".mirror-stage");
    if (!stage) return null;
    const r = stage.getBoundingClientRect();
    const scale = r.width / stage.offsetWidth;
    const cards = [...document.querySelectorAll('[data-scene-file$="card_reward_selection_screen.tscn"] [data-node-type$="NCard"]')].map((el) => {
      const b = el.getBoundingClientRect(); // the NCard root is 0x0 — its origin IS the nominal box centre
      return {
        centre: { cx: b.left, cy: b.top },
        justOutside: { cx: b.left + (nominal.w / 2 + 80) * scale, cy: b.top }
      };
    });
    return { cards, scale };
  }, REWARD_CARD_NOMINAL);

  if (!reward2 || reward2.cards.length === 0) {
    // KNOWN GAP, left as an honest SKIP rather than a fake pass. Measured Aug-25: three two-step taps
    // on the "Add a card to your deck" row leave the Loot list up — the row highlights but never opens
    // its screen for a synthetic coordinate click, the same shape as the map-point tap that had to be
    // routed as a semantic action instead. Until that is understood, the reward card's 240x338 nominal
    // hit box (which is a CLIENT MODEL, not something read off the game) stays unverified live.
    findings.push({ part: "reward", status: SKIP, note: "the card-reward selection screen never opened from the Loot list (row highlights, screen does not open for a synthetic click) — the 240x338 reward nominal stays unverified" });
  } else {
    const card = reward2.cards[0];
    await pointer.tap(card.centre.cx, card.centre.cy);
    await sleep(CONFIRM_SETTLE_MS);
    const inConfirm = await confirmState();
    findings.push({ part: "reward.inside", status: inConfirm.visible ? PASS : FAIL, note: `tap at the card origin -> confirm ${inConfirm.visible ? "armed" : "MISSING"}`, confirm: inConfirm });
    await pointer.tap(card.justOutside.cx, card.justOutside.cy);
    await sleep(CONFIRM_SETTLE_MS);
    const outConfirm = await confirmState();
    findings.push({ part: "reward.outside", status: !outConfirm.visible ? PASS : FAIL, note: `tap ${Math.round(REWARD_CARD_NOMINAL.w / 2 + 80)} design px right of the origin -> confirm ${outConfirm.visible ? "ARMED (nominal box too small / mis-placed)" : "stayed hidden"}`, confirm: outConfirm });
  }

  const failed = findings.filter((f) => f.status === FAIL);
  const skipped = findings.filter((f) => f.status === SKIP);
  if (failed.length === 0) return ok(`${findings.length - skipped.length} sub-checks passed${skipped.length ? `, ${skipped.length} skipped` : ""}: ${findings.map((f) => `${f.part}=${f.status}`).join(" ")}`);
  return bad(`${failed.length} confirm-firewall sub-check(s) failed`, { findings });
}

/**
 * H9 — a hand-card drag that is dropped back into the hand must CANCEL, and the hand must answer hover
 * again afterwards.
 *
 * THE REPORT THIS PINS (2026-08-27, from real play, mouse and phone): "drag a card at the side (e.g. the
 * 7th of 7) up onto the playable area, then drag down and release to not play → card focus stops
 * reproducing: hover or a single tap does nothing; clicking/tapping again produces a press on the game."
 *
 * WHY THE GESTURE HAS TO BE DROPPED OFF THE GRAB POINT. The game's cancel is a ZONE, not an event: while a
 * card is being targeted the game polls its own cursor and cancels the play once it comes back down into
 * the bottom band of the viewport. The mirror's cursor is whatever coordinate this client last sent — and
 * readable-hand mode draws the whole hand ~119px ABOVE where the game has it, so a drop onto the DRAWN
 * hand is a coordinate ~119px short of the game's own hand. Whether it reaches the cancel band therefore
 * depends on whether the drop pixel happens to be claimed by a raised card's drawn box (`raiseInverse`)
 * or is still inside the drag's raise-fade radius (`RAISE_DRAG_FADE_PX`, 200 design px around the grab).
 * Dropping the card back exactly where it was picked up is inside that radius and cancels; dropping it a
 * few hundred px along the fan — which is what actually happens when a player drags the outermost card up
 * and lets go — does not, and the game stays in targeting. In that state the game answers NO hover-focus
 * on the hand at all, which is the report verbatim.
 *
 * SO THE CHECK DROPS OFF THE GRAB POINT ON PURPOSE, and asserts BOTH halves, separately:
 *   1. the game really cancelled (no holder left the fan, no targeting arrow) — the state assertion;
 *   2. a hover / single tap afterwards focuses a card the pointer is on — the report's own symptom.
 * Every post-cancel probe records how many input envelopes went out and at what coordinates, because
 * "the client never sent anything" and "the game did not answer what was sent" are different bugs and
 * this check is worthless without saying which one it saw.
 */
async function checkH9(ctx) {
  const { page, pointer } = ctx;
  const hand = await handAtRest(page);
  if (!hand || hand.cards.length < 4) return skip("no hand to drag an edge card out of");
  // The OUTERMOST card of the fan, which is the one the report names. Its centre must be on stage — the
  // fan's outer cards hang below the floor at some hand sizes and a grab there measures the harness.
  const edge = [...hand.cards].reverse().find((c) => c.centre.onStage !== false);
  if (!edge) return skip("no edge card's centre is on stage to grab");

  const toClientY = (designY) => hand.origin.y + hand.scale * designY;
  const startX = edge.centre.cx;
  const startY = edge.centre.cy;
  // Up into the play area (design y 380 is well clear of the play-zone line at any grab height), then back
  // down to the fan's own band — but 260 design px along the hand, i.e. outside the raise-fade radius.
  const topY = toClientY(380);
  const dropX = startX - 260 * hand.scale;
  const dropY = startY;

  const sentBefore = await sentCount(page);
  await pointer.press(startX, startY);
  await sleep(120);
  for (let i = 1; i <= 8; i++) {
    await pointer.drag(startX, startY + ((topY - startY) * i) / 8);
    await sleep(70);
  }
  const lifted = await readFocus(page, FOCUS_POSE_RISE_PX);
  await sleep(250);
  for (let i = 7; i >= 0; i--) {
    const f = i / 8;
    await pointer.drag(startX + (dropX - startX) * (1 - f), dropY + (topY - dropY) * f);
    await sleep(70);
  }
  await sleep(150);
  await pointer.release(dropX, dropY);
  // The cancel is a game-side state change that travels back over the wire; give it the same settle a
  // fixture load gets before believing what the tree says.
  await sleep(1000);

  const gesture = (await readSentInputs(page, sentBefore))
    .filter((s) => s.coordX !== undefined)
    .map((s) => [s.kind ?? "?", Math.round(s.coordX), Math.round(s.coordY)]);
  const post = await readFocus(page, FOCUS_POSE_RISE_PX);
  const cancelled = post.arrows === 0 && !(await handOutOfFan(page));

  // …and now the symptom itself, whatever the state says: hover / tap three cards and require the game to
  // ANSWER — a focus, on a card that is still in the fan.
  //
  // Deliberately NOT "focus the right card". WHICH card a hover resolves to is H1's and H6's assertion, and
  // both of them fail on the `off` combos today for a documented reason that has nothing to do with this
  // gesture (a coordinate the per-pixel inverse sends faithfully and the game hit-tests to a neighbour). A
  // check that repeated that rule would go red for a bug it does not pin and stop meaning anything. The
  // report is "hover does nothing", and "nothing" is what this asserts against — plus the state that causes
  // it: a focus stuck on a holder the game has taken out of the hand.
  const probes = [];
  const after = await handAtRest(page);
  const picks = after && after.cards.length >= 3
    ? [after.cards[1], after.cards[Math.floor(after.cards.length / 2)], after.cards[after.cards.length - 2]]
    : [];
  for (const c of picks) {
    const pt = await livePoint(page, [c.holderId], "centre");
    if (pt === null || pt.onStage === false) continue;
    const where = await classifyPoint(page, pt.gx, pt.gy);
    if (where.containing.length === 0) continue;
    const r = await dwellAndSample(page, pointer, pt, { settleMs: 300, windowMs: 500 });
    const stillOut = await page.evaluate(
      (id) => id !== null && window.__mirrorHandRaise().holders.some((h) => h.id === id && h.localY === null),
      r.settledFocus
    );
    // The card the point is on, for the dump — a mis-target here is real information even though it is not
    // this check's verdict (see above).
    const onPoint = where.runnerUpPenetration !== null && where.runnerUpPenetration <= SEAM_TOLERANCE_LOCAL_PX && where.runnerUpHolder
      ? [...where.containing, where.runnerUpHolder]
      : where.containing;
    probes.push({
      card: c.index,
      design: [Math.round(pt.gx), Math.round(pt.gy)],
      pointIsOn: where.containing,
      focused: r.settledFocus,
      focusIsOutOfFan: stillOut,
      onTheCardItWasOn: onPoint.includes(r.settledFocus),
      answered: r.settledFocus !== null && !stillOut,
      // THE SPLIT. Envelopes on the wire for this hover/tap, and the last coordinates on it.
      inputsSent: r.sent,
      sentCoords: r.sentCoords,
      timeline: compressTimeline(r.samples)
    });
    await pointer.rest(hand.origin.x + hand.scale * hand.designW * 0.5, hand.origin.y + hand.scale * 220);
    await sleep(350);
  }
  // Leave the room as we found it for the next check, whatever this one decided.
  await cancelArmedSelection(page, pointer);
  await awaitFanRest(page);

  const dead = probes.filter((p) => !p.answered);
  const detail = {
    grabbed: { card: edge.index, holder: edge.holderId, design: [Math.round(edge.centre.gx), Math.round(edge.centre.gy)] },
    dropDesign: [Math.round((dropX - hand.origin.x) / hand.scale), Math.round((dropY - hand.origin.y) / hand.scale)],
    arrowsWhileLifted: lifted.arrows,
    cancelled,
    afterRelease: { arrows: post.arrows, lift: post.lift, dragging: post.dragging, outOfFan: post.outOfFan },
    // The whole gesture as the game saw it. The last coordinate here IS the diagnosis when `cancelled` is
    // false: compare its Y against the bottom band of the 1080 viewport.
    gestureCoords: gesture.slice(-6),
    probes
  };
  if (!cancelled) {
    const hovers = probes.length === 0
      ? "no post-drop hover landed on a card"
      : `${dead.length}/${probes.length} post-drop hovers then focused nothing they were on`;
    return bad(
      `the drop did not cancel: ${post.arrows} targeting arrow(s) up and ${post.outOfFan.length} holder(s) still out of the fan (${hovers})`,
      detail
    );
  }
  if (probes.length === 0) return skip("the drop cancelled, but no post-drop sample point landed on a card");
  if (dead.length > 0) {
    const stuck = dead.filter((p) => p.focusIsOutOfFan).length;
    return bad(
      `the drop cancelled but ${dead.length}/${probes.length} post-drop hovers went unanswered` +
        (stuck ? ` (${stuck} of them kept the focus on a holder that had left the fan)` : " (the game focused nothing)"),
      detail
    );
  }
  const misTargeted = probes.filter((p) => !p.onTheCardItWasOn).length;
  return ok(
    `the off-grab drop cancelled (no arrow, hand whole) and all ${probes.length} post-drop hovers were answered` +
      (misTargeted ? ` (${misTargeted} focused a neighbour — that is H1/H6's assertion, not this one)` : "")
  );
}

/**
 * H10 — a focus HANDOFF must move each card straight to its new pose. No card may overshoot the pose it is
 * heading for and come back.
 *
 * THE REPORT THIS PINS (2026-08-27, from real play): "focus going back and forth between cards plays a
 * transition of instantly going up then smoothly going down", and "a few frames of a card going up/down
 * more than it should".
 *
 * WHY IT NEEDS PER-FRAME SAMPLING, AND WHAT IT SAMPLES. A hand holder's drawn position is the SUM of two
 * CSS channels that are written by different code on different clocks: the `transform` the wire carries
 * (the game's own pose, a per-frame exponential lerp, sometimes replayed client-side as a tween) and the
 * `translate` readable-hand mode writes (the cosmetic lift, ramped down as the card rises — see
 * mirrorRenderer's handRaiseRamp). Each channel on its own is monotone. Their SUM is only monotone while
 * they stay in phase, and nothing in the state the other checks read can see the phase at all: `localY`,
 * `dy` and the z-lift all say the right thing on the frame they are read. So this check samples what the
 * player actually sees — `getBoundingClientRect().top` of each holder ELEMENT, every animation frame —
 * and asserts about the shape of that curve.
 *
 * THE ASSERTION. For each holder, the last samples of the sweep are its settle pose. During the 1.2s after
 * a focus change, the drawn y may approach that pose from either side, but it may NOT cross it by more
 * than OVERSHOOT_TOLERANCE_PX and come back — that crossing is precisely "the card went further than it
 * should and returned", and the same measurement catches "jumps up then eases down" (a newly focused card
 * whose curve passes its focus pose and drifts back).
 *
 * Deliberately NOT asserted: how long the motion takes, or that it is smooth. The game's own hand motion
 * is an unclamped exponential lerp read over a live wire; a slow host frame legitimately makes a big step.
 * Only the DIRECTION is a promise, and only the direction is what the report is about.
 */
const OVERSHOOT_TOLERANCE_PX = 4;

async function checkH10(ctx) {
  const { page, pointer } = ctx;
  const hand = await handAtRest(page);
  if (!hand || hand.cards.length < 4) return skip("no hand to hand focus back and forth across");
  const n = hand.cards.length;
  const a = hand.cards[Math.max(1, Math.floor(n / 2) - 1)];
  const b = hand.cards[Math.floor(n / 2)];
  const c = hand.cards[Math.min(n - 2, Math.floor(n / 2) + 1)];
  if ([a, b, c].some((x) => !x || x.centre.onStage === false)) return skip("the three middle cards are not all on stage");

  // The sampler runs in the PAGE on requestAnimationFrame: one rect + one computed style per holder per
  // frame. Reading it from node instead would sample at the harness's own cadence and miss exactly the
  // two-or-three-frame excursion the report is about.
  await page.evaluate(() => {
    window.__poseTrace = [];
    window.__poseStop = false;
    const tick = () => {
      if (window.__poseStop) return;
      // The GLOBAL lift rides every frame too: when it drops to 0 (a drag, an arrow, a dimmed hand) the whole
      // fan falls ~119px at once, which is a different excursion from one card's lift running late — and a
      // failure that cannot tell them apart is a failure nobody can act on.
      const row = { t: Math.round(performance.now() * 10) / 10, lift: window.__mirrorHandRaise().liftPx, h: [] };
      for (const el of document.querySelectorAll('[data-node-type$="NHandCardHolder"]')) {
        const box = el.getBoundingClientRect();
        row.h.push({
          id: el.getAttribute("data-node-id"),
          // The holder element is zero-size; its rect origin IS its drawn placement, transform + translate
          // composed by the browser — which is the only honest "where the player sees this card".
          y: Math.round(box.top * 10) / 10,
          tr: getComputedStyle(el).translate,
          z: el.style.zIndex || ""
        });
      }
      window.__poseTrace.push(row);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // Back and forth across three adjacent cards: every step is a handoff, and the repeats put a card back
  // under the pointer while its own return from the previous focus may still be in flight (which is the
  // "focus going back and forth" the report names).
  // 1.4s per point is not padding: the game's return-to-rest is an exponential lerp that takes ~700ms, and
  // the scoring below needs a window where the card is DEMONSTRABLY settled and still unfocused. At 900ms the
  // next handoff landed inside that window and every interesting event scored as "unscorable".
  for (const card of [a, b, c, b, a, b]) {
    const pt = await livePoint(page, [card.holderId], "centre");
    if (pt === null) continue;
    if (pointer.kind === "mouse") await pointer.dwellStart(pt.cx, pt.cy);
    else await pointer.tap(pt.cx, pt.cy);
    await sleep(1400);
  }
  const trace = await page.evaluate(() => {
    window.__poseStop = true;
    return window.__poseTrace;
  });
  await pointer.rest(hand.origin.x + hand.scale * hand.designW * 0.5, hand.origin.y + hand.scale * 220);
  await cancelArmedSelection(page, pointer);
  await awaitFanRest(page);

  if (trace.length < 30) return skip(`the page produced only ${trace.length} animation frames — nothing to measure a curve on`);

  // Per holder: its samples in order.
  const byId = new Map();
  for (const row of trace) {
    for (const h of row.h) {
      if (!byId.has(h.id)) byId.set(h.id, []);
      byId.get(h.id).push({ t: row.t, y: h.y, tr: h.tr, z: h.z, lift: row.lift });
    }
  }
  // Everything below is in DESIGN px: a wide combo's stage is scaled, and a tolerance in CSS px would mean a
  // different thing per combo.
  const px = (v) => Math.round((v / hand.scale) * 10) / 10;
  const median = (values) => {
    const s = [...values].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  const fmt = (s, t0) => `${Math.round(s.t - t0)}ms:${px(s.y)}${s.tr && s.tr !== "none" ? `[${s.tr}]` : ""}${s.z === "1" ? "*" : ""}${s.lift === 0 ? "{lift0}" : ""}`;
  const failures = [];
  let handoffs = 0;
  let unscorable = 0;
  for (const [id, samples] of byId) {
    for (let i = 1; i < samples.length; i++) {
      // A focus CHANGE on this holder, in either direction: the z-lift is the game's own earliest signal, and
      // both directions are in the report ("instantly up then smoothly down" is the gain, "further than it
      // should" the return).
      if ((samples[i].z === "1") === (samples[i - 1].z === "1")) continue;
      handoffs++;
      const t0 = samples[i].t;
      const move = samples.filter((s) => s.t >= t0 && s.t <= t0 + 800);
      const after = samples.filter((s) => s.t > t0 + 850 && s.t <= t0 + 1350);
      // THE TARGET IS READ LOCALLY, per handoff, not once per sweep. A holder's resting pose and its focus
      // pose are both "settled" states it visits repeatedly, so a single sweep-wide settle would score half
      // the events against the wrong pose. Skipped when the focus flips again inside the window (nothing
      // stable to compare against) or when the holder simply did not move.
      const held = samples.filter((s) => s.t >= t0 && s.t <= t0 + 1350);
      if (after.length < 3 || held.some((s) => (s.z === "1") !== (samples[i].z === "1"))) { unscorable++; continue; }
      const target = median(after.map((s) => s.y));
      const start = samples[i - 1].y;
      const travel = target - start;
      if (Math.abs(travel) < 8 * hand.scale) { unscorable++; continue; }
      const direction = travel > 0 ? 1 : -1;
      // How far PAST the pose it was heading for the card was ever drawn, in the direction it was travelling.
      let worst = null;
      for (const s of move) {
        const past = (s.y - target) * direction;
        if (past > OVERSHOOT_TOLERANCE_PX * hand.scale && (worst === null || past > worst.past)) {
          worst = { ...s, past };
        }
      }
      if (worst === null) continue;
      // …and it only counts as an EXCURSION if the card came back: a curve that ends past the target simply
      // settled somewhere else (a re-layout), which is not what the report is about.
      const returned = samples.some((s) => s.t > worst.t && s.t <= t0 + 1350 && (s.y - target) * direction <= OVERSHOOT_TOLERANCE_PX * hand.scale);
      if (!returned) continue;
      failures.push({
        holder: id,
        direction: direction > 0 ? "returning to rest" : "rising to focus",
        atMs: Math.round(worst.t - t0),
        targetY: px(target),
        peakY: px(worst.y),
        overshootPx: px(worst.past),
        // The two channels at the excursion, so a reader can see WHICH one was late without a second run:
        // `tr` is the cosmetic lift the renderer had applied, and the drawn y is that lift plus the streamed
        // pose. A lift that still reads the OLD value while the drawn y has moved is the lift running late.
        liftAtPeak: worst.tr,
        // The global lift over the whole excursion. `119,119,…` means one card's own lift channel drifted out
        // of phase with its pose; a `0` in here means the mode itself stood down and took the fan with it.
        globalLift: [...new Set(samples.filter((s) => s.t >= t0 && s.t <= worst.t + 200).map((s) => s.lift))],
        // Two slices, because the interesting frames are not always the first ones: the departure, and the
        // frames around the peak itself.
        curve: samples.filter((s) => s.t >= t0 && s.t <= worst.t + 300).slice(0, 8).map((s) => fmt(s, t0)),
        atPeak: samples
          .filter((s) => s.t >= worst.t - 200 && s.t <= worst.t + 400)
          .slice(0, 12)
          .map((s) => fmt(s, t0))
      });
    }
  }
  if (handoffs === 0) return skip("no focus change landed during the sweep — nothing to measure");
  const scored = handoffs - unscorable;
  if (scored === 0) return skip(`${handoffs} focus changes, none of them with a stable pose to score against`);
  if (failures.length === 0) {
    return ok(`${scored} scored focus changes over ${trace.length} frames, every card approached its pose without overshooting it`);
  }
  const worst = failures.reduce((x, y) => (y.overshootPx > x.overshootPx ? y : x));
  return bad(
    `${failures.length}/${scored} focus changes drew a card past the pose it was heading for and back (worst ${worst.overshootPx} design px, ${worst.atMs}ms in, while ${worst.direction})`,
    { failures: failures.slice(0, 8) }
  );
}


// ---------------------------------------------------------------------------------------------------
// H11 — LANDING PARITY. The one check that runs on either stage.
// ---------------------------------------------------------------------------------------------------
//
// THE REPORT. On `?stage=canvas` with the wide-screen stretch on, the client's predicted hand motion ends
// somewhere other than where the game has the card, so the cards jump when they stop moving: focusing a card does
// not push its neighbours to the right places, selecting one does not re-lay-out the rest, and cancelling the
// selection lands neither the returned card nor the others.
//
// THE MEASUREMENT. `window.__mirrorHandPoses()` publishes, per holder, where the GAME has it (the streamed
// composition, blind to every client-side override) and where the client DRAWS it (measured off the frame). At
// REST those two must differ by exactly the two deliberate client-side terms: the wide-screen squeeze shift and
// the readable-hand lift. `landingDrift` re-derives the shift from the game pose rather than believing the
// renderer's own number — a wrong shift IS the defect, so subtracting the reported one back out would score every
// wrong shift as perfect.
//
// FOUR RESTING STATES, which are the reported cases plus the baseline they all start from: the untouched fan, a
// focused card (its neighbours pushed), the hand with one card selected out of it, and the hand after that
// selection is cancelled. Each is measured only once the fan has STOPPED (`awaitPoseRest`) — mid-motion
// disagreement is H10's question, not this one.
const LANDING_TOLERANCE_PX = 1.5;

/** The shared seam, verbatim. Null when the page has no hand (or is an older build without the seam). */
const readPoses = (page) =>
  page.evaluate(() => (window.__mirrorHandPoses ? window.__mirrorHandPoses() : null));

/**
 * Wait for the GAME's own hand poses to stop changing.
 *
 * The seam's twin of `awaitFanRest`, and it exists because that one reads `__mirrorHandRaise().holders[].localY`
 * plus `[data-node-type$=NHandCardHolder]` elements — neither of which the canvas stage has. It waits on the
 * game's poses (`mGame`), not the drawn ones: the drawn pose is the thing under test, and a wait that waited for
 * IT to settle would happily return in a state the client had settled into wrongly.
 */
async function awaitPoseRest(page, { timeoutMs = 3000, requireWhole = true } = {}) {
  const deadline = now() + timeoutMs;
  let previous = null;
  let quiet = 0;
  while (now() < deadline) {
    const pose = await page.evaluate(() => {
      const report = window.__mirrorHandPoses ? window.__mirrorHandPoses() : null;
      if (!report) return null;
      return {
        ys: report.holders.map((h) => Math.round(h.mGame[5])),
        xs: report.holders.map((h) => Math.round(h.mGame[4])),
        whole: report.holders.every((h) => h.inFan),
        live: report.holders.some((h) => h.channelLive)
      };
    });
    if (!pose) return false;
    const same =
      previous &&
      previous.ys.length === pose.ys.length &&
      previous.ys.every((y, i) => Math.abs(y - pose.ys[i]) <= 1) &&
      previous.xs.every((x, i) => Math.abs(x - pose.xs[i]) <= 1);
    // A live channel means the client is still replaying something, and its endpoint is where it is going —
    // reading a landing while one is running would score the middle of the motion.
    if (same && !pose.live && (!requireWhole || pose.whole)) {
      if (++quiet >= 2) return true;
    } else {
      quiet = 0;
    }
    previous = pose;
    await sleep(90);
  }
  return false;
}

/** Score one resting state: the worst |drawn − game·field| over the holders that are still in the fan. */
async function scoreLanding(page, label, { includeOutOfFan = false } = {}) {
  const report = await readPoses(page);
  if (!report || report.holders.length === 0) {
    return { label, rows: [], worstPx: null, note: "no hand on screen" };
  }
  const rows = report.holders
    .filter((h) => includeOutOfFan || h.inFan)
    .map((h) => {
      // `handPoseProbe.landingDrift`, restated for the page: mode 1 (a hand holder — a zero-size positioner
      // under a pass-through container) claims the ORIGIN field, so its drawn x is `gameX · F` and the shift is
      // re-derivable here. Any other mode takes its shift from something that is not its own x, and the
      // renderer's number is all there is.
      const F = report.spreadFactor;
      const clamped = Math.max(0, Math.min(1920, h.mGame[4]));
      const shift = h.fieldMode === 1 ? clamped * (F - 1) : h.spreadDx;
      const dx = h.mDrawn[4] - (h.mGame[4] + shift);
      const dy = h.mDrawn[5] - (h.mGame[5] + h.raiseDy);
      return {
        id: h.id,
        name: h.name,
        inFan: h.inFan,
        fieldMode: h.fieldMode,
        gameX: Math.round(h.mGame[4] * 10) / 10,
        gameY: Math.round(h.mGame[5] * 10) / 10,
        drawnX: Math.round(h.mDrawn[4] * 10) / 10,
        drawnY: Math.round(h.mDrawn[5] * 10) / 10,
        spreadDx: Math.round(h.spreadDx * 10) / 10,
        raiseDy: h.raiseDy,
        dx: Math.round(dx * 100) / 100,
        dy: Math.round(dy * 100) / 100,
        distPx: Math.round(Math.hypot(dx, dy) * 100) / 100
      };
    });
  const worst = rows.reduce((a, b) => (b.distPx > (a?.distPx ?? -1) ? b : a), null);
  return { label, stage: report.stage, spreadFactor: report.spreadFactor, rows, worstPx: worst?.distPx ?? null, worst };
}


/**
 * PHASE 2 of H11 — THE JUMP ITSELF.
 *
 * Phase 1 measures RESTING states, and a resting state is measured AFTER the correction: if the client's
 * predicted motion ends in the wrong place and the next streamed pose yanks the card into line, the fan is
 * perfect by the time anything has settled. That is exactly the reported experience — "they don't end where they
 * should, so when they stop moving they suddenly jump to where they should" — so the defect lives in the frame
 * the correction lands on, not in the frames either side of it.
 *
 * So this samples the shared seam ON EVERY ANIMATION FRAME (in the page, at the display's cadence — reading it
 * from node would sample at the harness's own rate and miss a two-frame event) and looks for one shape:
 *
 *     a holder's DRAWN pose goes quiet — two consecutive frames under `QUIET_PX` — and then moves more than
 *     `JUMP_PX` in a single frame, while the GAME's own pose for that holder did not move to match.
 *
 * The last clause is what separates a mispredicted landing from ordinary gameplay: when the game teleports a card
 * (a focus is a teleport, and so is a draw) the streamed pose jumps too and the client is right to follow. A jump
 * the producer did not ask for in that frame is the client correcting itself, and the size of the correction is
 * how wrong the prediction was.
 */
const CORRECTION_PX = 2;
/** How long after a hand-off a re-placement still counts as the correction of THAT landing. */
const CORRECTION_WINDOW_MS = 400;
/** …and how much the GAME may move the card in that window before the re-placement is its motion, not a fix. */
const GAME_MOVED_PX = 2;

async function startLandingTrace(page) {
  await page.evaluate(() => {
    window.__landTrace = [];
    window.__landStop = false;
    const tick = () => {
      if (window.__landStop) return;
      const report = window.__mirrorHandPoses ? window.__mirrorHandPoses() : null;
      if (report) {
        window.__landTrace.push({
          t: Math.round(performance.now() * 10) / 10,
          f: report.spreadFactor,
          h: report.holders.map((h) => ({
            id: h.id,
            name: h.name,
            fm: h.fieldMode,
            dx: h.mDrawn[4],
            dy: h.mDrawn[5],
            gx: h.mGame[4],
            gy: h.mGame[5],
            sd: h.spreadDx,
            rd: h.raiseDy,
            live: h.channelLive,
            fan: h.inFan
          }))
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopLandingTrace(page) {
  return page.evaluate(() => {
    window.__landStop = true;
    return window.__landTrace ?? [];
  });
}

/**
 * THE CORRECTION: where the client's own replay put the card, against where the card ended up.
 *
 * This is deliberately NOT a per-frame "did it jump" test, and the reason is measured rather than assumed: this
 * headless browser paints at about 11 fps (SwiftShader, a 2400x1080 canvas; no launch flag moves it, and the
 * mirror's canvas stage computes every animation frame itself, so the RENDERER is stepping at that rate too). At
 * ~90ms between samples an ordinary motion ONSET is indistinguishable from a correction — both read as "two quiet
 * frames, then a big step" — and a gate built on that reports the environment.
 *
 * What IS frame-rate independent is the pair of poses either side of the hand-off:
 *
 *   * the LANDING — the drawn pose on the last frame a client-side channel owned this holder (`channelLive`), i.e.
 *     where the prediction ended;
 *   * the SETTLED pose — the drawn pose once the holder has gone quiet afterwards, which is the game's own
 *     placement (the producer's suppression window has closed by then and the walk re-derives from what it
 *     streams).
 *
 * Their difference IS the jump the player sees, whatever cadence it was drawn at, and it is exactly the number
 * the offline `handLanding.spec.ts` scores between its beats 2 and 3. A holder the client never predicted (the
 * game streamed every pose) has no landing and is not scored — there was nothing to get wrong.
 */
function scoreCorrections(trace) {
  const byHolder = new Map();
  for (const frame of trace) {
    for (const h of frame.h) {
      let rows = byHolder.get(h.id);
      if (!rows) {
        rows = [];
        byHolder.set(h.id, rows);
      }
      rows.push({ t: frame.t, f: frame.f, ...h });
    }
  }
  const corrections = [];
  // Landings the producer's own word CONFIRMED (see the `confirmed` test). Counted rather than dropped silently:
  // "0 predicted landings" would otherwise read as "nothing was measured" when it means "every prediction was
  // right", and those are opposite results.
  let confirmedLandings = 0;
  for (const [id, rows] of byHolder) {
    for (let i = 1; i < rows.length; i++) {
      // The hand-off: a channel owned the holder on the previous frame and does not on this one.
      if (!(rows[i - 1].live && !rows[i].live)) continue;
      const landing = rows[i - 1];
      // Where it comes to rest afterwards — WITHIN A SHORT WINDOW, and only while the GAME is not itself moving
      // the card. Both bounds are corrections to a first version that scored the game's own motion as a
      // mispredict: a selected card is parked by the game over the next second and a half, and an unbounded
      // search happily called that 42px of "correction". The jump this is hunting lands within a frame or two of
      // the pin lifting, so a window that spans a whole gameplay beat is measuring the wrong thing.
      let end = i;
      for (let j = i; j < rows.length && rows[j].t - landing.t <= CORRECTION_WINDOW_MS; j++) {
        if (rows[j].live) break;
        end = j;
      }
      const settled = rows[end];
      // The producer moved the card itself between the two samples: the client is right to follow, and what it
      // followed is not a correction of its own landing.
      if (Math.hypot(settled.gx - landing.gx, settled.gy - landing.gy) > GAME_MOVED_PX) continue;
      // …AND THE LANDING WAS CONFIRMED, which is the same idea read the other way round. The seam's game pose and
      // its drawn pose are sampled together, but the producer's word about a tweened node arrives on ITS own
      // schedule — a delta later, which on this ~11fps box is a quarter of a second. So a client that predicted
      // CORRECTLY looks momentarily wrong: it is already drawing the pose the producer is about to state. If any
      // game pose in the window around the hand-off puts the card where the client landed it, the prediction was
      // right and the re-placement is the producer catching up, not the client correcting itself.
      //
      // The comparison is the same one `handPoseProbe.landingDrift` makes — the field RE-DERIVED at the game's own
      // x for an origin claimer (`fieldMode === 1`, which every hand holder is), the node's reported shift
      // otherwise — so a wrong wide-screen shift can never be "confirmed" by it.
      const confirmed = rows.slice(Math.max(0, i - 2), Math.min(rows.length, end + 3)).some((row) => {
        const f = row.f ?? 1;
        const shift = landing.fm === 1 ? Math.min(Math.max(row.gx, 0), 1920) * (f - 1) : landing.sd;
        return (
          Math.abs(landing.dx - (row.gx + shift)) <= CORRECTION_PX &&
          Math.abs(landing.dy - (row.gy + landing.rd)) <= CORRECTION_PX
        );
      });
      if (confirmed) {
        confirmedLandings++;
        continue;
      }
      const dx = settled.dx - landing.dx;
      const dy = settled.dy - landing.dy;
      const distPx = Math.hypot(dx, dy);
      // THE MOTION'S OWN LAST STEP, which is what a correction has to be measured against rather than against a
      // fixed number of pixels. Every curve the producer sends is an ease-OUT: it decelerates into its endpoint,
      // so the final step is the SMALLEST of the motion. A re-placement bigger than the step before it is
      // therefore something the curve never asked for — the client's landing being overruled. A smaller one is
      // just the tail of an animation drawn at whatever cadence this device manages (here: ~11 fps headless,
      // where the last 3px of an Expo tail arrive in one frame and mean nothing).
      const prior = rows[i - 2];
      const lastStepPx = prior ? Math.hypot(landing.dx - prior.dx, landing.dy - prior.dy) : 0;
      // THE CLIENT'S OWN DELIBERATE OFFSET, subtracted before the verdict. The readable-hand lift is released the
      // moment a card is taken out of the hand — the whole fan lowers by 119px, on purpose, with the game's poses
      // unchanged — and that lands on exactly the frame a channel hands off. Scored raw, every commit reports two
      // 119px "jumps" (the two cards whose channels happened to release then) and buries the one correction that
      // is real. So the raise DELTA is removed and the residual is what is judged; the raw correction stays in the
      // record, because a lift that steps instead of easing is a defect too — just not this check's.
      const raiseDeltaPx = settled.rd - landing.rd;
      const residualPx = Math.hypot(dx, dy - raiseDeltaPx);
      corrections.push({
        id,
        name: landing.name,
        atMs: rows[i].t,
        settledAfterMs: Math.round(settled.t - landing.t),
        correctionPx: Math.round(distPx * 100) / 100,
        residualPx: Math.round(residualPx * 100) / 100,
        raiseDeltaPx: Math.round(raiseDeltaPx * 100) / 100,
        lastStepPx: Math.round(lastStepPx * 100) / 100,
        /** The correction is a JUMP only if the motion did not just carry on into it — see `lastStepPx`. */
        overruled: residualPx > Math.max(CORRECTION_PX, lastStepPx),
        landedAt: [Math.round(landing.dx * 10) / 10, Math.round(landing.dy * 10) / 10],
        settledAt: [Math.round(settled.dx * 10) / 10, Math.round(settled.dy * 10) / 10],
        // The two client-side terms at the landing, so a correction can be attributed: an x-only correction of
        // `(settledGameX − landingGameX)·(F − 1)` is the wide-screen field claimed at the wrong pose; a y-only one
        // is the readable-hand lift; a correction with the game pose unchanged is a pure mispredicted endpoint.
        gameAtLanding: [Math.round(landing.gx * 10) / 10, Math.round(landing.gy * 10) / 10],
        gameAtSettle: [Math.round(settled.gx * 10) / 10, Math.round(settled.gy * 10) / 10],
        spreadDxLanding: Math.round(landing.sd * 10) / 10,
        spreadDxSettled: Math.round(settled.sd * 10) / 10,
        raiseDyLanding: landing.rd,
        raiseDySettled: settled.rd,
        inFan: settled.fan,
        // The frames either side of the hand-off, for this holder alone. A jump you cannot read the run-up to is a
        // jump you cannot attribute: this is what says whether the client eased into its wrong answer or stepped
        // there, and what the game was streaming while it did.
        around: rows.slice(Math.max(0, i - 5), Math.min(rows.length, end + 3)).map((r) => ({
          t: r.t,
          drawn: [Math.round(r.dx * 10) / 10, Math.round(r.dy * 10) / 10],
          game: [Math.round(r.gx * 10) / 10, Math.round(r.gy * 10) / 10],
          sd: Math.round(r.sd * 10) / 10,
          rd: r.rd,
          live: r.live,
          fan: r.fan
        }))
      });
    }
  }
  // Worst RESIDUAL first — the raw correction is reported, but the ranking has to be by what is unexplained, or a
  // 119px lift release outranks the mispredicted landing hiding behind it.
  corrections.sort((a, b) => b.residualPx - a.residualPx);
  corrections.confirmed = confirmedLandings;
  return corrections;
}

/**
 * THE REPORTED GESTURES, ONCE — focus, hand-off, select, cancel, with a rest wait after each.
 *
 * Extracted so H11 (which scores the hand at each of those rests) and H12 (which scores what the client PREDICTED
 * on the way there) drive exactly the same sequence. Two copies of it would be two different gestures wearing one
 * name, and every conclusion drawn by comparing the two checks would be about the difference between them.
 *
 * `onRest(label, opts)` is called at each resting state, in order, and its return values come back in `states`.
 * Returns a `skip(...)` verdict instead when there is no hand to gesture at.
 */
async function handGestureTour(ctx, onRest) {
  const { page, pointer } = ctx;
  const states = [];

  await awaitPoseRest(page);
  const hand = await handAtRest(page);
  if (!hand || hand.cards.length < 3) {
    return { skipped: skip(`need a hand of 3+ to measure a re-layout; got ${hand ? hand.cards.length : 0}`) };
  }
  // The two cards the gesture uses: an inner one (so it HAS neighbours on both sides to push) and its right
  // neighbour, for the handoff.
  const cards = [...hand.cards].sort((a, b) => a.centre.gx - b.centre.gx);
  const inner = cards[Math.floor(cards.length / 2)];
  const next = cards[Math.min(cards.length - 1, Math.floor(cards.length / 2) + 1)];
  if (!inner.centre.onStage) {
    return { skipped: skip("the middle card's centre is off stage — nothing safe to aim at") };
  }

  // 1. THE RESTING FAN — the baseline. If this one is wrong nothing after it means anything.
  states.push(await onRest("rest"));
  // …and from here every frame is sampled, so the CORRECTION FRAMES between the resting states are visible too.
  await startLandingTrace(page);

  // 2. FOCUS — dwell on the middle card and let its neighbours be pushed apart.
  await pointer.dwellStart(inner.centre.cx, inner.centre.cy);
  await sleep(FOCUS_SETTLE_MS);
  await awaitPoseRest(page);
  states.push(await onRest("focus"));

  // 3. HANDOFF — the neighbour takes the focus while the first card slides home. Same question, different
  //    starting state: this is the transition the DOM arm's H10 found two defects in.
  if (next !== inner && next.centre.onStage) {
    await pointer.dwellEnd(inner.centre.cx, inner.centre.cy);
    await pointer.dwellStart(next.centre.cx, next.centre.cy);
    await sleep(FOCUS_SETTLE_MS);
    await awaitPoseRest(page);
    states.push(await onRest("handoff"));
    await pointer.dwellEnd(next.centre.cx, next.centre.cy);
  } else {
    await pointer.dwellEnd(inner.centre.cx, inner.centre.cy);
  }
  await awaitPoseRest(page);

  // A COMMIT is a tap on touch and a click on a mouse — the pointer abstraction has `tap` only on the touch leg,
  // because it is the only leg where a tap is a distinct gesture rather than press-then-release.
  const commit = async (x, y) => {
    if (pointer.tap) {
      await pointer.tap(x, y);
      return;
    }
    await pointer.press(x, y);
    await sleep(40);
    await pointer.release(x, y);
  };

  // 4. SELECT — commit the card. The game reparents its holder onto the hand root and re-lays-out the rest as a
  //    hand with one card fewer, which is the second reported case. The out-of-fan holder is measured too (it is
  //    drawn at the game's own pose and must not drift either), but the fan must be WHOLE-less to settle, so the
  //    rest wait does not require it.
  await commit(inner.centre.cx, inner.centre.cy);
  await sleep(FOCUS_SETTLE_MS);
  await awaitPoseRest(page, { requireWhole: false });
  states.push(await onRest("selected", { includeOutOfFan: true }));

  // 5. CANCEL — the third reported case: the card comes home and the whole fan is re-laid-out around it.
  await cancelArmedSelection(page, pointer);
  await awaitPoseRest(page);
  states.push(await onRest("cancelled"));

  return { states };
}

/**
 * H11 — do the cards END where the game has them, in each of the four resting states?
 *
 * Written against the shared seam alone, so it runs on the DOM stage and the canvas stage with the same code and
 * the same numbers. That is the point: the two arms of a comparison must not be two measurements.
 *
 * READ THIS TOGETHER WITH H12, and know what it CANNOT catch. Every state here is scored after `awaitPoseRest`,
 * i.e. after the producer's settle re-emit has been adopted — and adopting it is what makes `drawn == game` true.
 * A client that eased to the wrong place and was rescued by that re-emit passes this check by construction. The
 * jump detector below is the partial answer (it sees the rescue happen); H12 is the whole one (it reads the
 * decision itself, off `window.__mirrorLandingLog()`).
 */
async function checkH11(ctx) {
  const { page } = ctx;
  if (!(await readPoses(page))) {
    return skip("this page has no __mirrorHandPoses seam (older build?)");
  }
  const tour = await handGestureTour(ctx, (label, opts) => scoreLanding(page, label, opts));
  if (tour.skipped) return tour.skipped;
  const states = tour.states;
  const fail = (why, extra) => bad(why, { states, ...extra });

  const trace = await stopLandingTrace(page);
  const corrections = scoreCorrections(trace);
  const jumps = corrections.filter((c) => c.overruled);

  const measured = states.filter((s) => s.worstPx !== null);
  if (measured.length === 0) return skip("no resting state produced a hand to measure");
  const offenders = measured.filter((s) => s.worstPx > LANDING_TOLERANCE_PX);
  if (offenders.length === 0 && jumps.length === 0) {
    const worst = measured.reduce((a, b) => (b.worstPx > a.worstPx ? b : a));
    return ok(
      `${measured.length} resting states over ${trace.length} frames: every card drawn where the game has it ` +
        `(worst ${worst.worstPx}px, ${worst.label}/${worst.worst.name}); ` +
        `${corrections.length} predicted landings, none overruled (worst residual ` +
        `${corrections.length > 0 ? corrections[0].residualPx : 0}px, inside its own last step); ` +
        `${corrections.confirmed} more the producer confirmed outright`
    );
  }
  if (offenders.length === 0) {
    const worst = jumps[0];
    return fail(
      `${jumps.length}/${corrections.length} predicted landings ended somewhere the card then jumped from ` +
        `(worst ${worst.residualPx} design px unexplained: ${worst.name} landed at ${worst.landedAt}, settled at ` +
        `${worst.settledAt}; raw ${worst.correctionPx}px, of which ${worst.raiseDeltaPx}px is the raise standing aside)`,
      { jumps: jumps.slice(0, 12), landings: corrections.length, frames: trace.length }
    );
  }
  const worst = offenders.reduce((a, b) => (b.worstPx > a.worstPx ? b : a));
  return fail(
    `${offenders.length}/${measured.length} resting states drew a card away from the game's pose ` +
      `(worst ${worst.worstPx} design px: ${worst.label}, ${worst.worst.name}, dx ${worst.worst.dx} dy ${worst.worst.dy})` +
      (jumps.length > 0 ? `; ${jumps.length} corrected landing(s), worst ${jumps[0].residualPx}px` : ""),
    {
      offenders: offenders.map((s) => ({ label: s.label, worstPx: s.worstPx, rows: s.rows })),
      jumps: jumps.slice(0, 12),
      // …and every frame of the WORST offender's own holder, for the same reason the jumps carry `around`: a
      // resting pose that is wrong was drawn wrong at some identifiable moment, and the run-up is where that is.
      worstTrace: trace
        .map((f) => ({ t: f.t, h: f.h.find((h) => h.id === worst.worst.id) }))
        .filter((r) => r.h)
        .map((r) => ({
          t: r.t,
          drawn: [Math.round(r.h.dx * 10) / 10, Math.round(r.h.dy * 10) / 10],
          game: [Math.round(r.h.gx * 10) / 10, Math.round(r.h.gy * 10) / 10],
          rd: r.h.rd,
          live: r.h.live,
          fan: r.h.fan
        }))
    }
  );
}

// ---------------------------------------------------------------------------------------------------
// H12 — THE PREDICTION. Where the client DECIDED to send each card, against where the card ended up.
// ---------------------------------------------------------------------------------------------------
//
// WHY H11 IS NOT THIS. H11 scores the hand at rest, which is after the producer's settle re-emit has been adopted
// — and adopting it is precisely what overwrites the client's answer with the game's. `drawn == game` at rest is
// close to true by construction, so H11 can only catch a client that fails to ADOPT afterwards. It is blind to a
// client that predicted the wrong place and was rescued.
//
// So this one asks the renderer what it decided, at the moment it decided it. `window.__mirrorLandingLog()` (see
// `frontend/src/mirror/landingLog.ts`) opens a row when a hand tween is armed, recording where THAT BACKEND'S OWN
// drawing path will put the endpoint, and closes it when the producer speaks again — reading the frame, not
// predicting it. The difference is the prediction error, whatever the animation looked like in between.
//
// Its own decomposition names the cause, so a failure here arrives with a lever attached: `endpoint-field` (the
// wide-screen shift applied to the endpoint is not the field rule's — bisect with `--query spreadEndpoint=off`),
// `endpoint-pose`, `raise-ramp`. The three excluded causes (`gone`, `superseded`, `game-moved`) are rows that are
// not verdicts about this client at all, and they are reported rather than dropped silently.
const LANDING_PREDICTION_TOLERANCE_PX = 1.5;

/** The landing log, verbatim. Null on a page without the seam. */
const readLandingLog = (page) =>
  page.evaluate(() => (window.__mirrorLandingLog ? window.__mirrorLandingLog() : null));

/** `landingLog.classifyLanding`, transcribed for the harness (which cannot import the frontend's modules). */
function classifyLandingRow(row, spreadFactor) {
  const eps = 0.01;
  if (row.closedBy === "gone") return "gone";
  if (row.supersededBy !== null) return "superseded";
  if (row.fieldMode === 1) {
    const gx = row.endpointGame[4];
    const clamped = gx < 0 ? 0 : gx > 1920 ? 1920 : gx;
    if (Math.abs(row.endpointDrawn[4] - (gx + clamped * (spreadFactor - 1))) > eps) return "endpoint-field";
  }
  if (row.gameMovedPx !== null && row.gameMovedPx > eps) return "game-moved";
  if (Math.abs(row.dx) > eps || Math.abs(row.dy) > eps) return "endpoint-pose";
  // The two causes an origin-only comparison cannot see: a mispredicted BASIS (scale/rotation), and a card that
  // predicted its endpoint perfectly and still JUMPED when the delta landed because the client had been drawing
  // the whole flight somewhere else. `basisDelta`/`settleJumpPx` are absent on a row from an older build, and
  // `undefined > n` is false, so this stays correct against one.
  if (row.basisDelta > 0.001) return "endpoint-basis";
  if (row.settleJumpPx !== null && row.settleJumpPx > 0.5) return "settle-jump";
  if (Math.abs(row.raiseDeltaPx) > eps) return "raise-ramp";
  return "clean";
}

const LANDING_UNSCORED_CAUSES = new Set(["gone", "superseded", "game-moved"]);

/** One row, trimmed to what a report needs and rounded to a tenth of a design pixel. */
function landingRowSummary(row, cause) {
  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    name: row.name,
    cause,
    want: [r1(row.endpointDrawn[4]), r1(row.endpointDrawn[5])],
    got: [r1(row.settledDrawn[4]), r1(row.settledDrawn[5])],
    d: [r1(row.dx), r1(row.dy)],
    distPx: r1(row.distPx),
    screenPx: r1(row.screenDistPx),
    // Reported, never gated (like `raise`): a jump is a frame-to-frame fact rather than a verdict on the arm's
    // arithmetic, and it is the number the player's own report was actually about.
    jumpPx: row.settleJumpPx == null ? null : r1(row.settleJumpPx),
    raise: [row.raiseDyAtArm, row.raiseDyAtSettle],
    gameMovedPx: row.gameMovedPx === null ? null : r1(row.gameMovedPx),
    fieldMode: row.fieldMode,
    spreadDx: r1(row.spreadDxApplied),
    closedBy: row.closedBy,
    supersededBy: row.supersededBy,
    windowMs: Math.round(row.durationMs),
    settledAfterMs: Math.round(row.settleAt - row.armAt)
  };
}

async function checkH12(ctx) {
  const { page } = ctx;
  // POLLED, not read once. The seam is installed when the renderer is CONSTRUCTED, and this check reads it as its
  // very first act — earlier than any other check, which all wait for a hand first. A single read here raced the
  // construction and reported "no seam (older build?)", which is exactly the message a missing deploy gives and
  // sent a round looking at the wrong thing.
  let before = null;
  for (const deadline = now() + 5000; ; ) {
    before = await readLandingLog(page);
    if (before || now() > deadline) break;
    await sleep(100);
  }
  if (!before) {
    return skip("this page has no __mirrorLandingLog seam after 5s (older build, or no renderer was constructed)");
  }
  const seenBefore = before.rows.length;

  const tour = await handGestureTour(ctx, () => null);
  if (tour.skipped) return tour.skipped;
  // The trace H11's tour starts is not read here; stop it so it does not keep sampling into the next check.
  await stopLandingTrace(page);

  const after = await readLandingLog(page);
  // The log is a bounded ring, so "everything past the mark" is only right while the ring did not wrap. A hand
  // gesture opens ~5 rows and the ring holds 200; if it ever does wrap, taking the whole ring is the safe error
  // (it over-reports, which fails loudly, rather than under-reporting, which passes quietly).
  const fresh = after.rows.length >= seenBefore ? after.rows.slice(seenBefore) : after.rows;
  if (fresh.length === 0) {
    // SKIP, NOT FAIL. "Nothing was predicted" is a fact about the GAME's answer to the gesture, not about the
    // client: a hand the producer re-poses by teleport rather than by tween arms nothing, and that is a legal
    // (and common) shape — it happens on this fixture whenever an earlier check has already played cards out of
    // the hand. Failing on it would gate the run on the fixture's mood. It stays visible in the table, and the
    // detail says whether the seam answered at all, so a genuinely broken seam is still legible here.
    return skip(
      `the gestures armed no hand tween, so there is no prediction to score ` +
        `(seam answered: stage=${after.stage} F=${after.spreadFactor.toFixed(4)} rows=${after.rows.length} ` +
        `open=${after.openCount})`
    );
  }

  const classified = fresh.map((row) => ({ row, cause: classifyLandingRow(row, after.spreadFactor) }));
  const scored = classified.filter((c) => !LANDING_UNSCORED_CAUSES.has(c.cause));
  const offenders = classified
    .filter((c) => c.cause === "endpoint-field" || (!LANDING_UNSCORED_CAUSES.has(c.cause) && c.row.distPx > LANDING_PREDICTION_TOLERANCE_PX))
    .sort((a, b) => b.row.distPx - a.row.distPx);
  const excluded = classified.filter((c) => LANDING_UNSCORED_CAUSES.has(c.cause));

  // WHAT THE PLAYER SEES is not `distPx`: the cosmetic readable-hand lift is deliberately outside the pose
  // comparison (it is a separate channel, and the input side inverts it exactly), but it still MOVES the card on
  // screen when it changes across a window. It is ramped rather than teleported, so a change is not by itself a
  // jump and this does not gate on it — but a check that never mentioned it would be silent about the largest
  // vertical motion in the whole gesture, which is not a thing an instrument should be silent about.
  const byScreen = [...classified].sort((a, b) => b.row.screenDistPx - a.row.screenDistPx);
  const causes = ["clean", "raise-ramp", "endpoint-pose", "endpoint-field", "game-moved", "superseded", "gone"]
    .map((c) => [c, classified.filter((x) => x.cause === c).length])
    .filter(([, n]) => n > 0)
    .map(([c, n]) => `${c}=${n}`)
    .join(" ");

  if (offenders.length === 0) {
    const worst = scored.reduce((a, b) => (a === null || b.row.distPx > a.row.distPx ? b : a), null);
    return ok(
      `${fresh.length} predicted landings on the ${after.stage} stage at F=${after.spreadFactor.toFixed(4)}: ` +
        `${scored.length} scored, every one within ${LANDING_PREDICTION_TOLERANCE_PX}px of where it ended up ` +
        `(worst ${worst ? worst.row.distPx.toFixed(2) : 0}px, ${worst ? worst.row.name : "n/a"}); ` +
        `causes ${causes}; worst ON-SCREEN move across a window ` +
        `${byScreen.length > 0 ? byScreen[0].row.screenDistPx.toFixed(2) : 0}px ` +
        `(${byScreen.length > 0 ? byScreen[0].row.name : "n/a"}, lift ` +
        `${byScreen.length > 0 ? byScreen[0].row.raiseDeltaPx.toFixed(0) : 0}px of it)`,
      { rows: byScreen.slice(0, 10).map((c) => landingRowSummary(c.row, c.cause)) }
    );
  }
  const worst = offenders[0];
  return bad(
    `${offenders.length}/${scored.length} landings were PREDICTED WRONG on the ${after.stage} stage — worst ` +
      `${worst.row.distPx.toFixed(2)} design px (${worst.row.name}, cause "${worst.cause}"): the client sent it to ` +
      `(${worst.row.endpointDrawn[4].toFixed(1)},${worst.row.endpointDrawn[5].toFixed(1)}) and it finished at ` +
      `(${worst.row.settledDrawn[4].toFixed(1)},${worst.row.settledDrawn[5].toFixed(1)})`,
    {
      stage: after.stage,
      spreadFactor: after.spreadFactor,
      offenders: offenders.slice(0, 12).map((c) => landingRowSummary(c.row, c.cause)),
      excluded: excluded.slice(0, 8).map((c) => landingRowSummary(c.row, c.cause))
    }
  );
}

// ---------------------------------------------------------------------------------------------------------------
// H13 — THE WIDE-SCREEN FIELD, ON EVERY NODE, WHILE THE HAND IS MOVING
// ---------------------------------------------------------------------------------------------------------------
//
// H11 and H12 are both HAND-SHAPED: they read holders, which are zero-size positioners that paint nothing. The
// Aug-29 defect lived one level below them — the card's own painted parts were drawn through a field claim
// measured at the pose the producer had FROZEN, so the picture sat `travel · (F − 1)` off while both checks
// reported 0.00px. This one asks the build itself, of every node it walks, on the frames it walks them:
//
//     is the wide-screen shift you applied the one the field rule gives at the pose you DREW this node at?
//
// It needs `--query spreadAudit=1` (the audit costs one comparison per node, so the seam exists only when asked
// for), and it is meaningless at F = 1, where every shift is 0 by construction.
//
// WHAT IT CANNOT SEE, stated rather than implied: it samples, and the sampler is a page timer. A defect confined
// to frames it did not sample is missed — so it under-reports, never over-reports, and the sample count is in the
// PASS text so a reader can tell a thorough run from a thin one.
async function checkH13(ctx) {
  const { page } = ctx;
  const hasSeam = await page.evaluate(() => typeof window.__mirrorSpreadAudit === "function");
  if (!hasSeam) {
    return skip("no __mirrorSpreadAudit seam — re-run with `--query spreadAudit=1` (and on a canvas stage)");
  }
  await page.evaluate(() => {
    const w = window;
    w.__auditWatch = { samples: 0, checked: 0, moved: 0, worst: 0, rows: [], stop: false };
    const tick = () => {
      if (w.__auditWatch.stop) return;
      const report = w.__mirrorSpreadAudit ? w.__mirrorSpreadAudit() : null;
      if (report) {
        const s = w.__auditWatch;
        s.samples++;
        s.checked = Math.max(s.checked, report.checked);
        s.moved = Math.max(s.moved, report.moved);
        if (report.worstDefectPx > s.worst) {
          s.worst = report.worstDefectPx;
          s.rows = report.rows.filter((r) => r.reason === "drawn-pose").slice(0, 8);
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const tour = await handGestureTour(ctx, () => null);
  await stopLandingTrace(page);
  const watch = await page.evaluate(() => {
    const s = window.__auditWatch;
    s.stop = true;
    return s;
  });
  if (tour.skipped) return tour.skipped;

  const F = await page.evaluate(() => (window.__mirrorHandPoses ? window.__mirrorHandPoses().spreadFactor : 1));
  if (F === 1) {
    return skip(`the stage is 16:9 (F=1), where every wide-screen shift is 0 and the audit has nothing to check`);
  }
  if (watch.moved === 0) {
    // Not a pass: nothing was ever drawn away from its streamed pose, so a silent audit has proved nothing.
    return skip(
      `nothing moved client-side during the tour (${watch.samples} samples, ${watch.checked} nodes/build), ` +
        `so the audit had no animated node to check`
    );
  }
  if (watch.worst === 0) {
    return ok(
      `every node's wide-screen shift matched the field at the pose it was drawn at, across ${watch.samples} ` +
        `sampled frames (up to ${watch.checked} nodes per build, ${watch.moved} of them drawn off their streamed ` +
        `pose at the peak) at F=${F.toFixed(4)}`
    );
  }
  const worst = watch.rows[0];
  return bad(
    `a node was drawn through a field claim measured somewhere else — worst ${watch.worst.toFixed(2)} design px` +
      (worst
        ? ` (${worst.name}, mode ${worst.fieldMode}: applied ${worst.applied.toFixed(1)} where the field at its ` +
          `drawn x ${worst.drawnX.toFixed(1)} gives ${worst.expected.toFixed(1)}; the wire has it at ` +
          `${worst.gameX.toFixed(1)})`
        : ""),
    { spreadFactor: F, samples: watch.samples, rows: watch.rows }
  );
}

// H14 — THE CLIENT HAND CONTROL IS A MOMENTARY HOLD, IN BOTH STAGE BACKENDS
//
// The other hand checks deliberately run with `?raiseHand=on`. This one reloads the same page with the saved
// preference forced OFF, then runs last: an ON preference cannot distinguish "held override engaged" from a
// button that did nothing. Keeping the pointer captured while it moves well outside the control proves that the
// hold ends on release, not on leave; returning to data-on=0 and lift=0 proves the saved OFF preference survived.
async function checkH14(ctx) {
  const { page, pointer, combo } = ctx;
  loadFixture("combat", { force: true });
  const url = new URL(page.url());
  url.searchParams.set("raiseHand", "off");
  await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
  await (combo.stage === "dom"
    ? page.waitForFunction(() => document.querySelectorAll("[data-node-id]").length > 400, null, { timeout: 60000 })
    : page.waitForFunction(
        () => typeof window.__mirrorInteractiveRects === "function" && window.__mirrorInteractiveRects().length > 20,
        null,
        { timeout: 60000 }
      ));
  await page.waitForSelector('[data-testid="mirror-hand-raise-button"]', { state: "visible", timeout: 30000 });
  // Match the harness's ordinary post-readiness settle. The start-of-combat banner is itself a later full-stage
  // cover; sampling sooner would correctly disable the control and falsely call that H14's press failure.
  await sleep(3500);

  const before = await readRaiseGates(page);
  const button = page.locator('[data-testid="mirror-hand-raise-button"]');
  const box = await button.boundingBox();
  if (!box) return bad("the hand control had no pointer box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  // Keep the failure path as observable as the success path. A bare waitForFunction timeout used to throw out of
  // H14 before recording whether the browser hit the target, whether the target was blocked, or whether Vue saw
  // the pointer at all — which made a harness failure indistinguishable from a product failure.
  await page.evaluate(() => {
    window.__h14PointerEvents = [];
    const button = document.querySelector('[data-testid="mirror-hand-raise-button"]');
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"]) {
      button?.addEventListener(type, (event) => {
        window.__h14PointerEvents.push({
          type,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          isPrimary: event.isPrimary,
          button: event.button,
          buttons: event.buttons
        });
      });
    }
  });
  const inspectTarget = () => page.evaluate(([cx, cy]) => {
    const button = document.querySelector('[data-testid="mirror-hand-raise-button"]');
    const top = document.elementFromPoint(cx, cy);
    const style = button ? getComputedStyle(button) : null;
    return {
      dataOn: button?.getAttribute("data-on") ?? null,
      className: button?.getAttribute("class") ?? null,
      pointerEvents: style?.pointerEvents ?? null,
      display: style?.display ?? null,
      visibility: style?.visibility ?? null,
      zIndex: style?.zIndex ?? null,
      topTag: top?.tagName ?? null,
      topClass: top?.getAttribute("class") ?? null,
      topTestId: top?.getAttribute("data-testid") ?? null,
      received: window.__h14PointerEvents ?? []
    };
  }, [x, y]);
  const hitBefore = await inspectTarget();

  await pointer.press(x, y);
  // Read in the next browser task instead of polling. Canvas may synchronously repaint enough work after the
  // pointer handler that Playwright's polling callback does not get scheduled inside a short timeout, even though
  // the handler already set data-on=1 and the renderer already applied the full lift. The ordered evaluate is a
  // stricter pointer-DOWN assertion: its task cannot run before the dispatched input task has completed.
  const hitAfterDown = await inspectTarget();
  if (hitAfterDown.dataOn !== "1") {
    const failedDown = await readRaiseGates(page);
    await pointer.release(x, y).catch(() => {});
    return bad("pointer-down did not activate the hand control", {
      before,
      down: failedDown,
      hitBefore,
      hitAfterDown,
      pointer: combo.pointer,
      stage: combo.stage
    });
  }
  await sleep(320);
  const down = await readRaiseGates(page);
  await pointer.drag(8, 8);
  await sleep(180);
  const outside = await page.evaluate(() =>
    document.querySelector('[data-testid="mirror-hand-raise-button"]')?.getAttribute("data-on")
  );
  const held = await readRaiseGates(page);
  await pointer.release(8, 8);
  // Same ordering rule as pointer-down: the next browser task observes the Vue microtask triggered by release.
  // Polling can be starved by the canvas repaint and report a timeout after the attribute has already changed.
  const hitAfterRelease = await inspectTarget();
  await sleep(320);
  const after = await readRaiseGates(page);

  const detail = {
    before,
    down,
    outside,
    held,
    after,
    hitBefore,
    hitAfterDown,
    hitAfterRelease,
    pointer: combo.pointer,
    stage: combo.stage
  };
  if (before?.enabled || (before?.liftPx ?? 0) > 1) return bad("the forced saved-OFF baseline was already raised", detail);
  if (!down?.enabled || (down?.liftPx ?? 0) <= 1) return bad("pointer-down did not immediately start the raise", detail);
  if (outside !== "1" || !held?.enabled || (held?.liftPx ?? 0) <= 1) {
    return bad("the raise ended while the captured pointer was outside the control", detail);
  }
  if (hitAfterRelease.dataOn !== "0") return bad("release did not clear the transient hold", detail);
  if (after?.enabled || (after?.liftPx ?? 0) > 1) return bad("release did not restore the saved OFF setting", detail);
  return ok("raised on down, stayed raised outside under capture, and restored saved OFF on release", detail);
}

// H15 — AFTER PLAYING THE FIFTH CARD, THE FOURTH SURVIVOR STILL OWNS ITS RAISED-ONLY BAND
//
// This uses the renderer-neutral hand/rect seams: canvas emits no card DOM, but both stages publish the exact
// raised hitbox id, its drawn sample points, focus z-order, and the coordinate envelopes the game received.
const H15_RAISED_DY = -70;
const H15_FOCUSED_DY_EPS = 8;
// A real-GPU headless canvas can take hundreds of milliseconds to answer each seam read. Keep this a deadline,
// not a fixed dwell: every backend still releases as soon as the exact focus and zero-raise verdict is observed.
const H15_FOCUS_OBSERVE_MS = 4000;
// Canvas can defer rAF callbacks for 2.8–3.2s while a live hand grab is already entering and leaving the fan.
// This must exceed that observed stall and deliberately does NOT use page.waitForFunction's rAF default.
const H15_GRAB_OBSERVE_MS = 5000;
const H15_GRAB_POLL_MS = 25;
// The fifth's semantic play is staged: cross slop, wait for the holder to leave the fan, then commit at the board.
// This deliberately has a longer deadline than the survivor grab because a canvas CDP acknowledgement can stall.
const H15_PLAY_OVER_SLOP_CSS_PX = 32;
const H15_PLAY_GRAB_OBSERVE_MS = 12000;

/**
 * Return one fixed board-space point and prove it lies outside every native raised-hand OBB. It must be independent
 * from the fourth survivor: a "nearby" sample can overlap an adjacent card in a widened fan, especially on touch.
 *
 * This is intentionally board-empty rather than card-relative geometry. It is retained in the report, so a fixture
 * whose fan grows a native OBB into this lane fails visibly instead of borrowing a hand raise correction.
 */
async function findH15BoardDeadPoint(page) {
  return page.evaluate(() => {
    const stage = document.querySelector(".mirror-stage");
    const poses = window.__mirrorHandPoses?.();
    const rects = window.__mirrorInteractiveRects?.();
    if (!stage || !poses || !rects) return null;
    const box = stage.getBoundingClientRect();
    const designW = stage.offsetWidth;
    const designH = stage.offsetHeight;
    const scale = box.width / designW;
    if (!(scale > 0)) return null;
    const containsNative = (rect, x, y) => {
      const m = rect.transform;
      const lr = rect.localRect;
      const det = m[0] * m[3] - m[1] * m[2];
      if (Math.abs(det) < 1e-8) return false;
      const dx = x - m[4];
      const dy = y - m[5];
      const lx = (dx * m[3] - dy * m[2]) / det;
      const ly = (-dx * m[1] + dy * m[0]) / det;
      return lx >= lr.x && lx <= lr.x + lr.width && ly >= lr.y && ly <= lr.y + lr.height;
    };
    // H9's established safe board lane, fixed in native stage coordinates rather than relative to the fan.
    const point = { gx: designW / 2, gy: 380 };
    const handByHitbox = new Map(poses.holders
      .filter((holder) => holder.inFan && holder.hitboxId)
      .map((holder) => [holder.hitboxId, holder]));
    const nativeOwners = rects
      .filter((rect) => rect.raiseGoverned && handByHitbox.has(rect.id) && Array.isArray(rect.transform) && rect.localRect)
      .filter((rect) => containsNative(rect, point.gx, point.gy))
      .map((rect) => handByHitbox.get(rect.id).id);
    return {
      ...point,
      cx: box.left + point.gx * scale,
      cy: box.top + point.gy * scale,
      onStage: point.gx >= 2 && point.gx <= designW - 2 && point.gy >= 2 && point.gy <= designH - 2,
      nativeOwners,
    };
  });
}

async function waitForRaisedH15Card(page, holderId, timeout = 1800) {
  try {
    await page.waitForFunction(
      ({ id, raisedDy }) => {
        const poses = window.__mirrorHandPoses?.();
        const holder = poses?.holders.find((h) => h.id === id && h.inFan);
        if (!holder?.hitboxId) return false;
        const rect = window.__mirrorInteractiveRects?.().find((r) => r.id === holder.hitboxId);
        return rect !== undefined && rect.raiseDy < raisedDy;
      },
      { id: holderId, raisedDy: H15_RAISED_DY },
      { timeout }
    );
  } catch {
    return null;
  }
  const hand = await readHand(page);
  return hand?.cards.find((card) => card.holderId === holderId) ?? null;
}

/**
 * A press pulls a hand holder out of the fan before its click can resolve.  Four `inFan` holders alone therefore
 * mean only "the fifth card is grabbed", not "the fifth card was played".  H15 must not sample that transient:
 * it would call the still-present fifth card the fourth survivor and turn an ordinary grab into a renderer bug.
 */
async function waitForH15PlayedFan(page, fifthHolderId, survivorIds, timeout = 10000) {
  try {
    await page.waitForFunction(
      ({ fifthId, expected }) => {
        const poses = window.__mirrorHandPoses?.();
        if (!poses || poses.holders.some((holder) => !holder.inFan)) return false;
        const fanIds = poses.holders.filter((holder) => holder.inFan).map((holder) => holder.id);
        return fanIds.length === expected.length
          && !fanIds.includes(fifthId)
          && expected.every((id) => fanIds.includes(id));
      },
      { fifthId: fifthHolderId, expected: survivorIds },
      { timeout }
    );
    await awaitFanRest(page, timeout);
  } catch {
    return null;
  }
  const hand = await readHand(page);
  if (!hand || hand.cards.length !== survivorIds.length || hand.cards.some((card) => !survivorIds.includes(card.holderId))) {
    return null;
  }
  return hand;
}

/**
 * Keep a real pointer over one card until BOTH focus signals and its post-focus raise settle agree. A touch caller
 * can retain that exact peek contact for the next over-slop drag; releasing it would intentionally un-focus/re-raise
 * the holder and test a different gesture than the zero-lift edge H15 is meant to cover.
 */
async function dwellForH15Focus(page, pointer, point, holderId, { retainTouch = false } = {}) {
  const before = await sentCount(page);
  const samples = [];
  let settled = null;
  let contactHeld = false;
  await pointer.dwellStart(point.cx, point.cy);
  try {
    const until = now() + H15_FOCUS_OBSERVE_MS;
    while (now() < until) {
      const focus = await readFocus(page, FOCUS_POSE_RISE_PX);
      const hand = await readHand(page);
      const card = hand?.cards.find((row) => row.holderId === holderId) ?? null;
      settled = { focus, raiseDy: card?.raiseDy ?? null };
      samples.push(settled);
      if (focus.zFocus === holderId && focus.poseFocus === holderId && card && Math.abs(card.raiseDy) <= H15_FOCUSED_DY_EPS) {
        break;
      }
      await sleep(55);
    }
    contactHeld = retainTouch && pointer.kind === "touch" &&
      settled?.focus.zFocus === holderId && settled?.focus.poseFocus === holderId &&
      settled.raiseDy !== null && Math.abs(settled.raiseDy) <= H15_FOCUSED_DY_EPS;
  } finally {
    if (!contactHeld) await pointer.dwellEnd(point.cx, point.cy);
  }
  const inputs = (await readSentInputs(page, before)).filter((sample) => sample.coordX !== undefined && sample.coordY !== undefined);
  return {
    inputs,
    samples,
    settled,
    point,
    contactHeld,
    focused: settled?.focus.zFocus === holderId && settled?.focus.poseFocus === holderId,
    raiseSettled: settled?.raiseDy !== null && Math.abs(settled.raiseDy) <= H15_FOCUSED_DY_EPS,
  };
}

/** Snapshot one holder's native (un-raised, un-spread) oriented hitbox for H15's continuous-touch proof. */
async function h15NativeHitbox(page, holderId) {
  return page.evaluate((id) => {
    const stage = document.querySelector(".mirror-stage");
    const holders = window.__mirrorHandPoses?.().holders ?? [];
    const rects = window.__mirrorInteractiveRects?.() ?? [];
    const holder = holders.find((row) => row.id === id && row.inFan) ?? null;
    const rect = holder?.hitboxId ? rects.find((row) => row.id === holder.hitboxId) ?? null : null;
    if (!stage || !holder || !rect) return null;
    const box = stage.getBoundingClientRect();
    const scale = box.width / stage.offsetWidth;
    if (!(scale > 0)) return null;
    return {
      holderId: holder.id,
      transform: rect.transform,
      localRect: rect.localRect,
      spreadDx: rect.spreadDx,
      raiseDy: rect.raiseDy,
      origin: { x: box.left, y: box.top },
      scale,
      // Retain the declared paint order so H15 can prove the outgoing coordinate resolves to this holder, rather
      // than merely landing somewhere inside its native OBB while an overlapping neighbour owns the point.
      nativeOwners: rects
        .map((candidate, paintIndex) => ({ candidate, paintIndex, holder: holders.find((row) => row.inFan && row.hitboxId === candidate.id) ?? null }))
        .filter((row) => row.candidate.raiseGoverned && row.holder !== null)
        .map(({ candidate, paintIndex, holder: candidateHolder }) => ({
          holderId: candidateHolder.id,
          paintIndex,
          transform: candidate.transform,
          localRect: candidate.localRect,
        })),
    };
  }, holderId);
}

function h15PointInNativeHitbox(hitbox, x, y) {
  const [a, b, c, d, tx, ty] = hitbox.transform;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-8) return false;
  const dx = x - tx;
  const dy = y - ty;
  const lx = (dx * d - dy * c) / det;
  const ly = (-dx * b + dy * a) / det;
  const rect = hitbox.localRect;
  return lx >= rect.x && lx <= rect.x + rect.width && ly >= rect.y && ly <= rect.y + rect.height;
}

function h15ClientPointInNativeHitbox(hitbox, point) {
  const x = (point.cx - hitbox.origin.x) / hitbox.scale - hitbox.spreadDx;
  const y = (point.cy - hitbox.origin.y) / hitbox.scale;
  return h15PointInNativeHitbox(hitbox, x, y);
}

function h15NativeOwner(hitbox, x, y) {
  return hitbox.nativeOwners.filter((candidate) => h15PointInNativeHitbox(candidate, x, y)).at(-1)?.holderId ?? null;
}

/**
 * H15 needs a semantic fifth-card play, not a transient selected-card pose. Cross slop, explicitly observe the
 * holder leave the fan through Node-driven polling, then carry that confirmed drag to a board destination.
 */
async function playH15FocusedFifth(page, pointer, holderId, retainedTouch = null) {
  const continuousTouch = pointer.kind === "touch" && retainedTouch?.contactHeld === true && retainedTouch?.point;
  const releaseRetainedTouch = async () => {
    if (continuousTouch) await pointer.release(retainedTouch.point.cx, retainedTouch.point.cy).catch(() => {});
  };
  let hand;
  try {
    hand = await readHand(page);
  } catch (error) {
    await releaseRetainedTouch();
    throw error;
  }
  const fifth = hand?.cards.find((card) => card.holderId === holderId) ?? null;
  if (!fifth?.centre.onStage) {
    await releaseRetainedTouch();
    return { card: fifth, from: null, to: null, inputs: [], completed: false, reason: "fifth centre was not reachable" };
  }

  // H9's known-safe board lane: it is above the hand and away from UI chrome.  Center it in the current design
  // width so the same gesture stays in the playable field on the wide leg.
  const from = continuousTouch ? retainedTouch.point : fifth.centre;
  const to = {
    cx: hand.origin.x + hand.scale * (hand.designW / 2),
    cy: hand.origin.y + hand.scale * 380,
  };
  const plan = planH15FifthPlay(from, to, H15_PLAY_OVER_SLOP_CSS_PX);
  if (plan === null) {
    await releaseRetainedTouch();
    return { card: fifth, from, to, overSlop: null, inputs: [], completed: false, elapsedMs: 0, reason: "board destination coincides with grab point" };
  }
  const { overSlop } = plan;
  let before;
  try {
    before = await sentCount(page);
  } catch (error) {
    await releaseRetainedTouch();
    throw error;
  }
  const started = now();
  let position = from;
  let press = null;
  let overSlopDispatch = null;
  let boardDispatch = null;
  let grabbed = null;
  const elapsedMs = () => Math.round((now() - started) * 10) / 10;
  const readInputs = () => readSentInputs(page, before).then((inputs) =>
    inputs.filter((sample) => sample.coordX !== undefined && sample.coordY !== undefined)
  );
  // A promise-race timeout would strand a real touch while its CDP dispatch completes. Instead, after each ordered
  // input edge (or the fully settled touch batch), check the budget and retract through the product's known-safe
  // grab-point cancellation path.
  const cancel = async (reason) => {
    let retract = null;
    if (position.cx !== from.cx || position.cy !== from.cy) {
      const dispatchedAt = now();
      await pointer.drag(from.cx, from.cy).catch(() => {});
      const acknowledgedAt = now();
      retract = {
        cx: from.cx,
        cy: from.cy,
        dispatchedAt,
        acknowledgedAt,
        ackElapsedMs: Math.round((acknowledgedAt - dispatchedAt) * 10) / 10,
      };
      position = from;
    }
    const releaseDispatchedAt = now();
    await pointer.release(from.cx, from.cy).catch(() => {});
    return {
      card: fifth,
      from,
      to,
      overSlop,
      continuousTouch: Boolean(continuousTouch),
      press,
      overSlopDispatch,
      boardDispatch,
      grabbed,
      retract,
      release: {
        cx: from.cx,
        cy: from.cy,
        dispatchedAt: releaseDispatchedAt,
        ackElapsedMs: Math.round((now() - releaseDispatchedAt) * 10) / 10,
      },
      completed: false,
      reason,
      elapsedMs: elapsedMs(),
      inputs: await readInputs(),
    };
  };
  try {
    if (!continuousTouch) {
      const pressDispatchedAt = now();
      await pointer.press(from.cx, from.cy);
      press = {
        cx: from.cx,
        cy: from.cy,
        dispatchedAt: pressDispatchedAt,
        ackElapsedMs: Math.round((now() - pressDispatchedAt) * 10) / 10,
      };
    }
    const overSlopDispatchedAt = now();
    await pointer.drag(overSlop.cx, overSlop.cy);
    const overSlopAcknowledgedAt = now();
    position = overSlop;
    overSlopDispatch = {
      cx: overSlop.cx,
      cy: overSlop.cy,
      dispatchedAt: overSlopDispatchedAt,
      acknowledgedAt: overSlopAcknowledgedAt,
      ackElapsedMs: Math.round((overSlopAcknowledgedAt - overSlopDispatchedAt) * 10) / 10,
    };
    // Do not use page.waitForFunction: its rAF scheduler can miss the whole out-of-fan interval on canvas.
    grabbed = await observeH15GrabLeavesFan(page, holderId, H15_PLAY_GRAB_OBSERVE_MS);
    if (!grabbed.leftFan) return cancel("fifth holder never left the fan after the over-slop stage");

    const boardDispatchedAt = now();
    await pointer.drag(to.cx, to.cy);
    const boardAcknowledgedAt = now();
    position = to;
    boardDispatch = {
      cx: to.cx,
      cy: to.cy,
      dispatchedAt: boardDispatchedAt,
      acknowledgedAt: boardAcknowledgedAt,
      ackElapsedMs: Math.round((boardAcknowledgedAt - boardDispatchedAt) * 10) / 10,
    };
  } catch (error) {
    return cancel(`staged fifth-card play failed: ${String(error?.message ?? error)}`);
  }
  const releaseDispatchedAt = now();
  await pointer.release(to.cx, to.cy);
  return {
    card: fifth,
    from,
    to,
    overSlop,
    continuousTouch: Boolean(continuousTouch),
    press,
    overSlopDispatch,
    boardDispatch,
    grabbed,
    release: {
      cx: to.cx,
      cy: to.cy,
      dispatchedAt: releaseDispatchedAt,
      ackElapsedMs: Math.round((now() - releaseDispatchedAt) * 10) / 10,
    },
    completed: true,
    reason: null,
    elapsedMs: elapsedMs(),
    inputs: await readInputs(),
  };
}

/**
 * Observe the native hand-pose seam after a grab without rAF polling. `page.waitForFunction` defaults to animation
 * frames, which canvas can starve long enough to miss the whole short out-of-fan interval. Each protocol evaluate
 * is paired with an explicit Node-side 25ms interval and retained for the failure report until H15 returns the card.
 */
async function observeH15GrabLeavesFan(page, holderId, timeoutMs = H15_GRAB_OBSERVE_MS) {
  const started = now();
  const samples = [];
  while (now() - started <= timeoutMs) {
    const sample = await page.evaluate((id) => {
      const holder = window.__mirrorHandPoses?.().holders.find((row) => row.id === id) ?? null;
      return {
        pageMs: Math.round(performance.now() * 10) / 10,
        present: holder !== null,
        inFan: holder?.inFan ?? null,
      };
    }, holderId);
    samples.push({ elapsedMs: Math.round((now() - started) * 10) / 10, ...sample });
    if (sample.inFan === false) return { leftFan: true, samples };
    await sleep(H15_GRAB_POLL_MS);
  }
  return { leftFan: false, samples };
}

/**
 * H15's focused survivor is the zero-lift edge of the same closed loop: its rendered pixel still needs to press
 * that holder after the game has brought it to its native pose. Establish that focus before the gesture, snapshot
 * it at the edge that sends `pressed:true`, then grab only far enough to cross the touch drag threshold. Finally
 * return to the exact grab point before release — the product's safe cancel route cannot play at a board destination.
 */
async function grabAndCancelH15FocusedSurvivor(page, pointer, holderId, retainedTouch = null) {
  const focusedSnapshot = async () => {
    const [focus, hand] = await Promise.all([readFocus(page, FOCUS_POSE_RISE_PX), readHand(page)]);
    const card = hand?.cards.find((row) => row.holderId === holderId) ?? null;
    return {
      focus,
      hand,
      card,
      focusedAtNativeY: focus.zFocus === holderId && focus.poseFocus === holderId &&
        card !== null && Math.abs(card.raiseDy) <= H15_FOCUSED_DY_EPS,
    };
  };
  const waitForFocusedSnapshot = async (timeout = 1800) => {
    const until = now() + timeout;
    let snapshot = await focusedSnapshot();
    while (!snapshot.focusedAtNativeY && now() < until) {
      await sleep(55);
      snapshot = await focusedSnapshot();
    }
    return snapshot;
  };

  // A retained touch is the same positive peek contact that just proved this holder at dy=0. Do not end/re-touch it:
  // touch release intentionally un-focuses and re-raises the hand, so a later touchStart would correctly resolve a
  // DIFFERENT raised pose rather than testing this focused zero-lift press edge.
  const continuousTouch = pointer.kind === "touch" && retainedTouch?.contactHeld === true && retainedTouch?.point;
  const releaseRetainedTouch = async () => {
    if (continuousTouch) await pointer.release(retainedTouch.point.cx, retainedTouch.point.cy).catch(() => {});
  };
  let retainedBefore = null;
  try {
    retainedBefore = continuousTouch ? await sentCount(page) : null;
  } catch (error) {
    await releaseRetainedTouch();
    throw error;
  }
  const abandonRetainedTouch = async (reason, extra = {}) => {
    await releaseRetainedTouch();
    const inputs = retainedBefore === null
      ? []
      : (await readSentInputs(page, retainedBefore)).filter((sample) => sample.coordX !== undefined && sample.coordY !== undefined);
    return {
      ...extra,
      nativePress: { focusedAtNativeY: false },
      pressedInput: null,
      leftFan: false,
      restored: false,
      inputs,
      restError: reason,
    };
  };
  let initial;
  try {
    initial = await focusedSnapshot();
  } catch (error) {
    await releaseRetainedTouch();
    throw error;
  }
  if (!initial.card?.centre.onStage) {
    return continuousTouch
      ? abandonRetainedTouch("no reachable focused survivor centre", { card: initial.card, initial })
      : { card: initial.card, nativePress: { focusedAtNativeY: false }, pressedInput: null, leftFan: false, restored: false, inputs: [], restError: "no reachable focused survivor centre" };
  }
  const prewarm = { needed: !continuousTouch && !initial.focusedAtNativeY, mouseRefocusIssued: false, continuousTouch: Boolean(continuousTouch) };
  if (prewarm.needed) {
    await page.mouse.move(initial.card.centre.cx, initial.card.centre.cy);
    prewarm.mouseRefocusIssued = true;
  }
  if (!continuousTouch) initial = await waitForFocusedSnapshot();
  if (!initial.card?.centre.onStage || !initial.hand || !initial.focusedAtNativeY) {
    return continuousTouch
      ? abandonRetainedTouch("focused survivor did not settle at a reachable native pose", { card: initial.card, initial, prewarm })
      : { card: initial.card, initial, prewarm, nativePress: { focusedAtNativeY: false }, pressedInput: null, leftFan: false, restored: false, inputs: [], restError: "focused survivor did not settle at a reachable native pose" };
  }

  const start = continuousTouch ? retainedTouch.point : initial.card.centre;
  let nativeHitbox = null;
  try {
    nativeHitbox = continuousTouch ? await h15NativeHitbox(page, holderId) : null;
  } catch (error) {
    await releaseRetainedTouch();
    throw error;
  }
  const startInsideNativeHitbox = nativeHitbox !== null &&
    Math.abs(nativeHitbox.raiseDy) <= H15_FOCUSED_DY_EPS &&
    h15ClientPointInNativeHitbox(nativeHitbox, start);
  if (continuousTouch && !startInsideNativeHitbox) {
    return abandonRetainedTouch("retained positive touch point was outside the focused holder's native hitbox", {
      card: initial.card,
      initial,
      prewarm,
      start,
      nativeHitbox,
      startInsideNativeHitbox,
    });
  }
  // The smallest useful drag is still well past both pointer kinds' slop. It stays in the hand-side cancel lane;
  // after observing the holder leave the fan, the return to `start` makes the release an explicit cancellation.
  const grab = { cx: start.cx, cy: start.cy - Math.max(24, 48 * initial.hand.scale) };
  let before;
  try {
    before = await sentCount(page);
  } catch (error) {
    await releaseRetainedTouch();
    throw error;
  }
  let leftFan = false;
  let nativeRejoined = false;
  let restError = null;
  let nativePress = initial;
  let pressedInput = null;
  let grabObservation = { leftFan: false, samples: [] };
  try {
    if (!continuousTouch) await pointer.press(start.cx, start.cy);
    // Mouse sends its press above, so `initial` is its exact preceding snapshot. For either a fresh or CONTINUOUS
    // touch, the first over-slop move emits `pressed:true`; read immediately before that edge. In the continuous
    // case this occurs without any intervening touchEnd/touchStart or hybrid hover.
    if (pointer.kind === "touch") nativePress = await focusedSnapshot();
    await pointer.drag(grab.cx, grab.cy);
    // Keep the pointer held for the full bounded observation. Returning it first would erase the very native
    // out-of-fan state H15 is meant to witness; rAF polling was too late on canvas to see that short interval.
    grabObservation = await observeH15GrabLeavesFan(page, holderId);
    leftFan = grabObservation.leftFan;
  } finally {
    await pointer.drag(start.cx, start.cy).catch(() => {});
    await sleep(120);
    await pointer.release(start.cx, start.cy).catch(() => {});
  }
  try {
    await page.waitForFunction(
      (id) => window.__mirrorHandPoses?.().holders.find((holder) => holder.id === id)?.inFan === true,
      holderId,
      { timeout: 4000 },
    );
    nativeRejoined = true;
  } catch {
    // `after` records the native holder state below, even when its rejoin timed out.
  }
  try {
    await awaitFanRest(page, 4000);
  } catch (error) {
    restError = String(error?.message ?? error);
  }
  const after = await page.evaluate((id) => {
    const holders = window.__mirrorHandPoses?.().holders ?? [];
    const target = holders.find((holder) => holder.id === id) ?? null;
    return { targetInFan: target?.inFan === true, outOfFan: holders.filter((holder) => !holder.inFan).map((holder) => holder.id) };
  }, holderId);
  const inputs = (await readSentInputs(page, before)).filter((sample) => sample.coordX !== undefined && sample.coordY !== undefined);
  pressedInput = inputs.find((sample) => sample.pressed === true) ?? null;
  const pressedInsideNativeHitbox = pressedInput !== null && nativeHitbox !== null
    ? h15PointInNativeHitbox(nativeHitbox, pressedInput.coordX, pressedInput.coordY)
    : null;
  const pressedNativeOwner = pressedInput !== null && nativeHitbox !== null
    ? h15NativeOwner(nativeHitbox, pressedInput.coordX, pressedInput.coordY)
    : null;
  return {
    card: initial.card,
    initial,
    prewarm,
    nativePress,
    pressedInput,
    nativeHitbox,
    startInsideNativeHitbox,
    pressedInsideNativeHitbox,
    pressedNativeOwner,
    pressedResolvesToTarget: pressedNativeOwner === holderId,
    start,
    grab,
    leftFan,
    grabObservation,
    restored: nativeRejoined && after.targetInFan && after.outOfFan.length === 0,
    nativeRejoined,
    after,
    inputs,
    restError,
  };
}

async function checkH15(ctx) {
  const { page, pointer, combo } = ctx;
  loadFixture("handFive", { force: true });
  await sleep(2200);
  await awaitFanRest(page);
  let hand = await readHand(page);
  if (!hand || hand.cards.length !== 5) return skip(`H15 fixture did not expose exactly five fan cards (${hand?.cards.length ?? 0})`);
  const initialGates = await readRaiseGates(page);
  const initialOutOfFan = await handOutOfFan(page);
  // Holder shells are pooled and may be renamed to generated `@Control` values after the first card. The direct
  // NCard child's content key is the renderer-neutral card identity, and therefore still distinguishes this
  // authored Defend hand from the stock Strike opening hand on either stage.
  const cardContentKeys = hand.cards.map((card) => card.cardContentKey ?? "");
  const allDefends = cardContentKeys.every((key) => /^nc:DEFEND_IRONCLAD#/.test(key));
  if (initialGates?.targeting || initialOutOfFan || !allDefends) {
    return bad("H15 fixture did not yield five authored non-targeted Defends before the play", {
      hand, initialGates, initialOutOfFan, cardContentKeys
    });
  }
  const fifth = hand.cards[4];
  if (!fifth.centre.onStage) return bad("the fifth card has no reachable centre", { fifth, hand });
  const survivorIds = hand.cards.slice(0, 4).map((card) => card.holderId);

  // A mouse press on an unfocused card is a grab, not necessarily the card play this fixture needs. Focus the
  // exact fifth card first; touch retains that proven contact through the over-slop stage rather than re-touching.
  const fifthFocus = await dwellForH15Focus(page, pointer, fifth.centre, fifth.holderId, { retainTouch: pointer.kind === "touch" });
  if (!fifthFocus.focused || !fifthFocus.raiseSettled || (pointer.kind === "touch" && !fifthFocus.contactHeld)) {
    return bad("the fifth card did not focus and settle before H15 attempted to play it", { fifth, fifthFocus, hand: await readHand(page) });
  }

  const play = await playH15FocusedFifth(page, pointer, fifth.holderId, pointer.kind === "touch" ? fifthFocus : null);
  if (!play.completed) {
    return bad("the fifth-card play did not complete its confirmed staged gesture", {
      fifth, fifthFocus, play, survivorIds, after: await readHand(page), outOfFan: await handOutOfFan(page)
    });
  }
  hand = await waitForH15PlayedFan(page, fifth.holderId, survivorIds);
  if (!hand) {
    return bad("playing the fifth card did not leave its four original survivors at rest", {
      fifth,
      fifthFocus,
      play,
      survivorIds,
      after: await readHand(page),
      outOfFan: await handOutOfFan(page)
    });
  }
  const targetId = hand.cards[3].holderId;
  // The focused-grab cell starts from the genuine four-survivor rest pose. Do not create an unrelated focus
  // transition first: overlap makes a parking dwell a flaky prerequisite and it is irrelevant to this target.
  let target = await waitForRaisedH15Card(page, targetId);
  if (!target) {
    return bad("the fourth survivor was not genuinely raised at the exact four-survivor rest pose", { targetId, hand: await readHand(page) });
  }
  const targetRaisedBeforeDead = target;

  // Independent board-empty raw sentinel. It is proven outside every native raised-hand OBB before dispatch;
  // unlike the former "just above" target point, it cannot become an overlapping neighbour's touch hit.
  const deadPoint = await findH15BoardDeadPoint(page);
  if (!deadPoint?.onStage || deadPoint.nativeOwners?.length !== 0) {
    return bad("H15's fixed board-empty raw sentinel was inside a native raised-hand OBB", {
      targetId, target, deadPoint, hand: await readHand(page)
    });
  }
  const deadBefore = await sentCount(page);
  await pointer.dwellStart(deadPoint.cx, deadPoint.cy);
  await sleep(pointer.kind === "touch" ? 100 : 160);
  await pointer.dwellEnd(deadPoint.cx, deadPoint.cy);
  const deadInputs = (await readSentInputs(page, deadBefore)).filter((sample) => sample.coordX !== undefined && sample.coordY !== undefined);
  const dead = h15CoordinateVerdict(deadInputs, deadPoint);
  target = await waitForRaisedH15Card(page, targetId);
  if (!target) {
    return bad("the fixed board-empty raw sentinel disturbed the fourth survivor before its focused path", {
      targetId, deadPoint, deadInputs, dead, hand: await readHand(page)
    });
  }
  const upper = target.top;
  const positive = await dwellForH15Focus(page, pointer, upper, targetId, { retainTouch: pointer.kind === "touch" });
  const upperCoordinates = h15CoordinateVerdict(positive.inputs, upper);
  // For touch, the positive peek remains HELD directly into the over-slop drag. If it could not prove dy=0, do not
  // conceal that failure with a release/re-touch of a different raised pose.
  const continuedTouch = pointer.kind !== "touch" || positive.contactHeld;
  const focusedGrab = continuedTouch
    ? await grabAndCancelH15FocusedSurvivor(page, pointer, targetId, pointer.kind === "touch" ? positive : null)
    : { nativePress: { focusedAtNativeY: false }, pressedInput: null, leftFan: false, restored: false, inputs: [], restError: "positive touch peek never reached a retainable focused dy=0 pose" };
  // This is deliberately sampled AFTER the continuous gesture's safe return/release. A touch end legitimately
  // restores the raised fan, so it is diagnostic proof that H15 did not accidentally treat that later pose as the
  // press precondition.
  const afterPositiveRelease = await readHand(page);
  const detail = {
    targetId,
    targetRaisedBeforeDead,
    targetRaisedAfterDead: target,
    deadPoint,
    deadInputs,
    dead,
    upper,
    positive,
    upperCoordinates,
    focusedGrab,
    afterPositiveRelease: afterPositiveRelease?.cards.find((card) => card.holderId === targetId)?.raiseDy ?? null,
    afterPositiveReleaseRaised: pointer.kind === "touch"
      ? (afterPositiveRelease?.cards.find((card) => card.holderId === targetId)?.raiseDy ?? 0) < -H15_FOCUSED_DY_EPS
      : null,
    stage: combo.stage,
    pointer: combo.pointer,
  };
  const focusedGrabFailure = h15FocusedGrabFailure({ pointerKind: pointer.kind, dead, upperCoordinates, positive, focusedGrab });
  if (focusedGrabFailure !== null) return bad(focusedGrabFailure, detail);
  return ok("fifth play left its exact four survivors; the raised fourth kept an independent board-empty point raw, then its upper band corrected and its zero-lift focused grab left then safely rejoined the fan", detail);
}

const readRewardFocus = (page) =>
  page.evaluate(() =>
    typeof window.__mirrorRewardFocus === "function" ? window.__mirrorRewardFocus() : null
  );

async function waitRewardFocus(page, predicate, timeoutMs = 12000) {
  const deadline = now() + timeoutMs;
  let last = null;
  while (now() < deadline) {
    last = await readRewardFocus(page);
    if (last && predicate(last)) return last;
    await sleep(150);
  }
  throw new Error(`reward-focus state did not settle: ${JSON.stringify(last)}`);
}

async function setPagePressModality(page, modality) {
  await page.evaluate((next) => {
    if (next === "touch") {
      window.dispatchEvent(new Event("touchstart"));
    } else {
      window.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse" }));
    }
  }, modality);
}

async function parkGameCursorAwayFromRewards(page) {
  const point = await page.evaluate(() => {
    const stage = document.querySelector(".mirror-stage");
    if (!stage) return null;
    const box = stage.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height * 0.9 };
  });
  if (!point) throw new Error("mirror stage missing while parking the game cursor");
  await page.mouse.move(point.x, point.y);
  await sleep(300);
}

async function rewardRowClientPoint(page, row) {
  return page.evaluate((wanted) => {
    const stage = document.querySelector(".mirror-stage");
    const rects = typeof window.__mirrorInteractiveRects === "function"
      ? window.__mirrorInteractiveRects()
      : [];
    const stamps = typeof window.__mirrorViewScaleInputStamps === "function"
      ? window.__mirrorViewScaleInputStamps()
      : [];
    if (!stage || !wanted.gameCenter) return null;
    const contains = (box, point) => box &&
      point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY;
    const area = (box) => box ? (box.maxX - box.minX) * (box.maxY - box.minY) : Number.POSITIVE_INFINITY;
    const forward = (point, channel) => ({
      x: channel.pivotX + channel.k * (point.x - channel.pivotX) + channel.offsetX,
      y: channel.pivotY + channel.k * (point.y - channel.pivotY) + channel.offsetY
    });
    const centerOf = (rect) => {
      const lx = rect.localRect.x + rect.localRect.width / 2;
      const ly = rect.localRect.y + rect.localRect.height / 2;
      const [a, b, c, d, tx, ty] = rect.transform;
      return { x: a * lx + c * ly + tx, y: b * lx + d * ly + ty };
    };
    const box = stage.getBoundingClientRect();
    const scale = box.width / stage.offsetWidth;

    // rewardFocusSnapshot deliberately reports the game's stable, native centre. The item may be visibly enlarged
    // and shifted by ViewScale, however, so touching that native point is not a physical touch on the row. Select
    // the narrowest stamp that owns the centre, apply its fully-composed forward channel, then restore the
    // widened-stage spread shift represented by renderedBox. InputCapture will invert this exact point back to the
    // native centre; this is the same geometry a person sees and touches on both renderers.
    const stamp = stamps
      .filter((candidate) =>
        contains(candidate.originalBox, wanted.gameCenter) || contains(candidate.ownUnscaledBox, wanted.gameCenter))
      .sort((a, b) => area(a.originalBox) - area(b.originalBox))[0];
    if (stamp) {
      const rendered = forward(wanted.gameCenter, stamp.channel);
      const spreadDx = stamp.renderedBox ? stamp.renderedBox.minX - stamp.scaledBox.minX : 0;
      const cx = box.left + (rendered.x + spreadDx) * scale;
      const cy = box.top + rendered.y * scale;
      const probe = typeof window.__mirrorHitProbe === "function"
        ? window.__mirrorHitProbe(cx, cy, 1300, wanted.gameCenter.x, wanted.gameCenter.y)
        : null;
      return {
        cx,
        cy,
        hitId: probe?.stack?.ids?.[0] ?? null,
        hitCenter: wanted.gameCenter,
        spreadDx,
        raiseDy: 0,
        distance: 0,
        stack: probe?.stack ?? null,
        confirm: probe?.confirm ?? null,
        viewScale: {
          channel: stamp.channel,
          originalBox: stamp.originalBox,
          scaledBox: stamp.scaledBox,
          renderedBox: stamp.renderedBox ?? null
        }
      };
    }

    const candidates = rects.map((rect) => {
      const centre = centerOf(rect);
      const cx = box.left + (centre.x + rect.spreadDx) * scale;
      const cy = box.top + (centre.y + rect.raiseDy) * scale;
      const probe = typeof window.__mirrorHitProbe === "function"
        ? window.__mirrorHitProbe(cx, cy, 1300, centre.x, centre.y)
        : null;
      return {
        rect,
        centre,
        cx,
        cy,
        probe,
        distance: Math.hypot(centre.x - wanted.gameCenter.x, centre.y - wanted.gameCenter.y)
      };
    });
    const hit = candidates
      .filter((candidate) => candidate.probe?.stack?.ids?.includes(wanted.id))
      .sort((a, b) => {
        const aTop = a.probe.stack.ids[0] === wanted.id ? 0 : 1;
        const bTop = b.probe.stack.ids[0] === wanted.id ? 0 : 1;
        return aTop - bTop || a.distance - b.distance;
      })[0];
    if (!hit) {
      const nearest = candidates
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 6)
        .map((candidate) => ({
          hitId: candidate.rect.id,
          centre: candidate.centre,
          spreadDx: candidate.rect.spreadDx,
          raiseDy: candidate.rect.raiseDy,
          distance: candidate.distance,
          stack: candidate.probe?.stack ?? null,
          confirm: candidate.probe?.confirm ?? null
        }));
      // Unscaled fallback: a reward row without a stamp is painted at its native centre (plus proportional spread).
      const spreadFactor = stage.offsetWidth / 1920;
      return {
        cx: box.left + wanted.gameCenter.x * spreadFactor * scale,
        cy: box.top + wanted.gameCenter.y * scale,
        hitId: null,
        fallback: "proportional-reward-centre",
        nearest
      };
    }
    return {
      cx: hit.cx,
      cy: hit.cy,
      hitId: hit.rect.id,
      hitCenter: hit.centre,
      spreadDx: hit.rect.spreadDx,
      raiseDy: hit.rect.raiseDy,
      distance: hit.distance,
      stack: hit.probe?.stack ?? null,
      confirm: hit.probe?.confirm ?? null
    };
  }, row);
}

/**
 * H16 — reward focus follows the page's LAST PRESS modality, and an already-focused row activates with one touch.
 *
 * This check uses only the renderer-neutral `__mirrorRewardFocus` + `__mirrorInteractiveRects` seams, so its
 * coordinate and assertions are the same on the DOM and canvas backends. Synthetic window-level modality edges
 * deliberately never touch the stage: that isolates "the modality changed" from "the game cursor moved".
 */
async function checkH16(ctx) {
  const { page, pointer, combo, outDir } = ctx;
  const findings = [];

  // The list is already open when this new document starts, so its page-lifetime tracker is genuinely `unknown`.
  // Flipping that fact to touch must not run the entry rule retroactively or send a hover of its own.
  loadFixture("rewardFocus", { force: true });
  await sleep(1800);
  await page.reload({ waitUntil: "domcontentloaded" });
  const unknownBefore = await waitRewardFocus(page, (state) => state.rows.length === 3);
  const unknownSent = await sentCount(page);
  await setPagePressModality(page, "touch");
  await sleep(500);
  const unknownAfter = await readRewardFocus(page);
  const sameUnknownFocus = JSON.stringify(unknownBefore.rows.map((row) => row.focused)) ===
    JSON.stringify(unknownAfter?.rows.map((row) => row.focused));
  const unknownQuiet = (await sentCount(page)) === unknownSent;
  findings.push({
    part: "unknown-to-touch",
    status: unknownBefore.modality === "unknown" && unknownAfter?.modality === "touch" && sameUnknownFocus && unknownQuiet ? PASS : FAIL,
    before: unknownBefore,
    after: unknownAfter,
    sent: (await sentCount(page)) - unknownSent
  });

  // H16 owns Tap-to-focus, not the independent irreversible-choice firewall. Pin Confirm tap off for the physical
  // activation legs; confirmTap.spec.ts separately proves that the firewall keeps precedence over an already-
  // focused target. This navigation starts another page lifetime, which the explicit modality edges below seed.
  const tapFocusUrl = new URL(page.url());
  tapFocusUrl.searchParams.set("confirmTap", "off");
  await page.goto(tapFocusUrl.toString(), { waitUntil: "domcontentloaded" });
  await waitRewardFocus(page, (state) => state.rows.length === 3);

  // A pointer press followed by a fresh rewards-screen entry is also silent. Park the game cursor in combat first
  // so a pre-existing hover cannot make a row look coordinator-focused.
  loadFixture("combat", { force: true });
  await waitRewardFocus(page, (state) => state.screenId === null);
  await parkGameCursorAwayFromRewards(page);
  await setPagePressModality(page, "pointer");
  const pointerSent = await sentCount(page);
  loadFixture("rewardFocus", { force: true });
  const pointerEntry = await waitRewardFocus(page, (state) => state.rows.length === 3);
  await sleep(600);
  const pointerAfter = await readRewardFocus(page);
  findings.push({
    part: "pointer-entry",
    status: pointerEntry.modality === "pointer" &&
      pointerAfter?.rows.every((row) => !row.focused) &&
      (await sentCount(page)) === pointerSent ? PASS : FAIL,
    state: pointerAfter,
    sent: (await sentCount(page)) - pointerSent
  });

  if (combo.pointer !== "touch") {
    const failed = findings.filter((finding) => finding.status === FAIL);
    return failed.length === 0
      ? ok("unknown->touch was inert and pointer-mode reward entry did not auto-focus", { findings })
      : bad(`${failed.length} reward-modality sub-check(s) failed`, { findings });
  }

  // Enter again in touch mode. The coordinator must hover the first row; authoritative `focused` is the same game
  // state that displays its HoverTip. The screenshot records that rendered result on the selected backend.
  loadFixture("combat", { force: true });
  await waitRewardFocus(page, (state) => state.screenId === null);
  await parkGameCursorAwayFromRewards(page);
  await setPagePressModality(page, "touch");
  const touchSent = await sentCount(page);
  loadFixture("rewardFocus", { force: true });
  const touchEntry = await waitRewardFocus(
    page,
    (state) => state.rows.length === 3 && state.rows[0].focused && state.rows[0].gameCenter !== null
  );
  const entryShot = `${outDir}/${combo.name}-H16-entry-hover-tip.png`;

  // The reward list eases into its final vertical positions after it first becomes interactive. Let that entry
  // motion settle before measuring the physical touch point: this check is about one-tap semantics, not whether a
  // synthetic finger can beat the game's own entrance animation/input enable window.
  await sleep(FOCUS_SETTLE_MS);
  const settledTouchEntry = await waitRewardFocus(
    page,
    (state) => state.rows.length === 3 && state.rows[0].focused && state.rows[0].gameCenter !== null
  );
  // Capture the settled frame, not the transient entrance layout: this image is the visual proof that the first
  // row itself owns focus and displays its real HoverTip on both renderers.
  await page.screenshot({ path: entryShot });
  findings.push({
    part: "touch-entry",
    status: touchEntry.modality === "touch" && settledTouchEntry.rows[0].focused &&
      settledTouchEntry.rows.slice(1).every((row) => !row.focused) &&
      (await sentCount(page)) > touchSent ? PASS : FAIL,
    state: settledTouchEntry,
    screenshot: entryShot
  });

  // ACTIVATION IS ASSERTED ON THE WIRE, NOT ON THE ROW DISAPPEARING.
  //
  // A rewards FIXTURE synthesizes a reward set the game's own synchronizer is never told about, so on this screen
  // NO reward can be claimed BY ANY MEANS: the claim throws inside the game, which leaves the row on screen and
  // permanently disabled. That looks exactly like input that never landed, and exactly like a legitimate refusal.
  // It is what produced the long-standing "a synthetic click focuses a reward row but never presses it" finding
  // that made this client reach for the `claim-reward` semantic action in the first place. A live probe against a
  // REAL reward set disproved it: one ordinary left click at the row's native centre claims the row, cold, with no
  // preceding hover and no press/release split (.sts2/research/reward-real-input-probe-sep14.md).
  //
  // So this check proves the GESTURE — that the auto-focused row takes the one-tap path and puts a plain left
  // click on its native centre — which is the only half a fixture can answer for. Whether that click CLAIMS is a
  // question for a real reward screen (`dev console room Monster`, then `dev console win`), which this harness's
  // fixture-driven game has no way to build. Do not "fix" a red H16 by restoring a semantic activation path.
  const firstRow = settledTouchEntry.rows[0];
  const firstId = firstRow.id;
  const firstPoint = await rewardRowClientPoint(page, firstRow);
  if (!firstPoint) {
    throw new Error(`no rendered hit rectangle for first reward ${firstId}: ${JSON.stringify(firstPoint)}`);
  }
  const firstInputStart = await sentCount(page);
  await pointer.tap(firstPoint.cx, firstPoint.cy);
  await sleep(FOCUS_SETTLE_MS);
  const firstInputs = await readSentInputs(page, firstInputStart);
  const firstClicks = firstInputs.filter((message) => message.kind === "click" && message.button === "left");
  const oneTapShot = `${outDir}/${combo.name}-H16-auto-focused-one-tap.png`;
  await page.screenshot({ path: oneTapShot });
  const atNativeCentre = (message) =>
    Math.round(message.coordX) === Math.round(firstRow.gameCenter.x) &&
    Math.round(message.coordY) === Math.round(firstRow.gameCenter.y);
  findings.push({
    part: "one-tap-clicks-the-auto-focused-row",
    status: firstClicks.length === 1 && atNativeCentre(firstClicks[0]) ? PASS : FAIL,
    firstId,
    gameCenter: firstRow.gameCenter,
    point: firstPoint,
    inputs: firstInputs,
    screenshot: oneTapShot
  });

  // THE READINESS LATCH MUST NOT OUTLIVE ITS FOCUS.
  //
  // Auto-focus arms a local "already ready, activate on release" latch to cover the hover -> focus-delta round
  // trip. It used to survive for the whole screen, so after focus moved elsewhere a tap meant to re-focus the
  // first row TOOK it instead — a reward spent on a tap the player did not intend. Re-enter the list to arm it
  // again: the row tapped above is left disabled by the fixture's failed claim and can never be focused again.
  loadFixture("combat", { force: true });
  await waitRewardFocus(page, (state) => state.screenId === null);
  await parkGameCursorAwayFromRewards(page);
  loadFixture("rewardFocus", { force: true });
  await waitRewardFocus(page, (state) => state.rows.length === 3 && state.rows[0].focused);
  await sleep(FOCUS_SETTLE_MS);
  const armedEntry = await waitRewardFocus(
    page,
    (state) => state.rows.length === 3 && state.rows[0].focused && state.rows[0].gameCenter !== null
  );
  const armedId = armedEntry.rows[0].id;

  // A real touch on a DIFFERENT row: the ordinary focus-first tap there, and the armed row's readiness retires.
  const otherPoint = await rewardRowClientPoint(page, armedEntry.rows[1]);
  if (!otherPoint) throw new Error(`no rendered hit rectangle for reward ${armedEntry.rows[1].id}`);
  await pointer.tap(otherPoint.cx, otherPoint.cy);
  const movedFocus = await waitRewardFocus(
    page,
    (state) => state.rows.some((row) => row.id === armedEntry.rows[1].id && row.focused) &&
      !state.rows.some((row) => row.id === armedId && row.focused)
  );
  await sleep(FOCUS_SETTLE_MS);

  // Back to the once-armed row. The host reports it UNFOCUSED, so this tap must FOCUS it — not take it. Before
  // the latch was made to follow authoritative focus, this tap sent a click and spent the reward.
  const backRow = (await readRewardFocus(page)).rows.find((row) => row.id === armedId);
  const backPoint = backRow ? await rewardRowClientPoint(page, backRow) : null;
  if (!backPoint) throw new Error(`the once-armed reward ${armedId} lost its hit rectangle`);
  const backStart = await sentCount(page);
  await pointer.tap(backPoint.cx, backPoint.cy);
  await sleep(FOCUS_SETTLE_MS);
  const backInputs = await readSentInputs(page, backStart);
  const staleLatchShot = `${outDir}/${combo.name}-H16-stale-latch.png`;
  await page.screenshot({ path: staleLatchShot });
  findings.push({
    part: "re-tap-after-focus-moved-only-focuses",
    status: backInputs.every((message) => message.kind !== "click") ? PASS : FAIL,
    armedId,
    movedTo: movedFocus.rows.find((row) => row.focused)?.id ?? null,
    inputs: backInputs,
    screenshot: staleLatchShot
  });

  // …and the row is still perfectly reachable: now that the host reports it focused, the next tap does click it.
  // That is the ordinary two-tap, and it is what the player gets whenever the latch is not standing in.
  const refocused = await waitRewardFocus(page, (state) => state.rows.some((row) => row.id === armedId && row.focused));
  const refocusedPoint = await rewardRowClientPoint(page, refocused.rows.find((row) => row.id === armedId));
  if (!refocusedPoint) throw new Error(`the re-focused reward ${armedId} lost its hit rectangle`);
  const secondStart = await sentCount(page);
  await pointer.tap(refocusedPoint.cx, refocusedPoint.cy);
  await sleep(FOCUS_SETTLE_MS);
  const secondInputs = await readSentInputs(page, secondStart);
  findings.push({
    part: "second-tap-clicks-the-now-focused-row",
    status: secondInputs.filter((message) => message.kind === "click" && message.button === "left").length === 1
      ? PASS
      : FAIL,
    armedId,
    inputs: secondInputs
  });

  const failed = findings.filter((finding) => finding.status === FAIL);
  const detail = {
    stage: combo.stage,
    pointer: combo.pointer,
    findings,
    screenshots: [entryShot, oneTapShot, staleLatchShot]
  };
  return failed.length === 0
    ? ok("touch entry focused the first reward and one tap clicked its native centre; the readiness did not outlive its focus, and the ordinary two-tap still reaches the row; pointer/unknown stayed inert", detail)
    : bad(`${failed.length} reward-focus sub-check(s) failed`, detail);
}

// H17 — SHOP CARD-REMOVAL IS A TOUCH-ONLY IRREVERSIBLE ACTION
//
// Unlike an ordinary shop purchase, removal opens a second (deck-card-selection) screen. The browser seam names
// the service and picker from the renderer's own retained scene state, while `waitDeckCardSelection` proves the
// matching semantic transition in the isolated game. That division is deliberate: neither DOM ancestry nor a
// screenshot can tell us that a client-confirm route opened *remove* and staged a card without committing it.
const readShopRemoval = (page) =>
  page.evaluate(() =>
    typeof window.__mirrorShopRemoval === "function" ? window.__mirrorShopRemoval() : null
  );

async function waitShopRemoval(page, predicate, timeoutMs = 12000) {
  const deadline = now() + timeoutMs;
  let last = null;
  while (now() < deadline) {
    last = await readShopRemoval(page);
    if (last && predicate(last)) return last;
    await sleep(150);
  }
  throw new Error(`shop-removal renderer seam did not settle: ${JSON.stringify(last)}`);
}

const readClientConfirm = async (page) =>
  assessClientConfirm(
    await page.evaluate(() => {
    const el = document.querySelector('[data-testid="mirror-confirm-button"]');
    const stage = document.querySelector(".mirror-stage");
    if (!el) return { present: false, display: "none", visibility: "hidden", box: null, stage: null, viewport: { width: innerWidth, height: innerHeight }, hitTestMatches: false };
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const tapX = box.x + box.width / 2;
    const tapY = box.y + box.height / 2;
    const top = document.elementFromPoint(tapX, tapY);
    const stageBox = stage?.getBoundingClientRect();
    return {
      present: true,
      display: style.display,
      visibility: style.visibility,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      stage: stageBox ? { x: stageBox.x, y: stageBox.y, width: stageBox.width, height: stageBox.height } : null,
      viewport: { width: innerWidth, height: innerHeight },
      hitTestMatches: top !== null && el.contains(top)
    };
    })
  );

async function waitClientConfirm(page, visible, timeoutMs = 6000) {
  const deadline = now() + timeoutMs;
  let last = null;
  while (now() < deadline) {
    last = await readClientConfirm(page);
    // A mounted button begins 180px beyond the right edge.  It has a non-zero rectangle throughout that enter
    // animation, but a touch at its centre cannot reach it.  Opening waits for a real browser hit-test; closing
    // deliberately stays logical so the exit animation cannot be mistaken for a new ready button.
    if (visible ? last.tappable : !last.visible) return last;
    await sleep(100);
  }
  throw new Error(`client confirm did not become ${visible ? "tappable" : "logically hidden"}: ${JSON.stringify(last)}`);
}

/** Convert a native seam centre into the physical point presently drawn by either renderer. */
async function shopRemovalClientPoint(page, target) {
  return page.evaluate((wanted) => {
    const stage = document.querySelector(".mirror-stage");
    const stamps = typeof window.__mirrorViewScaleInputStamps === "function"
      ? window.__mirrorViewScaleInputStamps()
      : [];
    const rects = typeof window.__mirrorInteractiveRects === "function"
      ? window.__mirrorInteractiveRects()
      : [];
    if (!stage || !wanted?.gameCenter) return null;
    const contains = (box, point) => box &&
      point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY;
    const area = (box) => box ? (box.maxX - box.minX) * (box.maxY - box.minY) : Number.POSITIVE_INFINITY;
    const forward = (point, channel) => ({
      x: channel.pivotX + channel.k * (point.x - channel.pivotX) + channel.offsetX,
      y: channel.pivotY + channel.k * (point.y - channel.pivotY) + channel.offsetY
    });
    const centreOf = (rect) => {
      const lx = rect.localRect.x + rect.localRect.width / 2;
      const ly = rect.localRect.y + rect.localRect.height / 2;
      const [a, b, c, d, tx, ty] = rect.transform;
      return { x: a * lx + c * ly + tx, y: b * lx + d * ly + ty };
    };
    const box = stage.getBoundingClientRect();
    const scale = box.width / stage.offsetWidth;
    const stamp = stamps
      .filter((candidate) =>
        contains(candidate.originalBox, wanted.gameCenter) || contains(candidate.ownUnscaledBox, wanted.gameCenter))
      .sort((a, b) => area(a.originalBox) - area(b.originalBox))[0];
    if (stamp) {
      const rendered = forward(wanted.gameCenter, stamp.channel);
      const spreadDx = stamp.renderedBox ? stamp.renderedBox.minX - stamp.scaledBox.minX : 0;
      const cx = box.left + (rendered.x + spreadDx) * scale;
      const cy = box.top + rendered.y * scale;
      const probe = typeof window.__mirrorHitProbe === "function"
        ? window.__mirrorHitProbe(cx, cy, 1300, wanted.gameCenter.x, wanted.gameCenter.y)
        : null;
      return {
        cx, cy, hitboxId: wanted.hitboxId, nativeCenter: wanted.gameCenter, spreadDx,
        hitStack: probe?.stack ?? null, confirm: probe?.confirm ?? null,
        viewScale: { channel: stamp.channel, originalBox: stamp.originalBox, scaledBox: stamp.scaledBox, renderedBox: stamp.renderedBox ?? null }
      };
    }
    const rect = rects.find((candidate) => candidate.id === wanted.hitboxId);
    if (!rect) return null;
    const centre = centreOf(rect);
    const cx = box.left + (centre.x + rect.spreadDx) * scale;
    const cy = box.top + (centre.y + rect.raiseDy) * scale;
    const probe = typeof window.__mirrorHitProbe === "function"
      ? window.__mirrorHitProbe(cx, cy, 1300, wanted.gameCenter.x, wanted.gameCenter.y)
      : null;
    return {
      cx, cy, hitboxId: wanted.hitboxId, nativeCenter: wanted.gameCenter,
      spreadDx: rect.spreadDx, raiseDy: rect.raiseDy, hitStack: probe?.stack ?? null, confirm: probe?.confirm ?? null,
      fallback: "matching-interactive-rect"
    };
  }, target);
}

async function loadShopRemovalLeg(page, settings) {
  // A shop-removal selection can spend gold / hide Cost before its deck picker is confirmed. Never reuse either
  // that game state or the document's confirm arm across routes: each leg has a new fixture AND page lifetime.
  loadFixture("shopRemoval", { force: true });
  await sleep(1800);
  const url = new URL(page.url());
  url.searchParams.set("tapFocus", settings.tapFocus ? "on" : "off");
  url.searchParams.set("confirmTap", settings.confirmTap ? "on" : "off");
  // Every irreversible leg gets a new document URL as well as a new fixture.  This makes a stale HTML/app entry
  // fail provenance instead of quietly replaying the previous page's module cache.
  url.searchParams.set("touchQaNav", `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
  // `goto` creates the page lifetime; this preflight proves it also executed a module from THIS navigation before
  // the irreversible leg can call a result about an old page/bundle. The URL is retained in the report so a Vite
  // server accidentally reused from another worktree is diagnosable instead of looking like a gesture regression.
  const bundle = selectMirrorModuleBundle(await page.evaluate(() => {
    const scriptSrcs = [...document.scripts]
      .filter((candidate) => candidate.type === "module" && candidate.src)
      .map((candidate) => candidate.src);
    const resourceUrls = performance.getEntriesByType("resource").map((entry) => entry.name);
    return { scriptSrcs, resourceUrls };
  }));
  if (!bundle) throw new Error("fresh shop-removal page did not load MirrorApp or its module entry");
  const shop = await waitShopRemoval(page, (state) => state.service?.id && state.service?.hitboxId && state.service?.gameCenter && state.picker === null);
  const confirm = await waitClientConfirm(page, false);
  const semantic = await waitDeckCardSelection((overlay) => overlay === null);
  return { shop, confirm, semantic: deckSelectionDigest(semantic), url: url.toString(), bundle };
}

async function openRemovalAndStage(page, pointer, route) {
  const before = await waitShopRemoval(page, (state) => state.service?.id && state.picker === null);
  let coin = await shopRemovalClientPoint(page, before.service);
  if (!coin) throw new Error("shop-removal service had no renderer-neutral client point");
  await pointer.tap(coin.cx, coin.cy);

  const firstConfirm = await readClientConfirm(page);
  const firstSemantic = currentDeckCardSelection();
  if (route.expectFirstFocusOnly) {
    await sleep(CONFIRM_SETTLE_MS);
    const settled = currentDeckCardSelection();
    const confirm = await readClientConfirm(page);
    if (settled.overlay !== null || confirm.visible) {
      throw new Error(`first coin tap was not focus-only: ${JSON.stringify({ semantic: deckSelectionDigest(settled), confirm })}`);
    }
  }
  if (route.expectConfirm) {
    const armed = await waitClientConfirm(page, true);
    let confirmForButton = armed;
    const stillClosed = currentDeckCardSelection();
    if (stillClosed.overlay !== null) {
      throw new Error(`coin tap opened removal before the client confirm: ${JSON.stringify(deckSelectionDigest(stillClosed))}`);
    }
    if (route.repeatMustStayGuarded || route.retapOpens) {
      await sleep(260); // longer than the 200ms bounce debounce: this is an intentional second coin tap.
      const refreshed = await waitShopRemoval(page, (state) => state.service?.id && state.picker === null);
      coin = await shopRemovalClientPoint(page, refreshed.service);
      if (!coin) throw new Error("armed shop-removal service lost its renderer-neutral client point");
      await pointer.tap(coin.cx, coin.cy);
      if (route.repeatMustStayGuarded) {
        // Do not mistake the pre-repeat button for proof that the repeated tap stayed guarded. Let a real game
        // response settle, then require BOTH independent facts: no semantic picker opened and the client button
        // still owns the route.
        await sleep(CONFIRM_SETTLE_MS);
        const afterRepeat = currentDeckCardSelection();
        const confirmAfterRepeat = await waitClientConfirm(page, true);
        confirmForButton = confirmAfterRepeat;
        if (afterRepeat.overlay !== null) {
          throw new Error(`repeated guarded coin tap opened removal: ${JSON.stringify({ semantic: deckSelectionDigest(afterRepeat), confirm: confirmAfterRepeat })}`);
        }
      }
    }
    if (route.clientConfirm) {
      // The successful wait samples a frame, not a lease on it. Read again immediately before dispatching the
      // irreversible touch so a re-render/exit between the poll and this statement cannot send to stale geometry.
      confirmForButton = await readClientConfirm(page);
      const button = confirmForButton.tapPoint;
      if (!confirmForButton.tappable || !button) throw new Error("client confirm was not physically tappable at dispatch");
      await pointer.tap(button.x, button.y);
    }
  } else if (route.delayedRetap) {
    await sleep(260); // intentionally outside the accidental-double-tap debounce.
    const refreshed = await waitShopRemoval(page, (state) => state.service?.id && state.picker === null);
    coin = await shopRemovalClientPoint(page, refreshed.service);
    if (!coin) throw new Error("focused shop-removal service lost its renderer-neutral client point");
    await pointer.tap(coin.cx, coin.cy);
  }

  const opened = await waitDeckCardSelection((overlay) => overlay?.kind === "remove");
  const pickerState = await waitShopRemoval(page, (state) => state.picker?.screenId && Array.isArray(state.picker.cards) && state.picker.cards.length > 0);
  const hidden = await waitClientConfirm(page, false);
  const pickerCard = pickerState.picker.cards[0];
  const cardPoint = await shopRemovalClientPoint(page, pickerCard);
  if (!cardPoint) throw new Error("deck-removal picker card had no renderer-neutral client point");
  await pointer.tap(cardPoint.cx, cardPoint.cy);
  const staged = await waitDeckCardSelection((overlay) =>
    overlay?.kind === "remove" && Array.isArray(overlay.selectedCardIds) && overlay.selectedCardIds.length === 1 && overlay.canConfirm === true
  );
  const confirmAfterStage = await waitClientConfirm(page, false);

  // The service's Cost child is hidden after it becomes inactive. The seam intentionally reports that absence as
  // `service: null`; record an observed inactive service, but do not manufacture an irreversible game-confirm leg
  // merely to force it. A fresh fixture is the boundary after this point.
  const afterOpen = await readShopRemoval(page);
  return {
    route,
    firstConfirm,
    firstSemantic: deckSelectionDigest(firstSemantic),
    coin,
    opened: deckSelectionDigest(opened),
    picker: { screenId: pickerState.picker.screenId, cardCount: pickerState.picker.cards.length },
    pickerCard: { id: pickerCard.id, hitboxId: pickerCard.hitboxId, gameCenter: pickerCard.gameCenter },
    cardPoint,
    staged: deckSelectionDigest(staged),
    confirmHiddenAfterOpen: hidden,
    confirmHiddenAfterStage: confirmAfterStage,
    serviceInactiveObserved: afterOpen?.service === null,
    serviceAfterOpen: afterOpen?.service ?? null
  };
}

/** H17 — every touch safety setting combination on the merchant's card-removal service. */
async function checkH17(ctx) {
  const { page, pointer, combo } = ctx;
  if (combo.pointer !== "touch") return skip("shop-removal confirmation is a touch-only gesture; nothing to assert for a mouse");

  const legs = [
    { name: "focus-on-confirm-off-retap", settings: { tapFocus: true, confirmTap: false }, route: { expectFirstFocusOnly: true, delayedRetap: true } },
    { name: "focus-off-confirm-on-button", settings: { tapFocus: false, confirmTap: true }, route: { expectConfirm: true, repeatMustStayGuarded: true, clientConfirm: true } },
    { name: "focus-on-confirm-on-button", settings: { tapFocus: true, confirmTap: true }, route: { expectConfirm: true, clientConfirm: true } },
    { name: "focus-on-confirm-on-retap", settings: { tapFocus: true, confirmTap: true }, route: { expectConfirm: true, retapOpens: true } },
    { name: "focus-off-confirm-off-first", settings: { tapFocus: false, confirmTap: false }, route: {} }
  ];
  const findings = [];
  for (const leg of legs) {
    try {
      const baseline = await loadShopRemovalLeg(page, leg.settings);
      const result = await openRemovalAndStage(page, pointer, leg.route);
      findings.push({ name: leg.name, status: PASS, settings: leg.settings, baseline, result });
    } catch (err) {
      findings.push({ name: leg.name, status: FAIL, settings: leg.settings, error: String(err?.message ?? err) });
      break;
    }
  }
  const failed = findings.filter((finding) => finding.status === FAIL);
  return failed.length === 0
    ? ok("all Tap to focus / Confirm tap routes opened remove, staged one deck card, and left client confirm hidden", { stage: combo.stage, findings })
    : bad(`${failed.length} shop-removal route(s) failed`, { stage: combo.stage, findings });
}

const CHECKS = { H1: checkH1, H2: checkH2, H3: checkH3, H4: checkH4, H5: checkH5, H6: checkH6, H7: checkH7, H8: checkH8, H9: checkH9, H10: checkH10, H11: checkH11, H12: checkH12, H13: checkH13, H14: checkH14, H15: checkH15, H16: checkH16, H17: checkH17 };
// H7, H8, H16 and H17 change the ROOM, so they run last and the next combo reloads combat from scratch.
// H14 then reloads combat with its saved preference forced OFF, so it must be last of all.
// H14 intentionally reloads with the saved preference forced OFF, so it is always the final check.
const CHECK_ORDER = ["H1", "H2", "H3", "H4", "H5", "H6", "H9", "H10", "H11", "H12", "H13", "H7", "H8", "H15", "H16", "H17", "H14"];
/**
 * Checks that must start from a PRISTINE hand. Every grab-and-release in H3/H4/H5 can end with the card
 * played or discarded, so without this the fan shrinks as the run goes and later checks sample a
 * different, smaller hand than the one they were designed around (measured: 9 cards down to 6 by H6).
 * H2 is in the set for a milder version of the same reason: it inherits H1's long sweep, and a hand that
 * re-laid itself out under it turns a settling check into a report about the harness.
 * The reload costs seconds and buys a comparable hand for every check in every combo.
 */
const NEEDS_PRISTINE_HAND = new Set(["H2", "H3", "H4", "H5", "H6", "H9", "H10", "H11", "H12", "H13"]);

async function refreshCombat(page) {
  loadFixture("combat", { force: true });
  await sleep(2200);
  await page
    .waitForFunction(() => window.__mirrorInteractiveRects && window.__mirrorInteractiveRects().some((r) => r.raiseGoverned), null, { timeout: 30000 })
    .catch(() => {});
  await awaitFanRest(page);
}

// ---------------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------------

function pageUrl(combo) {
  const q = new URLSearchParams({ raiseHand: "on", stage: combo.stage });
  for (const pair of args.query) {
    const at = pair.indexOf("=");
    q.set(at < 0 ? pair : pair.slice(0, at), at < 0 ? "1" : pair.slice(at + 1));
  }
  return `http://127.0.0.1:${args.vitePort}/?${q.toString()}`;
}

async function runCombo(browser, combo, outDir) {
  const results = {};
  loadFixture("combat", { force: true });
  await sleep(1500);

  const context = await browser.newContext({
    viewport: { width: combo.width, height: combo.height },
    hasTouch: combo.pointer === "touch",
    // A touch context that still claims a fine pointer would take the desktop branch of every
    // coarse-pointer decision the client makes; `isMobile` is deliberately NOT set (it forces a
    // mobile viewport meta the mirror does not use).
    deviceScaleFactor: 1
  });
  const page = await context.newPage();
  // Record — never drop — the input envelopes. The closed loop is the measurement; see the header.
  await page.addInitScript(() => {
    window.__sentInputs = [];
    window.__touchQaSent = [];
    window.__touchQaReceived = [];
    const orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function (msg) {
      if (typeof msg === "string") {
        try {
          const parsed = JSON.parse(msg);
          if (parsed && parsed.type === "input") window.__sentInputs.push({ t: performance.now(), ...parsed });
          if (parsed && (parsed.type === "input" || parsed.type === "action")) {
            window.__touchQaSent.push({ t: performance.now(), ...parsed });
          }
        } catch { /* not our envelope */ }
      }
      return orig.call(this, msg);
    };
    const origAdd = WebSocket.prototype.addEventListener;
    WebSocket.prototype.addEventListener = function (type, listener, options) {
      if (!this.__touchQaObserved) {
        this.__touchQaObserved = true;
        origAdd.call(this, "message", (event) => {
          try {
            const parsed = JSON.parse(String(event.data));
            if (parsed?.type === "session") {
              window.__touchQaReceived.push({
                t: performance.now(),
                type: parsed.type,
                rewardAction: parsed.rewardAction ?? null,
                scrollAction: parsed.scrollAction ?? null,
                screen: parsed.screen ?? null
              });
            } else if (parsed?.type === "action-result") {
              window.__touchQaReceived.push({ t: performance.now(), ...parsed });
            }
          } catch { /* not a JSON envelope */ }
        });
      }
      return origAdd.call(this, type, listener, options);
    };
  });

  const url = pageUrl(combo);
  const gotoAt = now();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  let readyMs = -1;
  try {
    // READINESS, per stage. The DOM stage is ready when the scene has streamed enough nodes to be a real screen;
    // the canvas stage draws no per-node elements at all, so that count never rises and the honest signal there is
    // the renderer's own — a painted frame with interactive rects in it.
    await (combo.stage === "dom"
      ? page.waitForFunction(() => document.querySelectorAll("[data-node-id]").length > 400, null, { timeout: 60000 })
      : page.waitForFunction(
          () =>
            typeof window.__mirrorInteractiveRects === "function" && window.__mirrorInteractiveRects().length > 20,
          null,
          { timeout: 60000 }
        ));
    readyMs = now() - gotoAt;
  } catch {
    await context.close();
    for (const name of args.checks) results[name] = skip("the scene never streamed (join gate? game not in a run?)");
    return results;
  }
  await sleep(3500);

  const raise = await readRaiseGates(page);
  if (!raise || !raise.enabled) {
    log(`  !! readable-hand mode is not enabled on this page (${JSON.stringify(raise)}) — hand checks will skip`);
  }

  // ---- `--observe` STOPS HERE, and the line below is why this is the place: `makePointer` is the first
  // gesture-capable statement in the function, so everything above ran exactly as it does for a real combo.
  if (args.observe) {
    const seen = await page.evaluate(() => ({
      nodes: document.querySelectorAll("[data-node-id]").length,
      rects: typeof window.__mirrorInteractiveRects === "function" ? window.__mirrorInteractiveRects().length : null,
      // MEASURED, not asserted. The recorder above is installed and live; it simply has nothing to record.
      sentInputs: Array.isArray(window.__sentInputs) ? window.__sentInputs.length : null
    }));
    const digest = raise
      ? {
          enabled: raise.enabled,
          liftPx: raise.liftPx,
          maxLiftPx: raise.maxLiftPx,
          targetingArrows: raise.targetingArrows,
          choicePrompt: raise.choicePrompt,
          dragging: raise.dragging,
          dimmed: raise.dimmed,
          handRootId: raise.handRootId,
          holders: Array.isArray(raise.holders) ? raise.holders.length : null,
          creatureGroups: raise.creatureGroups,
          creatureGroupRows: Array.isArray(raise.creatureGroupRows) ? raise.creatureGroupRows.length : null,
          stamps: raise.stamps
        }
      : null;
    log(`  observe: no gestures were driven — bring-up only.`);
    log(`    url                     ${url}`);
    log(`    readyMs                 ${readyMs}`);
    log(`    [data-node-id]          ${seen.nodes}`);
    log(`    interactiveRects        ${seen.rects}`);
    log(`    sentInputs              ${seen.sentInputs}`);
    log(`    __mirrorHandRaise       ${JSON.stringify(digest)}`);
    await context.close();
    results.observe = seen.sentInputs === 0
      ? ok(`brought up in ${readyMs}ms: ${seen.nodes} streamed nodes, ${seen.rects} interactive rects, 0 inputs sent`)
      : bad(`the recorder saw ${seen.sentInputs} input envelope(s) — observe must drive none`, seen);
    log(`  ${results.observe.status.padEnd(4)} observe  ${results.observe.note}`);
    return results;
  }

  const pointer = await makePointer(page, combo.pointer);
  const ctx = { page, pointer, combo, outDir };

  for (const name of CHECK_ORDER) {
    if (!args.checks.includes(name)) continue;
    const started = now();
    // A canvas combo runs only the checks that read the SHARED SEAM. The rest read `[data-node-id]` elements and
    // would fail for the wrong reason on a stage that emits none — which reads as a broken renderer instead of an
    // unported check. Skipping says which it is.
    if (combo.stage !== "dom" && !STAGE_AGNOSTIC_CHECKS.has(name)) {
      results[name] = skip(`${name} reads per-node DOM; not ported to the canvas stage (see the stage axis note)`);
      results[name].ms = now() - started;
      log(`  ${results[name].status.padEnd(4)} ${name}  ${results[name].note}`);
      continue;
    }
    try {
      if (NEEDS_PRISTINE_HAND.has(name)) await refreshCombat(page);
      results[name] = await CHECKS[name](ctx);
    } catch (err) {
      results[name] = bad(`the check threw: ${err && err.message}`, { stack: String(err && err.stack).split("\n").slice(0, 6) });
    }
    results[name].ms = now() - started;
    const r = results[name];
    // A failing check photographs the screen it failed on. Cheap, and it settles the question every failure
    // dump raises first — "what was the game actually showing?" — without a second run to reproduce a state
    // the gestures themselves may have moved on from.
    if (r.status === FAIL) {
      const shot = `${outDir}/${combo.name}-${name}-fail.png`;
      try {
        await page.screenshot({ path: shot });
        r.detail = { ...(r.detail ?? {}), failScreenshot: shot };
      } catch { /* a torn-down page has nothing to photograph */ }
    }
    log(`  ${r.status.padEnd(4)} ${name}  ${r.note}`);
    if (r.status === FAIL && r.detail) {
      log(`       detail: ${JSON.stringify(r.detail).slice(0, 4000)}`);
    }
  }

  await context.close();
  return results;
}

async function main() {
  acquireLease({
    owner: lease.owner,
    pid: process.pid,
    resources: [
      "shared:install",
      `exclusive:game:${args.instance}`,
      `exclusive:port:${args.gamePort}`,
      `exclusive:port:${args.vitePort}`
    ]
  });
  lease.held = true;
  mkdirSync(args.out, { recursive: true });
  await ensureGame();
  // The browser server may walk upward from the preferred game port. Revalidate the complete set under the
  // registry guard before starting Vite or driving input, adding the actual bound port to this lease.
  acquireLease({
    owner: lease.owner,
    pid: process.pid,
    resources: [
      "shared:install",
      `exclusive:game:${args.instance}`,
      `exclusive:port:${args.gamePort}`,
      `exclusive:port:${args.vitePort}`
    ]
  });
  await ensureVite();

  // A HEADLESS BROWSER DOES NOT ANIMATE AT DISPLAY RATE unless it is told to. Chromium throttles
  // `requestAnimationFrame` hard when nothing is on screen (measured here: ~3.7 fps, ~270ms between frames), and
  // the mirror's canvas stage computes EVERY animation frame itself — so an unthrottled measurement is not a
  // luxury, it is the difference between watching a card glide and watching it teleport in three steps. The DOM
  // stage would not have shown it either way (its motion is a compositor transition), so without these flags the
  // two arms are not even measuring the same thing.
  const browser = await chromium.launch({
    args: [
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion"
    ]
  });
  // `--observe` is a BRING-UP, and a bring-up of eight viewport/pointer permutations is eight bring-ups.
  // The first selected combo is the one; `--combos` still chooses WHICH.
  const combos = COMBOS.filter((c) => args.combos.includes(c.name)).slice(0, args.observe ? 1 : undefined);
  const all = {};
  for (const combo of combos) {
    log(`\n=== ${combo.name}  (${combo.stage}, ${combo.pointer}, ${combo.width}x${combo.height}) ===`);
    all[combo.name] = await runCombo(browser, combo, args.out);
  }
  await browser.close();

  // ---- table (skipped under `--observe`: a grid of ten dashes says nothing the line above did not)
  if (!args.observe) {
    const checkCols = CHECK_ORDER.filter((c) => args.checks.includes(c));
    const width = Math.max(...combos.map((c) => c.name.length), 6);
    log(`\n${"".padEnd(width)}  ${checkCols.map((c) => c.padEnd(5)).join("")}`);
    for (const combo of combos) {
      const row = checkCols.map((c) => (all[combo.name][c]?.status ?? "-").padEnd(5)).join("");
      log(`${combo.name.padEnd(width)}  ${row}`);
    }
  }

  const report = { at: new Date().toISOString(), args: { ...args }, results: all };
  const reportPath = `${args.out}/report-${Date.now()}.json`;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log(`\nfull report (every timeline, every failing frame): ${reportPath}`);

  // ---- exit gate (every selected combination is a product gate)
  const failures = [];
  for (const combo of combos) {
    for (const [name, r] of Object.entries(all[combo.name])) {
      if (r.status === FAIL) failures.push(`${combo.name}/${name}`);
    }
  }
  if (failures.length) {
    log(`\n${failures.length} gating check(s) FAILED: ${failures.join(", ")}`);
    return 1;
  }
  log("\nall gating checks passed");
  return 0;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  console.error(`\nharness error: ${err && err.stack ? err.stack : err}`);
  exitCode = 2;
} finally {
  shutdown();
  if (lease.held) {
    releaseLease({ owner: lease.owner, pid: process.pid });
    lease.held = false;
  }
}
process.exit(exitCode);
