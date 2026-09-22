#!/usr/bin/env node
//
// Live probe for the pause menu's "Couch Co-Op QR Code" row -- the mid-run twin of the lobby QR button.
//
// WHY IT EXISTS. The lobby button is gone the moment a run embarks, so a device that joined and then lost
// its browser (locked phone, closed tab, dropped Wi-Fi) had no way back to the join URL. The row is that way
// back, and every claim below is one the unit suites cannot make: the unit suites own the GATE, this owns
// the fact that a game-owned container actually laid our row out where we said it would.
//
// What it proves, in order:
//   1. it is safe to drive the live game at all                        [advisory live-session lock]
//   2. a HOSTED run can be reached from the host-lobby fixture         [one real seat joins, then all ready]
//   3. the pause menu carries the row, with the contract label
//   4. the row sits IMMEDIATELY ABOVE GiveUp in the game's own ButtonContainer
//   5. the CONTAINER laid it out -- its x/width match a game-owned sibling row's, and it is
//      vertically between its neighbours. Nothing in the mod positions it.
//   6. hovering + clicking it opens CouchCoopQrDialog                  [NClickableControl is focus-gated]
//   7. the dialog closes by its Close button
//   8. no CouchCoopPauseMenuQr* / CouchCoopQr* node ever reaches a passive client
//   9. in a SINGLEPLAYER run the row is present but HIDDEN                       [the gate, live]
//  10. every claim above has a screenshot under .sts2/artifacts/pause-menu-qr/
//
// The positive legs run BEFORE the negative one on purpose: leg 2 is the only expensive, flaky-by-nature
// step here (it drives a real embark), so the evidence a reviewer actually wants is captured before
// anything can time out.
//
// Run standalone (a game must already be up):
//   node scripts/probe-pause-menu-qr.mjs
// or through the scenario, which also deploys + restarts the game:
//   sts2 --json test run tests/scenarios/pause-menu-qr.sts2.yaml

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  NAMES, DIALOG_TITLE_TEXT, BUTTON_TEXT,
  SCREEN_START_RUN_LOBBY, FIXTURE_HOST_LOBBY, FIXTURE_MAIN_MENU,
  ProbeError, assert, sleep, sts2,
  acquireLiveLock, releaseLiveLock,
  sceneTree, nodesNamed, findNodePath, nodeDetails,
  globalRect, isVisible, isEffectivelyVisible, textOf,
  hoverAndClick,
  loadFixture, state, waitFor, lobbyNetGameType,
  screenshot, scanMirrorForQrNodes
} from "./probe-lib-lobby-qr.mjs";
import { joinSeats, closeBrowsers, actForPlayer } from "./probe-five-player-run.mjs";

const artifactDir = new URL("../.sts2/artifacts/pause-menu-qr/", import.meta.url);
const artifactDirPath = fileURLToPath(artifactDir);
const relArtifact = name => `.sts2/artifacts/pause-menu-qr/${name}`;

/** The node contract this probe asserts. Mirrors CouchCoopPauseMenuQrEntry's constants. */
const ROW_NAME = "CouchCoopPauseMenuQrButton";
const ENTRY_NAME = "CouchCoopPauseMenuQrEntry";
/** The game's own nodes the row is measured against. */
const GIVE_UP_NAME = "GiveUp";
const PAUSE_BUTTON_NAME = "PauseButton";
const RESUME_NAME = "Resume";
/** A run fixture is ALWAYS the singleplayer SetUpNewSingleplayer path -- see qa-recipes ss4. */
const FIXTURE_SINGLEPLAYER_RUN = "tests/fixtures/act1-last-boss.sts2.fixture.yaml";

/** Rect tolerance in design units -- layout is integral, so this only absorbs float noise. */
const RECT_EPSILON = 0.5;

/** The host's compiled-in browser port, and the seat the embark needs. */
const DEFAULT_HOST_PORT = 13337;
const SEATS_FOR_EMBARK = 1;

/** How many times to press pause before calling it stuck -- a fresh run opens on Neow's intro. */
const PAUSE_OPEN_ATTEMPTS = 6;

/**
 * What `joinSeats()` needs to put ONE real co-op seat in this host's lobby.
 *
 * Everything machine-specific is read from the environment, never written down here. `COUCHCOOP_GAME_ORIGIN`
 * is the same variable the mirror helpers in `probe-lib-lobby-qr.mjs` already read, so a probe run is
 * pointed at one host by one variable.
 *
 * IT MUST NOT BE LOOPBACK ON AN ISOLATED INSTANCE. The mod's browser server confines its viewer-facing
 * routes to the LAN boundary, so `127.0.0.1` closes the connection while the host's LAN address answers
 * 200 -- the join would fail in a way that reads like a broken host. Pass the address the QR dialog itself
 * shows (or the one in that instance's `couch-coop/browser-port` file).
 *
 * `COUCHCOOP_PROBE_USER_DIR` is where the seat's own godot.log is looked for, which is how `joinSeats`
 * proves the ENet handshake actually happened rather than trusting a rendered browser frame. An isolated
 * instance keeps its own; the default is the operator's.
 */
function seatTargets() {
  const origin = (process.env.COUCHCOOP_GAME_ORIGIN ?? `http://127.0.0.1:${DEFAULT_HOST_PORT}`)
    .replace(/^ws/, "http")
    .replace(/\/$/, "");
  const browserPort = Number.parseInt(new URL(origin).port, 10) || DEFAULT_HOST_PORT;
  return {
    seats: SEATS_FOR_EMBARK,
    seatConcurrency: 1,
    baseUrl: origin,
    browserPort,
    portBases: [...new Set([browserPort, DEFAULT_HOST_PORT])],
    userDir: process.env.COUCHCOOP_PROBE_USER_DIR
      ?? `${process.env.HOME ?? ""}/.local/share`,
    seatTimeoutMs: 120_000,
    outDir: artifactDirPath
  };
}

const evidence = { steps: [] };
const screenshots = [];

function record(step, detail) {
  evidence.steps.push({ step, ...detail });
}

async function shot(name, note) {
  const path = relArtifact(name);
  const taken = await screenshot(path);
  screenshots.push({ name, path: `${artifactDirPath}${name}`, note, appliedViewport: taken.appliedViewport });
  return taken;
}

// ---------------------------------------------------------------------------------------------
// getting into a hosted run
// ---------------------------------------------------------------------------------------------

/**
 * Loads the host-lobby fixture and only returns once the lobby has PROVEN STABLE.
 *
 * Same hazard the lobby probe documents: a freshly restarted game keeps finishing its boot flow for
 * several seconds and that flow pushes the main menu, POPPING a lobby the fixture just created.
 */
async function loadHostLobbyStable({ attempts = 5, settleMs = 3000 } = {}) {
  let lastSeen = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await loadFixture(FIXTURE_HOST_LOBBY);
      await waitFor(
        () => sceneTree().then(tree => tree?.screen?.id ?? null),
        id => id === SCREEN_START_RUN_LOBBY,
        { what: `the ${SCREEN_START_RUN_LOBBY} lobby` }
      );
    } catch (error) {
      // A THROW IS A RETRY HERE, not a failure. A game still finishing its boot flow blocks its own main
      // thread on asset preloads ('Common' is ~700 assets), and a bridge request that lands in that window
      // comes back "failed to fill whole buffer" -- a transport read timeout, not a broken fixture.
      lastSeen = `error: ${error.message.slice(0, 160)}`;
      record("lobby-load-failed", { attempt, detail: lastSeen, note: "the bridge did not answer; retrying" });
      await sleep(5000);
      continue;
    }

    await sleep(settleMs);

    const tree = await sceneTree().catch(() => null);
    if (tree?.screen?.id === SCREEN_START_RUN_LOBBY && (await lobbyNetGameType().catch(() => null)) === "host") {
      record("host-lobby-ready", { attempt, netGameType: "host" });
      return;
    }

    lastSeen = tree?.screen?.id ?? "unreadable";
    record("lobby-collapsed-after-load", {
      attempt, screenAfterSettle: lastSeen,
      note: "the freshly restarted game's boot flow popped the fixture lobby; reloading"
    });
    await sleep(2000);
  }
  throw new ProbeError(
    `${FIXTURE_HOST_LOBBY} could not hold a host lobby across ${attempts} attempts (last screen: ${lastSeen}).`
  );
}

/**
 * Embarks the fixture lobby as a HOSTED run.
 *
 * READYING IS NOT ENOUGH ON ITS OWN, and that was measured here rather than assumed. The host lobby
 * fixture leaves p:1 as the only seat; readying it turns the confirm button into "Waiting for other
 * players..." and the run never begins, because a multiplayer host will not embark with nobody to host.
 * Adding a SYNTHETIC seat (`act join-lobby-player`) does not help either: that seat reports
 * `isConnected: false` and the same barrier holds with both checkmarks green -- the shape
 * `synthetic-seat-game-barriers` warns about. And a `run:` fixture can never stand in, because the
 * fixture loader always takes the no-ENet singleplayer path, which is the one netGameType this gate must
 * NOT fire on.
 *
 * So the embark needs one genuinely CONNECTED peer, which means a real browser seat: a page joins the
 * host's browser server, the host spawns that seat's headless game, and it joins over ENet like any
 * player's phone. That is `joinSeats()` from `probe-five-player-run.mjs`, imported rather than
 * reimplemented -- a second copy of the seat join would be a second thing to be wrong, and this one
 * carries its own per-seat ENet handshake evidence.
 *
 * Readying every player is then the actual embark trigger; there is no `start-run` verb. Those `act`
 * calls are a QA DRIVER, not the product's commit path -- the same standing `probe-five-player-run.mjs`
 * and `probe-lobby-actions-remain-available.mjs` already have. Nothing the mod ships calls one.
 */
async function embarkHostedRun() {
  const seats = await joinSeats(seatTargets(), { screenshots: [] });
  const joined = seats.filter(seat => seat.ok);
  record("seat-joined", {
    requested: seats.length,
    ok: joined.length,
    detail: seats.map(seat => ({ name: seat.name, ok: seat.ok, slot: seat.slot, port: seat.port, detail: seat.detail }))
  });
  assert(
    joined.length === seats.length,
    `the co-op seat could not join, so no HOSTED run can be embarked: ` +
    seats.filter(seat => !seat.ok).map(seat => `${seat.name}: ${seat.detail}`).join("; ")
  );

  // Every player, not just p:1 -- the seat that just joined is a player too, and the barrier is "all of
  // them", which is exactly why readying p:1 alone left the lobby waiting.
  const lobby = await waitFor(
    () => state().then(snapshot => snapshot?.characterSelect?.lobby ?? null),
    value => (value?.players?.length ?? 0) > 1,
    { attempts: 60, intervalMs: 500, what: "the joined seat to appear in the lobby roster" }
  );

  // EACH PLAYER READIES THROUGH ITS OWN BRIDGE. The host's bridge refuses an action for a remote client
  // outright (`wrong_player`, `local-only-degraded`) -- it executes local-player actions only, and the
  // joined seat is a genuinely independent process. `actForPlayer` tries the host bridge and falls back
  // to that seat's own socket, which is exactly the routing the five-player probe proved.
  const seatsByPlayerId = new Map(joined.filter(seat => seat.playerId).map(seat => [seat.playerId, seat]));
  for (const player of lobby.players) {
    if (player.isReady) continue;
    const outcome = await actForPlayer(player.id, ["ready"], seatsByPlayerId);
    assert(outcome.accepted === true,
      `readying ${player.id} was refused on every bridge: ${JSON.stringify(outcome.attempts)?.slice(0, 400)}`);
    record("player-readied", { playerId: player.id, via: outcome.via });
  }

  const run = await waitFor(
    () => state().then(snapshot => snapshot?.run ?? null),
    value => value !== null,
    { attempts: 120, intervalMs: 500, what: "the run to begin" }
  );

  // THE LEG THE WHOLE PROBE HANGS ON. The gate requires a HOSTED run; a `run:` fixture would have been the
  // easy way here and is always the singleplayer path, so it could never have exercised the positive case.
  assert(
    run.netGameType === "host",
    `the run embarked as netGameType=${run.netGameType}, not host -- this probe cannot prove the gate's ` +
    `positive case against it (a run: fixture is always the singleplayer path; only the lobby fixture hosts)`
  );
  record("run-embarked", { netGameType: run.netGameType, actFloor: run.actFloor ?? null });
  return run;
}

/**
 * Opens the pause menu by hovering and clicking the game's own top-bar pause control.
 *
 * Hover-then-click on a RESOLVED node path, never a blind coordinate: `NClickableControl` gates activation
 * on `IsFocused`, and scripted blind input against a live game is how the Stampede incident happened.
 */
async function openPauseMenu() {
  // THE CLICK IS RETRIED, and that is not belt-and-braces. A fresh run opens on Neow, whose intro plays
  // over the top bar for several seconds and eats the press -- measured here: the same probe, the same
  // build, opened the menu on one attempt and landed in Neow's dialogue on the next. So: press, look,
  // press again. The button is RE-RESOLVED every attempt, not resolved once: the singleplayer leg loads a
  // fixture first, and a path read before that swap names a node the game has already freed, which the
  // bridge refuses as `invalid_query_filter` rather than simply missing.
  for (let attempt = 1; attempt <= PAUSE_OPEN_ATTEMPTS; attempt += 1) {
    const tree = await waitFor(
      () => sceneTree(),
      value => findNodePath(value, PAUSE_BUTTON_NAME) !== null,
      { attempts: 120, intervalMs: 500, what: `the top bar's ${PAUSE_BUTTON_NAME}` }
    );

    // Re-hover each time too: NClickableControl only activates what it thinks is focused, and the intro
    // may have taken focus away in between.
    const landed = await hoverAndClick(findNodePath(tree, PAUSE_BUTTON_NAME)).catch(() => null);
    if (landed !== null) {
      const opened = await pauseMenuOnScreen();
      if (opened !== null) {
        record("pause-menu-opened", { attempt });
        return opened;
      }
    }
    await sleep(1500);
  }

  throw new ProbeError(
    `the pause menu did not open after ${PAUSE_OPEN_ATTEMPTS} presses of ${PAUSE_BUTTON_NAME} -- ` +
    `something in the run is swallowing the press`
  );
}

/**
 * The scene tree once the pause menu is ON SCREEN, or null while it is not.
 *
 * KEYED ON THE GAME'S OWN `Resume` ROW, deliberately, and never on ours. Visibility rather than presence
 * is the right question -- the entry is mounted for the whole run, so "the node exists" is true long
 * before the menu is drawn, and a screenshot taken on that signal catches the run behind it instead --
 * but asking it of `CouchCoopPauseMenuQrButton` would make this function unusable for the leg that
 * matters most: in a singleplayer run the gate HIDES our row, so a wait on it could only ever time out,
 * and the probe would report "the menu never opened" for a menu that opened perfectly with the row
 * correctly hidden. `Resume` is in the menu on every net type and is never gated.
 *
 * `effectiveVisible`, not `visible`: a row's own flag stays true while the MENU above it is hidden, which
 * is exactly the state being waited out. `properties` must stay ON, since that is where both flags live.
 */
async function pauseMenuOnScreen({ attempts = 10, intervalMs = 300 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const value = await sceneTree().catch(() => null);
    const path = value === null ? null : findNodePath(value, RESUME_NAME);
    if (path !== null) {
      const resume = await nodeDetails(path, { transform: false }).catch(() => null);
      if (isEffectivelyVisible(resume)) return value;
    }
    await sleep(intervalMs);
  }
  return null;
}

/** Closes the pause menu again, so a later fixture load is not racing an open submenu. */
async function closePauseMenu(tree) {
  const resumePath = findNodePath(tree, RESUME_NAME);
  if (resumePath === null) {
    return;
  }
  await hoverAndClick(resumePath);
  await sleep(600);
}

// ---------------------------------------------------------------------------------------------
// the assertions
// ---------------------------------------------------------------------------------------------

/**
 * The row exists once, is visible, and says what the lobby button says.
 *
 * The wording is asserted LITERALLY because it is a QA contract shared with the lobby probe: both entry
 * points resolve the same `couchcoop_qr_button` key, and a change that split them would be invisible
 * anywhere else.
 */
async function assertRowPresent(tree) {
  const rows = nodesNamed(tree, ROW_NAME);
  assert(rows.length === 1, `expected exactly one ${ROW_NAME}, found ${rows.length}`);

  const entries = nodesNamed(tree, ENTRY_NAME);
  assert(entries.length === 1, `expected exactly one ${ENTRY_NAME} (the dialog host), found ${entries.length}`);

  const rowPath = findNodePath(tree, ROW_NAME);
  const row = await nodeDetails(rowPath);
  assert(isVisible(row), `${ROW_NAME} is hidden in a hosted run -- the gate should be showing it`);

  // The row node itself carries no text; the wording lives on its MegaLabel child. Read through
  // `nodeDetails`, NOT `rowLabelText(tree, …)`: a `dev scene tree` dump carries no `properties`, so the
  // helper would answer `null` for a label that reads perfectly well — a false failure that looks exactly
  // like a genuinely blank row. The lobby probe gets away with it because it passes a properties-bearing
  // tree; this one holds the whole run's tree and does not.
  const { label, labelNode } = await readRowLabel(rowPath);
  assert(
    label === BUTTON_TEXT,
    `${ROW_NAME} reads "${label}", not the contract wording "${BUTTON_TEXT}"`
  );

  assertLabelFitsThePlate(labelNode);

  record("row-present", { path: rowPath, label });
  return { rowPath, row };
}

/** The row's MegaLabel, fetched once with properties, and the string it actually renders. */
async function readRowLabel(rowPath) {
  const labelNode = await nodeDetails(`${rowPath}/Label`);
  return { label: textOf(labelNode), labelNode };
}

/**
 * The label was set through the game's AUTO-SIZING path, and the result actually fits.
 *
 * `SetTextAutoSize` is the difference between a row whose text fits and one whose text runs off the plate:
 * assigning `Label.Text` directly skips `AdjustFontSize` entirely. English is the easy case at 19
 * characters; the longer translations of this same key are what make it load-bearing, so the assertion is
 * on the RENDERED width against the label's own box rather than on the string.
 */
function assertLabelFitsThePlate(label) {
  const text = label?.properties?.text ?? {};
  const box = globalRect(label);
  const rendered = text?.renderedMetrics?.paragraphSizeWidthPx ?? null;

  assert(
    text?.recipe?.autoSizeEnabled === true,
    `${ROW_NAME}'s label is not auto-sizing -- it was written with Label.Text instead of SetTextAutoSize`
  );
  assert(
    Number.isFinite(rendered) && Number.isFinite(box?.size?.x) && rendered <= box.size.x + RECT_EPSILON,
    `${ROW_NAME}'s label renders ${rendered}px wide inside a ${box?.size?.x}px box -- it overflows the plate`
  );

  record("label-fits", {
    renderedWidthPx: rendered, boxWidthPx: box?.size?.x ?? null,
    appliedFontSize: text?.appliedFontSize ?? null, maxFontSize: text?.recipe?.maxFontSizePx ?? null
  });
}

/** The direct children of `containerPath`, in scene order (`dev scene tree` dumps a pre-order DFS). */
async function childOrder(containerPath) {
  const subtree = await sceneTree(containerPath);
  return (subtree?.nodes ?? [])
    .filter(node => node.parentNodePath === containerPath)
    .map(node => node.name);
}

/**
 * The row sits IMMEDIATELY ABOVE GiveUp, in GiveUp's own parent.
 *
 * Asserted on the sibling INDEX rather than on a y coordinate: the index is what "above Give Up" actually
 * means to the container, and a y comparison alone would still pass if the row had been re-parented
 * somewhere that happens to draw higher.
 */
async function assertRowIsAboveGiveUp(rowPath) {
  const giveUpPath = rowPath.replace(new RegExp(`${ROW_NAME}$`), GIVE_UP_NAME);
  const giveUp = await nodeDetails(giveUpPath).catch(() => null);
  assert(
    giveUp !== null,
    `${GIVE_UP_NAME} is not a sibling of ${ROW_NAME} -- the row is not in the menu's button column ` +
    `(looked for ${giveUpPath})`
  );

  const containerPath = rowPath.slice(0, rowPath.lastIndexOf("/"));
  const order = await childOrder(containerPath);
  const rowIndex = order.indexOf(ROW_NAME);
  const giveUpIndex = order.indexOf(GIVE_UP_NAME);

  assert(rowIndex >= 0 && giveUpIndex >= 0, `could not read the sibling order under ${containerPath}: ${order}`);
  assert(
    rowIndex === giveUpIndex - 1,
    `${ROW_NAME} is at index ${rowIndex} and ${GIVE_UP_NAME} at ${giveUpIndex} -- it must sit directly ` +
    `above Give Up. Order: ${order.join(" > ")}`
  );

  record("row-above-give-up", { containerPath, order, rowIndex, giveUpIndex });
  return { containerPath, giveUp, order };
}

/**
 * The CONTAINER laid the row out, not the mod.
 *
 * This is the "inserted naturally" requirement, made falsifiable: the row's x and width must equal a
 * GAME-OWNED sibling's to the pixel (same shrink-center sizing, same plate width), and it must sit
 * vertically between the row above it and Give Up with no overlap. A row the mod had positioned itself
 * would be free to match none of that.
 */
async function assertContainerLaidItOut(rowPath, containerPath, order) {
  const rowRect = globalRect(await nodeDetails(rowPath));
  const rowIndex = order.indexOf(ROW_NAME);
  const aboveName = order[rowIndex - 1] ?? null;
  assert(aboveName !== null, `${ROW_NAME} has no sibling above it to measure against`);

  const aboveRect = globalRect(await nodeDetails(`${containerPath}/${aboveName}`));
  const giveUpRect = globalRect(await nodeDetails(`${containerPath}/${GIVE_UP_NAME}`));

  assert(
    Math.abs(rowRect.position.x - aboveRect.position.x) <= RECT_EPSILON,
    `${ROW_NAME} x=${rowRect.position.x} but ${aboveName} x=${aboveRect.position.x} -- the column did not ` +
    `place it`
  );
  assert(
    Math.abs(rowRect.size.x - aboveRect.size.x) <= RECT_EPSILON,
    `${ROW_NAME} width=${rowRect.size.x} but ${aboveName} width=${aboveRect.size.x} -- it is not wearing ` +
    `the same plate as its neighbours`
  );
  assert(
    rowRect.position.y >= aboveRect.position.y + aboveRect.size.y - RECT_EPSILON,
    `${ROW_NAME} overlaps ${aboveName} vertically`
  );
  assert(
    rowRect.position.y + rowRect.size.y <= giveUpRect.position.y + RECT_EPSILON,
    `${ROW_NAME} overlaps ${GIVE_UP_NAME} vertically`
  );

  record("container-laid-it-out", {
    row: rowRect, above: { name: aboveName, rect: aboveRect }, giveUp: giveUpRect
  });
}

/** Hover + click the row, and assert the QR dialog came up. */
async function assertRowOpensTheDialog(rowPath) {
  await hoverAndClick(rowPath);
  await sleep(600);

  const tree = await waitFor(
    () => sceneTree(),
    value => nodesNamed(value, NAMES.dialog).length === 1,
    { attempts: 20, intervalMs: 300, what: `${NAMES.dialog} to be built` }
  );

  const dialogPath = findNodePath(tree, NAMES.dialog);
  const dialog = await nodeDetails(dialogPath);
  assert(isVisible(dialog), `${NAMES.dialog} exists but is not visible after clicking the row`);

  const title = await nodeDetails(findNodePath(tree, NAMES.title));
  assert(
    textOf(title) === DIALOG_TITLE_TEXT,
    `dialog title reads "${textOf(title)}", not "${DIALOG_TITLE_TEXT}"`
  );

  record("dialog-open", { dialogPath, title: textOf(title) });
  return { tree, dialogPath };
}

async function assertDialogClosesByItsButton(tree, dialogPath) {
  const closePath = findNodePath(tree, NAMES.closeButton);
  assert(closePath !== null, `${NAMES.closeButton} is not in the tree -- the dialog cannot be closed`);

  await hoverAndClick(closePath);
  await sleep(600);

  const dialog = await nodeDetails(dialogPath);
  assert(!isVisible(dialog), `${NAMES.dialog} is still visible after its close button was clicked`);
  record("dialog-closed", { via: NAMES.closeButton });
}

/**
 * No injected node reaches a passive mirror client.
 *
 * Load-bearing, not tidiness: a viewer who picked "watch the host" mirrors THIS tree and drives it with
 * real injected input, so a row that reached a phone could be pressed onto the host's television.
 */
async function assertNothingLeaksToAMirror() {
  const scan = await scanMirrorForQrNodes({ extraPatterns: [ROW_NAME, ENTRY_NAME] });
  assert(
    scan.sawFullKeyframe,
    `the mirror scan never saw a full keyframe (${scan.socketError ?? "no socket error"}), so it proves nothing`
  );
  assert(
    scan.matches.length === 0,
    `these injected nodes reached a passive client: ${scan.matches.join(", ")}`
  );
  record("mirror-clean", {
    url: scan.url, messages: scan.messages, bytes: scan.bytes, fullKeyframeBytes: scan.fullKeyframeBytes
  });
}

/**
 * THE GATE, LIVE. A singleplayer run must carry the row HIDDEN, not absent.
 *
 * Hidden rather than absent is the assertion worth making: it proves the gate ran and said no, where an
 * absence would equally well mean the mount never happened and the positive leg above had been luck.
 */
async function assertHiddenInASingleplayerRun() {
  // VIA THE MAIN MENU, and not as tidiness. Dropping a singleplayer `run:` fixture straight onto a live
  // HOSTED run does create the run -- and then the hosted session's own teardown lands, pops everything
  // and leaves the game on the main menu, taking the fresh run with it. The probe then hunts a top bar
  // that no longer exists. Ending the hosted run first, and only then loading, is stable: measured here
  // across eight consecutive polls, `rootScene=run netGameType=singleplayer` every time.
  await loadFixture(FIXTURE_MAIN_MENU);
  await waitFor(
    () => state().then(snapshot => snapshot?.run ?? null),
    value => value === null,
    { attempts: 60, intervalMs: 500, what: "the hosted run to be torn down" }
  );
  await sleep(2000);

  await loadFixture(FIXTURE_SINGLEPLAYER_RUN);
  const run = await waitFor(
    () => state().then(snapshot => snapshot?.run ?? null),
    value => value !== null && value.netGameType === "singleplayer",
    { attempts: 60, intervalMs: 500, what: "a singleplayer run" }
  );
  // It has to HOLD, not merely appear -- the same "did the boot/teardown flow pop it?" hazard
  // `loadHostLobbyStable` guards against at the other end of the probe.
  await sleep(3000);
  const held = await state().then(snapshot => snapshot?.run ?? null).catch(() => null);
  assert(
    held?.netGameType === "singleplayer",
    `the singleplayer run did not hold (now: ${held?.netGameType ?? "no run"}) -- the gate cannot be ` +
    `judged against a run that is being torn down`
  );

  const tree = await openPauseMenu();
  const rowPath = findNodePath(tree, ROW_NAME);
  const row = await nodeDetails(rowPath);
  assert(
    !isVisible(row),
    `${ROW_NAME} is VISIBLE in a ${run.netGameType} run -- the gate must hide it, nothing can join`
  );

  const giveUp = await nodeDetails(rowPath.replace(new RegExp(`${ROW_NAME}$`), GIVE_UP_NAME)).catch(() => null);
  record("singleplayer-gate", {
    netGameType: run.netGameType,
    rowVisible: isVisible(row),
    giveUpVisible: giveUp === null ? null : isVisible(giveUp)
  });
  return tree;
}

// ---------------------------------------------------------------------------------------------

async function main() {
  await mkdir(artifactDir, { recursive: true });
  const lock = await acquireLiveLock("pause-menu-qr-probe");
  let failure = null;

  try {
    await loadHostLobbyStable();
    await embarkHostedRun();

    let tree = await openPauseMenu();
    await shot("01-pause-menu-row.png", "hosted run, pause menu: the Couch Co-Op QR Code row above Give Up");

    const { rowPath } = await assertRowPresent(tree);
    const { containerPath, order } = await assertRowIsAboveGiveUp(rowPath);
    await assertContainerLaidItOut(rowPath, containerPath, order);

    const opened = await assertRowOpensTheDialog(rowPath);
    await shot("02-dialog-over-paused-run.png", "the QR dialog open over the paused run");
    await assertDialogClosesByItsButton(opened.tree, opened.dialogPath);
    await shot("03-dialog-closed.png", "dialog closed by its Close QR Code button; the row is back");

    await assertNothingLeaksToAMirror();

    tree = await sceneTree();
    await closePauseMenu(tree);

    const singleplayer = await assertHiddenInASingleplayerRun();
    await shot("04-singleplayer-row-hidden.png", "singleplayer run: the row is mounted but the gate hides it");
    await closePauseMenu(singleplayer);

    // Leave the game where the next probe expects to find it.
    await loadFixture(FIXTURE_MAIN_MENU);
  } catch (error) {
    failure = error;
    try {
      await shot("99-failure.png", `state when the probe failed: ${error.message}`.slice(0, 240));
    } catch {
      // A screenshot of a broken game is a nice-to-have; the error below is the finding.
    }
  } finally {
    // The seat's browser context first: it holds a live WebSocket to the host, and leaving it open keeps
    // that seat's headless game alive past the probe.
    await closeBrowsers().catch(() => {});
    await releaseLiveLock(lock);
  }

  const result = {
    ok: failure === null,
    error: failure === null ? null : `${failure.name}: ${failure.message}`,
    screenshots: screenshots.map(entry => entry.path)
  };
  await writeFile(
    `${artifactDirPath}result.json`,
    `${JSON.stringify({ result, screenshots, evidence }, null, 2)}\n`
  );

  // The scenario runner accepts only `path` and `kind` per artifact entry; any extra key fails the hook.
  console.log(JSON.stringify({
    ok: result.ok,
    error: result.error,
    artifacts: [
      { path: relArtifact("result.json"), kind: "json" },
      ...screenshots.map(entry => ({ path: relArtifact(entry.name), kind: "image" }))
    ]
  }));

  if (failure !== null) {
    process.exitCode = 1;
  }
}

await main();
